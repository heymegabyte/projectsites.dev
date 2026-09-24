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

/**
 * Field-measured Core Web Vitals for ONE metric: the p75 (the CrUX/Cloudflare
 * convention for a "typical" score) plus the sample count backing it. `samples`
 * is ≥1 by construction — a metric with no field samples is `null` on the parent,
 * never `{p75: 0}` (a fabricated perfect score). p75 units: ms for LCP/INP,
 * unitless for CLS (as the beacon stores them).
 */
export const WebVitalStatSchema = z
  .object({ p75: z.number(), samples: z.number().int().min(1) })
  .strict();
export type WebVitalStat = z.infer<typeof WebVitalStatSchema>;

/**
 * One page's LCP p75 (the headline CWV) + the sample count behind it — powers the
 * "slowest pages" drilldown so an owner sees WHICH page is slow. `samples` ≥ 1 by
 * construction; only pages past a sample floor are surfaced (a p75 off 1–2 hits is
 * not reliable).
 */
export const SlowPageSchema = z
  .object({ path: z.string(), lcpP75: z.number(), samples: z.number().int().min(1) })
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
    // AN-CWV per-path — the slowest pages by LCP p75 (headline metric), for the
    // "which page is slow" drilldown. Default [] for back-compat.
    slowestPages: z.array(SlowPageSchema).default([]),
  })
  .strict()
  .default({ lcp: null, inp: null, cls: null, slowestPages: [] });
export type WebVitals = z.infer<typeof WebVitalsSchema>;

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
    // AN14 — visitors by country (CF `request.cf.country`, captured in metadata
    // since before AN1). Default [] for back-compat.
    byCountry: z.array(LabelCountSchema).default([]),
    // AN-CONV — conversions broken down by kind (call / directions / form / …)
    // from `json_extract(metadata,'$.kind')` on `conversion` events. The actual
    // business outcomes. Default [] for back-compat.
    byConversionKind: z.array(LabelCountSchema).default([]),
    // AN-CWV — real-user Core Web Vitals p75 (LCP/INP/CLS) from the `web_vital`
    // beacon rows. Defaults to all-null (no samples) for back-compat with older
    // producers/fixtures that predate CWV.
    webVitals: WebVitalsSchema,
    // AN15 — the immediately-preceding equal-length window's KPIs, for
    // period-over-period deltas. Defaults to zeros for back-compat.
    previous: z
      .object({
        pageviews: z.number().int().min(0),
        uniqueSessions: z.number().int().min(0),
        conversions: z.number().int().min(0),
      })
      .strict()
      .default({ pageviews: 0, uniqueSessions: 0, conversions: 0 }),
    windowDays: z.number().int().positive(),
  })
  .strict();
export type TrafficSummary = z.infer<typeof TrafficSummarySchema>;
