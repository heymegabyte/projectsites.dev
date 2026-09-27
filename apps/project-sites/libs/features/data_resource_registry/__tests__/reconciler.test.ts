/**
 * Unit tests for the Resource Registry reconciler (`reconcileResources`) — Data & Resource
 * Platform §1 + §6.
 *
 * Three behaviours under test (the exact contract the fire specifies):
 *   1. A registry row whose adapter `head` reports the resource is GONE → `drift_code` set to
 *      `resource_missing_on_cf` (the "row claims existence but CF 404s" case a display-only check is
 *      blind to, per verify-against-source-of-truth).
 *   2. A real per-site allocation (a D1 id in `site_database_allocations`) → RECORDED via
 *      `recordResource` (honest: a kind with no allocation source records nothing).
 *   3. Another site's rows are NEVER touched — every read/write is scoped to the passed `siteId`.
 *
 * All external deps mocked. swc-jest hoists `jest.mock` above the imports only when it sees the
 * GLOBAL `jest`, so we do NOT import `jest` from @jest/globals. Mock paths for `src/` use FOUR `../`
 * from `libs/features/<slug>/__tests__/`; sibling modules (service, adapters/d1) use `../`.
 */

// ─── Mocks (must precede the module-under-test import) ─────────────────────────
const mockDbQueryOne = jest.fn();
const mockDbQuery = jest.fn();
const mockDbUpdate = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: (...a: unknown[]) => mockDbQuery(...a),
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
  dbUpdate: (...a: unknown[]) => mockDbUpdate(...a),
}));

const mockResolveCfCredentials = jest.fn();
jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: (...a: unknown[]) => mockResolveCfCredentials(...a),
}));

const mockListResources = jest.fn();
const mockRecordResource = jest.fn();
jest.mock('../service.js', () => ({
  listResources: (...a: unknown[]) => mockListResources(...a),
  recordResource: (...a: unknown[]) => mockRecordResource(...a),
}));

const mockD1Head = jest.fn();
jest.mock('../adapters/d1.js', () => ({
  d1Adapter: {
    head: (...a: unknown[]) => mockD1Head(...a),
    kind: 'd1',
    supports: { environments: ['preview', 'production'], mutations: [], verbs: ['head'] },
  },
}));

import { reconcileResources } from '../reconciler.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
type TestEnv = { DB: unknown; CF_ACCOUNT_ID?: string };
const envWith = (over: Partial<TestEnv> = {}): TestEnv => ({
  CF_ACCOUNT_ID: 'acct_server',
  DB: {},
  ...over,
});

const OWNER_ORG = 'org_owner';
const OWNED_SITE = 'site_owned';

/** A full typed registry row (what listResources returns) with per-test overrides. */
function registryRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    accessPolicy: 'no_direct',
    accountId: 'acct_server',
    bindingName: undefined,
    cfAccountId: 'acct_server',
    createdAt: '2026-09-27T00:00:00Z',
    deletedAt: undefined,
    deletionProtected: 1,
    deployId: undefined,
    deployedVersion: undefined,
    driftCode: undefined,
    driftDetail: undefined,
    environment: 'production',
    id: 'row_d1',
    lastErrorCode: undefined,
    lastErrorDetail: undefined,
    lastSyncAt: undefined,
    lifecycleState: 'active',
    orgId: OWNER_ORG,
    ownerUserId: undefined,
    provisioningMethod: 'lazy',
    resourceConcept: 'account_resource',
    resourceDisplayName: 'ps-site-owned',
    resourceIdOrName: 'owned-db-uuid',
    resourceKind: 'd1',
    siteId: OWNED_SITE,
    tenancy: 'dedicated',
    updatedAt: '2026-09-27T00:00:00Z',
    usageJson: undefined,
    vectorizeNamespace: undefined,
    ...over,
  };
}

const okHead = { correlationId: 'cid', data: { databaseId: 'owned-db-uuid', exists: true }, ok: true };
const goneHead = { correlationId: 'cid', data: { databaseId: 'owned-db-uuid', exists: false }, ok: true };

beforeEach(() => {
  mockDbQueryOne.mockReset();
  mockDbQuery.mockReset();
  mockDbUpdate.mockReset();
  mockResolveCfCredentials.mockReset();
  mockListResources.mockReset();
  mockRecordResource.mockReset();
  mockD1Head.mockReset();
  // Sensible defaults each test overrides as needed.
  mockDbUpdate.mockResolvedValue({ changes: 1, error: null });
  mockResolveCfCredentials.mockResolvedValue({ apiKey: 'k', email: 'e@x', kind: 'global' });
  mockRecordResource.mockResolvedValue({ id: 'new-row', ok: true });
});

describe('reconcileResources — drift sweep (row claims existence, CF head 404s)', () => {
  it('sets drift_code=resource_missing_on_cf when an implemented-kind row heads GONE', async () => {
    // No allocation sources (drift sweep is the focus); one existing d1 row that CF says is gone.
    mockDbQueryOne.mockResolvedValueOnce(null); // readAllocationSources → no allocation row
    mockListResources.mockResolvedValue([registryRow()]);
    mockD1Head.mockResolvedValue(goneHead);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.checked).toBe(1);
    expect(res.drift).toEqual([
      { driftCode: 'resource_missing_on_cf', registryRowId: 'row_d1', resourceKind: 'd1' },
    ]);
    // The row's drift_code was persisted, scoped to that row id.
    const driftUpdate = mockDbUpdate.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>)?.drift_code === 'resource_missing_on_cf',
    );
    expect(driftUpdate).toBeDefined();
    const [, table, updates, where, whereParams] = driftUpdate as [
      unknown,
      string,
      Record<string, unknown>,
      string,
      unknown[],
    ];
    expect(table).toBe('site_resource_registry');
    expect(updates.drift_code).toBe('resource_missing_on_cf');
    expect(updates.lifecycle_state).toBe('degraded');
    expect(where).toBe('id = ?');
    expect(whereParams).toEqual(['row_d1']);
    expect(mockD1Head).toHaveBeenCalledTimes(1);
  });

  it('does NOT flag drift on a transient/retryable head failure (never flip a row on a blip)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);
    mockListResources.mockResolvedValue([registryRow()]);
    mockD1Head.mockResolvedValue({
      correlationId: 'cid',
      error: { code: 'cf_server_error', message: 'HTTP 503', retryable: true },
      ok: false,
    });

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.checked).toBe(1);
    expect(res.drift).toEqual([]);
    // No drift write happened.
    const driftUpdate = mockDbUpdate.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>)?.drift_code === 'resource_missing_on_cf',
    );
    expect(driftUpdate).toBeUndefined();
  });

  it('clears stale drift + stamps last_sync_at when a row heads present (clean)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);
    mockListResources.mockResolvedValue([registryRow({ driftCode: 'resource_missing_on_cf' })]);
    mockD1Head.mockResolvedValue(okHead);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.drift).toEqual([]);
    const cleanUpdate = mockDbUpdate.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>)?.drift_code === null,
    );
    expect(cleanUpdate).toBeDefined();
    expect((cleanUpdate as unknown[])[4]).toEqual(['row_d1']);
  });

  it('skips the drift sweep with a note when CF credentials are unavailable (never throws)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);
    mockListResources.mockResolvedValue([registryRow()]);
    mockResolveCfCredentials.mockResolvedValue(null);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.checked).toBe(0);
    expect(res.drift).toEqual([]);
    expect(res.notes).toContain('no_cf_credentials');
    expect(mockD1Head).not.toHaveBeenCalled();
  });

  it('does NOT probe rows of an unimplemented kind (e.g. vectorize) — leaves them untouched', async () => {
    // d1 + kv + r2 adapters are now implemented; pick a kind with NO CF-backed adapter yet so the
    // "unimplemented kinds are skipped" contract stays honestly exercised.
    mockDbQueryOne.mockResolvedValueOnce(null);
    mockListResources.mockResolvedValue([
      registryRow({ id: 'row_vec', resourceIdOrName: 'idx-x', resourceKind: 'vectorize' }),
    ]);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.checked).toBe(0);
    expect(mockD1Head).not.toHaveBeenCalled();
    // No drift write for the unimplemented-kind row.
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

describe('reconcileResources — recording real allocations (honest empty)', () => {
  it('RECORDS a real per-site D1 allocation via recordResource when no registry row exists yet', async () => {
    // 1st dbQueryOne → the allocation row (real D1 id); 2nd → the "existing account_resource row?" miss.
    mockDbQueryOne
      .mockResolvedValueOnce({
        d1_database_id: 'alloc-db-uuid',
        d1_database_name: 'ps-site-owned',
        kv_namespace_id: null,
        kv_namespace_name: null,
        org_id: OWNER_ORG,
        r2_bucket_name: null,
        tenant_id: OWNER_ORG,
      })
      .mockResolvedValueOnce(null); // no existing registry row for (site, prod, d1)
    mockListResources.mockResolvedValue([]); // nothing to drift-sweep

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.recorded).toBe(1);
    expect(mockRecordResource).toHaveBeenCalledTimes(1);
    const [, input] = mockRecordResource.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      accessPolicy: 'no_direct',
      environment: 'production',
      orgId: OWNER_ORG,
      resourceConcept: 'account_resource',
      resourceIdOrName: 'alloc-db-uuid',
      resourceKind: 'd1',
      siteId: OWNED_SITE,
      tenancy: 'dedicated',
    });
  });

  it('records NOTHING when there is no allocation source (empty is the correct state)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null); // no allocation row at all
    mockListResources.mockResolvedValue([]);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.recorded).toBe(0);
    expect(mockRecordResource).not.toHaveBeenCalled();
  });

  it('is idempotent — a matching existing row is NOT re-recorded and NOT rewritten', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({
        d1_database_id: 'alloc-db-uuid',
        d1_database_name: 'ps-site-owned',
        kv_namespace_id: null,
        kv_namespace_name: null,
        org_id: OWNER_ORG,
        r2_bucket_name: null,
        tenant_id: OWNER_ORG,
      })
      // existing account_resource row already carries the SAME id → no-op
      .mockResolvedValueOnce({ id: 'row_d1', resource_id_or_name: 'alloc-db-uuid' });
    mockListResources.mockResolvedValue([]);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.recorded).toBe(0);
    expect(mockRecordResource).not.toHaveBeenCalled();
    // No update for a matching id.
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('refreshes a STALE id in place (updates the existing row, does not record a new one)', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({
        d1_database_id: 'fresh-db-uuid',
        d1_database_name: 'ps-site-owned',
        kv_namespace_id: null,
        kv_namespace_name: null,
        org_id: OWNER_ORG,
        r2_bucket_name: null,
        tenant_id: OWNER_ORG,
      })
      .mockResolvedValueOnce({ id: 'row_d1', resource_id_or_name: 'STALE-db-uuid' });
    mockListResources.mockResolvedValue([]);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.recorded).toBe(0);
    expect(mockRecordResource).not.toHaveBeenCalled();
    const idUpdate = mockDbUpdate.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>)?.resource_id_or_name === 'fresh-db-uuid',
    );
    expect(idUpdate).toBeDefined();
    expect((idUpdate as unknown[])[4]).toEqual(['row_d1']);
  });

  it('records multiple kinds when the allocation carries D1 + KV + R2', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({
        d1_database_id: 'db-1',
        d1_database_name: 'ps-site-owned',
        kv_namespace_id: 'kv-1',
        kv_namespace_name: 'ps-kv-owned',
        org_id: OWNER_ORG,
        r2_bucket_name: 'ps-r2-owned',
        tenant_id: OWNER_ORG,
      })
      .mockResolvedValue(null); // every "existing row?" lookup misses → all three record
    mockListResources.mockResolvedValue([]);

    const res = await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    expect(res.recorded).toBe(3);
    const kinds = mockRecordResource.mock.calls.map(
      (c) => (c[1] as Record<string, unknown>).resourceKind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['d1', 'kv', 'r2']));
  });
});

describe('reconcileResources — tenant isolation (never touches another site)', () => {
  it('scopes EVERY read + write to the passed siteId — a foreign site is never referenced', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({
        d1_database_id: 'alloc-db-uuid',
        d1_database_name: 'ps-site-owned',
        kv_namespace_id: null,
        kv_namespace_name: null,
        org_id: OWNER_ORG,
        r2_bucket_name: null,
        tenant_id: OWNER_ORG,
      })
      .mockResolvedValueOnce(null);
    mockListResources.mockResolvedValue([registryRow()]);
    mockD1Head.mockResolvedValue(goneHead);

    await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    const FOREIGN = 'site_belonging_to_someone_else';
    // allocation-source read scoped to the owned site
    const allocParams = mockDbQueryOne.mock.calls[0]?.[2] as unknown[];
    expect(allocParams).toContain(OWNED_SITE);
    expect(allocParams).not.toContain(FOREIGN);
    // listResources called ONLY for the owned site + env
    expect(mockListResources).toHaveBeenCalledWith(expect.anything(), OWNED_SITE, 'production');
    // recordResource writes the owned site
    expect((mockRecordResource.mock.calls[0]?.[1] as Record<string, unknown>).siteId).toBe(OWNED_SITE);
    // every dbUpdate is scoped by a specific row id, never a bare site/all-rows clause
    for (const call of mockDbUpdate.mock.calls) {
      expect(call[3]).toBe('id = ?'); // whereClause is always a single-row id match
    }
    // no read/write params ever reference a foreign site
    const everyParam = [
      ...mockDbQueryOne.mock.calls.flatMap((c) => (c[2] as unknown[]) ?? []),
      ...mockDbUpdate.mock.calls.flatMap((c) => (c[4] as unknown[]) ?? []),
    ];
    expect(everyParam).not.toContain(FOREIGN);
  });

  it("the head scope carries the OWNED row's id (never a foreign or caller-supplied id)", async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);
    mockListResources.mockResolvedValue([registryRow({ resourceIdOrName: 'owned-db-uuid' })]);
    mockD1Head.mockResolvedValue(okHead);

    await reconcileResources(envWith() as never, OWNED_SITE, 'production');

    const [scope] = mockD1Head.mock.calls[0] as [Record<string, unknown>];
    expect(scope.resourceId).toBe('owned-db-uuid'); // from the registry row, server-resolved
    expect(scope.siteId).toBe(OWNED_SITE);
    expect(scope.accountId).toBe('acct_server'); // from env, never the caller
  });
});
