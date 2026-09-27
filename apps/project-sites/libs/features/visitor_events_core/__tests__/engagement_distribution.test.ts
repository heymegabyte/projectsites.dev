/**
 * AN-ENGAGE-DIST — getEngagementSummary now also returns a dwell DISTRIBUTION: the count of
 * visits whose time-on-page reached each threshold (≥10s / ≥30s / ≥60s / ≥180s). The dwell
 * analogue of the scroll-depth reach funnel — it shows the SPREAD the median point hides.
 *
 * Contract this suite locks: counts are monotonic (s10 ≥ s30 ≥ s60 ≥ s180), a dwell exactly at a
 * threshold reaches it (>=), an empty/errored query yields an all-0 distribution + null median
 * (never a fabricated 0-as-data), and the query stays scoped to `site_id` + `page_engagement`
 * with the drilldown filter bound.
 *
 * Reuses the param-capturing D1 stub pattern from form_funnel.test.ts.
 */

import { getEngagementSummary } from '../service.js';
import type { AnalyticsFilter } from '../schemas.js';
import type { Env } from '../../../../src/types/env.js';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type Row = { path: string | null; duration: number };

/** D1 stub returning `rows` for the engagement query + capturing (sql, params). */
function engEnv(rows: Row[]): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            all: async () => ({ results: rows as unknown[] }),
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

/** D1 stub whose query throws — proves the fail-soft path returns an all-0 distribution. */
function errorEnv(): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => {
              throw new Error('no such table: visitor_events');
            },
            first: async () => null,
            run: async () => ({ success: false, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

const EMPTY_DIST = { s10: 0, s30: 0, s60: 0, s180: 0 };

describe('getEngagementSummary — dwell distribution', () => {
  it('counts visits reaching each threshold, monotonically', async () => {
    const { env } = engEnv([
      { path: '/', duration: 5000 }, // <10s — in no bucket
      { path: '/', duration: 15000 }, // ≥10s
      { path: '/a', duration: 45000 }, // ≥30s
      { path: '/b', duration: 90000 }, // ≥60s
      { path: '/c', duration: 200000 }, // ≥180s
    ]);
    const r = await getEngagementSummary(env, 'site_1', 30);
    expect(r.samples).toBe(5);
    expect(r.distribution).toEqual({ s10: 4, s30: 3, s60: 2, s180: 1 });
    const d = r.distribution;
    expect(d.s10 >= d.s30 && d.s30 >= d.s60 && d.s60 >= d.s180).toBe(true); // monotonic
  });

  it('counts a dwell exactly at a threshold as reaching it (>=)', async () => {
    const { env } = engEnv([{ path: '/', duration: 30000 }]);
    const r = await getEngagementSummary(env, 'site_1', 30);
    expect(r.distribution.s10).toBe(1);
    expect(r.distribution.s30).toBe(1); // 30000 >= 30000
    expect(r.distribution.s60).toBe(0);
  });

  it('honest empty — no samples → all-0 distribution + null median (never fabricated)', async () => {
    const { env } = engEnv([]);
    const r = await getEngagementSummary(env, 'site_1', 30);
    expect(r.medianMs).toBeNull();
    expect(r.samples).toBe(0);
    expect(r.distribution).toEqual(EMPTY_DIST);
  });

  it('fail-soft on query error — all-0 distribution, never throws', async () => {
    const r = await getEngagementSummary(errorEnv(), 'site_1', 30);
    expect(r.distribution).toEqual(EMPTY_DIST);
    expect(r.samples).toBe(0);
  });

  it('scopes the query to site_id + page_engagement (tenant boundary)', async () => {
    const { env, calls } = engEnv([]);
    await getEngagementSummary(env, 'site_X', 30);
    const q = calls[0];
    expect(q.sql).toContain("event_type = 'page_engagement'");
    expect(q.sql).toContain('site_id = ?');
    expect(q.params[0]).toBe('site_X');
  });

  it('threads the drilldown filter as a BOUND value', async () => {
    const { env, calls } = engEnv([]);
    await getEngagementSummary(env, 'site_1', 30, undefined, {
      dim: 'device',
      value: 'mobile',
    } as AnalyticsFilter);
    expect(calls[0].sql).toContain("json_extract(metadata, '$.device') = ?");
    expect(calls[0].params).toContain('mobile');
  });
});
