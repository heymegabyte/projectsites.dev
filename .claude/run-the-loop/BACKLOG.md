# BACKLOG — the canonical actionable queue

> The single source of truth for `/run-the-loop` work units. Cadence-tagged, executable
> without asking. Migrated 2026-09-29 (fire-50) from `apps/project-sites/_RUN_THE_LOOP.md`
> + `_LOOP.md`. Cross-links: [`./README.md`](./README.md) · [`./DISCOVERIES.md`](./DISCOVERIES.md)
> · [`./LEDGER.md`](./LEDGER.md). Granular lane state stays in the per-workstream sub-ledgers
> (`_PROMOTE_WORKFLOW_CHECKPOINT.md`, `_CF_NATIVE_CONVERGENCE.md`, `docs/wfp-site-hosting.md`,
> `docs/data-platform-scope.md`, `_ADMIN_VQA_LEDGER.md`, `_INTERCONNECTEDNESS_LEDGER.md`).
>
> **The money path is Brian's #1 — its items are HIGH.** Every item ships behind a flag
> (`enabled=0, rollout=0, stage='experimental'`), TDD-first, deployed + prod-verified, `git add -f`
> (`.gitignore` blocks `*.md`), straight to `main`. Feature flag = server 404 when off, UI null.
>
> **Cadence values:** `once` · `every-loop` · `every-2-loops` · `every-4-loops` · `every-8-loops`
> · `every-16-loops` · `daily` · `weekly`. Item shape:
> ```
> - [ ] <title>
>   - cadence · priority · category · estimate · depends_on · discovered_by
> ```

---

## LAUNCH BAR — definition of public (Brian 2026-10-01; quiet launch when all green)

- [ ] LB-1 gp-05 money path green — stranger can search → build → pay $29/mo claim → entitlement unlocks → invoice; Stripe test-rail automated in CI
  - cadence: every-fire-until-green · priority: highest · category: money-path · estimate: 2-3 fires · depends_on: pricing-claim-flow · discovered_by: launch-bar
- [ ] LB-2 gallery of 10 showcase-grade sites — real local-business verticals, frontier-vision ≥9/10 each, WebGL-era templates, linked from homepage gallery
  - cadence: every-2-fires · priority: high · category: product · estimate: rolling · depends_on: webgl-templates · discovered_by: launch-bar
- [ ] LB-3 gp-09 stable at targets — 3 consecutive recreate cycles <5 min live / ≤$1 build with truthful Resources panel + 0 unknowns
  - cadence: every-2-fires · priority: high · category: testing · estimate: rolling · depends_on: gp-09 · discovered_by: launch-bar
- [ ] Delivered-outbound rail — lead-scanner → pre-generate preview site → SES outreach with live link → claim CTA on preview top-bar → $29/mo Stripe claim checkout → owner onboarding; reuses gp-09 generation muscle + golden-journey email verify
  - cadence: every-fire · priority: highest · category: money-path · estimate: 3-4 fires · depends_on: pricing-claim-flow · discovered_by: gtm-delivered-outbound
- [x] (fire-60 `f8d0cecfe`, flag-dark; frontend CTA + promote pending) Pricing claim-flow implementation — $0 preview → $29/mo claim: Stripe product/price, claim CTA + checkout, entitlements gate custom-domain/AI-ops/email, unpaid top-bar copy becomes the claim pitch
  - cadence: next-fire · priority: highest · category: money-path · estimate: 1 fire · depends_on: none · discovered_by: pricing-decision
- [ ] Intent-first chat edit rail — "What do you want to change?" chat performs site edits (AI does, owner confirms, undo always); bolt.diy editor demoted to Advanced tab via progressive disclosure; editor investment only where it feeds this rail
  - cadence: every-2-fires · priority: high · category: product · estimate: multi-fire · depends_on: none · discovered_by: edit-surface-decision

- [x] (fire-62 c1782f4ad/6123224b — true cause was worker editor-proxy CSP literal, drift-test locked) Evict stale editor hostname claimer — editor.projectsites.dev still routes to the OLD bolt-diy.pages.dev project despite active re-attach + DNS repoint; enumerate /pages/projects/*/domains, remove the stale registration, verify localhost CSP + admin embed live
  - cadence: next-fire · priority: high · category: architecture · estimate: 20m · discovered_by: fire-61
- [x] (fire-62 c0083b595 + image 3847a81e via 1f590b23) Container-internal AI token metering — build_metrics rows show tokens 0/0 (orchestrator-side calls unmetered inside container); bridge usage out to the finalize row so $-per-build includes model spend
  - cadence: next-fire · priority: high · category: product · estimate: 1h · discovered_by: gp-09-cycle-1
- [ ] Eager per-site D1 provisioning on create-from-search (today lazy on first Data-tab GET) + gp-09 cycle-2 with preferred_slug:"lone-mountain-global" to restore fixture slug
  - cadence: next-2-fires · priority: medium · category: product · estimate: 1h · discovered_by: gp-09-cycle-1

- [x] Destructive-opt-in silent downgrade class — purge_resources (and audit siblings) must NEVER silently downgrade when the body is lost: body-parse failure on a destructive flag → 400, and every destructive response echoes `{purged:true|false}` for caller assertion (gp-09 cycle-2 incident) — DONE fire-63: `DELETE /api/sites/:id` now `.catch(() => null)` + non-object guard → `badRequest` 400 (was `.catch(() => ({}))` silent no-op); response echoes `{purged:<number>}` (dedicated resources torn down) for caller assertion; IDOR guard `requireOwnedSite` already present; +4 regression tests in `site_delete_subscription.test.ts`
  - cadence: next-fire · priority: high · category: architecture · estimate: 45m · discovered_by: gp-09-cycle-2
- [x] (fire-63: created 7 new vertical.json packs — plumbing·logistics·restaurant·saas·medical·retail·professional-services — each carrying a `webgl` block tuned to its distinct presets.mjs theme; validateWebGLConfig clean, tsc 0; local-service first) WebGL block coverage — wire `webgl` blocks into the remaining 7 vertical.json packs (local-service first: gp-09 fixture classifies there) so generated sites actually carry the tuned heroes
  - cadence: next-fire · priority: high · category: product · estimate: 30m · discovered_by: gp-09-cycle-2
- [ ] Generated-brand quality cluster (vision 7/10): wordmark dark-on-dark + garbled glyph render, eyebrow AA fail, pack-default H1, irrelevant stock hero — root-cause in logo/theme/copy pipeline; ties to LB-2 gallery bar
  - cadence: next-2-fires · priority: high · category: product · estimate: 1-2 fires · discovered_by: gp-09-cycle-2

- [ ] Editor feature continual-verification sweep (Brian: "ensure ALL bolt.diy editor features work continually") — Deep UI Explorer owns a recurring pass that drives EVERY editor toolbar control + panel (sticky/minimap/split/inline-diff view toggles, Code/Diff/Preview, Data tab, terminal, file tree ops, SQL console) in a real authed embed and asserts each produces its effect; catches the dead-useState class (diff's fileHistory was `useState({})` w/ no setter — fixed fire this turn). Add a drift gate flagging any `useState` whose setter is never destructured on an interactive toggle
  - cadence: every-2-fires · priority: high · category: testing · estimate: 1 fire · discovered_by: brian-2026-10-01

## FRONTIER 0 — Constitution bootstrap (fire-59 opened)

> `./CONSTITUTION.md` landed 2026-09-30 and now governs the loop. These items bootstrap its
> required core infrastructure; they lead every fire until closed.
> **NORTH STAR (Brian 2026-10-01, through ~Oct-31): WEBSITE GENERATION SPEED + COST** —
> every fire ranks work by its effect on time-to-live-site and $-per-build first.

- [x] (fire-61 `414e5302b` admin card + gp-09 measured 5m29s/$0.071) Generation speed+cost instrumentation — measure p50/p95 wall-clock search→live and $-per-build (AI tokens, container minutes, CF calls) per site build; persist per-build rows; surface a trend in admin; set baseline then drive to <5min live / ≤$1 per build (Brian 2026-10-01) via template fast-path, parallel passes, cache reuse, cheaper models where quality holds; enforce owner-draft/public-gated serving
  - cadence: every-fire · priority: highest · category: product · estimate: 2h-first-slice · depends_on: none · discovered_by: brian-north-star
  - [x] (fire-63 `750ab3138`, prod-verified 401-gate live) flag-gate + feature-module close-out — the fire-60/61 build_metrics instrument shipped UNFLAGGED; added the DARK `build_metrics` flag (registry + docs + e2e spec ref), gated GET /api/admin/build-metrics/summary (auth 401 → flag 404-never-403 → super-admin 403, flag before super-admin per admin_leads), and the `libs/features/build_metrics/` module (7-field manifest + handler re-export + README). TDD RED-first (404-when-off + gate-order tests). Gates: tsc 0 · jest 14092 · validate:features 0 · e2e-inventory green · frontend tsc 0. Also registered 3 pre-existing orphan specs (per-site-data-panel · r2-buckets · wfp-site-hosting) to green the inventory gate.
- [x] (fire-61: ALL 10 industries ≥8/10, gate 11/11, template repo synced 0a5eabe) WebGL industry-themed templates — EVERY industry template pack gets a WebGL treatment (hero/background shader, motion-reduced fallback) PERFECTLY themed to its industry (restaurant/nonprofit/retail/professional/…); gate per template: canvas-mount probe + screenshot + frontier-vision ≥8/10 (black-broken-shader class is vision-only-detectable); patterns flow back to template.projectsites.dev same fire
  - cadence: once-then-maintain · priority: highest · category: product · estimate: 1-2 fires · depends_on: none · discovered_by: brian-2026-10-01
- [x] (fire-60 `5146105a1`, adversarial-verified live) Resources > Advanced truth repair (DEFECT, lying-empty class) — on lone-mountain-global the panel shows 0 for every resource type plus 4 "unknown resources" while the site holds ≥1 R2 version-tree + 1 D1 allocation; reconcile DISPLAY vs AUTHORITATIVE stores (site_database_allocations · R2 listing · WfP dispatch namespace script · KV host/manifest keys · custom hostnames) per verify-against-source-of-truth; every row NAMED + typed with owner-grade copy ("Your site files (R2)", "Your site database (D1)"), zero "unknown" rows ever (label it or don't list it); auto-updating, no manual reconcile
  - cadence: once · priority: highest · category: product · estimate: half-fire · depends_on: none · discovered_by: brian-2026-10-01
- [ ] gp-09 destructive-recreate golden loop (STANDING) — lone-mountain-global is the designated SACRIFICIAL regen fixture (Brian 2026-10-01: full regeneration explicitly authorized for THIS slug, standing): each cycle DELETE the site completely (R2 versions, D1 allocation, KV keys, WfP script, hostname rows) → re-create through the normal generation path (WebGL-themed template era) → RECORD wall-clock search→live + $-per-build (feeds north-star baseline) → verify Editor Resources > Advanced truthfully shows ≥1 R2 + 1 D1 + every other allocated resource, 0 unknowns → frontier-vision QA ≥8/10 on the regenerated site using ANTHROPIC vision or Unified-Billing OpenAI (NOT Workers-AI) → owner-draft/public-gated respected → ledger receipt
  - cadence: every-2-fires · priority: highest · category: testing · estimate: 1-fire-setup · depends_on: webgl-templates + resources-truth · discovered_by: brian-2026-10-01
- [x] (fire-61 `3b0f06963` — 78 ghosts, schema 572→629, apply=no-op) D1 migration-tracking drift — prod `d1_migrations` reports 10+ ANCIENT migrations (0020, 0507, 0518, 0530, 0560, 0566, 0597, 0607, 0649…) as unapplied on a working schema; blanket `migrations apply` re-runs history and dies on dropped tables (ai_endpoints). Reconcile tracking rows to prod reality (schema-diff proves each already-applied, then INSERT ghost rows; fire-58 0651 + fire-60 0652 precedent), then prove `migrations apply` runs clean
  - cadence: next-fire · priority: high · category: architecture · estimate: half-fire · depends_on: none · discovered_by: fire-60-migration-apply
- [x] (fire-60 `d1dabc929`) domain-stack.component.ts still has a manual Refresh button (same doctrine class as the fixed domains.component.ts one) — replace with the visibility-aware poll pattern
  - cadence: once · priority: medium · category: ux-a11y · estimate: 30m · depends_on: none · discovered_by: fire-59-admin-agent
- [x] (fire-60 `d1dabc929`, 2.4s cold/0.6s warm live) Admin Analytics entry renders a >10s skeleton wall before first paint — add progressive/partial paint or cached-first render
  - cadence: once · priority: medium · category: product · estimate: 1h · depends_on: none · discovered_by: fire-59-evaluator

- [ ] Genome rebuild test — give a CLEAN-CONTEXT agent only the repo + `./GENOME.md` + one bootstrap prompt; it must state what the product is, how it runs/tests, what's incomplete, and what happens next; every confusion becomes a genome repair item
  - cadence: every-4-loops · priority: high · category: loop-improvement · estimate: 45m · depends_on: GENOME.md · discovered_by: constitution-bootstrap
- [ ] Behavior coverage map — seed the STATE → ACTION → RESULTING-STATE graph for admin + editor (routes, menus, dialogs, tables, forms, keyboard); generate golden paths that traverse untouched areas
  - cadence: once · priority: high · category: testing · estimate: 90m · depends_on: none · discovered_by: constitution-bootstrap
- [ ] Browser Operating Layer slice 1 — Agent Browser Profile Vault schema (profile per account/site/integration/purpose; Freeze Profile capture + restore/reset/revoke/audit; encrypted + tenant-isolated) per `./BROWSER-OPERATING-LAYER.md`
  - cadence: once · priority: high · category: architecture · estimate: 2h · depends_on: BROWSER-OPERATING-LAYER.md · discovered_by: constitution-bootstrap
- [ ] Visual coverage rotation — first rotation pass through `./VISUAL-COVERAGE.md` debt: open, screenshot, vision-critique the least-recently-inspected significant surfaces/states; log verdicts + extract design principles
  - cadence: every-loop · priority: high · category: ux · estimate: 45m · depends_on: VISUAL-COVERAGE.md · discovered_by: constitution-bootstrap
- [ ] Golden-path gp-01..gp-08 activation — run the eight journeys in `./GOLDEN-PATHS.md` against prod; record every missing capability as a CAPABILITY GAP item (never shrink a journey to make it pass)
  - cadence: every-loop · priority: high · category: testing · estimate: 90m · depends_on: GOLDEN-PATHS.md · discovered_by: constitution-bootstrap
- [ ] Org observability dashboard concept — make autonomy legible: agents/work-in-progress, browser sessions + screenshots/recordings, golden-path failures, visual/stub/delight debt, token-yield trends, pending human interventions (concept + data sources first, UI later)
  - cadence: once · priority: medium · category: product · estimate: 2h · depends_on: none · discovered_by: constitution-bootstrap
- [ ] Champion/challenger design reviews — pilot on ONE high-value surface: render the champion (current) + a deliberately improved challenger, use both in a real browser, keep the winner; record the verdict in VISUAL-COVERAGE
  - cadence: every-2-loops · priority: medium · category: ux · estimate: 60m · depends_on: none · discovered_by: constitution-bootstrap
- [ ] Constitution champion/challenger evaluation — after ~4 fires, evaluate whether the constitution-governed loop beats the pre-fire-59 model (completion rate, defect escape, visual quality, token yield); fold evidence back into `./CONSTITUTION.md` per its § Recursive Improvement
  - cadence: every-4-loops · priority: medium · category: loop-improvement · estimate: 45m · depends_on: 4 fires of LEDGER data · discovered_by: constitution-bootstrap
- [ ] Cloud runner slice 1 — GitHub Actions scheduled `/run-the-loop` (`.github/workflows/run-the-loop.yml`): `anthropics/claude-code-action@v1` + `CLAUDE_CODE_OAUTH_TOKEN` repo secret from `claude setup-token` (Max subscription auth — NEVER `ANTHROPIC_API_KEY`: ≈$9.6K–27K/mo at our 130–216M tok/day vs $200/mo Max), `on: schedule */20 * * * *`, `concurrency: group: run-the-loop` as the CI fire-lease, `timeout-minutes: 25` + `--max-turns` governor exposed as repo vars, prompt reads the in-repo `run-the-loop` command + constitution (self-updating), fire transcript uploaded as artifact; quota-neutral vs the Mac loop; Mac harness cron becomes dormant fallback; slice 2 = CF Cron Trigger → Container runner (~$40–70/mo compute, same OAuth rail) per `./RUNNER-AND-CRITICS.md`
  - cadence: once · priority: high · category: loop-improvement · estimate: 90m · depends_on: none · discovered_by: fire-59-research
- [ ] Vision-critic ladder wiring — route screenshot art-director critiques through AI Gateway as: PRIMARY Gemini 2.5 Flash-Lite (≈$0.31/1000, free tier ~1K RPD covers 200/day; 2.5 Flash deprecates 2026-10-16 — pin Lite alias) → SECONDARY Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` ($0 inside 10K free neurons/day ≈ 250 critiques) → ARBITER OpenAI gpt-5-mini via **Unified Billing** (CF prepaid credit wallet pays OpenAI/Google/Workers AI; 5% credit fee, pass-through token rates; enable: dash → AI Gateway → Credits → Top-up + set Workers AI billing to Unified); set a $10/mo gateway spend limit; <$5/mo at 200/day; replaces the OpenAI-429/Anthropic-$0 ladder in deep-ui-explorer per `./RUNNER-AND-CRITICS.md`
  - cadence: once · priority: high · category: testing · estimate: 2h · depends_on: none · discovered_by: fire-59-research

---

## money-path (Brian #1 — HIGH)

- [~] Backfill WfP slots for all existing sites (batched, idempotent) — fire-51: script `scripts/backfill-wfp-slots.mjs` shipped (`5676c8329`), proven on search-verify (both slots `ok:true`); cross-org sweep needs the internal super-admin endpoint (see § fire-51 replenish)
  - cadence: once
  - priority: high
  - category: architecture
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: WfP is now the DEFAULT serving path (arc CLOSED on prod fire-50 — `x-ps-serve: wfp`
    proven for `search-verify`). Every existing site still serves from R2. Batch-deploy the WfP
    `preview`+`production` slots for all published sites via `deploySiteToWfp` (proven end-to-end,
    `ok:true, assetCount≥1`). MUST be idempotent (re-POST returns same release, no recompute drift)
    + batched (avoid CF rate limits) + fail-soft to R2 per site. Trigger: `POST /api/diag/wfp-deploy
    {siteId, slot}` per site, or a batched internal sweep. Verify a sample → `x-ps-serve: wfp`.

- [ ] Deliberate `site_wfp_hosting` rollout widening (beta → more orgs)
  - cadence: every-4-loops
  - priority: high
  - category: architecture
  - estimate: 30m
  - depends_on: Backfill WfP slots for all existing sites (batched, idempotent)
  - discovered_by: fire-50
  - context: Flag enabled SCOPED to `e2e-test-org` only (reversible `flag_overrides` row). Widen
    the rollout org-by-org via `/admin/feature-flags` (or scoped override rows) once slots are
    backfilled; after each widen, WebFetch a member site → assert `x-ps-serve: wfp` styled 200.
    Serve gate: `site_serving.ts:97` (`isFlagOn 'site_wfp_hosting' {orgId,siteId}`). Reversible via
    soft-delete of the override row. Do NOT flip global-on until backfill + monitoring confirm.

- [ ] Golden journey: create → build → publish → view → analytics (real E2E on PROD)
  - cadence: every-2-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §B.2. The money path: `/create` a real test business (Vito's Mens Salon, 74 N
    Beverwyck Rd, Lake Hiawatha NJ) → it BUILDS for real → view generated site → editor change a
    requirement → live site updates → publish. Real auth, real build, real edit, real publish,
    reconciled against source of truth (`verify-against-source-of-truth`). Homepage-start, navigate
    by UI clicks only. Wire a durable probe into `e2e/admin-verify/run-all.mjs`. Never mocked/smoke.

- [ ] Billing-full flow E2E (headless prod) — checkout → subscription → entitlement
  - cadence: every-4-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §B.4-B.7. Guest funnel · billing-full · editor round-trip · auth. Reconcile
    Stripe checkout → `subscriptions` row → `/api/billing/entitlements`. `plan` and `status` are
    orthogonal — `active` vs `trialing` both entitle. Never submit a real card in a manual pass; a
    test card belongs in the E2E suite. Assert entitlement gate is fail-CLOSED on transient.

- [ ] Analytics reconcile — displayed counts vs D1 `visitor_events` (per-subdomain)
  - cadence: every-4-loops
  - priority: high
  - category: bug
  - estimate: 90m
  - depends_on: Enable Analytics Engine ingest (per-subdomain RUM)
  - discovered_by: repository-audit
  - context: Prior lying-empty incident — `/admin/analytics` showed "never had traffic" for a site
    with 109 real pageviews (UI read CF-zone metrics, empty for `*.projectsites.dev` subdomains).
    Reconcile display-vs-store per `verify-against-source-of-truth`: query D1 `visitor_events` for the
    real org, hit the surface as the real user, flag `groundTruth>0 && display==0` as LYING-EMPTY.
    Add date-range + compare-to-prior across cards. Reuse `e2e/admin-verify/reconcile-surfaces.mjs`.

---

## feature

- [ ] WfP fast-follow (Functions convergence Stage 4+) — binding injection + runtime + versioning + observability
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: `docs/FUNCTIONS-CONVERGENCE.md` core COMPLETE. Stage 4+: inject per-site bindings into
    the Functions runtime, versioning, per-function logs/metrics in the editor, cold-start/cost
    guards. Code-defined endpoints in a site's `functions/` folder on Workers-for-Platforms (ADR-0035,
    replaces the removed AI-Agents dashboard feature). `wfp_dispatch.ts` is the KEPT WfP plumbing.

- [ ] Sora/Veo video generation module (`libs/features/media_generation_video/`)
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: fire-42
  - context: `src/services/media.ts:557` — the "TODO when Sora/Veo APIs land" comment IS the whole
    impl; Sora API is now public. Stand up a flag-gated feature module wiring the OpenAI Sora endpoint
    + generate route + D1 job queue (queued generation, workflow callback flips status — mirror the
    existing `POST /api/media/generate/video` shape). Ground-truthed fire-42.

- [ ] Pricing config engine (Wave 2) — D1 `pricing_config` table behind `pricing_engine_v2`
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 2h
  - depends_on: none
  - discovered_by: fire-42
  - context: `src/services/site_cost.ts:113,141,480` — 3 hardcoded pricing values with
    `TODO(pricing_engine)` markers (base rates + container compute). Also `voice.ts:233,286`
    hardcoded `monthly_cost_cents:100`. Create a D1 `pricing_config` table, backfill, wire refs behind
    the `pricing_engine_v2` flag. Prerequisite for self-serve pricing tiers (no-deploy price changes).
    Flag `pricing_engine` + `validator_strict` + `voice_numbers` + `r2_bucket_manager` FLAG_DOCS exist.

- [ ] Public REST API v1 — promote `public_api` to beta
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 4h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06 [HIGH]. `psk_live_*` keystore + OpenAPI 3.1 + scoped tokens ship DARK today.
    Expose `GET/POST /api/v1/sites`, `/v1/sites/:id/deploy`, `/v1/sites/:id/db/*`, `/v1/media`,
    `/v1/forms/submissions` behind the token middleware. The "deliver websites programmatically" wedge.
    Flag→beta with Zod + tests + prod-verify. Zod-derive the OpenAPI (`@asteasolutions/zod-to-openapi`).
    CAMPAIGN lane 3 (AI API Keys) EXTENDS this same `psk_live_*` keystore — ONE token DB, never a second.

- [ ] Enable Analytics Engine ingest (per-subdomain RUM/event sampling)
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: `ANALYTICS_INGEST_ENABLED="false"` — the CF-native metrics backend the doctrine mandates
    isn't writing. Deferred from Wave D (collided with psnotify on `wrangler.toml`). Flip scoped-on,
    verify per-subdomain RUM/event sampling, reconcile display-vs-store. Analytics Engine (not PostHog)
    is the default high-volume metrics backend per infra doctrine.

- [ ] psnotify follow-on — email/push fan-out adapters + unify bell onto the DO + promote flag
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 10. `PsNotifyDO` inbox shipped (dark, deployed). Add fan-out to in-app/email(SES)/
    web-push adapters so `notifyUser` lights the bell; point `/notifications` at the DO inbox (retire
    the `audit_logs`-derived `activity_feed` — producer↔consumer drift today); DO WebSocket/SSE push
    (kill the 60s poll); server-persist preferences off `localStorage` to D1 + enforce via
    `resolvePrefs`/`routeNotification`. Promote `psnotify` flag THEN verify the AUTHED inbox journey
    (never a 401 probe — false-green lesson). Notification source is psnotify DO, NOT a d1 table.

- [ ] Command palette (Cmd+K deep-actions) + Cmd+P fuzzy file open — editor + admin
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 02/08 [HIGH] — biggest embarrassingly-easy + keyboard win. Admin palette is
    nav-only; add verbs (create site · deploy · rollback · invite teammate · toggle flag) + fuzzy
    jump to any setting (Linear model). Editor lacks both Cmd+K + Cmd+P entirely. One entry to every
    action/file/route. ~+25% power-user completion per brief 08.

- [ ] AI inline code edit + explain in CodeMirror (`EditorPanel.tsx`)
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 02 [HIGH] — highest AI-native leverage. Select→edit / hover→explain; today AI lives
    only in the chat column. Inline/no-chat AI beats a bolted-on sidebar (AI-permanence + embarrassingly-
    easy). Reuse the existing `PS_SUBMIT_PROMPT` admin-relay bridge pattern (per Rev 7 Data-tab).

- [ ] Editor Data Platform post-arc backlog (ideas 14/15 + capability-matrix gaps)
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 3 — Rev 1-10 arc + Calendar + Insights + KV-preview all DONE (per-site D1, flag
    `per_site_data`, each editor-Pages-deployed). Remaining: broaden typed cell editors for INSERT
    add-row (stable-id plumbing); Phases 2-6 of `data-platform-scope.md` (schema builder + rich
    fields · AI copilot SQL-hidden · views/forms/automations/auto-REST-API · backup/search/governance
    · KV editor + wire Files panel to the site's R2). Reads the site's OWN D1, never shared platform.

- [ ] App catalog — cf-native migrations + new members + drift close
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 4h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 03 [HIGH]. Convert Umami → cf-native (D1 + Analytics Engine); make Payload the
    template every new member copies; surface ~10 wired-but-uncatalogued DO classes (~47 exist);
    close catalog↔`supported`↔infra drift (LiteLLM live at `llm.megabyte.space` but `supported:false`,
    one SSOT reconcile — LiteLLM line → folded into CAMPAIGN lane 9: resolve by REMOVAL, not
    `supported:true`); new members (Cal.com #1 SMB ask, NocoDB/Teable over per-site D1, Ghost,
    Chatwoot). Gate container-centric copy on `image?.startsWith('cf-native:')`. Never reduce DO
    subclasses (deploy-break 10064 — only ADD).

---

## test

- [ ] MCP connect buttons need `data-testid`
  - cadence: every-loop
  - priority: med
  - category: test
  - estimate: 30m
  - depends_on: none
  - discovered_by: fire-46
  - context: Per-provider "Connect"/"Add API key" buttons (rendered from `mcp-providers.ts` in
    `settings.component.ts` + `forms.component.ts`) have no `data-testid` → E2E can only target by
    brittle index. Add `data-testid="mcp-${id}-connect"` to each. (Note: fire-46 shipped this in
    `settings.component.ts` — verify `forms.component.ts` coverage.)

- [ ] Drain 7 stale E2E cohorts (details-modal, domain-files, ai-workflow, …)
  - cadence: every-4-loops
  - priority: med
  - category: test
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 7. 7 stale E2E cohorts need retargeting/repair. Editor verify MUST run the FULL
    Vitest suite (`npm test`, not scoped) — scoped runs hid 10 pre-existing RED editor tests across ≥3
    fires. Worker verify runs the full Jest suite (874 suites / 13819 tests). Per
    `handler-change-breaks-existing-contract-tests-run-full-suite`.

- [ ] E2E for admin cockpit/attention-queue/KPI/CWV surfaces
  - cadence: every-4-loops
  - priority: med
  - category: test
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-50
  - context: `dashboard.component.ts` (2199 LOC) — no E2E for the operator cockpit / needs-attention
    queue / KPI tile strip / CWV surfaces. Real-user journey against PROD, homepage-start.

---

## golden-path

- [ ] Full-flow E2E: guest funnel + auth round-trip (headless prod)
  - cadence: every-4-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §B.4-B.7. Guest funnel (homepage search → business select → signin gate) + editor
    round-trip + auth. Real E2E sign-in (`test@megabyte.space`, `TEST_USER_PASSWORD`), navigate by UI
    clicks only. Assert PERSISTENCE (navigate away → return → hard-refresh) + cross-feature effect.
    apex POST hits CF Bot-Fight 403 (known) — verify authed mutations via workers.dev host.

- [ ] Generated-site quality journeys (§C — the CORE product, deployed sites)
  - cadence: every-4-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §C/D. Generated-site quality (deployed `{slug}.projectsites.dev`) + platform
    marketing/SEO. The generated site must BEAT the source — more beautiful, faster, more accessible,
    denser. Reconcile page count = source sitemap (1:N). Verify JSON-LD-matches-visible-content, per-
    route meta, favicon set ships. Vision-QA generated sites via authed iframe (they 403 headless).

---

## ux

- [ ] Empty states as launchpads sweep (voice · forms · leads · apps · domains · site-features)
  - cadence: every-loop
  - priority: med
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] + `embarrassingly-easy-to-use`. Every empty state = the ONE button that
    creates the first result. Many shipped fire-43→50 (social composer, leads, team, webhooks, create
    search, billing caps-modal). Continue: wire `mini-empty` into any remaining passive "no data" state.
    Never a dead-end — always a first-action CTA.

- [ ] Entitlement/seat/flag-locked controls show reason + upgrade CTA (never a dead button)
  - cadence: every-2-loops
  - priority: med
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] + `action-button-must-gate-on-server-precondition`. Never present a doomed
    control. billing, site-features, team. A button that will fail (precondition unmet, seat limit,
    missing config) is disabled WITH the reason + the fix, or hidden. site-features shipped
    `lockedCtaLabel(f)` per-entitlement fire-50 — continue across billing/team.

- [ ] Real-time everywhere / kill remaining Refresh+Reconcile buttons
  - cadence: every-loop
  - priority: med
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] + `real-time-data-no-manual-refresh` (Brian directive). A manual Refresh/
    Reconcile/Reload/Sync button is a DEFECT — the surface should already be current. Many killed
    (analytics, audit, site-dna, site-data-browser, feature-flags, voice conversations,
    ResourceOverviewPanel). Remaining editor targets: BucketsPanel, DatabasePanel, NamespaceSummary,
    ImportPanel, LockManager, ProjectHub, EnvAssignmentGrid. Visibility-aware poll / SSE / `PS_*` push.

- [ ] Restore Preview responsive/device switcher (`Preview.tsx` — `isDeviceModeOn=false` orphaned)
  - cadence: every-8-loops
  - priority: med
  - category: ux
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 02 [HIGH]. Device list coded but `isDeviceModeOn=false` (orphaned — interconnected-
    ness). Wire back + a 6-breakpoint quick toggle. Adjacent orphan to reconnect same fire.

- [ ] Preview boot-timeout message → mirror into editor CHAT (Msg-3b remainder)
  - cadence: every-8-loops
  - priority: low
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: fire-41
  - context: `Preview.tsx:1172` DOES render a "No preview available" card on the 60s WebContainer
    cold-boot timeout. The ACTUAL missing piece (Msg-3b): MIRROR the boot-timeout into the editor CHAT
    — emit a `logStore` message / `onBootTimeout?()` callback so the AI learns boot stalled. Scope to
    the chat-mirror only (fire-41's "unwired" framing was imprecise; ground-truthed).

- [ ] Inspector → AI round-trip (Preview element → "change this" chat/inline patch)
  - cadence: every-8-loops
  - priority: med
  - category: ux
  - estimate: 90m
  - depends_on: AI inline code edit + explain in CodeMirror (`EditorPanel.tsx`)
  - discovered_by: repository-audit
  - context: brief 02 [HIGH]. Click element in Preview → "change this" as a chat/inline patch, not
    just `ElementInfo`. Reuse the `PS_SUBMIT_PROMPT` admin-relay bridge.

---

## a11y

- [x] Domains VQA a11y — `domain-manager` popover `aria-modal` + focus-trap; button width jitter — SHIPPED fire-51 (`71dcf4a8b`, reused `FocusTrapDirective`, Karma 2369✓, frontend R2)
  - cadence: every-2-loops
  - priority: med
  - category: a11y
  - estimate: 45m
  - depends_on: none
  - discovered_by: fire-43
  - context: Parked `docs/_loop-scan/discovery-domains-2026-09-29.md`. `domain-manager.component.ts:
    48-56` popover needs `aria-modal="true"` + focus-trap; button text-width jitter (`:131-134`, min-w
    7ch→11ch). H1 already covered by the `check-admin-h1.mjs` gate. (Domains refresh-button width +
    analytics freshness label + apps-detail subdomain `aria-describedby` all shipped fire-43.)

- [ ] Playwright a11y spec across the 4 CF-resource inspectors + shared `list-select` directive
  - cadence: every-8-loops
  - priority: low
  - category: a11y
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-50
  - context: kv/r2/vectorize/queues inspectors now share ONE ARIA 1.2 listbox keyboard model (roving
    tabindex, `role=listbox/option/aria-selected`). Follow-on: a Playwright a11y spec across all 4 +
    extract a shared `list-select` directive to dedupe the 4 copies (interconnectedness).

---

## architecture

- [ ] error_handler.ts is 331 LOC — extract business logic out of middleware (fire-51 agent died mid-run, 0 commit — retry fire-52 via § fire-51 replenish CARRIED item)
  - cadence: every-4-loops
  - priority: med
  - category: architecture
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-49
  - context: `src/middleware/error_handler.ts` embeds `brandedErrorPage()` (68 LOC CSS-in-JS HTML) +
    R2-specific `10042→503` mapping (:254-292) — violates inverted-abstraction (middleware ≤200 LOC).
    Extract `brandedErrorPage`/`prefersHtml` → `src/lib/error_pages.ts` + the R2 mapping → a typed
    `StorageUnavailableError` thrown from `site_serving.ts` (caught generically). Shrinks to ~150 LOC.

- [ ] social.component.ts god-component split (slices 3+: composer+preview, dialogs)
  - cadence: every-2-loops
  - priority: med
  - category: architecture
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 4 big item. Was 2676 LOC → 2446 after slices 1-2 (social-accounts, social-post-list
    extracted). Remaining: extract `social-composer` (+preview), `social-dialogs` into standalone
    presentational OnPush components. Byte-identical markup, parent keeps data-fetch/OAuth. Clears the
    `anyComponentStyle` 28KB budget WARN. Run FULL Karma on each slice.

- [ ] Admin god-component splits (analytics, billing, snapshots, settings, site-data-browser)
  - cadence: every-8-loops
  - priority: low
  - category: architecture
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] (perf + a11y). `analytics` 134K, `billing` 138K/2790ln, `social` 131K,
    `snapshots` 109K, `settings`/`site-data-browser` ~88K, `domains` 1079ln, `ai-logs` 1501ln,
    `site-detail` 1459ln, `dashboard` 2199ln → lazy `@defer` per tab; each folded tab needs its own
    single `<h1>` (the `check-admin-h1.mjs` gate enforces this — verify after each split).

- [ ] Relocate editor `app/` → `apps/editor/`
  - cadence: once
  - priority: low
  - category: architecture
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Root `TODO.md` + `_LOOP.md` §5. Discrete relocation pass: root `wrangler.toml`, vite
    configs, `functions/`, `electron/`, CF Pages `bolt-diy` settings. Editor build + Pages deploy
    verify (by hash, not grep). Per monorepo convention (`style-guide-driven-decisions`): every
    deployable app under `apps/`.

- [ ] Cold-provision migration-apply pipeline — fold 0646 apply so it can't drift
  - cadence: once
  - priority: med
  - category: architecture
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Migration 0646 (`site_working_tree`+`site_releases`) was the FALSE-GREEN behind Promote —
    an unapplied migration hidden by the auth/ownership guard. Applied to prod D1 fire-B. TODO: fold
    the prod migration-apply into the deploy pipeline so a migration can't silently go unapplied.
    Per `unapplied-migration-hidden-by-auth-guard-is-false-green`.

- [ ] Add Vectorize semantic leg (semantic site search / "sites like mine" / concierge grounding)
  - cadence: every-16-loops
  - priority: low
  - category: architecture
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06/08 [MED]. The missing D1+Vectorize+DO leg. `RAG_INDEX` binding exists
    (`projectsites-rag`, 768-dim cosine). Wire semantic search / "sites like mine" / concierge
    grounding through Vectorize + AutoRAG (`src/services/rag.ts` has embed/indexChunk/semanticSearch).

- [ ] Retire `apps/web` v2 Angular plan + decide Electron desktop packaging
  - cadence: once
  - priority: low
  - category: architecture
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Root `TODO.md`. `.cleanup-allowlist` references a non-existent `apps/web` dir — resolve or
    retire. Decide Electron desktop packaging — remove unless desktop distribution is a real goal
    (one-way-door: write the self-argument before deleting).

---

## security

- [ ] Rate-limit fail-CLOSED for expensive/abuse-sensitive routes (per-route policy) — DESIGN
  - cadence: every-8-loops
  - priority: high
  - category: security
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-49
  - context: DESIGN Rec (needs the call before coding). `src/middleware/rate_limit.ts:231-262` falls
    through UNMETERED when `CACHE_KV` errors — now LOGGED, but fail-open lets an attacker who induces
    KV congestion abuse expensive routes (media-gen $, SES). Likely answer: fail-CLOSED only for
    expensive/abuse-sensitive routes (per-route policy), fail-open for cheap reads. Blanket fail-closed
    would 429 the whole site on a KV blip.

- [ ] Server-side last-owner removal guard — VERIFIED SECURE (close-out check)
  - cadence: every-16-loops
  - priority: low
  - category: security
  - estimate: 15m
  - depends_on: none
  - discovered_by: fire-49
  - context: FALSE POSITIVE — the server DOES enforce it (`ai_admin.ts:266` counts owners + throws 409
    "Cannot remove the last owner" before the DELETE, org-scoped IDOR asserted, 3 TDD cases green).
    Listed only as a periodic re-verify anchor; no work unless a regression surfaces.

- [ ] Idempotency middleware onto all money/site-mutation POSTs
  - cadence: every-8-loops
  - priority: med
  - category: security
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06 [MED]. Wire `idempotency` middleware onto `/billing/*`, `/domains/purchase`,
    `/sites/:id/deploy`. Per `sync-ui-async-backing` idempotency-key convention (`Idempotency-Key`
    header → `crypto.randomUUID()` fallback → `INSERT OR IGNORE`). Fire-and-forget charges need a
    source idempotency key.

- [ ] Zod on the 23 `req.json().catch(()=>({}))` cast routes (per-feature, on promotion)
  - cadence: every-8-loops
  - priority: med
  - category: security
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: `src/routes/features.ts` ~33 handlers read bodies as `as`-cast with NO runtime validation
    (forbidden by zod-everywhere). DORMANT — every endpoint is `requireFlag`-gated on a default-OFF
    flag (404 in prod, ZERO overlap with the 12 enabled flags). Convert PER-FEATURE as each flag is
    promoted to beta/stable, with a unit test per endpoint. NEVER mass-retrofit blind. Same pattern
    (smaller) in `media.ts`, `env_vars.ts`, `ai_admin.ts`.

---

## dead-code / hygiene

- [ ] audit-dead-code — orphan sweep + verify-before-delete batch
  - cadence: every-loop
  - priority: med
  - category: dead-code
  - estimate: 30m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 5 recurring. Run `scripts/detect-orphans.mjs` + knip; wire the highest-value orphaned
    unit into a reachable surface the same fire (interconnectedness — built-but-unwired = not done).
    Verify 0 real + 0 dynamic callers BEFORE deleting (knip false-positives: namespace/dynamic refs).
    Dead-code well is largely DRY (function/const exports exhausted); pivot to genuinely uncovered
    areas — generated-site runtime, template repo, editor `app/`. Backlog parked in
    `docs/_loop-scan/discovery-deadcode-2026-09-29.md`.

- [ ] restoreDeletedSnapshot — VERIFIED WIRED (close-out check)
  - cadence: every-16-loops
  - priority: low
  - category: dead-code
  - estimate: 10m
  - depends_on: none
  - discovered_by: fire-48
  - context: `app/lib/persistence/projectSnapshots.ts:208` — verified WIRED (`ProjectHub.tsx:299`
    Undo-delete toast), NOT an orphan (the brief premise was stale). Periodic re-verify anchor only.

- [ ] revokeApiToken fail-soft — distinguish D1 error from not-found
  - cadence: every-8-loops
  - priority: low
  - category: hygiene
  - estimate: 20m
  - depends_on: none
  - discovered_by: fire-48
  - context: `src/services/api_tokens.ts:244` `.run().catch(() => null)` → a D1 error on revoke returns
    false ("not revoked"), conflating outage with not-found. Fail-SAFE (never falsely claims revoked)
    so low severity, but a silent revoke failure during an outage is confusing — surface the error,
    distinguish from not-found.

- [ ] Prune leftover `.claude/worktrees/agent-*` + regenerate lockfile
  - cadence: every-4-loops
  - priority: med
  - category: hygiene
  - estimate: 30m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Root `TODO.md` + `_LOOP.md` §5. ~68 leftover `.claude/worktrees/agent-*` — `git worktree
    prune` + explicit `git worktree remove` + `git branch -D` per fire (stranding incident class).
    Lockfile: `npm install --legacy-peer-deps` (removed workspace members still listed; `pnpm install`
    FAILS on electron-builder SSH dep).

- [ ] Source TODO/FIXME triage (useChatHistory FIXME + @deprecated shims)
  - cadence: every-8-loops
  - priority: low
  - category: hygiene
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: `app/lib/persistence/useChatHistory.ts:416` FIXME — navigate fn rerenders `<Chat/>` +
    breaks the app (deliberate workaround, needs a real fix test-first). Deferred-lowvalue `@deprecated`
    shims: `external_llm.ts:193`, `smtp_config.ts:19`, `browser_gateway.ts:44` (remove when callers
    migrate). Blocked-external: `abuse.ts:36` arcjet Workers adapter. TODOs are roadmap — triage, don't
    blanket-delete.

---

## dx (recurring gates)

- [x] lockfile-drift CI/pre-commit gate — SHIPPED fire-51 (`cfc581dd7`, non-mutating copy→regen→restore + CI gate)
  - cadence: once
  - priority: high
  - category: dx
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: P1 gate. This class RECURS (6+ "regenerate pnpm-lock" commits + a ~30-run silent-red
    pipeline — every worker commit stranded). Add a gate that fails when `pnpm install --lockfile-only`
    would change `pnpm-lock.yaml` (per `drift-detection` + audit-arc-maturity-ladder), so a silently-
    red deploy pipeline can't recur. Per `worker-deploy-silently-red-for-many-commits-via-lockfile-drift`.

- [ ] IDOR + feature-architecture gates into visible CI workflows
  - cadence: once
  - priority: med
  - category: dx
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06 [HIGH]. `validate:idor` + `validate:action-pins` promoted to blocking steps in
    `feature-architecture.yml` fire-49. Verify `feature-architecture.yml` runs both gates + backfill
    "handlers.ts dir MUST have a manifest" check (89 feature dirs, ~20 with valid manifest;
    `api_keys`/`audit_logs` are handlers-only). `assertSiteOwned` on every new `/api/sites/:siteId`.

---

## loop-improvement (recurring hygiene)

- [ ] loop-self-improvement — fold reusable lessons + append next-wave tasks
  - cadence: every-loop
  - priority: med
  - category: loop-improvement
  - estimate: 20m
  - depends_on: none
  - discovered_by: repository-audit
  - context: EVERY fire spawns the STANDING roster (discovery/audit + product/docs + browser/test +
    misc/integration). The discovery agent research- + repo- + runtime-audits a ROTATING uncovered area
    AND appends deduplicated next-wave tasks HERE (a fire appending zero next-wave tasks = the discovery
    agent under-scanned → rotate area next fire). Fold reusable lessons to `~/.claude` / `~/.agentskills`
    the same turn (`prompt-as-training-signal`). Update `LEDGER.md` with a ≤5-bullet entry.

- [ ] dependency-modernization — deps audit + safe version bumps
  - cadence: every-8-loops
  - priority: low
  - category: tech-modernization
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Run `dependency-auditor` — outdated deps, security advisories, license violations, unused
    imports. Propose version bumps, run tests after updates. Open-source only. Prefer the stack's
    current versions (TS 7.0, ESLint 10, Angular 22, Playwright v1.56+, Vitest 5). Never `pnpm install`
    (electron-builder SSH dep) — `npm install --legacy-peer-deps` in sub-packages.

- [ ] doc-compression — compress docs without losing decisions/commands/warnings
  - cadence: every-4-loops
  - priority: low
  - category: docs
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Run the `docs-compression` skill on the loop docs + `apps/project-sites/CLAUDE.md` +
    sub-ledgers. Keep every decision/command/warning/architecture/example/open-TODO; cut filler +
    inferable knowledge (`instruction-compression-playbook`). Keep this BACKLOG + DISCOVERIES + LEDGER
    optimized for future agents. Older detail lives in git history + sub-ledgers.

---

## fire-51 replenish — money-path CREATE/BUILD/editor (discovery, ground-truthed) + carried

- [ ] Internal super-admin cross-org WfP-backfill endpoint (`POST /api/internal/wfp-backfill`)
  - cadence: once · priority: high · category: architecture · estimate: 60m · depends_on: none · discovered_by: fire-51
  - context: fire-51 shipped `scripts/backfill-wfp-slots.mjs` (proven on `search-verify`) but the diag endpoint is ORG-scoped (`assertSiteOwned`) so it only backfills the caller-org's sites (1 of 2 today). Build a super-admin-gated endpoint that iterates ALL published sites, resolves each `org_id` server-side, calls `deploySiteToWfp` (trusted internal sweep, no per-caller ownership), idempotent + rate-limited + fail-soft. Then run the full backfill so every site serves `x-ps-serve: wfp`. Corpus is only 2 sites now; matters as it grows.
- [ ] Owner-notify on build-complete / build-fail (psnotify `build.*` channel never fires)
  - cadence: every-2-loops · priority: high · category: bug · estimate: 60m · depends_on: none · discovered_by: fire-51
  - context: `src/workflows/site-generation.ts` logs `workflow.owner_notified` but the psnotify DO `build.complete`/`build.failed` send is a stub — owner silently discovers via polling. Wire `notifyUser(ownerId, 'build.complete'|'build.failed', {siteId, slug, errorReason?})` into the final workflow step. Closes the money-path "did my site finish?" gap + the Billing-full E2E's build-signal dependency.
- [ ] Homepage build-error state + one-click retry (4-screen machine has NO error state)
  - cadence: every-2-loops · priority: high · category: bug · estimate: 60m · depends_on: none · discovered_by: fire-51
  - context: `public/index.html` state machine (search→signin→details→waiting) has no `error` screen — a build timeout/API-flake/container-evict leaves the user staring at `waiting` forever. Add a 5th screen (`waiting → error|success`) surfacing the build error + idempotency-safe retry (by site_id). Money-path completion blocker.
- [ ] Promote → "View Live" DNS-propagation guard (immediate click 404s)
  - cadence: every-2-loops · priority: high · category: bug · estimate: 45m · depends_on: none · discovered_by: fire-51
  - context: `SourceControlPanel`/`PromoteHeaderControl` declare "Published!" right after the WfP deploy, but the prod slot can take ~30-60s to propagate; "View Live Site" clicked immediately → 404. Add a post-deploy poll (≤5 checks/60s) that confirms `{slug}.projectsites.dev` 200s before the success/view-live state, or an honest "Waiting for propagation…" interstitial.
- [ ] Editor build-progress SSE subscription (events emitted, editor never subscribes)
  - cadence: every-4-loops · priority: med · category: feature · estimate: 90m · depends_on: none · discovered_by: fire-51
  - context: `src/services/build_events.ts` writes `build_progress` events per stage (research→generate→validate→upload) but the editor renders a static "Building…" spinner for ~15min. Add `useBuildProgress(siteId)` → SSE `GET /api/sites/:siteId/build/events` → live stage labels + %. Reuse `SiteImportStatus`/`PS_GENERATION_STATUS` plumbing.
- [ ] ProjectHub Deploy unwired in standalone (degrades to a hint outside admin bridge)
  - cadence: every-8-loops · priority: med · category: bug · estimate: 45m · depends_on: none · discovered_by: fire-51
  - context: `app/components/workbench/ProjectHub.tsx` — Deploy renders an "open from the admin" hint when not embedded (a doomed/dead control per `action-button-must-gate-on-server-precondition`). Wire a `PS_DEPLOY_REQUEST` bridge fallback so Deploy fires from ProjectHub directly.
- [ ] CREATE funnel: invite-expired inline error + resend; search no-results empty state
  - cadence: every-4-loops · priority: med · category: ux · estimate: 45m · depends_on: none · discovered_by: fire-51
  - context: (a) `src/routes/search.ts` site-lookup gate — a stale/revoked invite fires a 401/410 with a generic error; render "Your invite has expired" + "Request a new one". (b) 0-result search (`meta.reason:'no_results'`) shows nothing → render "No sites found for '<q>'" + "Start a new site" CTA (`embarrassingly-easy` empty-state-as-launchpad).
- [ ] ProjectHub snapshot-restore unsaved-changes guard + Promote "synced" affordance
  - cadence: every-8-loops · priority: low · category: ux · estimate: 45m · depends_on: none · discovered_by: fire-51
  - context: (a) `ProjectHub.tsx` "Restore snapshot" auto-applies over unsaved editor changes with no warning — add a confirm + "auto-backup first" checkbox (`createProjectSnapshot`). (b) `PromoteHeaderControl` disables with reason only in title/aria when Preview==Production — add a visible "synced ✓" badge so the disabled state is legible.
- [ ] CARRIED fire-52: error_handler.ts extraction (Agent 2 died mid-run) + golden-path journey CONTINUATION
  - cadence: once · priority: med · category: architecture · estimate: 90m · depends_on: none · discovered_by: fire-51
  - context: error_handler.ts still 331 LOC — extract `brandedErrorPage`/`prefersHtml` → `src/lib/error_pages.ts` + R2 `10042→503` → typed `StorageUnavailableError` (the fire-51 agent's output was cut off, 0 commit). Golden-path: Agent 5 shipped the `/create` blur-error fix (`8b83e2434`) then ECONNRESET before continuing — resume the LONG money-path journey (build→editor→promote→view-live) fire-52. Note: MCP `forms.component` testid = N/A (verified fire-51: forms renders MCP pills, not connect buttons).

---

## fire-52 replenish — golden-path gen-site defects + editor-resources discovery + follow-ons

- [ ] Generated-site quality defects (lone-mountain-global + template) — golden-path fire-52 found
  - cadence: every-2-loops · priority: high · category: bug · estimate: 90m · depends_on: none · discovered_by: fire-52
  - context: LONG journey on live generated sites surfaced REAL product-output bugs: (1) `lone-mountain-global` brand assets 404 — `logo-wordmark.png`, `favicon.ico`, `apple-touch-icon.png` (RFG favicon set not shipped; see fire-50 gen-site-runtime discovery); (2) doubled-word content bug across pages — title "Local **local** business", H1 "Your **your** community" (generation defect in the content pipeline); (3) build prompt LEAKED into the footer tagline ("Rebuild + enhance the source site…"); (4) ecommerce/"local business" MISFRAME for a global logistics firm + empty NAP (Address/Phone/Email/Hours blank on `/contact`) + no Google Maps panel. Each is a site-gen pipeline / `build_validators` gap — fix + add a validator so it can't reship.
- [ ] Generated-site cmd-palette Esc-close + soft-404 consistency (serving)
  - cadence: every-4-loops · priority: med · category: bug · estimate: 45m · depends_on: none · discovered_by: fire-52
  - context: (a) the generated-site template's command palette does NOT close on Escape (keyboard-trap-adjacent — WCAG 2.1.2). (b) `search-verify.projectsites.dev` soft-404 inconsistency: `/this-page-does-not-exist-zzz` → 200 but `/nonexistent-xyz-123` → 404 (WfP serving path, `site_serving`-owned — reconcile the known-route gate).
- [ ] notify-shape follow-on — 4 more callers still pass the legacy novu shape
  - cadence: every-2-loops · priority: high · category: bug · estimate: 45m · depends_on: none · discovered_by: fire-52
  - context: `0915cfeb6` fixed only the workflow. `src/services/notify_site_built.ts` (bolt-publish "site is live" bell, from `api.ts` publish) + callers in `webhooks.ts`, `ai_admin.ts`, `hostnames.ts` STILL pass `{event,…}` → `invalid_event` → their bells silently never fire. Apply the same canonical `{name,subscriberId,payload}` fix + kill the mocked tests that false-green the broken shape. Per `notification-source-is-psnotify-do`.
- [ ] Editor Resources — kill remaining manual Refresh/Reconcile (real-time-data)
  - cadence: every-loop · priority: med · category: ux · estimate: 60m · depends_on: none · discovered_by: fire-52
  - context: `real-time-data-no-manual-refresh`. Ground-truthed remaining editor targets: `BucketsPanel.tsx:413` (`onRefresh` mount-only, no poll) + `EnvAssignmentGrid.tsx:174` (click-only Refresh) → visibility-aware poll/SSE; `LockManager.tsx:52` `setInterval(…,5000)` unconditional → gate on `document.hidden`; `NamespaceSummary.tsx:340-351` explicit "Reconcile" button → auto-drift-sync + "Last synced" label. Hide manual buttons once auto-refresh is live.

---

## Brian-gated (approval-required — ship the decision-independent slice, NEVER auto-execute)

- ConversationHub DO deletion (`src/index.ts:250`) — destructive one-way-door DO migration
  (`deleted_classes`); DEFERRED indefinitely; needs explicit confirm + correct tag (procedure in the
  source comment).
- GPT-4o vision → Workers-AI swap per callsite (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- Backend-complete → decide frontend render for 4 surfaces (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- Geo-sweep + admin form + `/admin` persistence (`_LOOP_LEDGER.md` NEEDS-BRIAN).

## Blocked-user (awaiting a credential/decision only Brian can provide)

- LinkedIn OAuth creds · Reddit OAuth creds (blocked 4+ days).
- Stripe `STRIPE_PRICE_ID_MONTHLY_WALLET` — landed; needs integration wiring.
- DeepSeek $5 top-up — unblocks bespoke build-LLM copy + build-LLM-gated cohort rebuilds.

## visual-intelligence (role 17 — Deep UI Explorer; STANDING)

- [x] First slice SHIPPED (fire-53): `e2e/deep-ui-explorer/{explorer.mjs,vision-review.mjs}` —
  CF Browser Run CDP proven (provider+session recorded), real test-login verified
  (`brian@megabyte.space`, super-admin), deep path homepage→…→Database→Tables→Actions→History
  captured as 12 states, all vision-reviewed via AI Gateway. Evidence: run
  `dux-2026-09-29T20-01-44-425Z` + `coverage-ledger.json`.
- [x] (fire-54 `fb4c6ca8a`, prod-replayed) Kill the "Refresh" item in Database › Tables **Actions** menu — the tables list must
  self-update (visibility-aware poll or bridge event on create/import/drop). Rule:
  `real-time-data-no-manual-refresh`; sibling of the existing "Editor Resources real-time
  (4 panels kill Refresh)" item — do them as ONE class-sweep. Evidence: dux-…-425Z state 09.
  Acceptance: menu has no Refresh; creating a table via SQL console appears in the list ≤30s
  with zero clicks; `DatabasePanel.spec` updated. Owner: Feature Delivery. Est: M.
- [x] (fire-54 `7dcda7f27` — root cause: ButtonFace reset gap + Toastify light theme) "Loaded 49 files" toast is near-illegible (light-on-light) in the embedded editor —
  persistent across ≥3 states, NOT a fade artifact. Locate the toast styling (ReactToastify
  theme vs brand override) and pin ≥4.5:1. Evidence: dux-…-425Z states 07-09. Acceptance:
  computed toast text/bg contrast ≥4.5:1 in embedded context + replay screenshot. Est: S.
- [ ] Tables view renders TWO near-identical "TABLES (N)" lists side-by-side (master rail +
  pick-a-table pane). Verify intent in `SiteTablesPanel.tsx`; either visually differentiate
  (detail affordance, header, empty-state copy) or collapse to one list. Evidence:
  dux-…-425Z state 08. Acceptance: explorer replay shows one obvious primary list OR two
  visibly distinct panes; vision score ≥8 on that state. Owner: UX/Visual. Est: M.
- [ ] Explorer breadth: graph-discover beyond the deep path (sidebar groups · overflow menus ·
  dialogs · Code→Project hub · Resources→Buckets · analytics filters · settings dialogs ·
  feature-flag controls · keyboard paths · empty/populated/error states), rotating the
  underexplored branch each fire via `coverage-ledger.json`. Acceptance: ledger shows ≥10 new
  distinct state keys per fire until the nav-derived frontier is exhausted. Est: recurring.
- [ ] 🔑 Vision provider credits (Brian): OpenAI key is 429-quota-exhausted
  (https://platform.openai.com/settings/organization/billing/overview) and the Anthropic key
  has zero credit (https://console.anthropic.com/settings/billing) — until topped up, reviews
  run on the labeled Workers-AI fallback (Llama 4 Scout via AI Gateway). GPT-4o/Claude re-take
  the primary slot automatically once keys work (ladder already ships).
- [ ] Near-release multi-viewport re-visit of key states (375/768/1024/1440 + reduced-motion)
  driven from the same coverage ledger. Est: M.

## template-evolution (role 18 — every-2-fires)

- [ ] Typed component catalog in `HeyMegabyte/template.projectsites.dev`: per-entry manifest
  (scenario served · required VERIFIED facts · editing controls · semantic fallback ·
  motion/3D options · browser-API needs · a11y · cost/perf budget · tests). Start by
  inventorying existing sections into the manifest shape. Acceptance: catalog file + ≥10
  entries + CI check that every section component has an entry. Est: L.
- [ ] Builder creative brief: compact brief from research + owner edits + assets + vertical +
  buyer intent + objections + conversion goal, consumed by component selection in
  `site-generation.ts` (evidence-based choice, no scenario-blind defaults). Est: L.
- [x] (fire-58 `b353c888a`, 20 new tests / 374 adjacent green) Provenance gate: awards/testimonials/certifications/statistics/press/client-logos/case
  results render ONLY with verified facts — extend `build_validators.ts` fabricated-people
  class to these section types. Acceptance: validator red on unverified award section. Est: M.
  Shipped: `validateClaimProvenance` in `validateBuild` — `_citations.json` Zod evidence contract
  (`CitationEntrySchema`); award + fabricated AggregateRating/Review JSON-LD = ERROR, press/cert/
  statistic/client-logo/case-result/testimonial-heading = warn (v1); seeded trust-badge triads
  proven false-positive-safe. Escalate warn classes to error once template + orchestrator emit
  `_citations.json` (template-repo side of this item — fold into the component-catalog slice).
- [ ] Browser-capability registry + per-archetype visual language seeds (start: restaurant ·
  professional-services · nonprofit) with purposeful WebGL/3D + static fallback + early
  headline/CTA + reduced-motion; never permission-prompt on load. Est: L.
- [ ] Template VERSION stamped into every build (`_brand.json.template_version` + D1 column) +
  safe upgrade path for older generated sites preserving owner edits. Acceptance: new builds
  carry version; upgrade dry-run on one older site preserves edits. Est: M.

## cf-releases (role 14 scout duty — ~every 4 fires)

- [x] First feed sweep: developer-platform + product RSS + deprecations → dedupe by GUID into
  `CF-RELEASES.md` → decision per relevant release (pilot/backlog/watch/reject). Include
  browser-API/platform changes for the template capability registry. Est: S, recurring.
  DONE fire-54: 44 items + 10 deprecations → 2 pilot / 6 backlog / ~13 watch / 4 reject;
  no urgent deprecations (registrar client verified on NEW API). Next sweep ~fire-58.
- [ ] PILOT (fire-54 scout): Browser Run multi-client sessions (2026-09-29) — attach 2+
  concurrent CDP clients to ONE Browser Run session (journey driver + screenshot/console
  observer) in the Deep UI Explorer harness. Acceptance: second client attaches to a live
  session with no cold start, both interact without evicting each other, recipe documented
  in the explorer manifest. Est: S.
- [ ] PILOT (fire-54 scout): Workers tracing custom spans (2026-09-25) — instrument
  site-generation workflow phases + WfP dispatch with startSpan()/recordException()/
  setAttributes (siteId, orgId, phase); JS RPC session spans (2026-09-17) should cross the
  DO boundary for free. Acceptance: one real prod build shows named per-phase spans + a
  recorded exception in Workers Observability. Est: S-M.
- [ ] Browser Run budget: track browser-minutes per explorer/long-trail run in the manifest;
  reconcile monthly against CF billing (Browser Run pricing + session limits). Est: S.


## fire-54 replenish (verified, deduplicated)

- [x] (fire-55 `990ccaef8`) LockManager unconditional poll → visibility-aware (the one fire-52 real-time item the
  fire-54 sweep did NOT cover; same ResourceOverviewPanel pattern). Owner: Feature Delivery. Est: S.
- [ ] Long-Trail case-001 Phase B re-queue (2nd agent attrition fire-55 — died mid-run again; partial spec salvaged to .claude/run-the-loop/salvage/case-001-phaseB-fire55.patch; NEXT ATTEMPT: main thread pre-boots the stack, agent only writes+runs specs) — prerequisite discovered: apps/project-sites/.dev.vars
  needs ENVIRONMENT=development (has E2E_TEST_PASSWORD); agent died mid stack-setup, 0 commits.
- [x] (fire-55 `71a5affe3`, live main-BEAVLNRK) Settings page prefill (vision 8/10, run dux-…22-19-12): form fields empty except contact
  email — prefill from org/business profile or add inline guidance. Owner: UX. Est: S.
- [x] (fire-55 template repo `d5f4ba5`, 533 tests) Template defects from catalog inventory (template repo, role 18): LogoCloud marquee
  focusable-in-aria-hidden; scrubText firewall missing on MetricRow/Quote/Spotlight (Quote leaks
  into Quotation JSON-LD); Timeline year token unscrubbed; CaseStudyGrid fallback lacks DEV gate;
  docs/COMPONENTS.md lagging. Acceptance: validator/test per fix in template repo. Est: M.
- [x] (fire-55: REAL stranded work — salvaged `4288a2c3f` + `9f9fcf599`, branches deleted) Hygiene: inspect non-ancestor branches `worktree-wf_59b344e1-c59-6/8` — salvage or delete
  with rationale. Est: S.

---

## CAMPAIGN — cf-native-ai (spec: CAMPAIGN-cf-native-ai.md; lanes 1-11, dependency-chained)

> Canonical spec: [`./CAMPAIGN-cf-native-ai.md`](./CAMPAIGN-cf-native-ai.md) (single source — never
> re-derive from code). Opened fire-55; source-review baseline `29007fdf2`. Chain: inventory →
> policy → key-grants/model-routing → protocol adapters → managed execution; OAuth (lane 6) + Chat
> (lane 7) consume the SAME policy/executor; workspace ADR (1.3) precedes editor migration (lane 8);
> LiteLLM proxy removal (lane 9) only after verified caller cutover. FIRST slices only — replenish
> per fire until §17 acceptance satisfied. Item shape: `deps · files · flag (dark experimental) ·
> est S/M/L · acceptance (§17 case #)`.
> Guard: the removed UI-authored AI-endpoints product STAYS removed — Site Functions remain
> code-defined WfP. Dedupe: lane 3 EXTENDS the "Public REST API v1" `psk_live_*` keystore (ONE
> token DB); lane 6 subsumes DISCOVERIES Lane 16 (D — MCP broker); lane 8 subsumes the Lane 15
> `ide_sandbox` cull; lane 9 subsumes the App-catalog LiteLLM SSOT line.

### Lane 1 — Inventory/ADRs (wave 0)

- [ ] LiteLLM full-reference inventory → `docs/_campaign/litellm-inventory.md` — case-insensitive
  sweep (code/config/containers/deploy routes/catalogs/provider selections/flags/env/scripts/tests/
  docs); identify ACTIVE callers + customer-visible keys/models
  - deps: none · files: `infra/litellm/` (read-only) · flag: n/a (docs) · est: M · acceptance: feeds §17.13
- [ ] Foundations verify at HEAD → `docs/_campaign/foundations-verify.md` — confirm/refute each §2
  claim: psk_ token store · `platform_mcp` transport gaps · oauth scope split · unimplemented
  `mcp_client` providers · tier-router defects · 4-way router split · `ide_sandbox` fabrication ·
  editor internal marker
  - deps: none · files: `services/api_tokens.ts` · `libs/features/platform_mcp/` ·
    `libs/features/mcp_oauth_provider/schemas.ts` · `services/mcp_client.ts` ·
    `services/llm_tier_router.ts` · `services/ide_sandbox.ts` ·
    `app/lib/modules/llm/providers/projectsites-ai.ts` · flag: n/a · est: M · acceptance: gates all §17
- [ ] Workspace/runtime ADR — compare configured VibeSDK paths (SpaceDO SQLite fs-backend ·
  Artifacts · Worker Loader/worker-bundler · Sandbox SDK · Browser Run) vs OUR account features/
  entitlements BEFORE any R2/isomorphic-git commitment
  - deps: none · files: `docs/decisions/` (new ADR) · flag: n/a · est: M · acceptance: prerequisite for §17.11/12
- [ ] RED protocol-conformance specs `e2e/ai-api/` — failing specs for GET /v1/models ·
  POST /v1/chat/completions (streamed+non-streamed, tools) · POST /v1/messages (+count_tokens,
  events accumulate to valid final Message) BEFORE implementation (TDD)
  - deps: none · files: `e2e/ai-api/` (new) · flag: n/a (specs) · est: M · acceptance: §17.1 + §17.2 (RED now → green lane 4)

### Lane 2 — Policy/storage

- [ ] ONE grant/capability registry — shared Zod schemas + typed tool manifests (stable tool IDs ·
  read/write/publish distinction · resource requirements · cost class · idempotency · approval
  behavior); reconcile `sites:read/write` (oauth) with `data:read/write` (public API) scope split
  - deps: L1.2 · files: `libs/features/mcp_oauth_provider/schemas.ts` + `packages/shared/` · flag: `ai_policy_core` · est: M · acceptance: §17.3/§17.5 groundwork
- [ ] Additive D1 migrations — concrete grants (connection/account IDs · site/resource IDs ·
  actions · models · limits) + grant-revision/revocation + audit trail
  - deps: L2.1 · files: `migrations/` (additive only) · flag: `ai_policy_core` · est: M · acceptance: §17.6
- [ ] Principal resolver (session | API key | OAuth grant | site agent) + single authorizer
  enforcing the INTERSECTION (owner RBAC ∩ grant ∩ site/resource ∩ connection ∩ action ∩
  entitlement ∩ revocation/approval/budget) immediately before EVERY tool execution; authz-infra
  failure DENIES, never grants
  - deps: L2.2 · files: `services/api_tokens.ts` (EXTEND — same keystore as Public REST API v1) · flag: `ai_policy_core` · est: L · acceptance: §17.6
- [ ] DO-serialized budgets — reservation/settlement/crash recovery + coordinated grant-revision/
  revocation checks (KV = cache only, NEVER authority for revocation/spend)
  - deps: L2.3 · files: new DO class (deploy-safe: only ADD DO classes, 10064 class) · flag: `ai_policy_core` · est: M · acceptance: §17.9

### Lane 3 — Key management

- [ ] "AI API Keys" inside Settings → API Tokens (EXTEND — no detached dashboard, no second token
  DB): create = name + protocol (OpenAI|Anthropic|both) → grants → expiry/limits/approval policy →
  endpoint + plaintext ONCE + separate Copy controls + working curl/official-SDK examples
  - deps: L2.3 · files: `services/api_tokens.ts` + Angular/Spartan admin Settings · flag: `ai_api_keys` · est: L · acceptance: §17.1 (create/copy leg)
- [ ] Permission popup ("Choose access") on DialogShellComponent — live search · selected pinned +
  survive search changes · tri-state groups from the REAL catalog · Select-all = CURRENT eligible
  only · connected/expired/not-configured/unavailable states · presets (Read only · Draft ·
  Publishing · Custom) · keyboard/focus-trap/SR/mobile/reduced-motion
  - deps: L3.1 · files: Angular/Spartan admin (DialogShellComponent) + `services/mcp_client.ts` (connection states) · flag: `ai_api_keys` · est: L · acceptance: §17.4
- [ ] Key lifecycle — list/describe · edit/narrow · expire/rotate/revoke · last-use + usage/cost ·
  connection health; EXISTING tokens keep working WITHOUT silently gaining AI/publish/integration
  access; never redisplay plaintext, never keys in URLs/logs
  - deps: L3.1 · files: `services/api_tokens.ts` · flag: `ai_api_keys` · est: M · acceptance: §17.6 + legacy-scope no-regression

### Lane 4 — Inference protocols

- [ ] ONE routing authority — consolidate `libs/features/model_registry/` + `external_llm.ts` +
  `ai_gateway.ts` + `gateway_route.ts` (don't add another router); fix `services/llm_tier_router.ts`
  defects (latency rule overriding security-review · capability-blind fallback step-down ·
  premium-only-vision assumption) with VERIFIED per-model capabilities
  - deps: L1.2 · files: the 5 named modules · flag: `ai_model_router` · est: L · acceptance: §17.8
- [~] GET /v1/models (+lookup) + POST /v1/chat/completions — DONE fire-56/57: models (e5106673c) +
  non-streamed chat (b31faa534, prod-proven "OK"+usage via projectsites-fast; stream:true→honest 400).
  REMAINING: streaming SSE + tool-call deltas + ONE terminal marker (turns remaining L1.4 RED specs green)
  - deps: L2.3 + L4.1 · files: Workers/Hono backend (new `/v1` routes) · flag: `ai_compat_api` · est: L · acceptance: §17.1
- [ ] POST /v1/messages + /v1/messages/count_tokens — x-api-key + anthropic-version, content
  blocks, tool_use/tool_result, documented named events + content-block indexes + cumulative
  usage + one terminal stop; VERIFIED tokenization (no char heuristics as exact counts)
  - deps: L4.2 · files: Workers/Hono backend `/v1/messages` · flag: `ai_compat_api` · est: L · acceptance: §17.2
- [ ] Compat matrix + protocol-appropriate unsupported-feature errors (never silent strip) +
  virtual models `projectsites-auto|fast|balanced|premium` on versioned routing policies; never
  claim actual Claude/GPT when another backend served; separately-tested /v1/responses workstream
  - deps: L4.2 + L4.3 · files: docs + routing authority · flag: `ai_compat_api` · est: M · acceptance: §17.2 + §17.8
- [ ] API-path WAF narrowing — curl/SDK reach `/v1/*` with token auth, no browser-only bot
  challenge (zone protections stay); known class: apex POST hits CF Bot-Fight 403
  - deps: L4.2 · files: zone/WAF config + Workers/Hono backend · flag: n/a (infra) · est: S · acceptance: §17.1 (SDK reachability leg)

### Lane 5 — Managed tools

- [ ] Managed execution loop — resolve authorized connections/resources → introduce relevant
  tools → bounded server-side model/tool loop → protocol-compatible final answer from a NORMAL
  SDK request (zero MCP config; stateless Chat/Messages FIRST, no proprietary header); secrets
  decrypt/inject only at execution boundaries via `services/ai_env_vars.ts` (never into model
  context)
  - deps: L3.1 + L4.2/L4.3 · files: `services/mcp_client.ts` + `libs/features/platform_mcp/` + `services/ai_env_vars.ts` · flag: `ai_managed_tools` · est: L · acceptance: §17.1 + §17.3
- [ ] Two-boundary tool semantics — (A) managed tools server-side from saved grants; (B)
  caller-supplied functions returned as native protocol tool calls, NEVER silently
  server-executed; collision-free namespaces + correct continuation transcripts + preserved
  tool-choice/JSON-only semantics
  - deps: L5.1 · files: protocol adapters (Workers/Hono backend) · flag: `ai_managed_tools` · est: M · acceptance: §17.7
- [ ] Per-hidden-step metering + bounds (steps · wall-time · output/tool-result size · parallelism
  · spend · retry-escalation depth) on lane-2 DO budgets; retries NEVER duplicate
  publish/SMS/calls; useful partial-failure results without claiming completion
  - deps: L5.1 + L2.4 · files: DO budgets + gateway adapters · flag: `ai_managed_tools` · est: M · acceptance: §17.9
- [ ] Approval-required ops → actionable protocol-compatible pending receipts; server-verified
  approval or narrow configured automation ONLY ("model said confirmed" ≠ approval)
  - deps: L5.1 · files: policy registry + protocol adapters · flag: `ai_managed_tools` · est: M · acceptance: §17.9 (seeds lane-10 inbox)

### Lane 6 — External MCP/OAuth

- [ ] Conformant ProjectSites MCP server — CF Agents + official MCP SDK (Streamable HTTP ·
  protocol negotiation · init · implemented tools/resources · cancellation · errors · auth
  discovery); expose only principal-usable tools; INDEPENDENT re-authorization at tools/call
  (subsumes DISCOVERIES Lane 16-D)
  - deps: L2.3 · files: `libs/features/platform_mcp/` (EXTEND 56-entry dispatcher — hand-rolled handler ≠ transport conformance) · flag: extend `platform_mcp` · est: L · acceptance: §17.5 (resource-reach leg)
- [ ] workers-oauth-provider foundation — PKCE S256 · exact redirect-URI · CSRF/state ·
  resource/audience binding · AS/resource metadata · registration · code expiry + ATOMIC
  single-use exchange (two simultaneous exchanges must not both succeed) · secure refresh
  rotation/replay · revocation · delegated child ≤ presenter
  - deps: L2.3 · files: `libs/features/mcp_oauth_provider/schemas.ts` (+ provider Worker) · flag: extend `mcp_oauth_provider` · est: L · acceptance: §17.5 (escalation/code-replay/audience)
- [ ] Consent screen — client + verified origin · requested access + expiry · all CURRENT eligible
  sites preselected (search/all/none/individual) · grant SNAPSHOTS selected IDs (never future
  sites) · "Customize permissions" opens the SAME lane-3 selector
  - deps: L6.2 + L3.2 · files: Angular/Spartan admin consent surface · flag: extend `mcp_oauth_provider` · est: M · acceptance: §17.5
- [ ] Connected-applications UI — view/narrow/revoke; changes hit ACTIVE runs before their next
  action
  - deps: L6.2 · files: Angular/Spartan admin Settings · flag: extend `mcp_oauth_provider` · est: M · acceptance: §17.6

### Lane 7 — Chat (Cloudflare OS)

- [ ] Cloudflare OS reuse audit — inspect packages/workshop-frontend + workshop-backend +
  mcp-shared + MCP/Notion Gatekeepers + sharing/auth/action-store; pin adopted code; document
  reuse-vs-adapt (frontend island vs service-bound Worker under OUR origin/session)
  - deps: L1 · files: `docs/_campaign/` note · flag: n/a · est: M · acceptance: prerequisite for §17.10
- [ ] Sidebar entry named exactly "Chat" — first-class workspace under our admin shell + sign-in
  with verified tenant/site identity: conversations · active site/resource selection · connection
  picker (NOT a link/unauth iframe to os.cloudflare.app)
  - deps: L7.1 + L2.3 · files: Angular/Spartan admin (sidebar + route) · flag: `chat_workspace` · est: L · acceptance: §17.10 (opens from sidebar, authorized context)
- [ ] Chat execution surface — real execution progress · action receipts · reconnect/resume +
  cancel · shared approval inbox · artifact previews; proposals/drafts visibly distinct from
  executed effects
  - deps: L7.2 + L5.1 · files: Chat workspace + shared executor · flag: `chat_workspace` · est: L · acceptance: §17.10
- [ ] Capability-tied suggestions (improve homepage · draft social campaign · summarize Notion ·
  inspect analytics · prepare asset); unavailable → guide to connect; connection selection =
  allowed CEILING; on-demand tool discovery over every-schema-in-prompt
  - deps: L7.3 · files: Chat workspace · flag: `chat_workspace` · est: M · acceptance: §17.10 (suggestions leg)

### Lane 8 — Workspace/editor

- [ ] ONE workspace/runtime interface per L1.3 ADR — list/read · batched edits ·
  revisions/checkpoints + diffs · snapshots · previews · sandbox exec · promotion; functioning
  CF-native fallback when Artifacts/Facets/Loader unavailable; preserve bolt.diy until verified
  parity (no second editor); no competing sources of truth
  - deps: L1.3 · files: `app/` bolt.diy editor + Workers backend workspace routes · flag: `workspace_runtime_v2` · est: L · acceptance: §17.11/12 groundwork
- [ ] Replace `services/ide_sandbox.ts` fabricated demo runs / timer progress / fake file events
  with REAL workspace/Sandbox/job state — no pretend anything (subsumes DISCOVERIES Lane 15 cull)
  - deps: L8.1 · files: `services/ide_sandbox.ts` · flag: `workspace_runtime_v2` · est: M · acceptance: §17.11 (real Sandbox commands + Browser Run checks)
- [ ] Guest workspaces — isolated temp identities · quotas · signed previews · TTL cleanup ·
  secure claiming; never a shared anonymous workspace ID; container disks ≠ durable history
  - deps: L8.1 · files: workspace service + DO/R2 layout · flag: `workspace_runtime_v2` · est: M · acceptance: §17.11
- [ ] Frozen-revision promotion through the new interface — promotion serves EXACTLY the frozen
  revision via existing WfP (normal published serving, R2 fallback); autosave never publishes;
  rollback/history/assets/Functions/per-site-data isolation preserved
  - deps: L8.1 · files: WfP serving (§2.12) + workspace service · flag: `workspace_runtime_v2` · est: M · acceptance: §17.12

### Lane 9 — Cutover/removal

- [ ] Port useful LiteLLM routing/quotas/eval/telemetry natively WITH acceptance tests (from L1.1
  inventory) — port BEFORE removal
  - deps: L1.1 + L4.1 · files: `infra/litellm/` (source) → native router/budgets · flag: `ai_model_router` · est: M · acceptance: §17.13
- [ ] Cut over ALL callers to native endpoints — editor
  (`app/lib/modules/llm/providers/projectsites-ai.ts` — internal marker must NEVER authorize the
  public API), site-generation, internal jobs, public callers; preserve owned usage/history;
  rotate/reissue keys where plaintext unrecoverable
  - deps: L9.1 + L4.2/L4.3 · files: `app/lib/modules/llm/providers/projectsites-ai.ts` + caller inventory · flag: `ai_compat_api` · est: L · acceptance: §17.13 (native works with proxy UNAVAILABLE)
- [ ] Remove `infra/litellm/` + proxy-exclusive Neon/Upstash deps + bindings/routes/config/catalog
  entries/docs — verified DO-identity/migration deprecation plan (never blind class removal or
  migration rewrites); drift gate rejects reintroduction; close the App-catalog LiteLLM SSOT line
  by DELETION
  - deps: L9.2 verified · files: `infra/litellm/` + wrangler config + app catalog · flag: n/a (removal) · est: M · acceptance: §17.13 (no obsolete paths in active code/config)

### Lane 10 — Business workflows

- [ ] ONE approvals inbox across Chat + APIs + MCP + scheduled — single queue, shared receipts
  - deps: L5.4 + L7.3 · files: Angular/Spartan admin + policy registry · flag: `approvals_inbox` · est: M · acceptance: §17.10 (shared approvals leg)
- [ ] Notion → draft → social → approved-publish workflow behind the capability executor;
  publish/delete stay distinct from read/draft
  - deps: L5.1 + L10.1 · files: shared executor + `services/mcp_client.ts` adapters · flag: `notion_social_flow` · est: M · acceptance: §17.3 (scoping) + §17.9
- [ ] Scheduled workflows re-evaluate grants/budgets/approvals AT execution — typed tools +
  idempotency keys + operation receipts; recipient allowlists in tests + approved-destination
  policies in automation (REAL carrier boundary — reuse working Twilio)
  - deps: L5.3 + L10.1 · files: agent schedules/Workflows/Queues + shared executor · flag: `ai_agent_schedules` · est: M · acceptance: §17.9 (no duplicate SMS/calls; unauthorized sends fail closed)

### Lane 11 — Provider readiness/ops

- [ ] Routing evals + receipts — schema-validated versioned routing policies · canary/shadow evals
  (no external effects) · representative quality/cost/latency benchmarks · concise route reasons ·
  backend/attempt/tool-step/usage/cache/cost receipts
  - deps: L4.1 · files: routing authority + evals harness · flag: `ai_model_router` · est: M · acceptance: §17.8
- [ ] OpenRouter readiness artifacts — stable virtual-model IDs · compatible streaming/usage ·
  truthful pricing/capability/context/output metadata · geo disclosures · monitoring · retention
  policies; acceptance is EXTERNAL — no incidental application submission
  - deps: L4.4 · files: `docs/_campaign/` readiness dossier · flag: n/a · est: M · acceptance: §15 conformance artifacts (external gate)
- [ ] Ops guardrails — sensitive prompts/secrets OUT of default analytics; Gateway metrics ≠
  billing/permissions; caching scoped tenant+grant-revision+resource-state+model/policy-version
  (never skips writes, never leaks tenants); CF free allowance vs our pricing vs marginal cost
  distinguished
  - deps: L4.2 + L2.4 · files: gateway adapters + metering · flag: `ai_model_router` · est: M · acceptance: §17.9 (billing honesty leg)

## fire-56 replenish (verified)

- [ ] Feature Flags admin page: list CODE-REGISTRY flags even when D1 feature_flags is empty
  (registry is SoT; fresh-DB shows 0 rows — long-trail Phase B RED blocks here). Acceptance:
  Phase B greens on fresh local D1. Owner: Feature Delivery. Est: S-M.
- [ ] KV/detail (all per-kind details): distinguish flag-dark 404 by MESSAGE → honest
  "not enabled yet" state (not "Failed to load resource"+Retry); gate Write/TTL/Delete +
  Promote/Clone/Delete-resource controls on provisioned state (doomed-control rule). Evidence:
  dux-2026-09-29T23-45-06 state 11. Owner: UX/editor. Est: M.
- [ ] packages/shared/CLAUDE.md test-count stale after ai-policy (+58) — one-line doc sync. Est: XS.
- [x] Convergence deploy — DONE fire-57: worker 23cdff9f (models+mint+grants+chat+search+flags-union),
  frontend main-N5NOCGEV hash-verified, editor Pages 42e82f04; migrations 0649+0650 applied to prod D1.

## fire-63 next-wave (appended by convergence)
- [ ] **Editor Create-Table orphan** — wire `DatabasePanel.onCreateTable` to the `schema` SchemaBuilder overlay OR consolidate the two create paths (local `sitedb-create-table` modal vs `database-action-overlay`). Acceptance: one create path reachable from Tables UI; the other removed. (G#2)
- [ ] **AI-Seed empty-DB dead-end** — inline "Create a table" CTA inside the AI-Seed empty state so a blank-DB owner proceeds without leaving. Acceptance: AI-Seed on empty DB offers inline create. (G#3)
- [ ] **IDOR gate blind-spot** — add `src/index.ts` to SCAN_DIRS in check-idor-gates / check-idor-handlers / check-get-read-idor / check-body-slug-write-idor, OR enforce per-site handlers live only in libs/features. Acceptance: an inline `:siteId` handler in index.ts without assertSiteOwned fails the gate. (H)
- [ ] **Finish admin-ops golden journey** — F authored `e2e/admin-ops-journey/admin-ops.e2e.ts` (280 lines, complete) but never ran it green (d1Count helper cwd resolution). Role 4 next fire: fix the cwd + run green vs real backend. Acceptance: spec passes with the analytics display-vs-store reconcile.
- [ ] **Long-Trail case-001 Phase F iframe legs** — D-boot iframe legs need `editor.projectsites.dev` CSP `frame-ancestors http://localhost:4200` OR run case vs PROD editor. Acceptance: actions 91-96 (apps install/removal + tenant-isolation + cleanup) drive live + green. (role 16 resume)
- [ ] **Apply role-17 specialist-mapping fix to `.claude/commands/run-the-loop.md`** line ~96 (permission-blocked from headless main session this fire). Acceptance: role 17 line names general-purpose/test-writer, not visual-qa.

## fire-64 re-queue + next-wave (appended 2026-10-01)
- **[cleanup] Thin error_handler.ts (254→≤200 LOC)** — RE-SCOPED (D-64-2): fat is error_handler.ts's OWN classify→envelope→dispatch body, NOT brandedErrorPage (already 20 LOC in error_render.ts). Brief MUST mandate pure cut-paste-delete-repoint. Acceptance: error_handler.ts ≤200 LOC, jest error_handler 28/28, exactly one brandedErrorPage definition.
- **[standing/loop] Make STANDING browser roles runnable under the fleet** (D-64-1) — Deep UI Explorer + Long-Trail run on MAIN checkout (no auto-worktree) OR a node_modules-provisioned worktree; brief asserts deps resolve before claiming CF coverage. Acceptance: one real CF-Browser-Run pass, ≥3 settled Database overlays + coverage-ledger update.
- **[standing] Deep UI Explorer — settle Database action overlays** (schema/seed/import: open→fill→submit→capture) + Settings API Tokens mint. Re-queued (fire-64 BLOCKED on auto-worktree). Acceptance: coverage-ledger 43→≥46 settled states + vision verdicts.
- **[standing] Long-Trail TDD case-001 Phase F** (#79-96: apps install/remove → site survives → tenant-isolation #90 → cleanup #91-96). Lease stale/reclaimable; needs editor-CSP iframe unblock for iframe legs. Acceptance: Phase F green, checkpoint advanced.
- **[arch] Flag-gate OR allowlist voice_insights + cloudflare_rum** (D-64-3) — one coherent decision; convert cloudflare_rum `days` to Zod. Acceptance: validate:features 0 WARN.
