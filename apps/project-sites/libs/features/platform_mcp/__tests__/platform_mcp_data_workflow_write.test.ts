/**
 * TDD tests for the two Workflows WRITE-slice MCP tools:
 *   data_workflow_start   — start a NEW run instance of the site's workflow (optional params)
 *   data_workflow_control — pause/resume/restart/terminate ONE run instance (restart+terminate confirm-gated)
 *
 * Same pattern as platform_mcp_data_vectorize_write.test.ts: no real CF/D1, all external deps mocked, global
 * jest convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Both tools require the 'data:write' scope — a data:read-only token gets a scope error
 *   (b) per_site_workflows flag OFF → isError + dark-mode message, no mutation
 *   (c) tools/list advertises both write tools, both requiring data:write
 *   (d) Foreign site (org mismatch) → isError + 'Site not found.' (no leak, no mutation)
 *   (e) start forwards {action:'start', params?} and returns the ACTUAL id+status (created:true); caller names no CF id
 *   (f) control restart WITHOUT confirm → the adapter's confirmation_required WARNING is surfaced (nothing runs)
 *   (g) control restart/terminate WITH confirm → forwards {action:op, instanceId, confirm:true}; ACTUAL status
 *   (h) control pause/resume → forwards {action, instanceId, confirm:undefined} (adapter owns the no-confirm path)
 *   (i) not-provisioned workflow → honest 'does not have a workflow yet' (never a fabricated run)
 *   (j) status honesty — the tool surfaces exactly what the adapter returns, never an optimistic 'complete'
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

const mockWorkflowMutate = jest.fn();
jest.mock('../../data_resource_registry/adapters/workflow.js', () => ({
  workflowAdapter: {
    list: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockWorkflowMutate(...a),
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

/** A resolved Workflow scope the registry resolver returns for an OWNED, provisioned site (resourceId = name). */
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
  mockResolveResourceRef.mockReset();
  mockWorkflowMutate.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Workflow write tools catalog', () => {
  it('(c) tools/list includes data_workflow_start and data_workflow_control, both requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string }> = body.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('data_workflow_start');
    expect(names).toContain('data_workflow_control');
  });
});

// ─── data_workflow_start ───────────────────────────────────────────────────────────

describe('data_workflow_start', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_start', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_workflows flag OFF returns dark error, no mutation', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_start', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_start', arguments: { site_id: 'foreign' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });

  it('(e)(j) start forwards {action:"start", params} and returns the ACTUAL id + status, created:true', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWorkflowMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'workflow-1',
      data: { action: 'start', created: true, instanceId: 'run-new', status: 'queued', workflowName: 'site-generation' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_start', arguments: { site_id: 'site-1', params: { seed: 1 } } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('start');
    expect(payload.created).toBe(true);
    expect(payload.instanceId).toBe('run-new');
    expect(payload.status).toBe('queued'); // ACTUAL CF status, never optimistic complete
    expect(payload.workflowName).toBe('site-generation');
    // The dispatcher forwards {action:'start', params}; it never adds a CF workflow name/account.
    expect(mockWorkflowMutate.mock.calls[0][1]).toEqual({ action: 'start', params: { seed: 1 } });
  });

  it('(i) not-provisioned workflow → honest "does not have a workflow yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_start', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/workflow yet/i);
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });
});

// ─── data_workflow_control ─────────────────────────────────────────────────────────

describe('data_workflow_control', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'site-1', instanceId: 'run-1', op: 'pause' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'foreign', instanceId: 'run-1', op: 'terminate', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });

  it('(f) restart WITHOUT confirm → the adapter confirmation_required WARNING is surfaced (nothing runs)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWorkflowMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'workflow-1',
      error: {
        code: 'confirmation_required',
        message:
          'Restarting workflow run "run-1" re-runs it from the beginning — any side effect it already performed (emails, charges, writes) can HAPPEN AGAIN and its prior step outputs are discarded. Re-run with confirm:true to restart.',
        retryable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'site-1', instanceId: 'run-1', op: 'restart' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/confirm:true/i);
    expect(body.result.content[0].text).toMatch(/HAPPEN AGAIN/);
    // The dispatcher forwarded confirm:undefined — the adapter owns the gate.
    expect(mockWorkflowMutate.mock.calls[0][1]).toMatchObject({ action: 'restart', instanceId: 'run-1' });
    expect(mockWorkflowMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(g)(j) terminate WITH confirm → forwards {action,instanceId,confirm} and returns the ACTUAL status', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWorkflowMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'workflow-1',
      data: { action: 'terminate', instanceId: 'run-1', status: 'terminated', workflowName: 'site-generation' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'site-1', instanceId: 'run-1', op: 'terminate', confirm: true } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('terminate');
    expect(payload.status).toBe('terminated');
    expect(payload.status).not.toBe('complete'); // never an optimistic terminal claim
    expect(mockWorkflowMutate.mock.calls[0][1]).toEqual({ action: 'terminate', instanceId: 'run-1', confirm: true });
  });

  it('(h) pause forwards {action:"pause", instanceId} with confirm undefined (reversible, no gate)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedWorkflow);
    mockWorkflowMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'workflow-1',
      data: { action: 'pause', instanceId: 'run-1', status: 'paused', workflowName: 'site-generation' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'site-1', instanceId: 'run-1', op: 'pause' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('pause');
    expect(payload.status).toBe('paused');
    expect(mockWorkflowMutate.mock.calls[0][1]).toMatchObject({ action: 'pause', instanceId: 'run-1' });
    expect(mockWorkflowMutate.mock.calls[0][1].confirm).toBeUndefined();
  });

  it('(b) per_site_workflows flag OFF returns dark error, no mutation', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'site-1', instanceId: 'run-1', op: 'pause' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });

  it('a rejected argument shape (bad op) is surfaced as a JSON-RPC error, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      { name: 'data_workflow_control', arguments: { site_id: 'site-1', instanceId: 'run-1', op: 'delete' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // The Zod `.parse()` throw is caught by the handler → a JSON-RPC error (code -32603); NOT a fabricated op.
    expect(body.result.code).toBe(-32603);
    expect(mockWorkflowMutate).not.toHaveBeenCalled();
  });
});
