# Generated-site product + pipeline — scan + recommendations

Scope: the delivered `{slug}.projectsites.dev` sites + the generation pipeline. Files cited absolute.

## Pipeline stages + gates (current)

- **Workflow** `src/workflows/site-generation.ts` (2767 lines). Status machine
  `draft→collecting→imaging→generating→published|error|archived` (`updateSiteStatus`, anchors
  `status != 'published'` to survive stale 2nd-instance races AL-379).
- **Stages**: (1) research-profile → (1b) google-places → (2 parallel) social/brand/selling-points/images
  → (2.5) move-uploads/generate-logo/favicon-set/section-images/discover-brand-images/discover-videos/store-context
  → (2.5b) scrape-website → (2.6) seed-site-data → (3) structure-plan → (4-5) **container build** (single
  Claude Code orchestrator, ~25-40min) → upload-to-R2 + flip `published` → (5) visual-inspection-final (GPT-4o, non-blocking).
- **Container** `container/local-agent.mjs` (55K): ~15min wall-clock cap → **fast-path = MINOR CUSTOMIZATION** of
  `~/template/` (a complete WCAG-AA multi-page site) with real data, NO fan-out, NO audit swarm. Deeper QA deferred
  post-publish to `snapshot-quality` workflow. **The CLAUDE.md "20-30 prompt / parallel-subagent-swarm" philosophy is
  NOT what the time-boxed fast-path runs** — real doctrine/impl drift. [HIGH]
- **Build gates** `src/services/build_validators.ts` (2231 lines, `validateBuild` runs **31 validators**): required-files,
  asset-existence, image-format (PNG>200KB), image-alt, og-image, apple-touch-icon, meta-lengths (title 50-60/desc 120-156),
  **unique-page-titles**, jsonld-count(≥4)/jsonld-structure, single-H1, no-dev-modules, color-scheme, **indexable(no noindex)**,
  html-lang, canonical, sitemap-lastmod/routes-exist, banned-words, **hero-not-pack-default**, no-brand-placeholders,
  brand-name-match, js-bundle-size, lightbox-presence, theme-font-loader, no-client-secrets, contact-path,
  image-weight-budget, **conversion-framing**, route-count. Mode still **`report`** (logs, never throws) — invariants
  documented BUILD-BREAKING but not yet enforced `strict`. [HIGH]
- **Readiness score** `src/services/production_readiness.ts` — A-F/0-100 from violations; `passing` only at A/B + 0 security errors.
- **Theme** `src/services/theme_style.ts` (44K) — 16 presets (classic/editorial/warm/luxe/brutalist/bold/futuristic/rugged/
  botanical/boutique/precision/heritage/scholarly/noir/retro/artisan). Logo-luminance → light/dark polarity (`theme_polarity.ts`).
- **Beat-source harness** = `src/workflows/snapshot-quality.ts` (28K, `meanScore`, `site_benchmarks` regression vs prev).

## Section catalog (current) + top quality recs [HIGH/MED]

- **Required (generate_website.prompt.md)**: Hero(full-vh) · Selling-points/Features · About(≥2 internal anchors) ·
  Services/Categories · Google-Maps · Contact/NAP(tel:) · FAQ(≥5 + "Built by ProjectSites" item) · footer.
- **Per-vertical (container/prompts/industry-prompts.mjs + local-agent.mjs)**: restaurant→menu/chef/ambiance/reservations;
  salon→services-pricing/before-after/booking; legal→practice-areas/attorney-profiles/case-results/consultation;
  medical→services/provider-credentials/HIPAA; saas→bento-features/how-it-works/pricing-tiers/integrations;
  fitness→classes/trainers/membership/schedule/transformation; real-estate→property-cards/agent-stats/market-stats;
  contractor→before-after/process/certifications/service-areas; photographer→masonry-portfolio/packages.
- **AI-native surfaces shipped** (`src/generated/app_js.ts` universal runtime): (1) upgrade-bar (unpaid),
  (2) click-to-directions detection, (3) INP self-reporting, (4) **AI Concierge chat FAB** → `POST /api/chat/<slug>`
  (per-vertical RAG `concierge_knowledge.ts`); **page-audio AI summary** (`page_audio.ts`, MeloTTS) + Twilio voice.

Recs:
- [HIGH] Flip validators `report → strict` for the proven template (gates exist but don't block — a thin/broken build ships).
- [HIGH] Reconcile the fast-path vs the swarm doctrine: either the time-box runs a real (bounded) parallel enrich pass or
  CLAUDE.md's "20-30 prompts + 7-agent fan-out" is demoted to the post-publish `snapshot-quality` loop only.
- [MED] Section catalog is prose-in-prompts, not a typed registry — no enum, no per-section Zod, no coverage test. Extract a
  `SECTION_CATALOG` module (name·vertical·required-data) so builds + validators + tests share one source (drift-safe).
- [MED] `validateConversionFraming` + `validateHeroNotPackDefault` exist but there's no **JSON-LD-matches-visible-content**
  check nor a per-route **BreadcrumbList presence** gate for ≥2-deep routes (memory: jsonld consumer-without-producer class).
- [MED] No CWV/LCP/INP gate at build time (only post-publish Lighthouse) — add hero-image `fetchpriority`+dimensions +
  no-decorative-hero-video validators (TTFR class: hero video becomes LCP).

## New sections + AI-native surfaces to add [prioritized]

- [HIGH] **Quotable-answer block** + **FAQ accordion** as first-class required sections everywhere (GEO/AI-search floor);
  today FAQ is required but the AEO one-sentence answer + `<app-rolling-counter>` stat band are not.
- [HIGH] **Trust strip / proof band** (licenses, years, review stars) — memory flags hardcoded/lying proof-stats; make it a
  section sourced from real research data with a self-hiding guard (no datum → render nothing).
- [HIGH] **Per-page AI podcast** (3-min, MeloTTS/Piper, self-hosted per doctrine) — page_audio already exists; extend from
  summary→narrative episode per route; **AI-narrated 404**.
- [MED] Maximalist catalog gaps (doctrine lists, pipeline lacks): **before/after slider** (only "concept cards" today),
  **bento/asymmetric grid**, **timeline/process**, **live-data / rolling-counter stats**, **interactive calculator**
  (quote/savings), **resource library**, **glossary**, **donor wall** (nonprofit), **press strip**, **local sticky bar**.
- [MED] **AI-native**: multimodal contact form (photo+voice→structured intent), behavioral hero swap, GPT-annotated POI map,
  per-visitor generated PDF (brochure/quote), voice tour. All CF-native (Workers AI + Browser Rendering + R2).
- [MED] **View Transitions + scroll-driven motion** as a template baseline (gorgeous-by-default) — verify synced template.

## Beat-source / competitor-floor recs

- [HIGH] Doctrine mandates OUR build **outscore every competitor on every dim by ≥15%**, but the pipeline has NO
  competitor-research gate (no `_competitor_aggregate.json` floor, no ≥15% loop). `snapshot-quality` scores US vs our own
  prior run, not vs the source/competitors. Add a source+competitor scoring pass feeding a hard floor. [HIGH]
- [HIGH] "BEAT the source" is aspirational prose — add an automated **source-vs-rebuild reconcile** (content parity: every
  source route + image group round-trips; 1:N page count; denser copy) as a gate, not a philosophy.
- [MED] Wire `production_readiness` grade + `snapshot-quality` meanScore into a single **published-site scorecard** surfaced
  in admin, and block promotion below a threshold (currently non-blocking / advisory).
- [MED] Add per-route **OG-image branded-card** generation check (og validator checks size only, not that it's a branded
  card vs raw photo) + JSON-LD FAQPage-only-when-real enforcement (prompt says it; no validator asserts it).
