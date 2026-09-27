/**
 * TDD tests for the vectorize adapter (Vectorize READ slice).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Vectorize v2
 * REST API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * Per-site isolation for Vectorize is a NAMESPACE (metadata partition) inside ONE shared index, derived
 * SERVER-SIDE from siteId (`site-<first8>`), never caller-supplied (CAPABILITY-MATRIX: namespace ≠ quota).
 *
 * Contracts under test:
 *   (a) list() returns the shared index config + metadata indexes + the site's server-derived namespace
 *   (b) head() maps 200→exists:true (with config + namespace), 404→exists:false, 5xx→retryable error
 *   (c) get() with no ids → describe-only (empty vectors), metadataOnly:true, no get_by_ids fetch
 *   (d) get() with ids → NAMESPACE-SCOPED get_by_ids: sends the site's derived namespace as the filter
 *   (e) NAMESPACE ISOLATION: a foreign-namespace vector in CF's result is NEVER returned; only bytes-free
 *       id+metadata are surfaced (never raw vector values)
 *   (f) get() clamps ids to <= 100 and dedupes
 *   (g) mutate() returns code 'not_implemented' (never throws, never fetches)
 *   (h) site-isolation: every verb only ever hits scope.resourceId's index path (never another index)
 *   (i) the derived namespace matches `site-<first8-of-siteId>`
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { vectorizeAdapter, siteNamespace } from '../adapters/vectorize.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal ResolvedScope for a per-site Vectorize surface — resourceId is the SHARED index NAME. */
const scope: ResolvedScope = {
  siteId: 'site-abc-9999',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'projectsites-rag', // the SHARED index name (server-resolved); namespace derives from siteId
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'site_scoped',
};

/** The namespace the adapter must derive from scope.siteId (`site-` + first 8 chars). */
const NS = 'site-site-abc'; // 'site-abc-9999'.slice(0,8) === 'site-abc'

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

// ─── (i) siteNamespace derivation is deterministic + server-side ─────────────────

describe('siteNamespace()', () => {
  it('(i) derives `site-<first8-of-siteId>` — never a caller value', () => {
    expect(siteNamespace('site-abc-9999')).toBe('site-site-abc');
    expect(siteNamespace('abcdef0123456789')).toBe('site-abcdef01');
    // Two different sites get two different namespaces (isolation is structural).
    expect(siteNamespace('siteA-xxxx')).not.toBe(siteNamespace('siteB-xxxx'));
  });
});

// ─── (g) mutate() always returns not_implemented ────────────────────────────────

describe('vectorizeAdapter.mutate()', () => {
  it('(g) returns not_implemented code — never throws, never fetches', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vectorizeAdapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(h) list() — namespace summary + isolation ───────────────────────────────

describe('vectorizeAdapter.list()', () => {
  it('(a)(h)(i) returns index config + metadata indexes + the site-derived namespace, hits ONLY scope index', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: {
          name: 'projectsites-rag',
          config: { dimensions: 768, metric: 'cosine' },
          metadataIndexes: [
            { propertyName: 'org_id', indexType: 'string' },
            { property_name: 'site_id' },
          ],
        },
      }),
    );
    const result = await vectorizeAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.indexName).toBe('projectsites-rag');
    expect(result.data?.dimensions).toBe(768);
    expect(result.data?.metric).toBe('cosine');
    // Namespace is DERIVED from siteId, not returned by CF.
    expect(result.data?.namespace).toBe(NS);
    // Metadata indexes normalized from both key shapes.
    expect(result.data?.metadataIndexes.map((m) => m.propertyName)).toEqual(['org_id', 'site_id']);
    // Isolation: the request path contains the scope's index name and no other.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/vectorize/v2/indexes/${scope.resourceId}`);
    // No fabricated vector count.
    expect((result.data as Record<string, unknown>)?.vectorCount).toBeUndefined();
  });

  it('maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await vectorizeAdapter.list(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── (b) head() — existence + drift semantics ────────────────────────────────────

describe('vectorizeAdapter.head()', () => {
  it('(b)(i) 200 → exists:true with config + derived namespace', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: { name: 'projectsites-rag', config: { dimensions: 768, metric: 'cosine' } },
      }),
    );
    const result = await vectorizeAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.indexName).toBe('projectsites-rag');
    expect(result.data?.namespace).toBe(NS);
    expect(result.data?.dimensions).toBe(768);
    expect(result.data?.metric).toBe('cosine');
  });

  it('(b) 404 → exists:false (drift signal), ok:true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await vectorizeAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
    // Namespace is still echoed even when the index is gone.
    expect(result.data?.namespace).toBe(NS);
  });

  it('(b) 5xx → retryable error (NOT interpreted as gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { success: false }));
    const result = await vectorizeAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(b) 403 → retryable auth error (transient, not gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { success: false }));
    const result = await vectorizeAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_unauthorized');
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (c)(d)(e)(f)(h) get() — describe, namespace-scoped fetch, isolation, clamp ────

describe('vectorizeAdapter.get()', () => {
  it('(c) with no ids → describe-only (empty vectors), metadataOnly, no get_by_ids fetch', async () => {
    // Only the index describe GET fires; NO get_by_ids POST.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: { config: { dimensions: 768, metric: 'cosine' } } }),
    );
    const result = await vectorizeAdapter.get(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.metadataOnly).toBe(true);
    expect(result.data?.vectors).toHaveLength(0);
    expect(result.data?.namespace).toBe(NS);
    expect(result.data?.dimensions).toBe(768);
    // Exactly one fetch (the describe) — no get_by_ids.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('(d)(h) with ids → NAMESPACE-SCOPED get_by_ids sends the site namespace + targets scope index', async () => {
    // 1st fetch: index describe. 2nd fetch: get_by_ids POST.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, result: { config: { dimensions: 768, metric: 'cosine' } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          result: [{ id: 'v1', namespace: NS, metadata: { title: 'Home' } }],
        }),
      );
    const result = await vectorizeAdapter.get(scope, { ids: ['v1'] });
    expect(result.ok).toBe(true);
    expect(result.data?.vectors).toHaveLength(1);
    expect(result.data?.vectors[0].id).toBe('v1');
    expect(result.data?.vectors[0].metadata).toEqual({ title: 'Home' });
    // The get_by_ids POST body carries the DERIVED namespace as the isolation filter + the ids.
    const postCall = fetchMock.mock.calls[1];
    const url = new URL(postCall[0] as string);
    expect(url.pathname).toContain(`/vectorize/v2/indexes/${scope.resourceId}/get_by_ids`);
    expect(postCall[1]?.method).toBe('POST');
    const body = JSON.parse(postCall[1]?.body as string);
    expect(body.namespace).toBe(NS);
    expect(body.ids).toEqual(['v1']);
  });

  it('(e) NAMESPACE ISOLATION: a foreign-namespace vector in the result is NEVER returned; no raw values', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, result: { config: { dimensions: 768 } } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          result: [
            { id: 'mine', namespace: NS, metadata: { ok: true }, values: [0.1, 0.2] },
            // A vector from ANOTHER site's namespace must be dropped even if CF returns it.
            { id: 'foreign', namespace: 'site-otherxx', metadata: { secret: true } },
          ],
        }),
      );
    const result = await vectorizeAdapter.get(scope, { ids: ['mine', 'foreign'] });
    expect(result.ok).toBe(true);
    // Only the same-namespace vector survives.
    expect(result.data?.vectors.map((v) => v.id)).toEqual(['mine']);
    // Raw vector `values` are NEVER surfaced (metadata only).
    expect((result.data?.vectors[0] as Record<string, unknown>).values).toBeUndefined();
    expect(result.data?.metadataOnly).toBe(true);
  });

  it('(f) clamps ids to <= 100 and dedupes before the get_by_ids call', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, result: { config: {} } }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, result: [] }));
    const many = Array.from({ length: 250 }, (_v, i) => `id-${i}`).concat(['id-0', 'id-1']); // dupes at end
    await vectorizeAdapter.get(scope, { ids: many });
    const body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(body.ids.length).toBe(100);
    // Deduped: no repeats.
    expect(new Set(body.ids).size).toBe(100);
  });

  it('describe failure (5xx) → retryable error, never a fabricated describe', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await vectorizeAdapter.get(scope, { ids: ['v1'] });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    // get_by_ids must NOT be attempted after a failed describe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
