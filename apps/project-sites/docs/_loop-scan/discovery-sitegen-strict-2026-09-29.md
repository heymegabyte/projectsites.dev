# Discovery — site-gen strict-canary readiness (Lane 7, loop fire 2026-09-29)

> Read-only re-audit after fire-3 shipped `VALIDATOR_MODE` (report→strict). Feeds Lane 7 / §4.4.
> Dedup'd against `discovery-sitegen-2026-09-28.md` (fire-1). Headline: the strict-mode engine
> exists but is GLOBAL env-only — a safe canary needs per-org scoping + a false-positive pass first.

## Next-wave tasks

1. **[SITEGEN · READY] Per-org `VALIDATOR_MODE` scoping for a canary.** `site-generation.ts` calls `resolveValidatorMode(env.VALIDATOR_MODE)` GLOBALLY — no way to strict-test one org without a full prod flip. Slice: check a `flag_overrides`/`orgs.validator_mode_override` before `resolveValidatorMode` in the workflow's validate-build step (mirror the `per_site_data`/`durable_preview` scoped-override pattern). Then strict can pilot on the E2E org only.
2. **[VALIDATOR · READY] False-positive audit before any strict flip.** Before enabling strict, run the 13 validators against ~10 KNOWN-GOOD published sites → classify each error (real vs false positive). Highest FP risk: `png_too_large` (200KB cap may be tight for modern builds w/ AVIF siblings), `h1_count` (dynamic-hydration shells). Slice: `scripts/audit-validator-false-positives.mjs` (strict-eval real builds, report per-site, loosen thresholds / add exclusions). MUST run before task 1's canary goes strict.
3. **[SCORE · READY] Surface the readiness grade in admin + gate promotion.** `production_readiness.ts` computes `{grade,score,passing}` + logs to `workflow_jobs`, but it's NOT surfaced. Slice: `GET /api/admin/sites/:id/readiness` (read latest grade from the audit log, no rebuild) + a site-detail tile + optionally block/warn promotion below a grade threshold.
4. **[COMPETITOR] Competitor-research floor gate (still unwired).** `deepcrawl.ts` exists but no `analyzeCompetitors()`; the pipeline scores US-vs-our-prior only. Slice: `analyzeCompetitors(deepcrawl, urls[])` → `_competitors/aggregate_score.json` → `competitors_floor_breached` bool into `buildPrompt()`; flag `deepcrawl_competitor_research` (OFF). Define the floor rubric first (what % below market = breach).
5. **[VALIDATOR · READY] Banned-words expansion.** Current 13 slop terms; production B2B leakage adds "industry-leading/standard", "proven", "trusted experts", "comprehensive", "complete/full-featured solution". Sample 10 live sites → add ~5 confirmed.
6. **[VALIDATOR · READY] Hero-pack default detection expansion.** 13 hardcoded + 4 regex tells; missed recolor signatures: "crafted for you", "tailored for your", "designed to be", "at your fingertips", "helping you succeed". Sample 20 published hero H1s → add ~5 regex.

## Sub-area NOT reached (rotate next fire)
- Competitor floor THRESHOLD calibration (the rubric for "breached") · the fast-path-vs-swarm doctrine reconcile.
