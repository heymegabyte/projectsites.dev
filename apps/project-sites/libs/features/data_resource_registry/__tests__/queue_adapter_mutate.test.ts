/**
 * TDD tests for the queue adapter WRITE slice (Queues mutation — Data & Resource Platform §8, Backend tab):
 * mutate({action:'send', messages, confirm?}).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Queues REST
 * API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/` from
 * `libs/features/data_resource_registry/__tests__/`).
 *
 * ⛔ THE LOAD-BEARING CONTRACT OF THIS WRITE SLICE:
 *  - `send` is PRODUCER-ONLY + NON-DESTRUCTIVE (it appends) → NO confirm required (optional confirm honored).
 *  - It is NOT peek/pull/ack/purge — those are SEPARATE guarded/leasing ops (a later pass): supports.mutations
 *    is EXACTLY ['send'].
 *  - ISOLATION: every send addresses ONLY `scope.resourceId` (the server-resolved queue id) — a site can NEVER
 *    send to another site's queue (the adapter accepts no queue id).
 *  - HONESTY: when Queues are not enabled (no QUEUE binding — the reality today) CF 404s the queue → the adapter
 *    returns an honest `not_available` and sends NOTHING, never a fabricated success.
 *
 * Contracts under test:
 *   (a) supports advertises exactly the 'send' mutation + the mutate verb
 *   (b) send → POST …/queues/{id}/messages/batch with { messages:[{body}] }; accepted = count; NO confirm needed
 *   (c) send WITH confirm still sends (confirm is accepted but never required for a producer append)
 *   (d) unknown action → invalid_action, NO fetch
 *   (e) empty/non-array messages → invalid_messages, NO fetch
 *   (f) a non-string / empty-string message body → invalid_messages, NO fetch
 *   (g) an oversize single message → message_too_large, NO fetch
 *   (h) a batch over the total byte budget → batch_too_large, NO fetch
 *   (i) a 404 from CF (Queues not enabled / queue gone) → honest not_available, nothing sent, NOT a fake success
 *   (j) a 5xx → retryable error (never "gone")
 *   (k) ISOLATION — the POST path is the scope's queue id, never another queue
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { queueAdapter } from '../adapters/queue.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The resolved queue id this site owns (server-resolved from the registry row). */
const QUEUE_ID = 'q-11112222';

/** A minimal ResolvedScope for a per-site Queue surface — resourceId is the resolved queue id. */
const scope: ResolvedScope = {
  siteId: 'site-abc-9999',
  orgId: 'org-1',
  environment: 'production',
  resourceId: QUEUE_ID,
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'read_only',
};

/** Build a fake Response with a JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── supports ──────────────────────────────────────────────────────────────────

describe('queueAdapter.supports', () => {
  it('(a) advertises exactly the send mutation + the mutate verb', () => {
    expect(queueAdapter.supports.verbs).toContain('mutate');
    expect([...queueAdapter.supports.mutations]).toEqual(['send']);
  });
});

// ─── guards (no network) ─────────────────────────────────────────────────────────

describe('queueAdapter.mutate() — guards (no fetch)', () => {
  it('(d) unknown action → invalid_action, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await queueAdapter.mutate(scope, { action: 'purge' } as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e) empty messages array → invalid_messages, no fetch', async () => {
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: [] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_messages');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(f) a non-string / empty-string body → invalid_messages, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonString = await queueAdapter.mutate(scope, { action: 'send', messages: [123 as any] });
    expect(nonString.ok).toBe(false);
    expect(nonString.error?.code).toBe('invalid_messages');
    const empty = await queueAdapter.mutate(scope, { action: 'send', messages: [''] });
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe('invalid_messages');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(g) an oversize single message → message_too_large, no fetch', async () => {
    const huge = 'x'.repeat(128 * 1024 + 1);
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: [huge] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('message_too_large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(h) a batch over the total byte budget → batch_too_large, no fetch', async () => {
    // Each ~120KB (under the per-message cap) but 3× exceeds the 256KB batch budget.
    const chunk = 'y'.repeat(120 * 1024);
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: [chunk, chunk, chunk] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('batch_too_large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('over 100 messages → invalid_messages, no fetch', async () => {
    const many = Array.from({ length: 101 }, (_v, i) => `m${i}`);
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: many });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_messages');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── send (producer-only, no confirm) ─────────────────────────────────────────────

describe('queueAdapter.mutate({action:"send"})', () => {
  it('(b)(k) POSTs to the resolved queue /messages/batch with {messages:[{body}]}, accepted=count, NO confirm needed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: {} }));
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: ['a', 'b'] });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('send');
    expect(result.data?.accepted).toBe(2);
    expect(result.data?.queueId).toBe(QUEUE_ID);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    // ⛔ Producer path is the queue-by-id /messages/batch — never a /pull, /ack, or history path.
    expect(new URL(url as string).pathname).toContain(`/queues/${QUEUE_ID}/messages/batch`);
    expect(new URL(url as string).pathname).not.toContain('/pull');
    expect(new URL(url as string).pathname).not.toContain('/ack');
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ body: 'a' }, { body: 'b' }] });
  });

  it('(c) send WITH confirm still sends (confirm is accepted but not required for a producer append)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: {} }));
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: ['only'], confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('(i) a 404 (Queues not enabled / queue gone) → honest not_available, NOTHING fabricated', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: ['a'] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_available');
    expect(result.data).toBeUndefined(); // no fabricated accepted count
  });

  it('(j) a 5xx → retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: ['a'] });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('a network throw → retryable cf_request_failed (never "gone")', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const result = await queueAdapter.mutate(scope, { action: 'send', messages: ['a'] });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});
