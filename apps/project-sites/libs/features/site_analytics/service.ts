/**
 * @module libs/features/site_analytics/service
 * @description Aggregation logic for Site Analytics. Reads existing per-site
 * tables (`contacts`, `form_submissions`, `newsletter_subscribers`) and rolls
 * them into one owner summary. (The donations tile was dropped when the
 * child-site `donations_engine` feature was removed in 46184588 — the
 * `donations`/`donation_campaigns` tables have no live writer.)
 *
 * Every query is defensive: `dbQuery` swallows D1 errors into `{ error }`, so a
 * missing/renamed source table degrades that metric to 0 rather than throwing.
 * That keeps the dashboard resilient as sibling features ship or change.
 *
 * @packageDocumentation
 */

import type { Env } from '../../../src/types/env.js';
import { dbQuery } from '../../../src/services/db.js';
import {
  getCachedCloudflareRum,
  type CloudflareRumSummary,
} from '../../../src/services/cloudflare_rum.js';
import {
  getTrafficSummary,
  type AnalyticsWindow,
  type AnalyticsFilter,
} from '../visitor_events_core/service.js';
import {
  SiteAnalyticsSummarySchema,
  SectionConversionsSchema,
  FormAnalyticsSchema,
  VisitorFunnelSchema,
  type SiteAnalyticsSummary,
  type SectionConversions,
  type FormAnalytics,
  type VisitorFunnel,
  type SourceCount,
} from './schemas.js';

/** Flag key gating this feature. */
export const FLAG_KEY = 'site_analytics';

/** Run a COUNT/SUM scalar query, returning 0 on any error (missing table etc.). */
async function scalar(env: Env, sql: string, params: unknown[]): Promise<number> {
  const { data, error } = await dbQuery<{ n: number }>(env.DB, sql, params);
  if (error) return 0;
  return Number(data[0]?.n ?? 0);
}

/**
 * Resolve a site to its owning org, or null. Used by the handler to enforce
 * that the caller's org owns the site before returning analytics.
 */
export async function siteOrgId(env: Env, siteId: string): Promise<string | null> {
  const { data } = await dbQuery<{ org_id: string }>(
    env.DB,
    'SELECT org_id FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  return data[0]?.org_id ?? null;
}

/**
 * Cloudflare RUM (CF-measured CWV + Navigation Timing) for a site's OWNED host — for the public
 * share report + reusable elsewhere. The `siteId` is trusted (the caller has already authorized it,
 * e.g. via the verified HMAC share grant or an owner check); the host is resolved from the site's
 * OWN records (primary custom hostname → else `{slug}.projectsites.dev`), NEVER a client value.
 * Fail-soft: null on no-such-site / no host / CF error, so a share report never 500s or fakes a 0.
 *
 * @param env - Worker env (CF creds + DB)
 * @param siteId - the already-authorized site id
 * @param days - window length (clamped 1..30)
 * @returns the CF RUM summary, or null when unavailable
 */
export async function getCloudflareRumForSite(
  env: Env,
  siteId: string,
  days: number,
): Promise<CloudflareRumSummary | null> {
  const { data } = await dbQuery<{ slug: string; hostname: string | null }>(
    env.DB,
    `SELECT s.slug AS slug,
            (SELECT h.hostname FROM hostnames h
              WHERE h.site_id = s.id AND h.deleted_at IS NULL
              ORDER BY COALESCE(h.is_primary, 0) DESC, h.created_at ASC LIMIT 1) AS hostname
       FROM sites s WHERE s.id = ? AND s.deleted_at IS NULL LIMIT 1`,
    [siteId],
  );
  const row = data[0];
  if (!row?.slug) return null;

  const host = (row.hostname || `${row.slug}.projectsites.dev`).toLowerCase();
  // Cached per host per ~5-min window (one CF request per host, not per public-share view).
  return getCachedCloudflareRum(env, host, days);
}

/** One day of the analytics_daily rollup series. */
export interface DailyPoint {
  day: string;
  pageviews: number;
  uniqueSessions: number;
  conversions: number;
}

/**
 * Coerce a client-supplied UTC-offset (minutes, e.g. PST = -480) to a bounded
 * integer for day bucketing, or `null` (→ UTC, no shift). Rejects non-integers,
 * 0, and anything outside the real-world ±14h tz range — so an out-of-range or
 * junk value fails SAFE to UTC rather than producing a nonsense bucket.
 */
function normalizeTzOffset(v: number | undefined): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v === 0) return null;
  return v >= -840 && v <= 840 ? v : null;
}

/**
 * Per-day traffic series over a trailing window. Buckets by UTC calendar day by
 * default, or by the OWNER's local day when a `tzOffsetMinutes` is supplied.
 *
 * ⚠️ Reads LIVE `visitor_events` (GROUP BY `date(created_at)`), NOT the
 * `analytics_daily` rollup. The rollup cron only materializes YESTERDAY's row
 * (06:00 UTC), so a rollup read NEVER contains today (and lacks yesterday until
 * 06:00) — the chart silently dropped the most recent day(s) AND diverged from
 * the headline totals, which `getTrafficSummary` computes from LIVE
 * `visitor_events` (the `analytics_rollup_read` optimization is dark). Reading
 * the series live keeps the daily bars CURRENT and consistent with the headline
 * (same source + same metric definitions: pageview / DISTINCT session / conversion),
 * matching this module's sibling per-window queries (`getConversionsBySection`,
 * `getVisitorFunnel`, `getFormAnalytics` all scan `visitor_events`). When the
 * rollup-read flag is promoted, switch BOTH this and `getTrafficSummary` to the
 * rollup+today-refresh path together (see `getTrafficSummaryFromRollup`).
 *
 * Defensive: any D1 error (table missing on a fresh env) degrades to an empty
 * series rather than throwing.
 *
 * @param env    - Worker env (uses `env.DB`).
 * @param siteId - Site to read.
 * @param days   - Trailing window 1–365 (default 30).
 * @returns `{ days: DailyPoint[] }` ascending by calendar day, including today.
 *
 * @example
 * const { days } = await getDailySeries(env, 'site_123', 30);
 */
export async function getDailySeries(
  env: Env,
  siteId: string,
  days = 30,
  window?: AnalyticsWindow,
  tzOffsetMinutes?: number,
): Promise<{ days: DailyPoint[] }> {
  const n = Number.isInteger(days) && days > 0 && days <= 365 ? days : 30;
  // Absolute window → bound literals (created_at >= ? AND < ?); else trailing relative.
  const timeClause = window
    ? 'created_at >= ? AND created_at < ?'
    : "created_at >= datetime('now', ?)";
  const timeParams = window ? [window.since, window.until] : [`-${n} days`];
  // Timezone-aware day bucketing: SQLite can't do IANA zones, but a FIXED-offset
  // shift (`date(ts, '-480 minutes')`) buckets to the owner's local day instead of
  // UTC midnight. The modifier is a BOUND param (never concatenated). No/0/out-of-range
  // offset → plain `date(created_at)` (UTC, unchanged — backward-compat). DST-approximate
  // for a range crossing a DST change (the frontend labels the offset honestly).
  const tz = normalizeTzOffset(tzOffsetMinutes);
  const dayExpr = tz === null ? 'date(created_at)' : 'date(created_at, ?)';
  const dayParam = tz === null ? [] : [`${tz} minutes`];
  const { data, error } = await dbQuery<{
    day: string;
    pageviews: number;
    unique_sessions: number;
    conversions: number;
  }>(
    env.DB,
    // WHERE on the raw `created_at` (index-usable via idx_visitor_events_site_time);
    // GROUP BY the bucketed day (UTC, or the owner's local day when a tz offset is set).
    `SELECT ${dayExpr} AS day,
            SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            COUNT(DISTINCT session_id) AS unique_sessions,
            SUM(CASE WHEN event_type = 'conversion' THEN 1 ELSE 0 END) AS conversions
       FROM visitor_events
      WHERE site_id = ? AND ${timeClause}
      GROUP BY ${dayExpr} ORDER BY day ASC`,
    [...dayParam, siteId, ...timeParams, ...dayParam],
  );
  if (error) return { days: [] };
  return {
    days: data.map((r) => ({
      day: r.day,
      pageviews: Number(r.pageviews),
      uniqueSessions: Number(r.unique_sessions),
      conversions: Number(r.conversions),
    })),
  };
}

/**
 * AN27 — section-level conversion attribution. Aggregates the AN18 click-to-call/
 * directions/email `conversion` events (each tagged with the AN26
 * `data-ps-section`) from `visitor_events`, grouped by section + kind, ranked
 * by total desc with each section's share of all attributed conversions. Powers
 * the owner moat widget "Services drives 40% of calls".
 *
 * Defensive: any D1 error (table missing on a fresh env) degrades to an empty
 * breakdown rather than throwing. A null/absent section coalesces to
 * `(unattributed)` so conversions are never silently lost.
 *
 * @param env        - Worker env (uses `env.DB`).
 * @param siteId     - Site to attribute.
 * @param windowDays - Trailing window 1–365 (default 30).
 * @returns A validated {@link SectionConversions}, sections ranked by count desc.
 *
 * @example
 * const { sections } = await getConversionsBySection(env, 'site_123', 30);
 */
export async function getConversionsBySection(
  env: Env,
  siteId: string,
  windowDays = 30,
): Promise<SectionConversions> {
  const n = Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365 ? windowDays : 30;
  const { data, error } = await dbQuery<{ section: string | null; kind: string | null; n: number }>(
    env.DB,
    `SELECT COALESCE(json_extract(metadata, '$.section'), '(unattributed)') AS section,
            json_extract(metadata, '$.kind') AS kind,
            COUNT(*) AS n
       FROM visitor_events
      WHERE site_id = ? AND event_type = 'conversion'
        AND created_at >= datetime('now', ?)
      GROUP BY section, kind`,
    [siteId, `-${n} days`],
  );

  const bySection = new Map<
    string,
    { count: number; calls: number; directions: number; emails: number }
  >();
  let totalConversions = 0;
  if (!error) {
    for (const r of data) {
      const section = r.section ?? '(unattributed)';
      const c = Number(r.n) || 0;
      totalConversions += c;
      const agg = bySection.get(section) ?? { count: 0, calls: 0, directions: 0, emails: 0 };
      agg.count += c;
      if (r.kind === 'call') agg.calls += c;
      else if (r.kind === 'directions') agg.directions += c;
      else if (r.kind === 'email') agg.emails += c;
      bySection.set(section, agg);
    }
  }

  const sections = [...bySection.entries()]
    .map(([section, a]) => ({
      section,
      count: a.count,
      percent: totalConversions > 0 ? Math.round((a.count / totalConversions) * 1000) / 10 : 0,
      calls: a.calls,
      directions: a.directions,
      emails: a.emails,
    }))
    .sort((x, y) => y.count - x.count);

  return SectionConversionsSchema.parse({
    siteId,
    windowDays: n,
    totalConversions,
    sections,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * AN19 — per-site visitor funnel by distinct session: landing (≥1 pageview) →
 * engaged (≥2 pageviews) → converted (≥1 conversion event). Reads
 * `visitor_events` (session_id set server-side per pageview + on mirrored beacon
 * conversions), one GROUP BY pass per session. Each stage carries its share of the
 * landing (top) sessions, so the
 * owner sees the drop-off. Defensive → all-zero on D1 error.
 *
 * @param env        - Worker env (uses `env.DB`).
 * @param siteId     - Site to analyze.
 * @param windowDays - Trailing window 1–365 (default 30).
 * @returns A validated {@link VisitorFunnel}.
 *
 * @example
 * const { stages } = await getVisitorFunnel(env, 'site_1', 30);
 */
export async function getVisitorFunnel(
  env: Env,
  siteId: string,
  windowDays = 30,
): Promise<VisitorFunnel> {
  const n = Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365 ? windowDays : 30;
  const { data, error } = await dbQuery<{ pv: number; conv: number; max_scroll: number; has_scroll: number }>(
    env.DB,
    `SELECT SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) AS pv,
            MAX(CASE WHEN event_type = 'conversion' THEN 1 ELSE 0 END) AS conv,
            MAX(CASE WHEN event_type = 'scroll_depth'
                     THEN CAST(json_extract(metadata, '$.percent') AS INTEGER) ELSE 0 END) AS max_scroll,
            MAX(CASE WHEN event_type = 'scroll_depth' THEN 1 ELSE 0 END) AS has_scroll
       FROM visitor_events
      WHERE site_id = ? AND session_id IS NOT NULL
        AND created_at >= datetime('now', ?)
      GROUP BY session_id`,
    [siteId, `-${n} days`],
  );

  let landing = 0;
  let engaged = 0;
  let deeplyEngaged = 0;
  let converted = 0;
  let scrollMeasuredSessions = 0; // sessions that emitted ≥1 scroll_depth sample
  if (!error) {
    for (const r of data) {
      const pv = Number(r.pv) || 0;
      if (pv >= 1) landing += 1;
      if (pv >= 2) engaged += 1;
      // Deeply engaged = an ENGAGED session (2+ pages) that ALSO scrolled ≥50% on its deepest
      // page — a guaranteed SUBSET of engaged, so the funnel stays monotonic (no negative drop).
      if (pv >= 2 && (Number(r.max_scroll) || 0) >= 50) deeplyEngaged += 1;
      if (Number(r.has_scroll) > 0) scrollMeasuredSessions += 1;
      if (Number(r.conv) > 0) converted += 1;
    }
  }
  const pct = (v: number) => (landing > 0 ? Math.round((v / landing) * 1000) / 10 : 0);

  const stages: Array<{
    key: 'landing' | 'engaged' | 'deeply_engaged' | 'converted';
    label: string;
    sessions: number;
    percentOfLanding: number;
  }> = [
    {
      key: 'landing',
      label: 'Landed',
      sessions: landing,
      percentOfLanding: landing > 0 ? 100 : 0,
    },
    {
      key: 'engaged',
      label: 'Engaged (2+ pages)',
      sessions: engaged,
      percentOfLanding: pct(engaged),
    },
  ];
  // Only surface the deep-engagement stage when scroll depth is ACTUALLY being measured for
  // this site (≥1 scroll_depth sample). With zero samples a "0 deeply engaged" would read as
  // "nobody read deeply" when the truth is "not measured yet" — a lying-empty. Omit instead.
  if (scrollMeasuredSessions > 0) {
    stages.push({
      key: 'deeply_engaged',
      label: 'Deeply engaged (read 50%+)',
      sessions: deeplyEngaged,
      percentOfLanding: pct(deeplyEngaged),
    });
  }
  stages.push({
    key: 'converted',
    label: 'Converted',
    sessions: converted,
    percentOfLanding: pct(converted),
  });

  return VisitorFunnelSchema.parse({
    siteId,
    windowDays: n,
    stages,
    generatedAt: new Date().toISOString(),
  });
}

/** RFC-4180 escape: quote a field when it contains a comma, quote, or newline. */
function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * AN42 — flatten an owner analytics summary to a portable two-column
 * (`metric,value`) CSV for one-click export/download. Pure + deterministic;
 * non-PII (counts only). The contact-source breakdown is emitted as
 * `contacts.bySource.<source>` rows so nothing is lost.
 *
 * @param summary - A {@link SiteAnalyticsSummary}.
 * @returns A CSV string with a header row + one row per metric.
 *
 * @example
 * const csv = summaryToCsv(await getSiteAnalyticsSummary(env, org, site));
 */
export function summaryToCsv(summary: SiteAnalyticsSummary): string {
  const rows: Array<[string, string | number]> = [
    ['site_id', summary.siteId],
    ['window_days', summary.windowDays],
    ['generated_at', summary.generatedAt],
    ['contacts.total', summary.contacts.total],
    ['contacts.new_in_window', summary.contacts.newInWindow],
    ['form_submissions.total', summary.formSubmissions.total],
    ['form_submissions.new_in_window', summary.formSubmissions.newInWindow],
    ['newsletter.confirmed', summary.newsletter.confirmed],
    ['newsletter.total', summary.newsletter.total],
    ['traffic.pageviews', summary.traffic.pageviews],
    ['traffic.unique_sessions', summary.traffic.uniqueSessions],
    ['traffic.conversions', summary.traffic.conversions],
  ];
  for (const s of summary.contacts.bySource) {
    rows.push([`contacts.bySource.${s.source}`, s.count]);
  }
  const lines = ['metric,value', ...rows.map(([k, v]) => `${csvField(k)},${csvField(v)}`)];
  return lines.join('\r\n');
}

/**
 * AN17 — per-form completion rate + abandonment. Counts the tracker's
 * `form_start` (first focus) vs `form_submit` events from `visitor_events`
 * (mirrored from the client beacon via `/api/events`), grouped by the form key
 * (`metadata.form`), and derives completion rate +
 * abandonment per form. Bridges the pageview→lead gap: shows which forms get
 * started but not finished. Ranked by starts desc.
 *
 * Defensive: any D1 error degrades to an empty list. completionRate is capped at
 * 100 (a form can record more submits than starts if a visitor submits without
 * the focus firing — e.g. autofill); abandoned floors at 0 for the same reason.
 *
 * @param env        - Worker env (uses `env.DB`).
 * @param siteId     - Site to analyze.
 * @param windowDays - Trailing window 1–365 (default 30).
 * @returns A validated {@link FormAnalytics}.
 *
 * @example
 * const { forms } = await getFormAnalytics(env, 'site_123', 30);
 */
export async function getFormAnalytics(
  env: Env,
  siteId: string,
  windowDays = 30,
): Promise<FormAnalytics> {
  const n = Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365 ? windowDays : 30;
  const { data, error } = await dbQuery<{ form: string | null; eventType: string; n: number }>(
    env.DB,
    `SELECT COALESCE(json_extract(metadata, '$.form'), '(unnamed)') AS form,
            event_type AS eventType,
            COUNT(*) AS n
       FROM visitor_events
      WHERE site_id = ? AND event_type IN ('form_start', 'form_submit')
        AND created_at >= datetime('now', ?)
      GROUP BY form, eventType`,
    [siteId, `-${n} days`],
  );

  const byForm = new Map<string, { starts: number; submits: number }>();
  if (!error) {
    for (const r of data) {
      const form = r.form ?? '(unnamed)';
      const agg = byForm.get(form) ?? { starts: 0, submits: 0 };
      if (r.eventType === 'form_start') agg.starts += Number(r.n) || 0;
      else if (r.eventType === 'form_submit') agg.submits += Number(r.n) || 0;
      byForm.set(form, agg);
    }
  }

  const forms = [...byForm.entries()]
    .map(([form, a]) => ({
      form,
      starts: a.starts,
      submits: a.submits,
      completionRate:
        a.starts > 0 ? Math.min(100, Math.round((a.submits / a.starts) * 1000) / 10) : 0,
      abandoned: Math.max(0, a.starts - a.submits),
    }))
    .sort((x, y) => y.starts - x.starts);

  return FormAnalyticsSchema.parse({
    siteId,
    windowDays: n,
    forms,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Build the owner analytics summary for a site over a trailing window.
 *
 * @param env         - Worker env (uses `env.DB`).
 * @param orgId       - Caller's org (analytics are org-scoped).
 * @param siteId      - Site to summarize.
 * @param windowDays  - Trailing window for "new" metrics (default 30).
 * @returns A validated {@link SiteAnalyticsSummary}.
 * @example
 * ```ts
 * const summary = await getSiteAnalyticsSummary(env, orgId, siteId);
 * ```
 */
export async function getSiteAnalyticsSummary(
  env: Env,
  orgId: string,
  siteId: string,
  windowDays = 30,
  window?: AnalyticsWindow,
  filter?: AnalyticsFilter,
): Promise<SiteAnalyticsSummary> {
  // "New in window" counts use bound literals for an absolute window, else the
  // trailing relative window. TOTALS below are window-independent and unchanged.
  const newClause = window
    ? 'created_at >= ? AND created_at < ?'
    : "created_at >= datetime('now', ?)";
  const newParams = window ? [window.since, window.until] : [`-${windowDays} days`];

  const [
    contactsTotal,
    contactsNew,
    formTotal,
    formNew,
    newsConfirmed,
    newsTotal,
    bySourceRows,
    traffic,
  ] = await Promise.all([
    scalar(
      env,
      'SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND site_id = ? AND deleted_at IS NULL',
      [orgId, siteId],
    ),
    scalar(
      env,
      `SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND site_id = ? AND deleted_at IS NULL AND ${newClause}`,
      [orgId, siteId, ...newParams],
    ),
    scalar(env, 'SELECT COUNT(*) AS n FROM form_submissions WHERE org_id = ? AND site_id = ?', [
      orgId,
      siteId,
    ]),
    scalar(
      env,
      `SELECT COUNT(*) AS n FROM form_submissions WHERE org_id = ? AND site_id = ? AND ${newClause}`,
      [orgId, siteId, ...newParams],
    ),
    scalar(
      env,
      'SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE site_id = ? AND confirmed = 1 AND unsubscribed = 0',
      [siteId],
    ),
    scalar(env, 'SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE site_id = ?', [siteId]),
    dbQuery<{ source: string; n: number }>(
      env.DB,
      'SELECT source, COUNT(*) AS n FROM contacts WHERE org_id = ? AND site_id = ? AND deleted_at IS NULL GROUP BY source ORDER BY n DESC',
      [orgId, siteId],
    ).then((r) => (r.error ? [] : r.data)),
    // Traffic from visitor_events_core — defensive (no table/no events → all zeros).
    // The drilldown filter (if any) restricts the ENTIRE traffic block coherently.
    getTrafficSummary(env, siteId, windowDays, window, filter),
  ]);

  const bySource: SourceCount[] = bySourceRows.map((r) => ({
    source: r.source,
    count: Number(r.n),
  }));

  return SiteAnalyticsSummarySchema.parse({
    siteId,
    // Echo the ACTUAL span served: an absolute window reports its day-span (from the
    // traffic summary), a relative request reports the requested windowDays.
    windowDays: window ? traffic.windowDays : windowDays,
    contacts: { total: contactsTotal, newInWindow: contactsNew, bySource },
    formSubmissions: { total: formTotal, newInWindow: formNew },
    newsletter: { confirmed: newsConfirmed, total: newsTotal },
    traffic,
    generatedAt: new Date().toISOString(),
  });
}
