/**
 * TDD tests for the two Observability-slice MCP tools:
 *   data_analytics_list          — summarise the site's AE dataset(s) + config — honest available:false when ingest off
 *   data_analytics_query_summary — a SITE-SCOPED recent event-count summary — SERVER-BUILT query, never a caller SQL
 *
 * Same pattern as platform_mcp_data_queues.test.ts: no real CF/D1, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * ⛔ THE HONESTY + ISOLATION GUARANTEE: Analytics Engine INGEST is DISABLED on this deployment
 * (`ANALYTICS_INGEST_ENABLED="false"`), so the tools surface available:false honestly (never a fabricated event
 * stream). The AE SQL API is ACCOUNT-WIDE — the caller supplies NO SQL/dataset/account, ONLY a site_id (+
 * optional window); the adapter builds every query with a mandatory site WHERE, so one site can NEVER read
 * another's analytics. Cross-site isolation is proven by the scope's resourceId being the shared dataset while
 * the site dimension is the caller's own site_id, and by the foreign-site 404 (adapter never reached).
 *
 * Contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak); adapter never reached
 *   (b) per_site_observability flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) list returns datasets + count + available from the resolved-dataset scope
 *   (f) query_summary returns totalEvents + events + available; the adapter is scoped to the site (never a caller query)
 *   (g) query_summary passes ONLY window_days to the adapter — no SQL/dataset smuggling; site isolation is the scope
 *   (h) cross-site isolation: two different owned sites resolve DIFFERENT site-scoped scopes (siteId), same shared dataset
 */
import { Hono } from 'hono';

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockVerify = jest.fn();
jest.mock('../../../../src/services/api_tokens.js', () => ({
  verifyApiToken: (...a: unknown[]) => mockVerify(...a),
  extractBearerToken: (h: string | null) => (h ? h.replace(/^Bearer\s+/i, '') : null),
  hasScope: (token: { scopes?: string }, scope: string) => {
    const scopes: string[] = JSON.parse(token.scopes ?? '[]');
    return scopes.includes(scope);
  },
}));

jest.mock('../../../../src/services/db.js', () => ({
  dbInsert: jest.fn().mockResolvedValue({}),
  dbQuery: jest.fn().mockResolvedValue({ data: [] }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../../../../src/services/billing.js', () => ({
  getOrgEntitlements: jest.fn().mockResolvedValue({ topBarHidden: false }),
}));

jest.mock('../../../../src/services/domains.js', () => ({
  checkCnameTarget: jest.fn().mockResolvedValue(null),
  provisionCustomDomain: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../../src/services/site_data_db.js', () => ({
  resolveSiteDataDb: jest.fn(),
  listSiteTables: jest.fn(),
  isSafeIdent: (s: unknown): s is string =>
    typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s),
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  SiteDataD1Error: class extends Error {},
  FORBIDDEN_DB_IDS: new Set(['ea3e839a-c641-4861-ae30-dfc63bff8032']),
}));

const mockResolveRef = jest.fn();
jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: (...a: unknown[]) => mockResolveRef(...a),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

// The other adapters are imported by the service too — stub so nothing real fires.
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/r2.js', () => ({
  r2Adapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/vectorize.js', () => ({
  vectorizeAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/connection.js', () => ({
  connectionAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/workflow.js', () => ({
  workflowAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/durable_object.js', () => ({
  durableObjectAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/queue.js', () => ({
  queueAdapter: { list: jest.fn(), get: jest.fn() },
}));

const mockAnalyticsList = jest.fn();
const mockAnalyticsGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/analytics_engine.js', () => ({
  analyticsEngineAdapter: {
    list: (...a: unknown[]) => mockAnalyticsList(...a),
    get: (...a: unknown[]) => mockAnalyticsGet(...a),
  },
}));

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: jest.fn().mockResolvedValue({ email: 'e', key: 'k' }),
  cfAuthHeaders: () => ({}),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { platformMcp } from '../handlers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function app() {
  const a = new Hono();
  a.route('/', platformMcp);
  return a;
}

/** Env carries CF_ACCOUNT_ID (resolveAnalyticsScope needs it) + the ingest var (off, the reality today). */
const ENV = { CF_ACCOUNT_ID: 'acct-1', ANALYTICS_INGEST_ENABLED: 'false' };

const rpc = (
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
  env: Record<string, unknown> = ENV,
) =>
  app().request(
    '/api/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );

/** A token that has ONLY 'data:read' scope. */
const dataReadToken = { org_id: 'org-1', name: 'data-key', scopes: '["data:read"]' };
/** A token with ONLY 'sites:read' — NOT data:read. */
const sitesReadToken = { org_id: 'org-1', name: 'sites-key', scopes: '["sites:read"]' };

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveRef.mockReset();
  mockAnalyticsList.mockReset();
  mockAnalyticsGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Observability tools catalog', () => {
  it('(c) tools/list includes data_analytics_list and data_analytics_query_summary', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_analytics_list');
    expect(names).toContain('data_analytics_query_summary');
  });
});

// ─── data_analytics_list ─────────────────────────────────────────────────────────

describe('data_analytics_list', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_observability flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_observability flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site (org mismatch) returns "Site not found." — no leak; adapter never reached', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_list', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockAnalyticsList).not.toHaveBeenCalled();
  });

  it('(e) returns datasets + count + available:false (ingest disabled) from the resolved-dataset scope', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockAnalyticsList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'ae-1',
      data: {
        datasets: [{ name: 'projectsites_admin_v1', dimensions: [{ column: 'blob3', meaning: 'site_id' }] }],
        count: 1,
        available: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.available).toBe(false); // honest: ingest disabled
    expect(payload.datasets[0].name).toBe('projectsites_admin_v1');
    // The adapter was scoped to THIS site (resourceId = shared dataset, siteId = caller's own site).
    expect(mockAnalyticsList.mock.calls[0][0].siteId).toBe('site-1');
    expect(mockAnalyticsList.mock.calls[0][0].resourceId).toBe('projectsites_admin_v1');
  });
});

// ─── data_analytics_query_summary ─────────────────────────────────────────────────

describe('data_analytics_query_summary', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_query_summary', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_observability flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_query_summary', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site returns "Site not found." — no leak; adapter never reached', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_analytics_query_summary', arguments: { site_id: 'foreign', window_days: 7 } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockAnalyticsGet).not.toHaveBeenCalled();
  });

  it('(f)(g) returns totalEvents + events; passes ONLY window_days to the adapter (no SQL/dataset smuggling)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockAnalyticsGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'ae-2',
      data: {
        datasetName: 'projectsites_admin_v1',
        windowDays: 7,
        available: true,
        totalEvents: 42,
        events: [{ event: 'admin_visit', count: 30 }],
        sampled: true,
      },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_analytics_query_summary',
        // A malicious caller tries to smuggle a raw SQL/dataset — .strict() must reject unknown keys,
        // but even the accepted args carry ONLY window_days to the adapter.
        arguments: { site_id: 'site-1', window_days: 7 },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.totalEvents).toBe(42);
    expect(payload.available).toBe(true);
    expect(payload.events[0].event).toBe('admin_visit');
    expect(payload.sampled).toBe(true);
    // The adapter got a scope for THIS site + ONLY the window knob — never a SQL/dataset from the caller.
    const [scopeArg, inputArg] = mockAnalyticsGet.mock.calls[0];
    expect(scopeArg.siteId).toBe('site-1');
    expect(scopeArg.resourceId).toBe('projectsites_admin_v1');
    expect(inputArg).toEqual({ windowDays: 7 });
    // The input carries no SQL / dataset / where / account fields.
    for (const forbidden of ['sql', 'dataset', 'where', 'accountId', 'site_dimension']) {
      expect((inputArg as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it("(g) .strict() rejects a smuggled raw SQL arg (unknown key) — the adapter is never reached", async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_analytics_query_summary',
        arguments: { site_id: 'site-1', sql: 'SELECT * FROM projectsites_admin_v1' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // Zod .strict() throws on the unknown `sql` key → the dispatcher catches it and assigns a JSON-RPC error
    // envelope into `result` (code -32603), NOT a normal tool result. The security guarantee is that the
    // adapter is NEVER reached (the smuggled SQL cannot run).
    expect(body.result?.code === -32603 || body.result?.isError === true).toBe(true);
    expect(mockAnalyticsGet).not.toHaveBeenCalled();
  });

  it('(h) cross-site isolation: two owned sites resolve DIFFERENT site-scoped scopes (same shared dataset)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    const summary = (siteId: string) => ({
      ok: true,
      correlationId: 'ae',
      data: {
        datasetName: 'projectsites_admin_v1',
        windowDays: 30,
        available: true,
        totalEvents: 1,
        events: [],
        sampled: true,
      },
    });

    dbQueryOne.mockResolvedValueOnce({ id: 'site-A' });
    mockAnalyticsGet.mockResolvedValueOnce(summary('site-A'));
    await rpc(
      'tools/call',
      { name: 'data_analytics_query_summary', arguments: { site_id: 'site-A' } },
      { authorization: 'Bearer psk_x' },
    );

    dbQueryOne.mockResolvedValueOnce({ id: 'site-B' });
    mockAnalyticsGet.mockResolvedValueOnce(summary('site-B'));
    await rpc(
      'tools/call',
      { name: 'data_analytics_query_summary', arguments: { site_id: 'site-B' } },
      { authorization: 'Bearer psk_x' },
    );

    // Each call scoped the adapter to its OWN site — the isolation dimension differs per site,
    // while the shared dataset is the same. One site can never resolve another's scope.
    expect(mockAnalyticsGet.mock.calls[0][0].siteId).toBe('site-A');
    expect(mockAnalyticsGet.mock.calls[1][0].siteId).toBe('site-B');
    expect(mockAnalyticsGet.mock.calls[0][0].resourceId).toBe('projectsites_admin_v1');
    expect(mockAnalyticsGet.mock.calls[1][0].resourceId).toBe('projectsites_admin_v1');
  });
});
