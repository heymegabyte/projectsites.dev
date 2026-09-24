/**
 * @module libs/features/analytics/handlers
 *
 * @description
 * Hono routes for the analytics surface — the admin SPA's per-route visit
 * beacon + rolling overview tiles (Cloudflare Analytics Engine + D1 funnel
 * events) plus the per-site dashboard feed (GA4 Data API → Cloudflare zone
 * analytics → first-party edge pageviews fallback chain). The `track` beacon
 * is intentionally public (fires on every admin route change, degrades to an
 * `anonymous` org tag when unauthenticated); the `overview` + per-site feed
 * are org/membership scoped.
 *
 * | Method | Path                    | Auth   | Purpose                                            |
 * | ------ | ----------------------- | ------ | -------------------------------------------------- |
 * | POST   | /api/analytics/track    | public | Record one admin-visit Analytics Engine data point |
 * | GET    | /api/analytics/overview | orgId  | Rolling 1/7/30/90-day analytics summary            |
 * | GET    | /api/analytics/:siteId  | member | Per-site dashboard feed (GA4 → CF zone → edge)     |
 *
 * Extracted VERBATIM from `ai_admin.ts` (`POST /api/analytics/track` +
 * `GET /api/analytics/overview`) and `api.ts` (`GET /api/analytics/:siteId`
 * + its private `queryGa4DataApi` helper) — route-decomposition installment 14.
 * Only the route-registration receiver changed (`aiAdmin.`/`api.` → `analytics.`);
 * the handler bodies are byte-for-byte unchanged. The two ai_admin routes keep
 * ai_admin's local scaffolding (`HTTPError` / `need(c)` / this module's `onError`)
 * so `overview`'s 401 `{ error: { message: 'Authentication required' } }` gate
 * stays byte-identical to the ai_admin surface; the `:siteId` route uses its own
 * inline `{ error: { code, message, request_id } }` envelopes (no throw). The
 * private `queryGa4DataApi` moved alongside the `:siteId` route (its only caller).
 * This module MUST mount BEFORE both `api` and `aiAdmin` so its `/api/analytics/*`
 * routes win over the originals until the source handlers are removed.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { dbQuery, dbQueryOne } from '../../../src/services/db.js';
import { recordEvent, loadOverview } from '../../../src/services/cf_analytics.js';
import {
  isCloudflareAnalyticsConfigured,
  loadSiteTraffic,
} from '../../../src/services/cloudflare_analytics.js';
import { getTrafficSummary, type AnalyticsWindow } from '../visitor_events_core/service.js';

type AppContext = { Bindings: Env; Variables: Variables };

/**
 * True when a CF-zone-analytics failure is EXPECTED + PERMANENT (the API token lacks
 * `zone.analytics.read`, or the host is a `*.projectsites.dev` subdomain with no CF-zone
 * dataset). Such failures are the DESIGNED GA4→CF-zone→D1 fallback path — logged at `info`,
 * not `warn`, so the per-load fallback doesn't drown real warnings (AL-170).
 */
export const isExpectedZoneAnalyticsFallback = (errorMessage: string): boolean =>
  /permission|authenticat|unauthor|forbidden|\b403\b|zone\.analytics/i.test(errorMessage);

export const analytics = new Hono<AppContext>();

/* ────────────────────────── ai_admin local scaffolding (verbatim) ────────────────────────── */
// The track/overview handlers below were moved BYTE-VERBATIM from
// `routes/ai_admin.ts`. They keep ai_admin's local auth + error scaffolding
// (`HTTPError` / `need` / this module's `onError`) so `overview`'s 401
// `{ error: { message: 'Authentication required' } }` gate + generic-500 behavior
// are identical to the ai_admin surface. The `:siteId` route (from api.ts) uses
// its OWN inline `{ error: { code, message, request_id } }` envelopes and never
// touches this scaffolding.

type Ctx = Context<AppContext>;

class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

analytics.onError((err, c) => {
  // Only the folded-in `overview` route throws HTTPError (via `need`) — render its
  // intentional envelope here (byte-identical to ai_admin's onError). Anything else
  // propagates UNCHANGED to the app-level errorHandler, so re-throw it (the `track`
  // + `:siteId` routes never throw — they catch internally — so this path is only a
  // safety net that preserves the app's shared error rendering).
  if (err instanceof HTTPError) {
    return c.json({ error: { message: err.message } }, err.status as 400);
  }
  throw err;
});

function need(c: Ctx): { orgId: string; userId: string } {
  const orgId = c.get('orgId') as string | undefined;
  const userId = c.get('userId') as string | undefined;
  if (!orgId || !userId) throw new HTTPError(401, 'Authentication required');
  return { orgId, userId };
}

/* ────────────────────────── Cloudflare Analytics (folded from ai_admin.ts) ────────────────────────── */

// Public, unauthenticated — the admin SPA fires this on every route change.
// Records one Analytics Engine data point. Seeds a sentinel visit on first
// hit so the Analytics page always shows ≥ 1 visit out of the box.
/**
 * `POST /api/analytics/track` — Record a tenant-scoped analytics event
 * (CF Analytics + PostHog server-side).
 *
 * @remarks
 * Body: `{ event, properties? }`. Tagged with `org_id` + `user_id` for
 * cross-tenant isolation. Fire-and-forget; failures never block the
 * response.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
analytics.post('/api/analytics/track', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { route?: string; site_id?: string };
  const orgId = (c.get('orgId') as string | undefined) ?? 'anonymous';
  recordEvent(c.env, {
    event: 'admin_visit',
    routePath: body.route ?? '/admin',
    siteId: body.site_id ?? null,
    orgId,
    userAgent: c.req.header('user-agent'),
    referrer: c.req.header('referer'),
    country: c.req.header('cf-ipcountry'),
  });
  return c.json({ data: { tracked: true } });
});

/**
 * `GET /api/analytics/overview` — Rolling analytics summary (last 7 + 30
 * days) for the caller's org.
 *
 * @remarks
 * Pulls counts from CF Analytics + funnel events from D1 via
 * {@link loadOverview}. Used by the admin dashboard tiles.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
analytics.get('/api/analytics/overview', async (c) => {
  const { orgId } = need(c);
  // Seed at least one visit so the page never reads empty on first load.
  recordEvent(c.env, {
    event: 'admin_visit',
    routePath: '/admin/analytics',
    orgId,
    userAgent: c.req.header('user-agent'),
    country: c.req.header('cf-ipcountry'),
  });
  const rangeRaw = c.req.query('range') ?? '30d';
  const days = rangeRaw === '1d' ? 1 : rangeRaw === '7d' ? 7 : rangeRaw === '90d' ? 90 : 30;
  try {
    const data = await loadOverview(c.env, orgId, days);
    return c.json({ data, range: rangeRaw, days });
  } catch (err) {
    return c.json(
      {
        error: { message: err instanceof Error ? err.message : 'analytics unavailable' },
        data: null,
      },
      200,
    );
  }
});

/* ────────────────────────── Per-site analytics feed (folded from api.ts) ────────────────────────── */

/**
 * GET /api/analytics/:siteId — Per-site analytics dashboard data.
 *
 * Returns analytics data for a site from the GA4 Data API filtered by the
 * `site_slug` dimension. Falls back to D1-derived basic stats (page-view
 * estimates from audit log counts) when GA4 service-account credentials
 * aren't configured.
 *
 * @route GET /api/analytics/:siteId
 * @auth Required — Bearer session token. 401 returned directly when
 *   unauthenticated. 403 returned when user lacks membership in the site's org.
 * @param {string} siteId - Site UUID. Soft-deleted sites return 404.
 * @queryParam {string} [period="7"] - Look-back window in days. Coerced via
 *   `parseInt` — non-numeric values fall back to 7. No upper bound enforced
 *   (GA4 Data API itself caps at the property retention window, typically
 *   14 months).
 *
 * @returns {Object} 200 — Either the raw GA4 Data API report (when GA4 is
 *   configured AND the call succeeds) or a fallback envelope:
 *   `{ data: { period, slug, ga4_connected, ga4_measurement_id,
 *   gtm_container_id, stats:{pageViews,uniqueVisitors,avgSessionDuration,
 *   bounceRate}, chartData:[{date,views}], trafficSources:[], topPages:[] } }`.
 *   The fallback's `chartData` is computed from `audit_logs` where
 *   `action LIKE 'site.%'`, NOT real page views — it's a "is the site
 *   alive?" proxy until GA4 is wired up.
 *
 * @throws 401 — UNAUTHORIZED envelope when unauthenticated.
 * @throws 403 — FORBIDDEN envelope when user has no membership row in
 *   the site's org.
 * @throws 404 — NOT_FOUND envelope when site doesn't exist or is
 *   soft-deleted.
 *
 * @remarks
 * Cross-org guard: `dbQueryOne` against `memberships` enforces org access
 * AFTER the site lookup, NOT before — a 404 from a soft-deleted site
 * surfaces before the 403 even when the user has no membership. Acceptable
 * since soft-deleted sites should be invisible to all users anyway.
 *
 * GA4 path: requires both `GA4_PROPERTY_ID` AND base64-encoded
 * `GA4_SERVICE_ACCOUNT_JSON` env vars. Calls `queryGa4DataApi()` which
 * builds an RS256-signed JWT, exchanges for an access token via the
 * Google OAuth2 endpoint, and POSTs to
 * `analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`. Any
 * error in that chain (expired JWT, revoked SA, GA4 outage, missing
 * `site_slug` custom dimension) is caught and logged at `level: 'warn'`,
 * then falls through to the D1-based fallback so the dashboard always
 * renders SOMETHING rather than 500ing.
 *
 * `ga4_connected` boolean in the fallback response tells the frontend
 * whether to show a "Connect GA4 for real analytics" CTA.
 *
 * @see {@link queryGa4DataApi} - Private helper that signs the JWT +
 *   calls the GA4 Data API.
 */

/** Max span (inclusive days) for an arbitrary start/end window — bounds D1 query cost. */
const MAX_CUSTOM_SPAN_DAYS = 90;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` (UTC) for an epoch-ms value. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse + validate an arbitrary `?start&end` (YYYY-MM-DD) into an absolute D1
 * window. Both-absent → no window (caller falls back to the `?period` lookback).
 * Malformed or reversed → a client error. A span over the cap is CLAMPED (keeping
 * `end`, moving `start` forward) and the effective clamped dates are returned so
 * the UI shows the ACTUAL window served — never a wider range than was queried.
 * `until` is exclusive (end-day-inclusive → next-day 00:00). Pure (no clock read)
 * so it is fully unit-testable; a future `end` is harmless (no rows exist ahead of now).
 */
export function parseCustomWindow(
  startRaw: string | undefined | null,
  endRaw: string | undefined | null,
): { window?: AnalyticsWindow; startDisplay?: string; endDisplay?: string; error?: string } {
  if (!startRaw && !endRaw) return {};
  if (!startRaw || !endRaw) return { error: 'start_and_end_required' };
  if (!ISO_DAY_RE.test(startRaw) || !ISO_DAY_RE.test(endRaw)) return { error: 'invalid_date_format' };
  let startMs = Date.parse(`${startRaw}T00:00:00Z`);
  const endMs = Date.parse(`${endRaw}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { error: 'invalid_date' };
  if (startMs > endMs) return { error: 'start_after_end' };
  const spanDays = Math.round((endMs - startMs) / 86_400_000) + 1; // inclusive of both ends
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) startMs = endMs - (MAX_CUSTOM_SPAN_DAYS - 1) * 86_400_000;
  return {
    window: { since: isoDay(startMs), until: isoDay(endMs + 86_400_000) },
    startDisplay: isoDay(startMs),
    endDisplay: isoDay(endMs),
  };
}

analytics.get('/api/analytics/:siteId', async (c) => {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  const userId = c.get('userId');
  if (!userId)
    return c.json(
      {
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', request_id: requestId },
      },
      401,
    );

  const siteId = c.req.param('siteId');
  const period = c.req.query('period') || '7'; // days

  const site = await dbQueryOne<{ slug: string; org_id: string }>(
    c.env.DB,
    'SELECT slug, org_id FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  if (!site)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Site not found', request_id: requestId } },
      404,
    );

  // Verify user belongs to the org
  const membership = await dbQueryOne(
    c.env.DB,
    'SELECT id FROM memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL',
    [site.org_id, userId],
  );
  if (!membership)
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Access denied', request_id: requestId } },
      403,
    );

  // Arbitrary start/end date range (AL — custom window). Validated + bounded
  // server-side; the tenant authz above is unaffected (it keys purely on
  // siteId + membership, never on the window params).
  const cw = parseCustomWindow(c.req.query('start'), c.req.query('end'));
  if (cw.error)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: cw.error, request_id: requestId } },
      400,
    );
  const window = cw.window;

  const propertyId = c.env.GA4_PROPERTY_ID;
  const serviceAccountJson = c.env.GA4_SERVICE_ACCOUNT_JSON;

  // GA4's Data API path uses a RELATIVE `NdaysAgo` window and can't answer an
  // arbitrary [start, end] here, so a custom window SKIPS GA4 for the D1
  // first-party path (which supports it) rather than silently serving a
  // relative range mislabeled as the requested window.
  if (propertyId && serviceAccountJson && !window) {
    try {
      const analyticsData = await queryGa4DataApi(
        propertyId,
        serviceAccountJson,
        site.slug,
        parseInt(period),
      );
      return c.json({ data: analyticsData });
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'api',
          route: 'GET /api/analytics/:siteId',
          error: err instanceof Error ? err.message : String(err),
          request_id: requestId,
        }),
      );
      // Fall through to next fallback (CF zone analytics → D1).
    }
  }

  // Second fallback: Cloudflare zone analytics via GraphQL. Works whenever
  // CF_API_TOKEN + CF_ZONE_ID are present — no GA4 measurement-id needed.
  // Surfaces request counts, page views, unique visitors, top paths, and
  // country geography sourced directly from the CF edge.
  if (isCloudflareAnalyticsConfigured(c.env)) {
    try {
      const dayCount = parseInt(period) || 7;
      const traffic = await loadSiteTraffic(c.env, site.slug, dayCount);
      return c.json({
        data: {
          period: traffic.range_days,
          slug: site.slug,
          source: 'cloudflare_zone_analytics',
          ga4_connected: false,
          ga4_measurement_id: c.env.GA4_MEASUREMENT_ID || null,
          gtm_container_id: c.env.GTM_CONTAINER_ID || null,
          stats: {
            pageViews: traffic.page_views,
            uniqueVisitors: traffic.unique_visitors,
            totalRequests: traffic.total_requests,
            // No session-duration / bounce-rate at the CF edge — those need
            // a JS beacon (GA4/PostHog). Surface 0 + the source flag so the
            // frontend can hide those tiles when source === 'cloudflare_*'.
            avgSessionDuration: '—',
            bounceRate: 0,
          },
          chartData: traffic.by_day.map((b) => ({
            date: b.day,
            views: b.page_views || b.requests,
          })),
          trafficSources: [], // not available at the edge layer
          topPages: traffic.top_paths.map((p) => ({ path: p.path, views: p.requests })),
          topCountries: traffic.by_country.map((cc) => ({
            country: cc.country,
            views: cc.requests,
          })),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A permission/authz failure here is EXPECTED + PERMANENT — the CF API token lacks
      // `zone.analytics.read`, and `*.projectsites.dev` subdomains have no CF-zone dataset
      // anyway — so the D1 first-party fallback below is the DESIGNED path, not an incident.
      // Logging it at `warn` on EVERY load was alert-fatigue noise that buries real warnings
      // (graceful-degradation-hides-outages). Classify: expected authz/config → `info` (a
      // normal fallback transition); an unexpected error (network/timeout/schema) stays `warn`.
      const expected = isExpectedZoneAnalyticsFallback(msg);
      console.warn(
        JSON.stringify({
          level: expected ? 'info' : 'warn',
          service: 'api',
          route: 'GET /api/analytics/:siteId',
          fallback: 'cloudflare_zone_analytics',
          expected,
          error: msg,
          request_id: requestId,
        }),
      );
      // Fall through to D1 audit-log fallback.
    }
  }

  // Final source: FIRST-PARTY edge pageviews recorded at serve time into
  // `visitor_events` (see the Worker site-serving call to
  // recordPageviewFromRequest). This is the authoritative per-site signal and
  // needs NO GA4/CF config, so visitor clicks always surface here even before
  // zone analytics or GA4 are wired. Replaces the old audit-log estimate that
  // always returned zeros.
  const dayCount = parseInt(period) || 7;
  try {
    const summary = await getTrafficSummary(c.env, siteId, dayCount, window);
    // The daily series honors the SAME window — absolute [since, until) bounds for
    // a custom range, else the relative lookback.
    const byDay = await dbQuery<{ day: string; views: number }>(
      c.env.DB,
      `SELECT DATE(created_at) AS day, COUNT(*) AS views FROM visitor_events
       WHERE site_id = ? AND event_type = 'pageview' AND ${
         window ? 'created_at >= ? AND created_at < ?' : "created_at >= datetime('now', ?)"
       }
       GROUP BY DATE(created_at) ORDER BY day`,
      window ? [siteId, window.since, window.until] : [siteId, `-${dayCount} days`],
    );
    return c.json({
      data: {
        period: window ? summary.windowDays : dayCount,
        // Echo the EXACT window served so the UI labels the real range (honest even
        // when a >90-day request was clamped). Null for a relative lookback.
        windowStart: cw.startDisplay ?? null,
        windowEnd: cw.endDisplay ?? null,
        slug: site.slug,
        source: 'first_party_edge',
        ga4_connected: !!(propertyId && serviceAccountJson),
        ga4_measurement_id: c.env.GA4_MEASUREMENT_ID || null,
        gtm_container_id: c.env.GTM_CONTAINER_ID || null,
        stats: {
          pageViews: summary.pageviews,
          uniqueVisitors: summary.uniqueSessions,
          avgSessionDuration: '—',
          bounceRate: 0,
        },
        chartData: (byDay.data || []).map((r) => ({ date: r.day, views: Number(r.views) })),
        trafficSources: [],
        topPages: summary.topPaths.map((p) => ({ path: p.path, views: p.count })),
      },
    });
  } catch (err) {
    // Last-ditch: never 500 the dashboard on analytics. Return an empty envelope.
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'api',
        route: 'GET /api/analytics/:siteId',
        fallback: 'first_party_edge',
        error: err instanceof Error ? err.message : String(err),
        request_id: requestId,
      }),
    );
    return c.json({
      data: {
        period: dayCount,
        windowStart: cw.startDisplay ?? null,
        windowEnd: cw.endDisplay ?? null,
        slug: site.slug,
        source: 'empty',
        ga4_connected: !!(propertyId && serviceAccountJson),
        ga4_measurement_id: c.env.GA4_MEASUREMENT_ID || null,
        gtm_container_id: c.env.GTM_CONTAINER_ID || null,
        stats: { pageViews: 0, uniqueVisitors: 0, avgSessionDuration: '—', bounceRate: 0 },
        chartData: [],
        trafficSources: [],
        topPages: [],
      },
    });
  }
});

/**
 * Query the GA4 Data API v1beta using a service-account JWT.
 *
 * Builds an RS256-signed JWT from the SA's PKCS8 private key, exchanges it
 * for an OAuth2 access token via `oauth2.googleapis.com/token`, then POSTs
 * a `runReport` request to the GA4 Data API filtered by the
 * `customEvent:site_slug` dimension to isolate per-site stats. Aggregates
 * the row-level response into the dashboard envelope shape (totals + daily
 * series + top pages + traffic channels).
 *
 * @param propertyId - GA4 property ID (numeric string from `c.env.GA4_PROPERTY_ID`).
 * @param serviceAccountJsonB64 - Base64-encoded service-account JSON key
 *   from `c.env.GA4_SERVICE_ACCOUNT_JSON`. Encoded once at secret-creation
 *   time to avoid newline escaping issues in the PEM body when storing as
 *   a Wrangler secret. Decoded with `atob()` then `JSON.parse()`.
 * @param siteSlug - Site slug used as the `site_slug` custom-dimension
 *   filter value. Must match the slug logged by the site's GA4 snippet —
 *   if the snippet doesn't set this dimension, the report returns zero rows.
 * @param days - Look-back window. Used as `${days}daysAgo` for the
 *   `dateRanges[].startDate` field.
 *
 * @returns Aggregated analytics envelope ready for the dashboard:
 *   `{ period, ga4_connected: true, stats: { pageViews, uniqueVisitors,
 *   avgSessionDuration: "Xm Ys", bounceRate }, chartData: [{date, views}],
 *   trafficSources: [{name, percent}], topPages: [{path, views}] }`.
 *   `bounceRate` is rounded to 1 decimal place (`* 1000 / 10`).
 *   `avgSessionDuration` formatted as human-readable `Xm Ys` for direct UI
 *   rendering.
 *
 * @throws {Error} Any unhandled exception from the JWT signing, OAuth2 token
 *   exchange, or GA4 Data API call propagates UP to the calling route's
 *   try/catch, which logs at `warn` and falls back to the D1-based stats.
 *   Common causes: SA key revoked (401 from oauth2 endpoint), GA4
 *   permission missing (403 from analyticsdata), invalid property ID
 *   (404), missing `site_slug` custom dimension (200 + empty rows).
 *
 * @remarks
 * Uses Web Crypto SubtleCrypto API (`crypto.subtle.importKey` +
 * `crypto.subtle.sign`) because Workers don't have Node's `crypto.createSign`.
 * Signature base64-url-encoded inline (replace `+` → `-`, `/` → `_`, strip
 * `=`) per RFC 7515.
 *
 * 10000-row hard limit on the report query — adequate for per-site
 * dashboards but could undercount for high-traffic sites over long
 * windows. Future work: paginate via `offset`.
 *
 * Channel + page aggregation uses in-Worker `Map<>` accumulators rather
 * than asking GA4 to pre-group, because the same query also produces the
 * daily series and we want one round-trip not three.
 *
 * @see {@link https://developers.google.com/analytics/devguides/reporting/data/v1 GA4 Data API}
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7523 RFC 7523 JWT Bearer for OAuth 2.0}
 */
async function queryGa4DataApi(
  propertyId: string,
  serviceAccountJsonB64: string,
  siteSlug: string,
  days: number,
): Promise<Record<string, unknown>> {
  // Decode the base64-encoded service account JSON
  const saJson = JSON.parse(atob(serviceAccountJsonB64));

  // Build a JWT for Google OAuth2
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      iss: saJson.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  // Import the private key and sign
  const pemContents = saJson.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemContents), (c: string) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, signatureInput);
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${header}.${payload}.${signatureB64}`;

  // Exchange JWT for access token. 8s bound — a hung Google egress used to
  // hold /api/analytics/:siteId past the service worker's 30s freshness
  // timeout, rejecting the FetchEvent (SW "Failed to fetch", 2026-08-20).
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(8000),
  });
  const tokenData = (await tokenRes.json()) as { access_token: string };

  // Run GA4 Data API report (8s bound — same reasoning as above).
  const reportRes = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [
          { name: 'date' },
          { name: 'pagePath' },
          { name: 'sessionDefaultChannelGroup' },
        ],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'totalUsers' },
          { name: 'averageSessionDuration' },
          { name: 'bounceRate' },
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'customEvent:site_slug',
            stringFilter: { matchType: 'EXACT', value: siteSlug },
          },
        },
        limit: 10000,
      }),
    },
  );
  const report = (await reportRes.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  };

  let totalPageViews = 0;
  let totalUsers = 0;
  let totalDuration = 0;
  let totalBounceRate = 0;
  let rowCount = 0;
  const dailyViews = new Map<string, number>();
  const pagePaths = new Map<string, number>();
  const channels = new Map<string, number>();

  for (const row of report.rows || []) {
    const date = row.dimensionValues[0].value;
    const pagePath = row.dimensionValues[1].value;
    const channel = row.dimensionValues[2].value;
    const views = parseInt(row.metricValues[0].value) || 0;
    const users = parseInt(row.metricValues[1].value) || 0;
    const duration = parseFloat(row.metricValues[2].value) || 0;
    const bounce = parseFloat(row.metricValues[3].value) || 0;

    totalPageViews += views;
    totalUsers += users;
    totalDuration += duration;
    totalBounceRate += bounce;
    rowCount++;

    dailyViews.set(date, (dailyViews.get(date) || 0) + views);
    pagePaths.set(pagePath, (pagePaths.get(pagePath) || 0) + views);
    channels.set(channel, (channels.get(channel) || 0) + views);
  }

  const avgDuration = rowCount > 0 ? totalDuration / rowCount : 0;
  const avgBounce = rowCount > 0 ? totalBounceRate / rowCount : 0;
  const mins = Math.floor(avgDuration / 60);
  const secs = Math.floor(avgDuration % 60);

  const chartData = Array.from(dailyViews.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, views]) => ({ date, views }));

  const topPages = Array.from(pagePaths.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([path, views]) => ({ path, views }));

  const totalChannelViews = Array.from(channels.values()).reduce((s, v) => s + v, 0) || 1;
  const trafficSources = Array.from(channels.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([name, views]) => ({
      name,
      percent: Math.round((views / totalChannelViews) * 100),
    }));

  return {
    period: days,
    ga4_connected: true,
    stats: {
      pageViews: totalPageViews,
      uniqueVisitors: totalUsers,
      avgSessionDuration: `${mins}m ${secs}s`,
      bounceRate: Math.round(avgBounce * 1000) / 10,
    },
    chartData,
    trafficSources,
    topPages,
  };
}
