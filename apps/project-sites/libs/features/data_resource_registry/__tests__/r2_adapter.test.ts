/**
 * TDD tests for the r2 adapter (Phase 3 R2 READ slice).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF R2
 * REST API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   (a) list() returns honest pagination — truncated + cursor, NO fabricated total
 *   (b) list() clamps limit to [1, 1000] (passed to the CF `per_page` query param)
 *   (c) list() forwards prefix + cursor to the CF request
 *   (d) get() returns found:false on a 404 (honest miss), never an error
 *   (e) get() rejects an empty key → code 'invalid_key' (no fetch)
 *   (f) get() returns METADATA ONLY (size/etag/contentType + custom) — never object bytes, metadataOnly:true
 *   (g) head() maps 200→exists:true, 404→exists:false, 5xx→retryable error
 *   (h) mutate() returns code 'not_implemented' (never throws, never fetches)
 *   (i) site-isolation: the adapter only ever hits scope.resourceId's bucket path
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { r2Adapter } from '../adapters/r2.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal ResolvedScope for a per-site R2 bucket (R2 identity is the NAME, not a uuid). */
const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'ps-site-abc-123', // the site's own R2 bucket name
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

describe('r2Adapter.mutate()', () => {
  it('(h) returns not_implemented code — never throws, never fetches', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await r2Adapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(b)(c)(i) list() — pagination honesty, clamping, prefix/cursor, isolation ─

describe('r2Adapter.list()', () => {
  it('(a) returns honest pagination — truncated + cursor, no total field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: [
          { key: 'a.txt', size: 10, etag: 'e1', uploaded: '2026-01-01T00:00:00Z' },
          { key: 'b.png', size: 2048 },
        ],
        result_info: { cursor: 'NEXTPAGE', is_truncated: true },
      }),
    );
    const result = await r2Adapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.objects.map((o) => o.key)).toEqual(['a.txt', 'b.png']);
    expect(result.data?.objects[0].size).toBe(10);
    expect(result.data?.truncated).toBe(true);
    expect(result.data?.cursor).toBe('NEXTPAGE');
    // Honest completeness — NO invented total.
    expect((result.data as Record<string, unknown>)?.total).toBeUndefined();
  });

  it('(a) empty bucket → empty objects, truncated false, cursor undefined', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: [], result_info: { is_truncated: false } }),
    );
    const result = await r2Adapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.objects).toHaveLength(0);
    expect(result.data?.truncated).toBe(false);
    expect(result.data?.cursor).toBeUndefined();
  });

  it('(a) is_truncated true but empty cursor → not truncated (honest last page)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: [{ key: 'x', size: 1 }], result_info: { is_truncated: true, cursor: '' } }),
    );
    const result = await r2Adapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.truncated).toBe(false);
    expect(result.data?.cursor).toBeUndefined();
  });

  it('(b) clamps limit=99999 to 1000 in the CF per_page query param', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [], result_info: {} }));
    await r2Adapter.list(scope, { limit: 99999 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('per_page')).toBe('1000');
  });

  it('(b) clamps limit=0 to 1', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [], result_info: {} }));
    await r2Adapter.list(scope, { limit: 0 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('per_page')).toBe('1');
  });

  it('(c)(i) forwards prefix + cursor AND targets ONLY scope.resourceId bucket', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: [], result_info: {} }));
    await r2Adapter.list(scope, { prefix: 'uploads/', cursor: 'CUR' });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('prefix')).toBe('uploads/');
    expect(url.searchParams.get('cursor')).toBe('CUR');
    // Isolation: the path contains the scope's bucket name and no other.
    expect(url.pathname).toContain(`/r2/buckets/${scope.resourceId}/objects`);
  });

  it('maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false, errors: [{ code: 1 }] }));
    const result = await r2Adapter.list(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── (d)(e)(f)(i) get() — honest miss, invalid key, metadata-only, isolation ──────

describe('r2Adapter.get()', () => {
  it('(e) rejects an empty key → code invalid_key, no fetch', async () => {
    const result = await r2Adapter.get(scope, { key: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) returns found:false on a 404 (honest miss), NOT an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await r2Adapter.get(scope, { key: 'missing.txt' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(false);
    expect(result.data?.metadataOnly).toBe(true);
    expect(result.data?.size).toBeUndefined();
  });

  it('(f)(i) returns METADATA ONLY (size/etag/contentType/custom) AND targets scope.resourceId — never bytes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: {
          key: 'photo.jpg',
          size: 4096,
          etag: 'abc123',
          uploaded: '2026-02-02T00:00:00Z',
          http_metadata: { contentType: 'image/jpeg' },
          custom_metadata: { owner: 'me' },
        },
      }),
    );
    const result = await r2Adapter.get(scope, { key: 'photo.jpg' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(true);
    expect(result.data?.metadataOnly).toBe(true);
    expect(result.data?.size).toBe(4096);
    expect(result.data?.etag).toBe('abc123');
    expect(result.data?.contentType).toBe('image/jpeg');
    expect(result.data?.customMetadata).toEqual({ owner: 'me' });
    // No raw bytes field is ever returned.
    expect((result.data as Record<string, unknown>)?.value).toBeUndefined();
    expect((result.data as Record<string, unknown>)?.body).toBeUndefined();
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/r2/buckets/${scope.resourceId}/objects/photo.jpg`);
  });

  it('URL-encodes the key in the request path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { key: 'a/b c', size: 1 } }));
    await r2Adapter.get(scope, { key: 'a/b c' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/objects/a%2Fb%20c');
  });

  it('maps a 5xx object metadata get to a retryable error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await r2Adapter.get(scope, { key: 'k' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (g) head() — existence + drift semantics ───────────────────────────────────

describe('r2Adapter.head()', () => {
  it('(g) 200 → exists:true with createdAt', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: { name: scope.resourceId, creation_date: '2026-01-01T00:00:00Z', location: 'wnam' },
      }),
    );
    const result = await r2Adapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(result.data?.bucketName).toBe(scope.resourceId);
  });

  it('(g) 404 → exists:false (drift signal), ok:true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await r2Adapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
  });

  it('(g) 5xx → retryable error (NOT interpreted as gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { success: false }));
    const result = await r2Adapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(g) 403 → retryable auth error (transient, not gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { success: false }));
    const result = await r2Adapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_unauthorized');
    expect(result.error?.retryable).toBe(true);
  });
});
