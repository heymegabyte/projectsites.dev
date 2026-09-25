/**
 * Tests for:
 * 1. `getSessionDurationSummary` service — per-session SUM(duration_ms) folded to median/avg/longest
 *    + the ≥30s/≥1m/≥3m/≥5m distribution, the honest empty (null median), the fail-soft error path,
 *    and the GROUP-BY-sid query shape.
 * 2. `GET /api/sites/:siteId/analytics/session-duration` route — tenant boundary (404 foreign / 200 owned).
 * 3. `parseWindowDays` — the `?days` fallback fix (a route declared `'windowDays'` still honors the
 *    cards' `?days=N`, so the window selector is no longer silently ignored).
 *
 * Mirrors exit_pages.test.ts: the REAL `dbQuery` runs against a D1 double (no module mock), so the
 * ownership `SELECT org_id FROM sites` AND the aggregator query both resolve through the same double.
 */
import type { Context } from 'hono';
import { getSessionDurationSummary } from '../../visitor_events_core/service.js';
import type { SessionDurationSummary } from '../../visitor_events_core/service.js';
import { siteAnalytics, parseWindowDays } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';
import type { Env } from '../../../../src/types/env.js';

/** D1 double: serves the ownership row + the aggregator's GROUP BY totals, capturing every SQL. */
function db(
  opts: {
    owner?: string | null;
    totalRows?: Array<{ total: number }>;
    throwOnGroup?: boolean;
    sqls?: string[];
  } = {},
): D1Database {
  const { owner = 'org1', totalRows = [], throwOnGroup = false, sqls = [] } = opts;
  function prepare(sql: string) {
    sqls.push(sql);
    const api = {
      bind: () => api,
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (owner ? [{ org_id: owner }] : []) as unknown as T[] };
        }
        if (sql.includes('GROUP BY')) {
          if (throwOnGroup) throw new Error('D1 timeout');
          return { results: totalRows as unknown as T[] };
        }
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

function makeEnv(database: D1Database): Env {
  return { DB: database } as unknown as Env;
}

// ─── 1. Aggregator ───────────────────────────────────────────────────────────

describe('getSessionDurationSummary — aggregator', () => {
  it('computes median/avg/longest + the ≥30s/≥1m/≥3m/≥5m distribution from per-session totals', async () => {
    // Five sessions (ms): 10s, 40s, 90s, 200s, 400s → median 90k, avg 148k, max 400k.
    const env = makeEnv(
      db({
        totalRows: [
          { total: 10_000 },
          { total: 40_000 },
          { total: 90_000 },
          { total: 200_000 },
          { total: 400_000 },
        ],
      }),
    );
    const r: SessionDurationSummary = await getSessionDurationSummary(env, 'site1', 30);
    expect(r.sessions).toBe(5);
    expect(r.medianMs).toBe(90_000);
    expect(r.avgMs).toBe(148_000);
    expect(r.maxMs).toBe(400_000);
    // ≥30s: 40k/90k/200k/400k=4 · ≥1m: 90k/200k/400k=3 · ≥3m: 200k/400k=2 · ≥5m: 400k=1
    expect(r.distribution).toEqual({ s30: 4, s60: 3, s180: 2, s300: 1 });
  });

  it('honest empty (null median, never a fabricated 0) when there are no sessions', async () => {
    const r = await getSessionDurationSummary(makeEnv(db({ totalRows: [] })), 'site1', 30);
    expect(r).toEqual({
      sessions: 0,
      medianMs: null,
      avgMs: null,
      maxMs: null,
      distribution: { s30: 0, s60: 0, s180: 0, s300: 0 },
    });
  });

  it('fail-soft empty (null median) when the query errors', async () => {
    const r = await getSessionDurationSummary(makeEnv(db({ throwOnGroup: true })), 'site1', 30);
    expect(r.sessions).toBe(0);
    expect(r.medianMs).toBeNull();
  });

  it('sums duration per SESSION (GROUP BY sid), page_engagement only, sid + duration non-null', async () => {
    const sqls: string[] = [];
    await getSessionDurationSummary(makeEnv(db({ sqls })), 'site1', 30);
    const q = sqls.find((s) => s.includes('GROUP BY'));
    expect(q).toBeDefined();
    expect(q!).toContain("SUM(CAST(json_extract(metadata, '$.duration_ms') AS INTEGER))");
    expect(q!).toContain("GROUP BY json_extract(metadata, '$.sid')");
    expect(q!).toContain("event_type = 'page_engagement'");
    expect(q!).toContain("json_extract(metadata, '$.sid') IS NOT NULL");
    expect(q!).toContain("json_extract(metadata, '$.duration_ms') IS NOT NULL");
  });
});

// ─── 2. Route — tenant boundary ──────────────────────────────────────────────

const URL = '/api/sites/site1/analytics/session-duration';

describe('GET /api/sites/:siteId/analytics/session-duration — tenant boundary', () => {
  it('404 when the site belongs to a different org', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(URL, {}, harnessEnv(db({ owner: 'OTHER_ORG' }), true));
    expect(res.status).toBe(404);
  });

  it('200 + the session-duration summary for the org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(
      URL,
      {},
      harnessEnv(db({ owner: 'org1', totalRows: [{ total: 45_000 }, { total: 120_000 }] }), true),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDurationSummary;
    expect(body.sessions).toBe(2);
    // nearest-rank p50 (the CrUX/CF method the whole analytics stack uses): rank ceil(0.5·2)=1 → 45k
    expect(body.medianMs).toBe(45_000);
    expect(body.avgMs).toBe(Math.round((45_000 + 120_000) / 2)); // mean is a separate field
    expect(body.distribution.s30).toBe(2);
    expect(body.distribution.s60).toBe(1);
  });
});

// ─── 3. parseWindowDays — the ?days fallback fix ─────────────────────────────

describe('parseWindowDays — ?days fallback (window selector no longer silently ignored)', () => {
  const ctx = (q: Record<string, string>): Context =>
    ({ req: { query: (k: string) => q[k] } }) as unknown as Context;

  it('falls back to ?days when the named param is absent (the entry/exit/session cards send ?days)', () => {
    expect(parseWindowDays(ctx({ days: '7' }), 'windowDays')).toBe(7);
  });
  it('the named param wins when present', () => {
    expect(parseWindowDays(ctx({ windowDays: '14', days: '7' }), 'windowDays')).toBe(14);
  });
  it('defaults to 30 when neither is present', () => {
    expect(parseWindowDays(ctx({}), 'windowDays')).toBe(30);
  });
  it('rejects out-of-range / non-integer and defaults to 30 (no fallback to a bad ?days)', () => {
    expect(parseWindowDays(ctx({ windowDays: '999' }), 'windowDays')).toBe(30);
    expect(parseWindowDays(ctx({ days: 'abc' }), 'windowDays')).toBe(30);
    expect(parseWindowDays(ctx({ windowDays: '0' }), 'windowDays')).toBe(30);
  });
});
