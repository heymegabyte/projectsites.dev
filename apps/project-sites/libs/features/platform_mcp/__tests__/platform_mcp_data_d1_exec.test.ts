/**
 * TDD tests for the D1 WRITE-slice MCP tool:
 *   data_d1_exec — run ONE parameterized SQL statement against the site's own D1 (gated)
 *
 * Same pattern as platform_mcp_data_kv_write.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) requires the 'data:write' scope — a data:read-only token gets a scope error (never runs)
 *   (b) per_site_data flag OFF → isError + dark-mode message
 *   (c) tools/list advertises data_d1_exec requiring data:write
 *   (d) foreign site (org mismatch) → isError + 'Site not found.' (no leak, no exec)
 *   (e) a MUTATING statement WITHOUT confirm → the adapter's confirmation_required report is surfaced (nothing runs)
 *   (f) a statement WITH confirm → forwards {action:'exec', sql, params, confirm} and returns effect + rows_written
 *   (g) not-provisioned / un-openable database → honest error (never a fabricated write)
 *   (h) the dispatcher never accepts a CF/database id — only site_id + sql
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

const mockResolveSiteDataDb = jest.fn();
jest.mock('../../../../src/services/site_data_db.js', () => ({
  resolveSiteDataDb: (...a: unknown[]) => mockResolveSiteDataDb(...a),
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

const mockD1Mutate = jest.fn();
jest.mock('../../data_resource_registry/adapters/d1.js', () => ({
  d1Adapter: {
    list: jest.fn(),
    get: jest.fn(),
    head: jest.fn(),
    mutate: (...a: unknown[]) => mockD1Mutate(...a),
  },
}));

const mockResolveCfCredentials = jest.fn().mockResolvedValue({ email: 'e', key: 'k' });
jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: (...a: unknown[]) => mockResolveCfCredentials(...a),
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
  env: Record<string, unknown> = { CF_ACCOUNT_ID: 'acct-1' },
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

/** A token that has the 'data:write' scope (and data:read). */
const dataWriteToken = { org_id: 'org-1', name: 'write-key', scopes: '["data:read","data:write"]' };
/** A token with ONLY 'data:read' — NOT data:write. */
const dataReadOnlyToken = { org_id: 'org-1', name: 'read-key', scopes: '["data:read"]' };

/** What resolveSiteDataDb returns for an OWNED, provisioned site (isolated databaseId + executor). */
const resolvedDb = {
  ok: true,
  db: { databaseId: 'db-site-1', query: jest.fn() },
  databaseId: 'db-site-1',
  provisioned: false,
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveSiteDataDb.mockReset();
  mockD1Mutate.mockReset();
  mockResolveCfCredentials.mockClear();
  mockResolveCfCredentials.mockResolvedValue({ email: 'e', key: 'k' });
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('D1 exec tool catalog', () => {
  it('(c) tools/list includes data_d1_exec requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tool = body.result.tools.find((t: { name: string }) => t.name === 'data_d1_exec');
    expect(tool).toBeDefined();
    // The gorgeous safety copy makes the confirm/Time-Travel contract explicit to the agent.
    expect(tool.description).toMatch(/confirm:true/i);
    expect(tool.description).toMatch(/Time Travel/i);
  });
});

// ─── data_d1_exec ─────────────────────────────────────────────────────────────────

describe('data_d1_exec', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error, never runs', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_exec', arguments: { site_id: 'site-1', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_data flag OFF returns dark error', async () => {
    // mcp_server flag on (transport), per_site_data off.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_exec', arguments: { site_id: 'site-1', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no exec', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_exec', arguments: { site_id: 'foreign', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockResolveSiteDataDb).not.toHaveBeenCalled();
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(e) a MUTATING statement WITHOUT confirm → adapter confirmation_required is surfaced (nothing runs)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'd1-1',
      error: {
        code: 'confirmation_required',
        message:
          'This SQL is classified as a data-mutating statement (best-effort leading-keyword classification; D1\'s rows_written is the ground truth). Re-run with confirm:true to execute it.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_exec', arguments: { site_id: 'site-1', sql: 'DELETE FROM t WHERE id = ?', params: [5] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    // The dispatcher forwarded confirm:undefined to the adapter (the adapter owns the gate).
    expect(mockD1Mutate.mock.calls[0][1]).toMatchObject({ action: 'exec', sql: 'DELETE FROM t WHERE id = ?', params: [5] });
    expect(mockD1Mutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(f) a statement WITH confirm → forwards {action,sql,params,confirm} and returns effect + rows_written', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'd1-1',
      data: {
        action: 'exec',
        effect: 'mutating',
        destructive: false,
        rows: [],
        rowsRead: 0,
        rowsWritten: 2,
        changedDb: true,
      },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_exec',
        arguments: { site_id: 'site-1', sql: 'UPDATE t SET a = ? WHERE id = ?', params: ['x', 5], confirm: true },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.effect).toBe('mutating');
    expect(payload.rows_written).toBe(2);
    expect(payload.changed_db).toBe(true);
    expect(payload.databaseId).toBe('db-site-1');
    // (h) the caller named only site_id + sql — the adapter got the SERVER-RESOLVED id via the scope,
    // not from the caller. The forwarded mutation input carries the sql/params/confirm only.
    expect(mockD1Mutate.mock.calls[0][1]).toEqual({
      action: 'exec',
      sql: 'UPDATE t SET a = ? WHERE id = ?',
      params: ['x', 5],
      confirm: true,
    });
    // The scope handed to the adapter carries the resolved databaseId as resourceId (server-resolved).
    expect(mockD1Mutate.mock.calls[0][0].resourceId).toBe('db-site-1');
  });

  it('(g) an un-openable database → honest error, never a fabricated write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce({ ok: false, reason: 'not_provisioned' });
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_exec', arguments: { site_id: 'site-1', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Could not open the site database/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(h) rejects a smuggled databaseId (strict schema) — the CF id is never a caller input', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_exec',
        arguments: { site_id: 'site-1', sql: 'SELECT 1', databaseId: 'ea3e839a-c641-4861-ae30-dfc63bff8032' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // .strict() Zod schema throws on the unknown key → the handler's catch turns it into a JSON-RPC
    // internal-error (never a fabricated success), and the SQL is NEVER executed. (The handler assigns the
    // error object to the response `result` field; the key contract is: it is an error + nothing ran.)
    expect(body.result.code).toBe(-32603);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });
});
