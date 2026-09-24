# Analytics Coverage Matrix (honest metric → source map)

> Loop deliverable for the Analytics-section epic. Source of truth for what each
> metric MEANS, where it comes from, and whether it's actually available for a
> given site. **Never show 0 for an unavailable metric, or an estimate as exact.**
> Started 2026-09-23. Update every increment so it agrees with the code.

## Two data sources (do not conflate)

- **D1 `visitor_events`** — first-party on-site **beacon**. Columns: `id, org_id,
  site_id, session_id (anon), event_type (pageview|click|conversion|custom), path,
  referrer, metadata (JSON), created_at` (`migrations/0532_visitor_events.sql`).
  This is per-`site_id` accurate for EVERY site including `*.projectsites.dev`
  subdomains. It measures pageviews / uniques (by session_id) / paths / referrers /
  sections / forms. It is NOT HTTP-request/bandwidth/status/cache/WAF data.
- **Cloudflare zone GraphQL** `httpRequestsAdaptiveGroups` — **edge** HTTP metrics
  via `src/services/cloudflare_analytics.ts` (`CF_API_TOKEN`, zone `75a6f8d5…`).
  **CRITICAL: empty for `*.projectsites.dev` subdomains** — CF doesn't surface
  subdomain traffic at the zone level; only a site on a custom apex domain in our
  zone gets edge metrics. So for most tenant sites the beacon is the ONLY source.

### Reconciliation guard (already shipped)
`analytics.component.ts:1603-1619` — when the CF-edge envelope is missing/`!any_real_data`
but D1 `visitor_events` has pageviews, it rebuilds the envelope from D1 and relabels
`trafficSource` → **beacon** (not edge). This is why the old "0 traffic for a site with
109 real pageviews" incident (2026-08-20) no longer happens. Keep this invariant.

## Tenancy (authorization)
`requireOwnedSite` (`libs/features/site_analytics/handlers.ts`) resolves `:siteId` →
`SELECT org_id FROM sites WHERE id=? AND deleted_at IS NULL`, compares to the caller's
`orgId`, returns **404** (never 403) on mismatch. Hostname allow-set is derived
server-side; a client-supplied hostname/zone/filter is never trusted for authz.

## Endpoints
- `GET /api/sites/:siteId/analytics` — summary envelope (pageviews, uniques,
  total_requests, bounce, top_pages, top_referrers, by_country, `any_real_data`).
- `GET /api/sites/:siteId/analytics/daily` — daily series, live D1 `GROUP BY date`.
- `GET /api/sites/:siteId/analytics/sections` — per-section conversions (`data-ps-section`).
- `GET /api/sites/:siteId/analytics/forms` — form_start vs form_submit.

## Matrix (metric · source · availability · retention · UI · status)

| Metric | Source | Availability | Retention | UI | Status |
|---|---|---|---|---|---|
| Pageviews | D1 beacon | every site | D1 (unbounded) | KPI tile | DONE |
| Unique visitors (by session) | D1 beacon | every site | D1 | KPI tile | DONE |
| Bounce rate | D1 beacon | every site | D1 | KPI tile | DONE |
| Total HTTP requests | CF edge | **apex-on-zone only; empty for subdomains** | ~30 d | KPI tile (reconciles to beacon) | DONE (honest fallback) |
| Daily trend | D1 beacon | every site | D1 | line chart | DONE |
| Top pages | D1 beacon (`GROUP BY path`) | every site | D1 | Top-pages list | DONE |
| Top referrers | D1 beacon | every site | D1 | Referrers list | DONE |
| Geography (country) | D1 beacon (`metadata.country`) / CF edge | beacon per site | D1 | Countries list | DONE |
| Section conversions | D1 beacon | every site | D1 | (endpoint) | DONE |
| Form starts/submits | D1 beacon | every site | D1 | (endpoint) | DONE |
| **Comparison vs prior period (Δ%)** | D1 beacon | every site | D1 | KPI tiles | **SLICE (this fire)** |
| Devices / browsers / OS | beacon `metadata` (needs UA capture) | only if beacon records UA | D1 | — | BLOCKED (instrument beacon first) |
| Status codes / errors | CF edge | apex-on-zone only | ~30 d | — | PLANNED (honest "not available for subdomains") |
| Cache hit/miss + bandwidth saved | CF edge | apex-on-zone only | ~30 d | — | PLANNED |
| Security (bot / WAF / challenges) | CF edge firewall dataset | apex-on-zone + plan | — | — | PLANNED |
| **Core Web Vitals (LCP/INP/CLS)** | CF Web Analytics RUM **or** our beacon | **beacon NOT deployed → unavailable** | — | — | BLOCKED (needs RUM instrumentation; a CNAME alone does NOT collect browser metrics) |
| Custom date range / timezone | D1 beacon | every site | D1 | date picker | PARTIAL |
| CSV export | D1 beacon | every site | D1 | — | PLANNED |

## Honesty rules (enforced)
- CF-edge metrics on a subdomain → show **"Not available for projectsites.dev
  subdomains"**, never 0.
- CWV → show **"Real-user performance not measured — RUM beacon not deployed"**,
  never a fabricated score.
- Every surface labels its **source** (beacon vs edge) + a **freshness** timestamp.

## Next increments (priority order)
1. Comparison-period Δ% on KPI tiles (this fire).
2. Honest "capability/source" panel — explicitly list which datasets are active vs
   "not available on this plan / for subdomains" for the selected site.
3. CSV export of the current view (bounded).
4. Devices/browsers — only after the beacon captures UA (instrument first).
5. Core Web Vitals — only after a RUM beacon is deployed + verified per site.
