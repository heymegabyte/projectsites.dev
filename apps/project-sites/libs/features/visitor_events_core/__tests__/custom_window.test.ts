/**
 * Unit tests for the ARBITRARY start/end window in getTrafficSummary +
 * getWebVitalsSummary + getConversionKinds (AL — custom date range).
 *
 * The default (no `window`) path keeps the trailing relative window
 * (`created_at >= datetime('now', '-N days')`) so every existing contract is
 * preserved. When an absolute `{ since, until }` window is passed:
 *   - the WHERE clause switches to bound literals `created_at >= ? AND created_at < ?`
 *     (SQLite-comparable date strings, NEVER ISO T/Z which sorts wrong vs D1's
 *     space-separated created_at),
 *   - the period-over-period comparison uses the equal-length window immediately
 *     before [since, until),
 *   - `windowDays` reports the span in days.
 *
 * A param-capturing D1 stub records every (sql, params) so we assert the exact
 * window bounds each sub-query binds.
 */

import {
  getTrafficSummary,
  getWebVitalsSummary,
  getJsErrorSummary,
  getEngagementSummary,
  getScrollDepthSummary,
  getNetworkQualitySummary,
  getNavTimingSummary,
  getOutboundClicksSummary,
  getConversionKinds,
  getPreviousConversionKinds,
  getDimensionBreakdown,
  getCampaignBreakdown,
  getHourlyBreakdown,
  shiftWindowToTz,
} from '../service.js';
import type { Env } from '../../../../src/types/env.js';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** D1 stub capturing every bound (sql, params); all reads degrade to empty. */
function captureEnv(): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            all: async () => ({ results: [] as unknown[] }),
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

describe('getTrafficSummary — absolute {since, until} window', () => {
  it('binds ISO date literals (not datetime(now)) for the current window', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });

    const pageviews = calls.find(
      (c) =>
        c.sql.includes('COUNT(*)') &&
        c.sql.includes("event_type = 'pageview'") &&
        !c.sql.includes('DATE('),
    );
    expect(pageviews).toBeDefined();
    expect(pageviews!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(pageviews!.sql).not.toContain("datetime('now'");
    expect(pageviews!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('compares against the equal-length window immediately before [since, until)', async () => {
    const { env, calls } = captureEnv();
    // 15-day window → preceding window is [2026-07-17, 2026-08-01).
    await getTrafficSummary(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });

    const prev = calls.find(
      (c) => c.params.length === 3 && c.params[1] === '2026-07-17' && c.params[2] === '2026-08-01',
    );
    expect(prev).toBeDefined();
    expect(prev!.sql).toContain('created_at >= ? AND created_at < ?');
  });

  it('reports windowDays as the span of the absolute window', async () => {
    const { env } = captureEnv();
    const s = await getTrafficSummary(env, 'site_1', 30, {
      since: '2026-08-01',
      until: '2026-08-16',
    });
    expect(s.windowDays).toBe(15);
  });

  it('keeps the relative datetime(now) window when NO absolute window is given', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30);

    const pageviews = calls.find(
      (c) =>
        c.sql.includes('COUNT(*)') &&
        c.sql.includes("event_type = 'pageview'") &&
        !c.sql.includes('DATE('),
    );
    expect(pageviews).toBeDefined();
    expect(pageviews!.sql).toContain("datetime('now', ?)");
    expect(pageviews!.params).toEqual(['site_1', '-30 days']);
  });
});

describe('getWebVitalsSummary / getConversionKinds — absolute window', () => {
  it('web-vitals query binds the absolute window literals', async () => {
    const { env, calls } = captureEnv();
    await getWebVitalsSummary(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    const q = calls.find((c) => c.sql.includes("event_type = 'web_vital'"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('conversion-kinds query binds the absolute window literals', async () => {
    const { env, calls } = captureEnv();
    await getConversionKinds(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    const q = calls.find((c) => c.sql.includes("event_type = 'conversion'"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('PREVIOUS conversion-kinds query binds the PRIOR equal-length window (absolute)', async () => {
    const { env, calls } = captureEnv();
    // 15-day window [08-01, 08-16) → prior window is [07-17, 08-01).
    await getPreviousConversionKinds(env, 'site_1', 30, {
      since: '2026-08-01',
      until: '2026-08-16',
    });
    const q = calls.find((c) => c.sql.includes("event_type = 'conversion'"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(q!.params).toEqual(['site_1', '2026-07-17', '2026-08-01']);
  });

  it('PREVIOUS conversion-kinds keeps the relative [now-2N, now-N) window', async () => {
    const { env, calls } = captureEnv();
    await getPreviousConversionKinds(env, 'site_1', 7);
    const q = calls.find((c) => c.sql.includes("event_type = 'conversion'"));
    expect(q!.sql).toContain("datetime('now', ?)");
    expect(q!.params).toEqual(['site_1', '-14 days', '-7 days']);
  });

  it('getTrafficSummary wires previous.byConversionKind (present + defaulted [] when empty)', async () => {
    const { env } = captureEnv();
    const s = await getTrafficSummary(env, 'site_1', 30);
    expect(Array.isArray(s.previous.byConversionKind)).toBe(true);
    expect(s.previous.byConversionKind).toEqual([]); // no events → honest empty, never fabricated
  });

  it('getDimensionBreakdown groups pageviews by the metadata dimension over the window', async () => {
    const { env, calls } = captureEnv();
    await getDimensionBreakdown(env, 'site_1', 'browser', 30, {
      since: '2026-08-01',
      until: '2026-08-16',
    });
    const q = calls.find((c) => c.sql.includes("json_extract(metadata, '$.browser')"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain("event_type = 'pageview'");
    expect(q!.sql).toContain('GROUP BY label');
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('getDimensionBreakdown REJECTS a non-allowlisted dimension (never interpolates it)', async () => {
    const { env, calls } = captureEnv();
    const out = await getDimensionBreakdown(env, 'site_1', 'metadata) --' as never, 30);
    expect(out).toEqual([]);
    // The hostile dimension string never reaches a query.
    expect(calls.some((c) => c.sql.includes('metadata) --'))).toBe(false);
  });

  it('getHourlyBreakdown groups pageviews by UTC hour-of-day over the window', async () => {
    const { env, calls } = captureEnv();
    await getHourlyBreakdown(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    const q = calls.find((c) => c.sql.includes("strftime('%H', created_at)"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain("event_type = 'pageview'");
    expect(q!.sql).toContain('GROUP BY hour');
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('getHourlyBreakdown maps rows to {hour,count} and drops a null/out-of-range hour', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind: (..._p: unknown[]) => ({
            all: async () => ({
              results: [
                { hour: 9, n: 5 },
                { hour: 14, n: 12 },
                { hour: null, n: 3 },
              ],
            }),
          }),
        };
      },
    };
    const out = await getHourlyBreakdown({ DB: db } as unknown as Env, 'site_1', 30);
    expect(out).toEqual([
      { hour: 9, count: 5 },
      { hour: 14, count: 12 },
    ]);
  });

  it('getCampaignBreakdown groups TAGGED pageviews by the UTM param, EXCLUDING untagged (null)', async () => {
    const { env, calls } = captureEnv();
    await getCampaignBreakdown(env, 'site_1', 'utmSource', 30, {
      since: '2026-08-01',
      until: '2026-08-16',
    });
    const q = calls.find((c) => c.sql.includes("json_extract(metadata, '$.utmSource')"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain("event_type = 'pageview'");
    // The untagged direct/organic majority (NULL) must be filtered OUT — a campaign
    // breakdown never buckets untagged traffic as a giant "unknown".
    expect(q!.sql).toContain('IS NOT NULL');
    expect(q!.sql).toContain('GROUP BY label');
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('getCampaignBreakdown groups by utm_MEDIUM (the raw owner-set medium, distinct from byChannel)', async () => {
    const { env, calls } = captureEnv();
    await getCampaignBreakdown(env, 'site_1', 'utmMedium', 30, {
      since: '2026-08-01',
      until: '2026-08-16',
    });
    const q = calls.find((c) => c.sql.includes("json_extract(metadata, '$.utmMedium')"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain("event_type = 'pageview'");
    expect(q!.sql).toContain('IS NOT NULL'); // untagged (NULL) excluded — never a giant "unknown"
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('getCampaignBreakdown REJECTS a non-allowlisted UTM dimension (never interpolates it)', async () => {
    const { env, calls } = captureEnv();
    const out = await getCampaignBreakdown(env, 'site_1', "utmSource'); DROP" as never, 30);
    expect(out).toEqual([]);
    expect(calls.some((c) => c.sql.includes('DROP'))).toBe(false);
  });

  it('getTrafficSummary wires byBrowser + byOs + byUtmSource + byUtmMedium + byUtmCampaign (present + defaulted [])', async () => {
    const { env } = captureEnv();
    const s = await getTrafficSummary(env, 'site_1', 30);
    expect(Array.isArray(s.byBrowser)).toBe(true);
    expect(Array.isArray(s.byOs)).toBe(true);
    expect(s.byBrowser).toEqual([]);
    expect(s.byOs).toEqual([]);
    // AN-UTM: campaign attribution wired into the summary, honestly empty for an untagged site.
    expect(s.byUtmSource).toEqual([]);
    expect(s.byUtmMedium).toEqual([]);
    expect(s.byUtmCampaign).toEqual([]);
  });

  it('web-vitals keeps the relative window with no absolute window', async () => {
    const { env, calls } = captureEnv();
    await getWebVitalsSummary(env, 'site_1', 7);
    const q = calls.find((c) => c.sql.includes("event_type = 'web_vital'"));
    expect(q!.sql).toContain("datetime('now', ?)");
    expect(q!.params).toEqual(['site_1', '-7 days']);
  });
});

/**
 * The good/needs/poor distribution behind each CWV p75 — classified from the REAL
 * samples against Google's thresholds. Shows the spread the p75 point can't (a good
 * p75 can still hide a poor tail); never a fabricated distribution.
 */
describe('getWebVitalsSummary — rating distribution (dist)', () => {
  /** D1 stub that returns the given rows for the web_vital read (else empty). */
  function webVitalEnv(rows: Array<{ metric: string; value: number; path?: string }>): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              all: async () => ({ results: sql.includes("event_type = 'web_vital'") ? rows : [] }),
              first: async () => null,
              run: async () => ({ success: true, meta: { changes: 0 } }),
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }

  it('classifies each sample into good/needs/poor and the counts sum to samples', async () => {
    const wv = await getWebVitalsSummary(
      webVitalEnv([
        { metric: 'LCP', value: 2000 }, // good (≤2500)
        { metric: 'LCP', value: 2000 }, // good
        { metric: 'LCP', value: 3000 }, // needs (≤4000)
        { metric: 'LCP', value: 5000 }, // poor (>4000)
        { metric: 'CLS', value: 0.05 }, // good (≤0.1)
        { metric: 'CLS', value: 0.2 }, // needs (≤0.25)
        { metric: 'CLS', value: 0.3 }, // poor
      ]),
      'site_1',
      30,
    );
    expect(wv.lcp?.dist).toEqual({ good: 2, needs: 1, poor: 1 });
    expect(wv.lcp?.samples).toBe(4);
    expect(wv.cls?.dist).toEqual({ good: 1, needs: 1, poor: 1 });
    const d = wv.lcp!.dist!;
    expect(d.good + d.needs + d.poor).toBe(wv.lcp!.samples);
    // A metric with no field samples stays null — no fabricated dist.
    expect(wv.inp).toBeNull();
  });

  it('enriches each slowest page with its INP + CLS p75 (omitted below the 5-sample floor)', async () => {
    const rows: Array<{ metric: string; value: number; path?: string }> = [];
    // /pricing: 5 LCP + 5 INP + 5 CLS → all three per-page p75 present.
    for (let i = 0; i < 5; i++) rows.push({ metric: 'LCP', value: 3000, path: '/pricing' });
    for (let i = 0; i < 5; i++) rows.push({ metric: 'INP', value: 250, path: '/pricing' });
    for (let i = 0; i < 5; i++) rows.push({ metric: 'CLS', value: 0.15, path: '/pricing' });
    // /about: 5 LCP (ranks it) but only 2 INP (below the floor) → inpP75 omitted.
    for (let i = 0; i < 5; i++) rows.push({ metric: 'LCP', value: 2600, path: '/about' });
    for (let i = 0; i < 2; i++) rows.push({ metric: 'INP', value: 100, path: '/about' });
    const wv = await getWebVitalsSummary(webVitalEnv(rows), 'site_1', 30);
    const pricing = wv.slowestPages.find((p) => p.path === '/pricing');
    expect(pricing?.lcpP75).toBe(3000);
    expect(pricing?.inpP75).toBe(250);
    expect(pricing?.clsP75).toBe(0.15);
    const about = wv.slowestPages.find((p) => p.path === '/about');
    expect(about?.lcpP75).toBe(2600);
    // Below the 5-sample floor → omitted (undefined), never a fabricated 0.
    expect(about?.inpP75).toBeUndefined();
    expect(about?.clsP75).toBeUndefined();
  });

  it('enriches each slowest page with its FCP + TTFB p75 (omitted below the 5-sample floor)', async () => {
    const rows: Array<{ metric: string; value: number; path?: string }> = [];
    // /pricing: 5 LCP (ranks it) + 5 FCP + 5 TTFB → both page-load p75 present.
    for (let i = 0; i < 5; i++) rows.push({ metric: 'LCP', value: 3000, path: '/pricing' });
    for (let i = 0; i < 5; i++) rows.push({ metric: 'FCP', value: 1800, path: '/pricing' });
    for (let i = 0; i < 5; i++) rows.push({ metric: 'TTFB', value: 650, path: '/pricing' });
    // /about: 5 LCP (ranks it) but only 3 FCP + 0 TTFB (below the floor) → both omitted.
    for (let i = 0; i < 5; i++) rows.push({ metric: 'LCP', value: 2600, path: '/about' });
    for (let i = 0; i < 3; i++) rows.push({ metric: 'FCP', value: 1200, path: '/about' });
    const wv = await getWebVitalsSummary(webVitalEnv(rows), 'site_1', 30);
    const pricing = wv.slowestPages.find((p) => p.path === '/pricing');
    expect(pricing?.fcpP75).toBe(1800); // integer ms, not CLS-rounded
    expect(pricing?.ttfbP75).toBe(650);
    const about = wv.slowestPages.find((p) => p.path === '/about');
    expect(about?.lcpP75).toBe(2600);
    // Below the 5-sample floor → omitted (undefined), never a fabricated 0.
    expect(about?.fcpP75).toBeUndefined();
    expect(about?.ttfbP75).toBeUndefined();
  });

  it('threshold boundaries: ≤good is good, ≤needs is needs, else poor (INP 200/500)', async () => {
    const wv = await getWebVitalsSummary(
      webVitalEnv([
        { metric: 'INP', value: 200 }, // good (≤200)
        { metric: 'INP', value: 500 }, // needs (≤500)
        { metric: 'INP', value: 501 }, // poor (>500)
      ]),
      'site_1',
      30,
    );
    expect(wv.inp?.dist).toEqual({ good: 1, needs: 1, poor: 1 });
  });
});

describe('shiftWindowToTz — interpret absolute window bounds in the owner tz', () => {
  it('shifts PST (-480) local midnights to their UTC datetime equivalents', () => {
    // 2026-08-01 00:00 PST = 2026-08-01 08:00 UTC; 2026-08-16 00:00 PST = 2026-08-16 08:00 UTC.
    expect(shiftWindowToTz({ since: '2026-08-01', until: '2026-08-16' }, -480)).toEqual({
      since: '2026-08-01 08:00:00',
      until: '2026-08-16 08:00:00',
    });
  });

  it('shifts IST (+330) — east of UTC → earlier UTC instant', () => {
    // 2026-08-01 00:00 IST = 2026-07-31 18:30 UTC.
    expect(shiftWindowToTz({ since: '2026-08-01', until: '2026-08-16' }, 330)).toEqual({
      since: '2026-07-31 18:30:00',
      until: '2026-08-15 18:30:00',
    });
  });

  it('produces SQLite-comparable space-separated bounds (never ISO T/Z)', () => {
    const w = shiftWindowToTz({ since: '2026-08-01', until: '2026-08-16' }, -480);
    expect(w.since).not.toContain('T');
    expect(w.since).not.toContain('Z');
    expect(w.since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns the window UNCHANGED for UTC (0), non-integer, and out-of-range offsets', () => {
    const w = { since: '2026-08-01', until: '2026-08-16' };
    for (const bad of [0, 9999, -9999, 1.5, Number.NaN, undefined]) {
      expect(shiftWindowToTz(w, bad as number)).toEqual(w);
    }
  });
});

describe('getJsErrorSummary — first-party site-health', () => {
  /** D1 stub returning the given grouped rows for the js_error query (else empty). */
  function jsErrorEnv(
    rows: Array<{ message: string | null; n: number; sample_path?: string | null }>,
    opts: { error?: boolean } = {},
  ): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () => {
                if (opts.error) throw new Error('no such table: visitor_events');
                return { results: sql.includes("event_type = 'js_error'") ? rows : [] };
              },
              first: async () => null,
              run: async () => ({ success: true, meta: { changes: 0 } }),
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }

  it('groups by message, sums the true total, and carries a sample path', async () => {
    const s = await getJsErrorSummary(
      jsErrorEnv([
        {
          message: "Cannot read properties of undefined (reading 'x')",
          n: 12,
          sample_path: '/pricing',
        },
        { message: 'ChunkLoadError', n: 3, sample_path: '/blog' },
      ]),
      'site_1',
      30,
    );
    expect(s.total).toBe(15); // 12 + 3 — the real count, not the group count
    expect(s.byMessage[0]).toEqual({
      message: "Cannot read properties of undefined (reading 'x')",
      count: 12,
      samplePath: '/pricing',
    });
    expect(s.byMessage).toHaveLength(2);
  });

  it('caps the DISPLAYED groups at 8 but the total still counts all of them', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ message: 'err ' + i, n: i + 1 }));
    const s = await getJsErrorSummary(jsErrorEnv(rows), 'site_1', 30);
    expect(s.byMessage).toHaveLength(8); // top-8 for display
    expect(s.total).toBe(rows.reduce((t, r) => t + r.n, 0)); // total counts ALL 12
  });

  it('a clean site → {total:0, byMessage:[]} (never implies "not measured")', async () => {
    const s = await getJsErrorSummary(jsErrorEnv([]), 'site_1', 30);
    expect(s).toEqual({ total: 0, byMessage: [] });
  });

  it('fail-soft — a query error yields the empty clean summary, never throws', async () => {
    const s = await getJsErrorSummary(jsErrorEnv([], { error: true }), 'site_1', 30);
    expect(s).toEqual({ total: 0, byMessage: [] });
  });

  it('scopes to the tenant — the site_id predicate is bound, never interpolated', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({}),
            };
          },
        };
      },
    };
    await getJsErrorSummary({ DB: db } as unknown as Env, 'site-XYZ', 30);
    const q = calls.find((c) => c.sql.includes("event_type = 'js_error'"));
    expect(q?.sql).toContain('site_id = ?'); // bound predicate, not a literal
    expect(q?.params).toContain('site-XYZ'); // the caller-scoped site is a bound param
  });
});

describe('getEngagementSummary — first-party time-on-page (median dwell)', () => {
  /** D1 stub returning the given {path, duration} rows for the page_engagement query. */
  function engEnv(
    rows: Array<{ path: string | null; duration: number }>,
    opts: { error?: boolean } = {},
  ): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => {
                if (opts.error) throw new Error('no such table');
                return { results: sql.includes("event_type = 'page_engagement'") ? rows : [] };
              },
              first: async () => null,
              run: async () => ({ success: true }),
              _params: params,
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }

  it('computes the site-wide MEDIAN dwell (not mean — outlier-resistant)', async () => {
    // durations: 1s,2s,3s,4s,100s → median 3s (mean would be ~22s, skewed by the 100s outlier)
    const rows = [1000, 2000, 3000, 4000, 100000].map((d) => ({ path: '/', duration: d }));
    const s = await getEngagementSummary(engEnv(rows), 'site_1', 30);
    expect(s.medianMs).toBe(3000);
    expect(s.samples).toBe(5);
  });

  it('reports per-page median, longest-dwell first, past the 5-sample floor', async () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ path: '/pricing', duration: 60000 })), // 60s ×5 (qualifies)
      ...Array.from({ length: 5 }, () => ({ path: '/', duration: 10000 })), // 10s ×5 (qualifies)
      ...Array.from({ length: 2 }, () => ({ path: '/thin', duration: 90000 })), // only 2 → below floor
    ];
    const s = await getEngagementSummary(engEnv(rows), 'site_1', 30);
    expect(s.byPage.map((p) => p.path)).toEqual(['/pricing', '/']); // /thin dropped (below floor); longest first
    expect(s.byPage[0]).toEqual({ path: '/pricing', medianMs: 60000, samples: 5 });
  });

  it('no samples → {medianMs:null, samples:0, byPage:[]} (measuring…, never a fabricated 0)', async () => {
    const s = await getEngagementSummary(engEnv([]), 'site_1', 30);
    expect(s).toEqual({
      medianMs: null,
      samples: 0,
      byPage: [],
      distribution: { s10: 0, s30: 0, s60: 0, s180: 0 },
    });
  });

  it('fail-soft — a query error yields the empty summary, never throws', async () => {
    const s = await getEngagementSummary(engEnv([], { error: true }), 'site_1', 30);
    expect(s).toEqual({
      medianMs: null,
      samples: 0,
      byPage: [],
      distribution: { s10: 0, s30: 0, s60: 0, s180: 0 },
    });
  });

  it('scopes to the tenant — the site_id predicate is bound, never interpolated', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({}),
            };
          },
        };
      },
    };
    await getEngagementSummary({ DB: db } as unknown as Env, 'site-ABC', 30);
    const q = calls.find((c) => c.sql.includes("event_type = 'page_engagement'"));
    expect(q?.sql).toContain('site_id = ?');
    expect(q?.params).toContain('site-ABC');
  });
});

describe('getScrollDepthSummary — first-party scroll depth (reach funnel + median)', () => {
  /** D1 stub returning the given {path, pct} rows for the scroll_depth query. */
  function scrollEnv(
    rows: Array<{ path: string | null; pct: number }>,
    opts: { error?: boolean } = {},
  ): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => {
                if (opts.error) throw new Error('no such table');
                return { results: sql.includes("event_type = 'scroll_depth'") ? rows : [] };
              },
              first: async () => null,
              run: async () => ({ success: true }),
              _params: params,
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }

  it('computes the site-wide MEDIAN max-depth + a monotonic reach funnel', async () => {
    // depths: 10,30,50,80,100 → median 50; reach ≥25:4, ≥50:3, ≥75:2, ≥100:1
    const rows = [10, 30, 50, 80, 100].map((p) => ({ path: '/', pct: p }));
    const s = await getScrollDepthSummary(scrollEnv(rows), 'site_1', 30);
    expect(s.medianPercent).toBe(50);
    expect(s.samples).toBe(5);
    expect(s.reach).toEqual({ p25: 4, p50: 3, p75: 2, p100: 1 });
  });

  it('clamps out-of-range percents 0–100 defensively (never a >100 sample)', async () => {
    const rows = [
      { path: '/', pct: 150 },
      { path: '/', pct: -20 },
    ];
    const s = await getScrollDepthSummary(scrollEnv(rows), 'site_1', 30);
    // 150 clamps to 100, -20 clamps to 0 — so exactly one sample counts as complete (≥100)
    expect(s.reach.p100).toBe(1);
    expect(s.samples).toBe(2);
  });

  it('reports per-page median + completion, deepest first, past the 5-sample floor', async () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ path: '/long-read', pct: 90 })), // deep, 0% complete
      ...Array.from({ length: 5 }, () => ({ path: '/', pct: 100 })), // shallow list but all complete
      ...Array.from({ length: 2 }, () => ({ path: '/thin', pct: 100 })), // below floor → dropped
    ];
    const s = await getScrollDepthSummary(scrollEnv(rows), 'site_1', 30);
    expect(s.byPage.map((p) => p.path)).toEqual(['/', '/long-read']); // 100 median first, /thin dropped
    expect(s.byPage[0]).toEqual({
      path: '/',
      medianPercent: 100,
      samples: 5,
      completionPercent: 100,
    });
    expect(s.byPage[1].completionPercent).toBe(0); // /long-read: median 90, nobody hit 100
  });

  it('no samples → {samples:0, medianPercent:null, reach all-0, byPage:[]} (measuring…, never a fabricated 0)', async () => {
    const s = await getScrollDepthSummary(scrollEnv([]), 'site_1', 30);
    expect(s).toEqual({
      samples: 0,
      medianPercent: null,
      reach: { p25: 0, p50: 0, p75: 0, p100: 0 },
      byPage: [],
    });
  });

  it('fail-soft — a query error yields the empty summary, never throws', async () => {
    const s = await getScrollDepthSummary(scrollEnv([], { error: true }), 'site_1', 30);
    expect(s).toEqual({
      samples: 0,
      medianPercent: null,
      reach: { p25: 0, p50: 0, p75: 0, p100: 0 },
      byPage: [],
    });
  });

  it('scopes to the tenant — the site_id predicate is bound, never interpolated', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({}),
            };
          },
        };
      },
    };
    await getScrollDepthSummary({ DB: db } as unknown as Env, 'site-XYZ', 30);
    const q = calls.find((c) => c.sql.includes("event_type = 'scroll_depth'"));
    expect(q?.sql).toContain('site_id = ?');
    expect(q?.params).toContain('site-XYZ');
  });
});

describe('getNetworkQualitySummary — first-party visitor connection quality', () => {
  /** D1 stub returning the given network rows for the network_quality query. */
  function netEnv(
    rows: Array<{
      etype: string | null;
      downlink: number | null;
      rtt: number | null;
      save_data: number | null;
      path?: string | null;
    }>,
    opts: { error?: boolean } = {},
  ): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => {
                if (opts.error) throw new Error('no such table');
                return { results: sql.includes("event_type = 'network_quality'") ? rows : [] };
              },
              first: async () => null,
              run: async () => ({ success: true }),
              _params: params,
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }
  const row = (
    etype: string | null,
    downlink: number | null,
    rtt: number | null,
    save_data: number | null,
  ) => ({
    etype,
    downlink,
    rtt,
    save_data,
  });

  it('distributes by effectiveType (slow→fast) + medians downlink/rtt + save-data %', async () => {
    const rows = [
      row('4g', 10, 50, 0),
      row('4g', 8, 70, 0),
      row('3g', 2, 300, 1),
      row('slow-2g', 0.4, 1200, 1),
    ];
    const s = await getNetworkQualitySummary(netEnv(rows), 'site_1', 30);
    expect(s.samples).toBe(4);
    // ordered worst→best, only classes seen
    expect(s.byEffectiveType).toEqual([
      { type: 'slow-2g', count: 1 },
      { type: '3g', count: 1 },
      { type: '4g', count: 2 },
    ]);
    expect(s.medianRttMs).toBe(70); // nearest-rank p50 of [50,70,300,1200] → index 1 = 70
    expect(s.saveDataPercent).toBe(50); // 2 of 4 with save-data on
    expect(s.medianDownlinkMbps).toBe(2); // nearest-rank p50 of [0.4,2,8,10] → 2
  });

  it('ignores unknown effectiveType classes + non-finite downlink/rtt (never fabricated)', async () => {
    const rows = [row('lte', Number.NaN, -5, null), row('4g', 5, 40, 0)];
    const s = await getNetworkQualitySummary(netEnv(rows), 'site_1', 30);
    expect(s.samples).toBe(2); // both counted as samples
    expect(s.byEffectiveType).toEqual([{ type: '4g', count: 1 }]); // 'lte' dropped
    expect(s.medianRttMs).toBe(40); // only the valid rtt
    expect(s.saveDataPercent).toBe(0); // only one row carried save_data (false)
  });

  it('no samples → empty summary (null medians, "measuring…", never a fabricated 0)', async () => {
    const s = await getNetworkQualitySummary(netEnv([]), 'site_1', 30);
    expect(s).toEqual({
      samples: 0,
      byEffectiveType: [],
      medianDownlinkMbps: null,
      medianRttMs: null,
      saveDataPercent: null,
      byPage: [],
    });
  });

  it('ranks pages by SLOWEST median downlink (lowest first), floor-gated, each with median rtt', async () => {
    // /heavy: 5 visits on slow links (~1.5 Mbps). /light: 5 on fast (~20 Mbps). /thin: 2 → below floor.
    const rows = [
      ...Array.from({ length: 5 }, () => ({
        etype: '3g',
        downlink: 1.5,
        rtt: 300,
        save_data: 0,
        path: '/heavy',
      })),
      ...Array.from({ length: 5 }, () => ({
        etype: '4g',
        downlink: 20,
        rtt: 40,
        save_data: 0,
        path: '/light',
      })),
      ...Array.from({ length: 2 }, () => ({
        etype: '4g',
        downlink: 15,
        rtt: 50,
        save_data: 0,
        path: '/thin',
      })),
    ];
    const s = await getNetworkQualitySummary(netEnv(rows), 'site_1', 30);
    expect(s.byPage.map((p) => p.path)).toEqual(['/heavy', '/light']); // slowest-connection first; /thin dropped
    expect(s.byPage[0]).toEqual({
      path: '/heavy',
      medianDownlinkMbps: 1.5,
      medianRttMs: 300,
      samples: 5,
    });
    expect(s.byPage[1].medianDownlinkMbps).toBe(20);
  });

  it('fail-soft — a query error yields the empty summary, never throws', async () => {
    const s = await getNetworkQualitySummary(netEnv([], { error: true }), 'site_1', 30);
    expect(s.samples).toBe(0);
    expect(s.medianRttMs).toBeNull();
  });

  it('scopes to the tenant — the site_id predicate is bound, never interpolated', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({}),
            };
          },
        };
      },
    };
    await getNetworkQualitySummary({ DB: db } as unknown as Env, 'site-NET', 30);
    const q = calls.find((c) => c.sql.includes("event_type = 'network_quality'"));
    expect(q?.sql).toContain('site_id = ?');
    expect(q?.params).toContain('site-NET');
  });
});

describe('getNavTimingSummary — first-party page-load waterfall', () => {
  type NavRow = {
    dns: number | null;
    connect: number | null;
    ttfb: number | null;
    transfer: number | null;
    dom: number | null;
    total: number | null;
    path?: string | null;
  };
  /** D1 stub returning the given nav rows for the nav_timing query. */
  function navEnv(rows: NavRow[], opts: { error?: boolean } = {}): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => {
                if (opts.error) throw new Error('no such table');
                return { results: sql.includes("event_type = 'nav_timing'") ? rows : [] };
              },
              first: async () => null,
              run: async () => ({ success: true }),
              _params: params,
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }
  const row = (
    dns: number,
    connect: number,
    ttfb: number,
    transfer: number,
    dom: number,
    total: number,
  ): NavRow => ({
    dns,
    connect,
    ttfb,
    transfer,
    dom,
    total,
  });

  it('computes the MEDIAN of every phase (dns/connect/ttfb/transfer/dom/total)', async () => {
    const rows = [
      row(10, 20, 100, 30, 200, 400),
      row(20, 40, 200, 60, 400, 800),
      row(30, 60, 300, 90, 600, 1200),
    ];
    const s = await getNavTimingSummary(navEnv(rows), 'site_1', 30);
    expect(s.samples).toBe(3);
    // nearest-rank p50 of 3 values → the middle
    expect(s).toMatchObject({
      dns: 20,
      connect: 40,
      ttfb: 200,
      transfer: 60,
      dom: 400,
      total: 800,
    });
  });

  it('KEEPS honest 0 phases (cached DNS / reused connection) — 0 is a real datum, not "no data"', async () => {
    const rows = [row(0, 0, 120, 15, 180, 350), row(0, 0, 130, 25, 220, 450)];
    const s = await getNavTimingSummary(navEnv(rows), 'site_1', 30);
    expect(s.dns).toBe(0); // median of [0,0] = 0 (kept, not dropped)
    expect(s.connect).toBe(0);
    expect(s.samples).toBe(2);
  });

  it('no samples → all-null summary (measuring…, never a fabricated 0)', async () => {
    const s = await getNavTimingSummary(navEnv([]), 'site_1', 30);
    expect(s).toEqual({
      samples: 0,
      dns: null,
      connect: null,
      ttfb: null,
      transfer: null,
      dom: null,
      total: null,
      byPage: [],
    });
  });

  it('ranks the slowest pages by median total load, each with its median TTFB (floor-gated, worst-first)', async () => {
    const rows: NavRow[] = [
      // /checkout: 5 samples, slow total + high server-wait (TTFB). / : 5 samples, faster.
      // /thin: 2 samples → below the 5-sample floor → dropped.
      ...Array.from({ length: 5 }, () => ({
        ...row(10, 20, 800, 60, 400, 3000),
        path: '/checkout',
      })),
      ...Array.from({ length: 5 }, () => ({ ...row(10, 20, 100, 60, 400, 1000), path: '/' })),
      ...Array.from({ length: 2 }, () => ({ ...row(10, 20, 50, 60, 400, 500), path: '/thin' })),
    ];
    const s = await getNavTimingSummary(navEnv(rows), 'site_1', 30);
    expect(s.byPage.map((p) => p.path)).toEqual(['/checkout', '/']); // worst-first by total; /thin dropped
    expect(s.byPage[0]).toEqual({ path: '/checkout', total: 3000, ttfb: 800, samples: 5 });
    expect(s.byPage[1]).toEqual({ path: '/', total: 1000, ttfb: 100, samples: 5 });
  });

  it('fail-soft — a query error yields the empty summary, never throws', async () => {
    const s = await getNavTimingSummary(navEnv([], { error: true }), 'site_1', 30);
    expect(s.samples).toBe(0);
    expect(s.total).toBeNull();
  });

  it('scopes to the tenant — the site_id predicate is bound, never interpolated', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({}),
            };
          },
        };
      },
    };
    await getNavTimingSummary({ DB: db } as unknown as Env, 'site-NAV', 30);
    const q = calls.find((c) => c.sql.includes("event_type = 'nav_timing'"));
    expect(q?.sql).toContain('site_id = ?');
    expect(q?.params).toContain('site-NAV');
  });
});

describe('getOutboundClicksSummary — top clicked outbound/contact links', () => {
  /** D1 stub returning the given grouped-by-href rows for the outbound-clicks query. */
  function obEnv(
    rows: Array<{ href: string | null; kind: string | null; n: number }>,
    opts: { error?: boolean } = {},
  ): Env {
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => {
                if (opts.error) throw new Error('no such table');
                // the query groups conversion events by their stored href
                return {
                  results:
                    sql.includes("event_type = 'conversion'") &&
                    sql.includes("json_extract(metadata, '$.href')")
                      ? rows
                      : [],
                };
              },
              first: async () => null,
              run: async () => ({ success: true }),
              _params: params,
            };
          },
        };
      },
    };
    return { DB: db } as unknown as Env;
  }

  it('returns the top links (with kind) + a total across ALL link-clicks', async () => {
    const rows = [
      { href: 'tel:+15551234567', kind: 'call', n: 40 },
      { href: 'https://instagram.com/biz', kind: 'outbound', n: 12 },
      { href: 'mailto:hi@biz.com', kind: 'email', n: 5 },
    ];
    const s = await getOutboundClicksSummary(obEnv(rows), 'site_1', 30);
    expect(s.total).toBe(57); // 40 + 12 + 5, across all links
    expect(s.byLink[0]).toEqual({ href: 'tel:+15551234567', kind: 'call', count: 40 });
    expect(s.byLink.map((l) => l.href)).toEqual([
      'tel:+15551234567',
      'https://instagram.com/biz',
      'mailto:hi@biz.com',
    ]);
  });

  it('caps byLink at the top 8 but total counts every link', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      href: `https://x.test/${i}`,
      kind: 'outbound',
      n: 12 - i,
    }));
    const s = await getOutboundClicksSummary(obEnv(rows), 'site_1', 30);
    expect(s.byLink).toHaveLength(8); // top 8 shown
    expect(s.total).toBe(rows.reduce((a, r) => a + r.n, 0)); // total = all 12
  });

  it('no link-clicks → {total:0, byLink:[]} (never a fabricated 0)', async () => {
    const s = await getOutboundClicksSummary(obEnv([]), 'site_1', 30);
    expect(s).toEqual({ total: 0, byLink: [] });
  });

  it('fail-soft — a query error yields the empty summary, never throws', async () => {
    const s = await getOutboundClicksSummary(obEnv([], { error: true }), 'site_1', 30);
    expect(s).toEqual({ total: 0, byLink: [] });
  });

  it('scopes to the tenant — the site_id predicate is bound, never interpolated', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({}),
            };
          },
        };
      },
    };
    await getOutboundClicksSummary({ DB: db } as unknown as Env, 'site-OB', 30);
    const q = calls.find((c) => c.sql.includes("json_extract(metadata, '$.href')"));
    expect(q?.sql).toContain('site_id = ?');
    expect(q?.sql).toContain("event_type = 'conversion'");
    expect(q?.params).toContain('site-OB');
  });
});
