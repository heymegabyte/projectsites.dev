/**
 * TDD tests for the workflow adapter (Workflows READ slice — Data & Resource Platform §6, Backend tab).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Workflows
 * REST API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * Workflows are `shared_platform` (code-deployed definitions), NOT per-site — per-site provisioning is NOT
 * wired, so a blank site resolves no `workflow` row upstream (honest empty). The CF instances API is
 * account-level for a workflow name; isolation is enforced by resolving `scope.resourceId` (the workflow
 * name) server-side and binding a `get` to BOTH that name AND the requested instance id.
 *
 * Contracts under test:
 *   (a) list() returns the workflow's run instances (id/status/timestamps) + honest count + cursor
 *   (b) list() maps a 5xx to a retryable error (never "gone"), and clamps limit to <= 100
 *   (c) list() NEVER optimistically coerces status — an unknown CF status maps to 'unknown'
 *   (d) head() maps 200→exists:true (with class/script), 404→exists:false (drift), 5xx/403→retryable error
 *   (e) get() with a real instance → status + SANITIZED steps; status is the ACTUAL CF status (running≠complete)
 *   (f) get() 404 → honest found:false (never an error)
 *   (g) SANITIZE: a step output carrying a secret-shaped key is REDACTED; raw values are never dumped
 *   (h) get() empty/missing id → invalid_id error, no fetch
 *   (i) INSTANCE-ID SITE-SCOPING: get() binds BOTH the resolved workflow name AND the instance id in the URL
 *   (j) mutate() returns code 'not_implemented' (never throws, never fetches)
 *   (k) site-isolation: every verb only ever hits scope.resourceId's workflow path (never another workflow)
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { workflowAdapter, sanitizeStepPayload } from '../adapters/workflow.js';
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

/** Build a fake Response with a JSON body + optional headers. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

// ─── (g) sanitizeStepPayload — the load-bearing secret-safety helper ─────────────

describe('sanitizeStepPayload()', () => {
  it('(g) redacts secret-shaped keys, keeps benign fields', () => {
    const out = sanitizeStepPayload({
      status: 'ok',
      api_key: 'sk-live-DEADBEEF',
      nested: { authorization: 'Bearer xyz', label: 'fine' },
    });
    expect(out).toBeDefined();
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('sk-live-DEADBEEF');
    expect(out).not.toContain('Bearer xyz');
    expect(out).toContain('fine');
  });

  it('(g) truncates an oversized payload + returns undefined for an absent one', () => {
    const big = sanitizeStepPayload({ blob: 'x'.repeat(5000) });
    expect(big && big.length).toBeLessThanOrEqual(2000 + 20);
    expect(big).toContain('[truncated]');
    expect(sanitizeStepPayload(undefined)).toBeUndefined();
    expect(sanitizeStepPayload(null)).toBeUndefined();
  });
});

// ─── (j) mutate() always returns not_implemented ────────────────────────────────

describe('workflowAdapter.mutate()', () => {
  it('(j) returns not_implemented code — never throws, never fetches', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await workflowAdapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(b)(c)(k) list() — run instances + isolation ─────────────────────────────

describe('workflowAdapter.list()', () => {
  it('(a)(k) returns run instances + count + cursor, hits ONLY the scope workflow path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: [
          { id: 'run-1', status: 'complete', created_on: '2026-09-01T00:00:00Z', modified_on: '2026-09-01T00:05:00Z' },
          { id: 'run-2', status: 'running', created_on: '2026-09-02T00:00:00Z' },
        ],
        result_info: { cursor: 'next-page-token' },
      }),
    );
    const result = await workflowAdapter.list(scope, { limit: 25 });
    expect(result.ok).toBe(true);
    expect(result.data?.workflowName).toBe('site-generation');
    expect(result.data?.count).toBe(2);
    expect(result.data?.instances[0].id).toBe('run-1');
    expect(result.data?.instances[0].status).toBe('complete');
    expect(result.data?.instances[1].status).toBe('running');
    expect(result.data?.cursor).toBe('next-page-token');
    // Isolation: the request path contains the scope's workflow name + /instances, and no other workflow.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/workflows/${scope.resourceId}/instances`);
    // No fabricated total.
    expect((result.data as Record<string, unknown>)?.total).toBeUndefined();
  });

  it('(a) empty page → honest count 0 + empty instances (never fabricated)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [] }));
    const result = await workflowAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(0);
    expect(result.data?.instances).toEqual([]);
    expect(result.data?.cursor).toBeUndefined();
  });

  it('(b) clamps per_page to <= 100', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [] }));
    await workflowAdapter.list(scope, { limit: 9999 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('per_page')).toBe('100');
  });

  it('(b) maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await workflowAdapter.list(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(c) an unrecognised CF status maps to unknown (never optimistically complete)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: [{ id: 'run-x', status: 'some-new-state' }] }),
    );
    const result = await workflowAdapter.list(scope);
    expect(result.data?.instances[0].status).toBe('unknown');
  });
});

// ─── (d) head() — definition existence + drift semantics ─────────────────────────

describe('workflowAdapter.head()', () => {
  it('(d) 200 → exists:true with class/script name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: { name: 'site-generation', class_name: 'SiteGeneration', script_name: 'project-sites' },
      }),
    );
    const result = await workflowAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.workflowName).toBe('site-generation');
    expect(result.data?.className).toBe('SiteGeneration');
    expect(result.data?.scriptName).toBe('project-sites');
  });

  it('(d) 404 → exists:false (drift signal), ok:true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await workflowAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
    expect(result.data?.workflowName).toBe('site-generation');
  });

  it('(d) 5xx → retryable error (NOT interpreted as gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { success: false }));
    const result = await workflowAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(d) 403 → retryable auth error (transient, not gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { success: false }));
    const result = await workflowAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_unauthorized');
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (e)(f)(g)(h)(i)(k) get() — one instance, sanitized steps, honesty, isolation ──

describe('workflowAdapter.get()', () => {
  it('(h) empty id → invalid_id error, no fetch', async () => {
    const result = await workflowAdapter.get(scope, { id: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e)(i)(k) real instance → ACTUAL status + steps, URL binds BOTH workflow name AND instance id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: {
          id: 'run-1',
          status: 'running', // in-flight — MUST surface running, never optimistic complete
          created_on: '2026-09-01T00:00:00Z',
          modified_on: '2026-09-01T00:03:00Z',
          steps: [
            { name: 'research', type: 'step', status: 'success', start: '2026-09-01T00:00:00Z', end: '2026-09-01T00:01:00Z', output: { ok: true } },
            { name: 'build', type: 'step', status: 'running', start: '2026-09-01T00:01:00Z' },
          ],
        },
      }),
    );
    const result = await workflowAdapter.get(scope, { id: 'run-1' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(true);
    expect(result.data?.status).toBe('running'); // NOT coerced to complete
    expect(result.data?.instanceId).toBe('run-1');
    expect(result.data?.steps).toHaveLength(2);
    expect(result.data?.steps?.[0].name).toBe('research');
    expect(result.data?.steps?.[0].outputPreview).toContain('ok');
    expect(result.data?.outputSanitized).toBe(true);
    // Isolation: the URL binds BOTH the resolved workflow name AND the instance id.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/workflows/${scope.resourceId}/instances/run-1`);
  });

  it('(f) 404 → honest found:false (never an error)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await workflowAdapter.get(scope, { id: 'nope' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(false);
    expect(result.data?.instanceId).toBe('nope');
    expect(result.data?.outputSanitized).toBe(true);
  });

  it('(g) SANITIZE: a step output carrying a secret is REDACTED; raw values never dumped', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: {
          id: 'run-2',
          status: 'errored',
          steps: [
            {
              name: 'call-api',
              status: 'error',
              output: { api_key: 'sk-live-SECRETSAUCE', note: 'kept' },
              error: { message: 'boom', token: 'tok-LEAKME' },
            },
          ],
        },
      }),
    );
    const result = await workflowAdapter.get(scope, { id: 'run-2' });
    const text = JSON.stringify(result.data);
    expect(result.data?.status).toBe('errored');
    expect(text).not.toContain('sk-live-SECRETSAUCE');
    expect(text).not.toContain('tok-LEAKME');
    expect(text).toContain('[redacted]');
    expect(text).toContain('kept'); // benign field survives
    expect(result.data?.steps?.[0].errorPreview).toContain('boom');
  });

  it('(k) 5xx → retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await workflowAdapter.get(scope, { id: 'run-1' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});
