/**
 * TDD tests for the Backend-inventory MCP tool:
 *   data_backend_inventory — the READ-ONLY Backend-tab connected-resource inventory (Phase 8b):
 *     scheduled tasks (Cron Triggers) + Worker bindings + secret NAMES + last-change (⛔ never values).
 *
 * Same pattern as platform_mcp_data_analytics.test.ts: no real CF/D1, all external deps mocked,
 * global-jest convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * ⛔ THE HONESTY + ISOLATION GUARANTEES under test:
 *  - Org-scope: a foreign site (org mismatch) → isError 'Site not found.' (no leak); the inventory
 *    reader is never reached.
 *  - Flag-gate: the umbrella data_resource_platform flag OFF → an honest dark error.
 *  - Scope: the tool requires 'data:read' (a sites:read token is rejected).
 *  - ⛔ NO SECRET VALUE: the returned payload carries secret NAMES + metadata ONLY — an explicit test
 *    asserts no value-bearing key appears anywhere in the serialized tool result.
 *  - Honest not-available: a binding without an integrated management API surfaces managed:false +
 *    a notAvailableReason (never a fabricated manageRoute).
 *
 * Contract under test:
 *   (c) tools/list advertises data_backend_inventory
 *   (d) requires the 'data:read' scope
 *   (b) data_resource_platform flag OFF → dark error
 *   (a) foreign site (org mismatch) → 'Site not found.'; reader never reached
 *   (e) returns schedules + bindings + secrets + counts for an owned site
 *   (f) ⛔ no secret VALUE anywhere in the serialized result — names + metadata only
 *   (g) honest not-available: an un-integrated binding is managed:false + notAvailableReason
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

jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: jest.fn(),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

// All per-kind adapters are imported by the service — stub so nothing real fires.
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
jest.mock('../../data_resource_registry/adapters/analytics_engine.js', () => ({
  analyticsEngineAdapter: { list: jest.fn(), get: jest.fn() },
}));

// The Backend-inventory reader — the unit under test at the MCP boundary.
const mockGetInventory = jest.fn();
jest.mock('../../data_resource_registry/backend_inventory.js', () => ({
  getBackendInventory: (...a: unknown[]) => mockGetInventory(...a),
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

const ENV = { CF_ACCOUNT_ID: 'acct-1' };

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

/** A representative inventory the reader returns for an owned site. */
function sampleInventory() {
  return {
    siteId: 'site-1',
    environment: 'production',
    functionsDeployed: true,
    schedules: [
      {
        cron: '0 * * * *',
        dispatchedBy: 'platform_cron_dispatcher',
        description: 'hourly',
      },
    ],
    bindings: [
      {
        kind: 'kv',
        name: '__PS_KV',
        description: 'site KV',
        managed: true,
        manageRoute: '/admin/data?tab=kv',
        notAvailableReason: null,
        docsUrl: 'https://developers.cloudflare.com/kv/',
        scope: 'site',
      },
      {
        kind: 'browser',
        name: 'BROWSER',
        description: 'Browser Rendering',
        managed: false,
        manageRoute: null,
        notAvailableReason: 'no per-site Browser Rendering management API in this platform',
        docsUrl: 'https://developers.cloudflare.com/browser-rendering/',
        scope: 'shared_platform',
      },
    ],
    // ⛔ NAMES + metadata only — the reader never produces a value field.
    secrets: [
      { name: 'STRIPE_KEY', scope: 'site', isSecret: true, lastChangedAt: '2000', createdAt: '1000' },
    ],
    counts: { schedules: 1, bindings: 2, secrets: 1 },
  };
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockGetInventory.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Backend-inventory tool catalog', () => {
  it('(c) tools/list includes data_backend_inventory', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_backend_inventory');
  });
});

// ─── data_backend_inventory ─────────────────────────────────────────────────────

describe('data_backend_inventory', () => {
  it('(d) requires data:read scope — a sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_backend_inventory', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockGetInventory).not.toHaveBeenCalled();
  });

  it('(b) data_resource_platform flag OFF returns a dark error', async () => {
    // mcp_server flag ON (transport), data_resource_platform OFF (the surface).
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_backend_inventory', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockGetInventory).not.toHaveBeenCalled();
  });

  it('(a) foreign site (org mismatch) returns "Site not found." — no leak; reader never reached', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_backend_inventory', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockGetInventory).not.toHaveBeenCalled();
  });

  it('(e) returns schedules + bindings + secrets + counts for an owned site; reader is org+site scoped', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // owned
    mockGetInventory.mockResolvedValueOnce(sampleInventory());

    const res = await rpc(
      'tools/call',
      { name: 'data_backend_inventory', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.schedules[0].cron).toBe('0 * * * *');
    expect(payload.counts).toEqual({ schedules: 1, bindings: 2, secrets: 1 });
    // The reader was called with the owned site + the token's org (isolation).
    expect(mockGetInventory.mock.calls[0][1]).toBe('site-1');
    expect(mockGetInventory.mock.calls[0][2]).toBe('org-1');
    expect(mockGetInventory.mock.calls[0][3]).toBe('production');
  });

  it('(f) ⛔ NO SECRET VALUE anywhere in the serialized tool result — names + metadata only', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockGetInventory.mockResolvedValueOnce(sampleInventory());

    const res = await rpc(
      'tools/call',
      { name: 'data_backend_inventory', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    const text: string = body.result.content[0].text;
    const payload = JSON.parse(text);

    // Each secret carries ONLY name/scope/isSecret/lastChangedAt/createdAt — no value-bearing keys.
    for (const s of payload.secrets) {
      expect(Object.keys(s).sort()).toEqual([
        'createdAt',
        'isSecret',
        'lastChangedAt',
        'name',
        'scope',
      ]);
    }
    // Belt-and-braces: the raw serialized tool result carries no value-column shape at all.
    expect(text).not.toMatch(/value_encrypted/i);
    expect(text).not.toMatch(/"value"\s*:/i);
    expect(text).not.toMatch(/ciphertext/i);
  });

  it('(g) honest not-available: an un-integrated binding is managed:false + notAvailableReason (no fake route)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockGetInventory.mockResolvedValueOnce(sampleInventory());

    const res = await rpc(
      'tools/call',
      { name: 'data_backend_inventory', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    const browser = payload.bindings.find((b: { name: string }) => b.name === 'BROWSER');
    expect(browser.managed).toBe(false);
    expect(browser.manageRoute).toBeNull();
    expect(browser.notAvailableReason).toMatch(/.+/);
    // A managed binding DOES carry an in-platform route.
    const kv = payload.bindings.find((b: { name: string }) => b.name === '__PS_KV');
    expect(kv.managed).toBe(true);
    expect(kv.manageRoute).toMatch(/^\/admin\/data/);
  });
});
