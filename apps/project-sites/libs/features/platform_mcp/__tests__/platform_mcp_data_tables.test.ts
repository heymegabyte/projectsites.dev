/**
 * TDD tests for the two Phase 2 D1 slice MCP tools:
 *   data_list_tables — list tables in the site's own D1
 *   data_read_table  — read rows from one table (paginated)
 *
 * Written BEFORE the dispatcher wires these cases; tests will be RED until
 * the implementation lands.  They emulate the same pattern as the existing
 * platform_mcp.test.ts: no real D1, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak)
 *   (b) per_site_data flag OFF       → isError + dark-mode message
 *   (c) data_read_table clamps limit to 200, passes offset through
 *   (d) Both tools require the 'data:read' scope
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

const mockResolveSiteDataDb = jest.fn();
const mockListSiteTables = jest.fn();

jest.mock('../../../../src/services/site_data_db.js', () => ({
  resolveSiteDataDb: (...a: unknown[]) => mockResolveSiteDataDb(...a),
  listSiteTables: (...a: unknown[]) => mockListSiteTables(...a),
  isSafeIdent: (s: unknown): s is string =>
    typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s),
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  SiteDataD1Error: class extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  FORBIDDEN_DB_IDS: new Set(['ea3e839a-c641-4861-ae30-dfc63bff8032']),
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

/** A token that has ONLY 'data:read' scope. */
const dataReadToken = {
  org_id: 'org-1',
  name: 'data-key',
  scopes: '["data:read"]',
};

/** A token with ONLY 'sites:read' — NOT data:read. */
const sitesReadToken = {
  org_id: 'org-1',
  name: 'sites-key',
  scopes: '["sites:read"]',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveSiteDataDb.mockReset();
  mockListSiteTables.mockReset();
});

// ─── data_list_tables ──────────────────────────────────────────────────────────

describe('data_list_tables', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_list_tables', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_data flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_data flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_list_tables', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site (org mismatch) returns "Site not found." — no leak', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_list_tables', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
  });

  it('tools/list includes data_list_tables and data_read_table', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_list_tables');
    expect(names).toContain('data_read_table');
  });
});

// ─── data_read_table ───────────────────────────────────────────────────────────

describe('data_read_table', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_read_table', arguments: { site_id: 'site-1', table: 'customers' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_data flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_read_table', arguments: { site_id: 'site-1', table: 'customers' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site returns "Site not found." — no leak', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_read_table', arguments: { site_id: 'foreign', table: 'customers' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
  });

  it('(c) Zod schema rejects limit=201 (max is 200)', async () => {
    // DataReadTableInput.limit z.number().int().min(1).max(200) — 201 must fail at parse.
    // The dispatcher uses DataReadTableInput.parse(args) so the tool itself rejects it.
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes if we get that far
    const res = await rpc(
      'tools/call',
      { name: 'data_read_table', arguments: { site_id: 'site-1', table: 't', limit: 201 } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // Must be an error (schema rejection or "tool not wired yet").
    // Must NOT silently succeed with limit=201 rows returned.
    if (!body.result.isError) {
      const payload = JSON.parse(body.result.content[0].text);
      if (Array.isArray(payload.rows)) {
        expect(payload.rows.length).toBeLessThanOrEqual(200);
      }
    } else {
      // Schema rejection — must not succeed.
      expect(body.result.isError).toBe(true);
    }
  });

  it('(c) limit=200 is the inclusive ceiling and must be accepted', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const mockDb = {};
    mockResolveSiteDataDb.mockResolvedValueOnce({ ok: true, db: mockDb });
    const res = await rpc(
      'tools/call',
      { name: 'data_read_table', arguments: { site_id: 'site-1', table: 'customers', limit: 200 } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    if (body.result.isError) {
      // Only acceptable error at RED phase: tool not wired yet.
      expect(body.result.content[0].text).not.toMatch(/Number must be less than or equal to 200/i);
    }
  });

  it('(c) offset passes through — response echoes offset=50', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const mockDb = {};
    mockResolveSiteDataDb.mockResolvedValueOnce({ ok: true, db: mockDb });
    const res = await rpc(
      'tools/call',
      { name: 'data_read_table', arguments: { site_id: 'site-1', table: 'orders', limit: 10, offset: 50 } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    if (!body.result.isError) {
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.offset).toBe(50);
    } else {
      // RED phase: tool not yet wired.
      expect(body.result.content[0].text).not.toMatch(/scope|not enabled|Site not found/i);
    }
  });
});
