/**
 * TDD tests for the two KV WRITE-slice MCP tools:
 *   data_kv_put    — write one key's value (optional TTL + metadata) to the site's own KV namespace
 *   data_kv_delete — delete one key from the site's own KV namespace
 *
 * Same pattern as platform_mcp_data_kv.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Both tools require the 'data:write' scope — a data:read-only token gets a scope error
 *   (b) per_site_kv flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both write tools
 *   (d) Foreign site (org mismatch) → isError + 'Site not found.' (no leak)
 *   (e) delete WITHOUT confirm → the adapter's confirmation_required report is surfaced as isError (nothing deleted)
 *   (f) delete WITH confirm → forwards {action:'delete', confirm:true, key} and returns existed
 *   (g) put forwards value/ttl/metadata/confirm and returns overwritten
 *   (h) a confirmation_required from a put (overwrite) is surfaced as isError REPORTING the key
 *   (i) not-provisioned namespace → honest 'no KV namespace yet' (never a fabricated write)
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
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: {
    list: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockKvMutate(...a),
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
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('KV write tools catalog', () => {
  it('(c) tools/list includes data_kv_put and data_kv_delete, both requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_kv_put');
    expect(names).toContain('data_kv_delete');
  });
});

// ─── data_kv_delete ────────────────────────────────────────────────────────────

describe('data_kv_delete', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_delete', arguments: { site_id: 'site-1', key: 'k', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    // The mutation must never run for an under-scoped token.
    expect(mockKvMutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_kv flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_delete', arguments: { site_id: 'site-1', key: 'k', confirm: true } },
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
      { name: 'data_kv_delete', arguments: { site_id: 'foreign', key: 'k', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockKvMutate).not.toHaveBeenCalled();
  });

  it('(e) delete WITHOUT confirm → the adapter confirmation_required report is surfaced (nothing deleted)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    // The adapter returns the confirm-required envelope that REPORTS the key + that it exists.
    mockKvMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'kv-1',
      error: {
        code: 'confirmation_required',
        message: 'Deleting KV key "session:1" is destructive (the key currently exists). Re-run with confirm:true to delete it.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_delete', arguments: { site_id: 'site-1', key: 'session:1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    // Reports WHAT would change: the key + that it exists.
    expect(body.result.content[0].text).toContain('session:1');
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    // The dispatcher DID forward confirm:undefined to the adapter (the adapter owns the gate).
    expect(mockKvMutate.mock.calls[0][1]).toMatchObject({ action: 'delete', key: 'session:1' });
    expect(mockKvMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(f) delete WITH confirm → forwards {action,confirm,key} and returns existed', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'kv-1',
      data: { action: 'delete', existed: true, key: 'session:1' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_delete', arguments: { site_id: 'site-1', key: 'session:1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('delete');
    expect(payload.existed).toBe(true);
    expect(payload.key).toBe('session:1');
    expect(mockKvMutate.mock.calls[0][1]).toEqual({ action: 'delete', confirm: true, key: 'session:1' });
  });

  it('(i) not-provisioned KV → honest "no KV namespace yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_delete', arguments: { site_id: 'site-1', key: 'k', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/KV namespace yet/i);
    expect(mockKvMutate).not.toHaveBeenCalled();
  });
});

// ─── data_kv_put ───────────────────────────────────────────────────────────────

describe('data_kv_put', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_put', arguments: { site_id: 'site-1', key: 'k', value: 'v' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockKvMutate).not.toHaveBeenCalled();
  });

  it('(g) put forwards value/ttl/metadata/confirm and returns overwritten', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'kv-1',
      data: { action: 'put', key: 'config', overwritten: true, metadataStored: true, expirationTtl: 3600 },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_kv_put',
        arguments: {
          site_id: 'site-1',
          key: 'config',
          value: 'v2',
          expiration_ttl: 3600,
          metadata: { owner: 'me' },
          confirm: true,
        },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('put');
    expect(payload.overwritten).toBe(true);
    expect(payload.metadata_stored).toBe(true);
    expect(payload.expiration_ttl).toBe(3600);
    // The dispatcher maps the snake_case tool arg to the adapter's camelCase field.
    expect(mockKvMutate.mock.calls[0][1]).toMatchObject({
      action: 'put',
      key: 'config',
      value: 'v2',
      expirationTtl: 3600,
      metadata: { owner: 'me' },
      confirm: true,
    });
  });

  it('(h) an overwrite confirmation_required from the adapter is surfaced REPORTING the key (nothing written)', async () => {
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
        message: 'KV key "config" already exists — writing overwrites its current value. Re-run with confirm:true to overwrite.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_put', arguments: { site_id: 'site-1', key: 'config', value: 'v2' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('config');
    expect(body.result.content[0].text).toMatch(/overwrite/i);
    // confirm was NOT set — the adapter owns the gate.
    expect(mockKvMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('a new key (no confirm) writes and reports overwritten:false', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedKv);
    mockKvMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'kv-1',
      data: { action: 'put', key: 'fresh', overwritten: false, metadataStored: false },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_kv_put', arguments: { site_id: 'site-1', key: 'fresh', value: 'v' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.overwritten).toBe(false);
    expect(payload.metadata_stored).toBe(false);
  });
});
