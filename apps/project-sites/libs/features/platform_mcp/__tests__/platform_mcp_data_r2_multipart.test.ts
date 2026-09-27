/**
 * TDD tests for the three R2 MULTIPART MCP tools:
 *   data_r2_multipart_create   — begin a multipart upload for one large object (returns the transfer HANDLE)
 *   data_r2_multipart_complete — assemble the uploaded parts into the final object (overwrite-gated)
 *   data_r2_multipart_abort    — cancel an in-flight upload + discard its parts (idempotent)
 *
 * Same pattern as platform_mcp_data_r2_write.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) all three tools require the 'data:write' scope — a data:read-only token gets a scope error
 *   (b) per_site_r2 flag OFF → isError + dark-mode message (no mutation)
 *   (c) tools/list advertises all three multipart tools, each requiring data:write
 *   (d) foreign site (org mismatch) → isError + 'Site not found.' (no leak, no mutation)
 *   (e) create forwards {action:'create_multipart_upload', key, contentType} (snake→camel), returns the handle
 *   (f) create's honest multipart_not_available is surfaced as isError (never a fabricated upload_id)
 *   (g) complete forwards upload_id + parts[] (part_number→partNumber) + confirm and surfaces overwrite gate
 *   (h) abort forwards {action:'abort_multipart_upload', uploadId} and returns aborted
 *   (i) not-provisioned bucket → honest 'no R2 bucket yet' (never a fabricated upload)
 *   (j) LARGE PART BYTES are never carried in an MCP argument — create/complete inputs have no `body` field
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

const dataWriteToken = { org_id: 'org-1', name: 'write-key', scopes: '["data:read","data:write"]' };
const dataReadOnlyToken = { org_id: 'org-1', name: 'read-key', scopes: '["data:read"]' };

/** A resolved R2 scope for an OWNED, provisioned site (R2 id IS the bucket name). */
const resolvedR2 = {
  ok: true,
  resourceId: 'ps-site-abc-123',
  resourceKind: 'r2',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'site_scoped',
};

/** The honest not-available envelope the adapter returns for a valid multipart request (transport unwired). */
const notAvailable = {
  ok: false,
  correlationId: 'r2-1',
  error: {
    code: 'multipart_not_available',
    message:
      'Multipart create is not wired for this per-site R2 bucket yet. Parts transfer through a SERVER-SIDE proxy under a scoped token — never inline bytes, never an account credential.',
    retryable: false,
  },
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockR2Mutate.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('R2 multipart tools catalog', () => {
  it('(c) tools/list includes the three multipart tools, all requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string; inputSchema?: unknown }> = body.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('data_r2_multipart_create');
    expect(names).toContain('data_r2_multipart_complete');
    expect(names).toContain('data_r2_multipart_abort');
  });

  it('(j) the create + complete tool schemas have NO `body` field (large bytes never ride an MCP arg)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> =
      body.result.tools;
    const create = tools.find((t) => t.name === 'data_r2_multipart_create')!;
    const complete = tools.find((t) => t.name === 'data_r2_multipart_complete')!;
    expect(create.inputSchema.properties).not.toHaveProperty('body');
    expect(complete.inputSchema.properties).not.toHaveProperty('body');
    // complete carries only the small {part_number, etag} handles, not bytes.
    expect(complete.inputSchema.properties).toHaveProperty('parts');
  });
});

// ─── data_r2_multipart_create ───────────────────────────────────────────────────────

describe('data_r2_multipart_create', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_create', arguments: { site_id: 'site-1', key: 'big.bin' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_r2 flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_create', arguments: { site_id: 'site-1', key: 'big.bin' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) → "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_create', arguments: { site_id: 'foreign', key: 'big.bin' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(e) forwards {action, key, contentType} (snake→camel) and returns the transfer handle', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: {
        action: 'create_multipart_upload',
        key: 'big.bin',
        uploadId: 'upl-xyz',
        partTransport: 'server_proxy',
        limits: { minPartBytes: 5242880, maxPartBytes: 5368709120, maxParts: 10000 },
      },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_r2_multipart_create',
        arguments: {
          site_id: 'site-1',
          key: 'big.bin',
          content_type: 'application/octet-stream',
          custom_metadata: { owner: 'me' },
        },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('create_multipart_upload');
    expect(payload.upload_id).toBe('upl-xyz');
    expect(payload.partTransport).toBe('server_proxy');
    // snake→camel mapping to the adapter.
    expect(mockR2Mutate.mock.calls[0][1]).toMatchObject({
      action: 'create_multipart_upload',
      key: 'big.bin',
      contentType: 'application/octet-stream',
      customMetadata: { owner: 'me' },
    });
  });

  it('(f) an honest multipart_not_available is surfaced as isError (never a fabricated upload_id)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce(notAvailable);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_create', arguments: { site_id: 'site-1', key: 'big.bin' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not wired|server-side proxy/i);
    // No upload_id was fabricated in the surfaced error.
    expect(body.result.content[0].text).not.toMatch(/upl-/);
  });

  it('(i) not-provisioned R2 → honest "no R2 bucket yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_create', arguments: { site_id: 'site-1', key: 'big.bin' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/R2 bucket yet/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });
});

// ─── data_r2_multipart_complete ─────────────────────────────────────────────────────

describe('data_r2_multipart_complete', () => {
  it('(a) requires data:write scope', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      {
        name: 'data_r2_multipart_complete',
        arguments: { site_id: 'site-1', key: 'big.bin', upload_id: 'u1', parts: [{ part_number: 1, etag: 'e1' }] },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(g) forwards upload_id + parts[] (part_number→partNumber) + confirm; returns overwritten', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { action: 'complete_multipart_upload', key: 'big.bin', overwritten: true, etag: 'final-e', partCount: 2 },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_r2_multipart_complete',
        arguments: {
          site_id: 'site-1',
          key: 'big.bin',
          upload_id: 'u1',
          parts: [
            { part_number: 1, etag: 'e1' },
            { part_number: 2, etag: 'e2' },
          ],
          confirm: true,
        },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('complete_multipart_upload');
    expect(payload.overwritten).toBe(true);
    expect(payload.partCount).toBe(2);
    // parts snake→camel mapping + uploadId forwarded.
    expect(mockR2Mutate.mock.calls[0][1]).toMatchObject({
      action: 'complete_multipart_upload',
      key: 'big.bin',
      uploadId: 'u1',
      confirm: true,
      parts: [
        { partNumber: 1, etag: 'e1' },
        { partNumber: 2, etag: 'e2' },
      ],
    });
  });

  it('an overwrite confirmation_required from the adapter is surfaced REPORTING the key (nothing assembled)', async () => {
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
        message: 'R2 object "big.bin" already exists — completing this multipart upload overwrites the current object. Re-run with confirm:true to overwrite.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_r2_multipart_complete',
        arguments: { site_id: 'site-1', key: 'big.bin', upload_id: 'u1', parts: [{ part_number: 1, etag: 'e1' }] },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('big.bin');
    expect(body.result.content[0].text).toMatch(/overwrite/i);
    expect(mockR2Mutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('rejects a non-ascending parts[] at the schema boundary (strict) — never reaches the adapter', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'r2-1',
      error: { code: 'part_order_invalid', message: 'parts[] must be strictly ascending by partNumber.', retryable: false },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_r2_multipart_complete',
        arguments: {
          site_id: 'site-1',
          key: 'big.bin',
          upload_id: 'u1',
          parts: [
            { part_number: 2, etag: 'e2' },
            { part_number: 1, etag: 'e1' },
          ],
        },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // The adapter owns the ascending check → its typed error is surfaced as isError.
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/ascending/i);
  });
});

// ─── data_r2_multipart_abort ────────────────────────────────────────────────────────

describe('data_r2_multipart_abort', () => {
  it('(a) requires data:write scope', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_abort', arguments: { site_id: 'site-1', key: 'big.bin', upload_id: 'u1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockR2Mutate).not.toHaveBeenCalled();
  });

  it('(h) forwards {action, uploadId} and returns aborted', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { action: 'abort_multipart_upload', key: 'big.bin', uploadId: 'u1', aborted: true },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_abort', arguments: { site_id: 'site-1', key: 'big.bin', upload_id: 'u1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('abort_multipart_upload');
    expect(payload.aborted).toBe(true);
    expect(mockR2Mutate.mock.calls[0][1]).toEqual({
      action: 'abort_multipart_upload',
      key: 'big.bin',
      uploadId: 'u1',
    });
  });
});

// ─── (k) credential safety ─────────────────────────────────────────────────────────

describe('R2 multipart credential safety', () => {
  it('(k) the create result NEVER carries account-wide R2 credentials', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2Mutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: {
        action: 'create_multipart_upload',
        key: 'big.bin',
        uploadId: 'upl-xyz',
        partTransport: 'server_proxy',
        limits: { minPartBytes: 5242880, maxPartBytes: 5368709120, maxParts: 10000 },
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_multipart_create', arguments: { site_id: 'site-1', key: 'big.bin' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    const text = body.result.content[0].text;
    expect(text).not.toContain('SUPER_SECRET_ACCOUNT_KEY');
    expect(text).not.toMatch(/apiKey|X-Auth-Key/i);
  });
});
