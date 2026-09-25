/**
 * Deterministic, evidence-backed analytics "highlights" — turns the dashboard's numbers
 * into plain-language sentences a non-technical owner instantly understands (the "so what"
 * the dense card grid lacks). PURE + testable.
 *
 * HONESTY (load-bearing): every insight embeds its REAL number and is derived only from
 * data that is actually present — a datum that is absent or zero produces NO insight
 * (never "0% of visitors …"). A period-over-period comparison appears ONLY when the caller
 * passes a real delta (the dashboard's delta view-models are `null` when there is no prior
 * period to compare, and label `"new"` when the prior period was zero). Nothing is
 * estimated or fabricated; every claim is checkable against the cards below it.
 */

/** A period-over-period delta view-model (the dashboard's `TrendBadge` shape). */
export interface InsightDelta {
  dir: 'up' | 'down' | 'flat';
  /** e.g. "18%" — or "new" when the prior period was zero (never ∞%). */
  label: string;
}

/** Everything `buildAnalyticsInsights` reads — all already on the analytics component. */
export interface AnalyticsInsightsInput {
  windowDays: number;
  pageviews: number;
  pvDelta?: InsightDelta | null;
  topPage?: { path: string; views: number } | null;
  byDevice?: ReadonlyArray<{ label: string; count: number }>;
  topCountry?: { label: string; count: number } | null;
  topConversionKind?: { label: string; count: number } | null;
  conversionDelta?: InsightDelta | null;
  bounceRatePercent?: number | null;
}

/** One highlight — an id (for tracking/`@for`) + the plain-language sentence. */
export interface AnalyticsInsight {
  id: string;
  text: string;
  /**
   * The drilldown this insight is EVIDENCE for — clicking it filters the whole dashboard
   * to that dimension value (reuses the drilldown filter). Present only on insights that
   * map to a filterable dimension (device / top page / top country); absent on aggregate
   * insights (traffic / conversions / bounce), which have no single value to filter to.
   */
  drill?: { dim: 'country' | 'device' | 'path'; value: string };
}

/** Friendly plural noun per conversion kind; falls back to the raw label + "s". */
const CONVERSION_NOUNS: Record<string, string> = {
  call: 'phone calls',
  directions: 'directions taps',
  form: 'form submissions',
  form_submit: 'form submissions',
  form_start: 'form starts',
  email: 'email clicks',
  booking: 'bookings',
  order: 'orders',
};

function humanizeKind(label: string, n: number): string {
  const key = label.toLowerCase().replace(/\s+/g, '_');
  return CONVERSION_NOUNS[key] ?? (n === 1 ? label : `${label}s`);
}

/** Thousands-separated integer. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** "view" / "views" (etc.) — pluralize a noun by count. */
function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}

/** The largest row's label + its whole-percent share of the total, or null when empty. */
function topShare(
  rows: ReadonlyArray<{ label: string; count: number }> | undefined,
): { label: string; pct: number } | null {
  if (!rows || rows.length === 0) return null;
  let total = 0;
  let top = rows[0];
  for (const r of rows) {
    total += Math.max(0, r.count);
    if (r.count > top.count) top = r;
  }
  if (total <= 0 || top.count <= 0) return null;
  return { label: top.label, pct: Math.round((top.count / total) * 100) };
}

/** The comparison clause for an insight, or "" when there's nothing honest to say. */
function deltaPhrase(d: InsightDelta | null | undefined, windowDays: number): string {
  if (!d) return ''; // no prior period → no comparison (never invented)
  const win = windowDays === 1 ? 'day' : `${windowDays} days`;
  if (d.label === 'new') return ` — new in the last ${win}`;
  if (d.dir === 'flat') return `, about the same as the previous ${win}`;
  return `, ${d.dir === 'up' ? 'up' : 'down'} ${d.label} vs the previous ${win}`;
}

/**
 * Build up to 5 evidence-backed highlights from the current window's data, ordered by
 * owner relevance (traffic → conversions → top page → device → location → stickiness).
 * Returns `[]` when there's nothing real to say (the strip then hides).
 */
export function buildAnalyticsInsights(input: AnalyticsInsightsInput): AnalyticsInsight[] {
  const out: AnalyticsInsight[] = [];
  const days = input.windowDays;
  const win = days === 1 ? 'the last day' : `the last ${days} days`;

  // 1. Traffic — the headline. Only when there ARE page views.
  if (input.pageviews > 0) {
    out.push({
      id: 'traffic',
      text: `${fmt(input.pageviews)} page ${plural(input.pageviews, 'view')} in ${win}${deltaPhrase(input.pvDelta, days)}.`,
    });
  }

  // 2. Conversions — the business outcome an owner cares about most.
  const k = input.topConversionKind;
  if (k && k.count > 0) {
    out.push({
      id: 'conversions',
      text: `${fmt(k.count)} ${humanizeKind(k.label, k.count)} in ${win}${deltaPhrase(input.conversionDelta, days)}.`,
    });
  }

  // 3. Top page — clickable to filter the dashboard to that path.
  if (input.topPage && input.topPage.views > 0) {
    out.push({
      id: 'top-page',
      text: `Your most-visited page is ${input.topPage.path} (${fmt(input.topPage.views)} ${plural(input.topPage.views, 'view')}).`,
      drill: { dim: 'path', value: input.topPage.path },
    });
  }

  // 4. Device split — only a genuine MAJORITY (≥50%) is worth calling out honestly.
  const dev = topShare(input.byDevice);
  if (dev && dev.pct >= 50) {
    out.push({ id: 'device', text: `${dev.pct}% of visitors are on ${dev.label}.`, drill: { dim: 'device', value: dev.label } });
  }

  // 5. Top visitor location — "top", never a "most/majority" claim we can't back.
  if (input.topCountry && input.topCountry.count > 0) {
    out.push({
      id: 'country',
      text: `Your top visitor location is ${input.topCountry.label}.`,
      drill: { dim: 'country', value: input.topCountry.label },
    });
  }

  // 6. Stickiness — only when bounce was actually measured (session depth), never a fake 0.
  if (input.bounceRatePercent != null) {
    out.push({
      id: 'bounce',
      text: `${input.bounceRatePercent}% of visits saw just one page.`,
    });
  }

  return out.slice(0, 5);
}
