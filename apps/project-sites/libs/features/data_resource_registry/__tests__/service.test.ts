/**
 * Unit tests for the Authoritative Resource Registry service — focused on the
 * `resolveResourceRef` SERVER-SIDE site-isolation guard (DESIGN.md §4).
 *
 * The security invariant under test: a ref for a site/env the caller does NOT own, or a kind with
 * no owned registry row, or a resolved id on the shared-platform denylist, is REJECTED with a typed
 * reason — never a resolved CF id. All external deps are mocked (swc-jest hoists `jest.mock` above
 * the imports only when it sees the GLOBAL `jest`, so we do NOT import `jest` from @jest/globals).
 * Mock module paths use FOUR `../` to reach `src/` from `libs/features/<slug>/__tests__/`.
 */

// ─── Mocks (must precede the handler/service import) ──────────────────────────
const mockDbQuery = jest.fn();
const mockDbQueryOne = jest.fn();
const mockDbInsert = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: (...a: unknown[]) => mockDbQuery(...a),
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
  dbInsert: (...a: unknown[]) => mockDbInsert(...a),
}));

const mockAssertSiteOwned = jest.fn();
jest.mock('../../../../src/services/site_ownership.js', () => ({
  assertSiteOwned: (...a: unknown[]) => mockAssertSiteOwned(...a),
}));

// The one shared-platform id the resolver must never surface (mirror the real denylist shape).
jest.mock('../../../../src/services/site_data_db.js', () => ({
  FORBIDDEN_DB_IDS: new Set(['shared-platform-db-id']),
}));

jest.mock('../../../../src/lib/uuid.js', () => ({
  uuidv7: () => 'generated-uuid-v7',
}));

import {
  getResource,
  listResources,
  recordResource,
  resolveResourceRef,
} from '../service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
type TestEnv = { DB: unknown; CF_ACCOUNT_ID?: string };
const envWith = (over: Partial<TestEnv> = {}): TestEnv => ({
  DB: {},
  CF_ACCOUNT_ID: 'acct_server',
  ...over,
});

const OWNER_ORG = 'org_owner';
const OWNED_SITE = 'site_owned';

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQueryOne.mockReset();
  mockDbInsert.mockReset();
  mockAssertSiteOwned.mockReset();
});

describe('resolveResourceRef — server-side site isolation (§4)', () => {
  it('rejects when there is no authed org (unauthorized) — never touches the DB', async () => {
    const res = await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'd1', environment: 'production' },
      { orgId: undefined },
    );
    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });

  it('REJECTS a ref for a site owned by ANOTHER org (not_owned) — no id resolved, no lookup', async () => {
    // The canonical guard says the caller's org does NOT own this site.
    mockAssertSiteOwned.mockResolvedValue(false);
    const res = await resolveResourceRef(
      envWith() as never,
      'site_belonging_to_someone_else',
      { kind: 'd1', environment: 'production' },
      { orgId: OWNER_ORG },
    );
    expect(res).toEqual({ ok: false, reason: 'not_owned' });
    // Isolation is structural: a foreign site never reaches the id lookup.
    expect(mockDbQueryOne).not.toHaveBeenCalled();
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), OWNER_ORG, 'site_belonging_to_someone_else');
  });

  it('REJECTS an unsupported kind (queue) before any ownership/DB work', async () => {
    const res = await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'queue', environment: 'production' },
      { orgId: OWNER_ORG },
    );
    expect(res).toEqual({ ok: false, reason: 'unsupported_kind' });
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });

  it('rejects when the owned site has NO registry row for the kind (not_registered)', async () => {
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue(null); // no row
    const res = await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'r2', environment: 'production' },
      { orgId: OWNER_ORG },
    );
    expect(res).toEqual({ ok: false, reason: 'not_registered' });
  });

  it('scopes the lookup to the OWNED site + authed org + requested env (params carry all three)', async () => {
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({
      id: 'row_kv',
      resource_id_or_name: 'kv-namespace-id',
      access_policy: 'site_scoped',
    });
    await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'kv', environment: 'preview' },
      { orgId: OWNER_ORG },
    );
    const [, , params] = mockDbQueryOne.mock.calls[0] as [unknown, string, unknown[]];
    // The bound params MUST include the owned site, the authed org, the env, and the kind.
    expect(params).toEqual(expect.arrayContaining([OWNED_SITE, OWNER_ORG, 'preview', 'kv']));
  });

  it('resolves the CF id from the OWNED row on success (id comes from the registry, not the caller)', async () => {
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({
      id: 'row_d1',
      resource_id_or_name: 'owned-db-uuid',
      access_policy: 'no_direct',
    });
    const res = await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'd1', environment: 'production' },
      { orgId: OWNER_ORG },
    );
    expect(res).toEqual({
      accessPolicy: 'no_direct',
      accountId: 'acct_server',
      environment: 'production',
      ok: true,
      registryRowId: 'row_d1',
      resourceId: 'owned-db-uuid',
      resourceKind: 'd1',
    });
  });

  it('FAILS CLOSED when a resolved D1 id is on the shared-platform denylist (forbidden_shared)', async () => {
    mockAssertSiteOwned.mockResolvedValue(true);
    // Even for an owned site, a resolved id that is the shared platform DB must never be surfaced.
    mockDbQueryOne.mockResolvedValue({
      id: 'row_bad',
      resource_id_or_name: 'shared-platform-db-id',
      access_policy: 'site_scoped',
    });
    const res = await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'd1', environment: 'production' },
      { orgId: OWNER_ORG },
    );
    expect(res).toEqual({ ok: false, reason: 'forbidden_shared' });
  });

  it('rejects when CF_ACCOUNT_ID is missing (no_account_id) even for an owned, resolved row', async () => {
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({
      id: 'row_kv',
      resource_id_or_name: 'kv-namespace-id',
      access_policy: 'site_scoped',
    });
    const res = await resolveResourceRef(
      envWith({ CF_ACCOUNT_ID: undefined }) as never,
      OWNED_SITE,
      { kind: 'kv', environment: 'production' },
      { orgId: OWNER_ORG },
    );
    expect(res).toEqual({ ok: false, reason: 'no_account_id' });
  });

  it('honors an injected ownership guard (a foreign-site probe rejects without the default guard)', async () => {
    const denyGuard = jest.fn().mockResolvedValue(false);
    const res = await resolveResourceRef(
      envWith() as never,
      OWNED_SITE,
      { kind: 'd1', environment: 'production' },
      { orgId: OWNER_ORG, ownsSite: denyGuard as never },
    );
    expect(res).toEqual({ ok: false, reason: 'not_owned' });
    expect(denyGuard).toHaveBeenCalledWith(expect.anything(), OWNER_ORG, OWNED_SITE);
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
  });
});

describe('recordResource', () => {
  it('mints a UUIDv7 id + stamps the SERVER account (never the client) and inserts', async () => {
    mockDbInsert.mockResolvedValue({ error: null });
    const res = await recordResource(envWith() as never, {
      orgId: OWNER_ORG,
      siteId: OWNED_SITE,
      resourceConcept: 'account_resource',
      resourceKind: 'd1',
      resourceIdOrName: 'db-uuid-1',
    });
    expect(res).toEqual({ id: 'generated-uuid-v7', ok: true });
    const [, table, row] = mockDbInsert.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(table).toBe('site_resource_registry');
    expect(row.id).toBe('generated-uuid-v7');
    expect(row.cf_account_id).toBe('acct_server'); // from env, not caller
    expect(row.deletion_protected).toBe(1); // default true → 1
  });

  it('fails when CF_ACCOUNT_ID is missing', async () => {
    const res = await recordResource(envWith({ CF_ACCOUNT_ID: undefined }) as never, {
      orgId: OWNER_ORG,
      siteId: OWNED_SITE,
      resourceConcept: 'account_resource',
      resourceKind: 'd1',
    });
    expect(res).toEqual({ error: 'no_account_id', ok: false });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('propagates a D1 insert error', async () => {
    mockDbInsert.mockResolvedValue({ error: 'boom' });
    const res = await recordResource(envWith() as never, {
      orgId: OWNER_ORG,
      siteId: OWNED_SITE,
      resourceConcept: 'account_resource',
      resourceKind: 'kv',
    });
    expect(res).toEqual({ error: 'boom', ok: false });
  });
});

describe('listResources + getResource', () => {
  it('lists a site+env rows scoped by site_id + environment, mapping to typed records', async () => {
    mockDbQuery.mockResolvedValue({
      data: [
        {
          id: 'row_1',
          org_id: OWNER_ORG,
          site_id: OWNED_SITE,
          owner_user_id: null,
          environment: 'production',
          resource_concept: 'account_resource',
          resource_kind: 'd1',
          tenancy: 'dedicated',
          cf_account_id: 'acct_server',
          wfp_dispatch_namespace: null,
          user_worker_script: null,
          resource_id_or_name: 'db-uuid-1',
          resource_display_name: 'ps-site-owned',
          binding_name: null,
          vectorize_namespace: null,
          lifecycle_state: 'active',
          provisioning_method: 'lazy',
          access_policy: 'no_direct',
          deletion_protected: 1,
          deploy_id: null,
          deployed_version: null,
          last_sync_at: null,
          drift_code: null,
          drift_detail: null,
          last_error_code: null,
          last_error_detail: null,
          usage_json: null,
          created_at: '2026-09-27T00:00:00Z',
          updated_at: '2026-09-27T00:00:00Z',
          deleted_at: null,
        },
      ],
      error: null,
    });
    const rows = await listResources(envWith() as never, OWNED_SITE, 'production');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceIdOrName).toBe('db-uuid-1');
    expect(rows[0]?.accessPolicy).toBe('no_direct');
    const [, , params] = mockDbQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(params).toEqual([OWNED_SITE, 'production']);
  });

  it('getResource scopes on BOTH id AND site_id (a foreign-site row id misses)', async () => {
    mockDbQueryOne.mockResolvedValue(null);
    const row = await getResource(envWith() as never, OWNED_SITE, 'row_from_other_site');
    expect(row).toBeNull();
    const [, , params] = mockDbQueryOne.mock.calls[0] as [unknown, string, unknown[]];
    expect(params).toEqual(['row_from_other_site', OWNED_SITE]);
  });
});
