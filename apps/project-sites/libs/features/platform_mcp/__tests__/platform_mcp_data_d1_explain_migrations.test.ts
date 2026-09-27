/**
 * TDD tests for the D1 READ-ONLY polish MCP tools:
 *   data_d1_explain     — EXPLAIN QUERY PLAN for a read statement against the site's own D1 (data:read)
 *   data_d1_migrations  — the site's own D1 applied-migration history (data:read)
 *
 * Same pattern as platform_mcp_data_d1_exec.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) both require the 'data:read' scope; a no-data token gets a scope error (never runs the adapter)
 *   (b) per_site_data flag OFF → isError + dark-mode message (never runs)
 *   (c) tools/list advertises both requiring data:read
 *   (d) foreign site (org mismatch) → isError + 'Site not found.' (no leak, no adapter call)
 *   (e) explain forwards {action:'explain', sql, params} and returns effect + plan
 *   (f) explain surfaces the adapter's explain_refused_mutating error for a mutating statement
 *   (g) migrations forwards {action:'migrations'} and returns table_present + migrations
 *   (h) migrations honest-empty (table_present:false) is surfaced faithfully
 *   (i) neither accepts a smuggled CF/database id (.strict schema → internal error, nothing runs)
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

const dataReadToken = { org_id: 'org-1', name: 'read-key', scopes: '["data:read"]' };
const noDataToken = { org_id: 'org-1', name: 'sites-key', scopes: '["sites:read"]' };

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
  // Reset the shared dbQueryOne mock + restore its null default so an UNCONSUMED mockResolvedValueOnce
  // from a strict-schema-reject test (the parse throws before the ownership query runs) can never bleed
  // a stale `{id:'site-1'}` into the next test's ownership check.
  const { dbQueryOne } = require('../../../../src/services/db.js');
  dbQueryOne.mockReset();
  dbQueryOne.mockResolvedValue(null);
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('D1 polish tool catalog', () => {
  it('(c) tools/list includes data_d1_explain + data_d1_migrations requiring data:read', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const explain = body.result.tools.find((t: { name: string }) => t.name === 'data_d1_explain');
    const migrations = body.result.tools.find((t: { name: string }) => t.name === 'data_d1_migrations');
    expect(explain).toBeDefined();
    expect(migrations).toBeDefined();
    expect(explain.description).toMatch(/EXPLAIN QUERY PLAN/i);
    expect(explain.description).toMatch(/read-only/i);
    expect(migrations.description).toMatch(/d1_migrations/i);
  });
});

// ─── data_d1_explain ─────────────────────────────────────────────────────────────

describe('data_d1_explain', () => {
  it('(a) requires data:read scope — a no-data token gets a scope error, never runs', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(noDataToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_explain', arguments: { site_id: 'site-1', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_data flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_explain', arguments: { site_id: 'site-1', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) → "Site not found." — no leak, no adapter call', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_explain', arguments: { site_id: 'foreign', sql: 'SELECT 1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockResolveSiteDataDb).not.toHaveBeenCalled();
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(e) forwards {action:explain, sql, params} and returns effect + plan', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'd1-1',
      data: {
        action: 'explain',
        effect: 'read_only',
        plan: [{ id: 2, parent: 0, detail: 'SCAN t' }],
        durationMs: 1.2,
      },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_explain',
        arguments: { site_id: 'site-1', sql: 'SELECT * FROM t WHERE a = ?', params: [5] },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.effect).toBe('read_only');
    expect(payload.plan).toEqual([{ id: 2, parent: 0, detail: 'SCAN t' }]);
    expect(payload.duration_ms).toBe(1.2);
    expect(payload.databaseId).toBe('db-site-1');
    // The forwarded action carries only sql/params — the id came from the server-resolved scope.
    expect(mockD1Mutate.mock.calls[0][1]).toEqual({
      action: 'explain',
      sql: 'SELECT * FROM t WHERE a = ?',
      params: [5],
    });
    expect(mockD1Mutate.mock.calls[0][0].resourceId).toBe('db-site-1');
  });

  it('(f) surfaces the adapter explain_refused_mutating error for a write statement', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'd1-1',
      error: {
        code: 'explain_refused_mutating',
        message: 'EXPLAIN is only available for a read (SELECT/WITH…SELECT/VALUES) statement — this SQL is classified as potentially data-mutating and will not be explained.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_explain', arguments: { site_id: 'site-1', sql: 'DELETE FROM t' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/read/i);
  });

  it('(i) rejects a smuggled databaseId (strict schema) — the CF id is never a caller input', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_explain',
        arguments: { site_id: 'site-1', sql: 'SELECT 1', databaseId: 'ea3e839a-c641-4861-ae30-dfc63bff8032' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.code).toBe(-32603);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });
});

// ─── data_d1_migrations ─────────────────────────────────────────────────────────

describe('data_d1_migrations', () => {
  it('(a) requires data:read scope — a no-data token gets a scope error, never runs', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(noDataToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_migrations', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) → "Site not found." — no leak, no adapter call', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_migrations', arguments: { site_id: 'foreign' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockResolveSiteDataDb).not.toHaveBeenCalled();
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(g) forwards {action:migrations} and returns table_present + migrations', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'd1-1',
      data: {
        action: 'migrations',
        tablePresent: true,
        migrations: [{ id: 1, name: '0001_init.sql', appliedAt: '2026-01-01 10:00:00' }],
        durationMs: 0.8,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_migrations', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.table_present).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.migrations[0].name).toBe('0001_init.sql');
    expect(payload.duration_ms).toBe(0.8);
    expect(payload.databaseId).toBe('db-site-1');
    expect(mockD1Mutate.mock.calls[0][1]).toEqual({ action: 'migrations' });
    expect(mockD1Mutate.mock.calls[0][0].resourceId).toBe('db-site-1');
  });

  it('(h) honest empty (table absent) is surfaced faithfully — not an error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'd1-1',
      data: { action: 'migrations', tablePresent: false, migrations: [] },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_migrations', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.table_present).toBe(false);
    expect(payload.count).toBe(0);
    expect(payload.migrations).toEqual([]);
  });

  it('(i) rejects a smuggled databaseId (strict schema)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_migrations',
        arguments: { site_id: 'site-1', databaseId: 'ea3e839a-c641-4861-ae30-dfc63bff8032' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.code).toBe(-32603);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });
});
