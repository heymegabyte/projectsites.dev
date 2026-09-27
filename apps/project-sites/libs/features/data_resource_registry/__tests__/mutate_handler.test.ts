/**
 * @module libs/features/data_resource_registry/__tests__/mutate_handler
 *
 * @description
 * Handler-level security + dispatch tests for the GENERIC resource-MUTATE route:
 *   POST /api/sites/:siteId/resources/:kind/mutate   body { action, input?, confirm? }
 *
 * Verifies the 5-step security gate in ORDER + the adapter `mutate` dispatch:
 *   1. AUTH        (no orgId → 401)
 *   2. FLAG-DARK   (flag off → 404, never 403)
 *   3. OWNERSHIP   (foreign site → 404, never 403 — site-isolation)
 *   4. OPERANDS    (bad kind → 400, missing action → 400, smuggled CF id in body → 400, bad env → 400,
 *                   an action NOT in the adapter's supports.mutations → honest not_supported result)
 *   5. RESOLVE     (owned + flag on → resolveResourceRef → dispatch to IMPLEMENTED_ADAPTERS[kind].mutate;
 *                   `provision` SKIPS resolve + attaches env to the scope — the id is PRODUCED)
 *
 * Plus: the adapter's typed results pass through verbatim as 200 `{ data:{ kind, action, result } }` —
 * a `confirmation_required` (confirm omitted) and a `confirm:true` success both ride in `result`, never
 * as a transport error; `not_registered` from resolve → honest ok:false result (never 500); a smuggled
 * `resourceId`/`databaseId` in the body is REJECTED (400) by the strict schema.
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

// The mutate handler dispatches to IMPLEMENTED_ADAPTERS[kind].mutate — mock the reconciler module so we
// control the adapter map (and reconcileResources, which the same handlers.ts file also imports).
const mockKvMutate = jest.fn();
const mockReconcileResources = jest.fn();
jest.mock('../reconciler.js', () => ({
  reconcileResources: (...args: unknown[]) => mockReconcileResources(...args),
  IMPLEMENTED_ADAPTERS: {
    // kv serves put/delete/provision — the WRITE slice under test.
    kv: {
      kind: 'kv',
      supports: { environments: ['preview', 'production'], verbs: ['list', 'head', 'get', 'mutate'], mutations: ['put', 'delete', 'provision'] },
      list: jest.fn(),
      get: jest.fn(),
      head: jest.fn(),
      mutate: (...args: unknown[]) => mockKvMutate(...args),
    },
    // analytics_engine is read-only (mutations: []) — to prove a write action returns not_supported.
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

function mutate(
  siteId: string,
  kind: string,
  body: unknown,
  opts: { orgId?: string | null; query?: string } = {},
) {
  const { orgId = 'org-1', query = '' } = opts;
  return makeApp(orgId).request(
    `/api/sites/${siteId}/resources/${kind}/mutate${query ? `?${query}` : ''}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    ENV as never,
    EXEC as never,
  );
}

/** The happy-path resolve stub (an owned KV namespace). */
function resolveOwned() {
  mockResolveResourceRef.mockResolvedValue({
    ok: true,
    resourceId: 'ns-abc',
    resourceKind: 'kv',
    environment: 'production',
    accountId: 'acct-1',
    registryRowId: 'row-1',
    accessPolicy: 'site_scoped',
  });
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockOwnsSiteData.mockReset();
  mockResolveResourceRef.mockReset();
  mockListResources.mockReset();
  mockResolveCfCredentials.mockReset();
  mockKvMutate.mockReset();
  mockReconcileResources.mockReset();
  mockResolveCfCredentials.mockResolvedValue({ kind: 'token', token: 't' });
});

// ── 1. AUTH ─────────────────────────────────────────────────────────────────────

it('returns 401 when orgId is absent (no auth)', async () => {
  const res = await mutate('site-1', 'kv', { action: 'delete', input: { key: 'x' } }, { orgId: null });
  expect(res.status).toBe(401);
  expect(mockIsFlagOn).not.toHaveBeenCalled();
  expect(mockOwnsSiteData).not.toHaveBeenCalled();
});

// ── 2. FLAG-DARK ─────────────────────────────────────────────────────────────────

it('returns 404 when the flag is OFF (DARK — never 403)', async () => {
  mockIsFlagOn.mockResolvedValue(false);
  const res = await mutate('site-1', 'kv', { action: 'delete', input: { key: 'x' } });
  expect(res.status).toBe(404);
  expect(mockOwnsSiteData).not.toHaveBeenCalled();
});

// ── 3. OWNERSHIP (site-isolation) ────────────────────────────────────────────────

it('returns 404 when the caller does NOT own the site (IDOR — never 403, foreign 404)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(false);
  const res = await mutate('foreign-site', 'kv', { action: 'delete', input: { key: 'x' } }, { orgId: 'org-attacker' });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('NOT_FOUND');
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
  expect(mockKvMutate).not.toHaveBeenCalled();
});

// ── 4. OPERANDS ──────────────────────────────────────────────────────────────────

it('returns 400 on an invalid kind', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await mutate('site-1', 'not-a-kind', { action: 'delete' });
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

it('returns 400 when the body is missing an action', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await mutate('site-1', 'kv', { input: { key: 'x' } });
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

it('returns 400 when a CF id is SMUGGLED at the top level of the body (strict schema)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await mutate('site-1', 'kv', { action: 'delete', resourceId: 'EVIL', databaseId: 'EVIL' });
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
  expect(mockKvMutate).not.toHaveBeenCalled();
});

it('returns 400 on an invalid environment', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  const res = await mutate('site-1', 'kv', { action: 'delete', input: { key: 'x' } }, { query: 'environment=staging' });
  expect(res.status).toBe(400);
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

it('returns a not_supported result when the action is NOT in the adapter supports.mutations', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  // analytics_engine has mutations: [] — any write action must return an honest not_supported result BEFORE resolve.
  const res = await mutate('site-1', 'analytics_engine', { action: 'put', input: { key: 'x', value: 'y' } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { result: { ok: boolean; error: { code: string } } } };
  expect(body.data.result.ok).toBe(false);
  expect(body.data.result.error.code).toBe('not_supported');
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
});

// ── 5. RESOLVE + dispatch ─────────────────────────────────────────────────────────

it('dispatches to the adapter mutate() with the merged {action,...input} + resolved scope, returns AdapterResult verbatim', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  resolveOwned();
  mockKvMutate.mockResolvedValue({ ok: true, data: { action: 'put', key: 'greeting', overwritten: false, metadataStored: false }, correlationId: 'kv-x' });

  const res = await mutate('site-1', 'kv', { action: 'put', input: { key: 'greeting', value: 'hi' } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { kind: string; action: string; result: { ok: boolean; data: { key: string } } } };
  expect(body.data.kind).toBe('kv');
  expect(body.data.action).toBe('put');
  expect(body.data.result.ok).toBe(true);
  expect(body.data.result.data.key).toBe('greeting');

  // The adapter was called with the RESOLVED scope + the merged mutation input (action + input operands).
  expect(mockKvMutate).toHaveBeenCalledTimes(1);
  const [scopeArg, inputArg] = mockKvMutate.mock.calls[0] as [{ resourceId: string; siteId: string }, Record<string, unknown>];
  expect(scopeArg.resourceId).toBe('ns-abc');
  expect(scopeArg.siteId).toBe('site-1');
  expect(inputArg.action).toBe('put');
  expect(inputArg.key).toBe('greeting');
  expect(inputArg.value).toBe('hi');
});

it('passes CONFIRMATION_REQUIRED through as an honest ok:false result (confirm omitted) — never a 500/transport error', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  resolveOwned();
  mockKvMutate.mockResolvedValue({
    ok: false,
    error: { code: 'confirmation_required', message: 'Deleting KV key "x" is destructive. Re-run with confirm:true.', retryable: false },
    correlationId: 'kv-y',
  });

  const res = await mutate('site-1', 'kv', { action: 'delete', input: { key: 'x' } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { result: { ok: boolean; error: { code: string } } } };
  expect(body.data.result.ok).toBe(false);
  expect(body.data.result.error.code).toBe('confirmation_required');
  // The top-level confirm was NOT sent, so it isn't in the merged input.
  const inputArg = mockKvMutate.mock.calls[0][1] as Record<string, unknown>;
  expect(inputArg).not.toHaveProperty('confirm');
});

it('hoists a top-level confirm:true into the merged mutation input (approving a destructive op)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  resolveOwned();
  mockKvMutate.mockResolvedValue({ ok: true, data: { action: 'delete', key: 'x', existed: true }, correlationId: 'kv-z' });

  const res = await mutate('site-1', 'kv', { action: 'delete', input: { key: 'x' }, confirm: true });
  expect(res.status).toBe(200);
  const inputArg = mockKvMutate.mock.calls[0][1] as Record<string, unknown>;
  expect(inputArg.action).toBe('delete');
  expect(inputArg.key).toBe('x');
  expect(inputArg.confirm).toBe(true);
});

it('SKIPS resolve for `provision` and dispatches with an env-carrying scope (the id is PRODUCED)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  mockKvMutate.mockResolvedValue({
    ok: true,
    data: { action: 'provision', resourceId: 'ns-new', registryRowId: 'row-2', created: true, displayName: 'KV namespace' },
    correlationId: 'kv-p',
  });

  const res = await mutate('site-1', 'kv', { action: 'provision', confirm: true });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { result: { ok: boolean; data: { resourceId: string } } } };
  expect(body.data.result.ok).toBe(true);
  expect(body.data.result.data.resourceId).toBe('ns-new');

  // resolveResourceRef must NOT be called for provision (the id is what provision produces).
  expect(mockResolveResourceRef).not.toHaveBeenCalled();
  // The scope carries the worker env + an EMPTY resourceId + a tenantId for provisionResource.
  const [scopeArg, inputArg] = mockKvMutate.mock.calls[0] as [{ resourceId: string; env: unknown; tenantId: string }, Record<string, unknown>];
  expect(scopeArg.resourceId).toBe('');
  expect(scopeArg.env).toBe(ENV);
  expect(scopeArg.tenantId).toBe('org-1');
  expect(inputArg.action).toBe('provision');
  expect(inputArg.confirm).toBe(true);
});

it('passes through not_registered as an honest ok:false result when the ref cannot resolve (non-provision)', async () => {
  mockIsFlagOn.mockResolvedValue(true);
  mockOwnsSiteData.mockResolvedValue(true);
  mockResolveResourceRef.mockResolvedValue({ ok: false, reason: 'not_registered' });

  const res = await mutate('site-1', 'kv', { action: 'put', input: { key: 'k', value: 'v' } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { result: { ok: boolean; error: { code: string } } } };
  expect(body.data.result.ok).toBe(false);
  expect(body.data.result.error.code).toBe('not_registered');
  expect(mockKvMutate).not.toHaveBeenCalled();
});
