/**
 * @module libs/features/data_resource_registry/__tests__/handlers
 *
 * @description
 * Handler-level security gate tests for:
 *   GET  /api/sites/:siteId/resources        — list the site's registry rows
 *   POST /api/sites/:siteId/resources/reconcile — reconcile registry ↔ CF
 *
 * Verifies the 5-step security gate in ORDER:
 *   1. AUTH       (no orgId → 401)
 *   2. FLAG-DARK  (flag off → 404, never 403)
 *   3. OWNERSHIP  (foreign site → 404, never 403)
 *   4. OPERANDS   (invalid environment → 400)
 *   5. RESOLVE    (owned site + flag on → 200 with real data)
 *
 * Does NOT break existing tests. Uses the swc-jest global jest convention.
 */
import { Hono } from 'hono';

// ─── Mocks (must be declared BEFORE any import that triggers the modules) ─────

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...args: unknown[]) => mockIsFlagOn(...args),
}));

const mockOwnsSiteData = jest.fn();
jest.mock('../../../features/site_data_api/handlers.js', () => ({
  ownsSiteData: (...args: unknown[]) => mockOwnsSiteData(...args),
  // Keep other named exports that may be re-exported — add as needed.
  SITE_DATA_OVERVIEW_TABLES: [],
  DELETABLE_OVERVIEW_TABLES: {},
  EDITABLE_OVERVIEW_COLUMNS: {},
  ALLOWED_PUBLIC_TABLES: [],
}));

const mockListResources = jest.fn();
jest.mock('../service.js', () => ({
  listResources: (...args: unknown[]) => mockListResources(...args),
  resolveResourceRef: jest.fn(),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

// The GET now reads the owner-grade enumerator (fire-60) — mock it like the old listResources.
const mockEnumerateOwnerResources = jest.fn();
jest.mock('../owner_inventory.js', () => ({
  enumerateOwnerResources: (...args: unknown[]) => mockEnumerateOwnerResources(...args),
  ownerLabelFor: (kind: string) => `label:${kind}`,
  OWNER_LABELS: {},
}));

const mockReconcileResources = jest.fn();
jest.mock('../reconciler.js', () => ({
  reconcileResources: (...args: unknown[]) => mockReconcileResources(...args),
}));

// ─── Import AFTER mocks ────────────────────────────────────────────────────────
import { resourceRegistryApi } from '../handlers.js';

// ─── Test helpers ──────────────────────────────────────────────────────────────

const EXEC = { waitUntil: () => {}, passThroughOnException: () => {} };

/** Build a Hono app that injects the orgId into context (simulating auth middleware). */
function makeApp(orgId: string | null = 'org-1') {
  const a = new Hono<{ Variables: { orgId: string | null } }>();
  a.use('*', async (c, next) => {
    if (orgId !== null) c.set('orgId' as never, orgId);
    await next();
  });
  a.route('/', resourceRegistryApi);
  return a;
}

function getResources(
  siteId: string,
  opts: {
    orgId?: string | null;
    environment?: string;
  } = {},
) {
  const { orgId = 'org-1', environment } = opts;
  const url = environment
    ? `/api/sites/${siteId}/resources?environment=${environment}`
    : `/api/sites/${siteId}/resources`;
  return makeApp(orgId).request(url, { method: 'GET' }, {} as never, EXEC as never);
}

function reconcile(
  siteId: string,
  opts: {
    orgId?: string | null;
    environment?: string;
  } = {},
) {
  const { orgId = 'org-1', environment } = opts;
  const url = environment
    ? `/api/sites/${siteId}/resources/reconcile?environment=${environment}`
    : `/api/sites/${siteId}/resources/reconcile`;
  return makeApp(orgId).request(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    {} as never,
    EXEC as never,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockOwnsSiteData.mockReset();
  mockListResources.mockReset();
  mockEnumerateOwnerResources.mockReset();
  mockReconcileResources.mockReset();
});

// ── GET /api/sites/:siteId/resources ──────────────────────────────────────────

describe('GET /api/sites/:siteId/resources', () => {
  it('returns 401 when orgId is absent (no auth)', async () => {
    const res = await getResources('site-1', { orgId: null });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    // Flag + ownership must NOT have been consulted.
    expect(mockIsFlagOn).not.toHaveBeenCalled();
    expect(mockOwnsSiteData).not.toHaveBeenCalled();
  });

  it('returns 404 when the flag is OFF (DARK — never 403)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await getResources('site-1');
    expect(res.status).toBe(404);
    // Ownership must NOT have been consulted before the flag gate.
    expect(mockOwnsSiteData).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller does NOT own the site (IDOR guard — never 403)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(false);
    const res = await getResources('foreign-site', { orgId: 'org-attacker' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    // The ownership check fired; the enumerator must NOT have been called.
    expect(mockEnumerateOwnerResources).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid environment param', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(true);
    const res = await getResources('site-1', { environment: 'staging' });
    expect(res.status).toBe(400);
    expect(mockEnumerateOwnerResources).not.toHaveBeenCalled();
  });

  it('returns 200 with owner-grade snake_case wire rows for an owned site when flag is ON', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(true);
    mockEnumerateOwnerResources.mockResolvedValue([
      {
        id: 'row-1',
        resource_kind: 'd1',
        resource_concept: 'account_resource',
        environment: 'production',
        tenancy: 'dedicated',
        lifecycle_state: 'active',
        display_name: 'ps-site-x',
        owner_label: 'Your site database',
        detail: 'id: db-abc',
      },
      {
        id: 'row-2',
        resource_kind: 'wfp_worker',
        resource_concept: 'wfp_namespace',
        environment: 'production',
        tenancy: 'dedicated',
        lifecycle_state: 'active',
        display_name: 'site-abc (production)',
        owner_label: 'Your site worker',
      },
    ]);

    const res = await getResources('site-1');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        environment: string;
        resources: Record<string, unknown>[];
        countsByKind: Record<string, number>;
      };
    };
    expect(body.data.environment).toBe('production');
    expect(body.data.resources).toHaveLength(2);
    expect(body.data.countsByKind['d1']).toBe(1);
    expect(body.data.countsByKind['wfp_worker']).toBe(1);
    // The wire contract is snake_case + owner-labeled — the editor reads these exact keys.
    expect(body.data.resources[0]?.resource_kind).toBe('d1');
    expect(body.data.resources[0]?.owner_label).toBe('Your site database');
    expect(body.data.resources[0]?.resourceKind).toBeUndefined();
  });

  it('returns 200 with empty resources for a truly blank site (honest empty)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(true);
    mockEnumerateOwnerResources.mockResolvedValue([]);

    const res = await getResources('site-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { resources: unknown[] } };
    expect(body.data.resources).toHaveLength(0);
  });
});

// ── POST /api/sites/:siteId/resources/reconcile ───────────────────────────────

describe('POST /api/sites/:siteId/resources/reconcile', () => {
  it('returns 401 when orgId is absent (no auth)', async () => {
    const res = await reconcile('site-1', { orgId: null });
    expect(res.status).toBe(401);
    expect(mockIsFlagOn).not.toHaveBeenCalled();
  });

  it('returns 404 when the flag is OFF (DARK — never 403)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await reconcile('site-1');
    expect(res.status).toBe(404);
    expect(mockOwnsSiteData).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller does NOT own the site (IDOR guard — never 403)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(false);
    const res = await reconcile('foreign-site', { orgId: 'org-attacker' });
    expect(res.status).toBe(404);
    expect(mockReconcileResources).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid environment param', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(true);
    const res = await reconcile('site-1', { environment: 'staging' });
    expect(res.status).toBe(400);
    expect(mockReconcileResources).not.toHaveBeenCalled();
  });

  it('returns 200 with reconcile summary for an owned site when flag is ON', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(true);
    mockReconcileResources.mockResolvedValue({
      siteId: 'site-1',
      environment: 'production',
      reconciled: 1,
      recorded: 1,
      checked: 1,
      drift: [],
      notes: [],
    });

    const res = await reconcile('site-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { environment: string; reconciled: number; drift: unknown[] } };
    expect(body.data.environment).toBe('production');
    expect(body.data.reconciled).toBe(1);
    expect(body.data.drift).toHaveLength(0);
  });

  it('returns 200 with drift entry when a registry row is missing on CF', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockOwnsSiteData.mockResolvedValue(true);
    mockReconcileResources.mockResolvedValue({
      siteId: 'site-1',
      environment: 'production',
      reconciled: 1,
      recorded: 0,
      checked: 1,
      drift: [
        {
          resourceKind: 'd1',
          driftCode: 'resource_missing_on_cf',
          driftDetail: 'Head probe returned 404 for db-gone',
        },
      ],
      notes: [],
    });

    const res = await reconcile('site-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { drift: Array<{ resourceKind: string; driftCode: string }> } };
    expect(body.data.drift).toHaveLength(1);
    expect(body.data.drift[0].driftCode).toBe('resource_missing_on_cf');
    expect(body.data.drift[0].resourceKind).toBe('d1');
  });
});
