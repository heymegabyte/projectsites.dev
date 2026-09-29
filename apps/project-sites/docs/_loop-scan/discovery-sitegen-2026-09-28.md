# Discovery — Site-generation quality (loop fire, 2026-09-28)

> Read-only discovery/audit output for Lane 7 (site-generation quality — the CORE product).
> Feeds `_RUN_THE_LOOP.md` § "### 7. Site-generation quality". Deduplicated against the existing
> queue + §4.4. A future fire folds the un-done items into the live queue (queue file was held by
> a concurrent cron fire this round, so parked here — the canonical `docs/_loop-scan/` home).

## 8 next-wave tasks (ranked by product impact; `[READY]` = <2h)

1. **[READY] `build_validators.ts` report→strict via `VALIDATOR_MODE` env, canary-scoped.** Today mode = `'report'` (`build_validators.ts:7-8`), never throws; `site-generation.ts:2431` only logs `scoreReadiness` to D1. Slice: add `VALIDATOR_MODE` (default `report`) → throw path in `validateBuild()` → canary via `flag_overrides` scope=one org.
2. **Competitor-research floor gate into Phase -1.** `competitor_research.ts` skeleton never wired (`_LOOP_LEDGER.md:346-354`); `deepcrawl.ts` client exists; pipeline only scores US-vs-our-prior. Slice: `researchCompetitors(deepcrawl, urls[])` → `_competitors/*_score.json` → `competitors_floor_breached` bool into `buildPrompt()` context; flag `deepcrawl_competitor_research` (OFF).
3. **[READY] Post-publish SEO-audit crawler → admin surface.** `snapshot-quality-workflow-production` exists (`wrangler.toml:302`) but unhooked (`site-generation.ts:473` "does not block this build"). Slice: `POST /api/sites/:id/audit-trigger` → workflow crawls live site, maps violations to the 13 validator codes → D1 `site_audits` → admin Data→Audits read.
4. **[READY] Promote cinematic flags `word_reveal`/`line_draw`/`clip_reveal` ON-by-default on filled sections.** Slice: locate the 3 keys in `feature_flags`, set `enabled=1, rollout=100, stage='stable'` via admin UI after an opt-in-% check.
5. **Idempotency stress-test + codify.** Version minted inside `step.do()` (`site-generation.ts:718-722`); snapshot at `:2290`. Slice: fire the same site-gen 3× parallel → assert byte-identical outputs + 1 audit entry per build; codify in CLAUDE.md § Idempotency.
6. **Per-step retry config audit.** Transient patterns at `site-generation.ts:300-309`, no explicit per-step `retries`. Slice: grep `onError`/`catchError`; add `exponentialBackoff{initialDelayMs:500,maxRetries:3}` on npm-install steps; test against a known-failing build.
7. **Banned-words coverage audit.** 13 terms (`build_validators.ts:40-62`). Slice: sample 10 recent published sites for slop not in the list; add 3-5 rows if gaps.
8. **Hero-pack default detection expansion.** 13 hardcoded defaults + recolor regex (`build_validators.ts:792-822`). Slice: audit 20 recent sites for missed pack defaults; add patterns; flag `hero_customization_low` (warn, non-blocking).

## Sub-area NOT reached (rotate here next fire)
- Competitor-research floor THRESHOLD calibration — `_competitor_aggregate.json` convention exists but no rubric for "floor breached" (what % below market baseline triggers a rebuild recommendation). Next discovery fire: define the quality bar + runbook.
