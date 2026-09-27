/**
 * TDD tests for the D1 Time Travel MCP tools:
 *   data_d1_time_travel_info — READ the site's own D1 current bookmark + 30-day PITR window (data:read)
 *   data_d1_restore          — DESTRUCTIVE whole-DB point-in-time restore (data:write, confirm-gated)
 *
 * Same pattern as platform_mcp_data_d1_exec.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global). The d1 adapter's mutate is mocked, so
 * these tests assert the DISPATCHER contract (scope, flag-gate, org-isolation, confirm/whole-DB copy), not the
 * adapter's own CF calls (those are covered in d1_adapter_time_travel.test.ts).
 *
 * Security contract under test:
 *   info
 *     (a) tools/list advertises data_d1_time_travel_info requiring data:read
 *     (b) per_site_data flag OFF → isError + dark-mode message (nothing runs)
 *     (c) foreign site (org mismatch) → isError + 'Site not found.' (no leak, no call)
 *     (d) OWNED site → forwards {action:'time_travel_info', timestamp} and returns bookmark + retention_days
 *   restore
 *     (e) requires data:write — a data:read-only token gets a scope error (never runs)
 *     (f) tools/list advertises data_d1_restore requiring data:write, with whole-DB + confirm copy
 *     (g) WITHOUT confirm → the adapter's confirmation_required warning is surfaced (nothing runs)
 *     (h) foreign site → 'Site not found.' (no leak, no restore)
 *     (i) confirm + bookmark → forwards {action:'restore', bookmark, confirm} and returns restored + previous_bookmark
 *     (j) rejects a smuggled databaseId (strict schema) — the CF id is never a caller input
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

describe('D1 Time Travel tool catalog', () => {
  it('(a) tools/list includes data_d1_time_travel_info requiring data:read', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tool = body.result.tools.find(
      (t: { name: string }) => t.name === 'data_d1_time_travel_info',
    );
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/Time Travel/i);
    expect(tool.inputSchema.required).toEqual(['site_id']);
    // data:read tool must NOT require confirm.
    expect(tool.inputSchema.properties.confirm).toBeUndefined();
  });

  it('(f) tools/list includes data_d1_restore requiring data:write, with whole-DB + confirm copy', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tool = body.result.tools.find((t: { name: string }) => t.name === 'data_d1_restore');
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/confirm:true/i);
    expect(tool.description).toMatch(/whole-database/i);
    expect(tool.inputSchema.properties.confirm).toBeDefined();
  });
});

// ─── data_d1_time_travel_info ──────────────────────────────────────────────────────

describe('data_d1_time_travel_info', () => {
  it('(b) per_site_data flag OFF returns dark error (nothing runs)', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_time_travel_info', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(c) foreign site (org mismatch) → "Site not found." — no leak, no call', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_time_travel_info', arguments: { site_id: 'foreign' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockResolveSiteDataDb).not.toHaveBeenCalled();
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(d) OWNED site → forwards {action:time_travel_info, timestamp} and returns bookmark + retention_days', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'd1-1',
      data: { action: 'time_travel_info', available: true, bookmark: 'bk-current', retentionDays: 30 },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_time_travel_info',
        arguments: { site_id: 'site-1', timestamp: '2026-09-01T00:00:00Z' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.bookmark).toBe('bk-current');
    expect(payload.retention_days).toBe(30);
    expect(payload.databaseId).toBe('db-site-1');
    // Forwarded the timestamp; the SERVER-RESOLVED id is on the scope, never a caller input.
    expect(mockD1Mutate.mock.calls[0][1]).toEqual({
      action: 'time_travel_info',
      timestamp: '2026-09-01T00:00:00Z',
    });
    expect(mockD1Mutate.mock.calls[0][0].resourceId).toBe('db-site-1');
  });
});

// ─── data_d1_restore ─────────────────────────────────────────────────────────────

describe('data_d1_restore', () => {
  it('(e) requires data:write scope — a data:read-only token gets a scope error, never runs', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_restore', arguments: { site_id: 'site-1', bookmark: 'bk-1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(g) WITHOUT confirm → adapter confirmation_required is surfaced (nothing runs)', async () => {
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
          'Restoring is a DESTRUCTIVE, WHOLE-DATABASE point-in-time recovery: every table is reverted. Re-run with confirm:true to execute this restore.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_restore', arguments: { site_id: 'site-1', bookmark: 'bk-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    expect(body.result.content[0].text).toMatch(/whole-database/i);
    // The dispatcher forwarded confirm:undefined to the adapter (the adapter owns the gate).
    expect(mockD1Mutate.mock.calls[0][1]).toMatchObject({ action: 'restore', bookmark: 'bk-1' });
    expect(mockD1Mutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(h) foreign site → "Site not found." — no leak, no restore', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_d1_restore', arguments: { site_id: 'foreign', bookmark: 'bk-1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockResolveSiteDataDb).not.toHaveBeenCalled();
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });

  it('(i) confirm + bookmark → forwards {action:restore, bookmark, confirm} and returns restored + previous_bookmark', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveSiteDataDb.mockResolvedValueOnce(resolvedDb);
    mockD1Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'd1-1',
      data: {
        action: 'restore',
        restored: true,
        bookmark: 'bk-after',
        previousBookmark: 'bk-before',
        message: 'Restored',
      },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_restore',
        arguments: { site_id: 'site-1', bookmark: 'bk-1', confirm: true },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.restored).toBe(true);
    expect(payload.bookmark).toBe('bk-after');
    expect(payload.previous_bookmark).toBe('bk-before');
    expect(payload.databaseId).toBe('db-site-1');
    expect(mockD1Mutate.mock.calls[0][1]).toEqual({
      action: 'restore',
      bookmark: 'bk-1',
      timestamp: undefined,
      confirm: true,
    });
    expect(mockD1Mutate.mock.calls[0][0].resourceId).toBe('db-site-1');
  });

  it('(j) rejects a smuggled databaseId (strict schema) — the CF id is never a caller input', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_d1_restore',
        arguments: {
          site_id: 'site-1',
          bookmark: 'bk-1',
          confirm: true,
          databaseId: 'ea3e839a-c641-4861-ae30-dfc63bff8032',
        },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // .strict() Zod schema throws on the unknown key → JSON-RPC internal-error; nothing runs.
    expect(body.result.code).toBe(-32603);
    expect(mockD1Mutate).not.toHaveBeenCalled();
  });
});
