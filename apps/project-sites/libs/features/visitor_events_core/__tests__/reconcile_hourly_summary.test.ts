/**
 * verify-against-source: the "busiest hours" breakdown MUST reconcile with the headline pageviews.
 *
 * `getHourlyBreakdown` (the 24-bucket hour-of-day chart) and `getTrafficSummary` (the headline KPIs)
 * read the SAME `visitor_events` store via DIFFERENT queries. Every pageview has a `created_at`, so
 * `strftime('%H', created_at)` always lands in exactly one 0–23 bucket → the hourly bars MUST sum to
 * the true pageview count and to `summary.pageviews`. If those queries ever drift (a different WHERE,
 * an `event_type` mismatch that lets conversions inflate the pageview bars, a tz double-count, a
 * filter applied to one but not the other), the hourly chart would stop summing to the headline — the
 * exact "don't conflate / don't double-count pageviews vs client-events" hazard the analytics prompt
 * warns about, and a class a canned-row mock CANNOT catch (it never runs the SQL).
 *
 * This runs the ACTUAL aggregator SQL against a REAL SQLite (node:sqlite) over seeded raw events and
 * asserts SUM(byHour.count) === ground-truth pageview COUNT === getTrafficSummary().pageviews, under a
 * drilldown filter, with conversions present (they must NOT inflate the pageview bars), with tenant
 * scoping, and with an out-of-window row. Extends the daily↔summary reconciler (reconcile_daily_summary)
 * to a SECOND time-cut so both chart surfaces are drift-locked to the same headline in CI.
 */

import { getHourlyBreakdown, getTrafficSummary } from '../service.js';
import {
  createD1Sqlite,
  type D1SqliteHarness,
} from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * Seed a known event set for `site_1`: 5 pageviews spread across distinct hours/days (4 from
 * country=US), 2 conversions (must NOT count as pageviews in the hourly bars), `site_2` noise
 * (tenant-excluded) and an out-of-window row (excluded). Distinct hour offsets exercise multiple
 * buckets so the cross-bucket SUM is genuinely tested.
 */
function seed(h: D1SqliteHarness): void {
  h.exec(
    `CREATE TABLE visitor_events (
       id INTEGER PRIMARY KEY, org_id TEXT, site_id TEXT, session_id TEXT,
       event_type TEXT, path TEXT, referrer TEXT, metadata TEXT, created_at TEXT
     )`,
  );
  const ins = h.raw.prepare(
    `INSERT INTO visitor_events (site_id, session_id, event_type, path, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?, ?))`,
  );
  // site_1 — 5 pageviews across distinct hour buckets, within the 30-day window
  ins.run('site_1', 's1', 'pageview', '/', '{"country":"US"}', '-2 days', '-1 hours');
  ins.run('site_1', 's1', 'pageview', '/a', '{"country":"US"}', '-2 days', '-3 hours');
  ins.run('site_1', 's2', 'pageview', '/', '{"country":"DE"}', '-1 days', '-6 hours');
  ins.run('site_1', 's3', 'pageview', '/b', '{"country":"US"}', '-1 days', '-9 hours');
  ins.run('site_1', 's3', 'pageview', '/', '{"country":"US"}', '-1 hours', '+0 hours');
  // conversions — MUST NOT inflate the hourly PAGEVIEW breakdown (event_type-drift guard)
  ins.run('site_1', 's1', 'conversion', null, '{"country":"US"}', '-2 days', '-1 hours');
  ins.run('site_1', 's2', 'conversion', null, '{"country":"DE"}', '-1 days', '-6 hours');
  // site_2 — must be tenant-excluded
  ins.run('site_2', 'x', 'pageview', '/', '{}', '-1 days', '+0 hours');
  ins.run('site_2', 'x', 'pageview', '/', '{}', '-1 days', '+0 hours');
  // out-of-window — must be excluded from the 30-day sum
  ins.run('site_1', 'old', 'pageview', '/', '{"country":"US"}', '-90 days', '+0 hours');
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

const env = (h: D1SqliteHarness): Env => ({ DB: h.db }) as unknown as Env;

describe('analytics self-consistency — hourly breakdown reconciles with the summary (real SQLite)', () => {
  it('SUM(byHour) === ground-truth pageviews === summary.pageviews; conversions excluded; site-scoped', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const byHour = await getHourlyBreakdown(env(h), 'site_1', 30);
      const hourlySum = byHour.reduce((s, b) => s + b.count, 0);
      const truth = count(h, "event_type='pageview'");

      expect(hourlySum).toBe(5); // seeded pageviews within window
      expect(hourlySum).toBe(truth); // THE invariant: hourly bars sum to the true pageview count
      expect(hourlySum).not.toBe(7); // the 2 conversions never inflate the PAGEVIEW bars

      // three-way lock: the headline summary agrees with both the bars and ground truth.
      const summary = await getTrafficSummary(env(h), 'site_1', 30);
      expect(summary.pageviews).toBe(truth);
      expect(hourlySum).toBe(summary.pageviews);

      // every bucket is a valid 0–23 hour (no null / out-of-range bucket leaks into the sum).
      expect(byHour.every((b) => b.hour >= 0 && b.hour <= 23)).toBe(true);
      // tenant scoping — site_2's 2 pageviews never leak into site_1's bars.
      expect(hourlySum).not.toBe(7);
    } finally {
      h.close();
    }
  });

  it('a drilldown FILTER reconciles — country=US restricts the hourly bars + ground truth identically', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const byHour = await getHourlyBreakdown(env(h), 'site_1', 30, undefined, {
        dim: 'country',
        value: 'US',
      });
      const sumUS = byHour.reduce((s, b) => s + b.count, 0);

      expect(sumUS).toBe(4); // 4 US pageviews — DE excluded
      expect(sumUS).toBe(
        count(h, "event_type='pageview' AND json_extract(metadata,'$.country')='US'"),
      );
    } finally {
      h.close();
    }
  });

  it('an out-of-window row is excluded (the -90d pageview never inflates the 30d hourly sum)', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const byHour = await getHourlyBreakdown(env(h), 'site_1', 30);
      expect(byHour.reduce((s, b) => s + b.count, 0)).toBe(5); // not 6 (the -90d row is out)
    } finally {
      h.close();
    }
  });
});
