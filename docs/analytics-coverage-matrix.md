# Analytics Coverage Matrix

> Source-of-truth map for the ProjectSites.dev customer analytics experience (`/admin/analytics`).
> Maintained by the analytics loop (`65648642`). Rule: never imply an unavailable metric is zero,
> never present an estimate as exact. Verify display-vs-store, not just render-vs-endpoint.

## Existing-card plateau + first-party AUGMENT tier (updated 2026-09-25)

The EXISTING analytics cards are verified-complete — a 4-agent scan's ~24 "gaps" were all already-shipped,
honestly-blocked, or deliberately-dropped (verified against source; scans mis-report by not tracing the wrapper
chain). **BUT the plateau is on the existing CARDS, not the metric space.** The prompt's "AUGMENT with advanced
first-party metrics" clause still had genuine unbuilt metrics: **new-vs-returning shipped 2026-09-25** (row below)
— the beacon had NO returning-visitor detection. Still-unbuilt first-party AUGMENTs (verified not-measured):
**session duration** + **entry/exit pages** (both need a beacon session boundary), and the beacon `click`/`custom`
event types. So existing cards are done, but the augment tier has runway. Do NOT rebuild the already-shipped set
(the scans mis-report them because they don't trace the wrapper chain):

- **First-party cards ARE wired** (WebVitals/Engagement/Scroll/Network/NavTiming/JS-errors/OutboundClicks/
  Conversions/FormFunnel/device-browser-os/hourly/campaign): `getTrafficSummary` (`visitor_events_core/service.ts:1167`)
  wraps ALL 12 aggregators internally; `site_analytics/service.ts:547` calls `getTrafficSummary`. A grep for the
  individual `get*Summary` names in `site_analytics` returns 0 — that's the wrapper, NOT a missing wire.
- **CF-edge delivery is complete**: `DeliverySummary.top_statuses` carries `{status,count,bytes,visits}`
  (`multi_url_analytics.ts:75`); `cache` carries `hit_bytes/miss_bytes/uncacheable_bytes`; `protocols` (h2/h3)
  + `tls` are queried, parsed, AND rendered in `delivery-card` (lines 303-304). Content-type + method too.
- **Referrer/channel attribution** = `channel-breakdown.component.ts` (direct/organic/social/paid/email/referral).
- **Tenant isolation is tested**: all analytics endpoints share `requireOwnedSite` (`handlers.ts:55-62`,
  cross-org → 404); `site_analytics_handlers.test.ts:78` proves "404 when the site belongs to another org".
- **Honestly-blocked (never build)**: WAF/`firewallEventsAdaptiveGroups`, botScore, edge TTFB — no plan entitlement.

**Doctrine (corrected 2026-09-25):** "plateau on existing cards" is NOT "plateau on the metric space." Before
declaring analytics done + reallocating, check the NOT-MEASURED first-party AUGMENT tier (session duration,
entry/exit pages, click-through — new-vs-returning is now done) — the prompt explicitly invites these AND they
need a beacon change, so a grep of the existing aggregators misses them (that's what caused 3 premature
"plateau" fires this session). VERIFY a scanned gap against the wrapper chain before building (agents over-report
already-shipped cards). Reallocate to the DATA loop's un-plateaued adapters (Hyperdrive/DO still PLANNED) only
once the augment tier is genuinely exhausted. A CF plan upgrade is the only path to the WAF/botScore/TTFB datasets.

## Architecture (verified 2026-09-23, iteration 1)

- **Primary store: D1 `visitor_events`** (first-party). Pageviews are recorded **server-side per
  serve** by `recordPageviewFromRequest` (`libs/features/visitor_events_core/service.ts:116`),
  fired `ctx.waitUntil()` from site-serving — NOT dependent on a client beacon.
- **Server-side enrichment (no client beacon needed):** that same function folds `country/city/region`
  (from `request.cf` edge geo), `ua`, and `device/browser/os + channel/utm` (`enrichVisitor(ua,
  referrer, path)`) into the event `metadata` JSON, with bot-UA filtering (`BOT_UA_RE`). So the
  device / geo / channel / referrer breakdowns are **real**, not empty-pending-beacon.
- **Client beacon (`POST /api/events`)** mirrors `conversion` / `form_start` / `form_submit` /
  `web_vital` / `js_error` / **`page_engagement`** / **`scroll_depth`** / **`network_quality`** / **`nav_timing`** into
  `visitor_events` (`routes/analytics.ts`) — pageviews are intentionally NOT re-mirrored (server
  records them) to avoid double-count.
- **Time-on-page / engagement (✅ DONE end-to-end 2026-09-25):** `app.js` `initEngagement()`
  measures dwell (interactive → first hide) and beacons it once as a `page_engagement` event
  (`{duration_ms, href}`), client-bounded **1s–30min** (drops bounce/bot noise + abandoned open
  tabs) → ingest `EVENT_TYPES` accepts it → mirrored to `visitor_events` (server-re-guarded
  `{duration_ms}`, finite 0–30min) → **`getEngagementSummary`** computes the site-wide + per-page
  **MEDIAN** dwell (median, not mean — outlier-resistant; per-page past the 5-sample floor, longest
  first; fail-soft to a null-median empty) folded into BOTH traffic-summary paths (live + rollup) →
  **`EngagementCard`** ("Time on page") on `/admin/analytics` shows the median (formatted 8s / 1m 20s)
  + a **"How long visits lasted" DISTRIBUTION** (2026-09-25 — `distribution.{s10,s30,s60,s180}`, the % of
  visits past ≥10s/30s/1m/3m, the dwell analogue of the scroll reach funnel; the spread the median hides)
  + most-engaging pages, or **"Measuring…"** when 0 samples (never a fabricated 0 — the beacon runs on
  every page; the distribution block hides rather than showing 0%s). First-party signal CF's plan has NO dataset for. Tenant-scoped by the summary owner gate
  + `getEngagementSummary`'s bound `site_id`. +17 tests (7 instrument + 5 aggregate:
  median/per-page/floor/fail-soft/tenant + 4 card + formatDwell). Verified: worker tsc+jest, app tsc,
  Karma, build:prod.
- **Scroll depth / content consumption (✅ DONE end-to-end 2026-09-25):** `app.js` `initScrollDepth()`
  tracks the **max % of page height** a visit reaches (initial above-the-fold coverage, then the
  deepest scroll point) and beacons it once on `visibilitychange:hidden`/`pagehide` as a `scroll_depth`
  event (`{percent, href}`, client-clamped **0–100**; a viewport-fitting page = 100 "fully seen"; an
  unmeasurable page is skipped, never a fabricated sample) → ingest `EVENT_TYPES` + `VisitorEventTypeSchema`
  + `VISITOR_MIRROR_TYPES` accept it → mirrored to `visitor_events` (server-re-guarded finite 0–100
  `{percent}`) → **`getScrollDepthSummary`** computes the site-wide **MEDIAN** max-depth (median, not
  mean — depth is bimodal bounce-vs-read), a **monotonic reach funnel** (count of visits reaching
  ≥25/50/75/100%), and the deepest-read pages (per-page past the 5-sample floor, each with its completion
  rate), fail-soft to a null-median empty, folded into BOTH traffic-summary paths (live + rollup) →
  **`ScrollDepthCard`** ("Scroll depth") on `/admin/analytics` shows the median headline, the reach funnel
  as bars, and most-read pages, or **"Measuring…"** when 0 samples (never a fabricated 0 — the beacon runs
  on every scrollable page). First-party content-consumption signal CF's plan has NO dataset for.
  Tenant-scoped by the summary owner gate + `getScrollDepthSummary`'s bound `site_id`. +16 tests (7
  instrument beacon-contract + 6 aggregate: median+funnel/0–100-clamp/per-page-completion+floor/empty/
  fail-soft/tenant + 3 card: funnel-rates+rows/measuring-null/undefined-safe). Verified: worker tsc+jest
  (41/41 custom_window), app tsc, card Karma 3/3 (template AOT-compiled).
- **JS-error site-health (✅ DONE end-to-end 2026-09-25):** `app.js` `initErrorBeacon()` turns an
  uncaught error / unhandled rejection into a `js_error` event (`{message, source, line}`, deduped
  once/session · capped ≤5 · message truncated 300 · resource-404s skipped · self-guarded) → ingest
  `EVENT_TYPES` accepts it → mirrored to `visitor_events` with server-re-truncated metadata →
  **`getJsErrorSummary`** groups it by message (top-8 display, true `total`, sample path; fail-soft to
  the empty clean summary) folded into BOTH traffic-summary paths (live + rollup) → **`ScriptErrorsCard`**
  on `/admin/analytics` shows the count + top messages, or a green **"running clean"** (a REAL 0 — the
  beacon runs on every page — never "not measured"). The first-party site-health signal CF's plan has
  NO dataset for. Tenant-scoped by the summary's owner gate + the `getJsErrorSummary` bound `site_id`.
  +14 tests (7 instrument: app.js contract + schema; 5 aggregate: group/total/top-8/fail-soft/tenant;
  4 card: rows/singular/clean/undefined-safe). Verified: worker tsc+jest, app tsc, Karma, build:prod.

- **New vs returning visitors (✅ DONE end-to-end 2026-09-25):** the first genuinely-new AUGMENT metric after
  the existing cards plateaued — CF has NO returning-visitor dataset. `app.js` sets a cookieless `localStorage`
  `ps_v` first-seen marker and sends `nv` on the `page_engagement` beacon (1 = the browser's first-ever visit,
  0 = seen before, omitted when storage is unavailable → "unknown"). Ingest mirrors `nv` into `page_engagement`
  metadata (1/0 only) → **`getNewVsReturningSummary`** folds `GROUP BY json_extract(metadata,'$.nv')` into
  `{newVisits, returningVisits, unknownVisits}` — **unknown is surfaced separately, NEVER folded into returning**
  (a `Number(null)===0` trap the test guards) → owner-scoped route `GET /api/sites/:siteId/analytics/visitors`
  (`requireOwnedSite` tenant gate) → **`VisitorTypeCardComponent`** ("New vs returning") shows the split
  (denominator = new+returning), an "unknown" footnote when >0, and the HONEST disclaimer: browser-scoped — a new
  device or cleared storage counts as new (no cookie, no PII, a single timestamp). +4 Jest (fold incl.
  null→unknown · fail-soft · tenant 404 · 200 owned) + Karma card spec. Worker deployed (`eb2953b4`),
  `/analytics/visitors` prod 401-gated, beacon `/app.js` carries the `nv` logic. Data accrues from first serve.
- **CF GraphQL `httpRequestsAdaptiveGroups`** (`services/multi_url_analytics.ts`) is **fallback-only**
  now — the prior "no traffic" bug (reading empty CF-zone data for `*.projectsites.dev` subdomains
  instead of D1) is fixed. CF-zone per-host data is only meaningful for **custom domains in a CF zone**,
  30-day retention.
- **Analytics Engine (`ANALYTICS` binding)** — ops/debug only (`services/cf_analytics.ts`), not in the
  customer dashboard; ingest gated by `ANALYTICS_INGEST_ENABLED="false"`.
- **Tenant isolation: SAFE** — `resolveOwnedSiteId` (`routes/analytics.ts:57`) + `requireOwnedSite`
  (`site_analytics/handlers.ts:52`) resolve site→org server-side from ownership; 404 (no existence
  leak) on mismatch; hostname/zone never trusted from the client.

## Cloudflare entitlement map — DEFINITIVE (GraphQL introspection + per-field probe, 2026-09-24)

Probed our real zone (`9ceaa211750dd31899fd5d1bf8d1ec46`) field-by-field against
`ZoneHttpRequestsAdaptiveGroups` — the ONE dataset that works per-`clientRequestHTTPHost`
for `*.projectsites.dev` subdomains (the majority). This replaces guesswork: a field's
presence in the schema ≠ entitlement; one gated field nulls the whole query, so each was
probed alone. Method: `viewer.zones(zoneTag).httpRequestsAdaptiveGroups`, `authz` error =
gated.

- **✅ AVAILABLE on our (Free) plan — buildable per-subdomain, no upgrade:** `count`
  (edge requests) · `sum.visits` (CF visits) · `sum.edgeResponseBytes/edgeRequestBytes`
  (bandwidth) · `clientCountryName` (geo) · `clientDeviceType` + `userAgentBrowser` +
  `userAgentOS` (edge-measured, covers non-JS) · `edgeResponseContentTypeName` (content
  served) · `clientRequestHTTPProtocol` (HTTP/1.1·2·3) · `clientSSLProtocol` (TLS version)
  · `clientRequestHTTPMethodName` · `edgeResponseStatus` + `cacheStatus` · `coloCode` (CF
  data center) · `verifiedBotCategory` (Googlebot/Bingbot crawl visibility — SEO) ·
  `securityAction`.
- **❌ GATED (paid add-on — a card would be a permanent placeholder, forbidden):**
  `edgeTimeToFirstByteMs`/`edgeDnsResponseTimeMs` avg+quantiles (**latency** — Pro+) ·
  `botScore`/`botManagementDecision` (**Bot Management** add-on) · `wafAttackScore*`/
  (WAF Attack Score — Biz/Ent) · `clientRefererHost`/`clientRequestReferer` (edge referer)
  · `clientAsn`/`clientASNDescription` (network/ISP) · the whole `firewallEventsAdaptiveGroups`
  dataset. Latency + Security/WAF stay honestly absent (never faked).
- **RUM (Cloudflare Web Analytics)** — **INTEGRATED AS A SERVER SOURCE (2026-09-25, this fire).**
  The prior "we don't deploy the CF beacon → DEFERRED, would double-count" note was based on a
  FALSE premise: a LIVE per-host probe of `rumPageloadEventsAdaptiveGroups` +
  `rumWebVitalsEventsAdaptiveGroups` + `rumPerformanceEventsAdaptiveGroups` returns REAL data for
  our `*.projectsites.dev` subdomains (e.g. `franklin-barbecue` 1126 web-vital samples;
  `berkeley-bowl-2` 20 pageloads). Cloudflare **auto-injects** its Web Analytics beacon at the
  zone level, so every subdomain on the shared `projectsites.dev` zone IS collecting CF RUM — we
  never had to add a beacon. It is NOT harmful double-counting: CF RUM is an **independent second
  source**, always labeled `source:'cloudflare_rum'` + `sampled:true`, shown alongside (never summed
  with) the exact first-party numbers — a cross-check, not a replacement.
  - Server: `services/cloudflare_rum.ts` (`getCloudflareRumSummary`) + route
    `GET /api/sites/:siteId/cloudflare-rum` (`routes/cloudflare_rum.ts`). ONE GraphQL request per
    host; µs→ms conversion (raw 1_988_000 → 1988ms); CLS unitless; Google-band ratings; honest
    nulls on 0 samples; fail-soft `available:false` on CF error / no creds.
  - **Tenant-safe:** site resolved by id-or-slug AND `org_id = caller` (non-owned → 404, non-leak);
    the host is resolved SERVER-SIDE (primary hostname → else `{slug}.projectsites.dev`) — a client
    host is NEVER trusted. Live-proven: unauth 401 · non-owned `franklin-barbecue` **404 (cross-tenant
    isolation)** · owned `berkeley-bowl-2` **200** (LCP 1248ms good, TTFB 1ms, pageLoad 1917ms, honest
    samples). 16 Jest (service µs→ms/CLS/ratings/honest-empty/fail-soft + route auth/tenant/host/clamp).
  - **NEW capability unlocked — client-measured TTFB.** RUM `responseTimeP75` gives per-host TTFB,
    distinct from the still-BLOCKED *edge*-latency `edgeTimeToFirstByteMs` (httpRequests, Pro+). So
    "latency" is no longer fully absent: client-side timing (RUM + our beacon) is available; edge-side
    timing stays plan-blocked.
  - **UI DONE (2026-09-25):** `CloudflareRumCardComponent` ships in `/admin/analytics` beside the
    first-party CWV card — a self-fetching card (one request per host, token-guarded vs stale
    site-switch) rendering the CWV + Navigation-Timing tiles with server-provided ratings, always
    labelled "Cloudflare Web Analytics · sampled", honest per-metric "no samples yet" (never a 0),
    and an honest note when `available:false`. Bound to `state.selectedSite()?.id` (a lookup key
    only — the route re-resolves the owned host + org server-side). +9 Karma. Frontend chunk
    `chunk-DVB44EQP.js` prod-verified live (200 + `an-cf-rum` marker). The concurrent drilldown
    session had already landed its filter UI + moved on, so no collision.
  - The glossary still states first-party speed metrics come from the ProjectSites `app.js` beacon;
    the CF-RUM card will be labeled as the SEPARATE Cloudflare-measured source so the two never blur.
- **SHIPPED from this map:** (2026-09-24) HTTP protocol / TLS version / content-type /
  method breakdowns → `envelope.delivery.{protocols,tls,content_types,methods}` →
  `DeliveryCardComponent` edge-breakdown grid (same per-host query, zero extra requests);
  **(2026-09-25) `verifiedBotCategory`** → `envelope.delivery.verified_bots` → a dedicated
  "Verified bots · search crawlers & monitors" section — Cloudflare-verified bot traffic by
  category (empty human bucket excluded server-side; hides when none seen; explicitly NOT a
  bot-management score). Prod-verified real data. +1 worker Jest + 2 Karma.
  **NEXT from this map (exact, buildable):** `sum.visits`/edge-requests as explicit CF metrics ·
  `coloCode` edge-network view · edge geo/device to complement first-party.
- **First-party page-load timing SHIPPED (2026-09-25):** since CF gates edge latency, we now measure it
  OURSELVES — `app.js` beacons **FCP** (paint observer) + **TTFB** (Navigation Timing `responseStart`);
  `getWebVitalsSummary` aggregates their p75 + good/needs/poor distribution (thresholds FCP 1800/3000,
  TTFB 800/1800), surfaced in a "Page load speed" section of the CWV card. Covers EVERY browser (unlike
  Chromium-only CWV). Beacon prod-verified live; `traffic.webVitals.{fcp,ttfb}` keys live (null until
  re-served sites accrue samples — honest, hides the section meanwhile). This is the app.js-augmentation lane.
- **First-party scroll depth SHIPPED (2026-09-25):** `app.js` `initScrollDepth()` → `scroll_depth` beacon
  → `getScrollDepthSummary` (median max-depth + 25/50/75/100 reach funnel + per-page completion) →
  `ScrollDepthCard`. Content-consumption signal CF's plan has no dataset for. See the full bullet above.
- **First-party network quality SHIPPED (2026-09-25):** `app.js` `initNetworkQuality()` reads
  `navigator.connection` once on load → `network_quality` beacon (`{effective_type, downlink, rtt,
  save_data}`) → mirrored to `visitor_events` (server re-guarded: known effectiveType class + finite
  non-negative downlink/rtt + boolean save_data) → **`getNetworkQualitySummary`** (distribution across
  slow-2g/2g/3g/4g worst-first + MEDIAN downlink Mbps + MEDIAN rtt ms + save-data %) folded into BOTH
  summary paths → **`NetworkQualityCard`** ("Visitor connection") on `/admin/analytics`. HONESTY:
  `navigator.connection` is **Chromium-only** (Chrome/Edge/Android) — the beacon sends nothing on
  Safari/Firefox (never a fabricated sample) and the card LABELS the split as a Chromium sample, not
  "all visitors"; medians null → "measuring…", never a fake 0. Tenant-scoped by the summary owner gate
  + `getNetworkQualitySummary`'s bound `site_id`. +11 tests (6 beacon-contract + 5 aggregate:
  distribution+medians+save-data / drop-unknown-class+non-finite / empty / fail-soft / tenant + 4 card).
  Verified: worker tsc+jest (46/46 custom_window), app tsc, card Karma 4/4.
- **First-party page-load waterfall SHIPPED (2026-09-25):** `app.js` `initNavTiming()` reads the
  PerformanceNavigationTiming entry after load → `nav_timing` beacon (`{dns, connect, ttfb, transfer,
  dom, total}`) → mirrored to `visitor_events` (`navPhase` re-guard: finite 0–600s, honest 0 kept) →
  **`getNavTimingSummary`** (site-wide MEDIAN per phase) folded into BOTH summary paths →
  **`NavTimingCard`** ("Page load breakdown") on `/admin/analytics` — a median-total headline + per-phase
  bars scaled to the largest phase. HONESTY: each phase is an INDEPENDENT median (they don't sum to the
  total — the card SAYS so, never a strict decomposition); a null phase is omitted (never a fake 0); a
  real 0 (cached DNS / reused connection) is kept; a null total → "measuring…". The edge-latency
  breakdown CF's plan blocks, measured first-party in every browser. Tenant-scoped by the summary owner
  gate + `getNavTimingSummary`'s bound `site_id`. +11 tests (6 beacon-contract + 5 aggregate:
  per-phase-medians / keeps-honest-0 / empty / fail-soft / tenant + 5 card). Verified: worker tsc+jest
  (51/51 custom_window), app tsc, card Karma 5/5. **This completes the prompt's advanced-first-party
  list** (Navigation Timing · network quality · scroll · time-on-page · outbound clicks · JS-error — all shipped).
  **(2026-09-25) Per-page SLOWEST PAGES** — `getNavTimingSummary` now also returns `byPage[]` (each page's
  median total load + median TTFB, floor-gated ≥5 samples, worst-first, top 8; same nav_timing query, no new
  scan) → the card's "Slowest pages · median load · server wait" list. An owner sees WHICH page is slow AND
  whether it's slow off the SERVER (high TTFB) vs the client — the actionable drill the site-wide median hid.
  Per-page TTFB chip shown only when non-null (never a fake 0); block hidden when byPage empty. Mirrors the
  CWV slowest-pages pattern. +3 tests; worker `c328ef00`, chunk `chunk-ASRSJQJA.js`. Prod-verified: byPage
  shape flows + tenant-safe (404/401); populated path unit-tested (the E2E org has 0 nav_timing samples, so
  prod shows honest-empty byPage — a real-traffic owned site populates it).
- **Public share report enriched SHIPPED (2026-09-25):** `/shared/analytics/:token` was thin
  (pageviews/visits/contacts/forms/newsletter/donations). The public endpoint ALREADY returns the
  full traffic summary (`getSiteAnalyticsSummary` → `TrafficSummarySchema`), so this was
  FRONTEND-ONLY — `public-analytics.component.ts` now renders three owner-shareable tiles, each ONLY
  when the metric has real samples + a non-null median (never a fabricated 0): **Avg. time on page**
  (`traffic.engagement.medianMs`), **Median scroll depth** (`traffic.scrollDepth.medianPercent`),
  **Median page load** (`traffic.navTiming.total`). Network quality + the full nav waterfall are
  intentionally NOT on the public report (developer-facing / Chromium-only caveat). Tenant resolved
  from the HMAC share token server-side (unchanged — the token IS the capability). +2 Karma (renders
  when sampled / omits when 0 samples). Verified: app tsc, Karma 5/5, deployed chunk live on prod.
- **Visitor-funnel "Deeply engaged" stage SHIPPED (2026-09-25):** the per-site visitor funnel
  (`getVisitorFunnel` → `/api/sites/:siteId/analytics/funnel`) now surfaces a **"Deeply engaged
  (read 50%+)"** stage between Engaged and Converted, consuming the live `scroll_depth` data. The
  per-session GROUP BY computes MAX scroll % + a has-scroll flag; deeply-engaged = an ENGAGED session
  (2+ pages) that ALSO scrolled ≥50% — a guaranteed SUBSET of Engaged, so the funnel stays MONOTONIC
  (the frontend's drop-off % never goes negative). HONESTY: the stage is OMITTED entirely when the
  site has zero scroll_depth samples (a "0 deeply engaged" would misread as "nobody read deeply" vs
  "not measured yet"). `FunnelStageSchema.key` gains `deeply_engaged`; the frontend renders it
  automatically (generic stage list). +2 Jest (inserts-when-measured+monotonic / omits-when-no-samples);
  the first-party metrics now propagate to BOTH the public report AND the funnel. Worker tsc+jest clean.
- **Top outbound/contact links SHIPPED (2026-09-25):** outbound-link clicks were collected as
  `conversion` events but the DESTINATION was dropped at the mirror (only kind/section/channel
  stored). Now the mirror persists the click `href` — SERVER-normalized (`normalizeClickHref`:
  tel:/mailto:/sms: kept whole; http(s) → origin+pathname with query+fragment stripped so tracking
  params are never stored; relative/#/js/CTA-buttons dropped; length-capped) — and
  **`getOutboundClicksSummary`** groups by href → top-8 destinations (kind + count) + a total,
  folded into both summary paths. **`OutboundLinksCardComponent`** ("Top links clicked") renders it
  beside Conversions (the WHICH-LINKS companion to the by-category counts), scheme stripped for
  display, honest empty when none. These are the owner's OWN links, not visitor PII. +9 Jest
  (5 aggregate + 4 normalize) + 4 Karma. Worker tsc+jest; app tsc; card Karma 4/4.
- **Public report Cloudflare RUM SHIPPED (2026-09-25):** the shared `/shared/analytics/:token`
  report now also shows **Cloudflare-measured** performance — an INDEPENDENT second source beside the
  first-party numbers. Server: `getCloudflareRumForSite(env, siteId, days)` (site_analytics service)
  resolves the OWNED host from the site's OWN records (primary custom hostname → else
  `{slug}.projectsites.dev`) from the site id in the verified HMAC share grant — never a client value;
  fail-soft null on no-site/CF-error. The handler adds a sibling `cloudflareRum` field (NOT inside the
  Zod summary → no schema churn). Frontend: two tiles when CF has real samples — **"Page speed ·
  Cloudflare"** (independent `cwvOverallRating` verdict) + **"Server response · Cloudflare"** (TTFB —
  NEW; the first-party report shows page-load but not TTFB); labelled "· Cloudflare" so sources never
  blur; omitted (never a fabricated 0/verdict) when absent. +3 Jest (host resolution slug/custom +
  fail-soft) + 2 Karma (tiles render + honest-omit). Worker `9cc0e6b4`; public chunk `chunk-N3FLJGID.js`
  live; public route live (invalid token → 404). **Wire-through gap CLOSED (2026-09-25):** a route-level
  Hono `app.request` test now mints a real HMAC token → asserts the assembled `GET /api/public/analytics/:token`
  envelope carries `{ summary, cloudflareRum, expiresAt }` — `cloudflareRum` is a SIBLING (never nested in the
  Zod summary), populated for the owned host resolved SERVER-SIDE from the slug, µs→ms flowing through — AND a
  bad/tampered token → 404 (tenant boundary). +2 Jest in `site_analytics_handlers.test.ts` (full site_analytics
  suite 62/62). The prod valid-token path stays blocked only by the E2E org's flag-gated share-mint (test-env
  limit); the wire-through + boundary are now guarded in CI so a future edit can't silently drop the field.
- **Public report "Page speed" (CWV verdict) SHIPPED (2026-09-25):** the public
  `/shared/analytics/:token` report gains a recognizable **Page speed** tile (Good / Needs
  improvement / Poor) from real-user Core Web Vitals. Frontend-only (the endpoint already returns
  `traffic.webVitals`). Pure `cwvOverallRating` (exported, tested): Google thresholds (LCP 2500/4000,
  INP 200/500, CLS 0.1/0.25) + Google's pass model — Good only when EVERY measured core metric is
  good, Poor if any is poor, else Needs improvement; rates only metrics with field samples; null →
  tile omitted (never a fabricated rating). +8 Karma. Prod-verified: chunk live with the marker.
  **CORRECTION (2026-09-25): the "plateau" claim was premature — a parallel-agent scan found the
  contact-form LEAD FUNNEL was a real MEASURED-BUT-UNSURFACED gap** (`form_start` + `form_submit` have
  been beacon-emitted + mirrored into `visitor_events` for months, but NO aggregation consumed them).
  NOW SHIPPED (this fire): `getFormFunnelSummary` + `FormFunnelSummarySchema` (both summary paths) →
  `traffic.formFunnel` → `FormFunnelCardComponent` ("Contact form" lead funnel — starts → submits →
  completion rate + abandonment + per-form). Prod-verified live REAL data (berkeley-bowl-2: 1 start / 1
  submit / 100% / form "causal-beacon-form"); tenant-safe (owned 200, non-owned 404, no/bad-auth 401).
  8 Jest + 7 Karma. **Lesson: NEVER declare a plateau without grepping every summary-schema field
  against what a card renders** — `byChannel` (last fire) + `formFunnel` (this fire) were both
  computed-but-unrendered gaps a plateau claim missed.

  **RANKED BACKLOG (from the 2026-09-25 parallel scan — build top-down next fires):**
  - ~~Outbound clicks BY KIND~~ — **DROPPED as redundant** (2026-09-25): `getConversionKinds` →
    `byConversionKind` (the shipped Conversions card) ALREADY gives the by-category counts
    (call/directions/form). A second "by kind" view would confuse, not clarify. Verified in source.
  - ~~engagement-distribution~~ — **SHIPPED (2026-09-25, this fire):** `EngagementSummary.distribution`
    {s10,s30,s60,s180} (visits past each dwell threshold, monotonic) → the "How long visits lasted"
    rung funnel in the Engagement card. Answers "are people reading, or bouncing in 3s?" — the spread
    the median hides. 6 Jest + 2 Karma; worker `11924ec6`, chunk `chunk-GSJ5MXOV.js`; prod-verified
    (field flows; honest all-0 when 0 samples; non-owned 404).
  - ~~Delivery bytes/pageviews BY STATUS~~ — **SHIPPED (2026-09-25):** `top_statuses[]` carries
    `bytes` + `visits`; "Top error responses" shows "N visitors hit" per error code.
  - ~~Per-page NAV-TIMING~~ — **SHIPPED (2026-09-25):** `NavTimingSummary.byPage[]` (slowest pages).
  - ~~Per-page NETWORK-QUALITY~~ — **SHIPPED (2026-09-25):** `NetworkQualitySummary.byPage[]`.
  - ~~Per-cache-state BYTES~~ — **SHIPPED (2026-09-25):** `cache.hit_bytes/miss_bytes/uncacheable_bytes`
    (the cache query already fetched them; were folded to a scalar) → the card shows "N MB served on
    cache misses — cacheable to save bandwidth". Worker `6ca7fad9`; prod-verified real data.

  **BACKLOG CLEARED (2026-09-25, "implement them all" pass) — final disposition:**
  - ❌ **Content-type `byType` card — DROPPED as redundant.** The meaningful business events are ALREADY
    surfaced better elsewhere: pageviews = the headline KPI, conversions = the Conversions card,
    form_start/submit = the Form-funnel card. A raw `byType` card would MIX in telemetry event types
    (web_vital / scroll_depth / nav_timing / network_quality / page_engagement) that are noise to an
    owner — building it is redundant chrome. Not worth building (like outbound-by-kind, dropped earlier).
  - ❌ **Concierge chat engagement — DEFERRED (anti-value as-is).** `concierge_open`/`concierge_message`
    are beacon-emitted but the AI concierge is Gallery-only (dead model on real sites — see memory
    `ai-concierge-exists-gallery-only`). So a concierge card would be EMPTY for ~every real customer
    forever — building an always-empty card violates "no attractive buttons backed by nothing". Revisit
    ONLY if/when the concierge ships to customer sites.
  - **SQL syntax highlighting (DATA)** — the sole remaining REAL feature. Needs `@codemirror/lang-sql`
    (bolt.diy bundles the CodeMirror suite but not lang-sql) + a textarea→CodeMirror refactor in the
    Pages-deployed root `app/`. A DEDICATED task: the dep can't be installed in a symlinked-node_modules
    worktree without corrupting main, and it can't be verified locally without the dep — do it in a
    focused session, not a loop fire.
  - Tenant + honest-empty coverage is broad (every newer metric got honest-empty + tenant tests as it
    shipped). Residual: a public-share + drilldown-filter cross-tenant test (minor — the token IS the
    siteId source, so the surface is already narrow).
  **Both analytics + DATA sections are feature-complete on their clean surfaces.** Next loop fires:
  completeness-critic or reallocate to generated-site quality; the SQL-highlighting task when a session
  can own the dep+Pages work.
  Every AVAILABLE CF dataset is shipped (CF RUM cached); the backlog is first-party DEPTH, not CF.

## Coverage matrix

| Metric | Source | Plan/config | Hostname filter | Retention | Sampling | Status | UI |
|---|---|---|---|---|---|---|---|
| Pageviews | D1 visitor_events (server) | none | per site_id | D1 (unbounded) | none | ✅ live | traffic card |
| Visits (distinct visitor-days) | D1 visitor_events, `COUNT(DISTINCT session_id)` where `session_id = SHA-256(ip\|ua\|YYYY-MM-DD)` | none | site_id | D1 | none | ✅ live — **relabeled honestly (this fire)**: the KPI tile + glossary + aria now read **"Visits"**, NOT "Unique visitors"/"Distinct IPs". The id is stable per visitor per UTC day, so over an N-day window this is distinct visitor-DAYS summed (a person on 3 days = 3) — MORE than whole-range unique people, and not pageviews/requests. Glossary spells this out. **Public share report also fixed (next fire):** `/shared/analytics/:token` read a nonexistent `traffic.uniqueVisitors` key (API provides `uniqueSessions`) → it ALWAYS showed "Unique visitors: 0" (key-mismatch lying-empty); now reads `uniqueSessions` + labels it "Visits". | Visits KPI tile · public share report |
| Conversions (total) | D1 visitor_events (beacon) | none | site_id | D1 | none | ✅ live — **now with a period-over-period Δ chip** (`conversionDelta` vs `previous.conversions`, honest "new"/null) | conversions card |
| **Conversions by kind** (call / directions / form / …) **+ per-kind Δ** | D1 visitor_events `json_extract($.kind)` on `conversion` events (current + prior window) | none | site_id | D1 | none | ✅ **live** — `getConversionKinds` (both summary paths) → `traffic.byConversionKind` → focused **`ConversionsCardComponent`** (humanized labels + bar breakdown + total; kind-less → "other"; honest "no conversions tracked yet"). **(this fire)** each kind row now carries a period-over-period **Δ chip** (calls ↑, form-submits ↓) from `getPreviousConversionKinds` → `previous.byConversionKind`; "new" from zero, no chip when nothing to compare. | `/admin/analytics` "Conversions" card |
| Top pages / paths | D1 visitor_events | none | site_id | D1 | none | ✅ live | top-pages table |
| Referrers | D1 visitor_events | none | site_id | D1 | none | ✅ live | referrer table |
| Geography (country/city/region) | D1 metadata ← `request.cf` | none | site_id | D1 | none | ✅ live | geo breakdown |
| **Device / browser / OS** | D1 metadata `json_extract($.device\|$.browser\|$.os)` ← `enrichVisitor(ua)` (`getDimensionBreakdown`, allowlisted dimension) | none | site_id | D1 | none (all pageviews) | ✅ **fully live (this fire)** — was device-only surfaced; browser + OS were INGESTED but not aggregated. Now a focused **`TechBreakdownComponent`** ("Devices & platforms") renders all three pageview splits (top-6, bar + count + **share % of the FULL dimension total** — not just the top-6, so "mobile 68%" is honest, cycle 57 — "unknown" is a real bucket never dropped). Covers EVERY visitor (user-agent, unlike Chromium-only CWV). Both summary paths (live + rollup-reads-live). Prod-verified live REAL data: device `[desktop:19]`, browser `[Chrome:15, unknown:3, Firefox:1]`, os `[macOS:16, unknown:3]`. | `/admin/analytics` "Devices & platforms" card |
| **Busiest hours (hour-of-day)** | D1 `strftime('%H', created_at)` over pageviews (`getHourlyBreakdown`) | none | site_id | D1 | none (all pageviews) | ✅ **live (2026-09-24)** — 24 UTC hour-of-day pageview buckets (`byHour`) read live in both summary paths; the card rotates to the viewer's LOCAL time (`rotateToLocalHours`) + shows a 24-bar strip + peak-hours insight + honest empty state; local-time basis + half-hour-zone approximation disclosed. Prod-verified REAL data via the API. | `/admin/analytics` "Busiest hours" card |
| Channel + Campaigns (utm_source / utm_campaign) | D1 metadata ← `enrichVisitor` (channel from referrer+utm; utm_* parsed from the URL) via `getDimensionBreakdown` (channel) + `getCampaignBreakdown` (utm, allowlisted, **excludes untagged**) | none | site_id | D1 | none | ✅ channel live; **campaigns NEW (this fire)** — `CampaignBreakdownComponent` ("Campaigns & sources") renders top utm_source + utm_campaign over TAGGED visits ONLY (untagged direct/organic excluded, never a giant "unknown" bucket); honest empty state that TEACHES how to tag links (utm_source/utm_campaign example). Both summary paths + CSV. Prod-verified live: `byUtmSource`/`byUtmCampaign` in the summary (empty for the untagged test site). **(2026-09-25) Channels card NOW RENDERED** — `traffic.byChannel` was computed in BOTH summary paths (`getDimensionBreakdown('channel')`) + in CSV, but had NO dashboard card (computed-and-discarded). A focused **`ChannelBreakdownComponent`** ("Acquisition · Channels") now renders it (direct/organic/social/paid/email/referral, top-8, bar + count + honest share % of the full total; humanized labels; honest empty state), each row a drillable toggle (drills by the RAW stored channel value → exact server filter, never lying-empty). +6 Karma. Prod-verified chunk `chunk-LNG32YNM.js` (200 + `an-channel-drill`). | `/admin/analytics` "Acquisition · Channels" card (drillable) + "Campaigns & sources" card |
| Daily time series | D1 visitor_events / analytics_daily | flag `analytics_rollup_read` | site_id | D1 | none | ✅ live | line chart |
| Funnel (landing→engaged→converted) | D1 visitor_events | none | site_id | D1 | none | ✅ live | funnel widget |
| Forms / completions | D1 form_submissions | none | site_id | D1 | none | ✅ live | forms tab |
| **Contact-form LEAD FUNNEL (starts → submits → completion rate + abandonment, per form)** | D1 `visitor_events` — `form_start` (validated attempt) + `form_submit` (server-confirmed) beacon events, `COUNT` by `event_type` grouped by `json_extract(metadata,'$.form')` | none | site_id (+ drilldown predicate) | D1 | none (all events) | ✅ **NEW (2026-09-25)** — `getFormFunnelSummary` (both summary paths, reads `visitor_events` directly like conversions/outbound) → `traffic.formFunnel` → **`FormFunnelCardComponent`** ("Contact form" — big completion-rate stat + started→submitted funnel bars + a "N leads didn't get through" callout + per-form breakdown when >1 form). The ONLY view of form ABANDONMENT (starts − submits = lost leads), DISTINCT from the `form` conversion-kind (successes only). Honest: completion renders "—" (never 0%) when null, no activity → explicit empty state. Tenant-safe: `currentWindow` binds `site_id` first; owned 200 / non-owned 404 / no-auth 401 (prod-verified). Rate clamped ≤100 for the submit-without-start anomaly. 8 Jest + 7 Karma. Prod-verified live REAL data: berkeley-bowl-2 = 1 start / 1 submit / 100% / form "causal-beacon-form"; chunk `chunk-NNQ7WBNE.js` (200 + `an-form-funnel`); worker `f220e283`. | `/admin/analytics` "Contact form" lead-funnel card |
| Period-over-period deltas | D1 visitor_events | none | site_id | D1 | none | ✅ live | comparison |
| **Highlights / insights (evidence-backed)** | (UI) pure derivation over the fetched envelope + D1 traffic | none | — | — | — | ✅ **DONE (2026-09-25)** — `buildAnalyticsInsights` (pure, tested) turns the SAME data the cards show into ≤5 plain-language, owner-friendly takeaways (traffic + honest Δ · top conversion kind + Δ · most-visited page · **page speed** (first-party FCP p75, rated fast/okay/slow — added 2026-09-25 now that the page-load beacon accrued real samples) · device MAJORITY ≥50% only · top location · true session-bounce), rendered in an `InsightsStripComponent` at the top of the dashboard. **Honest:** every insight embeds its real number, is emitted ONLY from present data (never "0% of…"), comparisons appear ONLY from the real `pvDelta`/`conversionDelta` (null → no comparison; "new" when prior was zero), and the strip HIDES on a fresh site. No new query (pure derivation). **CLICKABLE (2026-09-25):** the device / top-page / top-location insights carry a `{dim,value}` drill and render as buttons ("68% of visitors are on mobile ↳ filter") that feed `applyDrill` — one tap from takeaway → filtered detail (reuses the drilldown filter); aggregate insights (traffic/conversions/bounce) have nothing single to filter to → plain text. Accessible (real button + aria-label). Prod-verified live (chunk MD5 local==prod). +12 Karma (8 util + 4 component). | `/admin/analytics` "Highlights" strip (top) |
| **Delivery & performance (status codes / cache hit-miss / bandwidth)** | CF GraphQL `httpRequestsAdaptiveGroups` (`edgeResponseStatus` + `cacheStatus` + `sum{edgeResponseBytes}`) | resolved via the shared zone for subdomains; API lookup for custom domains | per `clientRequestHTTPHost` | ~30 days | adaptive sampled | ✅ **LIVE for ALL sites (decoupled this fire)** — a SEPARATE `loadHostDelivery`/`resolveDeliveryZone` path resolves the shared projectsites.dev zone for `*.projectsites.dev` subdomains, so edge delivery works for the subdomain MAJORITY — **without flipping the audience numbers to CF** (audience stays first-party D1; `resolveDeliveryZone` is independent of the audience `resolveZoneForHostname`, which still returns null for subdomains → `resolved_zone:false` → "ProjectSites analytics" labeling preserved). `envelope.delivery` → `DeliveryCardComponent` (status classes + WORD, cache hit-ratio, bandwidth, top error codes, ≥5% 4xx/5xx warning). **Prod-verified live** on harborline: 30d = 31,610 req · 2xx 27588 / 5xx 3145 / 3xx 828 / 4xx 49 · cache 32% · 1.16 GB, while audience `resolved_zone:[false]` + pageviews first-party. **Sampling now VISIBLY surfaced (this fire)** — the card header shows a "sampled estimate" tag + the note reads "adaptive-sampled — approximate, not exact" and explicitly contrasts the EXACT first-party audience metrics (was tooltip-only, which violated "never imply an estimated metric is exact"). **(2026-09-25) Per-status BYTES + VISITS** — the `status` httpRequestsAdaptiveGroups sub-query now ALSO selects `sum{edgeResponseBytes, visits}` (same per-host request, no new CF call), so each `top_statuses` entry carries its edge bandwidth + how many REAL VISITORS hit it. The "Top error responses" list now shows "**N visitors hit**" per error code (real people, not raw requests — the actionable owner signal; shown ONLY when visits>0, since visits is adaptive-sampled → a 0 renders no-chip, never a fabricated "0 visitors") + per-code bytes. Parallel `by_status_bytes`/`by_status_visits` maps (zero churn to the count-based status-class fold). Prod-verified live: status 200 = 361 req · 15.1 MB · 39 visits (worker `d20f2a68`, chunk `chunk-IXCTLB4Y.js`). +3 Jest +1 Karma. ⚠️ the FIRST `wrangler deploy` served a STALE bundle (new version id, old 2-key `top_statuses`); a REDEPLOY fixed it — verify delivery by SHAPE, not version id. **(2026-09-25) Honest CF-edge WINDOW** — the card header showed the REQUESTED window (`windowDays`), but the worker caps delivery data at CF's ~30-day retention (`delivery.range_days = min(requested, 30)`, computed but UNRENDERED). So a 90-day request claimed "last 90 days" over ≤30 days of edge data (violating "outside-retention / never imply exact"). FIXED (frontend-only — worker already returned `range_days`): the header now shows `coveredDays()` (= `delivery.range_days`, the ACTUAL covered window) + when `windowCapped()` appends "(of N requested — CF ~30-day edge cap)". First-party audience metrics still honor the full window (note scoped to the CF edge block). Prod-verified: a 90d request returns `delivery.range_days:30`. +2 Karma; chunk `chunk-66FRSSMJ.js`. | `/admin/analytics` "Delivery & performance" card |
| **Core Web Vitals (LCP/INP/CLS + per-page + distribution)** | first-party RUM → `web_vital` events in D1 | none (no CF plan) | per site_id (+ per `path`) | D1 | none (all sessions) | ✅ **COMPLETE + per-path (full 5-metric) + distribution** — site p75 card, a **"Slowest pages · LCP / INP / CLS / FCP / TTFB p75"** drilldown (buckets EACH metric by `path`; ranked worst-first by LCP top 5, past a **5-sample floor**; **each affected page ALSO carries its INP + CLS p75 AND (2026-09-25) its FCP + TTFB p75** — the FULL per-page performance picture, so an owner pinpoints which page is slow to first-paint (FCP) or slow off the server (TTFB), not just slow to LCP; every per-metric cell shows "—" (never 0) when that page lacks enough samples for that metric, cycles 55 + 2026-09-25), AND a good/needs/poor DISTRIBUTION bar per metric (`getWebVitalsSummary` classifies every real sample against Google's thresholds → `dist:{good,needs,poor}` where `good+needs+poor===samples`; the card shows a 3-segment bar + %-legend + exact-count aria). Shows the SPREAD the p75 point hides (a "needs" p75 can still be mostly-good). Honest ("measuring"/null never a fake 0; no dist without samples) | `/admin/analytics` "Core Web Vitals" card + slowest-pages table (LCP·INP·CLS·FCP·TTFB) + per-metric distribution bar |
| **Cloudflare RUM (CWV + Navigation Timing, per host)** | CF GraphQL `rumPageloadEventsAdaptiveGroups` + `rumWebVitalsEventsAdaptiveGroups` + `rumPerformanceEventsAdaptiveGroups` (account-scoped, filtered `requestHost`) | none (CF zone auto-injects the Web Analytics beacon) | per owned host (server-resolved) | ~30 days | adaptive-sampled | ✅ **SERVER SOURCE LIVE (2026-09-25, this fire)** — the ONE CF dataset that attributes per `*.projectsites.dev` subdomain (unlike `httpRequestsAdaptiveGroups`). `services/cloudflare_rum.ts` + `GET /api/sites/:siteId/cloudflare-rum` return CF-measured **LCP/INP/CLS** (Core Web Vitals) + **TTFB(responseTime)/FCP/pageLoad/DNS/connect** (Navigation Timing) as an INDEPENDENT second source to the first-party beacon (labeled `source:'cloudflare_rum'` + `sampled:true`; never summed). µs→ms converted, CLS unitless, Google-band rated, honest nulls on 0 samples, fail-soft `available:false` (never a 500 / fake 0). Tenant-safe: owner-scoped site (non-owned → 404), host resolved SERVER-SIDE. **Live-proven:** unauth 401 · non-owned 404 (cross-tenant) · owned `berkeley-bowl-2` 200 (LCP 1248ms good, TTFB 1ms, pageLoad 1917ms, 20 samples). 16 Jest. Worker `82a8101a`. **(2026-09-25) CACHED — one CF request per host per ~5-min window.** `getCachedCloudflareRum(env, host, days)` wraps the fetch (KV key `cf_rum:v1:{host}:{days}` — server-resolved host, keyed by day-window not raw since/until; 5-min TTL; caches SUCCESS only so a transient null retries; env-mock-safe — direct fetch when `CACHE_KV` unbound). Both the admin route AND the public-share `getCloudflareRumForSite` use it (was: an uncached CF call on EVERY dashboard load + share view). No cross-tenant cache leak (a hostname maps to one site). +5 Jest (miss→fetch+store · hit→no-CF-call · no-KV fallthrough · null-not-cached · clamp). Worker `90896d13`. **Prod-verified: cold 5.60s (CF query) → warm 0.17s (KV hit), ~32× faster, identical data.** | ✅ **UI LIVE (2026-09-25)** — `CloudflareRumCardComponent` in `/admin/analytics` beside the first-party CWV card (self-fetching, sampled-labelled, server ratings, honest empties/`available:false`). +9 Karma. Prod-verified chunk `chunk-DVB44EQP.js` (200 + `an-cf-rum`). |
| **Security (WAF/bot/challenges)** | CF GraphQL `firewallEventsAdaptiveGroups` | **plan lacks access** | per hostname | plan-dependent | — | ❌ **BLOCKED — verified 2026-09-24** by an introspection probe against our zone: returns authz *"zone does not have access to the path"*. Our plan has no firewall-analytics entitlement, so this is NOT buildable without a plan upgrade — a security card would be a permanent placeholder (which the doctrine forbids). | — (honestly absent) |
| **CSV export (dashboard)** | (UI) client-side over fetched data | none | — | — | — | ✅ **COMPLETE** — `buildAnalyticsCsv` exports summary + top-pages/countries/referrers + the D1 **device/browser/OS** (the full platform trio, grouped, mirroring the "Devices & platforms" card) + **campaign attribution (utm_source/utm_campaign, tagged visits only)** + channel/conversions/CWV breakdowns + the CF edge DELIVERY breakdown (status classes, cache hit/miss/ratio, edge bandwidth — emitted ONLY when `has_data`, never fabricated zeros) + **(2026-09-25) the edge connection/content breakdowns** (`edge_protocol`/`edge_tls`/`edge_content_type`/`edge_method`/`edge_verified_bot`) **AND first-party page-load timing** (`web_vital,ttfb_p75_ms`/`fcp_p75_ms`, only when measured) — reconciling the export with the dashboard after those 6 dimensions were added this session; with the ACCURATE source label; browser/OS + page-load rows are omitted (never fabricated) when absent; formula-injection-safe via the shared `csvEscape`. Matches the dashboard cards. | `/admin/analytics` Export CSV |
| Source + freshness labels in UI | (UI) | none | — | — | — | ✅ **honest per-provenance** — the "Source:" badge routes through the authoritative `trafficSource` signal: first-party → **"ProjectSites analytics"**, genuine CF-zone custom domain → **"Cloudflare Edge"**. Freshness "as of" + "dates in UTC" present. | analytics header badge + chart caption + footer |
| **Metric definitions / measurement transparency** | (UI) static, data-driven | none | — | — | — | ✅ **DONE (this fire)** — `AnalyticsGlossaryComponent`, an accessible "How these metrics are measured" `<details>` disclosure: per-metric plain-language definition + **source badge** (first-party / Cloudflare edge / real-user) + caveats (bots filtered, Chromium-only CWV shown only when sampled, edge adaptive-sampled + ~30-day retention). Explicitly spells out **requests ≠ page views** (never conflated). | `/admin/analytics` (below the cards) |
| **Drilldown filter (server core)** | D1 `visitor_events` — an allowlisted `{dim,value}` predicate (`FILTER_DIMENSION_SQL`: country/device/browser/os/channel/path) baked into `currentWindow`/`previousWindow`/`timePredicate` + forwarded to every breakdown helper | none | site_id (+ the narrowing dim) | D1 | none | ✅ **server core LIVE (2026-09-24)** — `GET /api/sites/:siteId/analytics?filterDim=&filterValue=` restricts the ENTIRE summary (KPIs + every breakdown + CWV + conversions + the prior-window comparison) to one dimension value. **Tenant-safe:** dim is a Zod-enum allowlist (unknown/injected → **400**, never reaches SQL), value is always a BOUND `?` param, and the filter only NARROWS within the already owner-scoped `site_id` (a non-owned site still **404s** WITH a valid filter). A filter FORCES the live scan (the calendar rollup can't answer it) and is ECHOED as `appliedFilter`. Metrics whose events lack the dim (e.g. CWV by country) go **honest-empty** when filtered, never a fabricated 0. 18 new tests (11 core + 7 route). **UI SHIPPED + VERIFIED (2026-09-25) — was stale-marked "next".** Clickable drill rows: **path** + **country** (breakdown rows), **device / browser / os** (via `<app-tech-breakdown (drill)>`), and the **Highlights strip** (device / top-page / top-location). A removable, accessible **filter chip** (`an-filter-chip` → `clearFilter()`, rendered from the SERVER-echoed `appliedFilter`, never the click alone) + `isFiltered()` empty-when-filtered states ("No pages/countries match this filter"). **ALL 6 allowlisted dims are now row-clickable (2026-09-25):** path + country + device/browser/os + **channel** — the new drillable "Acquisition · Channels" card (`ChannelBreakdownComponent` over `traffic.byChannel`) closed the last gap the RIGHT way: it drills by the RAW stored `metadata.channel` value (the card's rows ARE the grouped channel values), so the filter is exact — NOT the earlier fuzzy "referrer-row → channel" idea (which risked a display-label ≠ stored-value lying-empty). | ✅ UI LIVE — drill rows for ALL 6 dims (path·country·device·browser·os·channel) + Highlights drills + removable chip + filtered empty states |

## Highest-impact gap — CWV is DONE (corrected 2026-09-24)

**Core Web Vitals is FULLY SHIPPED, not a gap.** The prior note here ("there is NO LCP/INP/CLS data
today") was stale. First-party RUM is live end to end: the `initWebVitals` beacon in the edge-injected
`app.js` posts `web_vital` events (LCP/INP/CLS/FCP/TTFB) → `/api/events` → mirrored into
`visitor_events`; `getWebVitalsSummary` aggregates p75 + a good/needs/poor distribution + slowest
pages; `<app-web-vitals-card>` renders each p75 WITH its Google-threshold rating (Good / Needs work /
Poor — WCAG use-of-color: the WORD, never colour alone), a distribution histogram, and per-page
affected-pages. Honest: a null metric shows "measuring", never a fabricated 0; Chromium-only sampling
is disclosed. **Nothing to build here — do NOT rebuild CWV.**

The customer analytics section is now at a **verified no-dep plateau**: audience/traffic, delivery
(sampled-flagged + **data-latency disclosed** — edge data "a few minutes behind live" vs real-time first-party,
cycle 2026-09-24), CWV, campaigns, device/browser/OS, bounce, conversions, comparison-period deltas, busiest-hours,
tz-aware daily bucketing, honest source/freshness/definition labels + a full glossary, and CSV export
(incl. device/browser/OS/CWV/hourly) are all shipped. The only remaining items are plan-blocked (Security/WAF +
latency percentiles — no entitlement) or need new plumbing/deps (see Next).

## Deferred / not-a-gap
- Device/geo/channel are NOT beacon-blocked (server-enriched) — do not chase a beacon backfill for them.
- Analytics Engine customer dashboards — ingest disabled; out of scope unless enabled.

## Next increment (handoff)

**"IMPLEMENT ALL PENDING ITEMS" pass — SHIPPED per-cache-state BYTES + cleared the backlog (2026-09-25,
latest).** On a "scan all pending items and implement them all" directive: implemented the one clean,
valuable, has-data item — **per-cache-state edge bytes** (`cache.hit_bytes/miss_bytes/uncacheable_bytes`;
the cache query already fetched them, were folded to a scalar) → the delivery card shows "N MB served on
cache misses — cacheable to save bandwidth". Worker `6ca7fad9`, chunk in R2; prod-verified real data
(miss_bytes 3424, hit_bytes 69179). The remaining backlog was resolved by ENGINEERING JUDGMENT, not
blind-built: **byType card DROPPED** (redundant — pageviews/conversions/form-funnel already surface the
meaningful events; raw byType mixes telemetry noise); **concierge engagement DEFERRED** (the AI concierge
is Gallery-only/dead-model → an always-empty card is anti-value); **SQL syntax highlighting** = the sole
remaining real feature, a DEDICATED dep(`@codemirror/lang-sql`)+Pages task (can't install in a symlinked
worktree or verify locally without the dep). See the BACKLOG CLEARED block above for full rationale.
**Both sections feature-complete on their clean surfaces.** NEXT: the SQL-highlighting dedicated task, or
reallocate to generated-site quality.

**Honest CF-edge WINDOW on the delivery card — SHIPPED (2026-09-25).** A completeness-critic
scan (the section is near-complete) found `DeliverySummary.range_days` computed-but-unrendered: the card
header showed the REQUESTED window while the worker caps delivery at CF's ~30-day retention, so a 90-day
request claimed "last 90 days" over ≤30 days of edge data. FIXED (frontend-only): header shows the ACTUAL
covered window (`delivery.range_days`) + a "(of N requested — CF ~30-day edge cap)" note when capped.
Prod-verified: a 90d request returns `delivery.range_days:30`. +2 Karma; chunk `chunk-66FRSSMJ.js`.
**Section status: at a genuine plateau.** The completeness scan confirmed EVERY summary field is now
rendered (no computed-but-unrendered gaps remain) except `byType` (event-type distribution — deliberately
NOT built: mixes telemetry event types like web_vital/scroll_depth, low owner value). Tenant + honest-empty
tests broadly cover the boundaries. **NEXT: run a completeness-critic / reallocate to generated-site
quality** rather than force another marginal card — the remaining backlog (byType, concierge [gallery-only],
per-cache-state bytes) is all low-value. Both analytics + DATA sections are feature-complete on their clean
surfaces (DATA's only gap = DataPanel SQL syntax highlighting, a dedicated dep+Pages task).

**Per-page NETWORK-QUALITY (slowest-connection pages) — SHIPPED (2026-09-25).**
`getNetworkQualitySummary` now returns `byPage[]` (each page's median downlink + median rtt, floor-gated
≥5 downlink samples, SLOWEST-downlink first, top-8; same network_quality query, no new scan) → the
network card's "Pages with the slowest-connection visitors" list. An owner sees which pages their
mobile/rural (low-bandwidth) visitors hit → make those lean. Honest: rtt chip only when non-null; block
hidden when empty. 1 Jest + 2 Karma; worker `83289d15`, chunk `chunk-C7QXFZFO.js`; prod-verified (byPage
shape flows + tenant 404/401; E2E org has 0 network_quality samples → honest-empty; populated path
unit-tested). This closes the per-page first-party depth arc (nav-timing + network-quality both done).
**NEXT (both sections near completion):** the remaining analytics backlog is low-value (content-type
`byType` card, concierge chat [may be gallery-only], per-cache-state delivery bytes) or missing-tests.
Consider a completeness-critic pass or reallocating the analytics loop to generated-site quality.

**DATA loop — section VERIFIED feature-complete (this fire's DATA scan).** The DataPanel SQL console is
FULLY featured on origin/main (EXPLAIN, query history, saved queries, multiple tabs, bind params, CSV/JSON
import+export, expensive-scan warnings, selection-execution, D1 rows_read/written metadata, SQL
formatting, PK-scoped CRUD). The `89e37cb2b` EXPLAIN "branch" I'd flagged as contention is SUPERSEDED
(origin/main's DataPanel is ~2995 lines larger). The admin data-overview + 4 resource inspectors are done.
The ONLY remaining DATA gap is **SQL syntax highlighting** — needs a new `@codemirror/lang-sql` dep in the
Pages-deployed root `app/` (bolt.diy already bundles the CodeMirror suite but not lang-sql). That's a
deliberate dedicated task (dep install + textarea→CodeMirror refactor + Pages deploy), NOT a clean 15-min
loop increment — the reason DATA fires keep landing on analytics. A dedicated session should do it.

**Per-page NAV-TIMING (slowest pages) — SHIPPED (2026-09-25).** `getNavTimingSummary` now
returns `byPage[]` (each page's median total load + median TTFB, floor-gated ≥5, worst-first top-8; same
nav_timing query, no new scan) → the page-load card's "Slowest pages · median load · server wait" list.
An owner sees WHICH page is slow AND whether it's slow off the SERVER (TTFB) vs the client — the drill the
site-wide median hid. Mirrors the CWV slowest-pages pattern. Honest: per-page TTFB chip only when non-null;
block hidden when empty. 3 Jest + 2 Karma; worker `c328ef00`, chunk `chunk-ASRSJQJA.js`; prod-verified
(byPage shape flows + tenant-safe 404/401; the E2E org has 0 nav_timing samples so prod byPage is
honest-empty — populated path is unit-tested). **NEXT: per-page NETWORK-QUALITY** — same byPage pattern on
`getNetworkQualitySummary` (which page is mobile-hostile / low-downlink). Then concierge chat engagement
(needs a `VISITOR_MIRROR_TYPES` add first) or the cheap per-cache-state delivery bytes.

**DATA-loop note (this fire also scanned DATA):** the data-management utility's CLEAN surface is at a
verified plateau — the admin data-overview is mature (browse/search/filter/sort/column-hide/schema/
delete/bulk-delete/edit/activity/export) and the 4 resource inspectors (KV/R2/Vectorize/Queues) are
done + nav-wired. The remaining DATA frontier is the Editor **DataPanel SQL-console polish** (CodeMirror
highlighting, query history, saved queries), which sits behind an ABANDONED-but-unmerged EXPLAIN branch
(`analytics-drilldown-filter`, unpushed since session start) + a separate Pages pipeline — not a clean
15-min increment. A future DATA fire should confirm that branch is dead, land-or-drop it, then tackle the
SQL console.

**Per-status edge BYTES + VISITS — SHIPPED (2026-09-25).** The `status`
httpRequestsAdaptiveGroups sub-query now also selects `sum{edgeResponseBytes, visits}` (same per-host
CF request, no new call) → `top_statuses[]` carries `{status,count,bytes,visits}` → the delivery card's
"Top error responses" shows "**N visitors hit**" per error code (real people who hit a 404/5xx — the
actionable owner signal, not raw requests; shown only when visits>0 since it's sampled) + per-code
bytes. 3 Jest + 1 Karma; worker `d20f2a68`, chunk `chunk-IXCTLB4Y.js`; prod-verified live (200 = 361
req · 15.1 MB · 39 visits). ⚠️ the first deploy served a STALE bundle (2-key `top_statuses` despite a
new version id) — a redeploy fixed it; verify delivery by SHAPE. **NEXT: Concierge chat engagement** —
`concierge_open`/`concierge_message` are beacon-emitted but NOT in `VISITOR_MIRROR_TYPES` (not stored);
needs a mirror-type add (instrument the store) + aggregation + card. Starts empty (no history) but is a
genuine chat-adoption KPI. (Or the cheap follow-up: per-cache-state bytes — the cache sub-query already
fetches the bytes, just folded to a scalar today.)

**Time-on-page DISTRIBUTION — SHIPPED (2026-09-25).** `EngagementSummary.distribution`
{s10,s30,s60,s180} (count of visits past each dwell threshold, monotonic) → the "How long visits lasted"
rung funnel under the median in the Engagement card. Reuses the durations `getEngagementSummary` already
loads (NO new query) — the dwell analogue of the scroll-depth reach funnel. Answers "are visitors reading,
or bouncing in 3s?" — the spread the median point hides. Honest: all-0 + hidden block when 0 samples.
6 Jest + 2 Karma; worker `11924ec6`, chunk `chunk-GSJ5MXOV.js`; prod-verified (field flows;
berkeley-bowl-2 honest-empty at 0 samples; non-owned 404). Also this fire: DROPPED outbound-by-kind from
the backlog as redundant with the shipped `byConversionKind` card. **NEXT: Delivery bytes/pageviews BY
STATUS** — reuse the `loadHostDelivery` CF query (add `sum{edgeResponseBytes}`/`sum{visits}` per status;
no new CF request); see the ranked backlog above.

**Contact-form LEAD FUNNEL — SHIPPED (2026-09-25).** A parallel-agent scan of the whole
analytics section found `form_start`/`form_submit` (beacon-emitted + mirrored into `visitor_events` for
months) had NO aggregation — a MEASURED-BUT-UNSURFACED gap the prior "plateau" note missed. Now:
`getFormFunnelSummary` (both summary paths) → `traffic.formFunnel` → `FormFunnelCardComponent`
(started→submitted funnel + completion rate + abandonment callout + per-form). Tenant-safe (owned 200 /
non-owned 404 / no-auth 401, prod-verified); honest (rate "—" not 0% when null; empty state on no
activity). 8 Jest + 7 Karma; worker `f220e283`, chunk `chunk-NNQ7WBNE.js`; live REAL data proven
(berkeley-bowl-2 1/1/100%). **NEXT (top of the ranked backlog above): Outbound clicks BY KIND** (S) —
`byLink` already carries `kind`; add a by-kind rollup card ("40 calls · 12 emails · 8 directions"). Then
concierge-chat engagement, then delivery bytes-by-status. Do NOT re-build the shipped funnel/drilldown.

**Drilldown filter — SERVER CORE is DONE (2026-09-24).** A tenant-safe `{dim,value}` filter now threads through
the whole traffic summary: `AnalyticsFilterSchema` (Zod-enum allowlist country/device/browser/os/channel/path +
bounded value) in `visitor_events_core/schemas.ts`; `FILTER_DIMENSION_SQL` maps each dim to a TRUSTED column
expression (`satisfies Record<AnalyticsFilterDimension,string>` = compile-time coverage) and `filterClause()`
emits ` AND <col> = ?` with the value BOUND; baked into `currentWindow`/`previousWindow`/`timePredicate` (so every
inline query filters) + forwarded to all 6 breakdown helpers + `getTrafficSummary` (which SKIPS the rollup when
filtered — the calendar rollup carries no per-dimension detail). Wired through `getSiteAnalyticsSummary` →
`GET /api/sites/:siteId/analytics?filterDim=&filterValue=`; the handler validates dim against the allowlist
(unknown/injected → **400**, never reaches SQL) and echoes `appliedFilter`. Tenant isolation: the filter only
NARROWS within the already owner-scoped `site_id` (a non-owned site still 404s WITH a valid filter). 18 tests —
11 core (`filtered_summary.test.ts`: bound-value correctness, path-column-vs-json, prev-window parity, web-vital
threading, EVERY-query-binds-site_id isolation, unknown-dim SQL no-op, rollup-skip + a mock-live control) + 7 route
(`filter_route.test.ts`: echo, allowlist-reject ×3, missing-half, over-long-value, authz-not-widened).

**✅ FILTER UI — SHIPPED 2026-09-24 (commit `99c883ff8`).** Clickable device/browser/os (tech-breakdown),
country (geo), and page (top-pages) rows now drill the whole summary to `{dim,value}` via the live
`?filterDim&filterValue`; a removable chip renders from the SERVER-echoed `appliedFilter` (never the click
alone), toggles off on re-click, honest empty-when-filtered states, accessible (rows = `aria-pressed` buttons,
chip = real button). Filtered view is first-party audience only (edge can't filter these dims). +9 Karma. The
prior handoff below is now HISTORICAL.

**~~THE single highest-priority NEXT increment: the filter UI.~~ — DONE, superseded (verified 2026-09-25).** This
block was stale (it contradicted the "FILTER UI — SHIPPED" note just above). The filter UI is live: breakdown rows
for path/country + device/browser/os (via `<app-tech-breakdown (drill)>`) + the Highlights strip are clickable →
`applyDrill` sets the `filter` signal → the summary fetch sends `&filterDim=&filterValue=`; a removable, accessible
`an-filter-chip` renders from the SERVER-echoed `appliedFilter` (`clearFilter()`, `aria-pressed` rows); `isFiltered()`
empty-when-filtered states are in place. `channel` is reachable via the API filter but intentionally NOT row-clickable
(the "Top referrers" breakdown mixes hosts + channel-names → a per-row channel drill risks binding a display label ≠
the stored `metadata.channel`, a lying-empty). **No filter-UI work remains** — the section is at a plateau.

---
_CWV history (all DONE — do not rebuild):_
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
the card renders a "Slowest pages · LCP / INP / CLS p75" table (path + LCP p75 + rating word + per-page INP & CLS p75 + samples) when any page qualifies, hidden
otherwise. So the **CWV area is fully built out** (site + per-page). Covered by a per-path service spec + 2 card specs.
**Per-page FCP + TTFB is DONE** (2026-09-25): the slowest-pages drilldown now also buckets **FCP + TTFB by `path`** (same
`MIN_PATH_SAMPLES=5` floor) and each row carries `fcpP75`/`ttfbP75` (integer ms, `plFormat`/`plRating` — page-load thresholds,
distinct from CWV), rendered as two new `an-wv-page-fcp`/`an-wv-page-ttfb` cells (header now "LCP / INP / CLS / FCP / TTFB p75").
Completes the FULL per-page performance picture: an owner sees which page is slow to first-paint (FCP) or slow off the server
(TTFB), not just slow to LCP. Omitted ("—", never a fabricated 0) below the per-page floor. +1 service spec + 1 card spec.
**CWV rating distribution is DONE** (2026-09-24): `getWebVitalsSummary`'s `stat()` now classifies every real sample
against `CWV_THRESHOLDS` (Google's official good/needs/poor, mirroring the card's `rating()`) into `dist:{good,needs,poor}`
on each `WebVitalStat` (`good+needs+poor===samples`; optional in the Zod schema for back-compat, always populated live).
The card renders a 3-segment distribution BAR per metric + a %-legend (visual) + an **exact-count aria label** (percentages
can round to 99–101; the counts never lie). Shows the SPREAD the p75 point hides — e.g. a CLS p75 of 0.157 ("needs") whose
dist is 4 good / 3 needs. Prompt-requested ("distributions, percentiles"). Verified live: `lcp dist {good:6,needs:1,poor:0}`
(=7 samples), `cls {good:4,needs:3,poor:0}`, `inp null` (no samples → no fabricated dist). +2 service specs (classification
+ boundaries) + 3 card specs (bar renders / omitted without dist / pct math).
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

**Custom lookback SHIPPED** (2026-09-24): the range selector gained a **"Custom" pill + a 1–90 day number input**
(`customDays`, persisted). `loadMultiUrlAnalytics` now takes a `daysOverride` (via `clampCustomDays`, exported+tested)
that wins over the enum `range` and is folded into the KV cache key (`:d<days>:`); the handler reads `?days=N`. The D1
audience calls already took `rangeDays()`, so they honor the custom window too. Prod-verified: `?days=7`→692 pv
(range_days 7) vs `?days=90`→1677 pv (range_days 90) — the override changes the window with an honest `range_days`. 3
new specs (`clampCustomDays` bounds; `rangeDays`/`getMultiUrlAnalytics` days wiring; `setCustomDays` clamp). Tenant
isolation unchanged (rides the same `loadSiteAndAuth`/`resolveOwnedSiteId` authed path; `days` is a bounded integer,
never a resource selector). Worker + frontend deployed.

**Metric definitions SHIPPED** (2026-09-24): `AnalyticsGlossaryComponent` — accessible "How these metrics are measured"
disclosure with per-metric definition + source badge + caveat, spelling out requests ≠ page views.

**Custom range now bookmarkable/shareable** (2026-09-24): fixed two real gaps — the range deep-link accepted `24h/7d/30d/90d`
but NOT `custom` (a `?range=custom` link was silently ignored), and `?days` was never read or written (a shared custom link
showed the recipient's own localStorage day count). Now: `?range=custom&days=45` restores the exact window (URL wins over
localStorage, validated 1–90); `setRange`/`setCustomDays` write `days` to the URL (a preset clears a stale `?days`).
Frontend-only; +5 Karma specs (incl. the deep-link restore + isolation fix); Karma 1965/1965; prod-verified live.

**Arbitrary start/end date range — SERVICE + `/api/analytics/:siteId` shipped (2026-09-24).** The regression-sensitive
core is DONE: `getTrafficSummary` / `getWebVitalsSummary` / `getConversionKinds` (`libs/features/visitor_events_core/
service.ts`) now take an optional absolute `{since, until}` window → bound SQLite-comparable literals (`created_at >= ? AND
created_at < ?`, NEVER ISO `T`/`Z` which sorts wrong vs D1's space-separated `created_at`); the relative `datetime('now')`
path is unchanged (backward-compat, proven by tests). An absolute window FORCES the live scan (skips the calendar-aligned
rollup) and uses an equal-length immediately-preceding window for period-over-period. `GET /api/analytics/:siteId` parses/
validates/bounds `?start=YYYY-MM-DD&end=YYYY-MM-DD` server-side (malformed/reversed → 400; span clamped to 90d keeping
`end`), echoes the EXACT window served (`windowStart`/`windowEnd`) so the UI can never label a wider range than queried, and
skips GA4 for a custom window (relative-only). Tenant authz unchanged (siteId→site→membership; window never touches authz).
+16 tests (`custom_window` service + `site_analytics_window` handler/validator, incl. non-member-403-with-window). Deployed;
prod-verified (valid→200 honest echo, malformed→400, reversed→400, relative→200 `windowStart:null`).

**Arbitrary window — WORKER end-to-end COMPLETE (2026-09-24).** The window now flows through EVERY D1 audience route,
including the ones the Editor UI actually calls: `getSiteAnalyticsSummary` (its "new-in-window" contact/form counts + the
`getTrafficSummary` call) + `getDailySeries` in `libs/features/site_analytics/` both take the optional `{since, until}` →
bound literals; both routes (`GET /api/sites/:siteId/analytics` + `/analytics/daily`) parse/validate `?start&end` via the
shared `parseCustomWindow` (malformed/reversed → 400) + echo `windowStart`/`windowEnd`; `windowDays` echoes the span. Tenant
authz (`requireOwnedSite` → flag + org-ownership) unchanged. +6 Jest; prod-verified authed (summary+daily 200 w/ echoed
window + honest `pv:0`/0-buckets, malformed→400, relative→200 `windowStart:null`).

**Arbitrary window — FULLY END-TO-END + USER-VISIBLE (2026-09-24).** The frontend date-picker shipped: the `custom` range in
`analytics.component.ts` now has exact-date `<input type="date">` (start → end) beside the days lookback; two valid ordered
dates form `customWindow()` which supersedes `customDays`, feeds `getSiteAnalytics`/`getSiteAnalyticsDaily` as `?start&end`
(ApiService methods take an optional `{start,end}`), drives `rangeDays()` (returns the inclusive span), and is
bookmarkable/shareable (`?range=custom&start&end`, restored in the constructor; preset/lookback switches clear the params).
An honest note resolves the CF-retention design call: **"Audience metrics show <start> → <end>; edge delivery + security
reflect a recent window — Cloudflare can't query an arbitrary past range"** (the CF delivery/security cards stay on their
trailing window). +5 Karma specs (customWindow validity, rangeDays span, window→API args, URL restore, conditional note) + 3
updated for the new URL contract → 1979 total. Deployed R2 + chunk-hash prod-verified (`chunk-K4QYFOWI.js`, `an-range-dates`).

**Timezone-aware daily bucketing — DONE (2026-09-24).** `getDailySeries` now buckets by the OWNER's local calendar day
instead of UTC midnight: SQLite can't do IANA zones, but a FIXED-offset shift (`date(created_at, ?)` with a BOUND
`'-480 minutes'` modifier — never concatenated) buckets to local. The frontend sends `-new Date().getTimezoneOffset()` to
`GET /api/sites/:siteId/analytics/daily?tz=<min>`; the service `normalizeTzOffset` bounds it to ±14h and **fails SAFE to UTC**
for 0/junk/out-of-range. The chart caption is now honest + dynamic — **"dates in <IANA zone>"** (e.g. `America/Los_Angeles`)
with a tooltip noting it's the current offset (DST-approximate across a change), or "dates in UTC" at offset 0. +4 Jest
(offset modifier bound both in SELECT+GROUP BY / UTC no-modifier / fail-safe 0+range / window+tz combined) + 2 Karma
(offset sent / caption). Deployed; verified. **Not touched (documented limits):** the calendar-aligned `analytics_daily`
rollup + `getTrafficSummaryFromRollup` can't be tz-shifted (pre-aggregated by UTC day) — the live path is the tz-aware one;
the `/api/analytics/:siteId` legacy `byDay` (secondary route, not the UI's source) stays UTC.

**Dead `getAnalytics` fetch removed — DONE (2026-09-24).** That legacy `/api/analytics/:siteId` (GA4→CF→D1) is NOT the UI's
source — yet `AdminStateService.loadAnalytics` still fetched it into an `analytics` signal on init + site-switch + every
60s refresh tick, and **NO component ever rendered that signal**: a write-only dead fetch that wasted one CF/GA4 API call
per site per minute (exactly the "one CF request per widget per customer" the doctrine forbids). Removed the whole dead
chain (`analytics`/`analyticsPeriod`/`analyticsLoading` signals + `loadAnalytics`/`setAnalyticsPeriod` + its 4 call sites).
This also VOIDS the Cycle-38 handoff — its per-source `visitorsMetric` label had no surface to render on. Regression-locked:
a Karma test asserts `loadData()`/refresh never call `getAnalytics`. Frontend-only; Karma 2054/2054.

**Frontend `getAnalytics` client + `Analytics*` types removed — DONE (2026-09-24, cycle 41).** Followed through on the
above: deleted `api.service.getAnalytics` + the 6 now-orphaned `Analytics{Data,Stats,ChartPoint,TrafficSource,TopPage,TopCountry}`
interfaces (no real-method test, no imports outside api.service — the `analytics.component` "getAnalytics" spy actually mocks
`getMultiUrlAnalytics`; `analytics-live` has its own local interface). The BACKEND `/api/analytics/:siteId` handler + its Jest
tests remain (removing them would touch preserved tests — a separate decision); it's a documented legacy secondary route with
no live consumer. tsc + Karma 2054/2054 green; frontend-only.

**Absolute-window tz interpretation — DONE (2026-09-24).** The custom `?start&end` bounds are now interpreted in the OWNER's
timezone, consistent with the tz-aware daily buckets. A pure `shiftWindowToTz(window, tzMin)` (in `visitor_events_core`)
converts each date-only LOCAL midnight to its UTC datetime equivalent (`YYYY-MM-DD HH:MM:SS`, D1-comparable — never ISO T/Z):
a PST owner's `since='2026-08-01'` → filter `created_at >= '2026-08-01 08:00:00'` (= Aug 1 00:00 PST), not UTC midnight.
Both site_analytics routes (`/analytics` + `/analytics/daily`) parse `?tz` and shift the window before querying — the summary
counts + the daily filter now match the owner's local days (the daily ALSO buckets by tz). UTC/junk/out-of-range → the window
passes through unchanged (fail-safe). The response still echoes the ORIGINAL local dates (the shifted UTC bounds are an
internal detail). Frontend sends `tz` to BOTH `getSiteAnalytics` + `getSiteAnalyticsDaily`. +4 Jest (PST/IST shift · no-T/Z ·
fail-safe pass-through) + 1 Karma (summary gets tz) → 1987 Karma / 12266 Jest. Deployed; prod-verified.

**Comparison-period Δ badges — DONE (2026-09-24).** The KPI tiles now show a period-over-period delta from the AUTHORITATIVE
server `previous` (`getTrafficSummary.previous` — the true equal-length prior window, SAME D1 source as current, so the ratio
is source-consistent). Replaces the pageviews tile's `pvTrend` halve-the-series proxy (kept as a fallback when `siteTraffic`
is null, e.g. the CF-zone path) with `pvDelta`, and adds `visitorDelta` on the **Visits** tile (`uniques` = `uniqueSessions`
on the D1 path via `envelopeFromTraffic`, so no IPs-vs-sessions conflation). Honest `deltaBadge`: up/down/flat with the exact
window in the hover ("vs the previous N days"), **"new" (never ∞%)** when the prior period was zero, `null` when there's nothing
to compare. Frontend-only (data already served). +6 Karma (up/down · new · null-both-zero · flat · no-siteTraffic · chip
renders) → 1997. Deployed R2 + chunk-hash prod-verified (`chunk-4NR7DMXE.js`, `kpi-pv-trend`).

**Conversions-tile Δ badge — DONE (2026-09-24).** The Conversions card now carries the SAME authoritative period-over-period
badge as the KPI tiles: a new `conversionDelta` computed feeds `deltaBadge(traffic.conversions, traffic.previous.conversions,
windowDays)` into `ConversionsCardComponent` via a new `delta` input, rendered as a trend chip (`[data-testid=an-conv-trend]`)
beside the "N total". Compares the authoritative `conversions` scalar across both periods (same metric/source, not a re-summed
breakdown) — source-consistent with `pvDelta`/`visitorDelta`. Honest: `null` (chip hidden) when there's nothing to compare,
never a fake "0%"; "new" when the prior period was zero. Extracted the `TrendBadge` view-model to a shared `trend-badge.model.ts`
(one type for producer + both consumer cards, no duplicate). Frontend-only (`previous.conversions` already served by both summary
paths). +6 Karma (card: chip-when-delta · no-chip-when-null; component: compute 25% · new/null · null-no-traffic · card wiring)
→ 2008. Deployed R2 + chunk-hash prod-verified (`chunk-3SPBOWJE.js`, `an-conv-trend`).

**Conversions-by-kind Δ — DONE (2026-09-24).** Each conversion-kind ROW now carries a per-kind period-over-period Δ chip
(calls ↑, form-submits ↓), not just the total. Server: `getConversionKinds` refactored onto a shared
`conversionKindsForClause` + a new `getPreviousConversionKinds` (the `previousWindow` predicate) → both summary paths add
`previous.byConversionKind` (Zod-defaulted `[]` for back-compat). Frontend: `conversionKindDeltas` (parent computed, `label →
TrendBadge` via the same authoritative `deltaBadge`) feeds a new `kindDeltas` input on `ConversionsCardComponent`; each row shows
a small `trend-chip--sm` (`[data-testid=an-conv-kind-trend-<raw>]`) keyed by raw label. Honest: a kind absent from the prior
window → "new"; nothing to compare → no chip; SR aria prefixes the kind label. +5 Jest (3 previous-window predicate/wiring + 2)
+ 5 Karma → 12304 Jest / 2033 Karma. Deployed; prod-verified live SHAPE: `previous.byConversionKind` present (current
`[{call:2}]`, prior `[]` — honest empty for this site).

**Bespoke CSV exports → shared helper (2026-09-24).** Migrated the client-built CSV exports onto the shared
`toCsv`/`csvEscape`/`downloadText` (one tested, formula-injection-safe code path): **forms** (`buildSubmissionsCsv` — dropped
the bespoke `csvCell`) + **audit** (`buildCsv`/`exportCsv` — dropped the bespoke `csvCell` + `csvFormulaGuard`). Net safety
improvement: the shared `csvEscape` EXEMPTS plain numbers from the `'` formula-prefix (the old guards corrupted `-2`→`'-2`),
while still guarding formula-SHAPED strings (`-2+cmd()`→`'-2+cmd()`). `events-table` + `site-detail` already used the shared
helper. Specs updated (forms `\n`+trailing-newline; audit unit tests re-pointed at `csvEscape` incl. the numeric-exemption
improvement) → 1999 Karma green. Deployed R2 + chunk-hash prod-verified (forms `PQRGT2D7`, audit `LN7JEF2J`).

NEXT highest-value gaps — the section is at a verified no-dep plateau (audience/delivery/CSV/custom-lookback/definitions/
shareable-range + arbitrary-window + tz-aware bucketing/bounds + comparison-period Δ + CWV rating/distribution/affected-pages +
device/browser/OS + bot-filtering disclosure + **tech-breakdown-in-CSV** all complete; `byBrowser`/`byOs` CSV rows shipped, and
`analytics-dashboard`'s hand-rolled CSV download was **consolidated onto the shared `downloadText`** — cycle 2026-09-24, which was
also hardened with an SSR/non-DOM guard).
✅ **SHIPPED (cycle 2026-09-24) — Hourly "Busiest hours" breakdown.** `getHourlyBreakdown` returns 24 UTC hour-of-day pageview
buckets (`byHour`), read LIVE in both summary paths (like CWV/browser/OS); `<app-hourly-breakdown>` rotates them to the viewer's
LOCAL time via a pure `rotateToLocalHours` — the LEANER design that needed NO tz-plumbing through the route/summary — showing a
24-bar strip + a "Peak: 7–9 PM · N views" insight + an honest empty state + the local-time / half-hour-zone caveat; the CSV export
gains `hour_local,HH:00,count` rows. Verified: `byHour` returns real data via the API (`[{hour:12,count:4},{hour:19,count:4},…]`),
worker version `f1cd19fc` @ 100%. +2 worker Jest, +9 Karma. What remains, in priority order:
1. **DST-precision** — the fixed browser offset is approximate for a range spanning a DST change; a true IANA-zone shift needs a tz
   library or per-timestamp `Intl` offset (D1's SQLite only does fixed `±HH:MM` modifiers). Documented caveat in the UI today —
   honest but not exact. Low ROI (~twice a year, near midnight).
2. **audit full-trail CSV download** intentionally stays a hand-rolled blob-`<a>` (fetched `res.blob()` + append-to-DOM anchor) — a
   genuinely different case from `downloadText`'s client-built text (blob→text semantic change + Firefox anchor-in-DOM). Cosmetic;
   not worth the behavioral risk.
- Plan-blocked (need a CF plan upgrade, not code): **Security/WAF** (`firewallEventsAdaptiveGroups` — no entitlement) + **latency
  percentiles**. Honestly absent in the UI, never faked.
