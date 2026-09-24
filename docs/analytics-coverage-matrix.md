# Analytics Coverage Matrix

> Source-of-truth map for the ProjectSites.dev customer analytics experience (`/admin/analytics`).
> Maintained by the analytics loop (`65648642`). Rule: never imply an unavailable metric is zero,
> never present an estimate as exact. Verify display-vs-store, not just render-vs-endpoint.

## Architecture (verified 2026-09-23, iteration 1)

- **Primary store: D1 `visitor_events`** (first-party). Pageviews are recorded **server-side per
  serve** by `recordPageviewFromRequest` (`libs/features/visitor_events_core/service.ts:116`),
  fired `ctx.waitUntil()` from site-serving — NOT dependent on a client beacon.
- **Server-side enrichment (no client beacon needed):** that same function folds `country/city/region`
  (from `request.cf` edge geo), `ua`, and `device/browser/os + channel/utm` (`enrichVisitor(ua,
  referrer, path)`) into the event `metadata` JSON, with bot-UA filtering (`BOT_UA_RE`). So the
  device / geo / channel / referrer breakdowns are **real**, not empty-pending-beacon.
- **Client beacon (`POST /api/events`)** mirrors ONLY `conversion` / `form_start` / `form_submit`
  into `visitor_events` (`routes/analytics.ts`) — pageviews are intentionally NOT re-mirrored
  (server records them) to avoid double-count.
- **CF GraphQL `httpRequestsAdaptiveGroups`** (`services/multi_url_analytics.ts`) is **fallback-only**
  now — the prior "no traffic" bug (reading empty CF-zone data for `*.projectsites.dev` subdomains
  instead of D1) is fixed. CF-zone per-host data is only meaningful for **custom domains in a CF zone**,
  30-day retention.
- **Analytics Engine (`ANALYTICS` binding)** — ops/debug only (`services/cf_analytics.ts`), not in the
  customer dashboard; ingest gated by `ANALYTICS_INGEST_ENABLED="false"`.
- **Tenant isolation: SAFE** — `resolveOwnedSiteId` (`routes/analytics.ts:57`) + `requireOwnedSite`
  (`site_analytics/handlers.ts:52`) resolve site→org server-side from ownership; 404 (no existence
  leak) on mismatch; hostname/zone never trusted from the client.

## Coverage matrix

| Metric | Source | Plan/config | Hostname filter | Retention | Sampling | Status | UI |
|---|---|---|---|---|---|---|---|
| Pageviews | D1 visitor_events (server) | none | per site_id | D1 (unbounded) | none | ✅ live | traffic card |
| Unique sessions | D1 visitor_events (anon hash) | none | site_id | D1 | none | ✅ live | sessions card |
| Conversions (total) | D1 visitor_events (beacon) | none | site_id | D1 | none | ✅ live | conversions card |
| **Conversions by kind** (call / directions / form / …) | D1 visitor_events `json_extract($.kind)` on `conversion` events | none | site_id | D1 | none | ✅ **live (this fire)** — `getConversionKinds` (both summary paths) → `traffic.byConversionKind` → focused **`ConversionsCardComponent`** (humanized labels + bar breakdown + total; kind-less → "other"; honest "no conversions tracked yet" empty state) | `/admin/analytics` "Conversions" card |
| Top pages / paths | D1 visitor_events | none | site_id | D1 | none | ✅ live | top-pages table |
| Referrers | D1 visitor_events | none | site_id | D1 | none | ✅ live | referrer table |
| Geography (country/city/region) | D1 metadata ← `request.cf` | none | site_id | D1 | none | ✅ live | geo breakdown |
| Device / browser / OS | D1 metadata ← `enrichVisitor(ua)` | none | site_id | D1 | none | ✅ live | device breakdown |
| Channel / UTM | D1 metadata ← referrer+path | none | site_id | D1 | none | ✅ live | channel breakdown |
| Daily time series | D1 visitor_events / analytics_daily | flag `analytics_rollup_read` | site_id | D1 | none | ✅ live | line chart |
| Funnel (landing→engaged→converted) | D1 visitor_events | none | site_id | D1 | none | ✅ live | funnel widget |
| Forms / completions | D1 form_submissions | none | site_id | D1 | none | ✅ live | forms tab |
| Period-over-period deltas | D1 visitor_events | none | site_id | D1 | none | ✅ live | comparison |
| **Delivery & performance (status codes / cache hit-miss / bandwidth)** | CF GraphQL `httpRequestsAdaptiveGroups` (`edgeResponseStatus` + `cacheStatus` + `sum{edgeResponseBytes}`) | resolved via the shared zone for subdomains; API lookup for custom domains | per `clientRequestHTTPHost` | ~30 days | adaptive sampled | ✅ **LIVE for ALL sites (decoupled this fire)** — a SEPARATE `loadHostDelivery`/`resolveDeliveryZone` path resolves the shared projectsites.dev zone for `*.projectsites.dev` subdomains, so edge delivery works for the subdomain MAJORITY — **without flipping the audience numbers to CF** (audience stays first-party D1; `resolveDeliveryZone` is independent of the audience `resolveZoneForHostname`, which still returns null for subdomains → `resolved_zone:false` → "ProjectSites analytics" labeling preserved). `envelope.delivery` → `DeliveryCardComponent` (status classes + WORD, cache hit-ratio, bandwidth, top error codes, ≥5% 4xx/5xx warning). **Prod-verified live** on harborline: 30d = 31,610 req · 2xx 27588 / 5xx 3145 / 3xx 828 / 4xx 49 · cache 32% · 1.16 GB, while audience `resolved_zone:[false]` + pageviews first-party. | `/admin/analytics` "Delivery & performance" card |
| **Core Web Vitals (LCP/INP/CLS + per-page)** | first-party RUM → `web_vital` events in D1 | none (no CF plan) | per site_id (+ per `path`) | D1 | none (all sessions) | ✅ **COMPLETE + per-path** — site p75 card PLUS a **"Slowest pages · LCP p75"** drilldown (`getWebVitalsSummary` buckets LCP by `path`, ranks worst-first, top 5, past a **5-sample floor**); honest ("measuring"/null never a fake 0; a page needs ≥5 samples to be ranked) | `/admin/analytics` "Core Web Vitals" card + slowest-pages table |
| **Security (WAF/bot/challenges)** | CF GraphQL `firewallEventsAdaptiveGroups` | **plan lacks access** | per hostname | plan-dependent | — | ❌ **BLOCKED — verified 2026-09-24** by an introspection probe against our zone: returns authz *"zone does not have access to the path"*. Our plan has no firewall-analytics entitlement, so this is NOT buildable without a plan upgrade — a security card would be a permanent placeholder (which the doctrine forbids). | — (honestly absent) |
| **CSV export (dashboard)** | (UI) client-side over fetched data | none | — | — | — | ✅ **COMPLETE** — `buildAnalyticsCsv` exports summary + top-pages/countries/referrers + the D1 device/channel/conversions/CWV breakdowns + **now the CF edge DELIVERY breakdown** (status classes, cache hit/miss/ratio, edge bandwidth — emitted ONLY when `has_data`, never fabricated zeros), with the ACCURATE source label; formula-injection-safe via the shared `csvEscape`. Matches the dashboard cards. | `/admin/analytics` Export CSV |
| Source + freshness labels in UI | (UI) | none | — | — | — | ✅ **honest per-provenance (this fire)** — the "Source:" badge (`dataLabel`/`dataTooltip`) was hardcoding **"Cloudflare Edge" / "Cloudflare GraphQL" for ALL real data**, a source-conflation lie for every `*.projectsites.dev` subdomain + the D1 fallback (their numbers are first-party `visitor_events`, not CF's). Now routed through the authoritative `trafficSource` signal: first-party → **"ProjectSites analytics"** (tooltip: measured on-site, per serve, incl. true session bounce), genuine CF-zone custom domain → **"Cloudflare Edge"**. "Total requests" KPI sublabel de-jargoned ("on-site beacon" → "recorded on your site"). Freshness "as of" already present. | analytics header badge + chart caption + footer |

## Highest-impact gap (corrected — NOT "beacon not deployed")

**Real-user-experience / Core Web Vitals is the biggest genuine coverage gap** and the prompt
emphasizes it. There is NO LCP/INP/CLS data today. A CNAME alone does not collect browser metrics —
requires either the **Cloudflare Web Analytics beacon** deployed + associated per site, or a small
first-party RUM beacon (`web-vitals` → `POST /api/events` as a new `web_vital` event type into
visitor_events). Size: **M–L** (instrument + ingest + aggregate percentiles + UI). Must gate the UI
on "beacon confirmed deployed for THIS site" — never show 0/empty as if measured.

Runner-up (smaller, honesty-aligned): audit `/admin/analytics` UI for **explicit source + freshness
labels + "not available for subdomains" vs "no data yet"** states (prompt: never imply unavailable=zero).
Good first implementable slice if CWV instrumentation is too large for one fire.

## Deferred / not-a-gap
- Device/geo/channel are NOT beacon-blocked (server-enriched) — do not chase a beacon backfill for them.
- Analytics Engine customer dashboards — ingest disabled; out of scope unless enabled.

## Next increment (handoff)
**Ingest + client beacon are DONE** (2026-09-23). Ingest: `web_vital` accepted at `/api/events` → mirrored to
`visitor_events` (metadata `{metric,value}`, validated metric∈{LCP,INP,CLS,FCP,TTFB} + value≥0, tenant-scoped
via `site.org_id`). Beacon: `app.js` `initWebVitals()` field-measures LCP/INP/CLS (final LCP frozen at first
interaction, CLS session-window max, INP p98-longest-interaction) and beacons each — ONLY when its observer
attached AND a real value exists (LCP/CLS/INP are Chromium-only APIs; an unmeasured vital is OMITTED, never a
fake 0) — on page hide via `track()`'s keepalive fetch. Covered by 15 `app_js_web_vitals` contract specs + the
52 ingest specs.
**p75 aggregation is DONE** (2026-09-23): `getWebVitalsSummary` (`visitor_events_core/service.ts`) reads the
`web_vital` rows directly (bounded to 50k, works in BOTH the live + rollup summary paths) and computes nearest-rank
**p75 per metric** (LCP/INP integer ms, CLS 3-decimal) via the pure `percentile()` helper, into a `webVitals` block
on `TrafficSummarySchema` (`{lcp,inp,cls}`, each `{p75,samples}` or **null** when no samples — never a fabricated 0;
defaulted for back-compat). Surfaced on the analytics summary API (`traffic.webVitals`) + the frontend `SiteTrafficSummary`
contract. Covered by a p75 aggregation test + `percentile` unit tests (299 analytics/visitor_events specs green).
**The UI card is DONE** (2026-09-23) — the **CWV arc is COMPLETE end-to-end**: beacon → ingest → p75 aggregation →
honest `WebVitalsCardComponent` (focused standalone) in the analytics "Real-user experience" card. Per metric it shows
p75 (LCP/INP in ms→s, CLS unitless) + the Google rating WORD (Good ≤2.5s/≤200ms/≤0.1 · Needs work ≤4s/≤500ms/≤0.25 ·
Poor) + sample count; a null metric renders "Measuring — no samples yet" (NEVER a fabricated 0), and an all-empty card
shows a "no field data yet" note. Labelled Chromium-only field data over the window. Covered by 10 `web_vitals_card`
specs. Verified live (prior fire) that `traffic.webVitals` returns real data (lcp p75=2372/1 sample, cls p75=0/1 sample,
inp=null → honesty contract visibly correct).
**Per-path CWV is DONE** (2026-09-24): `getWebVitalsSummary` now also buckets LCP by `path` from the same query and
returns `webVitals.slowestPages` (top-5 worst-first, past a **5-sample floor** so a p75 isn't ranked off 1–2 hits);
the card renders a "Slowest pages · LCP p75" table (path + p75 + rating word + samples) when any page qualifies, hidden
otherwise. So the **CWV area is fully built out** (site + per-page). Covered by a per-path service spec + 2 card specs.
**Conversions-by-kind is DONE** (2026-09-24): `getConversionKinds` (`visitor_events_core/service.ts`, both summary
paths) groups `conversion` events by `json_extract(metadata,'$.kind')` → `traffic.byConversionKind`; a focused
`ConversionsCardComponent` renders humanized labels (Phone calls / Directions / Form submissions / …) + a bar
breakdown + total, with an honest "no conversions tracked yet" empty state (kind-less conversions bucket as "other",
never dropped). This is the highest-impact UNIVERSAL (D1, all sites) outcome metric — the ROI a small-business owner
cares about. Covered by a service spec + 5 card specs.
**Security is BLOCKED by our plan** (introspection done 2026-09-24): a probe of `firewallEventsAdaptiveGroups`
against our zone returns authz *"zone does not have access to the path"* — our plan has no firewall-analytics
entitlement. So Security is NOT buildable without a plan upgrade (a card would be a permanent placeholder). Removed
from the buildable-next list. **CSV export is DONE + fixed** (this fire): `buildAnalyticsCsv` (tested pure fn) exports
the D1 device/channel/conversions/CWV breakdowns the prior export dropped, with the ACCURATE source (was a hardcoded
"cloudflare_graphql" lie for subdomains); the shared `csvEscape` was hardened with a CWE-1236 formula-injection guard
(benefits the Data-grid export too) and the dead `csvCell` removed.
**Usability honesty sweep is DONE** (2026-09-24): the "Source:" badge no longer conflates first-party D1 data with
Cloudflare. `dataLabel`/`dataTooltip` now branch on the authoritative `trafficSource` signal — first-party (every
subdomain + the D1 fallback) reads **"ProjectSites analytics"** (measured on-site, per serve, with true session
bounce), and only a genuine CF-zone custom domain reads **"Cloudflare Edge"** / "Cloudflare GraphQL". The "Total
requests" KPI sublabel was de-jargoned ("on-site beacon" → "recorded on your site"). +2 focused specs assert the
beacon-vs-edge badge; the beacon-KPI-sublabel spec was updated. tsc 0 · Karma 1936/1936 · AOT 0 · eslint 0-errors.

**Delivery & performance card is SHIPPED + honest** (2026-09-24): `buildDeliverySummary` folds status/cache/bandwidth
into the existing per-host authed CF query (zero extra requests) → `envelope.delivery` → `DeliveryCardComponent`. DATA
verified real via direct probe (harborline 74% 200 / 9% 504 / 4% cache-hit / 1.16 GB). Honest states via a `zone_resolved`
flag: real data when the zone resolves, "no requests yet" when resolved+empty, "not available (shared zone)" when NOT
resolved — NEVER "no traffic" for a site that has visitors. 8 worker + 8 card specs; 257 analytics tests still green.

**Delivery DECOUPLED → now LIVE for the subdomain majority** (2026-09-24): a SEPARATE `loadHostDelivery` +
`resolveDeliveryZone` path resolves the shared projectsites.dev zone for `*.projectsites.dev` subdomains (one extra
batched query per host, cached), so edge delivery works for every site — while the audience `resolveZoneForHostname`
still returns null for subdomains, keeping pageviews first-party D1 + "ProjectSites analytics" labeling. Last fire's
delivery additions to `loadHostAggregate` (which would've flipped audience) were REVERTED. Prod-verified: harborline
30d = 31,610 req · 2xx 27588 / 5xx 3145 · cache 32% · 1.16 GB, audience `resolved_zone:false` + pageviews 1676 first-party.
10 worker delivery specs (incl. `resolveDeliveryZone` subdomain→shared-zone) + 265 analytics tests green; frontend
unchanged (same `envelope.delivery` shape). The CF "subdomains-are-empty" assumption is confirmed OUTDATED.

**CSV export COMPLETED + honest TZ label** (2026-09-24): `buildAnalyticsCsv` now includes the CF edge delivery
breakdown (status classes / cache hit-miss-ratio / bandwidth), emitted only when `has_data` (never fabricated zeros),
so the export matches the dashboard. Added an honest **"dates in UTC"** label to the day-series chart caption (the
buckets are UTC-aggregated; the "as of" is browser-local). Frontend-only; +2 CSV specs; Karma 1952/1952. **Latency
percentiles are PLAN-BLOCKED** (verified this fire): `edgeTimeToFirstByteMs`/`edgeDnsResponseTimeMs` return authz
"zone does not have access", and origin timings return `-1` (Worker-served sites have no origin fetch) — so latency is
OFF the buildable list (would be a placeholder), same class as Security/WAF.

NEXT highest-value gaps (Security + latency plan-blocked; delivery + CSV now complete): (1) **Custom date range (arbitrary
start/end)** — the D1 endpoints already accept an arbitrary `windowDays` (`parseWindowDays`), but the CF/`multi-url`
envelope is enum-only (`RANGE_TO_DAYS`); unify by giving `loadMultiUrlAnalytics` a `days` override + a frontend range
picker (bound 1–90d for CF retention, honest clamp note). Timezone display is now labeled (UTC); full tz-aware bucketing
is a later step. (2) **Migrate bespoke CSV exports** (events-table/audit/forms/super-admin) onto the shared
`csvEscape`/`downloadText`.
