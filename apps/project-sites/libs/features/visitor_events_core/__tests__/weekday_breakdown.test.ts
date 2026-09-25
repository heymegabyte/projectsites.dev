/**
 * getWeekdayBreakdown — pageviews by day-of-week (0=Sun…6=Sat) over the window. Unlike
 * hour-of-day (rotatable client-side), a weekday histogram MUST be bucketed in the owner's
 * local tz IN SQL. This spec locks:
 *   - the tz-correct SQL expression (east-positive offset → `datetime(created_at, '±N minutes')`),
 *   - the UTC fallback + honest `tzApplied:false` for a 0 / absent / out-of-range offset,
 *   - pageview-only + GROUP BY weekday,
 *   - row mapping + out-of-range weekday rejection,
 *   - fail-soft empty.
 */

import { getWeekdayBreakdown } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

interface Cap {
  sql: string;
  params: unknown[];
}

/** D1 stub: dbQuery calls prepare(sql).bind(...params).all() → { results }. */
function stubEnv(rows: unknown[], cap?: Cap): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          if (cap) {
            cap.sql = sql;
            cap.params = params;
          }
          return {
            all: async () => ({ results: rows }),
            first: async () => rows[0] ?? null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe('getWeekdayBreakdown (day-of-week — tz-correct local bucketing)', () => {
  it('maps rows to { weekday, count } and reports tzApplied', async () => {
    const rows = [
      { wd: 0, n: 5 },
      { wd: 6, n: 12 },
    ];
    const out = await getWeekdayBreakdown(stubEnv(rows), 'site_1', 30, undefined, undefined, -480);
    expect(out.byWeekday).toEqual([
      { weekday: 0, count: 5 },
      { weekday: 6, count: 12 },
    ]);
    expect(out.tzApplied).toBe(true);
  });

  it('buckets in the OWNER local tz — a west offset (PST -480) shifts by -480 minutes', async () => {
    const cap: Cap = { sql: '', params: [] };
    const out = await getWeekdayBreakdown(stubEnv([], cap), 'site_1', 30, undefined, undefined, -480);
    expect(cap.sql).toMatch(/strftime\('%w', datetime\(created_at, '-480 minutes'\)\)/);
    expect(cap.sql).toMatch(/event_type = 'pageview'/);
    expect(cap.sql).toMatch(/GROUP BY wd/);
    expect(out.tzApplied).toBe(true);
  });

  it('an EAST offset (IST +330) shifts by +330 minutes (explicit + sign)', async () => {
    const cap: Cap = { sql: '', params: [] };
    await getWeekdayBreakdown(stubEnv([], cap), 'site_1', 30, undefined, undefined, 330);
    expect(cap.sql).toMatch(/datetime\(created_at, '\+330 minutes'\)/);
  });

  it('falls back to UTC weekday (no datetime modifier) + tzApplied:false for a 0 / absent offset', async () => {
    const cap: Cap = { sql: '', params: [] };
    const noTz = await getWeekdayBreakdown(stubEnv([], cap), 'site_1', 30);
    expect(cap.sql).toMatch(/strftime\('%w', created_at\)/);
    expect(cap.sql).not.toMatch(/datetime\(created_at/);
    expect(noTz.tzApplied).toBe(false);

    const zeroTz = await getWeekdayBreakdown(stubEnv([], cap), 'site_1', 30, undefined, undefined, 0);
    expect(zeroTz.tzApplied).toBe(false);
    expect(cap.sql).not.toMatch(/datetime\(created_at/);
  });

  it('rejects an out-of-range offset (> ±14h) → UTC fallback (guards a junk client value)', async () => {
    const cap: Cap = { sql: '', params: [] };
    const out = await getWeekdayBreakdown(stubEnv([], cap), 'site_1', 30, undefined, undefined, 9999);
    expect(cap.sql).toMatch(/strftime\('%w', created_at\)/);
    expect(out.tzApplied).toBe(false);
  });

  it('drops rows whose weekday is outside 0–6 (never a fabricated bucket)', async () => {
    const rows = [
      { wd: 3, n: 4 },
      { wd: 9, n: 99 },
      { wd: null, n: 7 },
    ];
    const out = await getWeekdayBreakdown(stubEnv(rows), 'site_1', 30, undefined, undefined, -300);
    expect(out.byWeekday).toEqual([{ weekday: 3, count: 4 }]);
  });

  it('returns an honest empty (never throws) when there are no pageviews', async () => {
    const out = await getWeekdayBreakdown(stubEnv([]), 'site_1');
    expect(out).toEqual({ byWeekday: [], tzApplied: false });
  });
});
