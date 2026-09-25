/**
 * @module libs/features/visitor_events_core/service
 * @description Ingest + aggregation for Visitor Events Core. Public beacons POST
 * events; `recordVisitorEvent` appends a row, `getTrafficSummary` rolls them up
 * for `site_analytics`. Aggregation queries are defensive (missing table → 0).
 *
 * @packageDocumentation
 */

import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbExecute } from '../../../src/services/db.js';
import { enrichVisitor } from './enrich.js';
import {
  VisitorEventInputSchema,
  TrafficSummarySchema,
  type VisitorEventInput,
  type TrafficSummary,
  type PathCountSchema,
  type WebVitals,
  type JsErrorSummary,
  type EngagementSummary,
  type ScrollDepthSummary,
  type NetworkQualitySummary,
  type NavTimingSummary,
  type OutboundClicksSummary,
  type FormFunnelSummary,
  type FormFunnelEntry,
  type LabelCount,
  type HourCount,
  type AnalyticsFilter,
  type AnalyticsFilterDimension,
} from './schemas.js';

// Re-export the drilldown filter type so consumers (e.g. site_analytics) import it
// from the service module alongside AnalyticsWindow, not by reaching into schemas.
export type { AnalyticsFilter } from './schemas.js';
import type { z } from 'zod';

/** Flag key gating this feature. */
export const FLAG_KEY = 'site_analytics';

/** Append one visitor event. Org/site resolved by the caller (handler), not the body. */
export async function recordVisitorEvent(
  env: Env,
  ctx: { orgId: string; siteId: string },
  input: VisitorEventInput,
): Promise<{ id: string }> {
  const v = VisitorEventInputSchema.parse(input);
  const id = crypto.randomUUID();
  const { error } = await dbExecute(
    env.DB,
    `INSERT INTO visitor_events (id, org_id, site_id, session_id, event_type, path, referrer, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ctx.orgId,
      ctx.siteId,
      v.sessionId,
      v.eventType,
      v.path ?? null,
      v.referrer ?? null,
      JSON.stringify(v.metadata ?? {}),
    ],
  );
  // Best-effort hot-path beacon: never block the request, but LOG a dropped write so an
  // under-counted /admin/analytics is observable, not silent ([[verify-against-source-of-truth]]).
  if (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'visitor_events',
        message: 'dropped visitor_events write',
        org_id: ctx.orgId,
        site_id: ctx.siteId,
        event_type: v.eventType,
        error,
      }),
    );
  }
  return { id };
}

/** Static-asset extensions that are NOT page views (skip recording). */
const NON_PAGE_EXT_RE =
  /\.(?:css|js|mjs|cjs|json|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|xml|txt|pdf|mp4|webm|mov|wasm|zip|gz|csv)$/i;

/**
 * True when a request path is a real page navigation (the thing a visitor
 * "clicks" to), not a static asset fetch. Root, trailing-slash, extensionless,
 * and `.html` count as pages; everything with an asset extension does not.
 */
export function isPageRequest(path: string): boolean {
  const clean = (path.split('?')[0] || '/').split('#')[0];
  if (clean === '/' || clean.endsWith('/')) return true;
  if (clean.endsWith('.html')) return true;
  return !NON_PAGE_EXT_RE.test(clean);
}

/** Obvious crawler/bot UAs we don't count as human pageviews. */
const BOT_UA_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|vkshare|whatsapp|flipboard|tumblr|redditbot|gptbot|claudebot|claude-|perplexitybot|ccbot|bytespider|google-extended|applebot|headlesschrome|lighthouse|pagespeed/i;

/**
 * Privacy-preserving anonymous session id: a truncated SHA-256 of
 * `ip|ua|YYYY-MM-DD`. Stable per visitor per UTC day for unique-session counts,
 * but stores NO raw PII (the hash is one-way; the IP/UA are never persisted).
 */
async function anonSessionId(ip: string, ua: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const bytes = new TextEncoder().encode(`${ip}|${ua}|${day}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Record an anonymous edge pageview for a served site. Called fire-and-forget
 * from the Worker's site-serving path via `ctx.waitUntil` — Cloudflare-native,
 * no client beacon, no feature flag, never blocks or breaks serving.
 *
 * @remarks Skips non-page asset requests and known bots. All failures are
 * swallowed: analytics must never take down content delivery.
 *
 * @example
 * ```ts
 * c.executionCtx.waitUntil(
 *   recordPageviewFromRequest(c.env, { orgId: site.org_id, siteId: site.site_id }, c.req.raw, path),
 * );
 * ```
 */
export async function recordPageviewFromRequest(
  env: Env,
  ctx: { orgId: string; siteId: string },
  request: Request,
  path: string,
): Promise<void> {
  try {
    if (!isPageRequest(path)) return;
    const ua = request.headers.get('user-agent') ?? '';
    if (BOT_UA_RE.test(ua)) return;
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    const referrer = request.headers.get('referer') ?? undefined;
    const cf = (request as unknown as { cf?: { country?: string; city?: string; region?: string } })
      .cf;
    const sessionId = await anonSessionId(ip, ua);
    await recordVisitorEvent(env, ctx, {
      sessionId,
      eventType: 'pageview',
      path: (path.split('?')[0] || '/').slice(0, 2048),
      referrer: referrer ? referrer.slice(0, 2048) : undefined,
      // AN1 enrichment — device/browser/os + channel (+ utm when present) folded
      // into metadata JSON (no schema migration); powers AN10/AN13 owner widgets.
      // AN2 — geo enrichment: country + city + region from the CF edge (city/region
      // are coarse, non-PII; capped to keep the metadata row small).
      metadata: {
        country: cf?.country ?? null,
        city: cf?.city ? cf.city.slice(0, 80) : null,
        region: cf?.region ? cf.region.slice(0, 80) : null,
        ua: ua.slice(0, 256),
        ...enrichVisitor(ua, referrer, path),
      },
    });
  } catch {
    // Analytics is best-effort; never surface to the visitor.
  }
}

/** Scalar COUNT/aggregate, 0 on any error (missing table etc.). */
async function scalar(env: Env, sql: string, params: unknown[]): Promise<number> {
  const { data, error } = await dbQuery<{ n: number }>(env.DB, sql, params);
  if (error) return 0;
  return Number(data[0]?.n ?? 0);
}

/**
 * Nearest-rank percentile of a numeric sample (the method CrUX/Cloudflare use for
 * CWV p75). Sorts ascending, picks the value at rank `ceil(p/100 · n)` (1-based).
 * Returns 0 for an empty input — callers must gate on sample count, not this value.
 *
 * @param values - the raw samples (unsorted; not mutated)
 * @param p - percentile in (0, 100]
 * @example percentile([10, 20, 30, 40], 75) // => 30
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] as number;
}

/** The 3 CWV metrics we field-measure, and how each p75 is rounded for display. */
const CWV_METRICS = ['LCP', 'INP', 'CLS'] as const;

/**
 * Google's official CWV rating thresholds `[good-max, needs-improvement-max]` — a value
 * `≤ good` is "good", `≤ needs` is "needs improvement", else "poor". MUST stay in sync
 * with the frontend `WebVitalsCardComponent.rating()`.
 */
const CWV_THRESHOLDS: Record<(typeof CWV_METRICS)[number], readonly [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
};

/**
 * Page-load timing metrics (NOT Core Web Vitals — kept separate so the CWV rating story
 * stays clean): FCP (first paint) + TTFB (server response). Both ms. Google's thresholds
 * `[good-max, needs-max]`. These fill the edge-latency gap Cloudflare's plan won't give
 * us, measured first-party in `app.js` (Navigation Timing + the paint observer).
 */
const PAGELOAD_METRICS = ['FCP', 'TTFB'] as const;
const PAGELOAD_THRESHOLDS: Record<(typeof PAGELOAD_METRICS)[number], readonly [number, number]> = {
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

/** Min LCP samples a page needs before it's ranked in "slowest pages" (p75 reliability). */
const MIN_PATH_SAMPLES = 5;

/**
 * An absolute, SQLite-comparable analytics window (arbitrary start/end date range).
 * `since`/`until` MUST be plain `YYYY-MM-DD` (or `YYYY-MM-DD HH:MM:SS`) strings —
 * NEVER ISO-8601 with `T`/`Z`, which sorts WRONG against D1's space-separated
 * `created_at` (space 0x20 < `T` 0x54, so a `T`-bound would drop the boundary day).
 * `since` is inclusive (`created_at >= since`); `until` is exclusive (`created_at < until`).
 */
export interface AnalyticsWindow {
  readonly since: string;
  readonly until: string;
}

/** Epoch ms for a `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` string, treated as UTC. */
function windowMs(d: string): number {
  return Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : `${d.replace(' ', 'T')}Z`);
}

/**
 * Re-interpret an absolute window's date-only day boundaries in the OWNER's
 * timezone by shifting each bound to its UTC equivalent — so "Aug 1" filters from
 * the owner's local midnight, consistent with the tz-aware daily bucketing (a PST
 * owner's `since='2026-08-01'` becomes `2026-08-01 08:00:00` UTC). `tzOffsetMinutes`
 * is east-positive (PST = -480); local wall-clock T = UTC + offset ⇒ UTC = T - offset.
 * Returns the window UNCHANGED for a 0 / non-integer / out-of-range (±14h) offset, so
 * a UTC or junk value falls back to the plain date-only (UTC) bounds. Output is
 * `YYYY-MM-DD HH:MM:SS` (D1-comparable, space-separated — never ISO `T`/`Z`).
 */
export function shiftWindowToTz(
  window: AnalyticsWindow,
  tzOffsetMinutes: number | undefined,
): AnalyticsWindow {
  if (
    typeof tzOffsetMinutes !== 'number' ||
    !Number.isInteger(tzOffsetMinutes) ||
    tzOffsetMinutes === 0 ||
    tzOffsetMinutes < -840 ||
    tzOffsetMinutes > 840
  ) {
    return window;
  }
  const toUtc = (dateOnly: string): string =>
    new Date(windowMs(dateOnly) - tzOffsetMinutes * 60_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
  return { since: toUtc(window.since), until: toUtc(window.until) };
}

/** Whole-day span of an absolute window (minimum 1). */
function windowSpanDays(w: AnalyticsWindow): number {
  return Math.max(1, Math.round((windowMs(w.until) - windowMs(w.since)) / 86_400_000));
}

/**
 * AN-FILTER — maps each allowlisted {@link AnalyticsFilterDimension} to its exact SQL
 * column / json_extract expression for a drilldown restriction. Keyed by the Zod enum
 * so it CANNOT drift: `satisfies Record<AnalyticsFilterDimension, string>` fails the
 * build if a dimension is missing, and TypeScript rejects any extra key — so the only
 * strings that can ever reach a query are these six trusted literals. The filter VALUE
 * is always a bound `?` param (never interpolated).
 */
const FILTER_DIMENSION_SQL = {
  country: "json_extract(metadata, '$.country')",
  device: "json_extract(metadata, '$.device')",
  browser: "json_extract(metadata, '$.browser')",
  os: "json_extract(metadata, '$.os')",
  channel: "json_extract(metadata, '$.channel')",
  path: 'path',
} as const satisfies Record<AnalyticsFilterDimension, string>;

/**
 * SQL fragment + bind params restricting a query to a single dimension value, appended
 * AFTER the window clause (so it only ever NARROWS the already-`site_id`-scoped set — a
 * filter can never widen or cross a tenant boundary). Empty for no filter OR an unknown
 * dim (defense in depth — the column is only ever pulled from the trusted
 * {@link FILTER_DIMENSION_SQL} map, so it is a literal; the value is always bound `?`).
 */
function filterClause(filter?: AnalyticsFilter): {
  readonly sql: string;
  readonly params: unknown[];
} {
  if (!filter) return { sql: '', params: [] };
  const col = FILTER_DIMENSION_SQL[filter.dim];
  if (!col) return { sql: '', params: [] }; // unknown dim → no-op; never interpolate a raw string
  return { sql: ` AND ${col} = ?`, params: [filter.value] };
}

/**
 * Current-window WHERE clause + bind params for a `visitor_events` query scoped to
 * `site_id`. An absolute window → bound literals (`created_at >= ? AND created_at < ?`);
 * otherwise the trailing relative window (`created_at >= datetime('now', ?)`). An
 * optional {@link AnalyticsFilter} appends a bound `AND <col> = ?` drilldown restriction.
 */
function currentWindow(
  siteId: string,
  windowDays: number,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): { readonly clause: string; readonly params: unknown[] } {
  const f = filterClause(filter);
  if (window) {
    return {
      clause: `site_id = ? AND created_at >= ? AND created_at < ?${f.sql}`,
      params: [siteId, window.since, window.until, ...f.params],
    };
  }
  return {
    clause: `site_id = ? AND created_at >= datetime('now', ?)${f.sql}`,
    params: [siteId, `-${windowDays} days`, ...f.params],
  };
}

/**
 * The equal-length window immediately BEFORE the current one, for period-over-period
 * deltas. Absolute: `[since - span, since)`; relative: `[now-2N, now-N)`. The SAME
 * {@link AnalyticsFilter} is applied so the comparison is like-for-like (US-this-period
 * vs US-last-period, never US-now vs everyone-then).
 */
function previousWindow(
  siteId: string,
  windowDays: number,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): { readonly pw: string; readonly pwParams: unknown[] } {
  const f = filterClause(filter);
  if (window) {
    const span = windowMs(window.until) - windowMs(window.since);
    const prevSince = new Date(windowMs(window.since) - span).toISOString().slice(0, 10);
    return {
      pw: `site_id = ? AND created_at >= ? AND created_at < ?${f.sql}`,
      pwParams: [siteId, prevSince, window.since, ...f.params],
    };
  }
  return {
    pw: `site_id = ? AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?)${f.sql}`,
    pwParams: [siteId, `-${windowDays * 2} days`, `-${windowDays} days`, ...f.params],
  };
}

/** Time-only predicate + params for a single-query summary (web vitals / conversions).
 *  Threads the SAME optional {@link AnalyticsFilter} as the window builders. */
function timePredicate(
  siteId: string,
  windowDays: number,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): { readonly time: string; readonly params: unknown[] } {
  const f = filterClause(filter);
  return window
    ? {
        time: `created_at >= ? AND created_at < ?${f.sql}`,
        params: [siteId, window.since, window.until, ...f.params],
      }
    : {
        time: `created_at >= datetime('now', ?)${f.sql}`,
        params: [siteId, `-${windowDays} days`, ...f.params],
      };
}

/**
 * Real-user Core Web Vitals p75 over the window, computed from the `web_vital`
 * beacon rows in `visitor_events`. Queried DIRECTLY (not via the analytics_daily
 * rollup, which doesn't carry CWV), so it works in both the live and rollup
 * summary paths. Bounded to the most-recent 50k samples for query cost.
 *
 * HONESTY: a metric with zero field samples is `null` (never `{p75: 0}`); LCP/INP
 * round to integer ms, CLS to 3 decimals (as the beacon stores them).
 *
 * @remarks Fail-soft — a missing table / query error yields an all-null summary.
 */
export async function getWebVitalsSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<WebVitals> {
  const win = timePredicate(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{
    metric: string | null;
    value: number;
    path: string | null;
  }>(
    env.DB,
    `SELECT json_extract(metadata, '$.metric') AS metric,
            CAST(json_extract(metadata, '$.value') AS REAL) AS value,
            path
       FROM visitor_events
      WHERE site_id = ? AND event_type = 'web_vital'
        AND ${win.time}
        AND json_extract(metadata, '$.metric') IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')
      ORDER BY created_at DESC
      LIMIT 50000`,
    win.params,
  );
  const empty: WebVitals = {
    lcp: null,
    inp: null,
    cls: null,
    fcp: null,
    ttfb: null,
    slowestPages: [],
  };
  if (error) return empty;

  const buckets: Record<(typeof CWV_METRICS)[number], number[]> = { LCP: [], INP: [], CLS: [] };
  const plBuckets: Record<(typeof PAGELOAD_METRICS)[number], number[]> = { FCP: [], TTFB: [] };
  const lcpByPath = new Map<string, number[]>();
  const inpByPath = new Map<string, number[]>();
  const clsByPath = new Map<string, number[]>();
  const fcpByPath = new Map<string, number[]>();
  const ttfbByPath = new Map<string, number[]>();
  const pushByPath = (map: Map<string, number[]>, path: string, v: number): void => {
    const arr = map.get(path);
    if (arr) arr.push(v);
    else map.set(path, [v]);
  };
  for (const row of data) {
    const m = row.metric;
    const v = Number(row.value);
    if (!(m && Number.isFinite(v) && v >= 0)) continue;
    if (m in plBuckets) {
      plBuckets[m as (typeof PAGELOAD_METRICS)[number]].push(v);
      // Also bucket FCP/TTFB PER PAGE so the slowest-pages drilldown shows the full
      // per-page picture (LCP · INP · CLS · FCP · TTFB), gated on the same sample floor.
      if (typeof row.path === 'string' && row.path) {
        if (m === 'FCP') pushByPath(fcpByPath, row.path, v);
        else if (m === 'TTFB') pushByPath(ttfbByPath, row.path, v);
      }
      continue; // FCP/TTFB are page-load timing, not CWV — no CWV-bucket, no LCP ranking
    }
    if (!(m in buckets)) continue;
    const cm = m as (typeof CWV_METRICS)[number];
    buckets[cm].push(v);
    // Bucket EACH metric per page so the "slowest pages" drilldown shows the full
    // per-page CWV picture (LCP · INP · CLS), not LCP alone.
    if (typeof row.path === 'string' && row.path) {
      if (cm === 'LCP') pushByPath(lcpByPath, row.path, v);
      else if (cm === 'INP') pushByPath(inpByPath, row.path, v);
      else if (cm === 'CLS') pushByPath(clsByPath, row.path, v);
    }
  }
  const stat = (metric: (typeof CWV_METRICS)[number]) => {
    const vals = buckets[metric];
    if (vals.length === 0) return null;
    const raw = percentile(vals, 75);
    const p75 = metric === 'CLS' ? Math.round(raw * 1000) / 1000 : Math.round(raw);
    // Distribution behind the p75 — classify each real sample against Google's
    // thresholds so the card shows the SPREAD (a good p75 can still hide a poor tail).
    const [good, needs] = CWV_THRESHOLDS[metric];
    const dist = { good: 0, needs: 0, poor: 0 };
    for (const v of vals) {
      if (v <= good) dist.good++;
      else if (v <= needs) dist.needs++;
      else dist.poor++;
    }
    return { p75, samples: vals.length, dist };
  };
  // Page-load timing (FCP/TTFB): integer-ms p75 + good/needs/poor distribution against
  // the page-load thresholds. Null (never a fabricated 0) when a metric has no samples.
  const plStat = (metric: (typeof PAGELOAD_METRICS)[number]) => {
    const vals = plBuckets[metric];
    if (vals.length === 0) return null;
    const p75 = Math.round(percentile(vals, 75));
    const [good, needs] = PAGELOAD_THRESHOLDS[metric];
    const dist = { good: 0, needs: 0, poor: 0 };
    for (const v of vals) {
      if (v <= good) dist.good++;
      else if (v <= needs) dist.needs++;
      else dist.poor++;
    }
    return { p75, samples: vals.length, dist };
  };
  // Slowest pages by LCP p75 — only pages past the sample floor (reliable p75), worst
  // first, capped so the drilldown stays focused + bounded. Each page ALSO carries its
  // INP + CLS p75 (when that page cleared the same sample floor for that metric) so the
  // owner sees the FULL per-page CWV picture, not LCP alone. Undefined (never 0) when a
  // page lacks enough INP/CLS samples — honest, never a fabricated metric.
  const pathP75 = (map: Map<string, number[]>, path: string, isCls = false): number | undefined => {
    const vals = map.get(path);
    if (!vals || vals.length < MIN_PATH_SAMPLES) return undefined;
    const raw = percentile(vals, 75);
    return isCls ? Math.round(raw * 1000) / 1000 : Math.round(raw);
  };
  const slowestPages = [...lcpByPath.entries()]
    .filter(([, vals]) => vals.length >= MIN_PATH_SAMPLES)
    .map(([path, vals]) => ({
      path,
      lcpP75: Math.round(percentile(vals, 75)),
      inpP75: pathP75(inpByPath, path),
      clsP75: pathP75(clsByPath, path, true),
      fcpP75: pathP75(fcpByPath, path),
      ttfbP75: pathP75(ttfbByPath, path),
      samples: vals.length,
    }))
    .sort((a, b) => b.lcpP75 - a.lcpP75)
    .slice(0, 5);
  return {
    lcp: stat('LCP'),
    inp: stat('INP'),
    cls: stat('CLS'),
    fcp: plStat('FCP'),
    ttfb: plStat('TTFB'),
    slowestPages,
  };
}

/**
 * Conversions broken down by kind (call / directions / form / email / …) over the
 * window — the actual business outcomes an owner acts on. Queried DIRECTLY from
 * `visitor_events` `conversion` rows (works in BOTH the live + rollup summary paths,
 * since the analytics_daily rollup carries by-type but not by-conversion-kind).
 *
 * @remarks Fail-soft — a missing table / query error yields []. A conversion with
 * no `kind` (a generic goal) buckets as 'other' so it's counted, never dropped.
 */
async function conversionKindsForClause(
  env: Env,
  clause: string,
  params: unknown[],
): Promise<LabelCount[]> {
  const { data, error } = await dbQuery<{ label: string | null; n: number }>(
    env.DB,
    `SELECT json_extract(metadata, '$.kind') AS label, COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'conversion'
      GROUP BY label ORDER BY n DESC LIMIT 20`,
    params,
  );
  if (error) return [];
  return data.map((r) => ({ label: r.label ?? 'other', count: Number(r.n) }));
}

export async function getConversionKinds(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<LabelCount[]> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  return conversionKindsForClause(env, clause, params);
}

/**
 * AN-OUTBOUND — the WHICH-LINKS companion to {@link getConversionKinds} (which gives the
 * by-CATEGORY counts). Groups `conversion` events by their stored click DESTINATION (`$.href`,
 * the owner's own server-normalized outbound/contact link) → the top links visitors actually
 * click, each with its kind (call / email / outbound / directions). Answers "are people tapping
 * my phone number / booking link / Instagram?". Only conversions that CARRY an href are counted
 * (CTA-button clicks with no href stay in the by-kind card). Fail-soft: a query error OR no rows
 * yields `{ total: 0, byLink: [] }`. `total` is the count across ALL link-clicks (not just the
 * top-8 shown), so the card can say "N link clicks · top 8".
 */
export async function getOutboundClicksSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<OutboundClicksSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ href: string | null; kind: string | null; n: number }>(
    env.DB,
    `SELECT json_extract(metadata, '$.href') AS href,
            MAX(json_extract(metadata, '$.kind')) AS kind,
            COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'conversion'
        AND json_extract(metadata, '$.href') IS NOT NULL
      GROUP BY href ORDER BY n DESC LIMIT 50`,
    params,
  );
  if (error) return { total: 0, byLink: [] };
  let total = 0;
  const byLink = [];
  for (const r of data) {
    if (typeof r.href !== 'string' || !r.href) continue;
    const count = Number(r.n) || 0;
    total += count;
    if (byLink.length < 8) {
      byLink.push({ href: r.href, kind: typeof r.kind === 'string' ? r.kind : null, count });
    }
  }
  return { total, byLink };
}

/**
 * AN-FORM — the contact-form LEAD FUNNEL over the window. Counts `form_start` (validated
 * submit attempts) and `form_submit` (server-confirmed successes) from `visitor_events`,
 * grouped by the form key (`json_extract(metadata,'$.form')`, set by the beacon to the
 * form's id/name, or 'contact'). One tenant-scoped query (`currentWindow` supplies the
 * `site_id = ?` + time-window + optional drilldown predicate — the SAME authz clause every
 * sibling uses, so a non-owned site is never read). Reads `visitor_events` DIRECTLY, so it
 * works in BOTH the live + rollup summary paths (like conversions/outbound; the daily
 * rollup carries none of these funnel events).
 *
 * @remarks Fail-soft — a missing table / query error yields an empty summary (never throws
 * into the summary assembly). `completionRatePercent` is null when there are no starts (no
 * attempts → no rate, never a fabricated 0%); clamped to 100 when confirmed submits exceed
 * validated starts (a submit whose start fell in a prior window — data anomaly, not >100%).
 */
export async function getFormFunnelSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<FormFunnelSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{
    form: string | null;
    starts: number;
    submits: number;
  }>(
    env.DB,
    `SELECT json_extract(metadata, '$.form') AS form,
            SUM(CASE WHEN event_type = 'form_start' THEN 1 ELSE 0 END) AS starts,
            SUM(CASE WHEN event_type = 'form_submit' THEN 1 ELSE 0 END) AS submits
       FROM visitor_events
      WHERE ${clause} AND event_type IN ('form_start', 'form_submit')
      GROUP BY form ORDER BY starts DESC, submits DESC LIMIT 20`,
    params,
  );
  if (error) return { starts: 0, submits: 0, completionRatePercent: null, byForm: [] };
  // completion% = submits/starts, null when no starts, clamped ≤100 for the submit-without-
  // start anomaly (a start beacon lost, or the start landed in a prior window).
  const rate = (submits: number, starts: number): number | null =>
    starts > 0 ? Math.min(100, Math.round((submits / starts) * 100)) : null;
  let totalStarts = 0;
  let totalSubmits = 0;
  const byForm: FormFunnelEntry[] = [];
  for (const r of data) {
    const starts = Number(r.starts) || 0;
    const submits = Number(r.submits) || 0;
    if (starts === 0 && submits === 0) continue;
    totalStarts += starts;
    totalSubmits += submits;
    byForm.push({
      form: typeof r.form === 'string' && r.form ? r.form : 'contact',
      starts,
      submits,
      completionRatePercent: rate(submits, starts),
    });
  }
  return {
    starts: totalStarts,
    submits: totalSubmits,
    completionRatePercent: rate(totalSubmits, totalStarts),
    byForm,
  };
}

/**
 * AN-JSERR — first-party JS-error site-health over the window: uncaught errors /
 * unhandled rejections from the `js_error` beacon (mirrored into `visitor_events`),
 * grouped by message (worst first, top 8 displayed) + a sample path each. Queried
 * DIRECTLY (works in BOTH the live + rollup summary paths, like CWV/conversions). Owner
 * scope rides the `currentWindow` predicate's bound `site_id` — never a client filter.
 *
 * @remarks Fail-soft — a missing table / query error yields the empty CLEAN summary
 * (`{total:0, byMessage:[]}`). `total` sums every grouped message (capped 100 distinct);
 * `byMessage` is the top 8 for display. An empty result = a clean site, NEVER "not
 * measured" (the beacon runs on every page).
 */
export async function getJsErrorSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<JsErrorSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{
    message: string | null;
    n: number;
    sample_path: string | null;
  }>(
    env.DB,
    `SELECT json_extract(metadata, '$.message') AS message,
            COUNT(*) AS n,
            MAX(path) AS sample_path
       FROM visitor_events
      WHERE ${clause} AND event_type = 'js_error'
      GROUP BY message ORDER BY n DESC LIMIT 100`,
    params,
  );
  if (error) return { total: 0, byMessage: [] };
  const groups = data
    .filter((r) => typeof r.message === 'string' && r.message)
    .map((r) => ({
      message: r.message as string,
      count: Number(r.n),
      samplePath: typeof r.sample_path === 'string' && r.sample_path ? r.sample_path : undefined,
    }));
  const total = groups.reduce((s, g) => s + g.count, 0);
  return { total, byMessage: groups.slice(0, 8) };
}

/**
 * AN-ENGAGE — first-party time-on-page (dwell) over the window: MEDIAN `duration_ms` from
 * the `page_engagement` beacon (mirrored into `visitor_events`), site-wide + per page (top
 * by dwell, past the {@link MIN_PATH_SAMPLES} floor). Median, NOT mean — dwell is
 * outlier-skewed. Queried DIRECTLY (works in BOTH summary paths, like CWV/js_error). Owner
 * scope rides the `currentWindow` bound `site_id`. Durations bounded 50k rows.
 *
 * @remarks Fail-soft — a missing table / query error yields the empty (null-median)
 * summary. `medianMs` is `null` when there are no samples (never a fabricated 0 — the beacon
 * runs on every page, so 0 is not "no data").
 */
export async function getEngagementSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<EngagementSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ path: string | null; duration: number }>(
    env.DB,
    `SELECT path, CAST(json_extract(metadata, '$.duration_ms') AS INTEGER) AS duration
       FROM visitor_events
      WHERE ${clause} AND event_type = 'page_engagement'
        AND json_extract(metadata, '$.duration_ms') IS NOT NULL
      LIMIT 50000`,
    params,
  );
  if (error)
    return {
      medianMs: null,
      samples: 0,
      byPage: [],
      distribution: { s10: 0, s30: 0, s60: 0, s180: 0 },
    };
  const all: number[] = [];
  const byPath = new Map<string, number[]>();
  for (const r of data) {
    const d = Number(r.duration);
    if (!Number.isFinite(d) || d < 0) continue;
    all.push(d);
    if (typeof r.path === 'string' && r.path) {
      const arr = byPath.get(r.path);
      if (arr) arr.push(d);
      else byPath.set(r.path, [d]);
    }
  }
  if (all.length === 0)
    return {
      medianMs: null,
      samples: 0,
      byPage: [],
      distribution: { s10: 0, s30: 0, s60: 0, s180: 0 },
    };
  const byPage = [...byPath.entries()]
    .filter(([, vals]) => vals.length >= MIN_PATH_SAMPLES)
    .map(([path, vals]) => ({
      path,
      medianMs: Math.round(percentile(vals, 50)),
      samples: vals.length,
    }))
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, 8);
  // AN-ENGAGE-DIST — dwell thresholds in ms; monotonic by construction (a visit past 60s is
  // also past 30s). Counts of visits reaching each threshold — the spread the median hides.
  const distribution = {
    s10: all.filter((d) => d >= 10_000).length,
    s30: all.filter((d) => d >= 30_000).length,
    s60: all.filter((d) => d >= 60_000).length,
    s180: all.filter((d) => d >= 180_000).length,
  };
  return { medianMs: Math.round(percentile(all, 50)), samples: all.length, byPage, distribution };
}

/** Result of {@link getNewVsReturningSummary}. */
export interface NewVsReturningSummary {
  /** Page visits from a browser recording its FIRST-EVER visit (localStorage marker was absent). */
  readonly newVisits: number;
  /** Page visits from a browser seen before (marker present). */
  readonly returningVisits: number;
  /** Page visits where the flag couldn't be determined (private mode / storage disabled) — NEVER folded into new/returning. */
  readonly unknownVisits: number;
}

/**
 * New-vs-returning page-visit split from the first-party `page_engagement` beacon's browser-scoped
 * `nv` flag (1 = the browser's first-ever visit, 0 = seen before, absent = couldn't determine).
 * Browser-scoped + honest: a new device or cleared storage counts as new; `unknownVisits` is surfaced
 * separately, never folded into either bucket. Fail-soft: a query error yields all-zero.
 */
export async function getNewVsReturningSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<NewVsReturningSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ nv: number | null; n: number }>(
    env.DB,
    `SELECT json_extract(metadata, '$.nv') AS nv, COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'page_engagement'
      GROUP BY nv`,
    params,
  );
  const out = { newVisits: 0, returningVisits: 0, unknownVisits: 0 };
  if (error) return out;
  for (const r of data) {
    const n = Number(r.n) || 0;
    // Null-check FIRST — Number(null) === 0 would misfold "unknown" into returning.
    if (r.nv === null || r.nv === undefined) out.unknownVisits += n;
    else if (Number(r.nv) === 1) out.newVisits += n;
    else if (Number(r.nv) === 0) out.returningVisits += n;
    else out.unknownVisits += n;
  }
  return out;
}

/** Result of {@link getEntryPagesSummary} — top entry (landing) pages by session-start count. */
export interface EntryPagesSummary {
  /** Top landing pages (session's first page) by count, descending, capped at 20. */
  readonly pages: ReadonlyArray<{ path: string; count: number }>;
}

/**
 * Top ENTRY (landing) pages over the window, from the first-party `page_engagement` beacon's
 * session-scoped `ep` flag (1 = the tab-session's first page). Answers "where do visitors land?" —
 * a metric CF's plan has no dataset for. Fail-soft: a query error yields the empty summary (the card
 * shows "measuring…", never a fabricated 0).
 */
export async function getEntryPagesSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<EntryPagesSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ path: string | null; n: number }>(
    env.DB,
    `SELECT path, COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'page_engagement'
        AND json_extract(metadata, '$.ep') = 1
      GROUP BY path
      ORDER BY n DESC
      LIMIT 20`,
    params,
  );
  if (error) return { pages: [] };
  const pages: Array<{ path: string; count: number }> = [];
  for (const r of data) {
    const count = Number(r.n) || 0;
    if (typeof r.path === 'string' && r.path && count > 0) pages.push({ path: r.path, count });
  }
  return { pages };
}

/** Top exit (last) pages over the window — the complement to entry pages. */
export interface ExitPagesSummary {
  /** Top exit pages (the session's LAST page) by count, descending, capped at 20. */
  readonly pages: ReadonlyArray<{ path: string; count: number }>;
}

/**
 * Top EXIT (last) pages over the window — the LAST first-party `page_engagement` per tab-session
 * (grouped by the session-scoped `sid` beacon field). Answers "where do visitors leave from?" — the
 * complement to entry pages; a metric CF's plan has no dataset for. A window function (ROW_NUMBER)
 * picks each session's last engagement; sessions with no `sid` (storage unavailable) are excluded,
 * never guessed. Fail-soft: a query error yields the empty summary (the card shows "measuring…",
 * never a fabricated 0).
 */
export async function getExitPagesSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<ExitPagesSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  // Exit page = each session's LAST page_engagement. The INNER query is already site-scoped by
  // `clause` (tenant isolation); the window function only ranks within that scoped set, so the
  // outer query never crosses a tenant boundary.
  const { data, error } = await dbQuery<{ path: string | null; n: number }>(
    env.DB,
    `SELECT path, COUNT(*) AS n
       FROM (
         SELECT path,
                ROW_NUMBER() OVER (
                  PARTITION BY json_extract(metadata, '$.sid')
                  ORDER BY created_at DESC, rowid DESC
                ) AS rn
           FROM visitor_events
          WHERE ${clause} AND event_type = 'page_engagement'
            AND json_extract(metadata, '$.sid') IS NOT NULL
       )
      WHERE rn = 1
      GROUP BY path
      ORDER BY n DESC
      LIMIT 20`,
    params,
  );
  if (error) return { pages: [] };
  const pages: Array<{ path: string; count: number }> = [];
  for (const r of data) {
    const count = Number(r.n) || 0;
    if (typeof r.path === 'string' && r.path && count > 0) pages.push({ path: r.path, count });
  }
  return { pages };
}

/** Empty scroll-depth summary — honest "measuring…" (null median), never a fabricated 0. */
function emptyScrollDepth(): ScrollDepthSummary {
  return {
    samples: 0,
    medianPercent: null,
    reach: { p25: 0, p50: 0, p75: 0, p100: 0 },
    byPage: [],
  };
}

/**
 * AN-SCROLL — first-party scroll depth over the window, from the `scroll_depth` beacon
 * (mirrored into `visitor_events`). Each row is ONE pageview's MAX depth reached (0–100).
 * Returns the site-wide MEDIAN max-depth, a monotonic reach funnel (how many samples got
 * ≥25/50/75/100% deep), and the deepest-read pages (past {@link MIN_PATH_SAMPLES}) with each
 * page's completion rate. Fail-soft: a query error OR no samples yields the empty summary
 * (null median) — the card shows "measuring…", NEVER a fabricated 0. Median (not mean) because
 * depth is bimodal (bounce-at-top vs read-to-bottom). Percent is clamped 0–100 defensively.
 */
export async function getScrollDepthSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<ScrollDepthSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ path: string | null; pct: number }>(
    env.DB,
    `SELECT path, CAST(json_extract(metadata, '$.percent') AS INTEGER) AS pct
       FROM visitor_events
      WHERE ${clause} AND event_type = 'scroll_depth'
        AND json_extract(metadata, '$.percent') IS NOT NULL
      LIMIT 50000`,
    params,
  );
  if (error) return emptyScrollDepth();
  const all: number[] = [];
  const byPath = new Map<string, number[]>();
  for (const r of data) {
    let p = Number(r.pct);
    if (!Number.isFinite(p)) continue;
    p = p < 0 ? 0 : p > 100 ? 100 : p;
    all.push(p);
    if (typeof r.path === 'string' && r.path) {
      const arr = byPath.get(r.path);
      if (arr) arr.push(p);
      else byPath.set(r.path, [p]);
    }
  }
  if (all.length === 0) return emptyScrollDepth();
  const reach = {
    p25: all.filter((p) => p >= 25).length,
    p50: all.filter((p) => p >= 50).length,
    p75: all.filter((p) => p >= 75).length,
    p100: all.filter((p) => p >= 100).length,
  };
  const byPage = [...byPath.entries()]
    .filter(([, vals]) => vals.length >= MIN_PATH_SAMPLES)
    .map(([path, vals]) => ({
      path,
      medianPercent: Math.round(percentile(vals, 50)),
      samples: vals.length,
      completionPercent: Math.round((100 * vals.filter((p) => p >= 100).length) / vals.length),
    }))
    .sort((a, b) => b.medianPercent - a.medianPercent)
    .slice(0, 8);
  return { samples: all.length, medianPercent: Math.round(percentile(all, 50)), reach, byPage };
}

/** Empty network-quality summary — honest "measuring…" (null medians), never a fabricated 0. */
function emptyNetworkQuality(): NetworkQualitySummary {
  return {
    samples: 0,
    byEffectiveType: [],
    medianDownlinkMbps: null,
    medianRttMs: null,
    saveDataPercent: null,
    byPage: [],
  };
}

/** effectiveType classes worst→best, so the distribution renders slow-first (attention-first). */
const NETWORK_CLASS_ORDER = ['slow-2g', '2g', '3g', '4g'] as const;

/**
 * AN-NET — first-party visitor connection quality over the window, from the `network_quality`
 * beacon (`navigator.connection`, mirrored into `visitor_events`). Returns the distribution
 * across 4g/3g/2g/slow-2g, the site-wide MEDIAN downlink (Mbps) + rtt (ms), and the share of
 * visits with the browser data-saver on. Fail-soft: a query error OR no samples yields the
 * empty summary (null medians) — the card shows "measuring…", NEVER a fabricated 0. Median
 * (not mean) because the browser's estimates are coarse + skewed. HONESTY: the sample is
 * Chromium-only (Chrome/Edge/Android report `navigator.connection`; Safari/Firefox don't), so
 * `samples` is a SUBSET of visitors — the card states this so the split is never read as "all".
 */
export async function getNetworkQualitySummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<NetworkQualitySummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{
    path: string | null;
    etype: string | null;
    downlink: number | null;
    rtt: number | null;
    save_data: number | null;
  }>(
    env.DB,
    `SELECT path,
            json_extract(metadata, '$.effective_type') AS etype,
            json_extract(metadata, '$.downlink')       AS downlink,
            CAST(json_extract(metadata, '$.rtt') AS INTEGER) AS rtt,
            json_extract(metadata, '$.save_data')      AS save_data
       FROM visitor_events
      WHERE ${clause} AND event_type = 'network_quality'
      LIMIT 50000`,
    params,
  );
  if (error) return emptyNetworkQuality();
  const byType = new Map<string, number>();
  const downlinks: number[] = [];
  const rtts: number[] = [];
  // Per-page connection samples (path → downlink Mbps + rtt ms) for the slowest-connection-pages drill.
  const pageDownlink = new Map<string, number[]>();
  const pageRtt = new Map<string, number[]>();
  let saveDataTrue = 0;
  let saveDataKnown = 0;
  let samples = 0;
  for (const r of data) {
    samples++;
    if (
      typeof r.etype === 'string' &&
      (NETWORK_CLASS_ORDER as readonly string[]).includes(r.etype)
    ) {
      byType.set(r.etype, (byType.get(r.etype) ?? 0) + 1);
    }
    const d = Number(r.downlink);
    if (Number.isFinite(d) && d >= 0) downlinks.push(d);
    const rt = Number(r.rtt);
    if (Number.isFinite(rt) && rt >= 0) rtts.push(rt);
    if (typeof r.path === 'string' && r.path) {
      if (Number.isFinite(d) && d >= 0) {
        const arr = pageDownlink.get(r.path);
        if (arr) arr.push(d);
        else pageDownlink.set(r.path, [d]);
      }
      if (Number.isFinite(rt) && rt >= 0) {
        const arr = pageRtt.get(r.path);
        if (arr) arr.push(rt);
        else pageRtt.set(r.path, [rt]);
      }
    }
    // save_data is stored as a JSON boolean → SQLite 1/0; count only rows that carry it.
    if (r.save_data === 1 || r.save_data === 0) {
      saveDataKnown++;
      if (r.save_data === 1) saveDataTrue++;
    }
  }
  if (samples === 0) return emptyNetworkQuality();
  const byEffectiveType = NETWORK_CLASS_ORDER.filter((t) => (byType.get(t) ?? 0) > 0).map((t) => ({
    type: t,
    count: byType.get(t) as number,
  }));
  // Slowest-connection pages: gated on ≥MIN_PATH_SAMPLES downlink samples (the ranking key is a
  // reliable median), lowest median downlink first (the pages whose audience is on the slowest links).
  const byPage = [...pageDownlink.entries()]
    .filter(([, dls]) => dls.length >= MIN_PATH_SAMPLES)
    .map(([path, dls]) => {
      const rttArr = pageRtt.get(path) ?? [];
      return {
        path,
        medianDownlinkMbps: Math.round(percentile(dls, 50) * 10) / 10,
        medianRttMs: rttArr.length ? Math.round(percentile(rttArr, 50)) : null,
        samples: dls.length,
      };
    })
    .sort((a, b) => a.medianDownlinkMbps - b.medianDownlinkMbps)
    .slice(0, 8);
  return {
    samples,
    byEffectiveType,
    medianDownlinkMbps: downlinks.length ? Math.round(percentile(downlinks, 50) * 10) / 10 : null,
    medianRttMs: rtts.length ? Math.round(percentile(rtts, 50)) : null,
    saveDataPercent: saveDataKnown ? Math.round((100 * saveDataTrue) / saveDataKnown) : null,
    byPage,
  };
}

/** Empty page-load summary — honest "measuring…" (null medians), never a fabricated 0. */
function emptyNavTiming(): NavTimingSummary {
  return {
    samples: 0,
    dns: null,
    connect: null,
    ttfb: null,
    transfer: null,
    dom: null,
    total: null,
    byPage: [],
  };
}

/** The nav-timing phases, in the load order they render as a waterfall. */
const NAV_PHASES = ['dns', 'connect', 'ttfb', 'transfer', 'dom', 'total'] as const;

/**
 * AN-NAV — first-party page-load WATERFALL over the window, from the `nav_timing` beacon
 * (PerformanceNavigationTiming, mirrored into `visitor_events`). Returns the site-wide MEDIAN
 * of each load phase (ms): dns · connect · ttfb · transfer · dom · total — so an owner sees
 * WHERE their load time goes. Fail-soft: a query error OR no samples yields the empty summary
 * (all-null) — the card shows "measuring…", NEVER a fabricated 0. Each phase's median is over
 * the rows that CARRY that phase (a phase is always present when the beacon fires, but a value
 * can be an honest 0 — cached DNS / reused connection — which IS counted). Median (not mean)
 * because page-load timings are right-skewed by slow tails.
 */
export async function getNavTimingSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<NavTimingSummary> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<Record<string, number | null> & { path: string | null }>(
    env.DB,
    `SELECT path,
            CAST(json_extract(metadata, '$.dns')      AS INTEGER) AS dns,
            CAST(json_extract(metadata, '$.connect')  AS INTEGER) AS connect,
            CAST(json_extract(metadata, '$.ttfb')     AS INTEGER) AS ttfb,
            CAST(json_extract(metadata, '$.transfer') AS INTEGER) AS transfer,
            CAST(json_extract(metadata, '$.dom')      AS INTEGER) AS dom,
            CAST(json_extract(metadata, '$.total')    AS INTEGER) AS total
       FROM visitor_events
      WHERE ${clause} AND event_type = 'nav_timing'
        AND json_extract(metadata, '$.total') IS NOT NULL
      LIMIT 50000`,
    params,
  );
  if (error) return emptyNavTiming();
  const cols: Record<string, number[]> = {
    dns: [],
    connect: [],
    ttfb: [],
    transfer: [],
    dom: [],
    total: [],
  };
  // Per-page samples for the slowest-pages drilldown: path → total-load ms + TTFB ms.
  const pageTotal = new Map<string, number[]>();
  const pageTtfb = new Map<string, number[]>();
  let samples = 0;
  for (const r of data) {
    samples++;
    for (const phase of NAV_PHASES) {
      const v = Number(r[phase]);
      // A phase value of 0 is a real datum (cached DNS, reused connection) — keep it; only
      // non-finite / negative values are excluded so a median is never skewed by junk.
      if (Number.isFinite(v) && v >= 0) cols[phase].push(v);
    }
    if (typeof r.path === 'string' && r.path) {
      const t = Number(r.total);
      if (Number.isFinite(t) && t >= 0) {
        const arr = pageTotal.get(r.path);
        if (arr) arr.push(t);
        else pageTotal.set(r.path, [t]);
      }
      const tt = Number(r.ttfb);
      if (Number.isFinite(tt) && tt >= 0) {
        const arr = pageTtfb.get(r.path);
        if (arr) arr.push(tt);
        else pageTtfb.set(r.path, [tt]);
      }
    }
  }
  if (samples === 0) return emptyNavTiming();
  const med = (arr: number[]): number | null =>
    arr.length ? Math.round(percentile(arr, 50)) : null;
  // Slowest pages by median total load (past the shared per-path sample floor), each carrying
  // its median TTFB (server wait) — worst-first, top 8. Mirrors the CWV slowest-pages drilldown.
  const byPage = [...pageTotal.entries()]
    .filter(([, totals]) => totals.length >= MIN_PATH_SAMPLES)
    .map(([path, totals]) => ({
      path,
      total: Math.round(percentile(totals, 50)),
      ttfb: med(pageTtfb.get(path) ?? []),
      samples: totals.length,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  return {
    samples,
    dns: med(cols.dns),
    connect: med(cols.connect),
    ttfb: med(cols.ttfb),
    transfer: med(cols.transfer),
    dom: med(cols.dom),
    total: med(cols.total),
    byPage,
  };
}

/**
 * Conversions by kind over the equal-length window immediately BEFORE the current one —
 * the prior-period baseline for the per-kind delta badges. Same SQL as
 * {@link getConversionKinds}, scoped to the {@link previousWindow} predicate.
 */
export async function getPreviousConversionKinds(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<LabelCount[]> {
  const { pw, pwParams } = previousWindow(siteId, windowDays, window, filter);
  return conversionKindsForClause(env, pw, pwParams);
}

/** Metadata dimensions the tech breakdown may GROUP BY — an allowlist so the dimension
 *  name (interpolated into `json_extract($.<dim>)`) is ALWAYS a trusted literal. */
const TECH_DIMENSIONS = ['device', 'browser', 'os'] as const;

/**
 * Pageview breakdown by a user-agent metadata dimension (device / browser / os) over the
 * window — the AN1 enrichment already stores `$.device`/`$.browser`/`$.os`, so this is a
 * cheap GROUP BY, no new instrumentation. Null label (pre-enrichment events) → 'unknown'.
 *
 * @param dim - MUST be one of {@link TECH_DIMENSIONS} (allowlist → safe to interpolate).
 * @remarks Fail-soft — a query error yields []. Not a percentile/scalar; a plain count split.
 */
export async function getDimensionBreakdown(
  env: Env,
  siteId: string,
  dim: (typeof TECH_DIMENSIONS)[number],
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<LabelCount[]> {
  if (!TECH_DIMENSIONS.includes(dim)) return []; // never interpolate an untrusted string
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ label: string | null; n: number }>(
    env.DB,
    `SELECT json_extract(metadata, '$.${dim}') AS label, COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'pageview'
      GROUP BY label ORDER BY n DESC`,
    params,
  );
  if (error) return [];
  return data.map((r) => ({ label: r.label ?? 'unknown', count: Number(r.n) }));
}

/**
 * Pageviews by hour-of-day (0–23, UTC) over the window — the "busiest hours" insight.
 * `created_at` is stored UTC, so `strftime('%H', created_at)` is the UTC hour; the
 * frontend rotates these buckets to the viewer's LOCAL time for display. Only real
 * pageviews count (`event_type='pageview'`; bots are already dropped at ingest). Absent
 * hours are omitted here (the UI renders the missing ones as 0). Fails soft to [].
 */
export async function getHourlyBreakdown(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<HourCount[]> {
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ hour: number | null; n: number }>(
    env.DB,
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'pageview'
      GROUP BY hour ORDER BY hour`,
    params,
  );
  if (error) return [];
  return data
    .filter((r) => r.hour != null && r.hour >= 0 && r.hour <= 23)
    .map((r) => ({ hour: Number(r.hour), count: Number(r.n) }));
}

/** UTM campaign parameters the campaign breakdown may GROUP BY — an allowlist so the
 *  dimension (interpolated into `json_extract($.<dim>)`) is ALWAYS a trusted literal. */
const CAMPAIGN_DIMENSIONS = ['utmSource', 'utmMedium', 'utmCampaign'] as const;

/**
 * Pageview breakdown by a UTM campaign parameter (source / medium / campaign) over the
 * window — the AN1 enrichment stores `$.utmSource`/`$.utmMedium`/`$.utmCampaign` ONLY on
 * UTM-tagged visits (an ad/email link), so this answers "which tagged campaigns drove
 * traffic". CRITICAL vs {@link getDimensionBreakdown}: untagged visits (the direct/organic
 * majority) have a NULL value and are EXCLUDED — a "campaign" breakdown must never bucket
 * the untagged majority as a giant "unknown" (that would misread as "most traffic is
 * unknown-source"). Zero tagged visits → `[]` → the card shows its honest empty state.
 *
 * @param dim - MUST be one of {@link CAMPAIGN_DIMENSIONS} (allowlist → safe to interpolate).
 * @remarks Fail-soft — a query error yields []. Top-20 by count; no new instrumentation.
 */
export async function getCampaignBreakdown(
  env: Env,
  siteId: string,
  dim: (typeof CAMPAIGN_DIMENSIONS)[number],
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<LabelCount[]> {
  if (!CAMPAIGN_DIMENSIONS.includes(dim)) return []; // never interpolate an untrusted string
  const { clause, params } = currentWindow(siteId, windowDays, window, filter);
  const { data, error } = await dbQuery<{ label: string | null; n: number }>(
    env.DB,
    `SELECT json_extract(metadata, '$.${dim}') AS label, COUNT(*) AS n
       FROM visitor_events
      WHERE ${clause} AND event_type = 'pageview'
        AND json_extract(metadata, '$.${dim}') IS NOT NULL
      GROUP BY label ORDER BY n DESC LIMIT 20`,
    params,
  );
  if (error) return [];
  return data.map((r) => ({ label: String(r.label ?? 'unknown'), count: Number(r.n) }));
}

/** Roll up a site's traffic over a trailing window. */
export async function getTrafficSummary(
  env: Env,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<TrafficSummary> {
  // AN3 — when the rollup-read flag is on, serve from analytics_daily (O(days)).
  // Fail-open: any flag-check error falls through to the live scan below.
  // An ABSOLUTE window OR a drilldown FILTER forces the live scan — the calendar-
  // aligned rollup can't answer an arbitrary [since, until) precisely, and it carries
  // NO per-dimension detail to filter on — so skip the rollup entirely in both cases
  // (a filtered request must NEVER silently return unfiltered rollup totals).
  if (!window && !filter) {
    try {
      const { isFlagOn } = await import('../../../src/modules/feature_flags/services.js');
      if (await isFlagOn(env, 'analytics_rollup_read', { siteId })) {
        return getTrafficSummaryFromRollup(env, siteId, windowDays);
      }
    } catch {
      /* fall through to the live path */
    }
  }

  const cur = currentWindow(siteId, windowDays, window, filter);
  const w = cur.clause;
  const wParams = cur.params;
  // AN15 — the equal-length window immediately BEFORE the current one, for
  // period-over-period deltas (relative [now-2N, now-N) or absolute [since-span, since)).
  const { pw, pwParams } = previousWindow(siteId, windowDays, window, filter);
  const effectiveWindowDays = window ? windowSpanDays(window) : windowDays;

  const [
    pageviews,
    uniqueSessions,
    conversions,
    topPathRows,
    byTypeRows,
    byDeviceRows,
    byChannelRows,
    prevPageviews,
    prevSessions,
    prevConversions,
    byCountryRows,
    bounceRows,
    webVitals,
    byConversionKind,
    prevByConversionKind,
    byBrowser,
    byOs,
    byUtmSource,
    byUtmMedium,
    byUtmCampaign,
    byHour,
    jsErrors,
    engagement,
    scrollDepth,
    networkQuality,
    navTiming,
    outboundClicks,
    formFunnel,
  ] = await Promise.all([
    scalar(
      env,
      `SELECT COUNT(*) AS n FROM visitor_events WHERE ${w} AND event_type = 'pageview'`,
      wParams,
    ),
    scalar(env, `SELECT COUNT(DISTINCT session_id) AS n FROM visitor_events WHERE ${w}`, wParams),
    scalar(
      env,
      `SELECT COUNT(*) AS n FROM visitor_events WHERE ${w} AND event_type = 'conversion'`,
      wParams,
    ),
    dbQuery<{ path: string | null; n: number; u: number }>(
      env.DB,
      `SELECT path, COUNT(*) AS n, COUNT(DISTINCT session_id) AS u FROM visitor_events
       WHERE ${w} AND event_type = 'pageview' AND path IS NOT NULL
       GROUP BY path ORDER BY u DESC, n DESC LIMIT 10`,
      wParams,
    ).then((r) => (r.error ? [] : r.data)),
    dbQuery<{ event_type: string; n: number }>(
      env.DB,
      `SELECT event_type, COUNT(*) AS n FROM visitor_events WHERE ${w} GROUP BY event_type ORDER BY n DESC`,
      wParams,
    ).then((r) => (r.error ? [] : r.data)),
    // AN13 — device split over pageviews, from the AN1 metadata enrichment.
    dbQuery<{ label: string | null; n: number }>(
      env.DB,
      `SELECT json_extract(metadata, '$.device') AS label, COUNT(*) AS n FROM visitor_events
       WHERE ${w} AND event_type = 'pageview' GROUP BY label ORDER BY n DESC`,
      wParams,
    ).then((r) => (r.error ? [] : r.data)),
    // AN10 — channel breakdown over pageviews (direct/organic/social/paid/email/referral).
    dbQuery<{ label: string | null; n: number }>(
      env.DB,
      `SELECT json_extract(metadata, '$.channel') AS label, COUNT(*) AS n FROM visitor_events
       WHERE ${w} AND event_type = 'pageview' GROUP BY label ORDER BY n DESC`,
      wParams,
    ).then((r) => (r.error ? [] : r.data)),
    // AN15 — previous-window scalars (same three KPIs) for the delta badges.
    scalar(
      env,
      `SELECT COUNT(*) AS n FROM visitor_events WHERE ${pw} AND event_type = 'pageview'`,
      pwParams,
    ),
    scalar(env, `SELECT COUNT(DISTINCT session_id) AS n FROM visitor_events WHERE ${pw}`, pwParams),
    scalar(
      env,
      `SELECT COUNT(*) AS n FROM visitor_events WHERE ${pw} AND event_type = 'conversion'`,
      pwParams,
    ),
    // AN14 — visitors by country over pageviews (cf.country captured in metadata).
    dbQuery<{ label: string | null; n: number }>(
      env.DB,
      `SELECT json_extract(metadata, '$.country') AS label, COUNT(*) AS n FROM visitor_events
       WHERE ${w} AND event_type = 'pageview' GROUP BY label ORDER BY n DESC`,
      wParams,
    ).then((r) => (r.error ? [] : r.data)),
    // True single-page-session bounce: count sessions and how many had exactly 1
    // pageview, via a per-session depth subquery. Fails soft to zeros on any error.
    dbQuery<{ sessions: number; single: number }>(
      env.DB,
      `SELECT COUNT(*) AS sessions, SUM(CASE WHEN pv = 1 THEN 1 ELSE 0 END) AS single FROM (
         SELECT session_id, COUNT(*) AS pv FROM visitor_events
          WHERE ${w} AND event_type = 'pageview' AND session_id IS NOT NULL
          GROUP BY session_id)`,
      wParams,
    ).then((r) => (r.error || !r.data[0] ? { sessions: 0, single: 0 } : r.data[0])),
    // AN-CWV — real-user Core Web Vitals p75 (queried directly; not in the rollup).
    getWebVitalsSummary(env, siteId, windowDays, window, filter),
    // AN-CONV — conversions by kind (queried directly; not in the rollup).
    getConversionKinds(env, siteId, windowDays, window, filter),
    // AN-CONV-Δ — prior-window conversions by kind, for the per-kind delta badges.
    getPreviousConversionKinds(env, siteId, windowDays, window, filter),
    // AN-TECH — browser + OS split (same AN1 user-agent enrichment as $.device).
    getDimensionBreakdown(env, siteId, 'browser', windowDays, window, filter),
    getDimensionBreakdown(env, siteId, 'os', windowDays, window, filter),
    // AN-UTM — campaign attribution (source + medium + campaign; tagged visits only, untagged excluded).
    getCampaignBreakdown(env, siteId, 'utmSource', windowDays, window, filter),
    getCampaignBreakdown(env, siteId, 'utmMedium', windowDays, window, filter),
    getCampaignBreakdown(env, siteId, 'utmCampaign', windowDays, window, filter),
    // AN-HOUR — pageviews by hour-of-day (UTC; frontend rotates to local).
    getHourlyBreakdown(env, siteId, windowDays, window, filter),
    // AN-JSERR — first-party JS-error site-health (queried directly; not in the rollup).
    getJsErrorSummary(env, siteId, windowDays, window, filter),
    // AN-ENGAGE — first-party time-on-page median (queried directly; not in the rollup).
    getEngagementSummary(env, siteId, windowDays, window, filter),
    // AN-SCROLL — first-party scroll depth (queried directly; not in the rollup).
    getScrollDepthSummary(env, siteId, windowDays, window, filter),
    // AN-NET — first-party visitor connection quality (queried directly; not in the rollup).
    getNetworkQualitySummary(env, siteId, windowDays, window, filter),
    // AN-NAV — first-party page-load waterfall (queried directly; not in the rollup).
    getNavTimingSummary(env, siteId, windowDays, window, filter),
    // AN-OUTBOUND — top clicked outbound/contact links (queried directly; not in the rollup).
    getOutboundClicksSummary(env, siteId, windowDays, window, filter),
    // AN-FORM — contact-form lead funnel (queried directly; the rollup has no funnel events).
    getFormFunnelSummary(env, siteId, windowDays, window, filter),
  ]);

  const topPaths: Array<z.infer<typeof PathCountSchema>> = topPathRows
    .filter((r) => r.path)
    // `u` (COUNT DISTINCT session_id) is always present from the live query; fall
    // back to count for any row lacking it so the strict schema never sees NaN.
    .map((r) => ({ path: r.path as string, count: Number(r.n), uniques: Number(r.u ?? r.n) }));
  const byType = byTypeRows
    .filter((r) => typeof r.event_type === 'string' && r.event_type)
    .map((r) => ({ type: r.event_type, count: Number(r.n) }));
  // Null label = pre-AN1 events (no enrichment) → bucket as 'unknown'.
  const toLabelCounts = (rows: Array<{ label: string | null; n: number }>) =>
    rows.map((r) => ({ label: r.label ?? 'unknown', count: Number(r.n) }));
  const byDevice = toLabelCounts(byDeviceRows);
  const byChannel = toLabelCounts(byChannelRows);
  const byCountry = toLabelCounts(byCountryRows);
  const bounceRatePercent =
    bounceRows.sessions > 0
      ? Math.round((Number(bounceRows.single) / Number(bounceRows.sessions)) * 100)
      : null;

  return TrafficSummarySchema.parse({
    pageviews,
    uniqueSessions,
    conversions,
    bounceRatePercent,
    topPaths,
    byType,
    byDevice,
    byBrowser,
    byOs,
    byUtmSource,
    byUtmMedium,
    byUtmCampaign,
    byHour,
    byChannel,
    byCountry,
    webVitals,
    jsErrors,
    engagement,
    scrollDepth,
    networkQuality,
    navTiming,
    outboundClicks,
    formFunnel,
    byConversionKind,
    previous: {
      pageviews: prevPageviews,
      uniqueSessions: prevSessions,
      conversions: prevConversions,
      byConversionKind: prevByConversionKind,
    },
    windowDays: effectiveWindowDays,
  });
}

/**
 * AN3 — the SAME shape as {@link getTrafficSummary}, read O(days) from the
 * `analytics_daily` rollup instead of scanning O(events) of `visitor_events`.
 *
 * @remarks
 * Today's (incomplete) rollup row is refreshed on demand first (the cron only
 * fills through yesterday), then the whole window is summed from the rollup via
 * SQL `json_each` (no JS JSON parsing). Window is CALENDAR-day aligned (last N
 * days incl. today) — a slightly different boundary than the live rolling
 * `now - N days`. `uniqueSessions` is summed across days (approximate: a session
 * spanning two days counts in each). Gated behind `analytics_rollup_read`.
 */
export async function getTrafficSummaryFromRollup(
  env: Env,
  siteId: string,
  windowDays = 30,
): Promise<TrafficSummary> {
  // Keep today's rollup row current — best-effort (a stale today degrades, never throws).
  try {
    const { rollupAnalyticsDaily } = await import('../../../src/services/analytics_rollup.js');
    await rollupAnalyticsDaily(env, new Date().toISOString().slice(0, 10));
  } catch {
    /* ignore — fall back to whatever the rollup already has */
  }

  const curStart = `-${windowDays - 1} days`; // inclusive of today → N calendar days
  const prevStart = `-${windowDays * 2 - 1} days`;
  const prevEnd = `-${windowDays} days`;

  const sumScalars = async (
    start: string,
    end: string | null,
  ): Promise<{ pageviews: number; uniqueSessions: number; conversions: number }> => {
    const where = end
      ? `site_id = ? AND day >= date('now', ?) AND day <= date('now', ?)`
      : `site_id = ? AND day >= date('now', ?)`;
    const params = end ? [siteId, start, end] : [siteId, start];
    const { data } = await dbQuery<{ pv: number; us: number; cv: number }>(
      env.DB,
      `SELECT COALESCE(SUM(pageviews),0) AS pv, COALESCE(SUM(unique_sessions),0) AS us,
              COALESCE(SUM(conversions),0) AS cv FROM analytics_daily WHERE ${where}`,
      params,
    );
    const r = data[0] ?? { pv: 0, us: 0, cv: 0 };
    return { pageviews: Number(r.pv), uniqueSessions: Number(r.us), conversions: Number(r.cv) };
  };

  /** Sum a JSON-array breakdown column across the window via json_each. */
  const merge = async (
    col: string,
    keyField: string,
  ): Promise<Array<{ k: string | null; c: number; u: number }>> => {
    const { data, error } = await dbQuery<{ k: string | null; c: number; u: number }>(
      env.DB,
      `SELECT json_extract(je.value, '$.${keyField}') AS k,
              SUM(CAST(json_extract(je.value, '$.count') AS INTEGER)) AS c,
              SUM(CAST(COALESCE(json_extract(je.value, '$.uniques'), 0) AS INTEGER)) AS u
       FROM analytics_daily ad, json_each(ad.${col}) je
       WHERE ad.site_id = ? AND ad.day >= date('now', ?) AND ad.${col} IS NOT NULL
       GROUP BY k ORDER BY c DESC`,
      [siteId, curStart],
    );
    return error ? [] : data;
  };

  const [
    cur,
    prev,
    pathRows,
    typeRows,
    channelRows,
    deviceRows,
    countryRows,
    webVitals,
    byConversionKind,
    prevByConversionKind,
    byBrowser,
    byOs,
    byUtmSource,
    byUtmMedium,
    byUtmCampaign,
    byHour,
    jsErrors,
    engagement,
    scrollDepth,
    networkQuality,
    navTiming,
    outboundClicks,
    formFunnel,
  ] = await Promise.all([
    sumScalars(curStart, null),
    sumScalars(prevStart, prevEnd),
    merge('top_paths_json', 'path'),
    merge('by_type_json', 'type'),
    merge('by_channel_json', 'label'),
    merge('by_device_json', 'label'),
    merge('by_country_json', 'label'),
    // CWV + conversions-by-kind + browser/OS + UTM aren't rolled into analytics_daily — read live.
    getWebVitalsSummary(env, siteId, windowDays),
    getConversionKinds(env, siteId, windowDays),
    getPreviousConversionKinds(env, siteId, windowDays),
    getDimensionBreakdown(env, siteId, 'browser', windowDays),
    getDimensionBreakdown(env, siteId, 'os', windowDays),
    getCampaignBreakdown(env, siteId, 'utmSource', windowDays),
    getCampaignBreakdown(env, siteId, 'utmMedium', windowDays),
    getCampaignBreakdown(env, siteId, 'utmCampaign', windowDays),
    // AN-HOUR — pageviews by hour-of-day (UTC; not in the rollup → read live).
    getHourlyBreakdown(env, siteId, windowDays),
    // AN-JSERR — first-party JS-error site-health (queried live; not in the rollup).
    getJsErrorSummary(env, siteId, windowDays),
    // AN-ENGAGE — first-party time-on-page median (queried live; not in the rollup).
    getEngagementSummary(env, siteId, windowDays),
    // AN-SCROLL — first-party scroll depth (queried live; not in the rollup).
    getScrollDepthSummary(env, siteId, windowDays),
    // AN-NET — first-party visitor connection quality (queried live; not in the rollup).
    getNetworkQualitySummary(env, siteId, windowDays),
    // AN-NAV — first-party page-load waterfall (queried live; not in the rollup).
    getNavTimingSummary(env, siteId, windowDays),
    // AN-OUTBOUND — top clicked outbound/contact links (queried live; not in the rollup).
    getOutboundClicksSummary(env, siteId, windowDays),
    // AN-FORM — contact-form lead funnel (queried live; the rollup has no funnel events).
    getFormFunnelSummary(env, siteId, windowDays),
  ]);

  return TrafficSummarySchema.parse({
    pageviews: cur.pageviews,
    uniqueSessions: cur.uniqueSessions,
    conversions: cur.conversions,
    // The analytics_daily rollup has no per-session depth, so true single-page-session
    // bounce can't be computed here — null is honest (never fabricate from day sums).
    bounceRatePercent: null,
    topPaths: pathRows.map((r) => ({
      path: String(r.k ?? '/'),
      count: Number(r.c),
      uniques: Number(r.u),
    })),
    byType: typeRows.map((r) => ({ type: String(r.k ?? 'unknown'), count: Number(r.c) })),
    byDevice: deviceRows.map((r) => ({ label: String(r.k ?? 'unknown'), count: Number(r.c) })),
    byBrowser,
    byOs,
    byUtmSource,
    byUtmMedium,
    byUtmCampaign,
    byHour,
    byChannel: channelRows.map((r) => ({ label: String(r.k ?? 'unknown'), count: Number(r.c) })),
    byCountry: countryRows.map((r) => ({ label: String(r.k ?? 'unknown'), count: Number(r.c) })),
    webVitals,
    jsErrors,
    engagement,
    scrollDepth,
    networkQuality,
    navTiming,
    outboundClicks,
    formFunnel,
    byConversionKind,
    previous: {
      pageviews: prev.pageviews,
      uniqueSessions: prev.uniqueSessions,
      conversions: prev.conversions,
      byConversionKind: prevByConversionKind,
    },
    windowDays,
  });
}
