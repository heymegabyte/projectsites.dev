/**
 * TDD tests for the kv adapter (Phase 3 KV READ slice).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF KV
 * REST API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   (a) list() returns honest pagination — listComplete + cursor, NO fabricated total
 *   (b) list() clamps limit to [1, 1000] (passed to the CF `limit` query param)
 *   (c) list() forwards prefix + cursor to the CF request
 *   (d) get() returns found:false on a 404 (eventual-consistency miss), never an error
 *   (e) get() rejects an empty key → code 'invalid_key' (no fetch)
 *   (f) get() returns the value + parsed metadata header on 200
 *   (g) head() maps 200→exists:true, 404→exists:false, 5xx→retryable error
 *   (h) mutate() returns code 'not_implemented' (never throws, never fetches)
 *   (i) site-isolation: the adapter only ever hits scope.resourceId's namespace path
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { kvAdapter } from '../adapters/kv.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal ResolvedScope for a per-site KV namespace. */
const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'kvns-00000000000000000000000000000001', // the site's own KV namespace id
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'site_scoped',
};

/** Build a fake Response with a JSON body + optional headers. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
/** Build a fake Response with a raw text body (for value get). */
function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
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

// ─── (h) mutate() always returns not_implemented ────────────────────────────────

describe('kvAdapter.mutate()', () => {
  it('(h) returns not_implemented code — never throws, never fetches', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await kvAdapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(b)(c)(i) list() — pagination honesty, clamping, prefix/cursor, isolation ─

describe('kvAdapter.list()', () => {
  it('(a) returns honest pagination — listComplete + cursor, no total field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: [
          { name: 'a', expiration: 123 },
          { name: 'b', metadata: { x: 1 } },
        ],
        result_info: { cursor: 'NEXTPAGE' },
      }),
    );
    const result = await kvAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.keys.map((k) => k.name)).toEqual(['a', 'b']);
    expect(result.data?.listComplete).toBe(false);
    expect(result.data?.cursor).toBe('NEXTPAGE');
    // Honest completeness — NO invented total.
    expect((result.data as Record<string, unknown>)?.total).toBeUndefined();
  });

  it('(a) empty namespace → empty keys, listComplete true, cursor undefined', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: [], result_info: { cursor: '' } }),
    );
    const result = await kvAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.keys).toHaveLength(0);
    expect(result.data?.listComplete).toBe(true);
    expect(result.data?.cursor).toBeUndefined();
  });

  it('(b) clamps limit=99999 to 1000 in the CF query param', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [], result_info: {} }));
    await kvAdapter.list(scope, { limit: 99999 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('limit')).toBe('1000');
  });

  it('(b) clamps limit=0 to 1', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [], result_info: {} }));
    await kvAdapter.list(scope, { limit: 0 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it('(c)(i) forwards prefix + cursor AND targets ONLY scope.resourceId namespace', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [], result_info: {} }));
    await kvAdapter.list(scope, { prefix: 'user:', cursor: 'CUR' });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('prefix')).toBe('user:');
    expect(url.searchParams.get('cursor')).toBe('CUR');
    // Isolation: the path contains the scope's namespace id and no other.
    expect(url.pathname).toContain(`/storage/kv/namespaces/${scope.resourceId}/keys`);
  });

  it('maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false, errors: [{ code: 1 }] }));
    const result = await kvAdapter.list(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── (d)(e)(f)(i) get() — honest miss, invalid key, value+metadata, isolation ─────

describe('kvAdapter.get()', () => {
  it('(e) rejects an empty key → code invalid_key, no fetch', async () => {
    const result = await kvAdapter.get(scope, { key: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) returns found:false on a 404 (eventual-consistency miss), NOT an error', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(404, 'key not found'));
    const result = await kvAdapter.get(scope, { key: 'missing' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(false);
    expect(result.data?.value).toBeUndefined();
  });

  it('(f)(i) returns the value + parsed metadata header AND targets scope.resourceId', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(200, 'hello-world', { 'x-kv-metadata': JSON.stringify({ owner: 'me' }) }),
    );
    const result = await kvAdapter.get(scope, { key: 'greeting' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(true);
    expect(result.data?.value).toBe('hello-world');
    expect(result.data?.metadata).toEqual({ owner: 'me' });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(
      `/storage/kv/namespaces/${scope.resourceId}/values/greeting`,
    );
  });

  it('URL-encodes the key in the request path', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, 'v'));
    await kvAdapter.get(scope, { key: 'a/b c' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/values/a%2Fb%20c');
  });

  it('maps a 5xx value get to a retryable error', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(500, 'boom'));
    const result = await kvAdapter.get(scope, { key: 'k' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (g) head() — existence + drift semantics ───────────────────────────────────

describe('kvAdapter.head()', () => {
  it('(g) 200 → exists:true with title', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: { id: scope.resourceId, title: 'ps-site-1-kv' } }),
    );
    const result = await kvAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.title).toBe('ps-site-1-kv');
    expect(result.data?.namespaceId).toBe(scope.resourceId);
  });

  it('(g) 404 → exists:false (drift signal), ok:true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await kvAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
  });

  it('(g) 5xx → retryable error (NOT interpreted as gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { success: false }));
    const result = await kvAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(g) 403 → retryable auth error (transient, not gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { success: false }));
    const result = await kvAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_unauthorized');
    expect(result.error?.retryable).toBe(true);
  });
});
