/**
 * TDD tests for the two Workflows-slice MCP tools:
 *   data_workflows_list        — list the site's workflow RUN INSTANCES (id/status/timestamps)
 *   data_workflow_get_instance — read ONE run instance's status + SANITIZED steps by id
 *
 * Same pattern as platform_mcp_data_vectorize.test.ts: no real CF/D1, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak); adapter never reached
 *   (b) per_site_workflows flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) list returns instances + count + cursor from the resolved-workflow scope (resourceId = workflow name)
 *   (f) not-provisioned (resolveResourceRef not_registered) → honest 'does not have a workflow yet'
 *   (g) get forwards the instance id + returns the ACTUAL status (never optimistic); steps sanitized
 *   (h) get missing instance → honest found:false
 *   (i) ⛔ NEVER an optimistic "complete" — the tool surfaces exactly what the adapter returns (running stays running)
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

const mockResolveRef = jest.fn();
jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: (...a: unknown[]) => mockResolveRef(...a),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

// The kv + r2 + vectorize + connection adapters are imported by the service too — stub so nothing real fires.
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/r2.js', () => ({
  r2Adapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/vectorize.js', () => ({
  vectorizeAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/connection.js', () => ({
  connectionAdapter: { list: jest.fn(), get: jest.fn() },
}));

const mockWfList = jest.fn();
const mockWfGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/workflow.js', () => ({
  workflowAdapter: {
    list: (...a: unknown[]) => mockWfList(...a),
    get: (...a: unknown[]) => mockWfGet(...a),
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

/** A token that has ONLY 'data:read' scope. */
const dataReadToken = { org_id: 'org-1', name: 'data-key', scopes: '["data:read"]' };
/** A token with ONLY 'sites:read' — NOT data:read. */
const sitesReadToken = { org_id: 'org-1', name: 'sites-key', scopes: '["sites:read"]' };

/** A successful ref resolution to a workflow NAME (the shape resolveResourceRef returns). */
const resolvedWorkflow = {
  ok: true,
  resourceId: 'site-generation',
  resourceKind: 'workflow',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'read_only',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveRef.mockReset();
  mockWfList.mockReset();
  mockWfGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Workflows tools catalog', () => {
  it('(c) tools/list includes data_workflows_list and data_workflow_get_instance', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_workflows_list');
    expect(names).toContain('data_workflow_get_instance');
  });
});

// ─── data_workflows_list ────────────────────────────────────────────────────────

describe('data_workflows_list', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflows_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_workflows flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_workflows flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflows_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site (org mismatch) returns "Site not found." — no leak; adapter never reached', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_workflows_list', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockWfList).not.toHaveBeenCalled();
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('(f) not-provisioned (resolveResourceRef not_registered) → honest "does not have a workflow yet"', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes
    mockResolveRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflows_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/does not have a workflow yet/i);
    expect(mockWfList).not.toHaveBeenCalled();
  });

  it('(e) returns instances + count + cursor; adapter scoped to the resolved workflow name', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWfList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'workflow-1',
      data: {
        workflowName: 'site-generation',
        instances: [
          { id: 'run-1', status: 'complete', createdOn: '2026-09-01T00:00:00Z' },
          { id: 'run-2', status: 'running' },
        ],
        count: 2,
        cursor: 'next',
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflows_list', arguments: { site_id: 'site-1', limit: 50 } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.workflowName).toBe('site-generation');
    expect(payload.count).toBe(2);
    expect(payload.cursor).toBe('next');
    expect(payload.instances[1].status).toBe('running');
    // The adapter was called with the scope whose resourceId is the RESOLVED workflow name (not the site id).
    expect(mockWfList.mock.calls[0][0].resourceId).toBe('site-generation');
  });
});

// ─── data_workflow_get_instance ─────────────────────────────────────────────────

describe('data_workflow_get_instance', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_get_instance', arguments: { site_id: 'site-1', id: 'run-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_workflows flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_get_instance', arguments: { site_id: 'site-1', id: 'run-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site returns "Site not found." — no leak; adapter never reached', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_get_instance', arguments: { site_id: 'foreign', id: 'run-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockWfGet).not.toHaveBeenCalled();
  });

  it('(g)(i) forwards the instance id + returns the ACTUAL status (never optimistic complete)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWfGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'workflow-2',
      data: {
        found: true,
        workflowName: 'site-generation',
        instanceId: 'run-1',
        status: 'running', // in-flight — the tool must surface it, never optimistic complete
        steps: [{ name: 'build', status: 'running', outputPreview: '{"stage":"1"}' }],
        outputSanitized: true,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_get_instance', arguments: { site_id: 'site-1', id: 'run-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.found).toBe(true);
    expect(payload.status).toBe('running');
    expect(payload.outputSanitized).toBe(true);
    expect(payload.steps[0].name).toBe('build');
    // The instance id was forwarded to the adapter; the scope's resourceId is the resolved workflow name.
    expect(mockWfGet.mock.calls[0][1].id).toBe('run-1');
    expect(mockWfGet.mock.calls[0][0].resourceId).toBe('site-generation');
  });

  it('(h) missing instance → honest found:false', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWfGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'workflow-3',
      data: { found: false, workflowName: 'site-generation', instanceId: 'nope', outputSanitized: true },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_get_instance', arguments: { site_id: 'site-1', id: 'nope' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.found).toBe(false);
    expect(payload.status).toBeUndefined();
  });
});
