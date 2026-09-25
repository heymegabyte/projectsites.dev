/**
 * @module libs/features/site_analytics/handlers
 * @description Hono route for Site Analytics.
 *
 * | Method | Path                          | Purpose                          |
 * | ------ | ----------------------------- | -------------------------------- |
 * | GET    | /api/sites/:siteId/analytics  | Owner analytics summary for site |
 *
 * 404 when the `site_analytics` flag is off (never 403). Org-ownership is
 * enforced: a caller can only read analytics for a site their org owns —
 * a mismatch returns 404 (never leak another org's site existence).
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { DOMAINS } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgFlag, notFound } from '../../../src/lib/feature_guard.js';
import { manifestSecret } from '../../../src/services/site_capability_manifest.js';
import {
  FLAG_KEY,
  getSiteAnalyticsSummary,
  getDailySeries,
  getConversionsBySection,
  getFormAnalytics,
  getVisitorFunnel,
  summaryToCsv,
  siteOrgId,
  getCloudflareRumForSite,
} from './service.js';
import { mintShareToken, verifyShareToken } from './share.js';
// Reusable server-side validator for an arbitrary ?start&end window (shared with
// the /api/analytics/:siteId route). Bounds/validates the range; authz is separate.
import { parseCustomWindow } from '../analytics/handlers.js';
// Shifts an absolute window's date bounds into the owner's timezone (UTC-equiv),
// so the ?start&end filter matches the tz-aware daily buckets.
import {
  getEntryPagesSummary,
  getConciergeEngagementSummary,
  getExitPagesSummary,
  getNewVsReturningSummary,
  getSessionDurationSummary,
  shiftWindowToTz,
} from '../visitor_events_core/service.js';
// Drilldown-filter allowlist schema — validates ?filterDim against the trusted
// dimension enum so an unknown/injected dimension is rejected here, never in SQL.
import { AnalyticsFilterSchema, type AnalyticsFilter } from '../visitor_events_core/schemas.js';

/** Share-link default lifetime: 30 days. */
const SHARE_TTL_MS = 30 * 86_400_000;

type AppContext = { Bindings: Env; Variables: Variables };

/**
 * Owner-gate: enforce the `site_analytics` flag, resolve `:siteId`, and verify
 * the caller's org owns it. Returns a 404 `Response` when the flag is off, the
 * site is missing, or another org owns it (never leaks existence); otherwise
 * returns the authorized `{ orgId, siteId }` context.
 */
async function requireOwnedSite(
  c: Context<AppContext>,
): Promise<Response | { orgId: string; siteId: string }> {
  const g = await requireOrgFlag(c, FLAG_KEY);
  if (g instanceof Response) return g;
  const siteId = c.req.param('siteId');
  const owner = await siteOrgId(c.env, siteId);
  if (!owner || owner !== g.orgId) return notFound(c); // not found OR not yours → 404
  return { orgId: g.orgId, siteId };
}

/**
 * Parse a bounded day-window query param (integer 1–365, default 30). Checks the named `param`
 * first, then falls back to `days` — the self-fetching cards (entry/exit/session-duration) send
 * `?days=N`, so a route declared with `'windowDays'` still honors their selected window instead of
 * silently defaulting to 30. Backward-compatible: a valid named param always wins.
 */
export function parseWindowDays(c: Context<AppContext>, param: string): number {
  const pick = (v: string | undefined): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= 365 ? n : null;
  };
  return pick(c.req.query(param)) ?? pick(c.req.query('days')) ?? 30;
}

/** 400 for a malformed/reversed ?start&end window (a client error, distinct from authz). */
function badWindow(c: Context<AppContext>, message: string): Response {
  return c.json(
    {
      error: {
        code: 'BAD_REQUEST',
        message,
        request_id: c.get('requestId') ?? crypto.randomUUID(),
      },
    },
    400,
  );
}

/**
 * Parse the optional drilldown filter (`?filterDim=&filterValue=`). The dimension is
 * validated against the {@link AnalyticsFilterSchema} allowlist and the value is bounded,
 * so an unknown/injected `filterDim` (or an over-long value) is rejected HERE (400) and
 * never reaches SQL. Returns `undefined` when no filter is requested, the validated filter,
 * or a 400 `Response`. Authz is UNAFFECTED — the filter only NARROWS within the already
 * owner-scoped `site_id` (it carries no hostname / zone / account).
 */
function parseFilter(c: Context<AppContext>): AnalyticsFilter | undefined | Response {
  const dim = c.req.query('filterDim');
  const value = c.req.query('filterValue');
  if (dim === undefined && value === undefined) return undefined; // no filter requested
  const parsed = AnalyticsFilterSchema.safeParse({ dim, value });
  if (!parsed.success)
    return badWindow(c, 'Invalid analytics filter (unknown dimension or bad value)');
  return parsed.data;
}

export const siteAnalytics = new Hono<AppContext>();

siteAnalytics.get('/api/sites/:siteId/analytics', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const cw = parseCustomWindow(c.req.query('start'), c.req.query('end'));
  if (cw.error) return badWindow(c, cw.error);
  const windowDays = parseWindowDays(c, 'windowDays');
  // Interpret the ?start&end bounds in the owner's tz (no-op for UTC/absent tz), so
  // the summary counts the owner's local days — consistent with the daily buckets.
  const tzRaw = Number.parseInt(c.req.query('tz') ?? '', 10);
  const win = cw.window
    ? shiftWindowToTz(cw.window, Number.isInteger(tzRaw) ? tzRaw : undefined)
    : undefined;
  // AN-FILTER — optional drilldown restriction. Validated against the allowlist (bad
  // dim → 400, never reaches SQL); only NARROWS within the already owner-scoped site.
  const filter = parseFilter(c);
  if (filter instanceof Response) return filter;
  const summary = await getSiteAnalyticsSummary(
    c.env,
    gate.orgId,
    gate.siteId,
    windowDays,
    win,
    filter,
  );
  // Echo the ORIGINAL local dates the owner picked (the shifted UTC bounds are an
  // internal query detail) so the UI labels the real range, never wider than queried.
  // Echo the applied filter too so the UI can render a chip AND confirm the server honored it.
  const body = cw.window
    ? { ...summary, windowStart: cw.startDisplay, windowEnd: cw.endDisplay }
    : summary;
  return c.json(filter ? { ...body, appliedFilter: filter } : body);
});

// AN5 follow-on — per-day traffic series from the analytics_daily rollup.
siteAnalytics.get('/api/sites/:siteId/analytics/daily', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const cw = parseCustomWindow(c.req.query('start'), c.req.query('end'));
  if (cw.error) return badWindow(c, cw.error);
  const days = parseWindowDays(c, 'days');
  // Optional UTC-offset (minutes): shifts the ?start&end FILTER bounds into the
  // owner's tz (shiftWindowToTz) AND buckets each day in the owner's tz (the raw
  // offset passed to getDailySeries); both no-op for UTC/absent. Service re-validates.
  const tzRaw = Number.parseInt(c.req.query('tz') ?? '', 10);
  const tz = Number.isInteger(tzRaw) ? tzRaw : undefined;
  const win = cw.window ? shiftWindowToTz(cw.window, tz) : undefined;
  const series = await getDailySeries(c.env, gate.siteId, days, win, tz);
  return c.json(
    cw.window ? { ...series, windowStart: cw.startDisplay, windowEnd: cw.endDisplay } : series,
  );
});

// AN27 — section-level conversion attribution ("Services drives 40% of calls").
siteAnalytics.get('/api/sites/:siteId/analytics/sections', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const breakdown = await getConversionsBySection(c.env, gate.siteId, windowDays);
  return c.json(breakdown);
});

// AN17 — per-form completion rate + abandonment.
siteAnalytics.get('/api/sites/:siteId/analytics/forms', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const forms = await getFormAnalytics(c.env, gate.siteId, windowDays);
  return c.json(forms);
});

// AN — new-vs-returning visitor split (first-party page_engagement `nv` flag, browser-scoped), owner-scoped.
siteAnalytics.get('/api/sites/:siteId/analytics/visitors', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const summary = await getNewVsReturningSummary(c.env, gate.siteId, windowDays);
  return c.json(summary);
});

// AN — top entry (landing) pages (first-party page_engagement `ep` session-start flag), owner-scoped.
siteAnalytics.get('/api/sites/:siteId/analytics/entry-pages', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const summary = await getEntryPagesSummary(c.env, gate.siteId, windowDays);
  return c.json(summary);
});

// AN — top exit (last) pages (first-party page_engagement, last per session `sid`), owner-scoped.
siteAnalytics.get('/api/sites/:siteId/analytics/exit-pages', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const summary = await getExitPagesSummary(c.env, gate.siteId, windowDays);
  return c.json(summary);
});

// AN — session duration (median/avg/longest session LENGTH + distribution), first-party
// SUM(duration_ms) per session `sid`; distinct from per-page dwell. Owner-scoped.
siteAnalytics.get('/api/sites/:siteId/analytics/session-duration', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const summary = await getSessionDurationSummary(c.env, gate.siteId, windowDays);
  return c.json(summary);
});

// AN — AI concierge engagement (opens · messages · unique visitors · messages/open), first-party
// concierge_open/concierge_message beacon events. Owner-scoped. The card self-hides when opens = 0.
siteAnalytics.get('/api/sites/:siteId/analytics/concierge', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const summary = await getConciergeEngagementSummary(c.env, gate.siteId, windowDays);
  return c.json(summary);
});

// AN19 — per-site visitor funnel (landing → engaged → converted), owner-scoped.
siteAnalytics.get('/api/sites/:siteId/analytics/funnel', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const windowDays = parseWindowDays(c, 'windowDays');
  const funnel = await getVisitorFunnel(c.env, gate.siteId, windowDays);
  return c.json(funnel);
});

// AN42 — one-click owner data export. Returns the analytics summary as a
// portable CSV (non-PII counts) for download. Owner+flag gated. The delete half
// of GDPR portability is the existing owner site-delete + per-visitor dsar.
siteAnalytics.get('/api/sites/:siteId/analytics/export', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const summary = await getSiteAnalyticsSummary(c.env, gate.orgId, gate.siteId, 30);
  const csv = summaryToCsv(summary);
  return c.json({ filename: `analytics-${gate.siteId}.csv`, csv });
});

// AN48 — mint a public, read-only, time-boxed share link for this site's
// analytics (owner-gated). The token is the capability; see the public route.
siteAnalytics.post('/api/sites/:siteId/analytics/share', async (c) => {
  const gate = await requireOwnedSite(c);
  if (gate instanceof Response) return gate;

  const secret = manifestSecret(c.env);
  if (!secret) {
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Sharing is not configured.' } },
      500,
    );
  }
  const expiresAt = Date.now() + SHARE_TTL_MS;
  const token = await mintShareToken(secret, gate.siteId, expiresAt);
  const url = `https://${DOMAINS.SITES_BASE}/shared/analytics/${token}`;
  return c.json({ token, url, expiresAt });
});

// AN48 — PUBLIC read-only analytics by share token. No session: the HMAC-signed,
// expiring token IS the capability. Gated on the same flag as the owner surface.
siteAnalytics.get('/api/public/analytics/:token', async (c) => {
  const secret = manifestSecret(c.env);
  if (!secret) return notFound(c);
  const grant = await verifyShareToken(secret, c.req.param('token'), Date.now());
  if (!grant) return notFound(c); // bad/expired/tampered token → 404 (never leak)

  // The site must still exist + own an org (deleted site → 404).
  const owner = await siteOrgId(c.env, grant.siteId);
  if (!owner) return notFound(c);

  const summary = await getSiteAnalyticsSummary(c.env, owner, grant.siteId, 30);
  // Cloudflare RUM (CF-measured CWV + TTFB) for the site's owned host — an INDEPENDENT second source
  // to the first-party beacon. Site is trusted from the verified share grant; the host is resolved
  // server-side. Fail-soft: null when no data / CF error (the report simply omits the CF tiles).
  const cloudflareRum = await getCloudflareRumForSite(c.env, grant.siteId, 30);
  return c.json({ summary, cloudflareRum, expiresAt: grant.expEpochMs });
});
