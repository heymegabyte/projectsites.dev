/**
 * TDD tests for the MCP tool `data_d1_query_history` — read the RECENT query history for a site's OWN
 * per-site D1 (Data Platform "query history").
 *
 * Same harness as platform_mcp_data_tables.test.ts: no real D1, all external deps mocked, the swc-jest
 * global-jest convention (NO `import { jest }`). `readQueryHistory` (the platform-D1 reader) is mocked so
 * we can assert the dispatcher passes the OWNED site + authed org, never a CF/db id.
 *
 * Security + behavior contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak, history NEVER read)
 *   (b) per_site_data flag OFF       → isError + dark-mode message
 *   (c) Requires the 'data:read' scope
 *   (d) Happy path → returns entries newest-first; reader called with (db, site_id, orgId)
 *   (e) tools/list includes data_d1_query_history
 *   (f) The reader is scoped to the AUTHED org (org_id from the token, never the args)
 */
import { Hono } from 'hono';

// ─── Mocks — declared BEFORE any import that triggers the real modules ─────────

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

const mockReadQueryHistory = jest.fn();
jest.mock('../../data_resource_registry/query_history.js', () => ({
  readQueryHistory: (...a: unknown[]) => mockReadQueryHistory(...a),
}));

jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: jest.fn(),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

// ─── Import AFTER mocks ────────────────────────────────────────────────────────

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

const dataReadToken = { org_id: 'org-1', name: 'data-key', scopes: '["data:read"]' };
const sitesReadToken = { org_id: 'org-1', name: 'sites-key', scopes: '["sites:read"]' };

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockReadQueryHistory.mockReset();
});

// ─── data_d1_query_history ───────────────────────────────────────────────────────

describe('data_d1_query_history', () => {
  it('(e) tools/list includes data_d1_query_history', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_d1_query_history');
  });

  it('(c) requires data:read scope — a sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_query_history', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockReadQueryHistory).not.toHaveBeenCalled();
  });

  it('(b) per_site_data flag OFF returns a dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_query_history', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockReadQueryHistory).not.toHaveBeenCalled();
  });

  it('(a)(f) a FOREIGN site (org mismatch) returns "Site not found." and NEVER reads history', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_query_history', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    // Isolation: a foreign site's history is never read.
    expect(mockReadQueryHistory).not.toHaveBeenCalled();
  });

  it('(d)(f) happy path returns entries newest-first; reader scoped to the AUTHED org', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes
    mockReadQueryHistory.mockResolvedValueOnce([
      {
        id: 'b',
        siteId: 'site-1',
        environment: 'production',
        statementKind: 'mutating',
        sqlText: 'UPDATE t SET a = ? WHERE id = ?',
        durationMs: 4,
        rowsRead: 0,
        rowsWritten: 1,
        ok: true,
        errorCode: null,
        createdAt: '2026-09-27T12:00:00.000Z',
      },
      {
        id: 'a',
        siteId: 'site-1',
        environment: 'production',
        statementKind: 'read_only',
        sqlText: 'SELECT * FROM t',
        durationMs: 1,
        rowsRead: 3,
        rowsWritten: 0,
        ok: true,
        errorCode: null,
        createdAt: '2026-09-27T10:00:00.000Z',
      },
    ]);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_query_history', arguments: { site_id: 'site-1', limit: 10 } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(2);
    expect(payload.entries.map((e: { id: string }) => e.id)).toEqual(['b', 'a']);
    // Response carries the statement TEMPLATE (with `?`) — never a param value.
    expect(payload.entries[0].sql_text).toBe('UPDATE t SET a = ? WHERE id = ?');
    // The reader was called with the PLATFORM db + the OWNED site + the AUTHED org (org from token, not args).
    const call = mockReadQueryHistory.mock.calls[0];
    expect(call[1]).toBe('site-1');
    expect(call[2]).toBe('org-1');
    expect(call[3]).toMatchObject({ limit: 10 });
  });
});
