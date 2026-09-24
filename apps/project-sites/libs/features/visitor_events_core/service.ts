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
        AND json_extract(metadata, '$.metric') IN ('LCP', 'INP', 'CLS')
      ORDER BY created_at DESC
      LIMIT 50000`,
    win.params,
  );
  const empty: WebVitals = { lcp: null, inp: null, cls: null, slowestPages: [] };
  if (error) return empty;

  const buckets: Record<(typeof CWV_METRICS)[number], number[]> = { LCP: [], INP: [], CLS: [] };
  const lcpByPath = new Map<string, number[]>();
  const inpByPath = new Map<string, number[]>();
  const clsByPath = new Map<string, number[]>();
  const pushByPath = (map: Map<string, number[]>, path: string, v: number): void => {
    const arr = map.get(path);
    if (arr) arr.push(v);
    else map.set(path, [v]);
  };
  for (const row of data) {
    const m = row.metric as (typeof CWV_METRICS)[number] | null;
    const v = Number(row.value);
    if (!(m && m in buckets && Number.isFinite(v) && v >= 0)) continue;
    buckets[m].push(v);
    // Bucket EACH metric per page so the "slowest pages" drilldown shows the full
    // per-page CWV picture (LCP · INP · CLS), not LCP alone.
    if (typeof row.path === 'string' && row.path) {
      if (m === 'LCP') pushByPath(lcpByPath, row.path, v);
      else if (m === 'INP') pushByPath(inpByPath, row.path, v);
      else if (m === 'CLS') pushByPath(clsByPath, row.path, v);
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
      samples: vals.length,
    }))
    .sort((a, b) => b.lcpP75 - a.lcpP75)
    .slice(0, 5);
  return { lcp: stat('LCP'), inp: stat('INP'), cls: stat('CLS'), slowestPages };
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
    byUtmCampaign,
    byHour,
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
    // AN-UTM — campaign attribution (source + campaign; tagged visits only, untagged excluded).
    getCampaignBreakdown(env, siteId, 'utmSource', windowDays, window, filter),
    getCampaignBreakdown(env, siteId, 'utmCampaign', windowDays, window, filter),
    // AN-HOUR — pageviews by hour-of-day (UTC; frontend rotates to local).
    getHourlyBreakdown(env, siteId, windowDays, window, filter),
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
    byUtmCampaign,
    byHour,
    byChannel,
    byCountry,
    webVitals,
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
    byUtmCampaign,
    byHour,
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
    getCampaignBreakdown(env, siteId, 'utmCampaign', windowDays),
    // AN-HOUR — pageviews by hour-of-day (UTC; not in the rollup → read live).
    getHourlyBreakdown(env, siteId, windowDays),
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
    byUtmCampaign,
    byHour,
    byChannel: channelRows.map((r) => ({ label: String(r.k ?? 'unknown'), count: Number(r.c) })),
    byCountry: countryRows.map((r) => ({ label: String(r.k ?? 'unknown'), count: Number(r.c) })),
    webVitals,
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
