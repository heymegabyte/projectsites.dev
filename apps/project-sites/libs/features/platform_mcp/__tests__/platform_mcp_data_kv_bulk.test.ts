/**
 * TDD tests for the two KV BULK-slice MCP tools:
 *   data_kv_bulk_get    — read MANY keys' values from the site's own KV namespace (data:read)
 *   data_kv_bulk_delete — delete MANY keys from the site's own KV namespace (data:write, confirm-gated)
 *
 * Same pattern as platform_mcp_data_kv_write.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) bulk_delete requires 'data:write'; bulk_get requires 'data:read' — under-scoped tokens get a scope error
 *   (b) per_site_kv flag OFF → isError + dark-mode message (both tools)
 *   (c) tools/list advertises both bulk tools with the right scope
 *   (d) Foreign site (org mismatch) → isError + 'Site not found.' (no leak, no adapter call)
 *   (e) bulk_delete WITHOUT confirm → the adapter's confirmation_required report is surfaced (nothing deleted)
 *   (f) bulk_delete WITH confirm → forwards {action,confirm,keys} and returns requested count
 *   (g) bulk_get forwards keys and returns per-key values + clamped_off
 *   (h) an over-cap bulk_limit_exceeded from the adapter is surfaced as isError
 *   (i) not-provisioned namespace → honest 'no KV namespace yet' (never a fabricated op)
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

const mockResolveResourceRef = jest.fn();
jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: (...a: unknown[]) => mockResolveResourceRef(...a),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

const mockKvMutate = jest.fn();
const mockKvBulkGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: {
    list: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockKvMutate(...a),
    bulkGet: (...a: unknown[]) => mockKvBulkGet(...a),
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

/** A token that has the 'data:write' scope (and data:read). */
const dataWriteToken = { org_id: 'org-1', name: 'write-key', scopes: '["data:read","data:write"]' };
/** A token with ONLY 'data:read' — NOT data:write. */
const dataReadOnlyToken = { org_id: 'org-1', name: 'read-key', scopes: '["data:read"]' };
/** A token with NEITHER data scope. */
const noDataToken = { org_id: 'org-1', name: 'plain', scopes: '["sites:read"]' };

/** A resolved KV scope the registry resolver returns for an OWNED, provisioned site. */
const resolvedKv = {
  ok: true,
  resourceId: 'kvns-1',
  resourceKind: 'kv',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'site_scoped',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockKvMutate.mockReset();
  mockKvBulkGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('KV bulk tools catalog', () => {
  it('(c) tools/list includes data_kv_bulk_get (read) and data_kv_bulk_delete (write)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string }> = body.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('data_kv_bulk_get');
    expect(names).toContain('data_kv_bulk_delete');
  });
});

// ─── data_kv_bulk_delete ─────────────────────────────────────────────────────────

describe('data_kv_bulk_delete', () => {
  it('(a) requires data:write — a data:read-only token gets a scope error, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'site-1', keys: ['a'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockKvMutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_kv flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'site-1', keys: ['a'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'foreign', keys: ['a'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockKvMutate).not.toHaveBeenCalled();
  });

  it('(e) WITHOUT confirm → the adapter confirmation_required (count) report is surfaced (nothing deleted)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'kv-1',
      error: {
        code: 'confirmation_required',
        message: 'Bulk-deleting 3 KV keys is destructive. Re-run with confirm:true to remove them.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'site-1', keys: ['a', 'b', 'c'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/3/);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    // The dispatcher forwarded confirm:undefined — the adapter owns the gate.
    expect(mockKvMutate.mock.calls[0][1]).toMatchObject({ action: 'bulk_delete', keys: ['a', 'b', 'c'] });
    expect(mockKvMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(f) WITH confirm → forwards {action,confirm,keys} and returns requested count', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'kv-1',
      data: { action: 'bulk_delete', requested: 3 },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'site-1', keys: ['a', 'b', 'c'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('bulk_delete');
    expect(payload.requested).toBe(3);
    expect(mockKvMutate.mock.calls[0][1]).toEqual({
      action: 'bulk_delete',
      confirm: true,
      keys: ['a', 'b', 'c'],
    });
  });

  it('(h) an over-cap bulk_limit_exceeded from the adapter is surfaced as isError', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'kv-1',
      error: {
        code: 'bulk_limit_exceeded',
        message: 'Bulk delete accepts at most 10000 keys per request (received 10001). Split into smaller batches.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'site-1', keys: ['a'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/10000|10,000/);
  });

  it('(i) not-provisioned KV → honest "no KV namespace yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_delete', arguments: { site_id: 'site-1', keys: ['a'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/KV namespace yet/i);
    expect(mockKvMutate).not.toHaveBeenCalled();
  });
});

// ─── data_kv_bulk_get ────────────────────────────────────────────────────────────

describe('data_kv_bulk_get', () => {
  it('(a) requires data:read — a token without it gets a scope error, no read', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(noDataToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_get', arguments: { site_id: 'site-1', keys: ['a'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockKvBulkGet).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no read', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_get', arguments: { site_id: 'foreign', keys: ['a'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockKvBulkGet).not.toHaveBeenCalled();
  });

  it('(g) forwards keys and returns per-key values + counts + clamped_off (data:read is enough)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvBulkGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'kv-1',
      data: {
        clampedOff: 0,
        found: 2,
        missing: 1,
        values: [
          { found: true, key: 'a', value: 'va' },
          { found: false, key: 'b' },
          { found: true, key: 'c', value: 'vc' },
        ],
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_get', arguments: { site_id: 'site-1', keys: ['a', 'b', 'c'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.found).toBe(2);
    expect(payload.missing).toBe(1);
    expect(payload.clamped_off).toBe(0);
    expect(payload.values).toHaveLength(3);
    expect(mockKvBulkGet.mock.calls[0][1]).toEqual({ keys: ['a', 'b', 'c'] });
  });

  it('(b) per_site_kv flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_bulk_get', arguments: { site_id: 'site-1', keys: ['a'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });
});
