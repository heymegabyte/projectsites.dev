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
- [ ] RES-AUTO Resources screen — integrate the **Automations (Schedule) panel** + the under-tracked FILE-1 tabs. The live `ResourcesPanel.tsx` renders ONLY Buckets/Media (Environment · Media library · Site files · Buckets); the FILE-1 "7-tab AI-native Resources editor" spec (Buckets · **Schedule/Automations: cron/workflow calendar + approval policy** · Functions · Agents · Connections · Knowledge · Manage) was flagged "absorbed fire-80" but the absorption NARROWED to GP-13 (Buckets/Manage only) — so Automations/Schedule + Functions/Agents/Connections/Knowledge never got a frontier line (absorbed≠fully-tracked). ACCEPTANCE: Resources shows an Automations (Schedule) tab that lists/creates/schedules/retries/cancels the site's Workflows (GP-16) with an approval policy, server-discovered (WLK-20), flag-gated (404-dark), reconciled display-vs-store; remaining FILE-1 tabs each tracked or explicitly deferred.
  - cadence: every-2-fires · priority: high · category: product · estimate: 2-3 fires · depends_on: GP-16 workflow-discovery (WLK-20) · discovered_by: brian-question-2026-10-03 (FILE-1 absorb over-claimed; only Buckets was tracked)
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

- [x] (fire-63 `2ddefd5e6`: dead-toggle gate 0-hits + deep-ui-explorer PASS_CLOUDFLARE live editor sweep) Editor feature continual-verification sweep (Brian: "ensure ALL bolt.diy editor features work continually") — Deep UI Explorer owns a recurring pass that drives EVERY editor toolbar control + panel (sticky/minimap/split/inline-diff view toggles, Code/Diff/Preview, Data tab, terminal, file tree ops, SQL console) in a real authed embed and asserts each produces its effect; catches the dead-useState class (diff's fileHistory was `useState({})` w/ no setter — fixed fire this turn). Add a drift gate flagging any `useState` whose setter is never destructured on an interactive toggle
  - cadence: every-2-fires · priority: high · category: testing · estimate: 1 fire · discovered_by: brian-2026-10-01

- [x] (fire-71: WIRED. `buildPrompt` resolves a THEMED `webglHeroConfigFor(category)` per build + emits a MANDATORY "mount `<WebGLHero>` as hero first-child, static-fallback-safe, headline+CTA render early" step; new `validateWebglHeroPresent` gate (`webgl.hero_missing`, opt `hasWebglPack:true` always-on) fails any canvas-less build; worker-side `WEBGL_HERO_PRESETS` mirror in `theme_style.ts` because tsconfig can't import `templates/*.mjs`. TDD RED→GREEN: 5 validator + 4 resolver + 1 aggregate test; full worker suite 898 suites / 14155 tests OK, tsc 0 errors.) WebGL generation-consumption gap — packs carried `webgl` blocks + gate passed yet gp-09 rendered NO canvas; the pipeline wasn't EMITTING the WebGLHero into built sites [fire-70 CONFIRMED REAL — templates/webgl/WebGLHero.tsx + webgl-hero-core.mjs EXIST, zero refs in apps/project-sites/src = built-but-unwired P0; CLOSED fire-71]
  - cadence: next-fire · priority: high · category: product · estimate: 1h · discovered_by: fire-63-lane-B
- [x] Wire dead-toggle gate into the `check` aggregate (lane D rec: add check:dead-toggle + && into check chain) + prod-verify purge {purged,archived} echo on a real teardown  <!-- fire-76: CONFIRMED already-wired (pkg.json:31 check:dead-toggle); backlog was stale -->
  - cadence: next-fire · priority: medium · category: testing · estimate: 20m · discovered_by: fire-63-lane-D
- [x] (fire-70 9f5909eb4) Wire orphaned /admin/sites grid into admin nav — Deep UI Explorer found the list route built but nav-unreachable; added Workspace "Sites" item + globe icon + lockstep spec; frontend R2 deployed
- [x] Golden-path money Journey A: Hosting view (~action 11) showed neither a "no build yet" state nor a Promote/Publish CTA within 10s — CONFIRM (stale selector vs real dead-end) then fix; spec at apps/project-sites/e2e/fire70-money-path.e2e.ts · priority: high · category: product · discovered_by: golden-path fire-70  <!-- fire-76: CONFIRMED STALE-SELECTOR, fixed fire-72 68e2af361, re-verified; hosting.component.ts:217-246 data-testid=hosting-publish -->

## WALKTHROUGH (WLK-*) — Brian STT walkthrough, absorbed fire-67 (2026-10-01)

> Full spec: `./WALKTHROUGH-SPEC.md` (verbatim). Canonical IDs below; map to existing items by
> meaning (reuse IDs, don't duplicate). P0 = reported-broken paths + loop intake. "Verified"
> requires OBSERVED behavior. Primary product ProjectSites.dev; Lone Mountain Global = repro target.

**P0 — broken paths + intake (implement first, §4 order):**
- [x] WLK-01 absorb: upgrade loop + persist spec + merge ledger + next-select reads it — fire-67 (this)
- [x] (fire-67 `2200d5fd3`+Pages `5654158a`; live-embed verify pending) WLK-03 editable table cells: edit→save→reload reads same value from correct DB; errors preserve failed edits
- [x] (fire-68 `7d9ae9abd`+`6148c921`; worker a4ae2da6 + editor Pages ccb27622 deployed) WLK-04 one **AI** action (replace AI Column/Filter split); repro+fix the "3 attempts / bad gateway"
- [x] (fire-67 `ad5715a7d`+worker `88388709`; not-billing, opaque-err+retry) WLK-08 Lone Mountain Global KV purchase→provision→open "failed to load resource"; no duplicate charge
- [x] (fire-67 `f3e31adf6`+worker `88388709`; PROD 404→200) WLK-09 Lone Mountain Global Hosting→Preview link (investigate double-dash route/TLS/redirect/load)
- [x] (fire-68 `7d9ae9abd`; verified REAL — createSampleData CREATEs+seeds owned per-site D1, not a toast no-op) WLK-02 one-click "Use AI to load sample data" creates tables when absent + seeds synthetic rows (no dead-end)
- [x] (fire-68 `0e2f653d3`; preset populate-before-run + AA contrast 3.5:1→7.8:1, editor Pages ccb27622) WLK-05 SQL readability: presets visibly populate SQL before run; fix unreadable-contrast cases
- [x] (fire-71; 30 jest + 22 Karma GREEN, AOT ng build OK) WLK-28 real error details + useful log rows (stack/resource context/trace nav), not empty/generic — mapEvent normalizes thrown-AppError events (message/url/code/request_id keys, not just msg/path/requestId) -> real code+message+route+trace_id (never a blank/generic edge row); LogRow gained code + trace_id; Log Explorer rows now clickable -> detail dialog (DialogShellComponent reuse) w/ full resource context + inline error-code badge + copy request/trace ids + "View trace" deep-link to Logs > Traces tab (?tab=traces&trace=<id>)

**P1 — requested core behavior:** WLK-06 persist SQL runs+saved queries · WLK-07 real D1 Time-Travel recovery UI · WLK-10 site/env/resource mappings + separate R2 buckets · WLK-11 migrate shared-bucket layout (resumable+rollback) · WLK-12 preview autosave/version history (Git-backed + AI title) · WLK-13 main env/bucket/history/publish selector · WLK-14 compact Code tree/panels + StackBlitz relocation + Code-only footer · WLK-15 remove standalone Queues/Vectorize/R2/KV inspectors + System Services · WLK-16 Resources→Buckets/Manage (counts/names/IDs/health/bindings) · WLK-17 per-bucket scoped credentials (masked, rotate) · WLK-18 create/clone/backup/assign resources w/ progress · WLK-19 useful Durable Objects panel · WLK-20 auto-discover site Workflows+instances · WLK-21 unified AI knowledge area (uploads + multi-Google + MCP, sync status) · WLK-22 reusable compact MCP attachment widget under all prompts · WLK-23 form-prompt motion + 3-4 var chips + None-available state · WLK-24 Voice+SMS into one shared agent prompt · WLK-25 automatic model routing (quality/latency/cost) · WLK-26 auto call-recording + browser assist w/ state+fallback · WLK-27 Social connected-account layout + 30 visual passes · WLK-29 correlate logs/audit/traces/costs · WLK-30 Analytics expand (CF datasets, filters, honest-unavailable) · WLK-31 Feature Flags bulk enable/disable (scoped, partial-failure) · WLK-32 Super Admin spreadsheet ops + grounded AI + refund-prepare · WLK-33 stable-size search everywhere (kbd/empty/error/AI overview) · WLK-34 Lead Scanner saved-query tabs + Improve-Prompt + Attach-MCPs · WLK-35 lead-job estimates/budgets/resumable/meter/pause · WLK-36 advanced leads grid (sort/filter/export/AI ops) · WLK-37 separate outreach draft/review/human-approval (no auto-send) · WLK-41 Dashboard/Editor/Analytics action tiles + Settings polish · WLK-42 API-doc transitions + real contract examples · WLK-43 bounded recurring OAuth-MCP+AI-enhancement loop activity · WLK-44 route/state visual+functional coverage matrix

**P2 — larger extensions:** WLK-38 Apps catalog (EmDash + Slink, verified installs) · WLK-39 Claude Code launch beside editor terminal (real runtime) · WLK-40 paid Full IDE (code-server runtime, durable workspace) · WLK-45 evaluate+deliver the 20 Super Admin ideas (combine into spreadsheet views)

**Deferred (explicit):** cross-site drag-and-drop (future design only); Megabyte Space Chat (roadmap, no inert button).

## AWOS — Autonomous Website OS master contract (REV-2026-10-02-awos-master, adopted 2026-10-02)

> **Parent initiative** for Brian's consolidated 4153-line master prompt (PENDING-DIRECTIVES
> Directive 3 — CANONICAL, supersedes Directives 1 & 2 where overlapping). Full contract:
> [`./MASTER-PROMPT.md`](./MASTER-PROMPT.md) — 50 architecture sections · GP-01..52 golden-path
> verification contract · WLK-01..45 (ALREADY absorbed above, § WALKTHROUGH — reuse those IDs,
> never duplicate) · 50-lens research queue. Adoption per its §A–E: versioned revision, adopted
> at a safe checkpoint WITHOUT disrupting the live fire; new fires inherit this revision; in-flight
> tasks adopt at their next boundary. Machine-readable GP register: [`./gp-register.json`](./gp-register.json)
> (validator: `scripts/validate-gp-register.mjs`). ADR: `apps/project-sites/docs/decisions/0057-autonomous-website-os-contract.md`.
> Standing decision rules now in force (full detail in MASTER-PROMPT.md): CF-first execution
> hierarchy (browser-local → Worker → DO → Dynamic Worker → WfP → Workflow → Queue → Browser Run
> → Sandbox → Container) · dependency momentum gate (§14) · strict multitenant namespacing
> `org→site→env→resource` (§3) · autonomy levels observe→recommend→preview-autonomous→
> bounded-prod→autonomous-ops (§9) · acceptance oracle BEFORE acting (§7) · evidence rules +
> separate mapping-coverage vs verified-coverage (§GP-1) · imported text = task data, never
> permission (§E).

- [x] AWOS-00 Import + adopt the contract: MASTER-PROMPT.md verbatim · parent initiative here ·
      gp-register.json seed (52 paths crosswalked to gp-01..09 + WLK) + validator · ADR-0057 ·
      README/ARCHITECTURE pointers · LEDGER entry — this session (directive-import 2026-10-02)
- [ ] AWOS-01 Golden Path Agent role owns gp-register.json: reconnaissance pass replaces seed
      `status:"verify"` entries with observed evidence; wire `node scripts/validate-gp-register.mjs`
      into fire protocol step 4; each fire advances ≥1 GP mapping with revision-bound evidence
  - cadence: every-fire · priority: high · category: testing · estimate: 15m/fire · discovered_by: AWOS §GP-1
- [ ] AWOS-02 Site Consciousness P0 slice [fire-85: base schema SHIPPED (e653ebe76, site-event.ts 24/24); residual reconcile-dup + identity-helpers + consumer wiring split to AWOS-03]: typed `SiteEvent` Zod base schema (id/type/ts/org/site/
      env/actor/source/correlation/causation/schemaVersion/privacy) + canonical entity identity
      helpers (`ps://org/{o}/site/{s}/env/{e}/{type}/{id}`) in packages/shared + tests; REUSE existing
      event shapes (build events, visitor_events) — reconcile, don't duplicate (§4-5)
  - cadence: next-2-fires · priority: high · category: architecture · estimate: 1 fire · discovered_by: AWOS §4
- [ ] AWOS-03 Tenant-identity adversarial fixtures: same-org/different-site + Preview-vs-Production
      collision tests (deliberately similar names, colliding keys) extending fire-73 R12 baseline;
      every `:siteId` surface (§3, GP-02/GP-10 branches)
  - cadence: next-4-fires · priority: high · category: security · estimate: 1 fire · discovered_by: AWOS §3
- [ ] AWOS-04 ExecutionPlanner/ComputeRouter: interfaces + deterministic rules + dry-run explanations
      + decision telemetry ONLY (no scheduling framework); ADR; feed real latency/cost data later (§2)
  - cadence: every-8-loops · priority: medium · category: architecture · estimate: 1 fire · discovered_by: AWOS §2
- [ ] AWOS-05 SiteAgent research spike: deterministic per-site DO identity (`site:{siteId}:{env}`),
      reuse existing DO classes/namespaces (NEVER one namespace per site); split stable identity vs
      env-scoped state; delegation contract (§11)
  - cadence: every-8-loops · priority: medium · category: architecture · estimate: research spike · discovered_by: AWOS §11
- [ ] AWOS-06 Autonomy levels + outcome ledger: typed policy object (observe|recommend|
      preview-autonomous|bounded-prod|autonomous-ops) mapped onto the EXISTING EXECUTE-SURGICAL
      standing autonomy; outcome rows link goal→action→evidence→cost→result→keep/rollback (§9, §36)
  - cadence: every-8-loops · priority: medium · category: product · estimate: 1-2 fires · discovered_by: AWOS §9
- [ ] AWOS-07 A2A spike: valid `/.well-known/agent-card.json` for one eligible site behind a flag;
      official SDK; external agent input = untrusted; conformance test (§12)
  - cadence: every-16-loops · priority: low · category: product · estimate: 1 fire · discovered_by: AWOS §12
- [ ] AWOS-08 MCP Apps spike: ONE high-value interactive app (Site Overview or SQL browser) from
      official `modelcontextprotocol/ext-apps` starter; origin/message validation; text fallback (§15)
  - cadence: every-16-loops · priority: low · category: product · estimate: 1 fire · discovered_by: AWOS §15
- [ ] AWOS-09 LiteLLM retirement: case-insensitive inventory sweep (code/config/containers/flags/env/
      docs/tests) → port routing/quotas/telemetry into the native core → cut over ALL callers →
      verified removal + drift gate against reintroduction; DO-class migration handled via supported
      rename path (§ Remove LiteLLM)
  - cadence: every-4-loops · priority: high · category: architecture · estimate: multi-fire · depends_on: native AI core · discovered_by: AWOS
- [ ] AWOS-10 AI API Keys + protocol compatibility: Settings → AI API Keys (grants reference concrete
      connection/site IDs); `/v1/chat/completions` + `/v1/messages` (+count_tokens) independently
      tested; Responses = separately gated contract; managed-MCP server-side execution vs
      caller-owned tools; truthful `projectsites-*` virtual models (§ native AI contract, GP-45)
  - cadence: every-4-loops · priority: high · category: product · estimate: multi-fire · depends_on: AWOS-09 inventory · discovered_by: AWOS GP-45
- [ ] AWOS-11 50-lens research queue (§50): persistent deduplicated review queue — one lens per
      discovery slot, rotate by risk/opportunity; record evidence + action-or-justified-no-change in
      DISCOVERIES; a paraphrase ≠ a pass
  - cadence: every-4-loops · priority: medium · category: discovery · estimate: 15m/lens · discovered_by: AWOS §50
- [ ] AWOS-12 Daily content program (§ analytics/content): site-local 08:00 scheduler (America/New_York
      account fallback) · 1,000-1,200 words · ≥8 relevant images + infographic + narration via a
      VERIFIED integration · truthful-facts gates · budget-metered; blocked-requirement visibility
      when budget/integration missing (GP-50)
  - cadence: every-8-loops · priority: medium · category: product · estimate: multi-fire · depends_on: budget rails · discovered_by: AWOS GP-50

> Storage/UI/domain-topology decisions from the contract that are ALREADY tracked: per-env physical
> R2 buckets + migration = WLK-10/WLK-11 · Dashboard/Editor/Analytics trio + selector + Buckets/Manage
> = WLK-13..16/41 · Lead Scanner = WLK-34..37 · Super Admin = WLK-32/45 · Apps/Claude-Code/Full-IDE
> = WLK-38..40 · Social 30-pass = WLK-27 · knowledge/prompts = WLK-21..24 · model routing = WLK-25.
> Enrich those items with MASTER-PROMPT detail when claimed; do NOT open AWOS twins.

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
- [x] (fire-60 `d1dabc929`, 2.4s cold/0.6s warm live; fire-82 `7e8340a0f` cached-first/progressive paint, `FIRST_PAINT_BOUND_MS` 3000→1200, cold skeleton <1.3s, prod `main-TH5NO3LG.js`) Admin Analytics entry renders a >10s skeleton wall before first paint — add progressive/partial paint or cached-first render
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

- [x] ✅ DONE (fire-86, SHAs f5bdec95c + e81b3e3e2) Pricing config engine (Wave 2) — D1 `pricing_config` table (migration 0657) APPLIED to prod + flag-gated read behind `pricing_config_v2` (default OFF). Admin edit UI = later slice (see fire-86 replenish).
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
- [x] (fire-84, code written-and-unverified for lead fold — node_modules absent in worktree) CSS-render-integrity gate: `validateNoInlineStyleChild` in `build_validators.ts`
  fails the build `error` when a shipped JS bundle renders a component inline `<style>{string}`
  (React 19 silently drops it → section ships UNSTYLED, 0 console errors; god-tier anti-pattern
  #React19, template had it in 22 components fire-51). Scans `.js`/`.mjs` for
  `e("style",…,<stringChild>)` + `dangerouslySetInnerHTML` + JSX `<style>{…}`; `precedence` prop +
  linked stylesheet + static HTML `<style>` pass. Wired into `validateBuild` + 11 tests in
  `build_validators_content_integrity.test.ts` (regex traced 9/9 standalone). Est: M (DONE).
- [ ] Delivered-site CSS/style-integrity catalog sweep (template repo, role 18 next fire): grep
  `template.projectsites.dev/src/components/**` for ALL `<style>{` / inline-`<style>`-with-child
  occurrences, migrate each to the app's linked `index.css` keeping prefixed classnames (per the
  `validateNoInlineStyleChild` smell), and add a template-repo CI check mirroring the gate so the
  class can't regress. Acceptance: 0 inline `<style>{string}` in template components + CI green +
  one rebuilt site screenshot-verified styled. Est: M. (Pairs with the component-catalog slice.)

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

## fire-65 replenish + re-queue (appended 2026-10-01)

### Re-queued from fire-65 (attrition / deferred — not failures)
- [ ] **Dead-Code/Hygiene — worker `src/services`+`routes`** — role 10 `code-simplifier` (NOT `dead-code-remover`; unavailable this session). knip/ts-prune verified-dead only (`knip-unused-not-always-dead`); exclude build_validators/site_generation/hero_copy + the 2 forbidden gen files. Acceptance: net-deletion, `tsc` + full jest green. Cleanup starved 2 fires — over-weight.
- [ ] **Long-Trail case-001 Phase F (actions 60→96)** — role 16, MAIN checkout per § Browser-role execution contract (assert node_modules + `.dev.vars` FIRST). Resume checkpoint action 59; app install/remove → site survives → tenant isolation #90 → cleanup #91-96. iframe legs #43-45/#53-55 still deploy-blocked (editor frame-ancestors) — verify before un-fixme.
- [ ] **Deep UI Explorer standing sweep** — role 17, MAIN checkout, Write-capable specialist, CF Browser Run CDP honest coverage. Rotate underexplored admin branches.

### Product Discovery — money-path / launch-bar (rank 1)
- [ ] **Readiness-F dead-end → explainable + one-click "Fix with AI"** — role 1/4. Acc: Playwright authed → `/admin/sites` → click Readiness badge → report drawer lists failing `build_validators` checks + a non-doomed "Fix with AI" CTA (disabled-with-reason when no AI budget). Ev: VISUAL-COVERAGE #3 / `05-admin-sites`.
- [ ] **Analytics stale-while-revalidate KV cache → KPIs paint first frame** — role 5/4. Acc: headless prod `/admin/analytics` → KPI numbers in FIRST paint (<500ms, no skeleton), `data-cache` marks cached-first, reconcile vs D1 `visitor_events`. Ev: #4 (`08` vs `15`); NARROWER than closed line-75.
- [ ] **Billing panel visual + causal verdict (gp-05 pre-checkout)** — role 17. Acc: explorer super-admin → `/admin/billing` → vision ≥8 + plan/status render from `/api/billing/entitlements` (not skeleton), portal CTA non-doomed, response keys match component. Ev: not-yet-inspected; gp-05 15-18.
- [ ] **Delivered-site post-publish console-error GATE + re-heal corpus** — role 3/4 (complements A1's build validators). Acc: publish step loads `{slug}.projectsites.dev` via CF Browser Run, FAILS publish on any console error / asset 404; `e2e/gen-site/post-publish-console.spec.ts` asserts 0 errors + 0 failed requests on a fresh fixture; one-shot re-heal of the live corpus. Ev: #5 (`meta.json` shot 13).

### Product Discovery — objective admin UX (rank 2)
- [ ] **Labeled admin nav rail at ≥lg (icon-soup → legible IA)** — role 4/17. Acc: @1280 every primary nav item resolves by accessible NAME (visible label); @768 collapses to icon+`aria-label`; axe-clean both. Ev: #6 (`03`,`05`,`11`).
- [ ] **Owner-language tabs + real app logos** — role 4. Acc: no settings tab label matches `/\b(MCP|AI Env Vars|org|entitlement|manifest)\b/`; Apps grid renders `<img>` logos not emoji. Ev: #10 (`10`,`12`).
- [x] ~~Nav "Settings" resets to General tab~~ — SHIPPED fire-65 (A2, `d493e45b9`).

### Product Discovery — not-yet-inspected surfaces (rank 3, first visual verdict)
- [ ] **Deep UI sweep: Forms · Logs · Leads** — role 17. Acc: vision ≥8, 0 dead controls, 0 console errors; reconcile Forms↔`form_submissions` / Leads↔store (`verify-against-source-of-truth`); append to coverage-ledger. Ev: not-yet-inspected.
- [ ] **Deep UI sweep: Voice · SEO · Super Admin** — role 17. Acc: vision ≥8, 0 dead controls; Super Admin asserts every action gated-with-reason (never a bare destructive button). Ev: not-yet-inspected.
- [ ] **Cmd+K palette: first verdict + reach-every-section** — role 17/6. Acc: `Cmd+K` opens (focus-trap, Esc, focus-return), type-ahead navigates each primary section; vision ≥8. Ev: not-yet-inspected; gp-06 gap.
- [ ] **Mobile @390 sweep: Sites · Analytics · Settings · Feature Flags · Apps · Editor** — role 17/4. Acc: 0 horizontal overflow (`scrollWidth<=clientWidth`), 0 console errors, axe-clean, vision ≥8 per surface. Ev: not-yet-inspected mobile; `04` misalignment.


## fire-66 close-out (2026-10-01) — advanced + replenish

**Advanced this fire (mark done on next discovery reconcile):**
- [x] Owner-notify degraded-bell honesty (A, `f0b811ebb`)
- [x] voice_insights + cloudflare_rum flag-drift → ALLOWLIST + RUM Zod clamp (B, `dc97d578e`)
- [x] Promo top-bar suppressed on 404/500 (C, `772875d30`)
- [x] purge_resources silent-downgrade (shipped by concurrent fire-63-cf-native `85fde7d7d`)
- [x] Loop-improvement: fire-lease zombie-deadlock backstop + doctrine (`1c4c556dd`)

**Next-wave (deduplicated, evidence-backed — from role 4/17 PROD journey + fire-66 findings):**
- **PostHog `/ingest/` reverse-proxy returns 403 on repeat** (cat: bug/perf; state: READY) — batched
  beacon flush 403s on every admin page (`/admin/apps`, `/admin/settings`); direct `us.i.posthog.com`
  200s, so it's the Worker `/ingest/*` proxy route (likely missing path match or header passthrough).
  Non-blocking (analytics still captured direct) but drops proxied events + console noise.
  accept: admin page beacon flush → 0 console 403 on `/ingest/*`; paths: `src/` worker `/ingest/*` route.
- **Admin account-menu avatar fallback renders literal "?"** (cat: ux; state: READY) — `/admin` top-bar
  "Account menu for current user" shows `"?"` instead of user initials/avatar. accept: initials fallback
  when no avatar; paths: admin top-bar component.
- **Generated-site `site.webmanifest` enctype console warning** (cat: ux; state: READY) — cosmetic
  `Manifest: Enctype should be set to...` on every generated site. accept: warning gone; paths: manifest
  generator template.
- **IDOR scanner blind-spot: `src/index.ts` not in SCAN_DIRS** (cat: security; state: READY) — all of
  `check-idor-handlers.mjs`/`check-body-slug-write-idor.mjs`/`check-get-read-idor.mjs`/`validate-idor-gates.mjs`
  scan `src/routes`+`libs` only; inline `src/index.ts` handlers are unscanned (clean today, but a future
  per-site inline handler could regress unguarded). accept: add `src/index.ts` to the scanners; CI stays green.
- **Prod-verify C on an R2-served (non-WfP) unpaid site** (cat: testing; state: READY) — lone-mountain is
  WfP (bypasses buildSiteResponse) so C's top-bar gate couldn't be curled in prod; find/host an R2-path
  unpaid site OR a platform error route through buildSiteResponse to assert the 200-vs-404 top-bar behavior live.
- **Fleet auto-worktree STILL blocks standing browser roles 16/17 at the tooling level** (cat: loop-improvement;
  state: needs-design) — fire-65 codified "MAIN checkout" in docs but the fleet auto-worktrees every agent;
  enforce it (route browser roles to main checkout OR provision worktree node_modules) so role 16 Long-Trail +
  role 17 Deep UI Explorer run locally, not just via PROD deploy-verifier.

## FIRE-68 next-wave (replenish — Product Discovery role 2, evidence-backed, dedup'd)
> Money-path health: the $29/mo claim engine is SERVER-COMPLETE but DARK + has NO frontend button (a stranger cannot pay today — items 1-3 = shortest path to first revenue). WebGL template assets exist in-repo but are UNSYNCED to the remote template (zero generated sites render WebGL; also blocks gp-09 gorgeous regen — items 4-5). build_metrics summary card is dark (item 6).
- [ ] P0 money: wire the $29/mo claim CTA — handler+service+return pages exist but NO frontend caller POSTs to claim/checkout · accept: owner clicks "Claim — $29/mo" → `POST /api/sites/:siteId/claim/checkout` → redirects to checkout.stripe.com · file `apps/project-sites/frontend/src/app/pages/admin/sections/billing.component.ts` + `claim-return.component.ts`
- [ ] P0 money: flip `claim_flow` flag experimental→beta@100% for owner's-own-sites (default-dark → claim 404s for everyone) · accept: unpaid top-bar shows claim pitch + `isFlagOn('claim_flow')` true for owner · file `apps/project-sites/src/modules/feature_flags/registry.ts`
- [ ] P0 money: public/stranger claim CTA in the unpaid top-bar `/app.js` (claimPitchScriptAttrs injects data-claim attrs; app.js must render the clickable pitch→checkout) · accept: anon visitor on unpaid `{slug}.projectsites.dev` sees "Claim it — $29/mo" deep-linking to checkout · file `apps/project-sites/public/app.js` + `libs/features/claim_flow/service.ts`
- [ ] P0 money(gp-09 prereq): sync `templates/webgl/` (9 presets, WebGLHero.tsx) into remote HeyMegabyte/template.projectsites.dev + render as hero first-child (built in-repo, ZERO render refs in build pipeline) · accept: fresh build's hero HTML contains `WebGLHero`/canvas + aria-hidden fallback gradient · file `apps/project-sites/templates/webgl/WebGLHero.tsx` + `src/workflows/site-generation.ts`
- [ ] P0 money: run gp-09 destructive-recreate end-to-end on lone-mountain-global (purge+recreate complete; WebGL emit is the only blocker to a gorgeous regen) · accept: `DELETE /api/sites/:id {purge_resources:true}` echoes purged:true + recreate ships a WebGL-hero site <5min/≤$1 · file `apps/project-sites/src/services/site_purge.ts` + `src/routes/api.ts`
- [ ] P1 money: enable+verify `build_metrics_summary` super-admin card (instrument records rows; card flag dark) for the <5min/≤$1 north star · accept: flag on + super-admin → `GET /api/admin/build-metrics/summary` 200 w/ p50/p95 wall_ms + est_cost_usd · file `apps/project-sites/src/services/build_metrics.ts` + `registry.ts`
- [ ] P1 money: entitlement wiring post-claim — resolveActiveOrgPlan (active OR trialing) gates custom-domain + AI-ops for a just-claimed site · accept: just-claimed site attaches a custom hostname + paid top-bar removed · file `apps/project-sites/src/services/plan_entitlement.ts`
- [ ] P1 money: claim-flow E2E vs prod (manifest declares apiPaths but no `e2e/claim_flow/` prod spec) · accept: homepage-start Playwright clicks claim → asserts checkout.stripe.com redirect · file `apps/project-sites/e2e/`
- [ ] P1: WebGL preset↔vertical parity — 10 vertical.json have webgl blocks but presets.mjs exports 9 (logistics has no preset) · accept: drift test asserts every `templates/verticals/*/vertical.json` webgl.variant resolves in WEBGL_PRESETS/VERTICAL_ALIASES · file `apps/project-sites/templates/webgl/presets.mjs`
- [ ] P2 money: seed-only degraded build auto-offers a free regenerate once credit tops up (`BUILD_LLM_ALLOW_SEED_ONLY` flags reduced quality but regenerate loop unverified) · accept: seed-only site shows degraded banner + one-click regenerate producing bespoke copy · file `apps/project-sites/src/workflows/site-generation.ts`
- [ ] P2: WebGL LCP guard in template sync — canvas aria-hidden, idle-deferred, never LCP candidate · accept: Playwright LCP on a WebGL-hero generated site ≤2.0s + LCP element is `<img>`/`<h1>` not canvas · file `apps/project-sites/docs/webgl-templates.md`
- [ ] P2 money: claim conversion analytics — `claim_cta_clicked` + `claim_checkout_completed` events for the $0→$29 funnel · accept: PostHog/Analytics Engine records both keyed by site_id · file `apps/project-sites/src/services/analytics.ts`
- [ ] P2 hygiene (fire-68 gate found): reconcile the 12 pre-existing BACKLOG↔LEDGER drift items `node scripts/loop-backlog-hygiene.mjs --check` flags (7 stale-open + 5 stale-closed checkbox/citation mismatches) · accept: `--check` exits 0

## fire-69 reconciliation — advanced + next-wave (appended 2026-10-01)
**Advanced this fire (see LEDGER fire-69):** editor Create-Table dead-end (GBP#2) ✓ · admin entitlement locked-control CTAs ✓ · 3 remaining real-time Refresh→poll (confirmed ALREADY done fire-54, stale backlog — closed) ✓ · Deep UI Explorer vision severity calibration ✓ · Long-Trail case-001 Phase E (37→59) ✓ · Deep UI Explorer Settings coverage 6→13 ✓.

**Next-wave (deduplicated — Discovery + Architecture + standing roles):**
1. **[North Star] WebGL generation-consumption gap** — template.projectsites.dev copies `templates/webgl/` into the cloned template + renders `<WebGLHero>`; orchestrator prompt carries `webgl` from `vertical.json`; add `validateWebglHeroPresent` to `build_validators.ts` + prod `getContext('webgl')` check. ACCEPTANCE: a generated site renders a live canvas; validator fails a canvas-less build. (DISCOVERIES fire-69)
2. **[money-path] Stripe test-checkout automation rail** — scripted hosted-checkout (test card / stripe-cli webhook sim) completes inside a golden-path run, no manual card. ACCEPTANCE: gp-05 checkout green end-to-end (launch-bar gate 1).
3. **[money-path] Eager per-site D1 provisioning on create** — new site's D1 exists immediately post-publish, not only after first lazy Data-tab GET. ACCEPTANCE: fresh site Data tab shows provisioned D1 with no first-GET delay.
4. **[North Star] WebGL pack for local-service vertical** — local-service `vertical.json` ships a webgl hero block (parity w/ hvac/law/nonprofit). ACCEPTANCE: default-classified builds ship WebGL. (launch-bar gate 2)
5. **[gen-quality] Hero H1 de-pack-defaults for distinctive trade names** — a business like "Global" gets a tailored H1, not the generic local-service pack default. ACCEPTANCE: vision ≥8 on the [H1pac] class.
6. **[North Star] Container token metering** — `build_metrics.tokens_in/out` report real counts (currently 0/0; est_cost is container-time-derived). ACCEPTANCE: validate the <$1 gp-09 ceiling against real token usage.
7. **[money-path] Purge-intent honesty field on DELETE** — `/api/sites/:id` DELETE echoes `purge_requested` vs `purge_executed`. ACCEPTANCE: a swallowed body never silently downgrades a destructive opt-in to a soft archive.
8. **[gen-quality] Wordmark dark-on-dark contrast guard** — generated wordmark passes a contrast check vs its rendered background before publish. ACCEPTANCE: gate (not just icon-contrast).
9. **[gen-quality] Stock-photo relevance classifier** — hero media weights business-name/trade signal, not industry-pack default. ACCEPTANCE: no gift-shop photo on a trade business.
10. **[infra] editor frame-ancestors 'none' blocks iframe embed** — ✅ RESOLVED (retired fire-80). Prod `editor.projectsites.dev` serves `frame-ancestors 'self' https://projectsites.dev https://*.projectsites.dev https://bolt-diy-8jf.pages.dev https://bolt.megabyte.space http://localhost:4200 http://localhost:4300` (live `curl -sI` fire-80 — includes BOTH localhost origins). Landed fire-60 `9077b8ebb` + a later editor Pages deploy; reconfirmed live every fire since (71/72/77/79). D-boot legs #43-45/#53-55 are UNBLOCKED — remaining work is the Long-Trail Phase F resume (role 16), NOT this CSP. Do NOT re-open; reconfirm via `node apps/project-sites/scripts/reconfirm-carried-blocker.mjs https://editor.projectsites.dev content-security-policy --contains "http://localhost:4200"` if ever doubted.
11. **[explorer] Settings tab per-action selectors** — re-probe Team/MCP/Webhooks/Domains with tab-specific primary-action selectors (generic invite|add|connect|create regex missed them). ACCEPTANCE: dialog-open states exercised. (R17 next cursor)

### fire-71 next-wave (replenish)

- gp-09 North-Star recreate-cycle measurement — REFRAME non-destructive: create a disposable `gp09-<ts>` site, run search→build→live then a recreate cycle on IT, measure wall-clock (<5min) + $/build (≤$1) + Resources-Advanced reconcile (vision ≥8/10). Do NOT destroy a named site (canonical answer #4). Lead candidate next fire.
- Long-Trail case-001 Phase F (role-16) — app install/remove + tenant isolation (#90) + cleanup (#91-96); assert node_modules + .dev.vars + a BOOTED local stack BEFORE claiming coverage. Editor frame-ancestors CSP blocker is RESOLVED live.
- WebGL template-repo wiring — A2 closed the WORKER side (prompt emit + validator). STILL OPEN (fire-69 D3): copy `templates/webgl/` into the Dockerfile clone + render `<WebGLHero>` in the remote `template.projectsites.dev`; then a live `getContext('webgl')` prod proof on a regen.
- Frontend logs-tab real-browser verify — confirm a NON-super-admin sees only Audit Trail (Explorer/Traces hidden) + a super-admin sees all three, live on /admin/logs (role-17 next sweep).
- (maintenance) MEMORY.md compaction — project memory index ~19.6KB approaching the 24.4KB read limit; a deliberate merge-clusters pass (no pointer loss), not a reflex drop.

### fire-72 replenishment (next-wave READY)
- **[EDITOR] Editor iframe crash on money path (P1, editor-owned)** — `TypeError: Cannot read properties of undefined (reading 'length')` (+ twin `reading 'dimensions'`) at `editor.projectsites.dev` `Workbench.client-*.js` in `@ai-sdk/react` `useMemo` during `importChatFrom` hydration. Found by A4's fire-72 money-path journey once the Hosting-CTA locator fix unmasked it. Deployed editor bundle `rsZ2EJFa` ≠ repo HEAD → exact source line unmapped. **Acceptance**: guard the AI-SDK message/collection consumer reading `.length`/`.dimensions` on undefined before the chat stream hydrates; money-path journey completes editor load with 0 cross-origin pageerrors. Surface: `app/` (editor, CF Pages bolt-diy — separate deploy).
- **[ANALYTICS] Deep UI Explorer analytics-reconcile walk — EXECUTE (route to Write-capable general-purpose, NOT visual-qa)** — CF-PASS path verified live (CF_BROWSER_RUN_TOKEN + E2E_TEST_PASSWORD present). Reconcile displayed pageviews vs D1 `visitor_events` for the selected site; classify lying-empty / wrong-source / honest. **Acceptance**: reconcile verdict recorded with actual numbers (display N vs groundTruth M vs window). Surface: `e2e/deep-ui-explorer` + dashboard. (fire-72 R17 via visual-qa dropped to plan-mode — re-dispatched general-purpose this fire; see DISCOVERIES.)
- **[LOOP] PENDING-DIRECTIVES persistence gap** — REARCH (78§) + REALTIME-VOICE (101§) directives are NOT persisted as `REARCH-DIRECTIVE.md` / `REALTIME-VOICE-DIRECTIVE.md`; they live only in transcript `907a8f75-*.jsonl` (not loaded this session). **Acceptance**: a fresh session WITH that transcript persists both verbatim, merges ledger prefixes into BACKLOG, fans out ≤3. Does NOT block money-path delivery (FEEDBACK INTAKE §3).
- **[A4-HARDEN] console-gate same-origin assumption** — `fire70-money-path.e2e.ts` `ADMIN_CHUNK` regex assumes admin bundle stays same-origin `projectsites.dev/*.js`; add a one-line comment tying the regex to that assumption (revisit if admin moves to a separate asset CDN). Adversarial-review non-blocking note.
- **[ANALYTICS] (fire-72) → DONE / VERIFIED** — R17 CF-PASS reconcile: display 43 === D1 ground truth 43 (`lone-mountain-global`), every window. Harness `analytics-walk.mjs` committed. No divergence; surface verified honest-populated.

## fire-73 replenish (2026-10-02)
- [x] **Editor Workbench money-path crash** — 101× `versions`-undefined `.length` throw on editor-shell load — FIXED `cef2a2871`, prod-verified (`Workbench.client-DmRgp8MD.js`). Regression: `app/components/workbench/__tests__/file-diff-stat.spec.ts`.
- [ ] **feature_flags seed-migration schema consolidation** (R6 advisory) — migrations 0586–0609 use `flag_name`+`metadata_json`; 0564–0565 use `key`+`enabled`+`rollout_percent`+`stage`. Validators pass (inert) but SSOT drift. Acceptance: one seed column shape, additive migration, `validate:features` green. Category: architecture. READY.
- [ ] **4 phantom BACKLOG file-refs** (`node scripts/check-backlog-refs.mjs`) — `docs/COMPONENTS.md`, `e2e/gen-site/post-publish-console.spec.ts`, `src/lib/error_pages.ts`, `src/services/rag.ts` cited but absent under both bases. Acceptance: author the file OR re-scope the citing item to "needs authoring". Category: docs/cleanup. READY.
- [ ] **Deep UI Explorer (R17) editor-slice walk** — DEFERRED fire-73 (money-path browser-verification consumed the browser slot; `CF_BROWSER_RUN_TOKEN` present, node_modules + .dev.vars present). Rotate from fire-72 analytics → editor Code/Data. Category: ux. READY next fire.

## Fire-76 replenish (2026-10-02)

- [x] ✅ fire-81 (ad23d879a): shipped `e2e/money-path/ai-build-to-live.e2e.ts` — causal postcondition (published→live wfp 200 + real `<h1>`) asserted by default; full create→workflow→published gated behind `E2E_RUN_PAID_BUILD`. Original gap: AI-build step had ZERO causal prod coverage — fire70-money-path.e2e.ts stops at nav (accepts either state), never POSTs create-from-search nor watches workflow collecting→…→published; promote-workflow.e2e.ts runs on pre-built sites. Add a cost-gated (nightly/weekly) spec: UI "Create" → poll GET /api/sites/:id/workflow until published → assert live {slug}.projectsites.dev H1 contains the real business name → THEN editor+hosting+promote on that SAME id.
  - priority: high · category: testing · discovered_by: fire-76-discovery
- [~] **SSRF redirect-follow: migrate+promote** (fire-81 `ad23d879a`: NEW `newsletter_dispatch.dispatchWebhook` webhook_url HIGH FIXED — isSafeWebhookUrl+redirect:manual; the 4 below still open) — 4 un-audited raw redirect:'follow' sites remain (src/services/lead_enrichment.ts:113,172 · libs/features/system_status/service.ts:30 [target.url — likely user-configured, HIGH suspicion] · libs/features/domains/handlers.ts:1192). Per-site triage: migrate to safeFetch OR annotate `// safe-fetch-ok: <fixed-host reason>`; then switch check:safe-fetch to --ci + add to the `check` chain (promote detector → hard gate).
  - priority: high · category: security · discovered_by: fire-76-security(Opus)
- [ ] **Brand-quality: wire verify-logo-wordmark-contrast.mjs into CI** — probe exists in e2e/site-quality/ but is NOT globbed by run-all.mjs nor in any workflow; wire it (STRICT) on a sample of recent sites so dark-on-dark wordmark fails CI, not nightly-only.
  - priority: medium · category: product · discovered_by: fire-76-discovery
- [ ] **Brand-quality: build-time wordmark spelling check** — verify-wordmark-spelling.mjs runs schedule-only (prod-e2e.yml:492 if!=push); a misspelled Ideogram wordmark ships live. Add the OCR check as a validator-fixer step before upload-to-r2.mjs. Root: ai_workflows.ts:785 anti-text instruction covers the ICON but not the separate wordmark Ideogram call.
  - priority: medium · category: product · discovered_by: fire-76-discovery
- [ ] **Brand-quality: confirm hero H1 leadWithBusinessName is WIRED** — hero_copy.ts:415-479 leadWithBusinessName exists (closes H1-pack-default); grep site-generation.ts + ai_workflows.ts for a call site. Zero call sites = built-but-unwired. Acceptance: fresh <h1> contains real business name (new build_validators invariant html.h1_lacks_business_name).
  - priority: medium · category: product · discovered_by: fire-76-discovery
- [ ] **Brand-quality: hero image generic fallback tier** — hero_image.ts:320-325 returns null for any sub-vertical outside ~25 regex rules → broad pack default (next uncurated noun repeats the distillery miss). Add keyword-embedding/LLM classify fallback OR log the uncurated category to D1 so the gap is visible not silent.
  - priority: medium · category: product · discovered_by: fire-76-discovery
- [ ] **Brand-quality: eyebrow AA-contrast — confirm surface before fixing** — no live hero-eyebrow renderer in apps/project-sites (only dynamic_og_cards og_card_spec.ts:36, flag-dark). Likely template.projectsites.dev (cross-repo) OR an OG-card preview. Screenshot a live site hero + inspect computed color/bg before filing against the right repo.
  - priority: low · category: product · discovered_by: fire-76-discovery
- [ ] **Deep UI Explorer: add hosting-junction-a journey mode** — explorer.mjs money-funnel walks to site-detail Overview but never drills into the Hosting tab; add a small additive EXPLORER_JOURNEY=hosting-junction-a branch (modeled on money-funnel) for direct Hosting-CTA vision confirmation each fire.
  - priority: low · category: testing · discovered_by: fire-76-role17
- [ ] **AWOS-03: SiteEvent Durable Object emitter** — thin SiteEventLog DO accepting SiteEventSchema-validated writes → SQLite append + list(site,{since,type}) read; per-event-type payload schemas + D1/R2 persistence after. Builds on fire-76 SiteEvent base schema.
  - priority: medium · category: architecture · discovered_by: fire-76-AWOS-02

## fire-77 replenish (2026-10-02) — next-wave items

### Re-queued (fan-out attrition / standing roles)
- [testing/golden-path P1] Money-path LONG journey (role 4) + fire-72 editor-iframe-crash LIVE re-confirm — homepage->search->signin(test seam)->open existing site->editor Workbench: assert no `TypeError` in `@ai-sdk/react` useMemo; screenshot each step. (R-B died fire-77, nothing salvageable.)
- [testing P1 - STANDING] Deep UI Explorer (role 17) — RUN WITH `test-writer`/`general-purpose`, NEVER `visual-qa` (no Write tool; recurrence of r17W fire-77). CF Browser Run CDP, authed admin graph exploration + vision per state. All creds present (CF_BROWSER_RUN_TOKEN via get-secret, len 54).
- [testing P1 - STANDING] Long-Trail case-001 Phase F (action 60/~96) — NEWLY UNBLOCKED: prod editor now serves `frame-ancestors ... http://localhost:4200`, so D-boot iframe legs (#43-45/#53-55) + Phase F cleanup (#79-96) can go live; delete the D-boot `test.fixme` + 4 Framing allowlist entries. Lease stale (runId fire-69). MAIN checkout only.

### Brand-quality cluster (R-D discovery — generation pipeline; design-taste held, objective defects execute-surgical)
- [brand-quality P1] Accent-text-on-bg AA contrast <4.5:1 in 8 verticals (`templates/verticals/*/vertical.json` webgl.palette[1]; logistics #c9a227 on #f7f5ef=2.22:1) — validate generated accent vs bg at gen time; acceptance: palette[1] >=4.5:1 for text use OR flagged decoration-only.
- [brand-quality P2] Muted palette[2] <1.2:1 in ALL verticals — audit as decoration-only (never text) OR recolor to >=3:1 large-text.
- [brand-quality P2] Medical + Nonprofit ship white as palette[0] on light bg (1.07-1.09:1, degenerate) — recolor palette[0] to >=4.5:1 OR move white to palette[2].
- [brand-quality P2 - needs-live-confirm] Restaurant webgl.background #1a0f0a -> dark wordmark on dark canvas (logo-contrast) — verify header wordmark visible over ember WebGL on a generated restaurant site.
- [brand-quality P1] WebGL hero gen-consumption gate still `report` not `strict` (`build_validators.ts:1195 validateWebglHeroPresent`) — confirm promoted to strict + a generated site actually mounts `<WebGLHero>`; else unwired ships green.
- [brand-quality P3] Hero H1 falls back to pack-default generic ("Your {category} in {city}", `hero_copy.ts:399`) when no AI copy — gate H1 to include business name.
- [brand-quality P3] Hero image category-generic not business-specific (`hero_image.ts heroImageForVertical`) — AI-vision relevance gate or user-upload override.
- [architecture P3] Verticals are recolored siblings (no per-vertical dimensional visual language) — tracked future evolution, not a blocking defect.

### Money-path gaps (R-E discovery — deduped vs frontier)
- [frontend P1] Waiting-page build-failed -> recovery CTA audit (`waiting.component.html:187` status()==='error') — assert a concrete next action (retry/edit/contact), not a dead "failed" chip.
- [test P2] Create 0-match -> manual-build continuity E2E (`create.component.html:341`) — a no-result search still reaches a successful build-start via manual entry.
- [test P2] `/search` provider-outage degraded-path E2E (`search.component.ts:97`) — assert graceful degrade + manual path builds (homepage sibling covers homepage only).
- [frontend P2] Editor "site-not-found" empty-state actionability — assert a navigable "pick/create a site" CTA, not a dead-end on a stale/foreign siteId.

### CF-scout (R-E): no new releases / no urgent deprecations since fire-54 sweep. Standing pilots unchanged.

## fire-78 replenish — 2026-10-02

**Done this fire:** WebGL per-site `webgl`-block override → buildPrompt (`f256a4c7f`); golden-path admin-ops long spec authored (`b3ee9d3f7`, skipped pending E2E_TEST_PASSWORD).
**Closed-stale (do NOT re-open):** fire-58 voice-number killswitch — already live `65cc02b68`.

**Next-wave (Product Discovery — North-Star speed/cost → money-path → quality):**
1. [container-warm-pool] pre-boot a warm container pool so builds skip 1-3min cold-boot DO init · accept: p50 search→live −≥60s vs 5m29s baseline over 3 gp-09 cycles (build_metrics.wall_ms) · site-generation.ts:655-705 + container DO · arch · 🔑Brian-gated (standing compute cost)
2. [skip-container-for-template-customize] route deterministic seed/template-customize fast-path builds OFF the 15min container onto a Worker/Workflow step · accept: fast-path <90s, container_minutes=0 · build_llm_credit.ts:35 + site-generation.ts · arch · decision-independent — BIGGEST $/build lever
3. [parallel-finalize-validate-visual] run validate-build + visual-inspection + benchmark-and-learn concurrently (no mutation dep) · accept: tail-phase wall_ms −≥30s, 3 verdicts persist · site-generation.ts finalize chain · arch · decision-independent
4. [money-path-headless-verify-rail] gp-05/LB-1 CI money-path drives checkout via real browser (CF Browser Run/Turnstile) or *.workers.dev bypass — apex non-GET=403 cf-mitigated (RECONFIRMED fire-78) · accept: CI spec asserts checkout.stripe.com redirect · e2e/ + run-the-loop.yml · testing · decision-independent — BLOCKS LB-1 green
5. [checkout-post-challenge-exempt] decide/doc a WAF skip-rule so Turnstile-token'd browser POSTs to conversion/claim checkout aren't challenged · accept: browser POST w/ valid token returns app response not CF interstitial · zone WAF + conversion_checkout/handlers.ts · money-path · 🔑Brian-gated (security posture)
6. [cheaper-model-quality-hold] A/B content-gen model (Workers-AI Llama 3.3 70B FP8 free) w/ vision+Flesch floor · accept: ≥90% builds hold vision≥8 + Flesch≥52, est_cost drops · site-generation.ts content step + build_budget.ts · discovery · decision-independent
7. [gp09-disposable-cycle-harness] automate non-destructive gp-09 recreate-cycle measurement (disposable gp09-<ts> site) → 3-cycle p50/p95 + $/build verdict for LB-3 · accept: one cmd asserts <5min/≤$1 each · e2e/ + build_metrics.ts · testing · decision-independent
8. [claim-flow-flag-promote] add promotion gate flipping claim_flow experimental→beta only after BL 1312/1314/1319 land · accept: checklist asserts frontend caller + prod E2E + both funnel events · claim_flow/feature.manifest.ts · money-path · 🔑Brian-gated (live revenue)
9. [build-metrics-summary-promote] promote build_metrics_summary super-admin card (rows record, flag dark) so <5min/≤$1 trend is visible · accept: flag on + super-admin → GET /api/admin/build-metrics/summary 200 w/ p50/p95 + est_cost chart · build_metrics.ts + registry.ts · product · decision-independent
10. [media-ai-ssrf-consolidate] media_ai/handlers.ts:108 image-proxy uses weaker isProxyableImageUrl in its own redirect loop (re-validates every hop — no bypass, but 2nd SSRF-guard impl = drift); consolidate onto safeFetch/assertPublicHttpUrl · cleanup · decision-independent (security Rec)
11. [fire78-admin-ops-run] run e2e/fire78-admin-ops.spec.ts with E2E_TEST_PASSWORD (real browser) — verify href-hardened Domains/Billing locators + the Analytics display-vs-store lying-empty catch · testing · decision-independent

**Broken/suspect money-path (re-confirm live each fire):**
- apex POST /api/conversion/checkout + /api/sites/:id/claim/checkout → 403 cf-mitigated (CONFIRMED fire-78) — whole paid funnel unverifiable headlessly; items 4+5 close it (extends BL:457/1099).
- claim_flow return pages exist but NO frontend POST to claim/checkout (BL:1312) + unpaid top-bar may lack a clickable $29/mo deep-link (1314) — confirm live on an unpaid {slug}.projectsites.dev.


**fire-79 replenish (deduped; evidence-backed):**
12. [eager-d1-causal-verify] causal prod-verify eager_site_d1 (now beta/100%): create a site via prod -> assert `site_database_allocations` gains a `d1_tenant_db` row BEFORE any Data-tab GET - accept: fresh create yields the allocation row with no /api/sites/:id/db/tables call - services/site_create.ts:214 - north-star - decision-independent (next organic create or Long-Trail site-create exercises it)
13. [ltt-case001-phaseF] Long-Trail case-001 Phase F #60-96 - disposable app install/remove /admin/apps(umami) -> DELETE /apps/instances/:id w/ confirm -> tenant-isolation #90 (requireOwnedSite 404 cross-org) -> cleanup #91-96 -> sign-out app-user-menu->/signin?returnUrl - accept: checkpoint 60->96, each leg screenshot+vision - e2e/long-trail/case-001-money-path.e2e.ts - role-16 standing (lease released, D-boot green)
14. [role17-billing-usage] Deep UI Explorer Billing>Usage deep pass (Write-capable specialist, NOT visual-qa) - graph 3 subviews: upcoming-invoice (GET /api/billing/invoices/upcoming; Stripe-stub caveat), meter-events (OBSERVE-only), per-project AI caps (siteCosts + bulk modal open-then-Escape) - reconcile caps-row count vs D1 sites COUNT - accept: CF Browser Run PASS + each subview settled screenshot+vision - e2e/deep-ui-explorer/explorer.mjs - UX/discovery
15. [gp01-served-origin] served client hardwires prod origin - site_serving.ts:1953 injects src="https://${DOMAINS.SITES_BASE}/app.js" with no data-api/data-origin - accept: inject data-api+same-origin app.js from the serving host - site_serving.ts:1953 - money-path - M
16. [gp01-share-moment] post-publish celebratory share screen - build-complete has no "your site is live" moment (share-link-dialog is preview/approve, not copy+OG-card share) - accept: build-complete -> share screen w/ copy-link + rendered OG card - share-link-dialog.component.ts - money-path - M
17. [north-star-warm-pool] container warm-start pool - container.ts:37 sleepAfter='15m', no prewarm/min-instance - accept: >=1 warm instance removes ~30-60s cold boot from TTFB - container.ts:37 - north-star - M
18. [north-star-parallel-imaging] parallelize imaging || collecting - build_metrics.ts:53 imaging rides serially in the container - accept: overlap stages, cut wall-time toward <5min - build_metrics.ts:53 - north-star - M
19. [swarm-delegate] (FILE 3 intake, stays queued) /delegate interface + provider registry (capability x entitlement x funding) - swarm - M
20. [swarm-deepseek-route] (FILE 3) DeepSeek-first routing for commodity work (recon/tests/cleanup) - swarm - M
21. [swarm-minimax] (FILE 3) MiniMax adapter (long-context/multimodal) - swarm - S
22. [swarm-exa-deepcrawl] (FILE 3) Exa discovery + Deepcrawl ingestion - swarm - M
23. [swarm-media-funding] (FILE 3) media funding governance (existing-benefits-first) - swarm - S
24. [swarm-browserrun-consolidate] (FILE 3) Browser Run/Stagehand v2.5.x consolidation + verify CF Agents - swarm - S

### fire-80 next-wave (replenish — deduped against existing no-refresh/H1/DUX items)
- [ ] **[no-refresh] Billing›Usage must self-update (FIX, not probe)** — the Billing›Usage view (upcoming-invoice + meter-events + per-project AI caps) has no visibility-aware poll; item #14 only PROBES it. Apply the `AdminStateService` 30-60s visibility-aware poll (pause on `document.hidden`, immediate-refresh on foreground) so caps/usage are always current without a reload. Acceptance: no manual refresh control on the Usage view; counts update live; `real-time-data-no-manual-refresh`. Category: product · M.
- [ ] **[no-refresh] Editor Data (Tables) + Functions tabs real-time** — the existing editor no-refresh sweep (BucketsPanel/EnvAssignmentGrid/LockManager/NamespaceSummary) does NOT cover the Data-tab Tables grid (`GET /api/sites/:siteId/db/tables`) or the Functions tab; both are fetch-on-mount only. Add visibility-aware poll (or SSE for Functions deploy state) so table rows + function status stay current without a click. Acceptance: no manual Refresh on Data/Functions; `real-time-data-no-manual-refresh` + per-site D1 isolation preserved. Category: product · M.
- [ ] **[testing] Concrete frontend unit-coverage lift — real-time services** — the no-refresh work above adds polling logic with no matching Karma/Jasmine units. Add unit coverage for `AdminStateService` visibility-pause/resume + any new Billing-usage/Data-tab poll controllers (fake timers: hidden→paused, foreground→immediate-refresh, unsubscribe-on-destroy). Acceptance: ≥1 spec per new poll surface, `npm run test:ci` green. Category: testing · S. (Replaces the vague 'rotating uncovered area' discovery with a named target.)
- [ ] **[intake] FILE 2 (F001–F100) absorb-verify next drain** — per DOWNLOADS-INTAKE-QUEUE drain order, FILE 2 (`projectsites-ai-shipping-claude-code-prompt.md`, status `queued`, 'Absorbed: LARGELY') is the next §0.5 intake-verify target: confirm F001–F035 required features + daily-publishing pipeline + analytics-work-discovery are in AWOS WALKTHROUGH/gp-register with NO duplication, then flip its row to `absorbed` + note the archive-copy removal. Append any genuinely-missing F-items to BACKLOG; do NOT re-import dupes. Category: discovery · S.
- [ ] **[billing] periodLabel() past-date guard (DUX fire-80 P2)** — `billing.component.ts:~2098 periodLabel()` shows "Renews {date}" for an `active` sub with NO past-date guard; DUX (role-17) saw a live "Renews 2026-08-24" (~5 weeks past, today 2026-10-02). Repro: Billing›Subscription where `current_period_end` < now. Vision can't catch it (no "today" ref) — DOM+date reconcile did. Fix: past-date → "Renewal overdue"/staleness cue, or surface the lagging period-advance webhook. Seed-org today (low real-customer severity) but misleads any customer whose renewal webhook lags. Add a Jasmine unit (past `current_period_end` → overdue). Category: product · S.
- [ ] **[testing] Wire the analytics classifier into the LIVE prod probe** — `_analytics-reconcile-classifier.mjs` (16 tests GREEN, fire-80 `56d57e061`) is a PURE module; the agent-1 cut-off remainder is to call it from `reconcile-surfaces.mjs`: supply the real ground-truth COUNT + newest-`visitor_events`-ts via `wrangler d1 execute project-sites-db-production --remote` + the authed admin Analytics display, replace the `mode:'populated'` analytics row with the classifier's LYING-EMPTY/WRONG-SOURCE/STALE verdict, run against a real site. Acceptance: flags divergence/stale on fixture + reconciles OK on a live quiet account. Category: testing · S.


## fire-81 replenish (verified, deduplicated)

- [ ] **[security] SSRF schema-refine hardening** — the shared `createIntegrationSchema`/`updateIntegrationSchema` `webhook_url` (`packages/shared/src/schemas/forms.ts:82,98`) is `z.string().url()` only; the egress guard (fire-81) is authoritative but a schema-level reject is better UX. Needs a PURE SSRF-host helper in `packages/shared` (worker's `isSafeWebhookUrl` can't be imported by shared — dependency direction). ACCEPT: shared helper + `.refine` + unit test; no cross-package import. decision-independent y · surface shared schema.
- [ ] **[docs] Phantom BACKLOG file-refs (RE-QUEUE — fire-81 content-writer worktree LOST its work)** — 4 refs cite absent files: `docs/COMPONENTS.md` (AUTHOR a real component catalog from the code), `apps/project-sites/src/services/rag.ts` + `src/lib/error_pages.ts` + `e2e/gen-site/post-publish-console.spec.ts` (RE-SCOPE the backlog lines as not-yet-built capability gaps — do NOT stub). decision-independent y · surface docs.
- [ ] **[arch] serviceAddOnSchema dupe** — `src/prompts/schemas.ts:98` redeclares the same shape as `packages/shared/src/schemas/seed-v3.ts:137`; prompts/schemas imports nothing from shared (2 competing seed-vocab generations). FIX: import canonical from `@project-sites/shared`, delete the local redecl. ACCEPT: tsc 0 · jest green · one definition · prompt parse unchanged. decision-independent y · surface worker. (Larger prompts↔shared reconciliation — 15 redefs vs seed-v3's 20 — is a multi-fire arc, not this item.)
- [ ] **[testing] Lock: legacy feature_flags table is NOT read at resolution** — regression test asserting `resolveFlag` ignores the `feature_flags` governance table (prevents re-introducing the fire-81 adversarial-caught legacy-fallback HIGH). ACCEPT: a test that seeds a legacy row with divergent rollout and asserts resolution == registry default. decision-independent y · surface worker test.
- [ ] **[loop/infra] Role 16 (Long-Trail) auto-worktreed despite MAIN-checkout contract** — fire-81 the fleet auto-worktree pool put role 16 in a sparse worktree (couldn't boot the local stack) → BLOCKED, 0 real browser actions (checkpoint stayed `last_completed_action:59`). The Agent-tool call did NOT set `isolation:worktree` yet the pool auto-init still worktreed it. FIX: make the standing browser roles pin to the main checkout (pool opt-out signal / explicit cwd guard) so the contract can't be silently overridden. decision-independent y · surface loop harness. Cross: `fleet-auto-worktree-blocks-standing-browser-roles`.
- [ ] **[testing P1 STANDING] Long-Trail case-001 phase F — RESUME** (re-queued; fire-81 blocked by auto-worktree). Lease FREE (checkpoint `phase_f_ready`, `last_completed_action:59`). Run in MAIN checkout, `test-writer`/`general-purpose`. CF token present via get-secret.
- [ ] **[discovery/§0.5 FILE-3] Swarm-delegation axis** (decomposed from `ProjectSites_Claude_Code_Master_Prompt_v2.md`, absorbed fire-81). NET-NEW epic — Claude permanent orchestrator + DeepSeek-first delegated inference + MiniMax/OpenAI specialists + Exa discovery + Deepcrawl ingestion + provider-agnostic MCP broker. STARTER SLICE (highest-leverage, decision-independent): **provider entitlement + billing-pool registry** — D1 table of credentials × tier × remaining-quota × entitlements (Anthropic coded separately from BYOK/Unified/API) + a CLI schema validator; foundation for all routing. Then (deduped): `/delegate` request/result-schema skill+MCP+DO-scheduler · DeepSeek fast/strong/escalation aliases via CF routing · three-env task ledger with durable leases · delegation telemetry (cost-per-accepted-outcome) · compact evidence bundles (task-scoped context packs) · live non-billable provider-health probes · media funding governance (existing-benefits-first, MiniMax-video budget protect). (dup-of existing, enforce only: Exa skill wiring · e2e-per-feature manifest · worktree cleanup contract.)

## fire-82 replenish (verified, deduplicated)

- [ ] **[HIGH, evidence] WfP-backfill: lonemountainglobal serves from R2 not WfP** — `verify-wfp-serving.mjs` proves `lonemountainglobal.projectsites.dev → x-ps-serve: r2` (no live WfP prod slot); canonical #2 says WfP is the default serving path. ACCEPT: provision a WfP prod slot (+ sweep other pre-WfP sites) → the header flips to `wfp`; `node apps/project-sites/scripts/verify-wfp-serving.mjs --strict` exits 0. decision-independent y · surface worker/serving. (Pairs with §848 internal cross-org WfP-backfill endpoint.)
- [ ] **[MED, investigate] Vision gateway falls to Workers-AI despite OpenAI+Anthropic keys present** (role-17 fire-82). Likely OpenAI 429 + Anthropic $0 balance. ACCEPT: AI Gateway routes role-17/gen vision to a frontier eye; the run manifest provider ≠ `workers-ai`. Check Anthropic balance / OpenAI quota. decision-independent y (diagnosis) · surface AI Gateway / vision.
- [ ] **[LOW, optional <30min] Apex marketing route could emit `x-ps-serve: marketing`** for full observability — it serves via the worker's own route (not `serveSiteFromR2`), so it's currently header-free; the gate exempts it. decision-independent y · surface worker.
- [ ] **[EPIC, §0.5 FILE-5 intake drained] CF-native voice/MCP/surfaces** — 5 workstreams (A Voice/media · B Twilio/SMS/Stripe · C Editor Claude-Code/Sandbox/browser · D ProjectSites MCP broker · E CF-native surfaces); ~50 slices, 15-17 fires. Parent = PENDING-DIRECTIVES §DIRECTIVE 2 (REALTIME-VOICE-DIRECTIVE, not yet persisted verbatim). NET-NEW. First-fire slice candidate: **A1 Voice-tab UI consolidation** (retain 7 tabs + add Recording/Reviews). Full breakdown: `.claude/run-the-loop/FILE5-VOICE-DECOMPOSITION.md`. DRAIN per `split-work-into-ledger` — never execute wholesale. decision-independent y · surface worker+frontend.

**Ticks (fire-82):**
- ✅ **Published-site WfP/serve observability** — done `c82563d1e`, deployed `fd9128cc` (`--env production`). Every published-site response now stamps `x-ps-serve` (`r2` on all ~8 R2 branches; `wfp` on the WfP branch). (No prior exact frontier line — net-new observability slice.)
- ✅ **Admin Analytics cold-start skeleton >10s** — see §181 `[x]` (fire-60 first paint 2.4s); fire-82 `7e8340a0f` tightened it further (cached-first/progressive paint, `FIRST_PAINT_BOUND_MS` 3000→1200, cold skeleton <1.3s; prod `/admin` serves `main-TH5NO3LG.js`).

## fire-84 replenish (next-wave, deduplicated — money-path first)
- **WS-DP1 / promote-flag-golden-proof** — promote `durable_preview` to beta on the e2e-test-org; prove edit→promote→live end-to-end; promoted artifact digest == frozen Preview revision; reversible via override. (money-path)
- **WS-DP2 / wire-date-detect-into-import** — role-1's `detectColumnType`/`isStrictIsoDate` currently drive only the add-column TYPE; wire autodetect into the seed/import path + a date cell-editor in the app/ editor Data tab. Acceptance: importing ISO-date data auto-types the column `date` + renders a date cell-editor (real browser).
- **WS-WFP-BF / wfp-backfill-prewfp-sites** — lonemountainglobal.projectsites.dev serves `x-ps-serve: r2` (not wfp), contradicting WfP-default; run the WfP prod-slot backfill. Acceptance: `verify-wfp-serving.mjs --strict` exits 0; sampled sites flip r2→wfp. (money-path HIGH, carried)
- **WS-DOC1 / fix-awos-master-prompt-ref** — §AWOS backlog block + the [AWOS] memory cite `./MASTER-PROMPT.md`, which does NOT exist in the repo. Restore it or correct both refs. Unblocks flipping DOWNLOADS FILE 4 → absorbed.
- **WS-F2DRAIN / file2-f-series-crosswalk** — crosswalk F001–F035 to existing WLK/GP/flag ids; append only genuinely-missing; flip DOWNLOADS FILE 2 → absorbed + rm archive.
- **WS-DUX-REGEX / explorer-primary-action-regex** — role-17's settings-depth probe regex misses real primary actions (`Connect with…`, `Add API key`, `+ Invite`, `+ Add variable`), so dialog-open states go unexercised; widen it. (test-probe, NOT a product bug — surfaces verified gorgeous.)
- **WS-LOOP-BROWSER-MAIN / browser-roles-must-land-in-main** — role 16 keeps getting fleet-auto-worktree'd into sparse node_modules (wtBRO), blocking the standing Long-Trail case every fire it recurs. Add a preflight guard / fleet config so roles 16+17 reliably run in the MAIN checkout. (loop-improvement — do FIRST next fire)

## Replenish — fire-85 (2026-10-02)

- [~] D-85-a PARTIALLY DONE (fire-86, SHA 249efb845) — SiteEvent shape consolidated onto the shared schema (`site_event_dispatch` now its first src consumer via `Pick<SiteEvent,'type'>`); detect-orphans gained SERVICE_MODULE class. STILL OPEN: emit a real event + wire `handleSiteEvent` as consumer (see fire-86 replenish `wire-site-event-dispatch`).
- [ ] AWOS-03 Wire SiteEvent emission + unify duplicated shape (retires D-85-a orphan + the AWOS-02 "reconcile, don't duplicate" drift). Emit a `SiteEvent` validated against the shared `packages/shared` `SiteEventSchema` on >=1 real mutation (e.g. `site:published`); wire `handleSiteEvent` (currently ZERO callers) as the consumer; delete the parallel `{type,payload}` shape in `apps/project-sites/src/services/site_event_dispatch.ts`. AC: >=1 event type emitted+persisted + shared-schema validated + zero duplicated shapes + drift-check clean. cadence: next-fire · priority: high · category: architecture/feature · discovered_by: fire-85 A4+A6 · owner: role-1/6
- [ ] WLK-29 Logs "View trace" deep-link -> REAL CF Traces API (currently hardcoded/unverified `?tab=traces&trace=<id>`). AC: clicking "View trace" on a log row opens the matching trace filtered by trace_id against the live Traces endpoint. cadence: next-fire · priority: medium · category: observability · discovered_by: fire-85 A6 · owner: role-10/11
- [ ] gp-09-completion Money-path LONG journey must continue PAST generate -> publish -> load live `{slug}.projectsites.dev` -> FAIL on any console error / asset 404. AC: fresh build -> publish -> CF Browser Run at the live subdomain, zero console errors. cadence: next-fire · priority: high · category: testing/golden-path · discovered_by: fire-85 A6 · owner: role-4/16
- [ ] Long-Trail case-001 Phase F (actions 60-96) RE-QUEUED — BLOCKED fire-85 by browser-role auto-worktree (D-85-b); MUST run in a guaranteed MAIN checkout with bootable node_modules (or apply the node_modules symlink self-heal). cadence: next-fire · priority: high · category: testing · owner: role-16

### fire-86 replenish (next-wave) — 2026-10-02
- [ ] [golden-path/editor-data-tab] RE-QUEUED from fire-86 (agent returned mid-journey, env was fine): LONG journey through editor Data tab — verify the 7 pill buttons are clickable + empty-launchpad actions reachable; TDD RED->fix->GREEN->continue to a created table+row. files: apps/project-sites/e2e + editor Data-tab components. (shippable)
- [ ] [arch/drain-unwired-services] 134 pre-existing unwired src/services/* modules surfaced by detect-orphans SERVICE_MODULE (advisory). Drain-then-promote arc: verify each (knip-unused-not-always-dead), wire or delete with rationale, then promote the gate blocking. (shippable, multi-fire)
- [ ] [standing/role-16-17-resume] Long-Trail case-001 Phase F (actions 60-96: disposable app install/remove->tenant isolation->cleanup) + Deep UI Explorer (Editor Data Platform P1 + billing invoice detail completion) — NOW UNBLOCKED by the fire-86 browser-role-preflight; resume next fire in MAIN checkout. (shippable)
- [ ] [arch/wire-site-event-dispatch] site_event_dispatch.handleSiteEvent still has zero non-test callers — wire it to a real webhook-dispatch path OR allowlist it in detect-orphans with rationale (reviewer rec). (shippable)
- [ ] [feature/pricing-admin-ui] Super-admin pricing_config editor UI (the later slice): table exists + seeded in prod D1, flag pricing_config_v2 default-OFF ready to flip once the edit UI + per-row audit ship. (shippable)

### fire-86 replenish (cont.) — Feature Architecture lockfile-drift (CI-only)
- [ci/lockfile-metadata-drift] FA "Lockfile-drift gate" red on main: CI `pnpm@9.14.4` regen adds a `deprecated:` metadata line near `@xterm/addon-fit@0.10.0` absent from the committed `pnpm-lock.yaml`; `check-lockfile-drift` passes LOCALLY + local `pnpm install --lockfile-only` is a no-op (stale registry cache). Fix: regen in a fresh-registry-metadata env (CI artifact, or local after `pnpm store prune`), confirm diff is metadata-only (no version/specifier changes), commit, re-dispatch the FA gate to confirm green. Known recurring class (silRED). (shippable; needs fresh-metadata env)

## fire-88 replenish (2026-10-02)
Product / money-path (F discovery + D perf):
- [ ] PERF-P1 /pricing LCP 8.9s→~1.3s — make app-shell route-aware (index.html:353-368 emits per-route static hero) OR SSG/prerender `/`+`/pricing`. HIGH-blast-radius; dedicated slice + CLS verify. (D)
- [ ] PERF-P2 homepage TBT/TTI — defer GTM+gtag 465KB (index.html:14-26) behind requestIdleCallback/first-interaction. Analytics-owned; coordinate. (D)
- [ ] LB-2 wire gallery-lightbox.component.ts → homepage (built, unwired; render ≥1 showcase site from real data). (F)
- [ ] MP-AIBUILD unpaid causal assert — e2e/money-path/ai-build-to-live.e2e.ts assert newest published site serves live `<h1>` + x-ps-serve:wfp 200 (no paid cost). (F)
- [ ] AWOS-03 wire handleSiteEvent on site:published (site_event_dispatch.ts zero callers → emit+persist+schema-validate ≥1 SiteEvent). (F)
- [ ] HOME-EMPTY homepage empty-state launchpad (no-showcase → first-action CTA, not blank). (F)
- [ ] CLEANUP drain billing/brand/hero service-export clusters (134 advisory unwired exports — themed batches; verify-then-wire). (F)
- [ ] WLK-33 stable-size search across kbd/empty/error/AI-overview states. (F)
Standing roles re-queue:
- [ ] role-16 Long-Trail Phase F actions 60-96 (apps lifecycle/tenant-isolation/cleanup) — MUST run MAIN checkout, NEVER auto-worktree (wtBRO). Lease reset.
- [ ] role-13 Accessibility axe@6bp generated-site + admin (blocked fire-88 on Playwright-MCP orphan lock; prefer CF Browser Run).
- [ ] role-14 CF Release Scout retry feeds with real Chrome UA / CF Browser Run (WAF-blocked fire-88).
DUX tooling (A):
- [ ] DUX-FIX explorer database-subtree: open "Actions ▾" before asserting AI-Seed; treat opened schema-builder as Create-Table success (kill 2 stale false-neg blocks).
- [ ] DUX-VISION-TUNE suppress boilerplate a11y_perf P0s (observed="no issues") so p0/p1 stays honest.

## fire-89 intake backlog (from ~/Downloads v7 + homepage/domains/SEO eval)

> Decomposed fire-89 from `projectsites-chatgpt-final-prompt-compiler-v7.md` +
> `projectsites-claude-code-homepage-domains-seo-evaluation-prompt.md`. Deduped against existing
> items (dropped: Flagship flags, three-bucket/30MB storage, AWOS-12 daily-content, LB-2/HOME-EMPTY
> homepage). Wisdom folded to ECOSYSTEM-CONTEXT § fire-89 + OPERATING-PRINCIPLES (open question +
> loop discipline). One line each, acceptance included.

- [ ] **[product/money-path] HOME-MONEY homepage + launch-sequence completion** — close every gap/dead-end in homepage→(preview)publish→live money path (extends LB-2/HOME-EMPTY; this is the COMPLETION slice, not the gallery/empty-state). AC: a fresh visitor reaches a working published preview from the homepage with zero dead controls; CF Browser Run proves the full sequence, 0 console errors. decision-independent y · surface worker+frontend.
- [ ] **[architecture/intake] EDGE-PREP edge-intake Workers-AI→OpenAI prep gate** — new assignments run Workers-AI enrichment → OpenAI research/prep → constraints validation → Claude orchestration, original request kept IMMUTABLE. AC: an intake produces a prepared-brief artifact distinct from (and non-destructive to) the stored original; Zod-validated prep envelope. decision-independent y · surface intake pipeline.
- [ ] **[testing/evals] ROUTE-EVAL Langfuse/Promptfoo route-eval harness** — measure route quality as raw-vs-prepared OUTCOME delta (NOT prompt verbosity / fabricated pass counts). AC: a Promptfoo A/B case + Langfuse-scored run comparing raw-request vs prepared-request on ≥1 real assignment, reported as a measured delta. decision-independent y · surface evals.
- [ ] **[product/content] DAILY-BLOG-RULE narrow daily marketing-blog publish rule** — isolate the daily-blog content-publish path so it NEVER auto-deploys application/code changes (complements AWOS-12). AC: a content publish runs with zero app/worker deploy triggered; a regression asserting the content path and the app-deploy path are disjoint. decision-independent y · surface content pipeline.
- [ ] **[product/UX] DOMAIN-URL-LIFECYCLE URL/domain lifecycle UX + business-name keyword→landing-page research** — gorgeous attach/verify/promote domain lifecycle + research mapping a business-name keyword to a landing-page intent (feeds claimyour.site resolution). AC: owner attaches+verifies a domain in ≤3 steps (real browser), and a business-name keyword resolves to a proposed landing-page plan. decision-independent y · surface worker+frontend.
- [ ] **[testing/infra] CAP-DOCTOR capability-doctor multi-provider fixture harness** — probe every provider/integration against fixtures, reporting PASS/PARTIAL/FAIL/BLOCKED honestly (NEVER mock-pass a missing credential). AC: the doctor runs a fixture suite across providers and emits per-provider PASS/PARTIAL/FAIL/BLOCKED with the exact missing prerequisite on non-PASS; a missing key reports BLOCKED, never PASS. decision-independent y · surface infra/providers.
- [ ] **[process/release] PROD-DEPLOY-GATE prod-deploy authorization gate** — BLOCKED-pending the open question (prod-off-by-default vs canonical #3); do NOT build until Brian reconciles. AC (once unblocked): CI/hook audit proving a `main` push cannot auto-promote the gated surface + an explicit single-release grant path. decision-independent n (Brian-gated) · surface CI/release. Cross: OPERATING-PRINCIPLES § Open question.
- [ ] **[product/observability] REFINE-VISIBILITY refinement-pass visibility** — surface refinement/improvement passes with REAL evidence counts (what changed, measured), never a fabricated "N-pass reasoning" tally. AC: a refinement surface shows per-pass evidence (diff/metric/eval) with counts sourced from actual runs; no hardcoded pass numbers. decision-independent y · surface frontend+loop.

## fire-90 intake backlog (from ~/Downloads 40-integrations-30-pass + ai-browser-headless-addendum)

> Decomposed fire-90 from `projectsites-40-integrations-30-pass-prompt.md` +
> `projectsites-ai-browser-headless-claude-addendum.md`. Deduped HARD against prior fires (NOT re-added:
> DeepSeek-first routing + MiniMax adapter [fire-81 swarm epic + items 20-21], Langfuse/Promptfoo
> route-eval [fire-89 ROUTE-EVAL], daily-blog-separate [fire-89 DAILY-BLOG-RULE], Flagship flags,
> large-media/30MB [FILE 6 Cycles], evidence-prep [fire-89 EDGE-PREP], 95% dev-SLA + prod-off-by-default
> open question [fire-89], Browser Profile Vault slice 1 [BACKLOG:188 + BROWSER-OPERATING-LAYER slice 1],
> Exa skill wiring [fire-81 dup-of]). One line each, acceptance included.

### Integration ledger (40-integrations-30-pass)
- [ ] **[infra/integrations] INT-REGISTRY typed capability registry + doctor/bootstrap/refresh** — one typed registry of every integration's capabilities + a `doctor`/`bootstrap`/`refresh` lifecycle, per-vendor failure containment (one vendor down never cascades) + independent health per vendor. AC: registry is Zod-typed; `doctor` emits per-vendor PASS/PARTIAL/FAIL/BLOCKED (extends CAP-DOCTOR); a forced single-vendor outage leaves all others green. decision-independent y · surface infra. (Note: extends fire-89 CAP-DOCTOR — this is the REGISTRY + lifecycle layer, not the probe.)
- [ ] **[observability/ai] INT-LANGFUSE end-to-end AI-lineage instrumentation** — instrument the full AI path (intake→prep→route→generate→verify) as Langfuse traces/spans reusing the EXISTING Langfuse project (no new project). AC: one real assignment appears as a single linked Langfuse trace spanning every AI step with model+cost+latency. decision-independent y · surface observability. (reuse project per neon-conservation ethos; complements fire-89 ROUTE-EVAL scoring.)
- [ ] **[testing/evals] INT-PROMPTFOO eval suite (functional+adversarial+engineer-skill)** — a Promptfoo suite covering functional correctness + adversarial/prompt-injection + engineer-skill cases, reusing existing creds. AC: `promptfoo eval` runs all three case classes green in CI with a regression baseline. decision-independent y · surface evals. (extends fire-89 ROUTE-EVAL A/B harness into a full suite.)
- [ ] **[observability/incident] INT-SENTRY-MCP incident→trace→fix→release loop** — wire Sentry MCP so an incident resolves to its trace → proposed fix → release marker, closing the loop. AC: a seeded Sentry issue drives a trace lookup + a release-tagged fix via the MCP, proven end-to-end. decision-independent y · surface observability. (reuses incident-responder agent + Sentry MCP.)
- [ ] **[observability/product] INT-POSTHOG outcome funnels + replay + resilient flags + guarded experiments** — PostHog outcome funnels + consented session-replay + resilient flag reads (fail-open to default) + guardrailed experiments (auto-stop on guardrail breach). AC: a funnel + a consent-gated replay + a flag that survives a PostHog outage + an experiment with a wired guardrail all live. decision-independent y · surface observability.
- [ ] **[observability/consent] INT-GA4-GTM GA4+GTM + Google Consent Mode v2** — GA4+GTM with Consent Mode v2, NO pre-consent buffering, owned-site OPT-IN only. AC: zero analytics requests fire before consent; owned sites default analytics OFF until opt-in; Consent Mode v2 signals present. decision-independent y · surface integrations. (pairs with cloudflare-native-provisioning PostHog-cloud model.)
- [ ] **[ai/delegation] INT-DELEGATED-WORKERS DeepSeek+MiniMax as ACTIVE delegated workers** — activate DeepSeek+MiniMax as live delegated inference workers with scoped tool schemas + per-provider quotas, Anthropic orchestration UNCHANGED. AC: ≥1 real sub-task runs on DeepSeek AND ≥1 on MiniMax via scoped tool schemas under enforced quota; Claude remains orchestrator. decision-independent y · surface ai. (ACTIVATION of fire-81 swarm items 20-21 + registry — not a re-spec.)
- [ ] **[infra/deploy] INT-WFP-SERVING CF-native WfP serving preview+prod** — serve every integration-touched surface CF-native via Workers-for-Platforms (preview AND prod). AC: a changed surface serves with `x-ps-serve:wfp` on both preview + prod hosts. decision-independent y · surface infra. (dedup: born-on-WfP is doctrine [bornW]; this is the integrations-arc acceptance tie-in.)
- [ ] **[design/system] INT-DESIGN-TOKENS cinematic design-system tokens + a11y + streaming + undo** — ship cinematic design-system tokens meeting WCAG 2.2 AA, with streaming AI-progress affordances + undo-on-mutation across integration surfaces. AC: integration UIs consume the shared tokens, pass axe@6bp, show streaming progress on AI calls, and every mutation is undoable. decision-independent y · surface frontend. (pairs with nebula-waiting + embarrassingly-easy + real-time-no-refresh rules.)
- [ ] **[process/docs] INT-DOCS-CI continuous docs/ADRs/skill-regression CI gate** — a CI gate keeping docs/ADRs current + guarding against skill-regression as integrations land. AC: a changed integration surface with stale docs/ADR or a dropped skill fails CI. decision-independent y · surface CI. (extends drift-detection + documentation-as-code gates.)

### Browser infra (ai-browser-headless-addendum)
- [ ] **[browser/vault] BRW-PROFILE-DATAPLANE Profile Vault data plane** — D1 `browser_profiles` + R2 encrypted state via EXISTING `ai_crypto.ts` + `assertProfileOwned` IDOR gate, flag-dark. AC: CRUD + freeze/restore/verify/revoke with org-scoped R2 keys + `assertProfileOwned` CI-gated + GCM blob round-trips. decision-independent y · surface worker. (This is BROWSER-OPERATING-LAYER slice 1 / BACKLOG:188 — kept as the fire-90 acceptance anchor; do NOT double-build.)
- [ ] **[browser/overlay] BRW-INTERACTIVE-OVERLAY interactive browser overlay + viewer gateway (SERVER-SIDE lease)** — a watch/take-control/resume overlay + viewer gateway whose mutual-exclusion is enforced by a SERVER-SIDE lease (never UI-only), AI-vs-human mutually exclusive. AC: a human take-control blocks the AI at the SERVER until released; UI reflects lease state; via Browserbase `live_view` where a human must watch. decision-independent y · surface worker+frontend. (NEW vs BROWSER-OPERATING-LAYER slice 3 which lacked the server-lease.)
- [ ] **[browser/leads] BRW-DEEPSEEK-LEADS DeepSeek lead-extraction pipeline** — evidence→Exa fetch→DeepSeek parse, provenance `source_url`+timestamp on every field, NO hallucinated fields, reuse business-entity adapters. AC: an extraction returns only fields with a cited source_url+timestamp; a field absent from evidence is omitted, never invented; reuses existing business-entity adapters. decision-independent y · surface worker. (grounds fire-81 Exa discovery into a typed extraction with provenance.)
- [ ] **[browser/runner] BRW-HEADLESS-BOOTSTRAP headless-runner bootstrap** — isolated non-root runner + `defaultMode:bypassPermissions` MERGE (not replace) + a GENERATED MCP manifest; ask-prompts still BLOCK. AC: runner boots non-root in isolation, merges bypass mode without clobbering existing perms, generates its MCP manifest, and a permission ASK still halts execution. decision-independent y · surface infra.
- [ ] **[browser/exa] BRW-EXA-MCP Exa MCP in shared registry + $100 budget broker** — register Exa MCP in the shared MCP registry behind a $100 budget broker, server-side key, NO key in logs. AC: Exa calls route through the broker, stop at the $100 ceiling, key resolved server-side via get-secret, names-only in logs. decision-independent y · surface infra. (registry wiring per fire-81 dup-of; this adds the budget broker + key discipline.)
- [ ] **[browser/observability] BRW-RUN-MANIFEST run-manifest + admin Browser panel** — per-run manifest (provider/autonomy/steps/timings) + an admin Browser panel showing it with a screenshot timeline to R2 `browser-runs/{orgId}/{runId}/`. AC: a run writes its manifest + per-state screenshots to the org-prefixed R2 path and the admin panel replays the timeline (live-updating, no refresh button). decision-independent y · surface worker+frontend. (This is BROWSER-OPERATING-LAYER slice 2 — fire-90 acceptance anchor.)

## fire-97 intake backlog (CF catalog-audit + realtime-master prompts; mostly dedup vs AWOS/WLK — these are the NEW items)
- [ ] CF-GATES-ORCH — 20-acceptance-gates orchestrator: per-fire checklist scoring gates 1-7 (Playwright interactive surfaces) · 8-16 (build/deploy + ledger/manifest evidence) · 17-20 (prod-E2E live reconcile); emit a gates-checklist row per gate with observed evidence. ACCEPTANCE: a fire produces the scored checklist. cadence every-2-fires · priority high · category testing · discovered_by fire-97-intake
- [ ] ASK-SDK — Durable Ask single producer SDK: one typed `WorkspaceEvent` (id/type/ts/org/site/env/actor/source/correlation/causation/schemaVersion/privacy) across all agents; Queues delivery + retry + DLQ; no raw-posting. ACCEPTANCE: emissions use the SDK only; replays missed events on reconnect. cadence every-2-fires · priority med · category architecture · discovered_by fire-97-intake
- [ ] SITE-CAP-MANIFEST — per-site capability manifest: D1 CapabilityRecord (status ready/disabled/not_configured/not_entitled/degraded/budget_exhausted + credentialRef + billingPoolId + fallbackIds) + on-demand provisioner (start zero, provision on feature-enable, zero auto-bill). ACCEPTANCE: honest status per capability; disabled degrades, never crashes. cadence every-2-fires · priority med · category architecture
- [ ] X402-MPP-GATE — Monetization-Gateway compliance: it is CLOSED-BETA US-only x402, NOT MPP; pre-dispatch eligibility check (account flag + geography + beta access); default = existing subscription path. ACCEPTANCE: code never auto-assumes MG; fallback is default. cadence next-eligible · priority med · category compliance · discovered_by fire-97-intake
- [ ] NO-COALESCE-POOLS — realtime pool-separation invariant: media (RealtimeKit/SFU/TURN) · state (DO presence/leases) · browser (Browser Run profile) · jobs (Workflows/Queues) are SEPARATE pools — never assume shared IDs/creds; SFU adapter is unidirectional, 1fps JPEG, no video-ingest (not bidi). ACCEPTANCE: an ADR + a drift check; no one-DO-for-all-state. cadence when-realtime-built · priority med · category architecture · discovered_by fire-97-intake

## Continuity & Beauty Directive — intake epic (fire-99; 12-Act master prompt decomposed; EXTEND existing stores, NEVER a competing registry/scheduler)
Spirit: recover forgotten promises · check reality vs intention · consolidate docs into a rebuildable blueprint · make the product progressively more beautiful — all via the EXISTING loop (no competing cron/ledger/registry). The "requirement registry" = the existing BACKLOG (requirement→acceptance→disposition) + gp-register (verification contract) + LEDGER (evidence+SHA) chain; strengthen it, don't duplicate (see OPERATING-PRINCIPLES § Requirement registry).
- [ ] CBD-1 Requirement Recall Auditor — recurring role+skill "what did we promise that isn't delivered?": reconcile accessible specs/memories/MASTER-PROMPT/intake vs BACKLOG; emit DEDUPED ledger items (source·gap·impact·surfaces·acceptance·verification); watch "also/automatically/by default/everywhere/reusable/across". ACCEPTANCE: a fire runs it + files ≥1 traced gap once (no dup). cadence daily-due · priority high · category discovery · discovered_by CBD
- [ ] CBD-2 Implementation Conformance Inspector — recurring role "does reality fulfill the promise?": static-discover + real-exercise routes/handlers/flags; find dead buttons·nonpersistent settings·disconnected APIs·unreachable screens·demo-data·config-only integrations; verify empty/loading/error/success/denied states; reconcile display-vs-store. ACCEPTANCE: a rotating weekly sweep marks blocked honestly + files confirmed gaps. cadence weekly-due · priority high · category architecture
- [ ] CBD-3 Documentation Editor-in-Chief — recurring skill: consolidate docs to the minimum authoritative set (Start-here · Product-spec · Experience/design · Architecture/contracts · Build/ops · Decisions/current-work); compress repetition NOT meaning; preserve every requirement/invariant/decision; fix links. ACCEPTANCE: a consolidation preserves all unique reqs + updates inbound links. cadence weekly/drift · priority med · category docs · discovered_by CBD
- [ ] CBD-4 Documentation Reconstruction Auditor — bounded: give an isolated agent ONLY docs+fixtures (NOT app source), rebuild a representative vertical slice in a sandbox, diff vs acceptance; every undocumented assumption/missing contract/asset → ledger + repair docs. ACCEPTANCE: one slice reconstructed; gaps filed; scope reported honestly (sample ≠ whole). cadence milestone/weekly · priority med · category docs/testing
- [ ] CBD-5 Visual Evolution Director — recurring: 60/25/15 selection (impact-weighted · neglected · random-seeded), evidence-gated (baseline→change→render→critique→verify→keep-or-revert); improve hierarchy/type/spacing/states/motion; prefer shared primitives; a justified no-change is success; beauty accumulates (record patterns, no oscillation). ACCEPTANCE: a rendered before/after with a hypothesis + regression check, or a justified no-change. cadence every-fire-eligible · priority med · category UX
- [ ] CBD-6 Independent Witness + registry-chain strengthening — material changes get an independent Browser-Run verifier (real screenshots · 6bp · a11y · golden path); strengthen the source→requirement→experience→impl→verification→disposition chain ON the existing stores (8-disposition vocab); invalidate stale evidence on relevant change. ACCEPTANCE: a material change this fire carries independent evidence. cadence per-material-change · priority high · category testing/architecture
