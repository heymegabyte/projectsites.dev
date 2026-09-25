# Analytics Coverage Matrix

> Source-of-truth for the ProjectSites.dev Analytics section: every metric we surface, its dataset +
> source, tenant scoping, and honest capability limits. Built from a verified code scan (2026-09-25),
> NOT aspirational. Every row is implemented + rendered unless marked otherwise. CF capability map
> live-probed 2026-09-24. **Never imply an unavailable metric is zero or an estimated metric is exact.**

Cross-refs: `libs/features/visitor_events_core/service.ts` (first-party aggregators),
`libs/features/site_analytics/` (routes + daily/section/funnel), `src/services/multi_url_analytics.ts`
(CF GraphQL delivery), frontend `apps/project-sites/frontend/src/app/pages/admin/sections/analytics*.ts`
+ child cards.

## Tenant isolation model (how authz is enforced)

- **First-party (D1):** every aggregator scopes by `site_id = ?` via `currentWindow()` — the site id is
  resolved server-side from ownership records, never a client filter. A drilldown filter only ever
  *narrows* the already-site-scoped set (`filterClause` appends `AND <col> = ?`; the column is a trusted
  literal from `FILTER_DIMENSION_SQL`, the value is always a bound `?`) — it can never widen or cross a
  tenant boundary.
- **CF delivery (GraphQL):** host→zone resolved from ownership (`listSiteUrls` + `resolveZoneForHostname`),
  never a client hostname/zoneID. One GraphQL request per host (multi-day aliases), not per widget.
- **Public share:** `/api/public/analytics/:token` — the opaque token IS the isolation boundary.
- **Reconciliation locks (verify-against-source, real SQLite):** `reconcile_daily_summary` (daily↔summary),
  `reconcile_hourly_summary` (hourly↔summary — 2026-09-25). Both assert breakdown SUM === ground-truth
  count === headline, under filter + tenant scoping, so a drifting WHERE / tz double-count / event-type
  mismatch fails CI.

## First-party metrics (measured by us — D1 `visitor_events` + app.js beacon)

| Metric | Aggregator | Card | Notes |
|---|---|---|---|
| Pageviews | `getTrafficSummary.pageviews` | headline KPI | `event_type='pageview'`; bots dropped at ingest |
| Unique sessions (Visits) | `uniqueSessions` (`COUNT(DISTINCT session_id)`) | headline KPI | = visits, NOT unique people (labelled) |
| Conversions | `conversions` + `byConversionKind` (`getConversionKinds`) | conversions card | by kind: call/email/directions/outbound |
| Outbound link clicks | `outboundClicks` (`getOutboundClicksSummary`) | outbound card | top-8 by `$.href` + kind; `total` across all |
| Bounce rate | `bounceRatePercent` | KPI | single-page-session % from session depth; null when no sessions |
| Top pages | `topPaths` (+ `uniques` per path) | top-pages card | pageviews + unique sessions per path |
| Visitor type | `byType` | `VisitorTypeCardComponent` | beacon event-type distribution |
| Device / Browser / OS | `byDevice`/`byBrowser`/`byOs` | tech-breakdown card | drilldownable |
| Channel (acquisition) | `byChannel` | `channel-breakdown` card | direct/organic/social/paid/email; drilldownable |
| Campaign (UTM) | `byUtmSource`/`byUtmMedium`/`byUtmCampaign` | `campaign-breakdown` card | |
| Country | `byCountry` | "Top countries" (flags + drill) | honest "No geo data yet" empty |
| Hour-of-day | `getHourlyBreakdown` | hourly card | UTC buckets, rotated to viewer local; **hourly↔summary reconciled** |
| Weekday | `getWeekdayBreakdown` | weekday card | tz-correct bucketing; `tzApplied` disclosed |
| Referrer domains | `getReferrerDomains` | referrers card | |
| Entry / Exit pages | `getEntryPages`/`getExitPages` | entry/exit cards | |
| Session duration | `getSessionDuration` (+ `distribution`) | session-duration card | median + s10/s30/s60/s180 tiers |
| Engagement (dwell) | `engagement` (median + `distribution` + `byPage`) | engagement card | |
| Scroll depth | `scrollDepth` | `scroll-depth-card` | |
| Web Vitals (LCP/CLS/INP/FCP/TTFB) | `webVitals` | web-vitals-card | "Measuring…" when no samples (never 0) |
| Navigation Timing | `navTiming` (TTFB/DNS/connect/DOM/load + `byPage`) | nav-timing-card | **the latency CF blocks — measured first-party** |
| Network quality | `networkQuality` (downlink/RTT + `byPage`) | network-quality-card | `navigator.connection`; slowest pages |
| JS errors | `jsErrors` | errors surface | first-party error beacon |
| Form funnel | `getFormFunnelSummary` (starts→submits) | funnel card | completion % null when no starts |
| Conversions by section | `getConversionsBySection` | sections surface | which page sections drive contact intent |
| Concierge engagement | `getConciergeEngagement` | concierge card | gallery-only caveat surfaced |

## Cloudflare delivery (CF `httpRequestsAdaptiveGroups` — adaptive-SAMPLED, ~30d, per-host)

Surfaced via `multi_url_analytics.ts` → `DeliverySummary`, one request per host. Sampling disclosed
("full data" / "sampled ~1:N"); `sum{visits}` is CF's already-scaled estimate (never multiply again).

- **Status classes** — `edgeResponseStatus`: `top_statuses[]` with `count` + `edgeResponseBytes` + `visits`.
- **Cache** — `cacheStatus`: hit/miss/uncacheable `count` + `_bytes` + `_visits` + `hit_ratio_pct` (null when no cacheable).
- **Bandwidth** — `sum{edgeResponseBytes}`.
- **Protocol** — `clientRequestHTTPProtocol` (HTTP/1.1/2/3), `clientSSLProtocol` (TLS version).
- **Content type** — `edgeResponseContentTypeName`. **HTTP method** — `clientRequestHTTPMethodName`.
- **Verified bots** — `verifiedBotCategory` (search engines / etc; distinct from blocked bot-mgmt).
- **Geo / path / referrer** — `clientCountryName`, `clientRequestPath`, `clientRequestReferer`.

## Cloudflare RUM (account-level — real data)

- `rumPageloadEventsAdaptiveGroups`, `rumPerformanceEventsAdaptiveGroups`, `rumWebVitalsEventsAdaptiveGroups`
  — cross-checked against first-party Web Vitals; per-host attribution verified.

## BLOCKED — honestly absent (plan lacks entitlement; NEVER built, never shown as 0)

- `firewallEventsAdaptiveGroups` (WAF / security events) — no entitlement.
- `botScore` / `botScoreSrcName` (Bot Management) — no entitlement. (Verified-bot CATEGORY is separate + available.)
- Edge latency / TTFB timing (origin/edge) — not in plan; **the latency gap is filled first-party via Navigation Timing** (see nav-timing-card).

## Ranked backlog (honest — the section is at a feature plateau; remaining work is correctness + polish)

1. **Extend reconciliation to a breakdown-sum surface** — `byCountry`/`byChannel`/`byDevice` SUM vs pageviews
   (needs a null-bucket-attribution check first: a pageview with no `$.country` must land in an "Unknown"
   bucket or the SUM won't equal pageviews — verify before asserting). `byType` is the cleanest candidate.
2. **Route-level tenant-404 tests** for any analytics route asserting only at the aggregator level (audit
   `funnel`/`forms`/`sections` handler routes for an explicit non-owned-site 404, matching entry/exit/weekday).
3. **Verified-bot visit split** — `verifiedBotCategory` + `sum{visits}` already fetched; a "search engines
   reached N real visitors" companion line to bandwidth (data exists, surfacing only).
4. **Conversions by channel** — conversions currently break down by device/browser/os + section; a
   `byChannel` cut of conversions ("do social/paid referrals convert?") reuses the proven channel enrichment.

## What NOT to build (verified already shipped — do not re-suggest)

Country card, visitor-type card, channel-breakdown, campaign-breakdown, scroll-depth, engagement
`distribution`, `networkQuality.byPage`, `navTiming.byPage`, cache/status `sum{visits}`, outbound-by-kind,
conversions-by-section — ALL implemented + rendered as of 2026-09-25. A scan that "finds" these as gaps is
reading stale/hallucinated state — verify against code (`grep` the component + aggregator) before proposing.
