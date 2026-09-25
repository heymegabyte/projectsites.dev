/**
 * verify-against-source: the event-TYPE breakdown MUST reconcile with the headline KPIs.
 *
 * `byType` (the client-event decomposition inside `getTrafficSummary`) groups EVERY event by
 * `event_type` — so it locks a DIFFERENT invariant than the daily/hourly pageview reconcilers:
 *   1. SUM(byType.count) === the count of all TYPED events (event_type NOT NULL/empty). byType
 *      deliberately DROPS null/empty-type rows (service.ts filters `typeof event_type === 'string'`),
 *      so the ground truth must match that filter — a real-SQLite test pins the exact behaviour a
 *      canned mock can't (it never runs the filter).
 *   2. byType['pageview'].count === summary.pageviews AND byType['conversion'].count ===
 *      summary.conversions — the per-type buckets reconcile with the HEADLINE KPIs. This is the
 *      exact "don't CONFLATE pageviews / conversions / client-events" hazard the analytics prompt
 *      warns about: if the byType query ever drifts (a stray event_type filter, a tz double-count,
 *      a filter applied to one surface not another), a bucket would stop matching its KPI.
 *
 * Runs the ACTUAL aggregator SQL against a REAL SQLite (node:sqlite) over seeded raw events, under a
 * drilldown filter, with a null-type row (must be excluded), with tenant scoping, and an out-of-window
 * row. Extends the daily↔summary + hourly↔summary reconcilers to the event-TYPE decomposition.
 */

import { getTrafficSummary } from '../service.js';
import {
  createD1Sqlite,
  type D1SqliteHarness,
} from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * Seed a known typed-event set for `site_1`: 3 pageviews (2 US, 1 DE) + 2 conversions (1 US, 1 DE)
 * + 1 page_engagement (US) = 6 TYPED events; plus 1 NULL-event_type row (US — must be dropped from
 * byType), `site_2` noise (tenant-excluded), and an out-of-window row (excluded).
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
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
  );
  // site_1 — 6 typed events within window (3 pv, 2 conv, 1 engagement)
  ins.run('site_1', 's1', 'pageview', '/', '{"country":"US"}', '-2 days');
  ins.run('site_1', 's2', 'pageview', '/a', '{"country":"US"}', '-1 days');
  ins.run('site_1', 's3', 'pageview', '/b', '{"country":"DE"}', '-1 days');
  ins.run('site_1', 's1', 'conversion', null, '{"country":"US"}', '-2 days');
  ins.run('site_1', 's3', 'conversion', null, '{"country":"DE"}', '-1 days');
  ins.run('site_1', 's2', 'page_engagement', '/a', '{"country":"US"}', '-1 days');
  // a NULL-event_type row — byType filters `typeof event_type === 'string'`, so it MUST be dropped.
  ins.run('site_1', 's4', null, '/', '{"country":"US"}', '-1 days');
  // site_2 — must be tenant-excluded
  ins.run('site_2', 'x', 'pageview', '/', '{}', '-1 days');
  ins.run('site_2', 'x', 'conversion', null, '{}', '-1 days');
  // out-of-window — must be excluded from the 30-day window
  ins.run('site_1', 'old', 'pageview', '/', '{"country":"US"}', '-90 days');
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
const bucket = (byType: { type: string; count: number }[], t: string): number =>
  byType.find((b) => b.type === t)?.count ?? 0;

describe('analytics self-consistency — byType decomposition reconciles with the headline KPIs (real SQLite)', () => {
  it('SUM(byType) === typed-event count; pageview/conversion buckets === headline KPIs; null-type dropped; site-scoped', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const summary = await getTrafficSummary(env(h), 'site_1', 30);
      const byTypeSum = summary.byType.reduce((s, t) => s + t.count, 0);

      // invariant 1 — byType sums to ALL typed events (null-type rows are excluded by the filter).
      expect(byTypeSum).toBe(6);
      expect(byTypeSum).toBe(count(h, "event_type IS NOT NULL AND event_type != ''"));
      expect(byTypeSum).not.toBe(7); // the null-event_type row is NOT counted
      expect(byTypeSum).not.toBe(8); // site_2's 2 events never leak in (tenant scoping)

      // invariant 2 — the per-type buckets reconcile with the HEADLINE KPIs (conflation guard).
      expect(bucket(summary.byType, 'pageview')).toBe(summary.pageviews);
      expect(bucket(summary.byType, 'pageview')).toBe(count(h, "event_type='pageview'"));
      expect(bucket(summary.byType, 'conversion')).toBe(summary.conversions);
      expect(bucket(summary.byType, 'conversion')).toBe(count(h, "event_type='conversion'"));

      // the third type is surfaced too — byType is the FULL client-event decomposition, not just pv/conv.
      expect(bucket(summary.byType, 'page_engagement')).toBe(1);
      // pageviews (3) is NOT the same as total typed events (6) — the distinction byType must preserve.
      expect(summary.pageviews).toBe(3);
    } finally {
      h.close();
    }
  });

  it('a drilldown FILTER reconciles — country=US restricts byType + ground truth identically', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const summary = await getTrafficSummary(env(h), 'site_1', 30, undefined, {
        dim: 'country',
        value: 'US',
      });
      const byTypeSumUS = summary.byType.reduce((s, t) => s + t.count, 0);

      // US typed events: 2 pv + 1 conv + 1 engagement = 4 (DE excluded; null-type US row excluded).
      expect(byTypeSumUS).toBe(4);
      expect(byTypeSumUS).toBe(
        count(
          h,
          "event_type IS NOT NULL AND event_type != '' AND json_extract(metadata,'$.country')='US'",
        ),
      );
      expect(bucket(summary.byType, 'pageview')).toBe(summary.pageviews); // bucket still tracks the KPI under filter
    } finally {
      h.close();
    }
  });

  it('an out-of-window row is excluded (the -90d pageview never inflates byType)', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const summary = await getTrafficSummary(env(h), 'site_1', 30);
      expect(summary.byType.reduce((s, t) => s + t.count, 0)).toBe(6); // not 7 (the -90d row is out)
    } finally {
      h.close();
    }
  });
});
