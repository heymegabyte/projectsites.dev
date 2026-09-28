# ProjectSites.dev Pricing Model + /pricing Page — Build Spec

> Brian directive 2026-09-28. Charge **exact cost of everything in a site's WfP namespace**
> (no Cloudflare membership/base fees) + a flat platform fee + pass-through usage.
> This doc is the SSOT for the cost engine, the `/pricing` page, the apps-catalog price
> fields, and the Super-admin pricing controls.

## Philosophy

- **We charge the exact metered cost of every asset assigned to the site's single CF WfP
  namespace** (its dispatched Worker(s), per-site D1, per-site R2, any per-site Container
  compute), PLUS every **sub-site** (installed app like Payload/Umami) metered the SAME way
  under its own namespaced resources.
- **We do NOT pass through Cloudflare account-level membership/base fees** (Workers Paid $5/mo,
  Workers-for-Platforms $25/mo). Those are our platform overhead, recovered by line item #2.
- Everything is attributable because each site + each installed app gets its OWN named
  Worker + D1 (`d1_database_id` in `site_database_allocations`) + R2 bucket/prefix. Meter each
  via the CF GraphQL Analytics API × unit price. (Reuse the client in
  `src/services/cloudflare_analytics.ts`.)

## The 10 charge components (a site's monthly bill = Σ)

1. **Namespace resource cost** — exact CF cost of all assets in the site's namespace:
   Worker requests+CPU, D1 rows-read/written+storage, R2 storage+ops, Vectorize/KV/Queues if
   used. Each attribute's unit price lives in a Super-admin-editable `pricing_config` table.
2. **Platform fee — $50/month per site** (flat; covers our CF base + engineering + support).
3. **AI usage** — pass-through of model spend, reported per API token OR per browser-report
   line (`analytics.captureLLMCall`/AI Gateway `$ai_*`). Super-admin can modify AI price by a
   **% multiplier** (markup or discount).
4. **Production R2 snapshot storage** — exact storage cost of everything under `sites/` in R2
   for that site (all versioned production snapshots) at the R2 storage unit price.
5. **CF Workers + Containers compute** — attributed to the site's WfP namespace: Worker
   CPU-ms + Container vCPU-sec/GiB-sec. (Containers hibernate at idle → near-zero at rest.)
6. **Voice (Twilio, simplified)** — we bill a single **per-minute** rate for phone time that
   bundles ElevenLabs TTS, PLUS a per-minute browser-time charge, PLUS a special-service
   charge for WebRTC voice / anything beyond plain phone. Rates in `pricing_config`.
7. **Social posts** — cost **per post per network** (X, LinkedIn, Instagram, Facebook,
   Bluesky, TikTok, …). Each network's per-post price is Super-admin-editable.
8. **Exa** — pass-through cost of every Exa search/contents call.
9. **Features** — cost of any capability enabled in the site's "Features" section (each
   feature module carries a `unit_cost` in `pricing_config`).
10. **Other quantifiable costs** — any remaining metered third-party/API spend attributable
    to the site (SES email, image-gen, domains at cost). Generic pass-through bucket.

## Unit prices (Cloudflare published, marginal — NO base fee)

| Resource | Metric | Unit price (default; Super-admin editable) |
|---|---|---|
| Worker | requests | $0.30 / M |
| Worker | CPU | $0.02 / M CPU-ms |
| D1 | rows read | $0.001 / M |
| D1 | rows written | $1.00 / M |
| D1 | storage | $0.75 / GB-mo |
| R2 | storage | $0.015 / GB-mo |
| R2 | Class A (write/list) | $4.50 / M |
| R2 | Class B (read) | $0.36 / M |
| R2 | egress | $0.00 |
| Container | compute | ~$0.0000025 / GiB-s + vCPU-s (CF Containers) |
| Vectorize | queries / stored dims | per CF |
| KV | reads/writes/storage | per CF |

Fixed platform base we ABSORB (not billed): Workers Paid $5/mo + WfP $25/mo.

## Apps catalog — two new printed prices per app

Add to `apps-catalog.data.ts` (frontend) + `src/data/apps-catalog.ts` (worker) for EVERY app:

- **`scaleToZeroMonthly`** — what you'd pay if provisioned and left **idle** (scale-to-zero).
  For Worker-based apps (Payload, Umami…) this is ~**$0** (only idle D1/R2 storage, no compute).
  For Container apps, ~storage + note "sleeps after 30m idle" (near-zero, cold-start on wake).
- **`aiEstimatedMonthly`** — the realistic **normal-usage** monthly "according to AI" (an
  AI-estimated typical bill for that app's resource profile). Seed from current
  `estCostMonthly` as the AI baseline; label it "AI-estimated typical".

Catalog card + apps-detail render BOTH: e.g. "Idle $0/mo · Typical ~$5/mo (AI-estimated)".

## apps-detail "MONTHLY ESTIMATE" module

- Copy becomes: **"Estimated — a function of your actual usage."**
- The "MONTHLY ESTIMATE" heading LINKS to `/pricing` (how we charge, in detail).
- Keep the CF breakdown lines; add "Idle (scale-to-zero)" + "Typical (AI-estimated)" rows.

## Super-admin pricing controls (new surface + D1)

- New D1 table `pricing_config` (Super-admin CRUD): one row per priced attribute —
  `{ key, label, category (1-10), unit, unit_price_usd, ai_pct_modifier?, network?, enabled }`.
- Super-admin section (under the existing Super-admin/System layer) to edit every unit price,
  the **AI % modifier** (#3), the **per-social-network per-post** price (#7), the flat
  **$50/site** (#2), and each feature `unit_cost` (#9). Audit every change (`feature_flag_audit`
  pattern). Killswitch-safe defaults = the table above.
- Worker endpoints: `GET /api/admin/pricing-config`, `PATCH /api/admin/pricing-config/:key`
  (super-admin-gated), `GET /api/sites/:id/cost` + `GET /api/apps/instances/:id/cost` (metered
  rollup for the owner). Flag `pricing_engine` (dark → 404).

## /pricing page (the headline — cinematic, Angular)

- New route `/pricing` → `frontend/src/app/pages/pricing/pricing.component.ts` (Angular 21
  standalone, signals, inline template+styles, brand tokens `--ps-bg #060610`/`--ps-accent
  #00E5FF`, matches existing marketing pages). Register in `app.routes.ts`; add to worker
  known-routes + SSR `<head>` (title/desc/canonical/OG) + sitemap.
- **Content**: hero ("You pay what it costs. Plus $50."), the 10-component breakdown as
  gorgeous tables, a **live cost example** (a sample site's itemized bill), a **competitor
  comparison** table (vs Vercel, Netlify, WP Engine, Squarespace, Webflow, Wix — show their
  flat/opaque tiers vs our exact-cost + $50), an **idle-vs-typical** app-price table pulled
  from the catalog, an FAQ (JSON-LD `FAQPage`), and a CTA. `Product`/`Offer` + `BreadcrumbList`
  JSON-LD. WCAG 2.2 AA, 6 breakpoints, `prefers-reduced-motion`.
- **Cinematic**: scroll-reveal, gradient/grain, bento, count-up on the "$50" + savings deltas,
  animated comparison bars. House cinematic bar (LCP ≤2.0s, INP ≤100ms, CLS ≤0.05).

## Visual-polish loop (next wave)

- After v1 ships, run **10 iterations** of visual inspection (Browserbase screenshot →
  critique → refine) on `/pricing`, each measurably more beautiful, AI-vision ≥9/10 at 6
  breakpoints. Track in a loop ledger. This is a `/loop`-style continuation, not one turn.

## Build waves

1. **Wave 1 (this turn, fan-out):** `/pricing` v1 page · apps-catalog `scaleToZeroMonthly` +
   `aiEstimatedMonthly` + catalog/detail render · cost-metering service + read-only endpoints ·
   apps-detail MONTHLY-ESTIMATE → /pricing link + "function of usage" copy. Deploy + prod-verify.
2. **Wave 2:** Super-admin `pricing_config` table + controls UI + audit; wire the 10 components
   to live metering; Stripe metered-price emission (approval-gated — pricing behavior change).
3. **Wave 3:** the 10× cinematic visual-polish loop on `/pricing`.
</content>
