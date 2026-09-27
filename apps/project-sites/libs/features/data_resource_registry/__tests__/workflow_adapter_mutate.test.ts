/**
 * TDD tests for the workflow adapter WRITE slice (Workflows mutations — Data & Resource Platform §6, Backend
 * tab): mutate({action:'start'|'pause'|'resume'|'restart'|'terminate'}).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Workflows REST
 * API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/` from
 * `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   (a) start → POST …/instances (on the resolved workflow), returns the ACTUAL CF id + status, created:true
 *   (b) start honesty — a fresh run's status is CF's (queued/running), NEVER coerced to complete; params in body
 *   (c) pause/resume → PATCH …/instances/{id} { status } with NO confirm required; ACTUAL status returned
 *   (d) restart WITHOUT confirm → confirmation_required, WARNS about side-effect replay, NO fetch
 *   (e) restart WITH confirm → PATCH …/instances/{id} { status:'restart' }; ACTUAL status (not optimistic)
 *   (f) terminate WITHOUT confirm → confirmation_required, WARNS state is discarded, NO fetch
 *   (g) terminate WITH confirm → PATCH { status:'terminate' }; the returned status is CF's, never 'complete'
 *   (h) INSTANCE-ID SITE-BINDING — every instance op URL binds BOTH the resolved workflow name AND the id
 *   (i) missing/empty instanceId on a control op → invalid_id, NO fetch
 *   (j) unknown action → invalid_action, NO fetch
 *   (k) a 5xx on any op maps to a retryable error (never "gone"); supports declares the write verbs
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { workflowAdapter } from '../adapters/workflow.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal ResolvedScope for a per-site Workflow surface — resourceId is the resolved workflow NAME. */
const scope: ResolvedScope = {
  siteId: 'site-abc-9999',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'site-generation', // the workflow NAME (server-resolved from the OWNED site's registry row)
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

// ─── supports + invalid action ───────────────────────────────────────────────────

describe('workflowAdapter.supports', () => {
  it('(k) advertises the five named mutations + mutate verb', () => {
    expect(workflowAdapter.supports.verbs).toContain('mutate');
    expect([...workflowAdapter.supports.mutations]).toEqual([
      'start',
      'pause',
      'resume',
      'restart',
      'terminate',
    ]);
  });
});

describe('workflowAdapter.mutate() — guards', () => {
  it('(j) unknown action → invalid_action, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await workflowAdapter.mutate(scope, { action: 'nope' } as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(i) control op with empty instanceId → invalid_id, no fetch', async () => {
    const result = await workflowAdapter.mutate(scope, { action: 'pause', instanceId: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── start ───────────────────────────────────────────────────────────────────────

describe('workflowAdapter.mutate({action:"start"})', () => {
  it('(a)(b)(h) POSTs to the resolved workflow /instances, returns ACTUAL id+status, created:true, sends params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-new', status: 'queued' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'start', params: { siteId: 'x' } });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('start');
    expect(result.data?.created).toBe(true);
    expect(result.data?.instanceId).toBe('run-new');
    expect(result.data?.status).toBe('queued'); // ACTUAL CF status — never optimistic complete
    expect(result.data?.workflowName).toBe('site-generation');
    // Isolation + method: POST to the scope workflow's /instances (no other workflow).
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(new URL(url as string).pathname).toContain(`/workflows/${scope.resourceId}/instances`);
    expect(new URL(url as string).pathname).not.toContain('/instances/'); // create, not act-on-instance
    // params are forwarded in the body.
    expect(JSON.parse(init.body as string)).toEqual({ params: { siteId: 'x' } });
  });

  it('(b) start with no params sends an empty object body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-2', status: 'running' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'start' });
    expect(result.data?.status).toBe('running');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({});
  });

  it('(b) start whose CF status is unrecognised maps to unknown (never optimistic complete)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-3', status: 'weird' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'start' });
    expect(result.data?.status).toBe('unknown');
  });

  it('(k) start 5xx → retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await workflowAdapter.mutate(scope, { action: 'start' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('start with a 200 but no id → hard error (never a fabricated instance)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: {} }));
    const result = await workflowAdapter.mutate(scope, { action: 'start' });
    expect(result.ok).toBe(false);
  });
});

// ─── pause / resume — reversible, no confirm ───────────────────────────────────────

describe('workflowAdapter.mutate() — pause/resume (reversible, no confirm)', () => {
  it('(c)(h) pause → PATCH …/instances/{id} { status:"pause" }, binds workflow+id, ACTUAL status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-1', status: 'paused' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'pause', instanceId: 'run-1' });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('pause');
    expect(result.data?.status).toBe('paused');
    expect(result.data?.created).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(new URL(url as string).pathname).toContain(`/workflows/${scope.resourceId}/instances/run-1`);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'pause' });
  });

  it('(c) resume → PATCH { status:"resume" }, no confirm required', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-1', status: 'running' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'resume', instanceId: 'run-1' });
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('running');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ status: 'resume' });
  });
});

// ─── restart — state-changing, side-effect replay, confirm-gated ───────────────────

describe('workflowAdapter.mutate({action:"restart"})', () => {
  it('(d) WITHOUT confirm → confirmation_required, WARNS about side-effect replay, NO fetch', async () => {
    const result = await workflowAdapter.mutate(scope, { action: 'restart', instanceId: 'run-1' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/HAPPEN AGAIN|re-runs it from the beginning/i);
    expect(result.error?.message).toMatch(/confirm:true/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e) WITH confirm → PATCH { status:"restart" }; ACTUAL CF status, never optimistic complete', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-1', status: 'queued' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'restart', instanceId: 'run-1', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('restart');
    expect(result.data?.status).toBe('queued'); // NOT coerced to complete
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(new URL(url as string).pathname).toContain(`/workflows/${scope.resourceId}/instances/run-1`);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'restart' });
  });
});

// ─── terminate — destructive, irreversible, confirm-gated ──────────────────────────

describe('workflowAdapter.mutate({action:"terminate"})', () => {
  it('(f) WITHOUT confirm → confirmation_required, WARNS state is discarded, NO fetch', async () => {
    const result = await workflowAdapter.mutate(scope, { action: 'terminate', instanceId: 'run-1' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/discard|irreversible|cannot be resumed/i);
    expect(result.error?.message).toMatch(/confirm:true/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(g)(h) WITH confirm → PATCH { status:"terminate" }; returns CF status, never a claimed complete', async () => {
    // CF may report the instance as still-terminating; the adapter surfaces exactly that, not 'complete'.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { id: 'run-1', status: 'terminated' } }));
    const result = await workflowAdapter.mutate(scope, { action: 'terminate', instanceId: 'run-1', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('terminate');
    expect(result.data?.status).toBe('terminated');
    expect(result.data?.status).not.toBe('complete');
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url as string).pathname).toContain(`/workflows/${scope.resourceId}/instances/run-1`);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'terminate' });
  });

  it('(k) terminate 5xx (with confirm) → retryable error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await workflowAdapter.mutate(scope, { action: 'terminate', instanceId: 'run-1', confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});
