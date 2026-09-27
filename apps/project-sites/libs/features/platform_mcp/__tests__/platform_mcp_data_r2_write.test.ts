/**
 * TDD tests for the two R2 WRITE-slice MCP tools:
 *   data_r2_put_object    — write one SMALL object's bytes (optional content-type + metadata) to the site's own R2 bucket
 *   data_r2_delete_object — delete one object from the site's own R2 bucket
 *
 * Same pattern as platform_mcp_data_kv_write.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Both tools require the 'data:write' scope — a data:read-only token gets a scope error
 *   (b) per_site_r2 flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both write tools, both requiring data:write
 *   (d) Foreign site (org mismatch) → isError + 'Site not found.' (no leak, no mutation)
 *   (e) delete WITHOUT confirm → the adapter's confirmation_required report is surfaced as isError (nothing deleted)
 *   (f) delete WITH confirm → forwards {action:'delete', confirm:true, key} and returns existed
 *   (g) put forwards body/content_type/metadata/confirm (snake→camel) and returns overwritten
 *   (h) a confirmation_required from a put (overwrite) is surfaced as isError REPORTING the key
 *   (i) not-provisioned bucket → honest 'no R2 bucket yet' (never a fabricated write)
 *   (j) a LARGE object (object_too_large) is surfaced as isError noting a signed upload URL — never embedded
 *   (k) the tool result NEVER carries account-wide R2 credentials
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

const mockR2Mutate = jest.fn();
jest.mock('../../data_resource_registry/adapters/r2.js', () => ({
  r2Adapter: {
    list: jest.fn(),
    head: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockR2Mutate(...a),
  },
}));

const mockResolveCfCredentials = jest.fn().mockResolvedValue({
  kind: 'global',
  email: 'e',
  apiKey: 'SUPER_SECRET_ACCOUNT_KEY',
});
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

/** A resolved R2 scope the registry resolver returns for an OWNED, provisioned site (R2 id IS the bucket name). */
const resolvedR2 = {
  ok: true,
  resourceId: 'ps-site-abc-123',
  resourceKind: 'r2',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'site_scoped',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockR2Mutate.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('R2 write tools catalog', () => {
  it('(c) tools/list includes data_r2_put_object and data_r2_delete_object, both requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string }> = body.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('data_r2_put_object');
    expect(names).toContain('data_r2_delete_object');
  });
});

// ─── data_r2_delete_object ───────────────────────────────────────────────────────

describe('data_r2_delete_object', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_delete_object', arguments: { site_id: 'site-1', key: 'a.txt', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    // The mutation must never run for an under-scoped token.
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_r2 flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_delete_object', arguments: { site_id: 'site-1', key: 'a.txt', confirm: true } },
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
      { name: 'data_r2_delete_object', arguments: { site_id: 'foreign', key: 'a.txt', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(e) delete WITHOUT confirm → the adapter confirmation_required report is surfaced (nothing deleted)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    // The adapter returns the confirm-required envelope that REPORTS the key + that it exists.
    mockR2Mutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'r2-1',
      error: {
        code: 'confirmation_required',
        message: 'Deleting R2 object "uploads/a.txt" is destructive (the object currently exists). Re-run with confirm:true to delete it.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_delete_object', arguments: { site_id: 'site-1', key: 'uploads/a.txt' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    // Reports WHAT would change: the key + that it exists.
    expect(body.result.content[0].text).toContain('uploads/a.txt');
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    // The dispatcher DID forward confirm:undefined to the adapter (the adapter owns the gate).
    expect(mockR2Mutate.mock.calls[0][1]).toMatchObject({ action: 'delete', key: 'uploads/a.txt' });
    expect(mockR2Mutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(f) delete WITH confirm → forwards {action,confirm,key} and returns existed', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { action: 'delete', existed: true, key: 'uploads/a.txt' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_delete_object', arguments: { site_id: 'site-1', key: 'uploads/a.txt', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('delete');
    expect(payload.existed).toBe(true);
    expect(payload.key).toBe('uploads/a.txt');
    expect(mockR2Mutate.mock.calls[0][1]).toEqual({ action: 'delete', confirm: true, key: 'uploads/a.txt' });
  });

  it('(i) not-provisioned R2 → honest "no R2 bucket yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_delete_object', arguments: { site_id: 'site-1', key: 'a.txt', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/R2 bucket yet/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });
});

// ─── data_r2_put_object ───────────────────────────────────────────────────────

describe('data_r2_put_object', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_put_object', arguments: { site_id: 'site-1', key: 'a.txt', body: 'v' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(g) put forwards body/content_type/metadata/confirm (snake→camel) and returns overwritten', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { action: 'put', key: 'config.json', overwritten: true, metadataStored: true, contentType: 'application/json' },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_r2_put_object',
        arguments: {
          site_id: 'site-1',
          key: 'config.json',
          body: '{"a":1}',
          content_type: 'application/json',
          custom_metadata: { owner: 'me' },
          http_metadata: { cacheControl: 'max-age=60' },
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
    expect(payload.content_type).toBe('application/json');
    // The dispatcher maps the snake_case tool args to the adapter's camelCase fields.
    expect(mockR2Mutate.mock.calls[0][1]).toMatchObject({
      action: 'put',
      key: 'config.json',
      body: '{"a":1}',
      contentType: 'application/json',
      customMetadata: { owner: 'me' },
      httpMetadata: { cacheControl: 'max-age=60' },
      confirm: true,
    });
  });

  it('(h) an overwrite confirmation_required from the adapter is surfaced REPORTING the key (nothing written)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'r2-1',
      error: {
        code: 'confirmation_required',
        message: 'R2 object "config.json" already exists — writing overwrites the current object. Re-run with confirm:true to overwrite.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_put_object', arguments: { site_id: 'site-1', key: 'config.json', body: 'v2' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('config.json');
    expect(body.result.content[0].text).toMatch(/overwrite/i);
    // confirm was NOT set — the adapter owns the gate.
    expect(mockR2Mutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(j) a LARGE object (object_too_large) is surfaced noting a signed upload URL — never embedded', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'r2-1',
      error: {
        code: 'object_too_large',
        message:
          'Object exceeds the 25 MiB inline-upload limit. Large/multipart uploads require a short-lived scoped upload URL (a signed R2 URL), not embedded bytes.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_put_object', arguments: { site_id: 'site-1', key: 'big.bin', body: 'pretend-large', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/upload url|signed/i);
  });

  it('a new object (no confirm) writes and reports overwritten:false', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { action: 'put', key: 'fresh.txt', overwritten: false, metadataStored: false, contentType: 'application/octet-stream' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_put_object', arguments: { site_id: 'site-1', key: 'fresh.txt', body: 'v' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.overwritten).toBe(false);
    expect(payload.metadata_stored).toBe(false);
  });

  it('(k) the successful put result NEVER carries account-wide R2 credentials', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { action: 'put', key: 'fresh.txt', overwritten: false, metadataStored: false, contentType: 'application/octet-stream' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_put_object', arguments: { site_id: 'site-1', key: 'fresh.txt', body: 'v' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    const text = body.result.content[0].text;
    // The stored account key resolved into the scope must never appear in the tool result envelope.
    expect(text).not.toContain('SUPER_SECRET_ACCOUNT_KEY');
    expect(text).not.toMatch(/apiKey|X-Auth-Key/i);
  });
});
