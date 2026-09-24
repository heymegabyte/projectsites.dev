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
  getConversionKinds,
  getPreviousConversionKinds,
  getDimensionBreakdown,
  getCampaignBreakdown,
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
      (c) => c.sql.includes('COUNT(*)') && c.sql.includes("event_type = 'pageview'") && !c.sql.includes('DATE('),
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
    const s = await getTrafficSummary(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    expect(s.windowDays).toBe(15);
  });

  it('keeps the relative datetime(now) window when NO absolute window is given', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30);

    const pageviews = calls.find(
      (c) => c.sql.includes('COUNT(*)') && c.sql.includes("event_type = 'pageview'") && !c.sql.includes('DATE('),
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
    await getPreviousConversionKinds(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
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
    await getDimensionBreakdown(env, 'site_1', 'browser', 30, { since: '2026-08-01', until: '2026-08-16' });
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

  it('getCampaignBreakdown groups TAGGED pageviews by the UTM param, EXCLUDING untagged (null)', async () => {
    const { env, calls } = captureEnv();
    await getCampaignBreakdown(env, 'site_1', 'utmSource', 30, { since: '2026-08-01', until: '2026-08-16' });
    const q = calls.find((c) => c.sql.includes("json_extract(metadata, '$.utmSource')"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain("event_type = 'pageview'");
    // The untagged direct/organic majority (NULL) must be filtered OUT — a campaign
    // breakdown never buckets untagged traffic as a giant "unknown".
    expect(q!.sql).toContain('IS NOT NULL');
    expect(q!.sql).toContain('GROUP BY label');
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('getCampaignBreakdown REJECTS a non-allowlisted UTM dimension (never interpolates it)', async () => {
    const { env, calls } = captureEnv();
    const out = await getCampaignBreakdown(env, 'site_1', "utmSource'); DROP" as never, 30);
    expect(out).toEqual([]);
    expect(calls.some((c) => c.sql.includes('DROP'))).toBe(false);
  });

  it('getTrafficSummary wires byBrowser + byOs + byUtmSource + byUtmCampaign (present + defaulted [])', async () => {
    const { env } = captureEnv();
    const s = await getTrafficSummary(env, 'site_1', 30);
    expect(Array.isArray(s.byBrowser)).toBe(true);
    expect(Array.isArray(s.byOs)).toBe(true);
    expect(s.byBrowser).toEqual([]);
    expect(s.byOs).toEqual([]);
    // AN-UTM: campaign attribution wired into the summary, honestly empty for an untagged site.
    expect(s.byUtmSource).toEqual([]);
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
