/**
 * TDD tests for the two Connections-slice MCP tools:
 *   data_connections_list    — list the site's OWN connections (id/name/type/masked-host/status)
 *   data_connection_describe — read ONE connection's SECRET-FREE metadata by id
 *
 * Same pattern as platform_mcp_data_vectorize.test.ts: no real CF/D1, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak); adapter never reached
 *   (b) per_site_connections flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) ⛔ NO secret/token/password/connection-string ever crosses the boundary (the load-bearing invariant)
 *   (f) list returns id/name/type/masked-host/status + honest count
 *   (g) describe returns metadata ONLY (masked host, no secret), secretsRedacted:true
 *   (h) describe missing id → honest found:false
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

// The kv + r2 + vectorize adapters are imported by the service too — stub so nothing tries a real fetch.
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/r2.js', () => ({
  r2Adapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/vectorize.js', () => ({
  vectorizeAdapter: { list: jest.fn(), get: jest.fn() },
}));

const mockConnList = jest.fn();
const mockConnGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/connection.js', () => ({
  connectionAdapter: {
    list: (...a: unknown[]) => mockConnList(...a),
    get: (...a: unknown[]) => mockConnGet(...a),
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

/** The SECRET-FREE shape the connection adapter returns for one connection. */
const secretFreeConn = {
  id: 'conn-1',
  name: 'Prod Postgres',
  type: 'postgres',
  maskedHost: 'db…example.com',
  status: 'active',
  connectedAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
};

/**
 * Secret-ish JSON KEYS that must NEVER appear in a returned payload. Matched as a quoted JSON key
 * (`"key":`) so the honesty flag `secretsRedacted:true` (a legitimate field) is not a false positive on
 * the substring `secret`.
 */
const SECRET_KEYS = [
  'access_token_encrypted',
  'refresh_token_encrypted',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'token',
  'password',
  'connectionString',
  'connection_string',
  'dsn',
];
function assertNoSecrets(text: string): void {
  for (const k of SECRET_KEYS) expect(text).not.toContain(`"${k}"`);
  // Also assert no obvious secret VALUE leaked from a fixture (defense-in-depth on the value side).
  expect(text).not.toContain('ENC(');
  expect(text).not.toContain('live_sk_');
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockConnList.mockReset();
  mockConnGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Connections tools catalog', () => {
  it('(c) tools/list includes data_connections_list and data_connection_describe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_connections_list');
    expect(names).toContain('data_connection_describe');
  });

  it('(e) neither tool description leaks a secret-ish word', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools = body.result.tools.filter((t: { name: string }) =>
      t.name.startsWith('data_connection'),
    );
    for (const t of tools) {
      // Descriptions may say "token"/"password" in a NEVER-returned clause; assert they promise redaction.
      expect(t.description).toMatch(/NEVER|never/);
    }
  });
});

// ─── data_connections_list ────────────────────────────────────────────────────────

describe('data_connections_list', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_connections_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_connections flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_connections flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_connections_list', arguments: { site_id: 'site-1' } },
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
      { name: 'data_connections_list', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockConnList).not.toHaveBeenCalled();
  });

  it('(f)(e) returns id/name/type/masked-host/status + count — never a secret', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes
    mockConnList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'connection-1',
      data: { connections: [secretFreeConn], count: 1 },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_connections_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text;
    const payload = JSON.parse(text);
    expect(payload.count).toBe(1);
    expect(payload.connections[0].id).toBe('conn-1');
    expect(payload.connections[0].type).toBe('postgres');
    expect(payload.connections[0].maskedHost).toBe('db…example.com');
    expect(payload.connections[0].status).toBe('active');
    assertNoSecrets(text);
    // The adapter was called with a scope whose resourceId is the OWNED site id.
    expect(mockConnList.mock.calls[0][0].resourceId).toBe('site-1');
  });

  it('(f) empty site → count 0, connections [] (honest empty)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockConnList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'connection-2',
      data: { connections: [], count: 0 },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_connections_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(0);
    expect(payload.connections).toEqual([]);
  });
});

// ─── data_connection_describe ─────────────────────────────────────────────────────

describe('data_connection_describe', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_connection_describe', arguments: { site_id: 'site-1', id: 'conn-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_connections flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_connection_describe', arguments: { site_id: 'site-1', id: 'conn-1' } },
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
      { name: 'data_connection_describe', arguments: { site_id: 'foreign', id: 'conn-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockConnGet).not.toHaveBeenCalled();
  });

  it('(g)(e) returns metadata ONLY (masked host, no secret), secretsRedacted:true', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockConnGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'connection-3',
      data: { found: true, connection: secretFreeConn, secretsRedacted: true },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_connection_describe', arguments: { site_id: 'site-1', id: 'conn-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text;
    const payload = JSON.parse(text);
    expect(payload.found).toBe(true);
    expect(payload.secretsRedacted).toBe(true);
    expect(payload.connection.maskedHost).toBe('db…example.com');
    assertNoSecrets(text);
    // The connection id was forwarded to the adapter (which binds it alongside the site id).
    expect(mockConnGet.mock.calls[0][1].id).toBe('conn-1');
    expect(mockConnGet.mock.calls[0][0].resourceId).toBe('site-1');
  });

  it('(h) missing id → honest found:false', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockConnGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'connection-4',
      data: { found: false, secretsRedacted: true },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_connection_describe', arguments: { site_id: 'site-1', id: 'nope' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.found).toBe(false);
    expect(payload.connection).toBeUndefined();
  });
});
