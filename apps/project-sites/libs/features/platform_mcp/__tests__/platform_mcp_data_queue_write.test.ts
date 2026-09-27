/**
 * TDD tests for the Queues WRITE-slice MCP tool:
 *   data_queue_send — PRODUCE one or more messages onto the site's OWN resolved queue (producer-only)
 *
 * Same pattern as platform_mcp_data_workflow_write.test.ts: no real CF/D1, all external deps mocked, global
 * jest convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) requires the 'data:write' scope — a data:read-only token gets a scope error, no mutation
 *   (b) per_site_queues flag OFF → isError + dark-mode message, no mutation
 *   (c) tools/list advertises data_queue_send requiring data:write
 *   (d) foreign site (org mismatch) → isError + 'Site not found.' (no leak, no mutation)
 *   (e) send forwards {action:'send', messages, confirm?} and returns { accepted, queueId }; caller names no CF id
 *   (f) ISOLATION — the caller supplies only site_id + messages; the queue is server-resolved (never a CF queue id)
 *   (g) not-provisioned / not-enabled queue → honest 'not available / does not have a queue' (never a fake send)
 *   (h) a rejected argument shape (empty messages) → JSON-RPC error, no mutation
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

const mockQueueMutate = jest.fn();
jest.mock('../../data_resource_registry/adapters/queue.js', () => ({
  queueAdapter: {
    list: jest.fn(),
    head: jest.fn(),
    get: jest.fn(),
    mutate: (...a: unknown[]) => mockQueueMutate(...a),
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

/** A resolved Queue scope the registry resolver returns for an OWNED, provisioned site (resourceId = queue id). */
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
  mockResolveResourceRef.mockReset();
  mockQueueMutate.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Queue write tool catalog', () => {
  it('(c) tools/list includes data_queue_send requiring data:write', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const tools: Array<{ name: string }> = body.result.tools;
    expect(tools.map((t) => t.name)).toContain('data_queue_send');
  });
});

// ─── data_queue_send ───────────────────────────────────────────────────────────────

describe('data_queue_send', () => {
  it('(a) requires data:write scope — a data:read-only token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadOnlyToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'site-1', messages: ['hi'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
    expect(mockQueueMutate).not.toHaveBeenCalled();
  });

  it('(b) per_site_queues flag OFF returns dark error, no mutation', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) => Promise.resolve(key === 'mcp_server'));
    mockVerify.mockResolvedValue(dataWriteToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'site-1', messages: ['hi'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
    expect(mockQueueMutate).not.toHaveBeenCalled();
  });

  it('(d) foreign site (org mismatch) returns "Site not found." — no leak, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'foreign', messages: ['hi'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockQueueMutate).not.toHaveBeenCalled();
  });

  it('(e)(f) send forwards {action:"send", messages, confirm?} and returns { accepted, queueId }; caller names no CF id', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedQueue);
    mockQueueMutate.mockResolvedValueOnce({
      ok: true,
      correlationId: 'queue-1',
      data: { action: 'send', accepted: 2, queueId: 'q-11112222' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'site-1', messages: ['a', 'b'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.action).toBe('send');
    expect(payload.accepted).toBe(2);
    expect(payload.queueId).toBe('q-11112222');
    // The dispatcher forwards {action:'send', messages, confirm}; it never adds a CF queue id/account.
    const forwarded = mockQueueMutate.mock.calls[0][1];
    expect(forwarded.action).toBe('send');
    expect(forwarded.messages).toEqual(['a', 'b']);
    expect(Object.keys(forwarded)).not.toContain('queueId');
    expect(Object.keys(forwarded)).not.toContain('accountId');
  });

  it('(g) not-provisioned / not-enabled queue → honest "does not have a queue yet", no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    // Queues UNSUPPORTED on this deployment → the resolver returns unsupported_kind → honest scope failure.
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'unsupported_kind' });
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'site-1', messages: ['a'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/queue yet/i);
    expect(mockQueueMutate).not.toHaveBeenCalled();
  });

  it('the adapter honest not_available (Queues disabled) is surfaced as an isError, no fabricated success', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedQueue);
    mockQueueMutate.mockResolvedValueOnce({
      ok: false,
      correlationId: 'queue-1',
      error: { code: 'not_available', message: 'Queues are not enabled on this account — nothing was sent.', retryable: false },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'site-1', messages: ['a'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled|nothing was sent/i);
  });

  it('(h) a rejected argument shape (empty messages) is surfaced as a JSON-RPC error, no mutation', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataWriteToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    const res = await rpc(
      'tools/call',
      { name: 'data_queue_send', arguments: { site_id: 'site-1', messages: [] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    // The Zod `.parse()` throw (min 1 message) is caught by the handler → a JSON-RPC error (code -32603).
    expect(body.result.code).toBe(-32603);
    expect(mockQueueMutate).not.toHaveBeenCalled();
  });
});
