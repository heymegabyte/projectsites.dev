/**
 * @module mocks/fixtures/analytics
 *
 * @description
 * Mock fixtures for the ENTIRE `/admin/analytics` surface (UI-mockout P2). The
 * Analytics section is the densest admin view — its default "Overview" tab fires a
 * per-card decoupled fan-in (the main summary + the CF aggregate + the daily series +
 * the URL list + the org CF-credential status) AND ~9 self-fetching card components,
 * then the sibling tabs (By Section / Forms / Visitor Funnel) each fetch their own
 * rollup. Every route here is served so the whole section LIGHTS UP on `?mock=1` with
 * believable, internally-consistent traffic — no spurious error toasts, every card in
 * its populated (or honest-empty) state.
 *
 * Each factory returns the EXACT worker wire shape (traced to
 * `libs/features/site_analytics/handlers.ts`, `src/routes/cloudflare_rum.ts`,
 * `libs/features/site_urls/handlers.ts`, and the `/admin/cloudflare-credentials`
 * route), typed against the real `api.service.ts` interfaces where they exist — so
 * wiring the real endpoint later is a provider SWAP, not a rewrite.
 *
 * | Route (`:param` PATTERN keys)                 | Factory                      | Worker contract                                   |
 * | --------------------------------------------- | ---------------------------- | ------------------------------------------------- |
 * | `GET /sites/:id/multi-url-analytics`          | {@link multiUrlAnalyticsFixture} | `{ data: MultiUrlAnalyticsEnvelope }`         |
 * | `GET /sites/:id/analytics`                    | {@link siteAnalyticsFixture}     | BARE `SiteAnalyticsSummary` (has `.traffic`)  |
 * | `GET /sites/:id/analytics/daily`              | {@link analyticsDailyFixture}    | `{ days: DailyRow[] }`                        |
 * | `GET /sites/:id/analytics/weekday`            | {@link analyticsWeekdayFixture}  | `{ byWeekday, tzApplied }`                    |
 * | `GET /sites/:id/analytics/visitors`           | {@link analyticsVisitorsFixture} | `{ newVisits, returningVisits, unknownVisits }` |
 * | `GET /sites/:id/analytics/entry-pages`        | {@link analyticsEntryPagesFixture} | `{ pages: {path,count}[] }`                 |
 * | `GET /sites/:id/analytics/exit-pages`         | {@link analyticsExitPagesFixture}  | `{ pages: {path,count}[] }`                 |
 * | `GET /sites/:id/analytics/clicks`             | {@link analyticsClicksFixture}   | `{ total, byLabel: {label,count}[] }`         |
 * | `GET /sites/:id/analytics/session-duration`   | {@link analyticsSessionDurationFixture} | `{ sessions, medianMs, avgMs, maxMs, distribution }` |
 * | `GET /sites/:id/analytics/concierge`          | {@link analyticsConciergeFixture} | `{ opens, messages, uniqueVisitors, messagesPerOpen }` |
 * | `GET /sites/:id/analytics/referrers`          | {@link analyticsReferrersFixture} | `{ domains: {label,count}[], capped }`        |
 * | `GET /sites/:id/analytics/sections`           | {@link analyticsSectionsFixture} | `{ siteId, windowDays, totalConversions, sections, generatedAt }` |
 * | `GET /sites/:id/analytics/forms`              | {@link analyticsFormsFixture}    | `{ siteId, windowDays, forms, generatedAt }`  |
 * | `GET /sites/:id/analytics/funnel`             | {@link analyticsFunnelFixture}   | `{ siteId, windowDays, stages, generatedAt }` |
 * | `GET /sites/:id/cloudflare-rum`               | {@link cloudflareRumFixture}     | `CloudflareRumResponse` (bare)                |
 * | `GET /sites/:id/urls`                         | {@link siteUrlsFixture}          | `{ data: SiteUrlRow[] }`                      |
 * | `GET /admin/cloudflare-credentials`           | {@link cloudflareCredentialsFixture} | `{ data: CloudflareCredentialStatus }`    |
 *
 * @remarks
 * - **Internally consistent numbers.** The populated view describes ONE believable
 *   subdomain site for a recent 30-day window (the demo `AnalyticsRange` default is
 *   `7d`/`30d`): ~`BASE_PAGEVIEWS` pageviews across `BASE_VISITS` visits, so the KPI
 *   tiles, the daily chart (sums to the totals), top pages/countries/referrers, the
 *   funnel (landing ≥ view ≥ engage ≥ convert), and the per-card metrics all tell the
 *   same story — never contradictory figures across cards.
 * - **Beacon source.** The demo site is a `*.projectsites.dev` subdomain, so the CF
 *   edge aggregate resolves NO zone (`urls_included[].resolved_zone:false`,
 *   `any_real_data:false`, `delivery:null`) — the component then renders from the
 *   authoritative first-party D1 summary (the `beacon` source), exactly as prod does
 *   for a subdomain. `cloudflare-credentials` reports `none` (honest: a demo org has
 *   no CF key), and `cloudflare-rum` reports `available:false` — both honest-empty.
 * - **state variants.** `empty` → a brand-new site with zero traffic (every KPI 0, the
 *   "No traffic yet — share your site" empty state, every card its calm measuring/empty
 *   state); `populated`/`loading`/default → the rich 30-day view. `error` is owned by
 *   the interceptor (it throws a 500 before any factory runs). `loading` serves the
 *   populated body after the interceptor's latency (same as populated).
 * - Registered under `:param` PATTERN keys so ONE factory serves EVERY fixture site id.
 */
import type {
  AnalyticsRange,
  CloudflareCredentialStatus,
  MultiUrlAnalyticsEnvelope,
  SiteAnalyticsSummary,
  SiteTrafficSummary,
  SiteUrlRow,
} from '../../services/api.service';
import type { FixtureFactory, MockState } from './index';

// ────────────────────────────── shared constants ──────────────────────────────

/** The demo window the populated view describes (days). Mirrors the dashboard default. */
const WINDOW_DAYS = 30;

/** Headline totals the whole populated view is derived from — kept consistent across cards. */
const BASE_PAGEVIEWS = 4820;
const BASE_VISITS = 2140; // anonymous visitors (uniqueSessions), counted once/day
const BASE_CONVERSIONS = 96; // calls + directions + form submits combined

/** Previous-period totals (prior 30 days) so every trend chip renders a real delta. */
const PREV_PAGEVIEWS = 4180;
const PREV_VISITS = 1960;
const PREV_CONVERSIONS = 81;

/** The demo site's primary host — a `*.projectsites.dev` subdomain (beacon-sourced). */
const DEMO_HOST = 'beverwyck-barber.projectsites.dev';

/** Is this the zero-traffic brand-new-site state? */
function isEmpty(state: MockState): boolean {
  return state === 'empty';
}

// ─────────────────── GET /sites/:id/analytics/daily (the chart series) ───────────────────

/** One day of the pageview/session rollup (worker `analytics_daily`). */
interface DailyRow {
  day: string;
  pageviews: number;
  uniqueSessions: number;
  conversions: number;
}

/** `GET /api/sites/:id/analytics/daily` envelope — `{ days: [] }` on any miss. */
export interface AnalyticsDailyResponse {
  days: DailyRow[];
}

/**
 * Build a believable {@link WINDOW_DAYS}-day series whose pageviews SUM to
 * {@link BASE_PAGEVIEWS} (so the chart total matches the KPI tile), with a gentle
 * mid-week rhythm + a light upward trend, visits ≈ 44% of pageviews, and conversions
 * sprinkled on ~70% of days. Deterministic (seeded by day index), newest day last.
 */
const DAILY_SERIES: readonly DailyRow[] = buildDailySeries();

function buildDailySeries(): DailyRow[] {
  const anchor = Date.parse('2026-10-06T00:00:00Z');
  // A deterministic weekday weighting (Mon–Thu busiest) + slow ramp; normalized to BASE_PAGEVIEWS.
  const raw: number[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const dow = new Date(anchor - (WINDOW_DAYS - 1 - i) * 86_400_000).getUTCDay(); // 0=Sun
    const weekdayWeight = [0.72, 1.12, 1.18, 1.16, 1.05, 0.95, 0.78][dow]!;
    const ramp = 0.82 + (i / (WINDOW_DAYS - 1)) * 0.36; // 0.82 → 1.18 over the window
    raw.push(weekdayWeight * ramp);
  }
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const scale = BASE_PAGEVIEWS / rawSum;
  const rows: DailyRow[] = [];
  let pvAcc = 0;
  let visAcc = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const last = i === WINDOW_DAYS - 1;
    // Round per-day but reconcile the final day so the series sums EXACTLY to the totals.
    const pageviews = last
      ? BASE_PAGEVIEWS - pvAcc
      : Math.max(0, Math.round(raw[i]! * scale));
    pvAcc += pageviews;
    const uniqueSessions = last
      ? BASE_VISITS - visAcc
      : Math.max(0, Math.round(pageviews * 0.444));
    visAcc += uniqueSessions;
    const conversions = i % 10 === 3 || i % 10 === 7 ? 0 : Math.max(0, Math.round(pageviews / 52));
    rows.push({
      day: new Date(anchor - (WINDOW_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      pageviews,
      uniqueSessions,
      conversions,
    });
  }
  return rows;
}

/**
 * Daily-series factory. `empty` → `{ days: [] }` (no traffic → the chart's "No traffic
 * yet" empty state); populated → the believable {@link WINDOW_DAYS}-day rollup.
 */
export const analyticsDailyFixture: FixtureFactory<AnalyticsDailyResponse> = (
  state: MockState,
): AnalyticsDailyResponse => (isEmpty(state) ? { days: [] } : { days: [...DAILY_SERIES] });

// ─────────────────── GET /sites/:id/analytics (the first-party summary) ───────────────────

/** Top pages for the populated view — paths + view counts (≈ pageview distribution). */
const TOP_PATHS: ReadonlyArray<{ path: string; count: number; uniques: number }> = [
  { path: '/', count: 1960, uniques: 1180 },
  { path: '/services', count: 940, uniques: 612 },
  { path: '/book', count: 712, uniques: 498 },
  { path: '/about', count: 486, uniques: 331 },
  { path: '/gallery', count: 388, uniques: 254 },
  { path: '/contact', count: 334, uniques: 243 },
];

/** Top countries — US-heavy local business, summing to the visit base order of magnitude. */
const TOP_COUNTRIES: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'US', count: 4310 },
  { label: 'CA', count: 214 },
  { label: 'GB', count: 118 },
  { label: 'DE', count: 82 },
  { label: 'IN', count: 54 },
  { label: 'AU', count: 42 },
];

/** Acquisition channels — one per pageview (direct/organic/social/…). Sum ≈ pageviews. */
const BY_CHANNEL: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'organic', count: 1980 },
  { label: 'direct', count: 1510 },
  { label: 'social', count: 720 },
  { label: 'referral', count: 410 },
  { label: 'email', count: 140 },
  { label: 'paid', count: 60 },
];

/** Device / browser / OS splits (cover every bucket; "unknown" is a real bucket). */
const BY_DEVICE: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'mobile', count: 2890 },
  { label: 'desktop', count: 1640 },
  { label: 'tablet', count: 290 },
];
const BY_BROWSER: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'Chrome', count: 2510 },
  { label: 'Safari', count: 1580 },
  { label: 'Firefox', count: 410 },
  { label: 'Edge', count: 240 },
  { label: 'unknown', count: 80 },
];
const BY_OS: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'iOS', count: 2010 },
  { label: 'Android', count: 980 },
  { label: 'Windows', count: 1120 },
  { label: 'macOS', count: 620 },
  { label: 'unknown', count: 90 },
];

/** Hour-of-day pageviews (UTC) — a believable daytime hump; the UI rotates to local. */
const BY_HOUR: ReadonlyArray<{ hour: number; count: number }> = Array.from(
  { length: 24 },
  (_, h) => ({
    hour: h,
    // Peak around 13–22 UTC (US daytime), quiet overnight — scaled to ~BASE_PAGEVIEWS.
    count: Math.round(BASE_PAGEVIEWS * hourWeight(h)),
  }),
);
function hourWeight(h: number): number {
  const shape = [
    8, 5, 4, 3, 3, 4, 7, 14, 24, 36, 46, 54, 60, 64, 66, 63, 58, 55, 50, 44, 36, 28, 20, 13,
  ][h]!;
  const total = 924; // sum of the shape array
  return shape / total;
}

/** Conversions by kind — calls + directions + form submits summing to BASE_CONVERSIONS. */
const BY_CONVERSION_KIND: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'call', count: 44 },
  { label: 'directions', count: 29 },
  { label: 'form', count: 23 },
];

/**
 * The first-party traffic block (D1 `visitor_events`) — the authoritative per-site
 * signal. Populated with rich, mutually-consistent metrics so every overview card
 * renders in its populated state.
 */
function buildTraffic(): SiteTrafficSummary {
  return {
    pageviews: BASE_PAGEVIEWS,
    uniqueSessions: BASE_VISITS,
    conversions: BASE_CONVERSIONS,
    bounceRatePercent: 46, // true session-depth bounce (preferred over the edge proxy)
    topPaths: [...TOP_PATHS],
    byType: [
      { type: 'pageview', count: BASE_PAGEVIEWS },
      { type: 'conversion', count: BASE_CONVERSIONS },
    ],
    byDevice: [...BY_DEVICE],
    byBrowser: [...BY_BROWSER],
    byOs: [...BY_OS],
    byUtmSource: [
      { label: 'google', count: 420 },
      { label: 'facebook', count: 260 },
      { label: 'newsletter', count: 140 },
    ],
    byUtmMedium: [
      { label: 'cpc', count: 380 },
      { label: 'social', count: 260 },
      { label: 'email', count: 140 },
    ],
    byUtmCampaign: [
      { label: 'fall-promo', count: 300 },
      { label: 'grand-opening', count: 220 },
    ],
    byChannel: [...BY_CHANNEL],
    byCountry: [...TOP_COUNTRIES],
    byHour: [...BY_HOUR],
    byConversionKind: [...BY_CONVERSION_KIND],
    webVitals: {
      lcp: { p75: 1840, samples: 1120, dist: { good: 860, needs: 190, poor: 70 } },
      inp: { p75: 118, samples: 1080, dist: { good: 940, needs: 110, poor: 30 } },
      cls: { p75: 0.04, samples: 1120, dist: { good: 1010, needs: 80, poor: 30 } },
      fcp: { p75: 1180, samples: 1120 },
      ttfb: { p75: 410, samples: 1120 },
      slowestPages: [
        { path: '/gallery', lcpP75: 2640, inpP75: 142, clsP75: 0.06, samples: 210 },
        { path: '/services', lcpP75: 2180, inpP75: 128, clsP75: 0.03, samples: 380 },
      ],
    },
    jsErrors: {
      total: 3,
      byMessage: [
        { message: "TypeError: Cannot read properties of null (reading 'src')", count: 2, samplePath: '/gallery' },
        { message: 'ResizeObserver loop completed with undelivered notifications', count: 1, samplePath: '/' },
      ],
    },
    engagement: {
      medianMs: 38_000,
      samples: 1640,
      byPage: [
        { path: '/services', medianMs: 52_000, samples: 540 },
        { path: '/book', medianMs: 61_000, samples: 420 },
        { path: '/', medianMs: 29_000, samples: 980 },
      ],
      distribution: { s10: 1480, s30: 980, s60: 540, s180: 180 },
    },
    scrollDepth: {
      samples: 1580,
      medianPercent: 68,
      reach: { p25: 1500, p50: 1180, p75: 720, p100: 410 },
      byPage: [
        { path: '/services', medianPercent: 82, samples: 520, completionPercent: 34 },
        { path: '/', medianPercent: 58, samples: 940, completionPercent: 22 },
      ],
    },
    networkQuality: {
      samples: 1210,
      byEffectiveType: [
        { type: '4g', count: 980 },
        { type: '3g', count: 170 },
        { type: '2g', count: 44 },
        { type: 'slow-2g', count: 16 },
      ],
      medianDownlinkMbps: 8.4,
      medianRttMs: 90,
      saveDataPercent: 6,
      byPage: [{ path: '/gallery', medianDownlinkMbps: 4.2, medianRttMs: 140, samples: 210 }],
    },
    navTiming: {
      samples: 1120,
      dns: 18,
      connect: 64,
      ttfb: 410,
      transfer: 120,
      dom: 540,
      total: 1760,
      byPage: [{ path: '/gallery', ttfb: 480, total: 2480, samples: 210 }],
    },
    outboundClicks: {
      total: 182,
      byLink: [
        { href: 'tel:+19735550148', kind: 'call', count: 44 },
        { href: 'https://instagram.com/beverwyckbarber', kind: 'social', count: 58 },
        { href: 'https://maps.google.com/?q=Beverwyck+Barber', kind: 'directions', count: 29 },
        { href: 'mailto:book@beverwyckbarber.com', kind: 'email', count: 21 },
        { href: 'https://facebook.com/beverwyckbarber', kind: 'social', count: 30 },
      ],
    },
    formFunnel: {
      starts: 148,
      submits: 96,
      completionRatePercent: 65,
      byForm: [
        { form: 'contact', starts: 92, submits: 61, completionRatePercent: 66 },
        { form: 'booking', starts: 56, submits: 35, completionRatePercent: 63 },
      ],
    },
    previous: {
      pageviews: PREV_PAGEVIEWS,
      uniqueSessions: PREV_VISITS,
      conversions: PREV_CONVERSIONS,
      byConversionKind: [
        { label: 'call', count: 38 },
        { label: 'directions', count: 25 },
        { label: 'form', count: 18 },
      ],
    },
    windowDays: WINDOW_DAYS,
  };
}

/** The zero-traffic first-party block — an honest brand-new site (every metric empty/null). */
function emptyTraffic(): SiteTrafficSummary {
  return {
    pageviews: 0,
    uniqueSessions: 0,
    conversions: 0,
    bounceRatePercent: null,
    topPaths: [],
    byType: [],
    byDevice: [],
    byBrowser: [],
    byOs: [],
    byUtmSource: [],
    byUtmMedium: [],
    byUtmCampaign: [],
    byChannel: [],
    byCountry: [],
    byHour: [],
    byConversionKind: [],
    webVitals: { lcp: null, inp: null, cls: null, fcp: null, ttfb: null, slowestPages: [] },
    jsErrors: { total: 0, byMessage: [] },
    engagement: { medianMs: null, samples: 0, byPage: [], distribution: { s10: 0, s30: 0, s60: 0, s180: 0 } },
    scrollDepth: { samples: 0, medianPercent: null, reach: { p25: 0, p50: 0, p75: 0, p100: 0 }, byPage: [] },
    networkQuality: {
      samples: 0,
      byEffectiveType: [],
      medianDownlinkMbps: null,
      medianRttMs: null,
      saveDataPercent: null,
      byPage: [],
    },
    navTiming: { samples: 0, dns: null, connect: null, ttfb: null, transfer: null, dom: null, total: null, byPage: [] },
    outboundClicks: { total: 0, byLink: [] },
    formFunnel: { starts: 0, submits: 0, completionRatePercent: null, byForm: [] },
    previous: { pageviews: 0, uniqueSessions: 0, conversions: 0, byConversionKind: [] },
    windowDays: WINDOW_DAYS,
  };
}

/**
 * Summary factory — the BARE {@link SiteAnalyticsSummary} (no `{ data }` wrapper; the
 * component reads `.traffic` directly). Echoes the server-applied drilldown filter
 * (`appliedFilter`) when the request carries a valid `filterDim` + `filterValue`, so
 * the UI's "Filtered" chip renders from the server's confirmation (never the click
 * alone). `empty` → zero traffic; populated → the rich first-party block.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params (for `windowDays` + the `filterDim`/`filterValue` echo).
 */
export const siteAnalyticsFixture: FixtureFactory<SiteAnalyticsSummary> = (
  state: MockState,
  query: URLSearchParams,
): SiteAnalyticsSummary => {
  const windowDays = clampInt(query.get('windowDays'), WINDOW_DAYS, 1, 90);
  const traffic = isEmpty(state) ? emptyTraffic() : buildTraffic();
  traffic.windowDays = windowDays;
  traffic.previous.pageviews = isEmpty(state) ? 0 : PREV_PAGEVIEWS;
  const summary: SiteAnalyticsSummary = {
    siteId: 'site-mock-0001',
    windowDays,
    traffic,
  };
  // Echo back the drilldown the server "applied" so the removable chip renders honestly.
  const dim = query.get('filterDim');
  const value = query.get('filterValue');
  if (dim && value) summary.appliedFilter = { dim, value };
  return summary;
};

// ─────────────────── GET /sites/:id/multi-url-analytics (CF edge aggregate) ───────────────────

/**
 * Multi-URL CF aggregate factory. The demo site is a `*.projectsites.dev` subdomain, so
 * NO owned host resolves a CF zone → `any_real_data:false`, `delivery:null`, and the
 * single `urls_included` entry is `resolved_zone:false`. The component then renders from
 * the first-party summary (the `beacon` source) — exactly as prod does for a subdomain,
 * and WITHOUT a "connect Cloudflare" CTA fighting the real first-party data. `empty`
 * returns the same beacon-blind shape with zeroed totals.
 *
 * @param state - The mock state knob (affects only the zeroed totals; the zone is always unresolved).
 */
export const multiUrlAnalyticsFixture: FixtureFactory<{ data: MultiUrlAnalyticsEnvelope }> = (
  state: MockState,
  query: URLSearchParams,
): { data: MultiUrlAnalyticsEnvelope } => {
  const rangeDays = clampInt(query.get('days'), rangeToDays(query.get('range')), 1, 90);
  return {
    data: {
      range_days: rangeDays,
      // One bound host, zone UNRESOLVED (subdomain) → the beacon overlay owns the numbers.
      urls_included: [{ hostname: DEMO_HOST, resolved_zone: false }],
      pageviews: 0,
      uniques: 0,
      total_requests: 0,
      series: [],
      top_pages: [],
      top_countries: [],
      top_referrers: [],
      any_real_data: false,
      delivery: null,
    },
  };
};

// ─────────────────── GET /sites/:id/urls (bound URL list) ───────────────────

/** `GET /api/sites/:id/urls` envelope. */
export interface SiteUrlsResponse {
  data: SiteUrlRow[];
}

/**
 * Site-URLs factory — the primary host (always present) the "Aggregating" strip renders.
 * One `site_urls` row; `is_primary` is the D1 1/0 int. Same on every state (a site always
 * has a primary URL, even with zero traffic).
 */
export const siteUrlsFixture: FixtureFactory<SiteUrlsResponse> = (): SiteUrlsResponse => ({
  data: [
    {
      id: 'url-mock-0001',
      site_id: 'site-mock-0001',
      hostname: DEMO_HOST,
      is_primary: 1,
      zone_id: null,
      account_id: null,
      added_at: new Date(Date.parse('2026-09-06T12:00:00Z')).toISOString(),
    },
  ],
});

// ─────────────────── GET /admin/cloudflare-credentials ───────────────────

/** `GET /api/admin/cloudflare-credentials` envelope. */
export interface CloudflareCredentialsResponse {
  data: CloudflareCredentialStatus;
}

/**
 * CF-credential-status factory. A demo org has no Cloudflare key on file — the honest
 * state — so `has_credentials:false`, `source:'none'`. Same on every state. The
 * subdomain beacon path doesn't need credentials, so this never gates the demo.
 */
export const cloudflareCredentialsFixture: FixtureFactory<CloudflareCredentialsResponse> = (): CloudflareCredentialsResponse => ({
  data: {
    has_credentials: false,
    source: 'none',
    email: null,
    last_validated_at: null,
    last_validated_account_id: null,
  },
});

// ─────────────────── GET /sites/:id/cloudflare-rum ───────────────────

/** One Cloudflare-RUM metric (µs→ms already converted; rated vs Google's bands). */
interface CfRumMetric {
  p75: number | null;
  rating: 'good' | 'needs' | 'poor' | null;
  samples: number;
}

/** `GET /api/sites/:id/cloudflare-rum` body (bare — no `{ data }` wrapper). */
export interface CloudflareRumResponse {
  available: boolean;
  days?: number;
  host?: string;
  pageviews?: number | null;
  sampled?: boolean;
  webVitals?: { lcp: CfRumMetric; inp: CfRumMetric; cls: CfRumMetric };
  navTiming?: {
    ttfb: CfRumMetric;
    fcp: CfRumMetric;
    pageLoad: CfRumMetric;
    dns: CfRumMetric;
    connect: CfRumMetric;
  };
  window?: { since: string; until: string };
  reason?: string;
}

/**
 * Cloudflare-RUM factory. An INDEPENDENT second CWV source to the first-party beacon.
 * The demo org has no CF credentials + the site is a shared-zone subdomain, so CF RUM
 * is `available:false` with an honest `reason` — the card renders its calm "not
 * available for this site" state (never fabricated edge CWV). Same on every state.
 */
export const cloudflareRumFixture: FixtureFactory<CloudflareRumResponse> = (
  _state: MockState,
  query: URLSearchParams,
): CloudflareRumResponse => ({
  available: false,
  days: clampInt(query.get('days'), WINDOW_DAYS, 1, 90),
  host: DEMO_HOST,
  reason: 'no_cloudflare_credentials',
});

// ─────────────────── GET /sites/:id/analytics/weekday ───────────────────

/** `GET /api/sites/:id/analytics/weekday` body. */
export interface WeekdayResponse {
  byWeekday: { weekday: number; count: number }[];
  tzApplied: boolean;
}

/**
 * Weekday-breakdown factory. Day-of-week pageviews bucketed in the owner's local tz
 * (`tzApplied:true` when a `tz` offset is sent). `empty` → no buckets; populated → a
 * believable Mon–Thu-heavy histogram summing to ~{@link BASE_PAGEVIEWS}.
 */
export const analyticsWeekdayFixture: FixtureFactory<WeekdayResponse> = (
  state: MockState,
  query: URLSearchParams,
): WeekdayResponse => {
  if (isEmpty(state)) return { byWeekday: [], tzApplied: query.get('tz') != null };
  // 0=Sun … 6=Sat; Mon–Thu busiest (mirrors the daily weekday weighting).
  const counts = [462, 820, 862, 848, 768, 612, 448];
  return {
    byWeekday: counts.map((count, weekday) => ({ weekday, count })),
    tzApplied: query.get('tz') != null,
  };
};

// ─────────────────── GET /sites/:id/analytics/visitors ───────────────────

/** `GET /api/sites/:id/analytics/visitors` body (new vs returning). */
export interface VisitorTypeResponse {
  newVisits: number;
  returningVisits: number;
  unknownVisits: number;
}

/**
 * Visitor-type factory. New + returning + unknown (private-mode) splits summing to
 * ≈{@link BASE_VISITS}. `empty` → all zeros (card shows its measuring/empty state).
 */
export const analyticsVisitorsFixture: FixtureFactory<VisitorTypeResponse> = (
  state: MockState,
): VisitorTypeResponse =>
  isEmpty(state)
    ? { newVisits: 0, returningVisits: 0, unknownVisits: 0 }
    : { newVisits: 1480, returningVisits: 584, unknownVisits: 76 };

// ─────────────────── GET /sites/:id/analytics/entry-pages + exit-pages ───────────────────

/** `GET /api/sites/:id/analytics/{entry,exit}-pages` body — ranked paths. */
export interface PagesResponse {
  pages: { path: string; count: number }[];
}

/** Entry (landing) pages — where sessions START; `empty` → no pages. */
export const analyticsEntryPagesFixture: FixtureFactory<PagesResponse> = (
  state: MockState,
): PagesResponse =>
  isEmpty(state)
    ? { pages: [] }
    : {
        pages: [
          { path: '/', count: 1240 },
          { path: '/services', count: 410 },
          { path: '/book', count: 268 },
          { path: '/about', count: 142 },
          { path: '/gallery', count: 80 },
        ],
      };

/** Exit pages — where sessions END; `empty` → no pages. */
export const analyticsExitPagesFixture: FixtureFactory<PagesResponse> = (
  state: MockState,
): PagesResponse =>
  isEmpty(state)
    ? { pages: [] }
    : {
        pages: [
          { path: '/', count: 820 },
          { path: '/book', count: 612 },
          { path: '/contact', count: 388 },
          { path: '/services', count: 214 },
          { path: '/gallery', count: 106 },
        ],
      };

// ─────────────────── GET /sites/:id/analytics/clicks ───────────────────

/** `GET /api/sites/:id/analytics/clicks` body — generic UI interactions by label. */
export interface ClicksResponse {
  total: number;
  byLabel: { label: string; count: number }[];
}

/**
 * Click-tracking factory. Generic button/role=button interactions (NOT conversions or
 * navigations — those are counted elsewhere), labelled by text. `empty` → zero.
 */
export const analyticsClicksFixture: FixtureFactory<ClicksResponse> = (
  state: MockState,
): ClicksResponse =>
  isEmpty(state)
    ? { total: 0, byLabel: [] }
    : {
        total: 412,
        byLabel: [
          { label: 'Book now', count: 148 },
          { label: 'View services', count: 96 },
          { label: 'See gallery', count: 74 },
          { label: 'Read reviews', count: 58 },
          { label: 'Hours & location', count: 36 },
        ],
      };

// ─────────────────── GET /sites/:id/analytics/session-duration ───────────────────

/** `GET /api/sites/:id/analytics/session-duration` body. */
export interface SessionDurationResponse {
  sessions: number;
  medianMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  distribution: { s30: number; s60: number; s180: number; s300: number };
}

/**
 * Session-duration factory — session LENGTH (sum of dwell per tab-session), reduced to
 * median/avg/longest + a 30s/1m/3m/5m distribution. `empty` → zero sessions + null
 * medians (card shows "measuring…", never a fake 0).
 */
export const analyticsSessionDurationFixture: FixtureFactory<SessionDurationResponse> = (
  state: MockState,
): SessionDurationResponse =>
  isEmpty(state)
    ? { sessions: 0, medianMs: null, avgMs: null, maxMs: null, distribution: { s30: 0, s60: 0, s180: 0, s300: 0 } }
    : {
        sessions: BASE_VISITS,
        medianMs: 84_000,
        avgMs: 132_000,
        maxMs: 1_840_000,
        distribution: { s30: 1480, s60: 1040, s180: 486, s300: 214 },
      };

// ─────────────────── GET /sites/:id/analytics/concierge ───────────────────

/** `GET /api/sites/:id/analytics/concierge` body — AI concierge engagement. */
export interface ConciergeResponse {
  opens: number;
  messages: number;
  uniqueVisitors: number;
  messagesPerOpen: number | null;
}

/**
 * Concierge factory. The AI assistant is optional — the card SELF-HIDES when `opens`
 * is 0, so `empty` returns all zeros (card absent) and populated shows believable
 * engagement with a real messages-per-open ratio.
 */
export const analyticsConciergeFixture: FixtureFactory<ConciergeResponse> = (
  state: MockState,
): ConciergeResponse =>
  isEmpty(state)
    ? { opens: 0, messages: 0, uniqueVisitors: 0, messagesPerOpen: null }
    : { opens: 184, messages: 462, uniqueVisitors: 142, messagesPerOpen: 2.5 };

// ─────────────────── GET /sites/:id/analytics/referrers ───────────────────

/** `GET /api/sites/:id/analytics/referrers` body — external referring domains. */
export interface ReferrerDomainsResponse {
  domains: { label: string; count: number }[];
  capped: boolean;
}

/**
 * Referrer-domains factory. External referring hosts (the site's own hosts excluded
 * server-side); `capped` flags a long tail truncated server-side. `empty` → no domains.
 */
export const analyticsReferrersFixture: FixtureFactory<ReferrerDomainsResponse> = (
  state: MockState,
): ReferrerDomainsResponse =>
  isEmpty(state)
    ? { domains: [], capped: false }
    : {
        domains: [
          { label: 'google.com', count: 1980 },
          { label: 'facebook.com', count: 420 },
          { label: 'instagram.com', count: 300 },
          { label: 'yelp.com', count: 214 },
          { label: 'bing.com', count: 118 },
          { label: 'nextdoor.com', count: 72 },
        ],
        capped: true,
      };

// ─────────────────── GET /sites/:id/analytics/sections (By Section tab) ───────────────────

/** One section's conversion attribution row. */
interface SectionRow {
  section: string;
  count: number;
  percent: number;
  calls: number;
  directions: number;
  emails: number;
}

/** `GET /api/sites/:id/analytics/sections` body. */
export interface SectionConversionsResponse {
  siteId: string;
  windowDays: number;
  totalConversions: number;
  sections: SectionRow[];
  generatedAt: string;
}

/** A stable "generated at" for the rollup tabs (deterministic across test runs). */
const GENERATED_AT = new Date(Date.parse('2026-10-06T14:30:00Z')).toISOString();

/**
 * Section-attribution factory. Conversions (calls/directions/emails) attributed to the
 * on-page section that drove them. `empty` → zero conversions + no sections.
 */
export const analyticsSectionsFixture: FixtureFactory<SectionConversionsResponse> = (
  state: MockState,
  query: URLSearchParams,
): SectionConversionsResponse => {
  const windowDays = clampInt(query.get('windowDays'), WINDOW_DAYS, 1, 90);
  if (isEmpty(state)) {
    return { siteId: 'site-mock-0001', windowDays, totalConversions: 0, sections: [], generatedAt: GENERATED_AT };
  }
  const sections: SectionRow[] = [
    { section: 'hero', count: 38, percent: 40, calls: 20, directions: 12, emails: 6 },
    { section: 'contact', count: 29, percent: 30, calls: 14, directions: 9, emails: 6 },
    { section: 'services', count: 18, percent: 19, calls: 8, directions: 6, emails: 4 },
    { section: 'footer', count: 11, percent: 11, calls: 2, directions: 2, emails: 7 },
  ];
  return { siteId: 'site-mock-0001', windowDays, totalConversions: BASE_CONVERSIONS, sections, generatedAt: GENERATED_AT };
};

// ─────────────────── GET /sites/:id/analytics/forms (Forms tab) ───────────────────

/** One form's funnel row. */
interface FormRow {
  form: string;
  starts: number;
  submits: number;
  completionRate: number;
  abandoned: number;
}

/** `GET /api/sites/:id/analytics/forms` body. */
export interface FormAnalyticsResponse {
  siteId: string;
  windowDays: number;
  forms: FormRow[];
  generatedAt: string;
}

/**
 * Form-analytics factory. Per-form starts → submits → completion-rate + abandonment
 * (starts − submits). Mirrors the summary's `formFunnel`. `empty` → no forms.
 */
export const analyticsFormsFixture: FixtureFactory<FormAnalyticsResponse> = (
  state: MockState,
  query: URLSearchParams,
): FormAnalyticsResponse => {
  const windowDays = clampInt(query.get('windowDays'), WINDOW_DAYS, 1, 90);
  if (isEmpty(state)) return { siteId: 'site-mock-0001', windowDays, forms: [], generatedAt: GENERATED_AT };
  const forms: FormRow[] = [
    { form: 'contact', starts: 92, submits: 61, completionRate: 66, abandoned: 31 },
    { form: 'booking', starts: 56, submits: 35, completionRate: 63, abandoned: 21 },
  ];
  return { siteId: 'site-mock-0001', windowDays, forms, generatedAt: GENERATED_AT };
};

// ─────────────────── GET /sites/:id/analytics/funnel (Visitor Funnel tab) ───────────────────

/** One visitor-funnel stage. */
interface FunnelStage {
  key: string;
  label: string;
  sessions: number;
  percentOfLanding: number;
}

/** `GET /api/sites/:id/analytics/funnel` body. */
export interface VisitorFunnelResponse {
  siteId: string;
  windowDays: number;
  stages: FunnelStage[];
  generatedAt: string;
}

/**
 * Visitor-funnel factory. A monotonically-narrowing session funnel (landing → engaged →
 * deep → converted), each stage ≤ the previous, `percentOfLanding` relative to stage 1.
 * `empty` → no stages.
 */
export const analyticsFunnelFixture: FixtureFactory<VisitorFunnelResponse> = (
  state: MockState,
  query: URLSearchParams,
): VisitorFunnelResponse => {
  const windowDays = clampInt(query.get('windowDays'), WINDOW_DAYS, 1, 90);
  if (isEmpty(state)) return { siteId: 'site-mock-0001', windowDays, stages: [], generatedAt: GENERATED_AT };
  const stages: FunnelStage[] = [
    { key: 'landed', label: 'Landed', sessions: BASE_VISITS, percentOfLanding: 100 },
    { key: 'engaged', label: 'Engaged', sessions: 1340, percentOfLanding: 63 },
    { key: 'deep', label: 'Browsed deep', sessions: 720, percentOfLanding: 34 },
    { key: 'converted', label: 'Converted', sessions: BASE_CONVERSIONS, percentOfLanding: 4 },
  ];
  return { siteId: 'site-mock-0001', windowDays, stages, generatedAt: GENERATED_AT };
};

// ────────────────────────────── helpers ──────────────────────────────

/** Parse a query-param int with a default + clamp; non-numeric → the default. */
function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw == null ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/** Map an `AnalyticsRange` enum label to its day count (fallback 30). */
function rangeToDays(range: string | null): number {
  switch (range as AnalyticsRange | null) {
    case '24h':
      return 1;
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    default:
      return WINDOW_DAYS;
  }
}
