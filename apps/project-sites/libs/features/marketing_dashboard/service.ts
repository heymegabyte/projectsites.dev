/**
 * Unified Marketing Dashboard (#57, ROI 2.00) — pure metric aggregation
 * schema + widget layout engine. Zero I/O, deterministic.
 */
/** The canonical metric-source vocabulary — SSOT. The `MetricSource` union is DERIVED from this
 *  const so the runtime list (used to validate untrusted `?sources=` input) can never drift from
 *  the type. */
export const METRIC_SOURCES = ['website', 'email', 'social', 'ads', 'crm', 'booking'] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];
export type WidgetType = 'number' | 'line_chart' | 'bar_chart' | 'pie_chart' | 'table' | 'funnel';

export interface MetricWidget {
  id: string; title: string; type: WidgetType;
  source: MetricSource; metric: string; position: number;
  size: 'small' | 'medium' | 'large'; visible: boolean;
}

export interface MetricValue {
  label: string; value: number; previousValue: number;
  changePercent: number; trend: 'up' | 'down' | 'flat';
  source: MetricSource;
}

export interface DashboardConfig {
  siteId: string; generatedAt: string; widgets: MetricWidget[];
  metrics: MetricValue[]; widgetCount: number;
  layout: 'grid' | 'list';
}

const DEFAULT_WIDGETS: MetricWidget[] = [
  { id: 'visitors', title: 'Visitors', type: 'number', source: 'website', metric: 'visitors', position: 0, size: 'small', visible: true },
  { id: 'leads', title: 'Leads Generated', type: 'number', source: 'website', metric: 'leads', position: 1, size: 'small', visible: true },
  { id: 'conversion', title: 'Conversion Rate', type: 'number', source: 'website', metric: 'conversion_rate', position: 2, size: 'small', visible: true },
  { id: 'traffic_sources', title: 'Traffic Sources', type: 'pie_chart', source: 'website', metric: 'traffic_sources', position: 3, size: 'medium', visible: true },
  { id: 'top_pages', title: 'Top Pages', type: 'table', source: 'website', metric: 'top_pages', position: 4, size: 'large', visible: true },
  { id: 'email_opens', title: 'Email Opens', type: 'number', source: 'email', metric: 'opens', position: 5, size: 'small', visible: true },
  { id: 'email_clicks', title: 'Email Clicks', type: 'number', source: 'email', metric: 'clicks', position: 6, size: 'small', visible: true },
  { id: 'social_engagement', title: 'Social Engagement', type: 'bar_chart', source: 'social', metric: 'engagement', position: 7, size: 'medium', visible: true },
  { id: 'pipeline', title: 'Deal Pipeline', type: 'funnel', source: 'crm', metric: 'pipeline', position: 8, size: 'large', visible: true },
  { id: 'revenue', title: 'Revenue', type: 'number', source: 'crm', metric: 'revenue', position: 9, size: 'small', visible: true },
  { id: 'bookings', title: 'Appointments', type: 'number', source: 'booking', metric: 'bookings', position: 10, size: 'small', visible: true },
];

/**
 * Computes change percentage and trend between two values.
 */
export function computeChange(current: number, previous: number): { changePercent: number; trend: 'up' | 'down' | 'flat' } {
  if (previous === 0) return { changePercent: current > 0 ? 100 : 0, trend: current > 0 ? 'up' : 'flat' };
  const pct = Math.round(((current - previous) / previous) * 100);
  return { changePercent: pct, trend: pct > 3 ? 'up' : pct < -3 ? 'down' : 'flat' };
}

/**
 * Generates a default dashboard config with all widgets enabled.
 */
export function defaultDashboard(siteId: string): DashboardConfig {
  return {
    siteId, generatedAt: new Date().toISOString(),
    widgets: DEFAULT_WIDGETS, metrics: [],
    widgetCount: DEFAULT_WIDGETS.length, layout: 'grid',
  };
}

/**
 * Filters visible widgets by source and re-positions them.
 */
export function filterBySource(config: DashboardConfig, sources: MetricSource[]): DashboardConfig {
  const filtered = config.widgets
    .filter((w) => sources.includes(w.source))
    .map((w, i) => ({ ...w, position: i }));
  return { ...config, widgets: filtered, widgetCount: filtered.length };
}

/**
 * Parse an untrusted `?sources=` CSV query param into a validated {@link MetricSource}[] —
 * the boundary guard for {@link filterBySource}. Splits on comma, trims, and DROPS any token
 * not in {@link METRIC_SOURCES} (a bad `?sources=foo` narrows to nothing rather than smuggling
 * an unknown string through an `as any` cast). Pure; never throws; empty/garbage → `[]`.
 *
 * @param csv - The raw `sources` query value (e.g. `"website,email"`), possibly empty/invalid.
 * @returns The subset of valid `MetricSource` values, in input order, de-duplicated.
 * @example parseMetricSources('website, email, bogus') // → ['website','email']
 */
export function parseMetricSources(csv: string): MetricSource[] {
  const valid = new Set<string>(METRIC_SOURCES);
  const seen = new Set<MetricSource>();
  for (const raw of csv.split(',')) {
    const t = raw.trim();
    if (valid.has(t)) seen.add(t as MetricSource);
  }
  return [...seen];
}

/**
 * Builds a metric value with computed change from current + previous values.
 */
export function buildMetric(label: string, current: number, previous: number, source: MetricSource): MetricValue {
  const change = computeChange(current, previous);
  return { label, value: current, previousValue: previous, ...change, source };
}

/**
 * Returns the available metric source categories (a fresh mutable copy of the
 * {@link METRIC_SOURCES} SSOT — no longer a hand-maintained duplicate that could drift).
 */
export function metricSources(): MetricSource[] {
  return [...METRIC_SOURCES];
}
