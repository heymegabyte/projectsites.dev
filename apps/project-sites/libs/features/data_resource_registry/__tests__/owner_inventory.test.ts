/**
 * @module libs/features/data_resource_registry/__tests__/owner_inventory
 *
 * @description
 * Unit tests for {@link enumerateOwnerResources} — the truthful owner-grade inventory behind
 * GET /api/sites/:siteId/resources (fire-60, the lone-mountain-global lying-empty fix).
 *
 * Locks the four invariants:
 *  1. A site with real resources (registry d1/kv/r2 + a WfP slot + an R2 version tree) yields
 *     TYPED rows — snake_case wire keys, an owner label on EVERY row, and ZERO "unknown" rows.
 *  2. Platform-shared rows are EXCLUDED (tenancy `shared_platform`, forbidden-id denylist) —
 *     the master platform D1 can never surface as "the site's".
 *  3. A truly blank site yields an HONEST empty array.
 *  4. A site whose registry was never reconcile-seeded STILL surfaces its live allocations
 *     (the "empty until reconcile" regression).
 *
 * Uses the swc-jest GLOBAL `jest` convention (mocks declared before imports).
 */

// ─── Mocks (must be declared BEFORE any import that triggers the modules) ─────

const mockListResources = jest.fn();
jest.mock('../service.js', () => ({
  listResources: (...args: unknown[]) => mockListResources(...args),
  forbiddenIdsForKind: (kind: string) =>
    kind === 'd1' ? new Set(['forbidden-platform-db']) : new Set(),
  resolveResourceRef: jest.fn(),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

const mockResolveSiteResources = jest.fn();
jest.mock('../site_resources.js', () => ({
  resolveSiteResources: (...args: unknown[]) => mockResolveSiteResources(...args),
}));

const mockDbQueryOne = jest.fn();
const mockDbQuery = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: (...args: unknown[]) => mockDbQueryOne(...args),
  dbQuery: (...args: unknown[]) => mockDbQuery(...args),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(),
}));

// ─── Import AFTER mocks ────────────────────────────────────────────────────────
import {
  enumerateOwnerResources,
  OWNER_LABELS,
  ownerLabelFor,
  type OwnerResourceEntry,
} from '../owner_inventory.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SITE_ID = '4f450690-e622-4c95-a83d-e5516a2c9442';

/** A minimal registry ResourceRecord as the enumerator consumes it. */
function registryRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'row-x',
    orgId: 'org-1',
    siteId: SITE_ID,
    environment: 'production',
    resourceConcept: 'account_resource',
    resourceKind: 'd1',
    tenancy: 'dedicated',
    lifecycleState: 'active',
    resourceIdOrName: 'id-x',
    resourceDisplayName: null,
    bindingName: null,
    userWorkerScript: null,
    wfpDispatchNamespace: null,
    deployedVersion: null,
    driftCode: null,
    lastSyncAt: null,
    ...overrides,
  };
}

function makeEnv(r2Objects: number): Record<string, unknown> {
  return {
    DB: {},
    SITES_BUCKET: {
      list: jest.fn().mockResolvedValue({
        objects: Array.from({ length: r2Objects }, (_, i) => ({ key: `k${i}` })),
      }),
    },
  };
}

/** No row may be untyped: kind + owner_label present, and neither is "unknown". */
function assertNoUnknown(entries: OwnerResourceEntry[]): void {
  for (const e of entries) {
    expect(e.resource_kind).toBeTruthy();
    expect(e.resource_kind.toLowerCase()).not.toContain('unknown');
    expect(e.owner_label).toBeTruthy();
    expect(e.owner_label.toLowerCase()).not.toContain('unknown');
    expect(e.lifecycle_state).toBeTruthy();
  }
}

beforeEach(() => {
  mockListResources.mockReset();
  mockResolveSiteResources.mockReset();
  mockDbQueryOne.mockReset();
  mockDbQuery.mockReset();
});

// ─── 1. Full site → typed rows, zero unknown ──────────────────────────────────

describe('enumerateOwnerResources — a built site', () => {
  it('maps registry d1/kv/r2 + the WfP slot to typed snake_case rows with owner labels', async () => {
    mockListResources.mockResolvedValue([
      registryRow({ id: 'row-d1', resourceKind: 'd1', resourceIdOrName: 'db-180a', resourceDisplayName: 'ps-site-x' }),
      registryRow({ id: 'row-kv', resourceKind: 'kv', resourceIdOrName: 'kv-479f', resourceDisplayName: 'ps-site-x-kv' }),
      registryRow({ id: 'row-r2', resourceKind: 'r2', resourceIdOrName: 'ps-site-x', resourceDisplayName: 'ps-site-x' }),
      registryRow({
        id: 'row-wfp',
        resourceKind: 'durable_object',
        resourceConcept: 'wfp_namespace',
        resourceIdOrName: 'ns-6ea1',
        resourceDisplayName: 'WfP dispatch namespace (project-sites-endpoints)',
        userWorkerScript: `site-${SITE_ID}`,
        lifecycleState: 'degraded',
      }),
    ]);
    mockResolveSiteResources.mockResolvedValue({
      ok: true,
      resources: {
        d1DatabaseId: 'db-180a', // already in the registry → deduped, not doubled
        d1DatabaseName: 'ps-site-x',
        kvNamespaceId: 'kv-479f',
        kvNamespaceName: 'ps-site-x-kv',
        r2BucketName: 'ps-site-x',
      },
    });
    mockDbQueryOne.mockResolvedValue({
      slug: 'lone-mountain-global',
      current_build_version: '2026-10-01T04-44-44-797Z',
    });
    mockDbQuery.mockResolvedValue({ data: [] });

    const entries = await enumerateOwnerResources(
      makeEnv(1) as never,
      SITE_ID,
      'production',
    );

    // 3+ typed rows; 0 unknown.
    expect(entries.length).toBeGreaterThanOrEqual(3);
    assertNoUnknown(entries);

    // snake_case wire keys — the camelCase wire bug can never regress.
    for (const e of entries) {
      expect(e.resource_kind).toBeDefined();
      expect((e as unknown as Record<string, unknown>).resourceKind).toBeUndefined();
      expect((e as unknown as Record<string, unknown>).lifecycleState).toBeUndefined();
    }

    // Owner-grade typing of each real resource.
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get('row-d1')?.owner_label).toBe('Your site database');
    expect(byId.get('row-kv')?.owner_label).toBe('Your site key-value store');
    expect(byId.get('row-r2')?.owner_label).toBe('Your site storage');

    // The WfP slot row surfaces as the SITE WORKER, never a bare durable_object/"unknown".
    const wfp = byId.get('row-wfp');
    expect(wfp?.resource_kind).toBe('wfp_worker');
    expect(wfp?.owner_label).toBe('Your site worker');
    expect(wfp?.detail).toContain(`site-${SITE_ID}`);

    // The shared-bucket version tree surfaces as "Your site files".
    const files = entries.find((e) => e.resource_concept === 'site_files');
    expect(files?.owner_label).toBe('Your site files');
    expect(files?.detail).toContain('sites/lone-mountain-global/2026-10-01T04-44-44-797Z/');

    // The default-subdomain routing entry is present.
    const routing = entries.find((e) => e.resource_kind === 'routing');
    expect(routing?.display_name).toBe('lone-mountain-global.projectsites.dev');

    // Dedupe: the allocation layer must NOT double the registry's d1/kv/r2.
    expect(entries.filter((e) => e.resource_kind === 'd1')).toHaveLength(1);
    expect(entries.filter((e) => e.resource_kind === 'kv')).toHaveLength(1);
  });
});

// ─── 2. Platform-shared exclusion ─────────────────────────────────────────────

describe('enumerateOwnerResources — platform-shared exclusion', () => {
  it('drops shared_platform rows and forbidden-id rows from the owner inventory', async () => {
    mockListResources.mockResolvedValue([
      registryRow({ id: 'row-shared', resourceKind: 'kv', tenancy: 'shared_platform', resourceIdOrName: 'platform-kv' }),
      registryRow({ id: 'row-forbidden', resourceKind: 'd1', resourceIdOrName: 'forbidden-platform-db' }),
      registryRow({ id: 'row-ok', resourceKind: 'r2', resourceIdOrName: 'ps-site-x' }),
    ]);
    mockResolveSiteResources.mockResolvedValue({ ok: false, reason: 'forbidden_db_id' });
    mockDbQueryOne.mockResolvedValue(null);
    mockDbQuery.mockResolvedValue({ data: [] });

    const entries = await enumerateOwnerResources(makeEnv(0) as never, SITE_ID, 'production');

    expect(entries.map((e) => e.id)).toEqual(['row-ok']);
    expect(entries.some((e) => e.detail?.includes('forbidden-platform-db'))).toBe(false);
    expect(entries.some((e) => e.detail?.includes('platform-kv'))).toBe(false);
  });
});

// ─── 3. Honest empty for a truly blank site ───────────────────────────────────

describe('enumerateOwnerResources — unbuilt site', () => {
  it('returns an honest empty array when the site truly has nothing', async () => {
    mockListResources.mockResolvedValue([]);
    mockResolveSiteResources.mockResolvedValue({ ok: false, reason: 'no_dedicated_resources' });
    mockDbQueryOne.mockResolvedValue(null); // no live sites row
    mockDbQuery.mockResolvedValue({ data: [] });

    const entries = await enumerateOwnerResources(makeEnv(0) as never, SITE_ID, 'production');
    expect(entries).toEqual([]);
  });

  it('returns an honest empty array for the preview environment of a blank site', async () => {
    mockListResources.mockResolvedValue([]);
    mockResolveSiteResources.mockResolvedValue({ ok: false, reason: 'no_dedicated_resources' });

    const entries = await enumerateOwnerResources(makeEnv(0) as never, SITE_ID, 'preview');
    expect(entries).toEqual([]);
    // Preview never reads the production serving stores.
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });
});

// ─── 4. Allocation-without-registry (the lying-empty regression) ──────────────

describe('enumerateOwnerResources — registry never reconcile-seeded', () => {
  it('still surfaces live allocations + serving resources (no prior reconcile required)', async () => {
    mockListResources.mockResolvedValue([]); // the old source — empty forever without a reconcile
    mockResolveSiteResources.mockResolvedValue({
      ok: true,
      resources: {
        d1DatabaseId: 'db-alloc',
        d1DatabaseName: 'ps-site-alloc',
        kvNamespaceId: 'kv-alloc',
        kvNamespaceName: 'ps-site-alloc-kv',
        r2BucketName: 'ps-site-alloc',
      },
    });
    mockDbQueryOne.mockResolvedValue({
      slug: 'lone-mountain-global',
      current_build_version: 'v1',
    });
    mockDbQuery.mockResolvedValue({
      data: [{ id: 'h1', hostname: 'lonemountainglobal.com', status: 'active' }],
    });

    const entries = await enumerateOwnerResources(makeEnv(1) as never, SITE_ID, 'production');

    assertNoUnknown(entries);
    const kinds = entries.map((e) => e.resource_kind);
    expect(kinds).toEqual(expect.arrayContaining(['d1', 'kv', 'r2', 'routing', 'hostname']));

    const domain = entries.find((e) => e.resource_kind === 'hostname');
    expect(domain?.owner_label).toBe('Your domain');
    expect(domain?.display_name).toBe('lonemountainglobal.com');
    expect(domain?.lifecycle_state).toBe('active');

    // Both R2 facets are present: the dedicated bucket AND the shared-tree site files.
    expect(entries.filter((e) => e.resource_kind === 'r2')).toHaveLength(2);
  });
});

// ─── Label-map totality ───────────────────────────────────────────────────────

describe('ownerLabelFor', () => {
  it('has an explicit owner label for every wire kind the enumerator emits', () => {
    for (const kind of [
      'd1', 'kv', 'r2', 'wfp_worker', 'hostname', 'routing',
      'durable_object', 'workflow', 'queue', 'vectorize', 'analytics_engine', 'connection',
    ]) {
      expect(OWNER_LABELS[kind]).toBeTruthy();
      expect(ownerLabelFor(kind).toLowerCase()).not.toContain('unknown');
    }
  });

  it('falls back to a LABELED type (never "unknown") for an unmapped kind', () => {
    expect(ownerLabelFor('something_new')).toBe('Platform resource');
  });
});
