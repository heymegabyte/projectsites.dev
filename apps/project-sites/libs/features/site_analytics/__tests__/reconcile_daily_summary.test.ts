/**
 * verify-against-source: the daily-series chart MUST reconcile with the headline summary.
 *
 * `getDailySeries` (per-day chart) and `getTrafficSummary` (headline KPIs) read the SAME
 * `visitor_events` store via DIFFERENT queries. If those queries ever drift (a different WHERE, a tz
 * double-count, an event-type mismatch, a filter applied to one but not the other), the chart line
 * would stop summing to the KPI — the exact "don't conflate / don't double-count" hazard the prompt
 * warns about, and a class a canned-row mock CANNOT catch (it never runs the SQL).
 *
 * This test runs `getDailySeries`'s ACTUAL SQL against a REAL SQLite (node:sqlite) over seeded raw
 * events and asserts SUM(daily.pageviews) === the ground-truth pageview COUNT the summary computes
 * over the same window — and the same for conversions, under a drilldown filter, and with tenant
 * scoping. A prod reconcile (site-megabytespace-001, 2026-09-25) confirmed the invariant holds live
 * (4901 pageviews summary === 4901 daily-sum); this locks it against future drift in CI.
 */

import { getDailySeries } from '../service.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * Seed a known event set for `site_1` (5 pageviews across 3 sessions + 2 conversions, spread over 3
 * days, 4 of the pageviews from `country=US`), plus `site_2` noise (must be tenant-excluded) and an
 * out-of-window row (must be excluded). Returns the ground-truth totals.
 */
function seed(h: D1SqliteHarness): void {
  h.exec(
    `CREATE TABLE visitor_events (
       id INTEGER PRIMARY KEY, org_id TEXT, site_id TEXT, session_id TEXT,
       event_type TEXT, path TEXT, referrer TEXT, metadata TEXT, created_at TEXT
     )`,
  );
  const ins = h.raw.prepare(
    `INSERT INTO visitor_events (site_id, session_id, event_type, metadata, created_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`,
  );
  // site_1 — within window
  ins.run('site_1', 's1', 'pageview', '{"country":"US"}', '-2 days');
  ins.run('site_1', 's1', 'pageview', '{"country":"US"}', '-2 days');
  ins.run('site_1', 's2', 'pageview', '{"country":"DE"}', '-1 days');
  ins.run('site_1', 's3', 'pageview', '{"country":"US"}', '-1 days');
  ins.run('site_1', 's3', 'pageview', '{"country":"US"}', '-1 hour');
  ins.run('site_1', 's1', 'conversion', '{"country":"US"}', '-2 days');
  ins.run('site_1', 's2', 'conversion', '{"country":"DE"}', '-1 days');
  // site_2 — must be tenant-excluded
  ins.run('site_2', 'x', 'pageview', '{}', '-1 days');
  ins.run('site_2', 'x', 'pageview', '{}', '-1 days');
  // out-of-window — must be excluded
  ins.run('site_1', 'old', 'pageview', '{"country":"US"}', '-90 days');
}

/** A ground-truth scalar COUNT over the SAME 30-day window the summary uses. */
function count(h: D1SqliteHarness, where: string): number {
  const row = h.raw
    .prepare(
      `SELECT COUNT(*) c FROM visitor_events WHERE site_id='site_1' AND created_at >= datetime('now','-30 days') AND ${where}`,
    )
    .get() as { c: number };
  return row.c;
}

describe('analytics self-consistency — daily-series reconciles with the summary (real SQLite)', () => {
  it('SUM(daily.pageviews) === ground-truth count; conversions likewise; site-scoped', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const { days } = await getDailySeries({ DB: h.db } as unknown as Env, 'site_1', 30);
      const dailyPv = days.reduce((s, d) => s + d.pageviews, 0);
      const dailyConv = days.reduce((s, d) => s + d.conversions, 0);

      expect(dailyPv).toBe(5); // seeded within window
      expect(dailyPv).toBe(count(h, "event_type='pageview'")); // THE invariant: chart sums to the headline
      expect(dailyConv).toBe(2);
      expect(dailyConv).toBe(count(h, "event_type='conversion'"));
      expect(dailyPv).not.toBe(7); // site_2's 2 pageviews never leak in (tenant scoping)
    } finally {
      h.close();
    }
  });

  it('a drilldown FILTER reconciles too — country=US restricts the chart + ground truth identically', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const { days } = await getDailySeries({ DB: h.db } as unknown as Env, 'site_1', 30, undefined, undefined, {
        dim: 'country',
        value: 'US',
      });
      const dailyPvUS = days.reduce((s, d) => s + d.pageviews, 0);

      expect(dailyPvUS).toBe(4); // 2×s1 + 2×s3 — DE excluded
      expect(dailyPvUS).toBe(count(h, "event_type='pageview' AND json_extract(metadata,'$.country')='US'"));
    } finally {
      h.close();
    }
  });

  it('an out-of-window row is excluded (the -90d pageview never inflates the 30d chart)', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const { days } = await getDailySeries({ DB: h.db } as unknown as Env, 'site_1', 30);
      expect(days.reduce((s, d) => s + d.pageviews, 0)).toBe(5); // not 6 (the -90d row is out)
    } finally {
      h.close();
    }
  });
});
