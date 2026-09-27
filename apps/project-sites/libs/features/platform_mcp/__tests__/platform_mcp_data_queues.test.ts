/**
 * TDD tests for the two Queues-slice MCP tools:
 *   data_queues_list   — list the site's Queue(s) config + metrics — NEVER a message body / history
 *   data_queue_describe — describe ONE queue's config + metrics — NEVER a message body / history
 *
 * Same pattern as platform_mcp_data_durable_objects.test.ts: no real CF/D1, all external deps mocked, global
 * jest convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * ⛔ THE HONESTY GUARANTEE: Queues are UNSUPPORTED on this deployment (no `QUEUE` binding), peek ≠ history,
 * pull = leases + ack — so the tools surface CONFIG + METRICS ONLY (messageHistoryAvailable:false), never a
 * message body, and a caller can never see another site's messages (server-resolved queue only).
 *
 * Contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak); adapter never reached
 *   (b) per_site_queues flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) list returns queues + count + available from the resolved-queue scope (resourceId = queue id)
 *   (f) not-provisioned / unsupported (resolveResourceRef unsupported_kind|not_registered) → honest 'does not have a queue'
 *   (g) describe returns config + metrics; messageHistoryAvailable false; adapter scoped to the resolved queue id
 *   (h) ⛔ describe returns NO message body / history — the payload carries config + metrics only
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

// The other adapters are imported by the service too — stub so nothing real fires.
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
jest.mock('../../data_resource_registry/adapters/workflow.js', () => ({
  workflowAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/durable_object.js', () => ({
  durableObjectAdapter: { list: jest.fn(), get: jest.fn() },
}));

const mockQueueList = jest.fn();
const mockQueueGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/queue.js', () => ({
  queueAdapter: {
    list: (...a: unknown[]) => mockQueueList(...a),
    get: (...a: unknown[]) => mockQueueGet(...a),
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

/** A successful ref resolution to a QUEUE id (the shape resolveResourceRef returns). */
const resolvedQueue = {
  ok: true,
  resourceId: 'q-11112222',
  resourceKind: 'queue',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'read_only',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveRef.mockReset();
  mockQueueList.mockReset();
  mockQueueGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Queues tools catalog', () => {
  it('(c) tools/list includes data_queues_list and data_queue_describe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_queues_list');
    expect(names).toContain('data_queue_describe');
  });
});

// ─── data_queues_list ─────────────────────────────────────────────────────────────

describe('data_queues_list', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_queues_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_queues flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_queues flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_queues_list', arguments: { site_id: 'site-1' } },
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
      { name: 'data_queues_list', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockQueueList).not.toHaveBeenCalled();
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('(f) unsupported/not-provisioned (resolveResourceRef unsupported_kind) → honest "does not have a queue"', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes
    // Queues are unsupported on this deployment — the resolver returns unsupported_kind.
    mockResolveRef.mockResolvedValueOnce({ ok: false, reason: 'unsupported_kind' });
    const res = await rpc(
      'tools/call',
      { name: 'data_queues_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/does not have a queue/i);
    expect(mockQueueList).not.toHaveBeenCalled();
  });

  it('(e) returns queues + count + available; adapter scoped to the resolved queue id (never another queue)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedQueue);
    mockQueueList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'queue-1',
      data: {
        queues: [
          { id: 'q-11112222', name: 'site-jobs', paused: false, consumers: [], metrics: { backlogMessages: 5 } },
        ],
        count: 1,
        available: true,
        pullLeasesAndNeedsAck: true,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_queues_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.available).toBe(true);
    expect(payload.queues[0].name).toBe('site-jobs');
    // Honest: the pull consumer LEASES + needs ack — the tool declares this permanently.
    expect(payload.pullLeasesAndNeedsAck).toBe(true);
    // ⛔ No message body smuggled into the list payload.
    expect(JSON.stringify(payload)).not.toMatch(/"messages"\s*:\s*\[/);
    // The adapter was called with the scope whose resourceId is the RESOLVED queue id (not the site id).
    expect(mockQueueList.mock.calls[0][0].resourceId).toBe('q-11112222');
  });
});

// ─── data_queue_describe ──────────────────────────────────────────────────────────

describe('data_queue_describe', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_describe', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_queues flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_describe', arguments: { site_id: 'site-1' } },
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
      { name: 'data_queue_describe', arguments: { site_id: 'foreign', id: 'q-x' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockQueueGet).not.toHaveBeenCalled();
  });

  it('(g)(h) ⛔ returns config + metrics ONLY — no message body / history; scoped to the resolved queue id', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveRef.mockResolvedValueOnce(resolvedQueue);
    mockQueueGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'queue-2',
      data: {
        queueId: 'q-11112222',
        found: true,
        available: true,
        queue: { id: 'q-11112222', name: 'site-jobs', consumers: [], metrics: { backlogMessages: 5 } },
        messageHistoryAvailable: false,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_describe', arguments: { site_id: 'site-1', id: 'q-11112222' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.queueId).toBe('q-11112222');
    expect(payload.found).toBe(true);
    expect(payload.queue.name).toBe('site-jobs');
    // ⛔ The tool NEVER surfaces a queue's messages / history — permanently declared.
    expect(payload.messageHistoryAvailable).toBe(false);
    // No message/history-bearing key smuggled into the tool payload.
    for (const forbidden of ['messages', 'message', 'body', 'payload', 'history', 'contents']) {
      expect(payload[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(payload)).not.toMatch(/"history"\s*:/);
    // The scope's resourceId is the resolved queue id.
    expect(mockQueueGet.mock.calls[0][0].resourceId).toBe('q-11112222');
  });
});
