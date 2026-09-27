/**
 * TDD tests for the Durable Objects WRITE-slice MCP tool:
 *   data_durable_object_manage — a NARROW, platform-defined management op (status_probe | reset) against a
 *   KNOWN instance in the site's own namespace. ⛔ NEVER an arbitrary method call into customer code.
 *
 * Same pattern as platform_mcp_data_workflow_write.test.ts: no real CF/D1, all external deps mocked, global
 * jest convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) requires the 'data:write' scope — a data:read-only token gets a scope error, no mutation
 *   (b) per_site_durable_objects flag OFF → isError + dark-mode message, no mutation
 *   (c) tools/list advertises data_durable_object_manage requiring data:write
 *   (d) foreign site (org mismatch) → isError + 'Site not found.' (no leak, no mutation)
 *   (e) ⛔ NEVER-ARBITRARY-CALL: an action outside the closed enum (a "customer method") → JSON-RPC error, no mutation
 *   (f) status_probe forwards {action:'status_probe', objectId, confirm?} and returns { available, stateBrowsable:false }
 *   (g) reset WITHOUT confirm → the adapter's confirmation_required WARNING is surfaced (nothing runs)
 *   (h) reset WITH confirm → forwards {action:'reset', objectId, confirm:true}; honest available:false on this deploy
 *   (i) ISOLATION — the caller supplies only site_id + action + object_id; the namespace is server-resolved (never a CF id)
 *   (j) not-provisioned namespace → honest 'does not have a Durable Object namespace yet' (never a fabricated result)
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

const mockDurableObjectMutate = jest.fn();
jest.mock('../../data_resource_registry/adapters/durable_object.js', () => ({
  durableObjectAdapter: {
    list: jest.fn(),
    head: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockDurableObjectMutate(...a),
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

/** A resolved DO scope the registry resolver returns for an OWNED, provisioned site (resourceId = namespace id). */
const resolvedDo = {
  ok: true,
  resourceId: 'ns-aaaa1111',
  resourceKind: 'durable_object',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'read_only',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockDurableObjectMutate.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Durable Object manage tool catalog', () => {
  it('(c) tools/list includes data_durable_object_manage requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string; description: string }> = body.result.tools;
    const tool = tools.find((t) => t.name === 'data_durable_object_manage');
    expect(tool).toBeDefined();
    // The description advertises the closed-allowlist / never-arbitrary-method guarantee.
    expect(tool?.description).toMatch(/never|arbitrary method/i);
  });
});

// ─── data_durable_object_manage ──────────────────────────────────────────────────────

describe('data_durable_object_manage', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'status_probe', object_id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockDurableObjectMutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_durable_objects flag OFF returns dark error, no mutation', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'status_probe', object_id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockDurableObjectMutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'foreign', action: 'reset', object_id: 'obj-1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockDurableObjectMutate).not.toHaveBeenCalled();
  });

  it('(e) ⛔ NEVER-ARBITRARY-CALL: an action outside the closed enum → JSON-RPC error at the boundary, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      // A caller trying to smuggle an arbitrary method name as the action.
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'deleteEverything', object_id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // The Zod enum rejects it BEFORE the adapter is ever reached — no method passthrough exists.
    expect(body.result.code).toBe(-32603);
    expect(mockDurableObjectMutate).not.toHaveBeenCalled();
  });

  it('(e2) ⛔ a smuggled `method` property is rejected by .strict(), no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'status_probe', object_id: 'obj-1', method: 'wipe' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.code).toBe(-32603); // .strict() rejects the unknown `method` key
    expect(mockDurableObjectMutate).not.toHaveBeenCalled();
  });

  it('(f)(i) status_probe forwards {action,objectId} and returns available:false + stateBrowsable:false; caller names no CF id', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedDo);
    mockDurableObjectMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'durable_object-1',
      data: { action: 'status_probe', available: false, namespaceId: 'ns-aaaa1111', objectId: 'obj-1', stateBrowsable: false },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'status_probe', object_id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('status_probe');
    expect(payload.available).toBe(false);
    expect(payload.stateBrowsable).toBe(false);
    // The dispatcher maps object_id → objectId and forwards ONLY the closed op; never a CF namespace id/account.
    const forwarded = mockDurableObjectMutate.mock.calls[0][1];
    expect(forwarded).toMatchObject({ action: 'status_probe', objectId: 'obj-1' });
    expect(Object.keys(forwarded)).not.toContain('namespaceId');
    expect(Object.keys(forwarded)).not.toContain('accountId');
  });

  it('(g) reset WITHOUT confirm → the adapter confirmation_required WARNING is surfaced (nothing runs)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedDo);
    mockDurableObjectMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'durable_object-1',
      error: {
        code: 'confirmation_required',
        message: 'Resetting Durable Object "obj-1" is a state-changing management op — its transient in-memory state / alarm is cleared. Re-run with confirm:true to reset it.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'reset', object_id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    // The dispatcher forwarded confirm:undefined — the adapter owns the gate.
    expect(mockDurableObjectMutate.mock.calls[0][1]).toMatchObject({ action: 'reset', objectId: 'obj-1' });
    expect(mockDurableObjectMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(h) reset WITH confirm → forwards {action:"reset", objectId, confirm:true}; honest available:false', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedDo);
    mockDurableObjectMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'durable_object-1',
      data: { action: 'reset', available: false, namespaceId: 'ns-aaaa1111', objectId: 'obj-1', stateBrowsable: false },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'reset', object_id: 'obj-1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('reset');
    expect(payload.available).toBe(false);
    expect(payload.stateBrowsable).toBe(false);
    expect(mockDurableObjectMutate.mock.calls[0][1]).toEqual({ action: 'reset', objectId: 'obj-1', confirm: true });
  });

  it('(j) not-provisioned namespace → honest "does not have a Durable Object namespace yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_durable_object_manage', arguments: { site_id: 'site-1', action: 'status_probe', object_id: 'obj-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Durable Object namespace yet/i);
    expect(mockDurableObjectMutate).not.toHaveBeenCalled();
  });
});
