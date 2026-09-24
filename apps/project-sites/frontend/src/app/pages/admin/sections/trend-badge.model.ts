/**
 * A period-over-period trend badge — the shared view-model for every "up / down /
 * flat vs the prior window" chip on `/admin/analytics` (page-views + unique-visitor
 * KPI tiles, conversions card). Produced once by `AdminAnalyticsComponent.deltaBadge()`
 * from the authoritative server `previous` window, then handed to presentational cards.
 *
 * Defined here (not inside a component) so the producer and every consumer share ONE
 * type — a duplicated shape across cards would be drift.
 */
export interface TrendBadge {
  /** Direction of change; drives the arrow glyph + `data-dir` styling. */
  dir: 'up' | 'down' | 'flat';
  /** Short visible label: a percent (`"20%"`), `"flat"`, or `"new"` (up from zero). */
  label: string;
  /** Screen-reader sentence (full "up 20 percent versus the previous 7 days"). */
  aria: string;
  /** Hover title with the same evidence spelled out. */
  title: string;
}
