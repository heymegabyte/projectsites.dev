/**
 * AN-FILTER — tenant-safe drilldown filter on getTrafficSummary + the breakdown helpers.
 *
 * A filter `{ dim, value }` restricts the WHOLE summary to events matching one dimension
 * (e.g. country=US) so an owner can ask "device split FOR my US visitors". The security
 * contract this suite locks:
 *   - the dimension COLUMN is always a trusted literal from FILTER_DIMENSION_SQL (never a
 *     client string); the VALUE is always a bound `?` param — no interpolation, no injection,
 *   - the filter only ever NARROWS within the already-`site_id`-scoped set (every query still
 *     binds site_id first — a filter can never widen or cross a tenant boundary),
 *   - the current AND previous windows carry the SAME filter (like-for-like comparison),
 *   - an UNKNOWN dimension is a no-op at the SQL layer (defense in depth behind the route's
 *     allowlist), never an interpolated raw string,
 *   - a filtered request FORCES the live scan and never returns unfiltered rollup totals.
 *
 * Reuses the param-capturing D1 stub pattern from custom_window.test.ts.
 */

// The rollup-read flag is mocked ON for the whole file so the "filter skips rollup" test
// is meaningful (without the mock, an empty stub DB reports the flag OFF → live anyway).
// 4× `../` reaches src/ from a libs/features/<slug>/__tests__ file; use the GLOBAL jest so
// @swc/jest hoists the mock above the service import (see apps CLAUDE.md gotchas #11/#12).
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(async () => true),
}));

import {
  getTrafficSummary,
  getWebVitalsSummary,
  getConversionKinds,
  getPreviousConversionKinds,
  getDimensionBreakdown,
} from '../service.js';
import type { AnalyticsFilter } from '../schemas.js';
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

/** The headline pageviews scalar — a live-path-only query (the rollup uses SUM(pageviews)). */
function pageviewCount(calls: Call[]): Call | undefined {
  return calls.find(
    (c) =>
      c.sql.includes('COUNT(*)') &&
      c.sql.includes("event_type = 'pageview'") &&
      !c.sql.includes('DATE('),
  );
}

describe('getTrafficSummary — drilldown filter (relative window)', () => {
  it('appends a BOUND `AND <col> = ?` restriction for a metadata dimension', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30, undefined, { dim: 'country', value: 'US' });

    const pv = pageviewCount(calls);
    expect(pv).toBeDefined();
    expect(pv!.sql).toContain("json_extract(metadata, '$.country') = ?");
    // siteId + relative-window modifier + the bound filter value — in that order.
    expect(pv!.params).toEqual(['site_1', '-30 days', 'US']);
    // The value is a param, never spliced into the SQL text.
    expect(pv!.sql).not.toContain('US');
  });

  it('uses the `path` COLUMN (not json_extract) for a path filter', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30, undefined, { dim: 'path', value: '/pricing' });
    const pv = pageviewCount(calls);
    expect(pv!.sql).toContain('AND path = ?');
    expect(pv!.sql).not.toContain("json_extract(metadata, '$.path')");
    expect(pv!.params).toEqual(['site_1', '-30 days', '/pricing']);
  });

  it('applies the SAME filter to the previous (comparison) window', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 7, undefined, { dim: 'device', value: 'mobile' });
    // The prev-window pageviews scalar binds [now-2N, now-N) + the filter value.
    const prev = calls.find(
      (c) =>
        c.sql.includes("event_type = 'pageview'") &&
        c.sql.includes("json_extract(metadata, '$.device') = ?") &&
        (c.params as unknown[]).includes('-14 days'),
    );
    expect(prev).toBeDefined();
    expect(prev!.params).toEqual(['site_1', '-14 days', '-7 days', 'mobile']);
  });

  it('threads the filter into the web-vital query too (whole summary is coherent)', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30, undefined, { dim: 'country', value: 'GB' });
    const wv = calls.find((c) => c.sql.includes("event_type = 'web_vital'"));
    expect(wv).toBeDefined();
    expect(wv!.sql).toContain("json_extract(metadata, '$.country') = ?");
    expect(wv!.params).toContain('GB');
  });
});

describe('getTrafficSummary — tenant isolation (a filter can only NARROW)', () => {
  it('EVERY query still binds site_id first — the filter never removes the site scope', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_ISOLATED', 30, undefined, { dim: 'country', value: 'US' });
    expect(calls.length).toBeGreaterThan(0);
    // No captured query may target another site or drop the site predicate.
    for (const c of calls) {
      expect(c.sql).toContain('site_id = ?');
      expect(c.params[0]).toBe('site_ISOLATED');
    }
  });

  it('an UNKNOWN dimension is a SQL no-op (defense in depth) — never interpolated', async () => {
    const { env, calls } = captureEnv();
    // The route rejects this at the boundary; here we prove that even IF a bad dim reached
    // the service, the column lookup misses → no clause, no bound value, no injection.
    await getTrafficSummary(env, 'site_1', 30, undefined, {
      dim: 'metadata) = 1; DROP TABLE visitor_events;--',
      value: 'x',
    } as unknown as AnalyticsFilter);
    const pv = pageviewCount(calls);
    expect(pv!.params).toEqual(['site_1', '-30 days']); // value never bound
    for (const c of calls) {
      expect(c.sql).not.toContain('DROP TABLE');
      expect(c.params).not.toContain('x');
    }
  });
});

describe('getTrafficSummary — a filter FORCES the live scan (never the rollup)', () => {
  it('skips the rollup even when the rollup-read flag is ON', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30, undefined, { dim: 'country', value: 'US' });
    // Live path uses COUNT(*) event_type='pageview'; the rollup uses SUM(pageviews).
    expect(calls.some((c) => c.sql.includes('SUM(pageviews)'))).toBe(false);
    expect(pageviewCount(calls)).toBeDefined();
  });

  it('CONTROL: with NO filter + flag ON, it DOES use the rollup (proves the mock is live)', async () => {
    const { env, calls } = captureEnv();
    await getTrafficSummary(env, 'site_1', 30);
    expect(calls.some((c) => c.sql.includes('SUM(pageviews)'))).toBe(true);
  });
});

describe('breakdown helpers thread the filter to their own clause', () => {
  it('getDimensionBreakdown carries the bound filter', async () => {
    const { env, calls } = captureEnv();
    await getDimensionBreakdown(env, 'site_1', 'browser', 30, undefined, {
      dim: 'country',
      value: 'US',
    });
    const q = calls.find((c) => c.sql.includes("json_extract(metadata, '$.browser') AS label"));
    expect(q).toBeDefined();
    expect(q!.sql).toContain("json_extract(metadata, '$.country') = ?");
    expect(q!.params).toEqual(['site_1', '-30 days', 'US']);
  });

  it('getWebVitalsSummary carries the bound filter', async () => {
    const { env, calls } = captureEnv();
    await getWebVitalsSummary(env, 'site_1', 30, undefined, { dim: 'path', value: '/home' });
    const q = calls.find((c) => c.sql.includes("event_type = 'web_vital'"));
    expect(q!.sql).toContain('AND path = ?');
    expect(q!.params).toEqual(['site_1', '-30 days', '/home']);
  });

  it('getConversionKinds + getPreviousConversionKinds both carry the filter', async () => {
    const cur = captureEnv();
    await getConversionKinds(cur.env, 'site_1', 30, undefined, {
      dim: 'channel',
      value: 'organic',
    });
    const cq = cur.calls.find((c) => c.sql.includes("event_type = 'conversion'"));
    expect(cq!.sql).toContain("json_extract(metadata, '$.channel') = ?");
    expect(cq!.params).toEqual(['site_1', '-30 days', 'organic']);

    const prev = captureEnv();
    await getPreviousConversionKinds(prev.env, 'site_1', 7, undefined, {
      dim: 'channel',
      value: 'organic',
    });
    const pq = prev.calls.find((c) => c.sql.includes("event_type = 'conversion'"));
    expect(pq!.params).toEqual(['site_1', '-14 days', '-7 days', 'organic']);
  });
});
