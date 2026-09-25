/**
 * @module libs/features/visitor_events_core/schemas
 * @description Zod schemas for Visitor Events Core — the pageview/session ingest
 * pipeline from published sites. Feeds `site_analytics`'s traffic block.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Event kinds a published-site beacon may emit. `form_start`/`form_submit` back
 * the AN17 form-funnel (mirrored from the client beacon via `/api/events`); the
 * admin reads them out of `visitor_events`, not the dead `analytics_events` store.
 */
export const VisitorEventTypeSchema = z.enum([
  'pageview',
  'click',
  'conversion',
  'custom',
  'form_start',
  'form_submit',
  // Core Web Vitals RUM sample (metadata: {metric, value}); see EVENT_TYPES.
  'web_vital',
  // Uncaught JS error / unhandled rejection on a published site (metadata: {message,
  // source, line}) — a first-party site-health signal (CF's plan exposes no client-error
  // dataset). Deduped + capped + message-truncated client-side by the app.js beacon.
  'js_error',
  // Page engagement / dwell time (metadata: {duration_ms}) — first-party time-on-page,
  // beaconed once on pagehide, client-bounded 1s–30min. CF's plan has no dwell dataset.
  'page_engagement',
  // Scroll depth (metadata: {percent}) — the max % of page height a visit reached, beaconed
  // once on pagehide (client-clamped 0–100). First-party content-consumption signal; CF's
  // plan has no scroll-depth dataset.
  'scroll_depth',
  // Network quality (metadata: {effective_type, downlink, rtt, save_data}) — the visitor's
  // navigator.connection estimate, beaconed once on load. Chromium-only; CF's plan has no
  // client network-quality dataset.
  'network_quality',
  // Page-load waterfall (metadata: {dns, connect, ttfb, transfer, dom, total}) — the
  // PerformanceNavigationTiming phase durations, beaconed once on load. CF's plan has no
  // client latency dataset.
  'nav_timing',
  // AI concierge usage (no metadata) — `concierge_open` on panel open, `concierge_message`
  // per visitor question (app.js universal-runtime FAB). First-party engagement signal for
  // the optional AI assistant; the analytics card self-hides when there are no opens.
  'concierge_open',
  'concierge_message',
]);
export type VisitorEventType = z.infer<typeof VisitorEventTypeSchema>;

/** Public ingest payload from a published site's beacon. Org/site resolved server-side. */
export const VisitorEventInputSchema = z
  .object({
    sessionId: z.string().min(8).max(128),
    eventType: VisitorEventTypeSchema.default('pageview'),
    path: z.string().max(2048).optional(),
    referrer: z.string().max(2048).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type VisitorEventInput = z.infer<typeof VisitorEventInputSchema>;

/** One `{ path, count }` row of the top-paths breakdown. */
export const PathCountSchema = z
  .object({
    path: z.string(),
    count: z.number().int().min(0),
    // AN9 — unique visitors for this page (COUNT(DISTINCT session_id)); the
    // engagement signal vs raw hits. Optional for back-compat with older payloads.
    uniques: z.number().int().min(0).optional(),
  })
  .strict();
/** One `{ type, count }` row of the by-type breakdown. */
export const TypeCountSchema = z
  .object({ type: z.string(), count: z.number().int().min(0) })
  .strict();
/** One `{ label, count }` row of a generic labelled breakdown (device / channel). */
export const LabelCountSchema = z
  .object({ label: z.string(), count: z.number().int().min(0) })
  .strict();
export type LabelCount = z.infer<typeof LabelCountSchema>;
/** One `{ hour, count }` row of the hour-of-day breakdown. `hour` is the 0–23 UTC
 *  hour (`created_at` is stored UTC); the frontend rotates to the viewer's local time. */
export const HourCountSchema = z
  .object({ hour: z.number().int().min(0).max(23), count: z.number().int().min(0) })
  .strict();
export type HourCount = z.infer<typeof HourCountSchema>;

/** One `{ weekday, count }` row of the day-of-week breakdown. `weekday` is SQLite
 *  `strftime('%w')` — 0 = Sunday … 6 = Saturday — computed in the OWNER's local timezone
 *  (unlike {@link HourCountSchema}, a weekday histogram CANNOT be rotated client-side, so
 *  the bucketing is done tz-correct in SQL). `count` = real pageviews on that weekday. */
export const WeekdayCountSchema = z
  .object({ weekday: z.number().int().min(0).max(6), count: z.number().int().min(0) })
  .strict();
export type WeekdayCount = z.infer<typeof WeekdayCountSchema>;

/**
 * Day-of-week breakdown envelope — the "busiest days" insight (complements hour-of-day).
 * `byWeekday: []` = no pageviews in the window (an HONEST empty, never a fabricated 0 per
 * day). `tzApplied` tells the UI whether buckets are the owner's LOCAL weekday (a real
 * `tz` offset was supplied) or UTC (fallback) — surfaced so we never imply a local
 * precision we didn't compute.
 */
export const WeekdaySummarySchema = z
  .object({
    byWeekday: z.array(WeekdayCountSchema).default([]),
    tzApplied: z.boolean().default(false),
  })
  .strict()
  .default({ byWeekday: [], tzApplied: false });
export type WeekdaySummary = z.infer<typeof WeekdaySummarySchema>;

/**
 * AN-FILTER — dimensions a traffic summary may be DRILLED DOWN / restricted to. This
 * enum IS the allowlist: the owner route validates a requested `filterDim` against it,
 * so an unknown or injected dimension is rejected at the boundary (400) and can never
 * reach SQL. Each name maps (in the service's SQL layer, `FILTER_DIMENSION_SQL`) to a
 * trusted `visitor_events` column / json_extract expression; the filter VALUE is always
 * BOUND as a `?` param, never interpolated. Note: a filter can only NARROW within the
 * already-authorized `site_id` scope — it never carries a hostname / zone / account.
 */
export const AnalyticsFilterDimensionSchema = z.enum([
  'country',
  'device',
  'browser',
  'os',
  'channel',
  'path',
]);
export type AnalyticsFilterDimension = z.infer<typeof AnalyticsFilterDimensionSchema>;

/**
 * A single drilldown filter: restrict the summary to events where `dim` equals `value`.
 * `value` is bounded (1–256 chars) and bound as a SQL param. `.strict()` rejects any
 * extra key so a client can't smuggle a raw column/predicate through this boundary.
 */
export const AnalyticsFilterSchema = z
  .object({
    dim: AnalyticsFilterDimensionSchema,
    value: z.string().min(1).max(256),
  })
  .strict();
export type AnalyticsFilter = z.infer<typeof AnalyticsFilterSchema>;

/**
 * Field-measured Core Web Vitals for ONE metric: the p75 (the CrUX/Cloudflare
 * convention for a "typical" score) plus the sample count backing it. `samples`
 * is ≥1 by construction — a metric with no field samples is `null` on the parent,
 * never `{p75: 0}` (a fabricated perfect score). p75 units: ms for LCP/INP,
 * unitless for CLS (as the beacon stores them).
 */
/**
 * The good / needs-improvement / poor sample split for ONE metric, classified against
 * Google's official CWV thresholds. `good + needs + poor === samples` by construction —
 * it shows the SPREAD behind the p75 (a "good" p75 can still hide a poor tail), never a
 * fabricated distribution.
 */
export const WebVitalDistSchema = z
  .object({
    good: z.number().int().min(0),
    needs: z.number().int().min(0),
    poor: z.number().int().min(0),
  })
  .strict();
export type WebVitalDist = z.infer<typeof WebVitalDistSchema>;

export const WebVitalStatSchema = z
  .object({
    p75: z.number(),
    samples: z.number().int().min(1),
    // AN-CWV-DIST — the good/needs/poor sample split (Google thresholds) so the UI can
    // show the distribution, not just the p75 point. Optional for back-compat with
    // pre-dist fixtures; the live aggregation always populates it.
    dist: WebVitalDistSchema.optional(),
  })
  .strict();
export type WebVitalStat = z.infer<typeof WebVitalStatSchema>;

/**
 * One page's LCP p75 (the headline CWV) + the sample count behind it — powers the
 * "slowest pages" drilldown so an owner sees WHICH page is slow. `samples` ≥ 1 by
 * construction; only pages past a sample floor are surfaced (a p75 off 1–2 hits is
 * not reliable).
 */
export const SlowPageSchema = z
  .object({
    path: z.string(),
    lcpP75: z.number(),
    // INP + CLS + FCP + TTFB p75 for the SAME page (present only when the page cleared the
    // sample floor for that metric too) — the full per-page performance picture. Omitted
    // (never 0) when a page lacks enough samples for that metric.
    inpP75: z.number().optional(),
    clsP75: z.number().optional(),
    fcpP75: z.number().optional(),
    ttfbP75: z.number().optional(),
    samples: z.number().int().min(1),
  })
  .strict();
export type SlowPage = z.infer<typeof SlowPageSchema>;

/**
 * Real-user Core Web Vitals summary over the window, per metric. `null` per metric
 * = NOT measured / no field samples yet (Chromium-only APIs; a fresh or low-traffic
 * site legitimately has none) — the UI shows "measuring…", never a fabricated 0.
 */
export const WebVitalsSchema = z
  .object({
    lcp: WebVitalStatSchema.nullable().default(null),
    inp: WebVitalStatSchema.nullable().default(null),
    cls: WebVitalStatSchema.nullable().default(null),
    // AN-PAGELOAD — page-load timing (NOT Core Web Vitals): FCP (first paint) + TTFB
    // (server response), both first-party ms p75, filling the CF-gated edge-latency
    // gap. Nullable + defaulted for back-compat with older payloads.
    fcp: WebVitalStatSchema.nullable().default(null),
    ttfb: WebVitalStatSchema.nullable().default(null),
    // AN-CWV per-path — the slowest pages by LCP p75 (headline metric), for the
    // "which page is slow" drilldown. Default [] for back-compat.
    slowestPages: z.array(SlowPageSchema).default([]),
  })
  .strict()
  .default({ lcp: null, inp: null, cls: null, fcp: null, ttfb: null, slowestPages: [] });
export type WebVitals = z.infer<typeof WebVitalsSchema>;

/** One grouped JS error: the message, how many times it fired, and a sample path it hit. */
export const JsErrorGroupSchema = z
  .object({
    message: z.string(),
    count: z.number().int().min(1),
    samplePath: z.string().optional(),
  })
  .strict();
export type JsErrorGroup = z.infer<typeof JsErrorGroupSchema>;

/**
 * AN-JSERR — first-party site-health: uncaught JS errors / unhandled rejections on the
 * published site over the window (from the `js_error` beacon → `visitor_events`), grouped
 * by message. `total` is the raw count; `byMessage` the top groups (worst first). An empty
 * summary (`total:0`, `byMessage:[]`) means a CLEAN site — never "not measured" (the beacon
 * runs on every page), so the card shows "running clean", never a fabricated/omitted metric.
 */
export const JsErrorSummarySchema = z
  .object({
    total: z.number().int().min(0),
    byMessage: z.array(JsErrorGroupSchema).default([]),
  })
  .strict()
  .default({ total: 0, byMessage: [] });
export type JsErrorSummary = z.infer<typeof JsErrorSummarySchema>;

/** One page's median dwell — how long visitors typically stay on it. */
export const EngagementPageSchema = z
  .object({
    path: z.string(),
    medianMs: z.number().int().min(0),
    samples: z.number().int().min(1),
  })
  .strict();
export type EngagementPage = z.infer<typeof EngagementPageSchema>;

/**
 * AN-ENGAGE-DIST — time-on-page distribution: the COUNT of visits whose dwell reached each
 * threshold (≥10s / ≥30s / ≥60s / ≥180s). Monotonic by construction (s10 ≥ s30 ≥ s60 ≥ s180 —
 * a visit past 60s is also past 30s). The dwell analogue of the scroll-depth reach funnel.
 */
export const EngagementDistributionSchema = z
  .object({
    s10: z.number().int().min(0),
    s30: z.number().int().min(0),
    s60: z.number().int().min(0),
    s180: z.number().int().min(0),
  })
  .strict()
  .default({ s10: 0, s30: 0, s60: 0, s180: 0 });
export type EngagementDistribution = z.infer<typeof EngagementDistributionSchema>;

/**
 * AN-ENGAGE — first-party time-on-page (dwell) over the window, from the `page_engagement`
 * beacon (mirrored into `visitor_events`). `medianMs` is the site-wide MEDIAN dwell (median,
 * not mean — dwell is outlier-skewed); `byPage` the per-page medians (top by dwell, past a
 * sample floor). `distribution` is how many visits stayed past each threshold — the SPREAD the
 * median point hides (a low median can still hide a long tail of deeply-engaged readers).
 * `medianMs` is `null` when there are no samples yet — the card shows "measuring…", never a
 * fabricated 0 (the beacon runs on every page, so 0 isn't "no data").
 */
export const EngagementSummarySchema = z
  .object({
    medianMs: z.number().int().min(0).nullable().default(null),
    samples: z.number().int().min(0),
    byPage: z.array(EngagementPageSchema).default([]),
    // AN-ENGAGE-DIST — visits reaching ≥10s/30s/60s/180s (monotonic). Default all-0 for back-compat.
    distribution: EngagementDistributionSchema,
  })
  .strict()
  .default({
    medianMs: null,
    samples: 0,
    byPage: [],
    distribution: { s10: 0, s30: 0, s60: 0, s180: 0 },
  });
export type EngagementSummary = z.infer<typeof EngagementSummarySchema>;

/** One page's scroll-depth story — how far visitors typically get, and how many finish. */
export const ScrollPageSchema = z
  .object({
    path: z.string(),
    medianPercent: z.number().int().min(0).max(100),
    samples: z.number().int().min(1),
    // % of this page's samples that reached the very bottom (100%).
    completionPercent: z.number().int().min(0).max(100),
  })
  .strict();
export type ScrollPage = z.infer<typeof ScrollPageSchema>;

/**
 * AN-SCROLL — first-party scroll depth over the window, from the `scroll_depth` beacon (the
 * max % of page height a visit reached, ONE sample per pageview, mirrored into
 * `visitor_events`). `medianPercent` is the site-wide MEDIAN max-depth; `reach` counts how
 * many samples got at least 25/50/75/100% deep (a monotonic non-increasing funnel — the
 * card divides by `samples` for reach rates); `byPage` the deepest-read pages past a sample
 * floor, each with its completion rate. `medianPercent` is `null` when there are no samples
 * yet — the card shows "measuring…", never a fabricated 0 (the beacon fires on every
 * scrollable page, so 0 isn't "no data", and CF's plan exposes no scroll-depth dataset).
 */
export const ScrollDepthSummarySchema = z
  .object({
    samples: z.number().int().min(0),
    medianPercent: z.number().int().min(0).max(100).nullable().default(null),
    reach: z
      .object({
        p25: z.number().int().min(0),
        p50: z.number().int().min(0),
        p75: z.number().int().min(0),
        p100: z.number().int().min(0),
      })
      .strict()
      .default({ p25: 0, p50: 0, p75: 0, p100: 0 }),
    byPage: z.array(ScrollPageSchema).default([]),
  })
  .strict()
  .default({
    samples: 0,
    medianPercent: null,
    reach: { p25: 0, p50: 0, p75: 0, p100: 0 },
    byPage: [],
  });
export type ScrollDepthSummary = z.infer<typeof ScrollDepthSummarySchema>;

/** One connection-class bucket (4g / 3g / 2g / slow-2g) and how many visits were on it. */
export const NetworkClassSchema = z
  .object({
    // 'slow-2g' | '2g' | '3g' | '4g' — the browser's effectiveType estimate.
    type: z.string(),
    count: z.number().int().min(1),
  })
  .strict();
export type NetworkClass = z.infer<typeof NetworkClassSchema>;

/**
 * AN-NET — first-party visitor CONNECTION QUALITY over the window, from the `network_quality`
 * beacon (`navigator.connection`, ONE sample per pageview, mirrored into `visitor_events`).
 * `byEffectiveType` is the distribution across 4g/3g/2g/slow-2g; `medianDownlinkMbps` /
 * `medianRttMs` the site-wide medians (median, not mean — connection estimates are skewed);
 * `saveDataPercent` the share of visits with the browser data-saver on. HONESTY: this API is
 * CHROMIUM-ONLY (Chrome/Edge/Android) — the card says so; `samples` counts only visits whose
 * browser reported it, and the medians are `null` (→ "measuring…") when there are none, never
 * a fabricated 0. CF's plan exposes no client network-quality dataset.
 */
/** One page's visitor-connection story — median downlink (Mbps) + median RTT, past a sample floor. */
export const NetworkPageSchema = z
  .object({
    path: z.string(),
    /** Median downlink Mbps of THIS page's visitors (the ranking key — lower = slower audience). */
    medianDownlinkMbps: z.number().min(0),
    medianRttMs: z.number().int().min(0).nullable().default(null),
    samples: z.number().int().min(1),
  })
  .strict();
export type NetworkPage = z.infer<typeof NetworkPageSchema>;

export const NetworkQualitySummarySchema = z
  .object({
    samples: z.number().int().min(0),
    byEffectiveType: z.array(NetworkClassSchema).default([]),
    medianDownlinkMbps: z.number().min(0).nullable().default(null),
    medianRttMs: z.number().int().min(0).nullable().default(null),
    saveDataPercent: z.number().int().min(0).max(100).nullable().default(null),
    // AN-NET-PAGE — pages whose visitors have the SLOWEST connections (lowest median downlink),
    // so an owner knows which pages to make lean for mobile/rural audiences. Floor-gated by
    // downlink samples; slowest-first, top 8. Default [] for back-compat / honest empty.
    byPage: z.array(NetworkPageSchema).default([]),
  })
  .strict()
  .default({
    samples: 0,
    byEffectiveType: [],
    medianDownlinkMbps: null,
    medianRttMs: null,
    saveDataPercent: null,
    byPage: [],
  });
export type NetworkQualitySummary = z.infer<typeof NetworkQualitySummarySchema>;

/**
 * AN-NAV — first-party page-load WATERFALL over the window, from the `nav_timing` beacon
 * (the PerformanceNavigationTiming entry, ONE sample per pageview, mirrored into
 * `visitor_events`). Each field is the site-wide MEDIAN duration (ms) of one load phase —
 * `dns` (DNS lookup) · `connect` (TCP+TLS) · `ttfb` (server wait) · `transfer` (response
 * download) · `dom` (DOM build) · `total` (fetch→load). Shows an owner WHERE their load time
 * goes (slow DNS vs slow server vs heavy DOM), the latency breakdown Cloudflare's plan blocks.
 * A phase median is `null` only when there are no samples (→ "measuring…", never a fabricated
 * 0); an HONEST 0 (cached DNS, reused connection) IS a real value and IS counted. Median (not
 * mean) — load timings are right-skewed.
 */
/** One page's nav-timing story — median total page-load + median server-wait (TTFB), past a sample floor. */
export const NavPageSchema = z
  .object({
    path: z.string(),
    /** Median TTFB (server wait) for this page — null when it lacks enough TTFB samples (never a fake 0). */
    ttfb: z.number().int().min(0).nullable().default(null),
    /** Median total page-load ms for this page (the ranking key — worst-first). */
    total: z.number().int().min(0),
    samples: z.number().int().min(1),
  })
  .strict();
export type NavPage = z.infer<typeof NavPageSchema>;

export const NavTimingSummarySchema = z
  .object({
    samples: z.number().int().min(0),
    dns: z.number().int().min(0).nullable().default(null),
    connect: z.number().int().min(0).nullable().default(null),
    ttfb: z.number().int().min(0).nullable().default(null),
    transfer: z.number().int().min(0).nullable().default(null),
    dom: z.number().int().min(0).nullable().default(null),
    total: z.number().int().min(0).nullable().default(null),
    // AN-NAV-PAGE — the slowest pages by median total load (each with its median TTFB = server
    // wait, so an owner tells a slow-SERVER page from a slow-CLIENT one). Mirrors the CWV
    // slowest-pages drilldown; floor-gated. Default [] for back-compat / honest empty.
    byPage: z.array(NavPageSchema).default([]),
  })
  .strict()
  .default({
    samples: 0,
    dns: null,
    connect: null,
    ttfb: null,
    transfer: null,
    dom: null,
    total: null,
    byPage: [],
  });
export type NavTimingSummary = z.infer<typeof NavTimingSummarySchema>;

/** One clicked outbound/contact link: the destination, its kind, and the click count. */
export const OutboundLinkSchema = z
  .object({
    href: z.string(),
    kind: z.string().nullable().default(null),
    count: z.number().int().min(1),
  })
  .strict();
export type OutboundLink = z.infer<typeof OutboundLinkSchema>;

/**
 * AN-OUTBOUND — the WHICH-LINKS view of click conversions (the by-CATEGORY view is
 * `byConversionKind`). `total` counts every conversion that carried a destination href; `byLink`
 * is the top-8 destinations (the owner's own phone / email / social / booking links), each with
 * its kind. Answers "are visitors tapping my phone number / booking link?". Empty (`total:0`,
 * `byLink:[]`) = no link-clicks yet (the card shows "no link clicks tracked yet" — never a fake 0).
 */
export const OutboundClicksSummarySchema = z
  .object({
    total: z.number().int().min(0),
    byLink: z.array(OutboundLinkSchema).default([]),
  })
  .strict()
  .default({ total: 0, byLink: [] });
export type OutboundClicksSummary = z.infer<typeof OutboundClicksSummarySchema>;

/** One form's funnel over the window: its key + validated starts + confirmed submits. */
export const FormFunnelEntrySchema = z
  .object({
    form: z.string(),
    starts: z.number().int().min(0),
    submits: z.number().int().min(0),
    // submits/starts as a 0–100 integer; null when starts===0 (no attempts → no rate,
    // never a fabricated 0%). Clamped to 100 when a submit's start fell outside the window.
    completionRatePercent: z.number().int().min(0).max(100).nullable().default(null),
  })
  .strict();
export type FormFunnelEntry = z.infer<typeof FormFunnelEntrySchema>;

/**
 * AN-FORM — the contact-form LEAD FUNNEL. `form_start` fires on a VALIDATED submit
 * attempt (name+email present, message ≥10 chars); `form_submit` fires ONLY on a
 * server-confirmed 200. So `starts` = serious attempts, `submits` = delivered leads,
 * and `starts − submits` = abandons/failures — the owner's lost leads. Both events are
 * beacon-emitted (app.js) and mirrored into `visitor_events` with `metadata.$.form` (the
 * form's id/name, or 'contact'). `completionRatePercent` = submits/starts, null when
 * there are no starts. Empty (`starts:0`) = no form activity yet — the card says so,
 * never a fabricated 0%. Distinct from the `form` CONVERSION kind (which counts only
 * successes): this funnel is the only view that surfaces ABANDONMENT.
 */
export const FormFunnelSummarySchema = z
  .object({
    starts: z.number().int().min(0),
    submits: z.number().int().min(0),
    completionRatePercent: z.number().int().min(0).max(100).nullable().default(null),
    byForm: z.array(FormFunnelEntrySchema).default([]),
  })
  .strict()
  .default({ starts: 0, submits: 0, completionRatePercent: null, byForm: [] });
export type FormFunnelSummary = z.infer<typeof FormFunnelSummarySchema>;

/** Aggregated traffic summary for one site over a window. */
export const TrafficSummarySchema = z
  .object({
    pageviews: z.number().int().min(0),
    uniqueSessions: z.number().int().min(0),
    conversions: z.number().int().min(0),
    // True single-page-session bounce (% of sessions with exactly 1 pageview),
    // computed from visitor_events session depth. null when there's no session data.
    bounceRatePercent: z.number().int().min(0).max(100).nullable().default(null),
    topPaths: z.array(PathCountSchema),
    byType: z.array(TypeCountSchema),
    // AN13 device split + AN10 channel breakdown — from the AN1 metadata
    // enrichment (`json_extract(metadata,'$.device'|'$.channel')`). Default []
    // keeps older producers/fixtures valid.
    byDevice: z.array(LabelCountSchema).default([]),
    byChannel: z.array(LabelCountSchema).default([]),
    // AN-TECH — browser + OS split, from the SAME AN1 user-agent enrichment as
    // `$.device` (`json_extract(metadata,'$.browser'|'$.os')`). Default [] for
    // back-compat with producers/fixtures that predate the tech breakdown.
    byBrowser: z.array(LabelCountSchema).default([]),
    byOs: z.array(LabelCountSchema).default([]),
    // AN-UTM — campaign attribution: top utm_source + utm_medium + utm_campaign over TAGGED
    // visits only (untagged direct/organic excluded). Default [] for back-compat + honest empty
    // (a site running no campaigns has none — never a fabricated bucket). utm_medium is the RAW
    // owner-set medium (cpc/email/newsletter/banner) — distinct from the coarse derived `byChannel`.
    byUtmSource: z.array(LabelCountSchema).default([]),
    byUtmMedium: z.array(LabelCountSchema).default([]),
    byUtmCampaign: z.array(LabelCountSchema).default([]),
    // AN14 — visitors by country (CF `request.cf.country`, captured in metadata
    // since before AN1). Default [] for back-compat.
    byCountry: z.array(LabelCountSchema).default([]),
    // AN-HOUR — pageviews by hour-of-day (0–23 UTC). The frontend rotates these UTC
    // buckets to the viewer's local time for display. Default [] for back-compat /
    // honest-empty (no pageviews → no bars).
    byHour: z.array(HourCountSchema).default([]),
    // AN-CONV — conversions broken down by kind (call / directions / form / …)
    // from `json_extract(metadata,'$.kind')` on `conversion` events. The actual
    // business outcomes. Default [] for back-compat.
    byConversionKind: z.array(LabelCountSchema).default([]),
    // AN-CWV — real-user Core Web Vitals p75 (LCP/INP/CLS) from the `web_vital`
    // beacon rows. Defaults to all-null (no samples) for back-compat with older
    // producers/fixtures that predate CWV.
    webVitals: WebVitalsSchema,
    // AN-JSERR — first-party JS-error site-health (grouped by message). Defaults to an
    // empty clean summary for back-compat with producers/fixtures that predate it.
    jsErrors: JsErrorSummarySchema,
    // AN-ENGAGE — first-party time-on-page (median dwell + per-page). Defaults to an empty
    // (null-median) summary for back-compat with producers/fixtures that predate it.
    engagement: EngagementSummarySchema,
    // AN-SCROLL — first-party scroll depth (median max-depth + reach funnel + per-page).
    // Defaults to an empty (null-median) summary for back-compat with producers/fixtures
    // that predate it.
    scrollDepth: ScrollDepthSummarySchema,
    // AN-NET — first-party visitor connection quality (effectiveType distribution + median
    // downlink/rtt + save-data %). Chromium-only sample. Defaults to an empty summary for
    // back-compat with producers/fixtures that predate it.
    networkQuality: NetworkQualitySummarySchema,
    // AN-NAV — first-party page-load waterfall (median dns/connect/ttfb/transfer/dom/total).
    // Defaults to an empty (null-median) summary for back-compat with producers/fixtures.
    navTiming: NavTimingSummarySchema,
    // AN-OUTBOUND — top clicked outbound/contact links (which links, by destination). Defaults
    // to an empty summary for back-compat with producers/fixtures that predate it.
    outboundClicks: OutboundClicksSummarySchema,
    // AN-FORM — contact-form lead funnel (validated starts → confirmed submits →
    // completion rate, per form). The only view that surfaces form ABANDONMENT.
    // Defaults to an empty summary for back-compat with producers/fixtures that predate it.
    formFunnel: FormFunnelSummarySchema,
    // AN15 — the immediately-preceding equal-length window's KPIs, for
    // period-over-period deltas. Defaults to zeros for back-compat.
    previous: z
      .object({
        pageviews: z.number().int().min(0),
        uniqueSessions: z.number().int().min(0),
        conversions: z.number().int().min(0),
        // AN-CONV-Δ — the prior window's conversions BY KIND, so the card can show a
        // per-kind period-over-period delta (calls up, form-submits down). Defaulted []
        // for back-compat with pre-delta producers/fixtures.
        byConversionKind: z.array(LabelCountSchema).default([]),
      })
      .strict()
      .default({ pageviews: 0, uniqueSessions: 0, conversions: 0, byConversionKind: [] }),
    windowDays: z.number().int().positive(),
  })
  .strict();
export type TrafficSummary = z.infer<typeof TrafficSummarySchema>;
