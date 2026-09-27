/**
 * TDD tests for the two Vectorize WRITE-slice MCP tools:
 *   data_vectorize_upsert — write vectors into the site's own namespace (namespace FORCED server-side)
 *   data_vectorize_delete — delete vectors by id from the site's own namespace (foreign ids impossible)
 *
 * Same pattern as platform_mcp_data_kv_write.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Both tools require the 'data:write' scope — a data:read-only token gets a scope error
 *   (b) per_site_vectorize flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both write tools, both requiring data:write
 *   (d) Foreign site (org mismatch) → isError + 'Site not found.' (no leak, no mutation)
 *   (e) delete WITHOUT confirm → the adapter's confirmation_required report is surfaced (nothing deleted)
 *   (f) delete WITH confirm → forwards {action:'delete', confirm:true, ids} and returns deleted+skipped
 *   (g) upsert forwards vectors and returns count + namespace; the caller never supplies a namespace
 *   (h) not-provisioned namespace → honest 'no Vectorize namespace yet' (never a fabricated write)
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

const mockVectorizeMutate = jest.fn();
jest.mock('../../data_resource_registry/adapters/vectorize.js', () => ({
  vectorizeAdapter: {
    list: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockVectorizeMutate(...a),
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

/** A resolved Vectorize scope the registry resolver returns for an OWNED, provisioned site. */
const resolvedVectorize = {
  ok: true,
  resourceId: 'projectsites-rag',
  resourceKind: 'vectorize',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'site_scoped',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockVectorizeMutate.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Vectorize write tools catalog', () => {
  it('(c) tools/list includes data_vectorize_upsert and data_vectorize_delete, both requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string }> = body.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('data_vectorize_upsert');
    expect(names).toContain('data_vectorize_delete');
  });
});

// ─── data_vectorize_delete ───────────────────────────────────────────────────────

describe('data_vectorize_delete', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_delete', arguments: { site_id: 'site-1', ids: ['v1'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_vectorize flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_delete', arguments: { site_id: 'site-1', ids: ['v1'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_delete', arguments: { site_id: 'foreign', ids: ['v1'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });

  it('(e) delete WITHOUT confirm → the adapter confirmation_required report is surfaced (nothing deleted)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedVectorize);
    mockVectorizeMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'vectorize-1',
      error: {
        code: 'confirmation_required',
        message: "Deleting Vectorize vectors is destructive — 1 of 1 requested id(s) are in this site's namespace and would be removed. Re-run with confirm:true to delete.",
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_delete', arguments: { site_id: 'site-1', ids: ['v1'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    // The dispatcher forwarded confirm:undefined — the adapter owns the gate.
    expect(mockVectorizeMutate.mock.calls[0][1]).toMatchObject({ action: 'delete', ids: ['v1'] });
    expect(mockVectorizeMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(f) delete WITH confirm → forwards {action,confirm,ids} and returns deleted+skipped', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedVectorize);
    mockVectorizeMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'vectorize-1',
      data: { action: 'delete', deleted: 1, skipped: 1, namespace: 'site-site-1', mutationId: 'mut-del' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_delete', arguments: { site_id: 'site-1', ids: ['mine', 'foreign'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('delete');
    expect(payload.deleted).toBe(1);
    expect(payload.skipped).toBe(1);
    expect(payload.mutationId).toBe('mut-del');
    expect(mockVectorizeMutate.mock.calls[0][1]).toEqual({ action: 'delete', confirm: true, ids: ['mine', 'foreign'] });
  });

  it('(h) not-provisioned Vectorize → honest "no Vectorize namespace yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_delete', arguments: { site_id: 'site-1', ids: ['v1'], confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Vectorize namespace yet/i);
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });
});

// ─── data_vectorize_upsert ───────────────────────────────────────────────────────

describe('data_vectorize_upsert', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_upsert', arguments: { site_id: 'site-1', vectors: [{ id: 'v1', values: [0.1] }] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });

  it('(g) upsert forwards vectors and returns count + namespace (caller never supplies a namespace)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedVectorize);
    mockVectorizeMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'vectorize-1',
      data: { action: 'upsert', count: 2, namespace: 'site-site-1', mutationId: 'mut-up' },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_vectorize_upsert',
        arguments: {
          site_id: 'site-1',
          vectors: [
            { id: 'v1', values: [0.1, 0.2], metadata: { t: 'a' } },
            { id: 'v2', values: [0.3, 0.4] },
          ],
        },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('upsert');
    expect(payload.count).toBe(2);
    expect(payload.namespace).toBe('site-site-1');
    expect(payload.mutationId).toBe('mut-up');
    // The dispatcher forwards the vectors as an upsert mutation; it never adds a namespace (the adapter forces it).
    const forwarded = mockVectorizeMutate.mock.calls[0][1];
    expect(forwarded.action).toBe('upsert');
    expect(forwarded.vectors).toHaveLength(2);
    expect(forwarded.vectors[0]).toMatchObject({ id: 'v1', values: [0.1, 0.2] });
    expect('namespace' in forwarded).toBe(false);
  });

  it('(b) per_site_vectorize flag OFF returns dark error, no mutation', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_upsert', arguments: { site_id: 'site-1', vectors: [{ id: 'v1', values: [0.1] }] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });

  it('a rejected argument shape (empty vectors) is surfaced as a JSON-RPC error, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_upsert', arguments: { site_id: 'site-1', vectors: [] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // The Zod `.parse()` throw is caught by the handler → a JSON-RPC error (code -32603) placed in `result`;
    // it is NOT a fabricated write. The mutation never ran.
    expect(body.result.code).toBe(-32603);
    expect(body.result.isError).toBeUndefined();
    expect(mockVectorizeMutate).not.toHaveBeenCalled();
  });
});
