/**
 * TDD tests for the analytics_engine adapter (Observability READ slice — Data & Resource Platform §8b,
 * Backend tab).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Analytics
 * Engine SQL API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * ⛔ THE LOAD-BEARING HONESTY OF THIS SLICE:
 *  - INGEST IS DISABLED on this deployment (`ANALYTICS_INGEST_ENABLED="false"` → `scope.ingestEnabled` false):
 *    `list`/`head` report available:false and `get` returns a ZERO summary WITHOUT querying (honest
 *    not_available, never a fabricated count, never a misleading "0 real events").
 *  - ISOLATION: the AE SQL API is ACCOUNT-WIDE. The adapter NEVER accepts a caller query; every SQL is
 *    SERVER-BUILT and carries a mandatory `WHERE blob3 = '<siteId>'` (the site dimension). One site can only
 *    ever aggregate ITS OWN events — a caller supplies only an optional window, never SQL/dataset/account.
 *  - SAMPLED: counts are `SUM(_sample_interval)` estimates — `sampled` is ALWAYS true.
 *
 * Contracts under test:
 *   (a) ingest disabled → get() returns available:false + totalEvents:0 WITHOUT fetching (honest not_available)
 *   (b) ingest disabled → list()/head() report available:false (never a fake event stream)
 *   (c) get() with ingest enabled builds a SERVER-SIDE site-scoped query (WHERE blob3 = '<siteId>')
 *   (d) get() NEVER accepts a caller SQL/dataset — only windowDays; the site filter is always injected
 *   (e) get() returns totalEvents + per-event breakdown; sampled ALWAYS true
 *   (f) get() maps a 5xx to a retryable error (never "gone")
 *   (g) get() clamps windowDays to [1, 90] (over-window succeeds clamped, never rejected)
 *   (h) head() with ingest enabled → exists:true + available:true for the resolved dataset
 *   (i) list() with ingest enabled → the shared dataset + its dimension config; available:true
 *   (j) mutate() returns not_implemented (Observability is read-only) — never throws, never fetches
 *   (k) a malformed/injected dataset name is rejected before any SQL runs (defense-in-depth)
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { analyticsEngineAdapter } from '../adapters/analytics_engine.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The resolved (shared) AE dataset name this site's events flow into. */
const DATASET = 'projectsites_admin_v1';
const SITE_ID = 'site-abc-9999';

/** Build a ResolvedScope for the AE surface. `ingestEnabled` toggles the honest availability path. */
function makeScope(ingestEnabled: boolean, overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    siteId: SITE_ID,
    orgId: 'org-1',
    environment: 'production',
    resourceId: DATASET,
    accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
    auth: { email: 'test@example.com', key: 'test-key' } as never,
    accessPolicy: 'read_only',
    ingestEnabled,
    ...overrides,
  };
}

/** Build a fake Response with a JSON body (the AE SQL API returns `{ data: [...] }`). */
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

describe('analyticsEngineAdapter.mutate()', () => {
  it('(j) returns not_implemented code — never throws, never fetches (Observability is read-only)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await analyticsEngineAdapter.mutate(makeScope(true), undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (a)(b) ingest disabled — honest not_available, NEVER a query ─────────────────

describe('analyticsEngineAdapter — ingest disabled (the reality today)', () => {
  it('(a) get() returns available:false + totalEvents:0 WITHOUT fetching (honest not_available)', async () => {
    const result = await analyticsEngineAdapter.get(makeScope(false), { windowDays: 30 });
    expect(result.ok).toBe(true);
    expect(result.data?.available).toBe(false);
    expect(result.data?.totalEvents).toBe(0);
    expect(result.data?.events).toEqual([]);
    expect(result.data?.sampled).toBe(true);
    // ⛔ No query is issued when ingest is off — a fabricated "0 real events" would be dishonest.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(b) list()/head() report available:false — never a fake event stream', async () => {
    const list = await analyticsEngineAdapter.list(makeScope(false));
    expect(list.ok).toBe(true);
    expect(list.data?.available).toBe(false);
    const head = await analyticsEngineAdapter.head(makeScope(false));
    expect(head.ok).toBe(true);
    expect(head.data?.available).toBe(false);
    // list/head describe config; they never query the SQL API.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (c)(d)(e)(f)(g) get() with ingest enabled — SERVER-SCOPED query ──────────────

describe('analyticsEngineAdapter.get() — ingest enabled', () => {
  it('(c)(d) builds a SERVER-SIDE site-scoped query (WHERE blob3 = <siteId>); never a caller SQL/dataset', async () => {
    // total-events query, then per-event breakdown query (Promise.all → two fetches).
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ n: 42 }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ event: 'admin_visit', n: 30 }] }));
    const result = await analyticsEngineAdapter.get(makeScope(true), { windowDays: 30 });
    expect(result.ok).toBe(true);
    // Both calls hit the account-level AE SQL endpoint.
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).toContain('/analytics_engine/sql');
      const sql = String((call[1] as { body?: string }).body);
      // The mandatory site WHERE — the isolation dimension, injected server-side.
      expect(sql).toContain(`blob3 = '${SITE_ID}'`);
      // The dataset FROM is the server-resolved shared dataset (never a caller value).
      expect(sql).toContain(`FROM ${DATASET}`);
      // SAMPLED aggregate — honest estimate, never an exact tally.
      expect(sql).toContain('SUM(_sample_interval)');
    }
  });

  it('(e) returns totalEvents + per-event breakdown; sampled ALWAYS true', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ n: 42 }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            { event: 'admin_visit', n: 30 },
            { event: 'form_submit', n: 12 },
          ],
        }),
      );
    const result = await analyticsEngineAdapter.get(makeScope(true), {});
    expect(result.ok).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.totalEvents).toBe(42);
    expect(result.data?.events).toHaveLength(2);
    expect(result.data?.events[0]).toEqual({ event: 'admin_visit', count: 30 });
    expect(result.data?.events[1]).toEqual({ event: 'form_submit', count: 12 });
    expect(result.data?.sampled).toBe(true);
    expect(result.data?.datasetName).toBe(DATASET);
  });

  it('(f) maps a 5xx to a retryable error (never "gone")', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const result = await analyticsEngineAdapter.get(makeScope(true), {});
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('(g) clamps windowDays to [1, 90] — an over-window request SUCCEEDS clamped (never rejected)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ n: 1 }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    const result = await analyticsEngineAdapter.get(makeScope(true), { windowDays: 9999 });
    expect(result.ok).toBe(true);
    expect(result.data?.windowDays).toBe(90); // clamped, never rejected
    const sql = String((fetchMock.mock.calls[0][1] as { body?: string }).body);
    expect(sql).toContain("INTERVAL '90' DAY");
  });

  it('(k) a malformed/injected dataset name is rejected before any SQL runs (defense-in-depth)', async () => {
    const badScope = makeScope(true, { resourceId: "evil; DROP TABLE x; --" });
    const result = await analyticsEngineAdapter.get(badScope, {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_dataset');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (h)(i) head()/list() with ingest enabled ─────────────────────────────────────

describe('analyticsEngineAdapter.head()/list() — ingest enabled', () => {
  it('(h) head() → exists:true + available:true for the resolved dataset', async () => {
    const result = await analyticsEngineAdapter.head(makeScope(true));
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.datasetName).toBe(DATASET);
    // head never queries the SQL API — it's a config/health probe.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(i) list() → the shared dataset + its dimension config; available:true', async () => {
    const result = await analyticsEngineAdapter.list(makeScope(true));
    expect(result.ok).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.count).toBe(1);
    expect(result.data?.datasets[0].name).toBe(DATASET);
    // The custom-event dimensions (blob layout) surface as config — includes the site_id dimension.
    const dims = result.data?.datasets[0].dimensions ?? [];
    expect(dims.some((d) => d.column === 'blob3' && d.meaning === 'site_id')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
