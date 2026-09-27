/**
 * TDD tests for the two Durable-Objects-slice MCP tools:
 *   data_durable_objects_list    — list the site's DO CLASS namespaces (id/class/script) — NEVER instances
 *   data_durable_object_describe — describe a NAMED object id's identity metadata — NEVER its state
 *
 * Same pattern as platform_mcp_data_workflows.test.ts: no real CF/D1, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * ⛔ THE HONESTY GUARANTEE: CF cannot enumerate DO instances or read arbitrary state — so `list` surfaces
 * NAMESPACES and `describe` surfaces identity metadata ONLY (stateBrowsable:false), never a DO's data.
 *
 * Contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak); adapter never reached
 *   (b) per_site_durable_objects flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) list returns namespaces + count from the resolved-namespace scope (resourceId = namespace id)
 *   (f) not-provisioned (resolveResourceRef not_registered) → honest 'does not have a Durable Object'
 *   (g) describe forwards the object id + returns identity metadata; stateBrowsable false
 *   (h) ⛔ describe returns NO fabricated state — the payload carries identity keys only, stateBrowsable false
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

// The kv + r2 + vectorize + connection + workflow adapters are imported by the service too — stub so nothing
// real fires.
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

const mockDoList = jest.fn();
const mockDoGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/durable_object.js', () => ({
  durableObjectAdapter: {
    list: (...a: unknown[]) => mockDoList(...a),
    get: (...a: unknown[]) => mockDoGet(...a),
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

const rpc = (
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
  env: Record<string, unknown> = {},
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

/** A successful ref resolution to a DO NAMESPACE id (the shape resolveResourceRef returns). */
const resolvedDo = {
  ok: true,
  resourceId: 'do-ns-11112222',
  resourceKind: 'durable_object',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'read_only',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveRef.mockReset();
  mockDoList.mockReset();
  mockDoGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Durable Objects tools catalog', () => {
  it('(c) tools/list includes data_durable_objects_list and data_durable_object_describe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_durable_objects_list');
    expect(names).toContain('data_durable_object_describe');
  });
});

// ─── data_durable_objects_list ────────────────────────────────────────────────────

describe('data_durable_objects_list', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_objects_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_durable_objects flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_durable_objects flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_objects_list', arguments: { site_id: 'site-1' } },
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
      { name: 'data_durable_objects_list', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockDoList).not.toHaveBeenCalled();
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('(f) not-provisioned (resolveResourceRef not_registered) → honest "does not have a Durable Object"', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes
    mockResolveRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_objects_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/does not have a Durable Object/i);
    expect(mockDoList).not.toHaveBeenCalled();
  });

  it('(e) returns namespaces + count; adapter scoped to the resolved namespace id (never instances)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedDo);
    mockDoList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'durable_object-1',
      data: {
        namespaces: [
          { id: 'do-ns-11112222', className: 'SiteBuilderContainer', scriptName: 'project-sites', useSqlite: true },
        ],
        count: 1,
        instancesEnumerable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_objects_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.namespaces[0].className).toBe('SiteBuilderContainer');
    // Honest: CF cannot enumerate DO instances — the tool declares this permanently.
    expect(payload.instancesEnumerable).toBe(false);
    // The adapter was called with the scope whose resourceId is the RESOLVED namespace id (not the site id).
    expect(mockDoList.mock.calls[0][0].resourceId).toBe('do-ns-11112222');
  });
});

// ─── data_durable_object_describe ─────────────────────────────────────────────────

describe('data_durable_object_describe', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_describe', arguments: { site_id: 'site-1', id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_durable_objects flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_describe', arguments: { site_id: 'site-1', id: 'obj-1' } },
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
      { name: 'data_durable_object_describe', arguments: { site_id: 'foreign', id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockDoGet).not.toHaveBeenCalled();
  });

  it('(g)(h) ⛔ forwards the object id + returns identity metadata ONLY — no fabricated state', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedDo);
    const hex = 'a'.repeat(64);
    mockDoGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'durable_object-2',
      data: {
        objectId: hex,
        namespaceId: 'do-ns-11112222',
        hexId: hex,
        stateBrowsable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_describe', arguments: { site_id: 'site-1', id: hex } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.objectId).toBe(hex);
    expect(payload.namespaceId).toBe('do-ns-11112222');
    // ⛔ The tool NEVER surfaces a DO's private state — permanently declared.
    expect(payload.stateBrowsable).toBe(false);
    // No state-bearing key smuggled into the tool payload.
    for (const forbidden of ['state', 'storage', 'data', 'value', 'values', 'entries', 'contents', 'sql']) {
      expect(payload[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(payload)).not.toMatch(/"state"\s*:/);
    // The object id was forwarded to the adapter; the scope's resourceId is the resolved namespace id.
    expect(mockDoGet.mock.calls[0][1].id).toBe(hex);
    expect(mockDoGet.mock.calls[0][0].resourceId).toBe('do-ns-11112222');
  });
});
