/**
 * verify-against-source: the conversion-KIND breakdown MUST reconcile with the headline conversions.
 *
 * `byConversionKind` (`getConversionKinds` inside `getTrafficSummary`) groups every `conversion`
 * event by its `$.kind` (call / email / directions / …), coalescing a null/absent kind to `'other'`
 * so NOTHING is dropped. So a clean invariant holds:
 *   SUM(byConversionKind.count) === COUNT(*) WHERE event_type='conversion' === summary.conversions
 * — the exact "don't CONFLATE / don't double-count" hazard the analytics prompt warns about: if the
 * kind query ever drifts (a stray event_type filter that lets pageviews leak in, a dropped null
 * bucket, a filter applied to one surface not another), the kind buckets stop summing to the headline
 * conversions and CI fails. A class a canned-row mock CANNOT catch (it never runs the SQL).
 *
 * Runs the ACTUAL aggregator SQL against a REAL SQLite (node:sqlite) over seeded raw events, under a
 * drilldown filter, with a null-kind conversion (must bucket as 'other', never dropped), with
 * pageviews present (must NOT inflate the conversion-only breakdown), with tenant scoping, and an
 * out-of-window row. Completes the clean-invariant reconciliation set (daily / hourly / byType / kind);
 * the remaining breakdowns (device/browser/os/country/channel) need a null→'unknown' caveat, so they
 * are NOT clean-lockable (see the coverage-matrix backlog).
 *
 * @remarks The aggregator caps at `LIMIT 20` distinct kinds; the invariant holds while distinct kinds
 * ≤ 20 — always true in practice (conversion kinds are a small fixed enum). The seed uses 4 kinds.
 */

import { getTrafficSummary } from '../service.js';
import {
  createD1Sqlite,
  type D1SqliteHarness,
} from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * Seed a known conversion set for `site_1`: 5 conversions (2 call, 1 email, 1 directions, 1 NULL-kind
 * → 'other'), plus 2 pageviews (must NOT count as conversions), `site_2` noise (tenant-excluded), and
 * an out-of-window conversion (excluded).
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
  // site_1 — 5 conversions within window (2 call, 1 email, 1 directions, 1 null-kind → 'other')
  ins.run('site_1', 's1', 'conversion', null, '{"kind":"call","country":"US"}', '-2 days');
  ins.run('site_1', 's2', 'conversion', null, '{"kind":"call","country":"US"}', '-1 days');
  ins.run('site_1', 's3', 'conversion', null, '{"kind":"email","country":"DE"}', '-1 days');
  ins.run('site_1', 's4', 'conversion', null, '{"kind":"directions","country":"US"}', '-1 days');
  ins.run('site_1', 's5', 'conversion', null, '{"country":"US"}', '-1 days'); // NO kind → 'other'
  // pageviews — MUST NOT count toward the conversion-KIND breakdown
  ins.run('site_1', 's1', 'pageview', '/', '{"country":"US"}', '-2 days');
  ins.run('site_1', 's2', 'pageview', '/a', '{"country":"US"}', '-1 days');
  // site_2 — must be tenant-excluded
  ins.run('site_2', 'x', 'conversion', null, '{"kind":"call"}', '-1 days');
  // out-of-window — must be excluded
  ins.run('site_1', 'old', 'conversion', null, '{"kind":"call","country":"US"}', '-90 days');
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
const kindCount = (kinds: { label: string; count: number }[], k: string): number =>
  kinds.find((b) => b.label === k)?.count ?? 0;

describe('analytics self-consistency — conversion-kind breakdown reconciles with the headline conversions (real SQLite)', () => {
  it('SUM(byConversionKind) === conversion count === summary.conversions; null-kind → other; pageviews excluded; site-scoped', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const summary = await getTrafficSummary(env(h), 'site_1', 30);
      const kindSum = summary.byConversionKind.reduce((s, k) => s + k.count, 0);

      // THE invariant: the kind buckets sum to the true conversion count AND the headline KPI.
      expect(kindSum).toBe(5);
      expect(kindSum).toBe(count(h, "event_type='conversion'"));
      expect(kindSum).toBe(summary.conversions);

      // a null/absent kind is bucketed as 'other', never dropped.
      expect(kindCount(summary.byConversionKind, 'other')).toBe(1);
      expect(kindCount(summary.byConversionKind, 'call')).toBe(2);

      // pageviews never inflate the conversion-only breakdown (event-type-drift guard).
      expect(kindSum).not.toBe(7); // 5 conversions + 2 pageviews would be 7
      // site_2's conversion never leaks in (tenant scoping).
      expect(kindSum).not.toBe(6);
    } finally {
      h.close();
    }
  });

  it('a drilldown FILTER reconciles — country=US restricts the kind breakdown + ground truth identically', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const summary = await getTrafficSummary(env(h), 'site_1', 30, undefined, {
        dim: 'country',
        value: 'US',
      });
      const kindSumUS = summary.byConversionKind.reduce((s, k) => s + k.count, 0);

      // US conversions: 2 call + 1 directions + 1 other = 4 (the DE email is excluded).
      expect(kindSumUS).toBe(4);
      expect(kindSumUS).toBe(
        count(h, "event_type='conversion' AND json_extract(metadata,'$.country')='US'"),
      );
      expect(kindSumUS).toBe(summary.conversions); // still tracks the headline under the filter
    } finally {
      h.close();
    }
  });

  it('an out-of-window row is excluded (the -90d conversion never inflates the kind breakdown)', async () => {
    const h = createD1Sqlite();
    try {
      seed(h);
      const summary = await getTrafficSummary(env(h), 'site_1', 30);
      expect(summary.byConversionKind.reduce((s, k) => s + k.count, 0)).toBe(5); // not 6 (the -90d row is out)
    } finally {
      h.close();
    }
  });
});
