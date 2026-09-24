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

import { getTrafficSummary, getWebVitalsSummary, getConversionKinds } from '../service.js';
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

  it('web-vitals keeps the relative window with no absolute window', async () => {
    const { env, calls } = captureEnv();
    await getWebVitalsSummary(env, 'site_1', 7);
    const q = calls.find((c) => c.sql.includes("event_type = 'web_vital'"));
    expect(q!.sql).toContain("datetime('now', ?)");
    expect(q!.params).toEqual(['site_1', '-7 days']);
  });
});
