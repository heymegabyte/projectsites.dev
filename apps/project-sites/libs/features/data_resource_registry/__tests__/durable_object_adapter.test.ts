/**
 * TDD tests for the durable_object adapter (Durable Objects READ slice — Data & Resource Platform §7,
 * Backend tab).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Durable
 * Objects management REST API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders`
 * (4× ../ reaches `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * ⛔ THE LOAD-BEARING HONESTY OF THIS SLICE: CF has NO API to enumerate DO INSTANCES or read arbitrary
 * instance storage — a structural fact, not a missing feature. So `list` lists NAMESPACES (classes), `get`
 * returns identity METADATA of a NAMED object id (never its state), and `mutate` exposes a NARROW closed
 * management allowlist (never an arbitrary method into customer code) — full coverage in the mutate suite.
 * Only `SITE_BUILDER` is bound; there is no per-site DO namespace, so a blank site resolves no
 * `durable_object` row upstream (honest empty). The account namespaces API is account-level; isolation is
 * enforced by resolving `scope.resourceId` (the namespace id) server-side and surfacing ONLY the matching
 * namespace.
 *
 * Contracts under test:
 *   (a) list() lists NAMESPACES filtered to the resolved namespace id; instancesEnumerable is ALWAYS false
 *   (b) list() with NO matching namespace → honest empty list + count 0 (never a fabricated instance)
 *   (c) list() maps a 5xx to a retryable error (never "gone")
 *   (d) list() hits ONLY the account durable_objects/namespaces path (never an instance/state path)
 *   (e) head() namespace present → exists:true with class/script; absent → exists:false (drift)
 *   (f) head() 5xx/403 → retryable error (NOT interpreted as gone)
 *   (g) get() a NAMED id → id + namespace + hex metadata; stateBrowsable ALWAYS false
 *   (h) ⛔ get() returns NO fabricated object state — the envelope carries identity metadata ONLY (no
 *       storage/data/state/value keys), does NOT fetch CF, and stateBrowsable is false
 *   (i) get() empty/missing id → invalid_id error, no fetch
 *   (j) mutate() returns code 'not_implemented' (never throws, never fetches) — reset/send are the write pass
 *   (k) site-isolation: list()/head() only ever surface the scope.resourceId namespace, never another
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { durableObjectAdapter } from '../adapters/durable_object.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The resolved DO namespace id this site owns (server-resolved from the registry row). */
const NS_ID = 'do-ns-11112222';

/** A minimal ResolvedScope for a per-site Durable Object surface — resourceId is the resolved namespace id. */
const scope: ResolvedScope = {
  siteId: 'site-abc-9999',
  orgId: 'org-1',
  environment: 'production',
  resourceId: NS_ID,
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

// ─── (j) mutate() rejects an unknown action — full manage coverage lives in durable_object_adapter_mutate.test.ts ──

describe('durableObjectAdapter.mutate() — guard', () => {
  it('(j) an unknown/undefined action → invalid_action, never throws, never fetches (status_probe/reset are covered in the mutate suite)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await durableObjectAdapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(b)(c)(d)(k) list() — NAMESPACES only, never instances ────────────────────

describe('durableObjectAdapter.list()', () => {
  it('(a)(d)(k) lists the resolved NAMESPACE only; instancesEnumerable false; hits namespaces path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: [
          { id: NS_ID, class: 'SiteBuilderContainer', script: 'project-sites', use_sqlite: true },
          // A DIFFERENT account namespace — must NOT be surfaced (server-side isolation to scope.resourceId).
          { id: 'other-ns-abc', class: 'SomeoneElse', script: 'other-worker' },
        ],
      }),
    );
    const result = await durableObjectAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(1);
    expect(result.data?.namespaces).toHaveLength(1);
    expect(result.data?.namespaces[0].id).toBe(NS_ID);
    expect(result.data?.namespaces[0].className).toBe('SiteBuilderContainer');
    expect(result.data?.namespaces[0].scriptName).toBe('project-sites');
    expect(result.data?.namespaces[0].useSqlite).toBe(true);
    // Honest: CF cannot enumerate instances — this is permanently declared false.
    expect(result.data?.instancesEnumerable).toBe(false);
    // The foreign namespace is never surfaced.
    expect(result.data?.namespaces.some((n) => n.id === 'other-ns-abc')).toBe(false);
    // Isolation: the request path is the account namespaces list — NEVER an instance/state path.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain('/workers/durable_objects/namespaces');
    expect(url.pathname).not.toContain('/instances');
    expect(url.pathname).not.toContain('/storage');
  });

  it('(b) no matching namespace → honest empty list + count 0 (never a fabricated instance)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: [{ id: 'unrelated-ns', class: 'X' }] }),
    );
    const result = await durableObjectAdapter.list(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(0);
    expect(result.data?.namespaces).toEqual([]);
    expect(result.data?.instancesEnumerable).toBe(false);
  });

  it('(c) maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await durableObjectAdapter.list(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── (e)(f)(k) head() — class-binding existence + drift semantics ──────────────────

describe('durableObjectAdapter.head()', () => {
  it('(e) namespace present → exists:true with class/script name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: [{ id: NS_ID, class: 'SiteBuilderContainer', script: 'project-sites' }],
      }),
    );
    const result = await durableObjectAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.namespaceId).toBe(NS_ID);
    expect(result.data?.className).toBe('SiteBuilderContainer');
    expect(result.data?.scriptName).toBe('project-sites');
  });

  it('(e)(k) namespace absent from account list → exists:false (drift signal), ok:true', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: [{ id: 'only-some-other-ns', class: 'X' }] }),
    );
    const result = await durableObjectAdapter.head(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
    expect(result.data?.namespaceId).toBe(NS_ID);
  });

  it('(f) 5xx → retryable error (NOT interpreted as gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { success: false }));
    const result = await durableObjectAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(f) 403 → retryable auth error (transient, not gone)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { success: false }));
    const result = await durableObjectAdapter.head(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_unauthorized');
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (g)(h)(i) get() — identity metadata ONLY, NEVER fabricated state ──────────────

describe('durableObjectAdapter.get()', () => {
  it('(i) empty id → invalid_id error, no fetch', async () => {
    const result = await durableObjectAdapter.get(scope, { id: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(g) a NAMED hex id → id + namespace + hexId metadata; stateBrowsable ALWAYS false', async () => {
    const hex = 'a'.repeat(64);
    const result = await durableObjectAdapter.get(scope, { id: hex });
    expect(result.ok).toBe(true);
    expect(result.data?.objectId).toBe(hex);
    expect(result.data?.namespaceId).toBe(NS_ID);
    expect(result.data?.hexId).toBe(hex);
    expect(result.data?.stateBrowsable).toBe(false);
  });

  it('(g) a from-name (non-hex) id → no fabricated hexId, still bound to the namespace', async () => {
    const result = await durableObjectAdapter.get(scope, { id: 'my-named-instance' });
    expect(result.ok).toBe(true);
    expect(result.data?.objectId).toBe('my-named-instance');
    expect(result.data?.namespaceId).toBe(NS_ID);
    // A non-hex id is NOT claimed to be a hex id (never fabricated).
    expect(result.data?.hexId).toBeUndefined();
    expect(result.data?.stateBrowsable).toBe(false);
  });

  it('(h) ⛔ returns NO fabricated object state — identity metadata ONLY, no CF fetch', async () => {
    const result = await durableObjectAdapter.get(scope, { id: 'b'.repeat(64) });
    expect(result.ok).toBe(true);
    // ⛔ get() must NEVER read/return a DO's private storage or in-memory state (no CF API can).
    // It does not even call CF — there is no per-object metadata endpoint.
    expect(fetchMock).not.toHaveBeenCalled();
    // The envelope carries identity metadata ONLY — assert NO state-bearing keys leaked in.
    const data = (result.data ?? {}) as Record<string, unknown>;
    expect(data.stateBrowsable).toBe(false);
    for (const forbidden of ['state', 'storage', 'data', 'value', 'values', 'entries', 'contents', 'sql']) {
      expect(data[forbidden]).toBeUndefined();
    }
    // The full serialized envelope must not smuggle a "state" payload either.
    const text = JSON.stringify(result.data);
    expect(text).not.toMatch(/"state"\s*:/);
    expect(text).not.toMatch(/"storage"\s*:/);
    // Only the four honest identity keys are present.
    expect(Object.keys(data).sort()).toEqual(['hexId', 'namespaceId', 'objectId', 'stateBrowsable']);
  });
});
