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
| Conversions | D1 visitor_events (beacon) | none | site_id | D1 | none | ✅ live | conversions card |
| Top pages / paths | D1 visitor_events | none | site_id | D1 | none | ✅ live | top-pages table |
| Referrers | D1 visitor_events | none | site_id | D1 | none | ✅ live | referrer table |
| Geography (country/city/region) | D1 metadata ← `request.cf` | none | site_id | D1 | none | ✅ live | geo breakdown |
| Device / browser / OS | D1 metadata ← `enrichVisitor(ua)` | none | site_id | D1 | none | ✅ live | device breakdown |
| Channel / UTM | D1 metadata ← referrer+path | none | site_id | D1 | none | ✅ live | channel breakdown |
| Daily time series | D1 visitor_events / analytics_daily | flag `analytics_rollup_read` | site_id | D1 | none | ✅ live | line chart |
| Funnel (landing→engaged→converted) | D1 visitor_events | none | site_id | D1 | none | ✅ live | funnel widget |
| Forms / completions | D1 form_submissions | none | site_id | D1 | none | ✅ live | forms tab |
| Period-over-period deltas | D1 visitor_events | none | site_id | D1 | none | ✅ live | comparison |
| CF requests/bandwidth/cache/status | CF GraphQL httpRequestsAdaptiveGroups | custom domain in CF zone | per hostname | 30 days | adaptive sampled | ⚠️ fallback-only, not surfaced as its own view | — |
| **Core Web Vitals (LCP/INP/CLS)** | — (needs CF Web Analytics beacon or RUM) | Web Analytics beacon on site | per hostname | — | — | ❌ **missing** | — |
| **Security (WAF/bot/challenges)** | CF GraphQL firewall/security datasets | custom domain in zone (WAF plan) | per hostname | plan-dependent | — | ❌ missing | — |
| **CSV export / custom range / comparison / TZ** | (UI) | none | — | — | — | ❌ partial/missing | — |
| Source + freshness labels in UI | (UI) | none | — | — | — | ⚠️ verify present | — |

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
Verify whether a CF Web Analytics beacon is injected into generated-site HTML at build (grep the
template/site output for `static.cloudflareinsights.com` / a RUM beacon). If absent → implement a
first-party `web_vital` beacon (client `web-vitals` lib → `/api/events` → visitor_events) with a
"measurement enabled?" gate + p75 LCP/INP/CLS cards labeled estimated/sampled. Add tenant-isolation
test for the new event type. Otherwise wire CF Web Analytics per-hostname read for custom domains.
