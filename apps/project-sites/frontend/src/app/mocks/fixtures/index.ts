/**
 * @module mocks/fixtures
 *
 * @description
 * The fixture REGISTRY — the single map the mock interceptor consults. Each entry
 * keys a route pattern (`"<METHOD> <path>"`, path relative to `/api`, e.g.
 * `"GET /admin/leads"`) to a typed {@link FixtureFactory}. When `?mock=1` is active
 * the interceptor matches an incoming request against this map (method + pathname,
 * origin + query stripped) and serves the factory's body; an UNMATCHED route passes
 * through to the real backend untouched (the mock layer never breaks a real call).
 *
 * @remarks
 * - This is the seam the whole UI-mock-out campaign extends: a new slice adds ONE
 *   fixture module + ONE registry line. Every fixture satisfies the SAME typed
 *   contract the real worker returns, so wiring the real endpoint is a provider SWAP.
 * - Paths are stored WITHOUT the `/api` prefix + WITHOUT query — the interceptor
 *   normalizes the request the same way before lookup, so `GET /api/admin/leads?x=1`
 *   matches the `GET /admin/leads` entry.
 * - A registry key MAY carry `:param` segments (`GET /sites/:id/mcp/connections`) — a
 *   PATTERN that matches any value in that segment, so ONE fixture serves every id.
 *   {@link findFixture} checks EXACT keys first, then `:param` patterns (first match),
 *   so an exact key always wins; an unmatched key still passes through to the backend.
 * - `state` lets every fixture expose empty / loading / error / populated variants
 *   via `?mock=1&state=…` so every UI state is demoable from mock data alone.
 */
import { leadsFixture } from './leads.fixture';
import { sitesFixture } from './sites.fixture';
import { subscriptionFixture, entitlementsFixture, walletFixture } from './billing.fixture';
import { domainsSummaryFixture } from './domains-summary.fixture';
import { meFixture } from './admin-me.fixture';
import {
  mcpConnectionsFixture,
  snapshotMetricsFixture,
  snapshotsListFixture,
  githubStatusFixture,
  copilotConfigFixture,
  logsTailFixture,
  sparklineFixture,
  annotationsFixture,
  readinessFixture,
} from './per-site.fixture';
// P2d — these three superseded the thin per-site stubs with richer section fixtures.
import { deliverabilityFixture } from './deliverability.fixture';
import { webhooksFixture, webhookDeliveriesFixture } from './webhooks.fixture';
import { docsOpenApiFixture, docsStatsFixture, docsAppOverviewFixture } from './docs.fixture';
import { appsInstallCountsFixture } from './apps.fixture';
import { apiKeysFixture, sessionsFixture, notificationPrefsFixture } from './user-settings.fixture';
// ai-logs: richer section fixture supersedes the thin per-site stub (+ a per-log detail route).
import { aiLogsFixture, aiLogDetailFixture } from './ai-logs.fixture';
import {
  aiSettingsFixture,
  teamFixture,
  orgEnvVarsFixture,
  orgSecurityFixture,
} from './settings.fixture';
import { orgFullOrganizationFixture } from './team.fixture';
import {
  multiUrlAnalyticsFixture,
  siteAnalyticsFixture,
  analyticsDailyFixture,
  analyticsWeekdayFixture,
  analyticsVisitorsFixture,
  analyticsEntryPagesFixture,
  analyticsExitPagesFixture,
  analyticsClicksFixture,
  analyticsSessionDurationFixture,
  analyticsConciergeFixture,
  analyticsReferrersFixture,
  analyticsSectionsFixture,
  analyticsFormsFixture,
  analyticsFunnelFixture,
  cloudflareRumFixture,
  siteUrlsFixture,
  cloudflareCredentialsFixture,
} from './analytics.fixture';
import { auditFixture } from './audit.fixture';
import { siteHostnamesFixture, adminDomainsFixture } from './domains.fixture';
import {
  voiceInsightsFixture,
  voiceNumbersFixture,
  voiceNumberSearchFixture,
  voiceVanitySuggestionsFixture,
  voiceConversationsFixture,
  voiceConversationDetailFixture,
  voiceAgentSettingsFixture,
  voiceMetaPromptFixture,
  voiceMcpAttachmentsFixture,
  voiceMcpConnectionsFixture,
} from './voice.fixture';
import { mcpTokensFixture, mcpToolsFixture, mcpToolUsageFixture } from './site-mcp-server.fixture';
import { featureFlagsFixture, liveCheckFixture } from './hosting.fixture';
import {
  socialAccountsFixture,
  socialPostsFixture,
  socialBestTimesFixture,
  socialAutoPilotConfigFixture,
  socialPostAnalyticsFixture,
} from './social.fixture';

/** The demo-state knob from `?mock=1&state=…`. `populated` is the default. */
export type MockState = 'empty' | 'loading' | 'error' | 'populated';

/** All valid mock states (for parsing/validation in {@link MockModeService}). */
export const MOCK_STATES: readonly MockState[] = ['empty', 'loading', 'error', 'populated'];

/**
 * A fixture factory — builds the response body for a matched route. Receives the
 * active {@link MockState} and the request's parsed query params (so a paginated
 * fixture can honor `offset`/`limit`). Pure + synchronous; the interceptor owns the
 * realistic latency + the `error` short-circuit.
 */
export type FixtureFactory<T = unknown> = (state: MockState, query: URLSearchParams) => T;

/**
 * Registry key: `"<METHOD> <path>"` where `path` is relative to `/api` and carries
 * NO query string, e.g. `"GET /admin/leads"`. Kept as a plain string so a slice can
 * add an entry in one line.
 *
 * A key MAY contain `:param` segments (e.g. `"GET /sites/:id/mcp/connections"`) — a
 * PATTERN key. A `:param` segment matches any single non-empty, non-`/` value, so
 * one pattern serves every id. EXACT keys (no `:param`) always win over patterns
 * (see {@link findFixture}). Static keys without a colon are matched verbatim.
 */
export type RoutePattern = string;

/**
 * The registry. **P0 ships ONE real surface — leads.** Later slices (dashboard,
 * billing, sites, analytics, …) each add their own typed fixture module + a line
 * here. PER-SITE routes use a `:param` PATTERN key so one fixture serves every id.
 */
export const FIXTURES: Readonly<Record<RoutePattern, FixtureFactory>> = {
  'GET /admin/leads': leadsFixture as FixtureFactory,
  'GET /sites': sitesFixture as FixtureFactory,
  'GET /billing/subscription': subscriptionFixture as FixtureFactory,
  'GET /billing/entitlements': entitlementsFixture as FixtureFactory,
  'GET /wallet': walletFixture as FixtureFactory,
  'GET /admin/domains/summary': domainsSummaryFixture as FixtureFactory,
  'GET /auth/me': meFixture as FixtureFactory,
  // Per-site reads the already-mocked surfaces fire once a site is selected — `:param`
  // patterns so one fixture serves EVERY fixture-site id (prod-nonexistent → 404 before).
  'GET /sites/:id/mcp/connections': mcpConnectionsFixture as FixtureFactory,
  'GET /sites/:id/snapshots/metrics': snapshotMetricsFixture as FixtureFactory,
  // P2 — analytics section (per-site :param reads + admin cloudflare-credentials)
  'GET /sites/:id/multi-url-analytics': multiUrlAnalyticsFixture as FixtureFactory,
  'GET /sites/:id/analytics': siteAnalyticsFixture as FixtureFactory,
  'GET /sites/:id/analytics/daily': analyticsDailyFixture as FixtureFactory,
  'GET /sites/:id/analytics/weekday': analyticsWeekdayFixture as FixtureFactory,
  'GET /sites/:id/analytics/visitors': analyticsVisitorsFixture as FixtureFactory,
  'GET /sites/:id/analytics/entry-pages': analyticsEntryPagesFixture as FixtureFactory,
  'GET /sites/:id/analytics/exit-pages': analyticsExitPagesFixture as FixtureFactory,
  'GET /sites/:id/analytics/clicks': analyticsClicksFixture as FixtureFactory,
  'GET /sites/:id/analytics/session-duration': analyticsSessionDurationFixture as FixtureFactory,
  'GET /sites/:id/analytics/concierge': analyticsConciergeFixture as FixtureFactory,
  'GET /sites/:id/analytics/referrers': analyticsReferrersFixture as FixtureFactory,
  'GET /sites/:id/analytics/sections': analyticsSectionsFixture as FixtureFactory,
  'GET /sites/:id/analytics/forms': analyticsFormsFixture as FixtureFactory,
  'GET /sites/:id/analytics/funnel': analyticsFunnelFixture as FixtureFactory,
  'GET /sites/:id/cloudflare-rum': cloudflareRumFixture as FixtureFactory,
  'GET /sites/:id/urls': siteUrlsFixture as FixtureFactory,
  'GET /admin/cloudflare-credentials': cloudflareCredentialsFixture as FixtureFactory,
  // P2 — audit section
  'GET /audit-logs': auditFixture as FixtureFactory,
  // P2 — domains section (per-site hostnames :param + org-wide aggregator)
  'GET /sites/:id/hostnames': siteHostnamesFixture as FixtureFactory,
  'GET /admin/domains': adminDomainsFixture as FixtureFactory,
  // P2b — voice section (org-level + per-site conversation detail :param)
  'GET /voice/insights': voiceInsightsFixture as FixtureFactory,
  'GET /voice/numbers': voiceNumbersFixture as FixtureFactory,
  'GET /voice/numbers/search': voiceNumberSearchFixture as FixtureFactory,
  'GET /voice/vanity-suggestions': voiceVanitySuggestionsFixture as FixtureFactory,
  'GET /voice/conversations': voiceConversationsFixture as FixtureFactory,
  'GET /voice/conversations/:id': voiceConversationDetailFixture as FixtureFactory,
  'GET /voice/agent-settings': voiceAgentSettingsFixture as FixtureFactory,
  'GET /voice/meta-prompt': voiceMetaPromptFixture as FixtureFactory,
  'GET /voice/mcp-attachments': voiceMcpAttachmentsFixture as FixtureFactory,
  'GET /mcp/connections': voiceMcpConnectionsFixture as FixtureFactory,
  // P2b — site MCP-server section (per-site :param; mcp/connections already fixtured above)
  'GET /sites/:id/mcp/tokens': mcpTokensFixture as FixtureFactory,
  'GET /sites/:id/mcp/tools': mcpToolsFixture as FixtureFactory,
  'GET /sites/:id/mcp/tool-usage': mcpToolUsageFixture as FixtureFactory,
  // P2b — hosting section
  'GET /feature-flags': featureFlagsFixture as FixtureFactory,
  'GET /sites/:id/live-check': liveCheckFixture as FixtureFactory,
  // P2d — SOCIAL section (Pulse Social composer + scheduler). The SECTION is NOT
  // flag-gated — every PRIMARY GET below is auth-only in `routes/social.ts` (only the
  // publish/schedule/generate MUTATIONS carry `social_publishing_native` / the
  // `social_publishing` + `social_autopilot` kill-switches). So the Social tab renders
  // fully on `?mock=1` with these five factories, no flag flip. `GET /social/posts/:id/analytics`
  // is a `:param` pattern (anchored, so it never shadows the exact `/social/posts` list).
  'GET /social/accounts': socialAccountsFixture as FixtureFactory,
  'GET /social/posts': socialPostsFixture as FixtureFactory,
  'GET /social/best-times': socialBestTimesFixture as FixtureFactory,
  'GET /social/auto-pilot/config': socialAutoPilotConfigFixture as FixtureFactory,
  'GET /social/posts/:id/analytics': socialPostAnalyticsFixture as FixtureFactory,
  // P2c — SETTINGS section (per-site ai-settings :param + org-level team/env-vars/security).
  // `GET /sites/:id/ai-settings` is the single richest per-site read (Settings General + AI-Chat
  // MCP allow-list + the Forms designer all read it) — it fixes the fire-281 #34 toast.
  'GET /sites/:id/ai-settings': aiSettingsFixture as FixtureFactory,
  'GET /team': teamFixture as FixtureFactory,
  // #37 native-fetch shim — the standalone admin Team SECTION reads this via
  // `OrgApiService.getFullOrganization()`, which uses NATIVE `window.fetch` (bypassing
  // the HttpClient interceptor). Now covered by `installMockFetch` (mocks/mock-fetch.ts),
  // so `?mock=1` lights up the Team section. DIFFERENT surface + envelope from `GET /team`
  // above (the Settings Team TAB) — see team.fixture.ts for the two-routes/two-envelopes note.
  'GET /auth/organization/get-full-organization': orgFullOrganizationFixture as FixtureFactory,
  'GET /env-vars': orgEnvVarsFixture as FixtureFactory,
  'GET /admin/security': orgSecurityFixture as FixtureFactory,
  // P2c — #34 shell sweep: the remaining per-site GET reads fired on section/tab open so NO
  // spurious 404/error toast fires anywhere in the demo (snapshots + github/status were NON-silent
  // → toasted; the rest are silent but kept the demo network tab dirty).
  'GET /sites/:id/snapshots': snapshotsListFixture as FixtureFactory,
  'GET /sites/:id/github/status': githubStatusFixture as FixtureFactory,
  'GET /sites/:id/ai-logs': aiLogsFixture as FixtureFactory,
  'GET /sites/:id/ai-logs/:logId': aiLogDetailFixture as FixtureFactory,
  'GET /sites/:id/deliverability': deliverabilityFixture as FixtureFactory,
  'GET /sites/:id/copilot/config': copilotConfigFixture as FixtureFactory,
  'GET /sites/:id/logs/tail': logsTailFixture as FixtureFactory,
  'GET /sites/:id/webhooks': webhooksFixture as FixtureFactory,
  'GET /sites/:id/webhooks/deliveries': webhookDeliveriesFixture as FixtureFactory,
  // P2d — docs section (OpenAPI explorer; auth-only, no flag; openapi.json is a BARE spec object)
  'GET /admin/docs/openapi.json': docsOpenApiFixture as FixtureFactory,
  'GET /admin/docs/stats': docsStatsFixture as FixtureFactory,
  'GET /admin/docs/app-overview': docsAppOverviewFixture as FixtureFactory,
  // P2d — apps section (install-count social-proof pills; the catalog grid itself is static)
  'GET /apps/install-counts': appsInstallCountsFixture as FixtureFactory,
  // P2d — user-settings section (API keys, active sessions, notification prefs)
  'GET /admin/api-keys': apiKeysFixture as FixtureFactory,
  'GET /admin/sessions': sessionsFixture as FixtureFactory,
  'GET /admin/notifications': notificationPrefsFixture as FixtureFactory,
  // #34 — the Snapshots section's three self-fetching cards (health sparkline, timeline
  // notes, readiness panel). Un-prefixed per-site paths (NOT `/snapshots/*`), verified
  // against the live components + worker. `:param` keys; each anchored regex (`^…$`, one
  // `[^/]+` per segment) can't shadow a longer sibling (`/snapshots`, `/snapshots/metrics`).
  'GET /sites/:id/sparkline': sparklineFixture as FixtureFactory,
  'GET /sites/:id/annotations': annotationsFixture as FixtureFactory,
  'GET /sites/:id/readiness': readinessFixture as FixtureFactory,
};

/**
 * Normalize a request method + URL to the registry key + its parsed query. Strips
 * the origin, the leading `/api` prefix, a trailing slash, and the query string, so
 * `GET https://host/api/admin/leads?offset=50` → `{ key: 'GET /admin/leads', query }`.
 * Falls back to the raw pathname when there's no `/api` prefix (same-origin SPA asset
 * routes aren't in the registry, so they simply won't match → pass through).
 */
export function toRegistryKey(
  method: string,
  url: string,
): { key: RoutePattern; query: URLSearchParams } {
  // Resolve relative URLs against a dummy base so `new URL` always parses.
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  let pathname: string;
  let query: URLSearchParams;
  try {
    const parsed = new URL(url, base);
    pathname = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    // Degenerate URL — treat the whole thing as the path, no query.
    const qIdx = url.indexOf('?');
    pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    query = new URLSearchParams(qIdx === -1 ? '' : url.slice(qIdx + 1));
  }
  // Drop the `/api` prefix the ApiService adds, and any trailing slash.
  let path = pathname.replace(/^\/api(?=\/|$)/, '');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '') path = '/';
  return { key: `${method.toUpperCase()} ${path}`, query };
}

/**
 * A compiled `:param` PATTERN key — the original pattern plus an anchored regex
 * that matches any normalized `"<METHOD> <path>"` key with the same shape.
 */
interface ParamPattern {
  /** The source pattern, e.g. `"GET /sites/:id/mcp/connections"`. */
  readonly pattern: RoutePattern;
  /** Anchored matcher: each `:param` → one non-`/` segment; everything else literal. */
  readonly regex: RegExp;
}

/**
 * Compile a `:param` pattern key to an anchored regex. The method + each literal
 * path segment is escaped so regex metacharacters in a real path are matched
 * literally; a `:param` segment becomes `[^/]+` (one or more non-slash chars, so a
 * value can't span segment boundaries). Anchored with `^…$` so the whole key must
 * match (no prefix/suffix over-match). Keys WITHOUT a `:` compile to `null` (they
 * live in the exact map and are never pattern-matched).
 */
function compileParamPattern(pattern: RoutePattern): ParamPattern | null {
  if (!pattern.includes(':')) return null;
  // Split on `/` so each segment is classified independently; the leading
  // "METHOD /" chunk has no `/` before the first space, so it's escaped whole.
  const source = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRegex(seg)))
    .join('/');
  return { pattern, regex: new RegExp(`^${source}$`) };
}

/** Escape regex metacharacters so a literal segment matches itself verbatim. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Precompiled `:param` patterns from the shipped {@link FIXTURES}, plus any
 * registered at runtime via {@link registerFixtures}. Rebuilt whenever the
 * registered set changes. Exact (colon-free) keys are NOT here — they're matched
 * via the object maps directly, which is both faster and higher-precedence.
 */
let PARAM_PATTERNS: ParamPattern[] = buildParamPatterns(FIXTURES);

/** Ad-hoc patterns registered at runtime (test seam) — checked after {@link FIXTURES}. */
const EXTRA_FIXTURES: Record<RoutePattern, FixtureFactory> = {};

/** Build the compiled param-pattern list from one or more registries (in order). */
function buildParamPatterns(...registries: Record<RoutePattern, FixtureFactory>[]): ParamPattern[] {
  const out: ParamPattern[] = [];
  for (const reg of registries) {
    for (const pattern of Object.keys(reg)) {
      const compiled = compileParamPattern(pattern);
      if (compiled) out.push(compiled);
    }
  }
  return out;
}

/**
 * Look up a fixture factory for a normalized registry key, or `undefined`.
 *
 * Precedence (first hit wins):
 *   1. EXACT match in {@link FIXTURES} (the shipped static + pattern map — exact keys only);
 *   2. EXACT match in {@link EXTRA_FIXTURES} (runtime-registered, exact keys only);
 *   3. first `:param` PATTERN whose anchored regex matches the key.
 *
 * So an exact key ALWAYS beats a param pattern that would also match, and an
 * unmatched key returns `undefined` → the interceptor passes the request straight
 * through to the real backend (the mock layer never breaks a real call).
 */
export function findFixture(key: RoutePattern): FixtureFactory | undefined {
  // 1 + 2 — exact wins (a `:param`-containing key is never an exact runtime key).
  const exact = FIXTURES[key] ?? EXTRA_FIXTURES[key];
  if (exact) return exact;
  // 3 — first matching param pattern (shipped patterns precede runtime-registered ones).
  for (const { pattern, regex } of PARAM_PATTERNS) {
    if (regex.test(key)) return FIXTURES[pattern] ?? EXTRA_FIXTURES[pattern];
  }
  return undefined;
}

/**
 * TEST SEAM — register ad-hoc fixture patterns (exact OR `:param`) without mutating
 * the shipped {@link FIXTURES} map. Returns a disposer that removes exactly the keys
 * it added and rebuilds the compiled pattern list, so a spec stays hermetic:
 *
 * ```ts
 * const dispose = registerFixtures({ 'GET /sites/:id/x': myFactory });
 * // …assert findFixture(...) …
 * dispose();
 * ```
 *
 * Shipped fixtures always take precedence (they're checked first); this seam only
 * ADDS routes for a test and never shadows a shipped key.
 */
export function registerFixtures(extra: Record<RoutePattern, FixtureFactory>): () => void {
  const added = Object.keys(extra);
  for (const key of added) EXTRA_FIXTURES[key] = extra[key];
  PARAM_PATTERNS = buildParamPatterns(FIXTURES, EXTRA_FIXTURES);
  return () => {
    for (const key of added) delete EXTRA_FIXTURES[key];
    PARAM_PATTERNS = buildParamPatterns(FIXTURES, EXTRA_FIXTURES);
  };
}
