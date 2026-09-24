/**
 * Builds the CSV export for the analytics dashboard — a pure, testable function so
 * the 85KB component only wires it to a download. Long-format (`section,key,value`)
 * so heterogeneous breakdowns share one file. Uses the shared {@link csvEscape}.
 *
 * Two correctness properties this fixes over the prior inline version:
 *  - the `source` row is the ACCURATE, resolved source label — never a hardcoded
 *    "cloudflare_graphql" (which lied for the subdomain majority whose data is D1);
 *  - it includes the D1 breakdowns (device / channel / conversions / Core Web Vitals)
 *    that work for EVERY site, not just the CF-zone envelope. A CWV / bounce value is
 *    emitted only when it was actually measured (never a fabricated 0).
 */
import { csvEscape } from './csv-export';

/** One CWV metric's p75 + sample count (or null when unmeasured). */
interface WebVitalStat {
  p75: number;
  samples: number;
}

/** The fields `buildAnalyticsCsv` reads off the dashboard's envelope + D1 traffic. */
export interface AnalyticsCsvInput {
  /** Resolved, human source label (e.g. "First-party (visitor_events)" / CF GraphQL). */
  source: string;
  /** Range token for the summary + filename (e.g. "7d"). */
  range: string;
  envelope: {
    pageviews: number;
    uniques: number;
    total_requests: number;
    series?: ReadonlyArray<{ date: string; page_views: number }>;
    top_pages?: ReadonlyArray<{ path: string; views: number }>;
    top_countries?: ReadonlyArray<{ country: string; views: number }>;
    top_referrers?: ReadonlyArray<{ referrer: string; views: number }>;
    urls_included?: ReadonlyArray<{ hostname: string; resolved_zone: boolean }>;
  };
  /** The D1 `traffic` summary; null before a site resolves. */
  traffic: {
    byDevice?: ReadonlyArray<{ label: string; count: number }>;
    byChannel?: ReadonlyArray<{ label: string; count: number }>;
    byConversionKind?: ReadonlyArray<{ label: string; count: number }>;
    bounceRatePercent?: number | null;
    webVitals?: {
      lcp: WebVitalStat | null;
      inp: WebVitalStat | null;
      cls: WebVitalStat | null;
    };
  } | null;
  /**
   * Cloudflare edge delivery (status classes / cache / bandwidth) from
   * `envelope.delivery`. Rows are emitted ONLY when `has_data` — an unavailable or
   * empty delivery block contributes nothing (never fake zeros), matching the card.
   */
  delivery?: {
    has_data: boolean;
    total_requests: number;
    by_status_class: ReadonlyArray<{ class: string; count: number }>;
    cache: { hit: number; miss: number; uncacheable: number; hit_ratio_pct: number | null };
    response_bytes: number;
  } | null;
}

/** Serialize the analytics dashboard to a `section,key,value` CSV document. */
export function buildAnalyticsCsv(input: AnalyticsCsvInput): string {
  const e = input.envelope;
  const t = input.traffic;
  const lines: string[] = ['section,key,value'];

  lines.push(`summary,source,${csvEscape(input.source)}`);
  lines.push(`summary,range,${csvEscape(input.range)}`);
  lines.push(`summary,page_views,${e.pageviews}`);
  lines.push(`summary,unique_visitors,${e.uniques}`);
  lines.push(`summary,total_requests,${e.total_requests}`);
  // Bounce is emitted only when truly measured (session-depth) — never a fake 0.
  if (t?.bounceRatePercent != null) lines.push(`summary,bounce_rate_percent,${t.bounceRatePercent}`);

  for (const r of e.series ?? []) lines.push(`by_day,${csvEscape(r.date)},${r.page_views}`);
  for (const r of e.top_pages ?? []) lines.push(`top_page,${csvEscape(r.path)},${r.views}`);
  for (const r of e.top_countries ?? []) lines.push(`country,${csvEscape(r.country)},${r.views}`);
  for (const r of e.top_referrers ?? []) lines.push(`referrer,${csvEscape(r.referrer)},${r.views}`);

  // D1 breakdowns — the universal (all-site) data the prior export dropped.
  for (const r of t?.byDevice ?? []) lines.push(`device,${csvEscape(r.label)},${r.count}`);
  for (const r of t?.byChannel ?? []) lines.push(`channel,${csvEscape(r.label)},${r.count}`);
  for (const r of t?.byConversionKind ?? []) lines.push(`conversion,${csvEscape(r.label)},${r.count}`);

  const wv = t?.webVitals;
  if (wv?.lcp) lines.push(`web_vital,lcp_p75_ms,${wv.lcp.p75}`);
  if (wv?.inp) lines.push(`web_vital,inp_p75_ms,${wv.inp.p75}`);
  if (wv?.cls) lines.push(`web_vital,cls_p75,${wv.cls.p75}`);

  // Cloudflare edge delivery — emitted ONLY when there's real edge data (matches the
  // card's honest "not available / no traffic" states; never fabricated zeros).
  const dl = input.delivery;
  if (dl?.has_data) {
    lines.push(`delivery,edge_requests,${dl.total_requests}`);
    for (const s of dl.by_status_class) lines.push(`delivery,status_${csvEscape(s.class)},${s.count}`);
    lines.push(`delivery,cache_hit,${dl.cache.hit}`);
    lines.push(`delivery,cache_miss,${dl.cache.miss}`);
    lines.push(`delivery,cache_uncacheable,${dl.cache.uncacheable}`);
    if (dl.cache.hit_ratio_pct != null) lines.push(`delivery,cache_hit_ratio_pct,${dl.cache.hit_ratio_pct}`);
    lines.push(`delivery,edge_response_bytes,${dl.response_bytes}`);
  }

  for (const u of e.urls_included ?? []) {
    lines.push(`url_included,${csvEscape(u.hostname)},${u.resolved_zone ? 'resolved' : 'unresolved'}`);
  }

  return lines.join('\n') + '\n';
}
