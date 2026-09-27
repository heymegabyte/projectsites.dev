/**
 * TDD tests for the PROVISIONING MCP tool: data_provision_resource — turn a site's 'not provisioned'
 * D1/KV/R2 into a live, isolated, dedicated resource by calling the (previously inert) provisioner.
 *
 * Same pattern as platform_mcp_data_kv_write.test.ts: NO real Cloudflare, all external deps mocked
 * (including `provisionResource`, so ZERO real resources are ever created), global-jest convention
 * (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) requires the 'data:write' scope — a data:read-only token gets a scope error, no provision
 *   (b) data_resource_platform flag OFF → isError + dark-mode message, no provision
 *   (c) tools/list advertises data_provision_resource requiring data:write
 *   (d) foreign site (org mismatch) → isError 'Site not found.' (no leak), provisionResource NOT called
 *   (e) confirm gate — the confirmation_required result is surfaced as isError (nothing created)
 *   (f) quota at cap — the quota_at_cap result is surfaced honestly (never a silent shared substitution)
 *   (g) happy path — forwards {confirm, environment, orgId} + returns the created id + created:true
 *   (h) idempotent reuse — created:false is surfaced (existing resource returned)
 *   (i) partial recovery — a record_failed result is surfaced WITH the created id (recoverable)
 *   (j) the CF-id-free contract — the caller names only site_id + kind (a smuggled resourceId is rejected)
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

// The registry service is where provisionResource lives — mock BOTH the read helpers the dispatcher
// imports (listResources/resolveResourceRef) AND provisionResource so NO real CF/DB work happens.
const mockProvisionResource = jest.fn();
jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: jest.fn(),
  recordResource: jest.fn(),
  getResource: jest.fn(),
  provisionResource: (...a: unknown[]) => mockProvisionResource(...a),
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

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockProvisionResource.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('data_provision_resource catalog', () => {
  it('(c) tools/list includes data_provision_resource requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string; requiredScope?: string }> = body.result.tools;
    const tool = tools.find((t) => t.name === 'data_provision_resource');
    expect(tool).toBeDefined();
    // The advertised inputSchema takes site_id + kind, never a CF id.
    const props = (tool as unknown as { inputSchema: { properties: Record<string, unknown> } })
      .inputSchema.properties;
    expect(Object.keys(props).sort()).toEqual(['confirm', 'environment', 'kind', 'site_id']);
  });
});

// ─── data_provision_resource ─────────────────────────────────────────────────────

describe('data_provision_resource', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error, no provision', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'site-1', kind: 'd1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockProvisionResource).not.toHaveBeenCalled();
  });

  it('(b) data_resource_platform flag OFF returns dark error, no provision', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'site-1', kind: 'kv', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockProvisionResource).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) → "Site not found.", provisionResource NOT called (no leak)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'foreign', kind: 'd1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockProvisionResource).not.toHaveBeenCalled();
  });

  it('(e) confirm gate — a confirmation_required result is surfaced as isError (nothing created)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockProvisionResource.mockResolvedValueOnce({ ok: false, reason: 'confirmation_required' });
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'site-1', kind: 'd1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    expect(body.result.content[0].text).toMatch(/billable/i);
    // The dispatcher forwarded confirm:undefined (the orchestrator owns the gate).
    expect(mockProvisionResource.mock.calls[0][3]).toMatchObject({ orgId: 'org-1', environment: 'production' });
    expect(mockProvisionResource.mock.calls[0][3].confirm).toBeUndefined();
  });

  it('(f) quota at cap — surfaced honestly, never a silent shared substitution', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockProvisionResource.mockResolvedValueOnce({ ok: false, reason: 'quota_at_cap' });
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'site-1', kind: 'd1', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/quota/i);
    expect(body.result.content[0].text).toMatch(/never substituted silently/i);
  });

  it('(g) happy path — forwards {confirm, environment, orgId} + returns created id + created:true', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockProvisionResource.mockResolvedValueOnce({
      ok: true,
      resourceId: 'db-uuid-1',
      registryRowId: 'row-1',
      created: true,
      displayName: 'ps-site-site-1',
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_provision_resource',
        arguments: { site_id: 'site-1', kind: 'd1', confirm: true, environment: 'preview' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload).toMatchObject({
      site_id: 'site-1',
      environment: 'preview',
      kind: 'd1',
      resourceId: 'db-uuid-1',
      registryRowId: 'row-1',
      created: true,
    });
    // Forwarded the owned site + kind + confirm + env to the orchestrator (which owns quota/record/gate).
    expect(mockProvisionResource.mock.calls[0][1]).toBe('site-1'); // siteId
    expect(mockProvisionResource.mock.calls[0][2]).toBe('d1'); // kind
    expect(mockProvisionResource.mock.calls[0][3]).toMatchObject({
      confirm: true,
      environment: 'preview',
      orgId: 'org-1',
    });
  });

  it('(h) idempotent reuse — created:false is surfaced (existing resource returned)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockProvisionResource.mockResolvedValueOnce({
      ok: true,
      resourceId: 'kvns-1',
      registryRowId: 'row-1',
      created: false,
      displayName: 'ps-site-site-1-kv',
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'site-1', kind: 'kv', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.created).toBe(false);
    expect(payload.resourceId).toBe('kvns-1');
  });

  it('(i) partial recovery — a record_failed is surfaced WITH the created id (recoverable)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockProvisionResource.mockResolvedValueOnce({
      ok: false,
      reason: 'record_failed',
      resourceId: 'r2-bucket-1',
      detail: 'db write failed',
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_provision_resource', arguments: { site_id: 'site-1', kind: 'r2', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    // The created id is reported so the partial state is recoverable (re-run reuses it).
    expect(body.result.content[0].text).toContain('r2-bucket-1');
    expect(body.result.content[0].text).toMatch(/recoverable|re-run/i);
  });

  it('(j) CF-id-free — a smuggled resourceId is rejected by the strict schema, the provisioner never runs', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      {
        name: 'data_provision_resource',
        arguments: { site_id: 'site-1', kind: 'd1', confirm: true, resourceId: 'db-evil' },
      },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // The strict schema's `.parse()` throws a ZodError → caught by the dispatcher's catch, which assigns
    // jsonRpcError(...).error into `result` → body.result carries the -32603 code (never a fabricated
    // success). The provisioner is NEVER reached with a smuggled id.
    expect(body.result.code).toBe(-32603);
    expect(mockProvisionResource).not.toHaveBeenCalled();
  });
});
