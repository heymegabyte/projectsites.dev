/**
 * @module libs/features/data_resource_registry/__tests__/detail_handler
 *
 * @description
 * Handler-level security + dispatch tests for the GENERIC resource-detail route:
 *   GET /api/sites/:siteId/resources/:kind/detail?action=list|get
 *
 * Verifies the 5-step security gate in ORDER + the adapter dispatch:
 *   1. AUTH        (no orgId → 401)
 *   2. FLAG-DARK   (flag off → 404, never 403)
 *   3. OWNERSHIP   (foreign site → 404, never 403 — site-isolation)
 *   4. OPERANDS    (bad kind → 400, bad action → 400, bad environment → 400)
 *   5. RESOLVE     (owned + flag on → resolveResourceRef → dispatch to IMPLEMENTED_ADAPTERS[kind])
 *
 * Plus: a `not_registered` resolve → honest passthrough (200 with an `ok:false` result, never 500);
 * a NO-CF-ID smuggle attempt is ignored (only siteId+kind+action+safe params reach the adapter).
 *
 * Uses the swc-jest GLOBAL `jest` convention (no `import { jest }`) so `jest.mock` hoists above the
 * handler import — see the repo gotcha in apps/project-sites/CLAUDE.md.
 */
import { Hono } from 'hono';

// ─── Mocks (declared BEFORE any import that pulls the modules) ─────────────────

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...args: unknown[]) => mockIsFlagOn(...args),
}));

const mockOwnsSiteData = jest.fn();
jest.mock('../../../features/site_data_api/handlers.js', () => ({
  ownsSiteData: (...args: unknown[]) => mockOwnsSiteData(...args),
  SITE_DATA_OVERVIEW_TABLES: [],
  DELETABLE_OVERVIEW_TABLES: {},
  EDITABLE_OVERVIEW_COLUMNS: {},
  ALLOWED_PUBLIC_TABLES: [],
}));

const mockResolveResourceRef = jest.fn();
const mockListResources = jest.fn();
jest.mock('../service.js', () => ({
  resolveResourceRef: (...args: unknown[]) => mockResolveResourceRef(...args),
  listResources: (...args: unknown[]) => mockListResources(...args),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

const mockResolveCfCredentials = jest.fn();
jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: (...args: unknown[]) => mockResolveCfCredentials(...args),
  cfAuthHeaders: () => ({}),
}));

// The detail handler dispatches to IMPLEMENTED_ADAPTERS[kind].list|get — mock the reconciler module so
// we control the adapter map (and reconcileResources, which the same handlers.ts file also imports).
const mockD1List = jest.fn();
const mockD1Get = jest.fn();
const mockReconcileResources = jest.fn();
jest.mock('../reconciler.js', () => ({
  reconcileResources: (...args: unknown[]) => mockReconcileResources(...args),
  IMPLEMENTED_ADAPTERS: {
    d1: {
      kind: 'd1',
      supports: { environments: ['preview', 'production'], verbs: ['list', 'head', 'get'], mutations: [] },
      list: (...args: unknown[]) => mockD1List(...args),
      get: (...args: unknown[]) => mockD1Get(...args),
      head: jest.fn(),
      mutate: jest.fn(),
    },
    // A kind whose adapter serves head only — to prove the verb-capability gate returns not_supported.
    analytics_engine: {
      kind: 'analytics_engine',
      supports: { environments: ['preview', 'production'], verbs: ['head', 'get'], mutations: [] },
      list: jest.fn(),
      get: jest.fn(),
      head: jest.fn(),
      mutate: jest.fn(),
    },
  },
}));

// ─── Import AFTER mocks ────────────────────────────────────────────────────────
import { resourceRegistryApi } from '../handlers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

const EXEC = { waitUntil: () => {}, passThroughOnException: () => {} };
const ENV = { DB: {}, CF_ACCOUNT_ID: 'acct-1', ANALYTICS_INGEST_ENABLED: 'false' };

function makeApp(orgId: string | null = 'org-1') {
  const a = new Hono<{ Variables: { orgId: string | null } }>();
  a.use('*', async (c, next) => {
    if (orgId !== null) c.set('orgId' as never, orgId);
    await next();
  });
  a.route('/', resourceRegistryApi);
  return a;
}

function detail(
  siteId: string,
  kind: string,
  query = 'action=list',
  opts: { orgId?: string | null } = {},
) {
  const { orgId = 'org-1' } = opts;
  return makeApp(orgId).request(
    `/api/sites/${siteId}/resources/${kind}/detail?${query}`,
    { method: 'GET' },
    ENV as never,
    EXEC as never,
  );
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockOwnsSiteData.mockReset();
  mockResolveResourceRef.mockReset();
  mockListResources.mockReset();
  mockResolveCfCredentials.mockReset();
  mockD1List.mockReset();
  mockD1Get.mockReset();
  mockReconcileResources.mockReset();
  // Sensible defaults for the "happy" branch; individual tests override.
  mockResolveCfCredentials.mockResolvedValue({ kind: 'token', token: 't' });
});

// ── 1. AUTH ─────────────────────────────────────────────────────────────────────

it('returns 401 when orgId is absent (no auth)', async () => {
  const res = await detail('site-1', 'd1', 'action=list', { orgId: null });
  expect(res.status).toBe(401);
  expect(mockIsFlagOn).not.toHaveBeenCalled();
  expect(mockOwnsSiteData).not.toHaveBeenCalled();
});

// ── 2. FLAG-DARK ─────────────────────────────────────────────────────────────────

it('returns 404 when the flag is OFF (DARK — never 403)', async () => {
  mockIsFlagOn.mockResolvedValue(false);
  const res = await detail('site-1', 'd1');
  expect(res.status).toBe(404);
  // Ownership must NOT have been consulted before the flag gate.
  expect(mockOwnsSiteData).not.toHaveBeenCalled();
});

// ── 3. OWNERSHIP (site-isolation) ────────────────────────────────────────────────

it('returns 404 when the caller does NOT own the site (IDOR — never 403, foreign 404)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(false);
  const res = await detail('foreign-site', 'd1', 'action=list', { orgId: 'org-attacker' });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('NOT_FOUND');
  // The adapter + resolver must NOT have been reached.
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
  expect(mockD1List).not.toHaveBeenCalled();
});

// ── 4. OPERANDS ──────────────────────────────────────────────────────────────────

it('returns 400 on an invalid kind', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await detail('site-1', 'not-a-kind');
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

it('returns 400 on an invalid action', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await detail('site-1', 'd1', 'action=mutate');
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

it('returns 400 on an invalid environment', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await detail('site-1', 'd1', 'action=list&environment=staging');
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

// ── 5. RESOLVE + dispatch ─────────────────────────────────────────────────────────

it('dispatches to the adapter list() and returns its AdapterResult verbatim', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  mockResolveResourceRef.mockResolvedValue({
    ok: true,
    resourceId: 'db-abc',
    resourceKind: 'd1',
    environment: 'production',
    accountId: 'acct-1',
    registryRowId: 'row-1',
    accessPolicy: 'no_direct',
  });
  mockD1List.mockResolvedValue({ ok: true, data: { tables: [{ name: 'orders' }] }, correlationId: 'd1-x' });

  const res = await detail('site-1', 'd1', 'action=list');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { kind: string; action: string; result: { ok: boolean; data: { tables: { name: string }[] } } } };
  expect(body.data.kind).toBe('d1');
  expect(body.data.action).toBe('list');
  expect(body.data.result.ok).toBe(true);
  expect(body.data.result.data.tables[0].name).toBe('orders');

  // The adapter was called with a server-resolved scope carrying the RESOLVED id (never a caller id).
  expect(mockD1List).toHaveBeenCalledTimes(1);
  const scopeArg = mockD1List.mock.calls[0][0] as { resourceId: string; siteId: string; accountId: string };
  expect(scopeArg.resourceId).toBe('db-abc');
  expect(scopeArg.siteId).toBe('site-1');
  expect(scopeArg.accountId).toBe('acct-1');
});

it('dispatches to get() and forwards the safe `table` param (never a CF id)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  mockResolveResourceRef.mockResolvedValue({
    ok: true,
    resourceId: 'db-abc',
    resourceKind: 'd1',
    environment: 'production',
    accountId: 'acct-1',
    registryRowId: 'row-1',
    accessPolicy: 'no_direct',
  });
  mockD1Get.mockResolvedValue({ ok: true, data: { table: 'orders', columns: [], rows: [], limit: 50, offset: 0, total: 0 }, correlationId: 'd1-y' });

  // A smuggled resourceId/databaseId must be IGNORED (strict schema) — only `table` reaches the adapter.
  const res = await detail('site-1', 'd1', 'action=get&table=orders&limit=10&databaseId=EVIL&resourceId=EVIL');
  expect(res.status).toBe(200);
  expect(mockD1Get).toHaveBeenCalledTimes(1);
  const [scopeArg, inputArg] = mockD1Get.mock.calls[0] as [{ resourceId: string }, Record<string, unknown>];
  expect(scopeArg.resourceId).toBe('db-abc'); // the RESOLVED id, not the smuggled one
  expect(inputArg.table).toBe('orders');
  expect(inputArg.limit).toBe(10);
  // The smuggled CF-id keys are stripped by the strict params schema.
  expect(inputArg).not.toHaveProperty('databaseId');
  expect(inputArg).not.toHaveProperty('resourceId');
});

it('passes through not_registered as an honest ok:false result (200, never 500)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  mockResolveResourceRef.mockResolvedValue({ ok: false, reason: 'not_registered' });

  const res = await detail('site-1', 'd1', 'action=list');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { result: { ok: boolean; error: { code: string } } } };
  expect(body.data.result.ok).toBe(false);
  expect(body.data.result.error.code).toBe('not_registered');
  // The adapter itself was never called (resolve failed first).
  expect(mockD1List).not.toHaveBeenCalled();
});

it('returns a not_supported result when the adapter does not serve the requested verb', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);

  // analytics_engine supports only head/get — a `list` must return an honest not_supported result BEFORE resolve.
  const res = await detail('site-1', 'analytics_engine', 'action=list');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { result: { ok: boolean; error: { code: string } } } };
  expect(body.data.result.ok).toBe(false);
  expect(body.data.result.error.code).toBe('not_supported');
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});
