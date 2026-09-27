/**
 * TDD tests for the queue adapter (Queues READ slice — Data & Resource Platform §8, Backend tab).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Queues REST
 * API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/`
 * from `libs/features/data_resource_registry/__tests__/`).
 *
 * ⛔ THE LOAD-BEARING HONESTY OF THIS SLICE:
 *  - Queues are UNSUPPORTED on this deployment (NO `QUEUE` binding); the resolver returns unsupported_kind
 *    UPSTREAM, so a blank site never reaches this adapter. When it IS reached (Queues later enabled + a queue
 *    provisioned) it surfaces CONFIG + METRICS only.
 *  - peek ≠ history (HARD FACT #1): `get`/`list` NEVER return a message body or a "history" —
 *    `messageHistoryAvailable` is ALWAYS false; only config + backlog METRICS.
 *  - pull = leases + ack (HARD FACT #2): `pullLeasesAndNeedsAck` is ALWAYS true; this read pass never leases.
 *  - Isolation: every verb addresses ONLY `scope.resourceId` (the server-resolved queue id) — a caller can
 *    never peek/ack/purge another site's messages.
 *
 * Contracts under test:
 *   (a) list() surfaces the ONE resolved queue's config + metrics; pullLeasesAndNeedsAck ALWAYS true
 *   (b) list()/get() hit ONLY the queue-by-id path (never a /messages, /pull, or history path)
 *   (c) list() maps a 5xx to a retryable error (never "gone")
 *   (d) list() a 404 (queue our row claims is gone) → honest empty list + count 0 (drift, never fabricated)
 *   (e) head() queue present → exists:true with name/paused; absent (404) → exists:false (drift)
 *   (f) head() 5xx/403 → retryable error (NOT interpreted as gone)
 *   (g) get() → config + metrics; messageHistoryAvailable ALWAYS false; a 404 → found:false (honest miss)
 *   (h) ⛔ get() returns NO message body / history — the envelope carries config + metrics ONLY
 *   (i) get() only ever addresses scope.resourceId — a mismatching input.id can NOT widen to another queue
 *   (j) mutate() returns code 'not_implemented' (never throws, never fetches) — send/peek/pull-ack are later
 *   (k) site-isolation: the request path is the scope's queue id, never another queue
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

/** A raw CF queue GET body (config + metrics only — NEVER a message body). */
function rawQueueBody() {
  return {
    success: true,
    result: {
      queue_id: QUEUE_ID,
      queue_name: 'site-jobs',
      paused: false,
      created_on: '2026-01-01T00:00:00Z',
      modified_on: '2026-02-01T00:00:00Z',
      consumers: [
        {
          type: 'worker',
          script_name: 'site-consumer',
          dead_letter_queue: 'site-jobs-dlq',
          settings: { batch_size: 10, max_retries: 3, visibility_timeout_ms: 30000 },
        },
      ],
      backlog: { messages: 42, bytes: 8400, oldest_message_age_seconds: 120 },
    },
  };
}

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

// ─── (j) mutate() always returns not_implemented ────────────────────────────────

describe('queueAdapter.mutate()', () => {
  it('(j) returns not_implemented code — never throws, never fetches (send/peek/pull-ack are the write pass)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await queueAdapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(b)(c)(d)(k) list() — config + metrics only, never messages ───────────────

describe('queueAdapter.list()', () => {
  it('(a)(b)(k) surfaces the resolved queue config + metrics; pullLeasesAndNeedsAck true; hits queue-by-id path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, rawQueueBody()));
    const result = await queueAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(1);
    expect(result.data?.available).toBe(true);
    expect(result.data?.queues).toHaveLength(1);
    expect(result.data?.queues[0].id).toBe(QUEUE_ID);
    expect(result.data?.queues[0].name).toBe('site-jobs');
    expect(result.data?.queues[0].paused).toBe(false);
    // Consumer delivery/retry settings + DLQ surface (config only).
    expect(result.data?.queues[0].consumers[0].deadLetterQueue).toBe('site-jobs-dlq');
    expect(result.data?.queues[0].consumers[0].maxRetries).toBe(3);
    expect(result.data?.queues[0].consumers[0].batchSize).toBe(10);
    // Backlog METRICS surface (never a message body).
    expect(result.data?.queues[0].metrics?.backlogMessages).toBe(42);
    expect(result.data?.queues[0].metrics?.oldestMessageAgeSeconds).toBe(120);
    // Honest: the pull consumer LEASES + needs ack — permanently declared.
    expect(result.data?.pullLeasesAndNeedsAck).toBe(true);
    // Isolation: the request path is the scope's queue id — NEVER a /messages, /pull, or history path.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/queues/${QUEUE_ID}`);
    expect(url.pathname).not.toContain('/messages');
    expect(url.pathname).not.toContain('/pull');
    expect(url.pathname).not.toContain('/history');
  });

  it('(d) a 404 (queue our row claims is gone) → honest empty list + count 0 (drift, never fabricated)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await queueAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(0);
    expect(result.data?.queues).toEqual([]);
    expect(result.data?.pullLeasesAndNeedsAck).toBe(true);
  });

  it('(c) maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await queueAdapter.list(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── (e)(f)(k) head() — existence + drift semantics ───────────────────────────────

describe('queueAdapter.head()', () => {
  it('(e) queue present → exists:true with name/paused; available true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, rawQueueBody()));
    const result = await queueAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.queueId).toBe(QUEUE_ID);
    expect(result.data?.name).toBe('site-jobs');
    expect(result.data?.paused).toBe(false);
  });

  it('(e)(k) queue absent (404) → exists:false (drift signal), ok:true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await queueAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
    expect(result.data?.queueId).toBe(QUEUE_ID);
  });

  it('(f) 5xx → retryable error (NOT interpreted as gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { success: false }));
    const result = await queueAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(f) 403 → retryable auth error (transient, not gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { success: false }));
    const result = await queueAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_unauthorized');
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (g)(h)(i)(k) get() — config + metrics ONLY, never a message body / history ─────

describe('queueAdapter.get()', () => {
  it('(g)(k) → config + metrics; messageHistoryAvailable false; addresses only the scope queue id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, rawQueueBody()));
    const result = await queueAdapter.get(scope, {});
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.queueId).toBe(QUEUE_ID);
    expect(result.data?.queue?.name).toBe('site-jobs');
    expect(result.data?.queue?.metrics?.backlogMessages).toBe(42);
    // ⛔ Queues has NO message-history API — permanently declared.
    expect(result.data?.messageHistoryAvailable).toBe(false);
    // Isolation: only the scope's queue id is addressed.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/queues/${QUEUE_ID}`);
  });

  it('(g) a 404 → found:false (honest miss, not an error); messageHistoryAvailable false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await queueAdapter.get(scope, {});
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(false);
    expect(result.data?.messageHistoryAvailable).toBe(false);
    expect(result.data?.queueId).toBe(QUEUE_ID);
  });

  it('(i) a mismatching input.id can NOT widen to another queue — only scope.resourceId is addressed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, rawQueueBody()));
    // Caller passes a DIFFERENT queue id as an echo — it must be IGNORED for addressing.
    const result = await queueAdapter.get(scope, { id: 'someone-elses-queue' });
    expect(result.ok).toBe(true);
    expect(result.data?.queueId).toBe(QUEUE_ID);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/queues/${QUEUE_ID}`);
    // The foreign id never touched the request path.
    expect(url.pathname).not.toContain('someone-elses-queue');
  });

  it('(h) ⛔ returns NO message body / history — config + metrics ONLY', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, rawQueueBody()));
    const result = await queueAdapter.get(scope, {});
    expect(result.ok).toBe(true);
    const data = (result.data ?? {}) as Record<string, unknown>;
    expect(data.messageHistoryAvailable).toBe(false);
    // No message-bearing key leaked into the envelope.
    for (const forbidden of ['messages', 'message', 'body', 'payload', 'history', 'contents']) {
      expect(data[forbidden]).toBeUndefined();
    }
    const text = JSON.stringify(result.data);
    expect(text).not.toMatch(/"messages"\s*:\s*\[/);
    expect(text).not.toMatch(/"history"\s*:/);
    // The queue payload carries config + metrics only — never a message list.
    const queue = (data.queue ?? {}) as Record<string, unknown>;
    expect(queue.messages).toBeUndefined();
    expect(queue.body).toBeUndefined();
  });
});
