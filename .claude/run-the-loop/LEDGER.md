# LEDGER — compact chronological record

> Compressed cycle log for `/run-the-loop`, most recent first. Each fire ≤5 bullets — shipped
> behavior/fix + closing SHA + prod proof. Cross-links: [`./README.md`](./README.md) ·
> [`./BACKLOG.md`](./BACKLOG.md) · [`./DISCOVERIES.md`](./DISCOVERIES.md).
>
> **Older detail lives in git history + the per-workstream sub-ledgers** (`_LOOP.md` ⟐ Cycle log,
> `_LOOP_LEDGER.md` (2.3MB — never main-thread-read), `_PROMOTE_WORKFLOW_CHECKPOINT.md`,
> `_CF_NATIVE_CONVERGENCE.md`, `_ADMIN_VQA_LEDGER.md`, `_INTERCONNECTEDNESS_LEDGER.md`). This is the
> INDEX, not a duplicate.

## fire-71 — Feature Delivery: WebGL consumption gap (interconnectedness P0)

- **Closed the fire-70-CONFIRMED built-but-unwired WebGL defect**: `templates/webgl/WebGLHero.tsx` + `webgl-hero-core.mjs` + per-vertical `webgl` blocks EXISTED but NO generated site emitted them (`grep WebGLHero apps/project-sites/src` = 0). Now wired end-to-end.
- **Pipeline EMIT** (`workflows/site-generation.ts` `buildPrompt`) — resolves a THEMED `webglHeroConfigFor(category)` per build + a MANDATORY prompt step: copy `templates/webgl/` in, mount `<WebGLHero vertical webgl={cfg} paletteCssVars=…/>` as the hero section's FIRST child, static-fallback-safe (aria-hidden, deferred GL, `prefers-reduced-motion`→gradient, never LCP), headline+CTA render early.
- **Build ASSERT** — new `validateWebglHeroPresent` in `services/build_validators.ts` (code `webgl.hero_missing`, opt `hasWebglPack` threaded through `validateBuild`, set `true` in the workflow since every build resolves a config) fails any build whose bundle/HTML never mounts the hero.
- **Worker-side SSOT** — `WEBGL_HERO_PRESETS` + `webglVerticalFor`/`webglHeroConfigFor` added to `services/theme_style.ts` (faithful mirror of `templates/webgl/presets.mjs`; tsconfig scopes compilation to `src/**`+`libs/**`, so `templates/*.mjs` can't be imported — same deliberate-mirror pattern as `PACK_DEFAULT_HEROES`).
- **TDD RED→GREEN** — wrote 5 `validateWebglHeroPresent` + 4 resolver + 1 `validateBuild`-aggregate tests FIRST (RED: `validateWebglHeroPresent is not a function`), implemented → GREEN. Full worker suite **898 suites / 14155 tests pass**, `tsc --noEmit` **0 errors**, eslint 0 errors (new region lint-clean). Gates best-effort in sparse worktree (borrowed main `node_modules` via a scratch symlink, removed before commit).
- **Deferred (next fire):** flow the EXACT per-site vertical.json `webgl` overrides (not just the category-derived preset) into `buildPrompt`; a live regen + real-browser canvas-mount proof on gp-09 (no deploy this fire — pure pipeline/validator slice).

---

## fire-70-convergence (2026-10-01)
- Wired orphaned `/admin/sites` list into Workspace nav (Deep UI Explorer money-funnel finding; interconnectedness) + globe icon + lockstep spec — SHA 9f5909eb4; frontend R2 deploy (300/300, CDN purged).
- WLK-05 editor SQL a11y hardening: SqlEditor `id` for label assoc + computed-contrast regression (AA 7.88:1) — SHA 9f5909eb4; editor Pages deploy 99b0d476.bolt-diy-8jf.pages.dev.
- Fixed pre-existing RED fire-69 usage-gauges upgrade-CTA test (provideRouter so static routerLink resolves href) — Karma 2443 SUCCESS / 0 FAILED.
- Dead-toggle gate wired into `check` aggregate (SHA 6d9df3ed4, detector from fire-63) — `check:dead-toggle` GREEN (188 files, 0 dead). Deep UI Explorer money-funnel pass (SHA f670b80b7, CF Browser Run CLOUD_PASS, 12 states, 0 p0/p1).
- Adversarial review CAUGHT a fan-out error: scout's `src/`-only search wrongly called the real WebGL built-but-unwired P0 a "phantom" → corrected (see BACKLOG + OPERATING-PRINCIPLES + monitor #14). Budget: ~2.1M subagent tokens.

### 2026-10-01 · fire-63 — destructive-opt-in silent-downgrade fix (correctness slice)
- **Frontier-0 closed:** `DELETE /api/sites/:id` `purge_resources` opt-in no longer silently downgrades on a lost/garbled body. Was `const body = await c.req.json().catch(() => ({}))` → a malformed/non-object body became `{}` → `purge_resources` undefined → irreversible teardown SKIPPED while the delete still 200'd. Now `.catch(() => null)` + null/non-object/array guard → `throw badRequest('Request body must be a JSON object')` (400, `BAD_REQUEST` envelope). Mirrors the PATCH `/api/sites/:id` fix; the valid empty-`{}` no-op stays 200.
- **Asserable effect:** a successful purge now echoes `{ purged: <number> }` (R2 version objects + dedicated D1 + KV + buckets torn down) so a caller can assert the destructive action actually ran, not just that it 200'd.
- **IDOR:** `requireOwnedSite` (`AND org_id = ?`) already guards the handler — no change needed.
- **TDD RED→GREEN:** +4 regression tests in `src/__tests__/site_delete_subscription.test.ts` (malformed→400, non-object→400, purge echoes numeric `purged`, empty-`{}` no-op preserved). RED observed (malformed→200, purged=undefined) → GREEN 12/12; sibling blast-radius (site_purge · patch_site_malformed_body · api_malformed_json_authed_boundary · site_ownership) 45/45. `tsc --noEmit` exit 0.

### 2026-09-29 · fire-52 — money-path notify + golden-path WCAG + failure-taxonomy loop-improvement
- **§7 loop-improvement (the fire-51→52 re-prompt gradient):** failure-taxonomy shipped (`2f28f3dd3` + skills-rules `05982ffd5`) — a WORKER agent failing (ECONNRESET / one-agent `subagent_tokens:0` / cut-off) is fan-out ATTRITION → salvage its commit (`git show <tip>` before `git branch -D`) + re-queue + KEEP RUNNING; only the LEAD failing ("prompt too long"/autocompact/can't-spawn) is the checkpoint trigger. monitor-orchestration shortcoming #13.
- **Money-path (§3): owner build.complete/build.failed bell now actually FIRES** (`0915cfeb6`). Root cause: the workflow passed the legacy novu-era `{event,tenantId,…}` shape → failed `PsnotifyEventSchema` → `invalid_event` → the DO write silently never fired (a prior fire made it observable but never fixed the callers). Rewrote all build.* notifies to canonical `{name,subscriberId,payload}` + threaded `action_url` (live site URL) through `notify.ts` (bell rows were un-clickable). tsc 0, jest 53✓.
- **Golden-path (§6): 36-action money-path journey** found + fixed a `/create` WCAG 3.3.1 gap (required-field error didn't fire on focus→blur-empty, the common keyboard/AT pattern — fire-51 only caught type→clear) (`54974f118`, RED→GREEN 17/17, deployed R2 + **prod-verified live**, durable `e2e/create-blur-required.e2e.ts`). QUEUED 6 generated-site/serving defects (below).
- **error_handler extraction FAILED 2× (agent cut off mid-run, 0 commit, still 331 LOC)** — re-queued; needs a smaller-scoped brief next fire.
- **Discovery (editor Data/Functions/Resources):** 4 new tasks (BucketsPanel + EnvAssignmentGrid manual Refresh, LockManager unconditional 5s poll, NamespaceSummary Reconcile→auto-sync); Functions convergence verified COMPLETE (do not re-audit for phantom gaps).

### 2026-09-29 · fire-51 — first fire under the upgraded loop (BACKLOG frontier + 15 roles)
- **3 slices landed + verified:** domains-a11y — `domain-manager` popover `aria-modal` + focus-trap (reused `FocusTrapDirective`) + refresh-button `min-w-[11ch]` (`71dcf4a8b`, frontend R2, Karma 2369✓); WfP-slot backfill script `scripts/backfill-wfp-slots.mjs` (`5676c8329`, proven on `search-verify` both slots `ok:true`; 2 published sites total; cross-org sweep needs an internal super-admin endpoint — queued); lockfile-drift CI gate `scripts/check-lockfile-drift.mjs` + `feature-architecture.yml` step (`cfc581dd7`, non-mutating copy→regen→restore, fail-open) — the §7 loop-improvement, kills the recurring `ERR_PNPM_OUTDATED_LOCKFILE` silent-red-deploy class.
- **⭐ Golden-path (§6) found + fixed a REAL money-path defect:** `/create` gated required-field errors on submit-only → a keyboard/AT user who cleared a field hit a catch-22 (button disabled, no inline feedback, the click that sets `attempted` never fires). Fix: error-on-blur + clear-on-type + `aria-invalid` (WCAG 3.3.1). TDD (4 new spec cases). The agent died on ECONNRESET before pushing; the complete verified commit was SALVAGED via cherry-pick (`8b83e2434`, tsc 0), frontend R2.
- **2 agents failed (queued, not re-fanned):** error_handler.ts extraction (Agent 2 output cut off mid-run — 0 commit, still 331 LOC → fire-52); golden-path journey CONTINUATION beyond the create fix (Agent 5 ECONNRESET → fire-52).
- **Discovery rotated to the money-path CREATE/BUILD/editor arc** → ~10 new ground-truthed next-wave tasks folded into `BACKLOG.md` (owner-notify on build-complete/fail · homepage build-error state + retry · ProjectHub deploy unwired standalone · invite-expired error · promote DNS-wait guard · build-progress SSE · search no-results empty state · snapshot-restore unsaved guard · promote synced affordance).
- **Checkpoint:** `subagent_tokens:0` (Agent 5 ECONNRESET) observed + 3 heavy waves this session → per the loop's context-budget HARD-STOP, fire-52 runs in a FRESH session; BACKLOG replenished + ready.

### 2026-09-29 · fire-50 — ⭐ WfP arc CLOSED on prod + 4 slices + F-flag + full standing roster
- ⭐ **WfP site-hosting acceptance MET (Lane 2) — `x-ps-serve: wfp` PROVEN on prod.** Deployed the WfP
  production slot (`POST /api/diag/wfp-deploy`, site `search-verify`, `ok:true, assetCount:1`), enabled
  `site_wfp_hosting` scoped to `e2e-test-org` (reversible `flag_overrides` row), 60s cache expiry →
  `search-verify.projectsites.dev` flipped `x-ps-edge: hit` (R2) → `x-ps-serve: wfp`. Closes the
  ~6-fire lockfile→10405→10304→serving stack. Serve gate `site_serving.ts:97`.
- 6-agent standing roster, all disjoint, all on `main`: F-flag `voice_receptionist` + ADR-0056
  (`15dbff616`) · editor persistence resilience (`5ea5dc0bc`, Editor Pages `ab144625`) · advanced_features
  7× lie-empty→observable (`06e430aa9`) · admin input/a11y polish (`e099b3623`, frontend R2 `main-SSJSMJLQ.js`).
- Discovery rotated to generated-site PUBLIC RUNTIME → 5 new ground-truthed next-wave tasks (wordmark
  fallback · soft-404 gate order · serve-time JSON-LD audit · partial-build empty-state · favicon link
  order) + 2 design recs. Browser/test golden journey GREEN (homepage/search/2 live sites/404 all pass).
- **Migration: this fire also created `.claude/run-the-loop/{BACKLOG,DISCOVERIES,LEDGER}.md}` — the
  canonical loop home — from `_RUN_THE_LOOP.md` + `_LOOP.md`. Live queue now lives here.**

### 2026-09-28 · CF-NATIVE CONVERGENCE RUN scaffolded + fire-1 audit wave
- Scaffolded the entire CF-native mandate into the SINGLE loop (job `5b233086` `/run-the-loop` every 15m,
  confirmed live). New sub-ledger `_CF_NATIVE_CONVERGENCE.md` + immutable spec `docs/_cf-convergence/MANDATE.md`
  + 6 audit files. NO second cron — this run is lanes 12-18 of the one loop.
- Fire-1 = 6 parallel read-only `architect` audits → the feature+migration matrix. DANGER: B0 orphan-number
  no-payment Twilio purchase, no killswitch (`voice.ts:193-261`, live money-loss) → TOP slice.
- C: `@cloudflare/sandbox`+`@cloudflare/agents` ABSENT, orphaned `ide_sandbox.ts` + dead migration 0504.
  D: org-wide 90-day MCP token + orphaned `mcp_resource_tokens`. E: Inspector removal = 26 files/~4600 LOC.
- F: next migration 0648, next ADR 0056, `voice_receptionist` flag missing from registry.

### 2026-09-28 · Editor panels — comprehensive no-white + gorgeous (Brian re-prompted ≥3×)
- Root-caused the recurring "panels still show white" — 3 sources grep can't see: the CodeMirror `--cm-*`
  layer, native form chrome (`color-scheme` unset), `bolt-elements-*/opacity` utilities dropping alpha.
- 3 disjoint agents: dark token override + native-element styling (`9f5ec7fb0`); Data cluster no-white
  (`1cce2f66b`); Resources+Code cluster (`d8851e3bc`). Verified via pixel-faithful harness on compiled CSS.
- ⚠ Campaign NOT complete — KvBrowser + SchemaBuilder still need `color-scheme:dark`; more gorgeous rounds
  continue. `editor.projectsites.dev` 403s headless → verify via authed admin iframe.

### 2026-09-28 · Wave D — editor deep-route fix + psnotify DO + Data journey GREEN (first cron fire)
- D1: `/admin/editor/:siteId` deep-links FIXED (were 404ing) — added `editor/:siteId` route +
  `selectSiteById` + coherent not-found. `e18b023af`, frontend R2 deployed.
- D2: psnotify DO inbox SHIPPED (first slice) — `PsNotifyDO` SQLite per-user, `notifyUser` writes to the
  DO (was a stub), authed `GET/POST /api/notifications`, flag `psnotify` dark. Worker `4aa5c078`, `9223970c1`.
- D4: per-site D1 Data journey PROVEN GREEN on prod (2 passed) — `e2e/data-tab-journey.e2e.ts` reconciles
  each op display-vs-store against the site's OWN D1 (not shared). `0c8438e86`.

### 2026-09-28 · Wave C — Promote browser GREEN + Data column-ops + Forms journey GREEN
- Lane 1 Promote — BROWSER journey GREEN on prod (6 passed). Rewrote `e2e/promote-workflow.e2e.ts` to
  drive the real UI (auth → editor iframe → Source Control → promote). Promote proven API + browser.
- Lane 3 Data — column ops (add/rename/drop) SHIPPED → per-site D1 table CRUD COMPLETE. New
  `PS_SITEDB_ADD/RENAME/DROP_COLUMN` bridge. Editor Pages `4a46bcfa`.
- Core loop Forms — journey GREEN on prod (3 passed). Submit → `form_submissions` persists → admin inbox
  shows it. Display-vs-store reconciled. Commits `9bec0b994`/`1d23525b5`/`98345b6eb`.

### 2026-09-28 · Wave B — Data create/drop UI + operator cockpit + Promote PROVEN GREEN
- Lane 1 Promote — MONEY-PATH PROVEN GREEN (API). Caught migration 0646 never applied to prod (the
  Wave-A 403 probe was a FALSE-GREEN — ownership guard fired before the missing-table SQL). Applied 0646
  idempotent; preview-state → `POST /promote` → `outcome:success` → real release → prod serves it.
- Lane 3 Data — create-table + drop-table UI SHIPPED (dark behind `per_site_data`). Editor Pages `5def1d68`.
- Lane 4 Admin — operator cockpit SHIPPED live (`/admin` live KPI tiles + needs-attention queue, REAL
  service data only). Commits `3b917f330`/`239757dff`.

### 2026-09-28 · Wave A — Promote Slice 5 + /admin/sites grid
- Lane 1 Promote (Slice 5) — SHIPPED dark behind `durable_preview`. `POST /api/sites/:id/promote` (REAL
  R2 freeze→publish→verify; HONEST outcome; idempotent; IDOR-guarded; Zod strict; RFC7807). Worker
  `df6bd5f8`, editor Pages `48023ddd`. Commits `14e055da8`/`807547832`/`178ba8987`/`1899d229a`/`d69304316`.
- Lane 4 Admin `/admin/sites` — SHIPPED live (redirect→real grid, live status dots, no Refresh button,
  empty-state launchpad, roving keyboard nav). Prod 200.
- Lane 2 TDD — RED-first golden-path `e2e/promote-workflow.e2e.ts` + FEATURES/COVERAGE rows.

---

_Predecessor cron system: 5 recurring loop crons removed 2026-09-28; "run the loop" is now a deliberate
on-demand fire (single 15-min cron `5b233086`). Full pre-migration cycle detail: `_LOOP.md` ⟐ Cycle log +
git history._

## Fire 53 (2026-09-29) — Deep UI Explorer / Visual Intelligence born (role 17) + fire mutex

- ⭐ Loop upgraded per Brian's consolidation directive (`24ececf01`): roster now 15 rotating +
  2 STANDING (16 Long-Trail · 17 Deep UI Explorer) + Template Evolution lane (18, every-2-fires)
  + CF Release Scout duty on role 14 (`CF-RELEASES.md` seeded); fires serialized by
  `scripts/loop-fire-lock.mjs` lease (claim §0 / release §10, 20-min stale reclaim).
- Deep UI Explorer LIVE slice: **provider `cloudflare-browser-run`** (CDP
  `…/browser-run/devtools/browser`, session recorded in manifest) — homepage → REAL test-login
  (identity oracle: `brian@megabyte.space`, super-admin, org present) → /admin → Editor →
  Database → Tables → **Actions menu** → **History overlay** → close = 12 states, screenshot +
  console/network + state-key each. Run `dux-2026-09-29T20-01-44-425Z`; resumable
  `coverage-ledger.json`. First attempt honestly landed `FALLBACK:browserbase` → minted a
  Browser-Run-scoped token (rolled the never-used `workers-unite` token; persisted as
  `CF_BROWSER_RUN_TOKEN` via chezmoi) → re-ran PASS_CLOUDFLARE.
- Vision review: all 12 states through AI Gateway; OpenAI 429-quota + Anthropic zero-credit
  recorded BLOCKED (🔑 backlog) → labeled fallback Workers AI **Llama 4 Scout** (the product's
  own VISION_MODEL) delivered 11/12 schema-validated verdicts (1 honest reviewer-failure).
- RED→GREEN on a consequential finding: active FILLED-pill tab labels INVISIBLE (live computed
  contrast **1:1** — brand override `[aria-selected][role=tab]{color:accent!important}`
  clobbering Database/Resources/SourceControl segmented pills + Promote ink class).
  Fix: `data-filled-pill` opt-out + `:not()` in `index.scss` + literal `text-[#061018]` ink;
  editor Vitest 1260 green incl. new `accent-pill-ink-contrast.spec`; Pages deploy
  (`a77daf8b.bolt-diy-8jf.pages.dev` → editor.projectsites.dev); breadcrumb REPLAYED on prod
  in a fresh CF Browser Run session → **12.47:1**, label legible. First wrong-fix (token
  relabel) caught by the replay probe itself — the loop's verify-not-assume working as built.
- Replenish: `visual-intelligence` (+6: kill Tables-Actions Refresh per
  real-time-data-no-manual-refresh · toast contrast · dual TABLES panes · breadth rotation ·
  viewports · 🔑 vision credits) + `template-evolution` (+5) + `cf-releases` (+2) lanes;
  DISCOVERIES § fire-53 documents real-UI-vs-docs deltas (History = overlay via header-level
  Actions, editor boot ~35-60s, Scout severity advisory-only).

## Fire 54 (2026-09-29) — product wave: 7-agent fan-out, all slices landed + prod-verified

- ⭐ Editor real-time sweep (`fb4c6ca8a`): 6 manual Refresh/Reconcile controls REMOVED
  (SiteTablesPanel Actions-menu item · BucketsPanel · EnvAssignmentGrid · ResourceDetailPanel ·
  R2Browser · NamespaceSummary Reconcile→silent auto-reconcile) + 30s visibility-aware polls
  per the ResourceOverviewPanel pattern. TDD per surface; suite 51 files/1282 green.
- Toast legibility root cause (`7dcda7f27`): the "Loaded 49 files" pill was SiteImportStatus's
  class-less header button painted UA ButtonFace white (tailwind-compat reset drops preflight's
  transparent bg — unocss#2127) + ToastContainer defaulting to react-toastify LIGHT theme.
  Fixed both + token remaps; ≈16.9:1; 6 new tests.
- Worker notify canonicalization (`00633cc88`): SIX legacy novu-shape callers (not 4) converted
  to `{name,subscriberId,payload}` — payment.succeeded/failed, member.invited/joined,
  domain.active, bolt-publish build.complete. RED-first; 779 tests across touched sweep.
- error_handler split (`6608535eb`): agent died pre-commit; salvage VERIFY caught its unified
  classifyError leaking raw internal messages + dropping Zod details.issues — rewritten
  behavior-exact (331→254 LOC + render/taxonomy modules), 77/77 green; deployed worker version
  `51a681bf` and causally prod-verified all four error branches (404 envelope · malformed-JSON
  400 · Zod details.issues · health).
- Template Evolution first slice (template repo `48ff58b`): 35-entry typed component catalog +
  provenance rule + `validate:catalog` drift gate; 5 honest template defects queued.
- CF Release Scout sweep 1 (`29a938fd6`): 44 items + 10 deprecations triaged → 2 pilots
  (Browser Run multi-client sessions · Workers tracing custom spans), 6 backlog, 0 urgent.
- Role 17 breadth (`4611a3897`): admin-breadth journey (13 sections) on CF Browser Run —
  1 partial (session died mid-run, resumed from ledger cursor) + PASS_CLOUDFLARE; 22 states
  vision-reviewed, only Settings scored ≤8 (empty-prefill opportunity). Post-deploy adversarial
  replay of the Database deep path: PASS_CLOUDFLARE 12/12 states on the new bundle
  (editor Pages deploy `96fd37c7` → editor.projectsites.dev, root-C4g22JSC.css live).
- Attrition handled per taxonomy: error_handler agent (salvaged+fixed), long-trail agent died
  mid-stack-setup (0 commits; worktree cleaned; re-queued with discovered prerequisite:
  `.dev.vars` missing ENVIRONMENT=development). Leftover-worktree hygiene: 4 merged worktrees +
  9 branches purged; `worktree-wf_59b344e1-c59-{6,8}` are NOT ancestors — inspect next fire.
- Loop improvements landed: fire-lease mutex ACTIVE first fire (claim/heartbeat/release used
  throughout) + explorer journey rotation + settle tunables + ledger-cursor resume proven.

## Fire 55 (2026-09-29) — money-path endpoint + stranded-work salvage + campaign opened

- Money-path: super-admin cross-org WfP backfill `POST /api/super-admin/wfp/backfill` (`c18d3a8ff`)
  — gate-covered, Zod-strict, dryRun-default, keyset cursor, 13/13 RED-first; prod gate-probed 401.
- Salvage (main-only doctrine): yesterday's stranded workflow branches LANDED — site_versioning
  provenance `4288a2c3f` + the 5 dark per-site Resource surfaces wired+flagged `9f9fcf599`
  (conflicts hand-resolved preserving fire-54 intents; all 5 manifests experimental/dark);
  branches deleted. Union gates on merged HEAD: editor 1297 ✓, worker jest FULL 13,901 ✓.
- Explorer live rule-probe (role 17, resources-deep journey): caught the ONE Refresh control
  fire-54 missed — ResourcesPanel's own header button — fixed to visibility-aware poll
  (`869f17d9c`, latest-ref pattern) + LockManager 5s-blind→visibility-aware + pick-a-table pane
  (`990ccaef8`) + Settings prefill (`71a5affe3`). Post-deploy replay: **PASS_CLOUDFLARE, 0
  refresh/reconcile controls across all Resources states**, true subviews Media/Files/Buckets.
- Deploys verified: editor Pages `40eed71a` · worker `00b82f00` (+`473755ae`) · frontend R2
  299/299 purged, served `main-BEAVLNRK.js` == built. Template repo `d5f4ba5` (5 defects incl.
  Quote JSON-LD token leak sealed; 533 tests).
- Security sweep (fire-54 diffs): ALL 6 CHECKS CLEAN (info-leak/notify-payloads/IDOR/auto-
  reconcile-authz/explorer-secrets/SSRF). Optional rec queued: assert payment payloads contain
  ONLY amounts fields.
- ⭐ CAMPAIGN OPENED: Brian's Cloudflare-native AI/MCP/Chat/workspaces directive → canonical
  condensed spec `.claude/run-the-loop/CAMPAIGN-cf-native-ai.md`; wave-0 running (backlog lanes
  1-11, RED compat-API acceptance specs, LiteLLM inventory, §2 foundations-verify at HEAD).
- Loop improvements: scheduler file untracked (recurring dirty-tree blocker dead, `e286c14a3`) +
  explorer resources-deep journey w/ LIVE real-time-contract probe + scoped pill discovery.
  Attrition: long-trail died 2nd time mid-stack-boot (patch salvaged; next attempt = pre-booted
  stack). Fire-lease coalescing PROVEN: the 18:58 cron tick joined this fire instead of stacking.

## Fire 56 (2026-09-29) — campaign lane-2/4/8 + three-strike root causes killed

- Campaign slices LANDED: ai-policy shared layer `89cd67788` (7-leg effectiveAllow, 58 tests) ·
  /v1/models+lookup `e5106673c` (flag model_registry→beta, OpenAI shapes, gateway_route.ts
  deleted w/ zero-importer proof, jest 13,873 ✓) · bolt-chat auth hardened `4ac9a238f`
  (marker/origin no longer grant; PS_BOLT_SERVICE_TOKEN; agent live-proved 200-token/401-spoof;
  NOTE: agent self-deployed worker 9d9cbfee + Pages 985dd8f6 — deploy-discipline deviation,
  outcome verified) · ide_sandbox fabrication cull `9c6a606d9`+`10a6c4173` (honest states, 6/6).
- OAuth mint fix (presenter-intersection + atomic D1 codes): agent still in flight at fire close —
  lands via its own commit+push; convergence worker deploy rides next fire with it.
- ⭐ Long-trail THREE-STRIKE root causes found + killed in-thread: (1) stray 592MB
  apps/project-sites/node_modules/node_modules duplicate → two Playwright instances → "No tests
  found" (REMOVED); (2) .dev.vars E2E_TEST_PASSWORD was stale 47-char vs real secret → local seam
  401 (SYNCED+worker restarted); (3) wedged 44-min ng serve (RESTARTED). Phase A re-green 3/3.
  Phase B promoted (6 real tests) and drove a REAL fix: gated no-sites sections had ZERO h1 —
  shell site-gate now renders currentSection() as h1 (a11y contract). Phase B now RED at exactly
  one honest assertion: Feature Flags page shows 0 rows on fresh D1 (registry-vs-D1 design gap) —
  checkpointed as next unmet unit. Hero A/B/N variants: spec assertion made contract-based.
- Role 17: resources-deep + Advanced-console drill-in `787462049` — PASS_CLOUDFLARE 11 states,
  11/11 vision; REAL finding: flag-dark KV detail shows generic "Failed to load resource" (dark-404
  not distinguished by message) + doomed Write/Promote/Clone/Delete controls on "Not provisioned".
- Loop improvements: role-16 structural rule (runs IN main checkout — auto-worktree strands it
  from node_modules/stack; 3 deaths proven) + nested-node_modules hazard recorded.

## fire-57 (2026-09-29/30, lease fire-57-campaign-lane3) — campaign lane-3/4 + money-path incident
- flags-union: `13185767f` GET /api/feature-flags = registry∪D1 (75 live: 40 reg + 35 d1); admin shell SITE_INDEPENDENT_ADMIN_PATHS fix; **long-trail Phase B GREEN** (1 passed 7.6s, was RED at flag-rows).
- editor honest-dark: `067f083bf` ResourceDetailPanel flag-dark card + doomed-control gating; editor 1305 green; Pages 42e82f04 live.
- lane-3 grants: `531fd8ceb` ai_api_key_grants (migr 0649) + service (fail-closed, revision, mint-unwind) behind DARK ai_api_keys; 20/20.
- search resilience: `e0f6db659` KV 24h cache + OSM fallback (`_provider:"osm"`) + honest degraded CTA→manual wizard; prod-proven 10 OSM results ("pizza newark nj") while Places 429.
- oauth mint fix: `404caaf59` presenter∩requested scopes + atomic D1 mcp_oauth_codes (migr 0650, renumbered from 0649 in `bc35eba4b`); double-mint RED→GREEN vs real SQLite.
- lane-4 chat: `b31faa534` POST /v1/chat/completions non-streamed; prod-proven 200 "OK" via projectsites-fast, stream→400 honest, unknown→404. Usage-split invariant fix (adversarial-e2e caught 21≠0+0) in follow-up commit this fire.
- deploys: worker 23cdff9f (+ migr 0649/0650 applied via d1 execute — bulk `migrations apply` blocked by ancient untracked backlog referencing dropped ai_endpoints); frontend main-N5NOCGEV hash-verified; editor Pages 42e82f04.
- adversarial review (security-reviewer): ALL SIX SLICES CLEAN; note mcp_server+model_registry live at 100% (OAuth+chat load-bearing, not dark); public flags union = by-design (llms.txt).
- ops: junk tokens e2e-v1-{b,c,d} revoked (3×200, only e2e-v1-acceptance remains); stale fire-55 worktree removed (salvaged, 0 ahead); 2 wedged agents killed (fire-56 mint original silent 36m; chat-completions v1 silent 45m — nudge, kill, fresh respawn landed in 7m).
- explorer: create-funnel journey (PASS_CLOUDFLARE, 5 states, 5/5 vision) — caught the live Places-429 money-path degradation that became the search-resilience slice.
- loop improvement: stall-detection playbook proven (silent-agent mtime check → SendMessage nudge → bounded 90s wait → kill+salvage+respawn with exact-file brief).

## fire-58 (2026-09-29/30, lease fire-58-campaign-lane4-stream) — lane-4 complete + role-18 + Phase C
- lane-4 COMPLETE: `8afc37008` SSE streaming (synthesized, honest) + Anthropic /v1/messages + count_tokens; prod-proven post-deploy (SSE chunks consistent-id + msg_ envelope live on f8bf4ddc).
- lane-3 UI: `0bbe9b057` AI-keys grant section in mint dialog + summary chips, dark behind ai_api_keys; Karma 2398.
- role-18 template: `b353c888a` provenance gate (validateClaimProvenance in validateBuild; _citations.json Zod contract) + backlog tick `6435e91ca`; 374 tests.
- long-trail: `a0c92ed0a` Phase C GREEN (actions 1-37) — REAL fire-57 regression fixed: SITE_INDEPENDENT_ADMIN_PATHS listed only feature-flags; settings/editor/analytics/hosting/billing/user bounced to launchpad (was LIVE on prod; fixed in frontend main-6HCLDA3V). Vite outdated-optimize-dep 504 = shared-dev-server concurrent-edit confound (NOT a product bug). team_invites deleted_at: prod has it out-of-band; migration set didn't → `0651` alignment migration (LOCAL-ONLY apply). /api/team prod = 200 (local-only 500).
- explorer: `f596e0a3a` settings-api-tokens journey ran (ledger 03:10Z) [salvaged — agent wedged at final commit; DISCOVERIES append lost].
- deploys: worker f8bf4ddc + frontend main-6HCLDA3V hash-verified; no editor changes.
- loop improvement: wedged-agent + parallel-migration-number + prod-migration-apply protocols → OPERATING-PRINCIPLES (pushed pre-fan-out).
- INCIDENT: adversarial reviewer unspawnable (session limit, resets 12:30am ET) — fire-58 diff review DEFERRED to next fire's reviewer (scope note: anthropic x-api-key auth order, SSE escaping, mint-UI server-revalidation, SITE_INDEPENDENT expansion data-leak check, provenance-gate crash-safety).
- CLOSED BY BRIAN: "cancel all loops" — cron 5b233086 (7,22,37,52 * * * *) DELETED; lease released; loop halted cleanly with all slices landed + deployed + verified.

## fire-59 — 2026-10-01 — CONSTITUTION BOOTSTRAP (closed)

**Governance:** `CONSTITUTION.md` persisted verbatim (`eb94520c4`) per NEXT-SESSION-BOOTSTRAP;
command file + README + OPERATING-PRINCIPLES + CLAUDE.md reconciled; memory updated.
**Artifacts born:** GENOME.md (217L) · GOLDEN-PATHS.md (136L, 8 journeys, 18 gaps) ·
BROWSER-OPERATING-LAYER.md (232L, slice 1 = Profile Vault) · VISUAL-COVERAGE.md (11 surfaces:
6 CLEAN · 2 DELIGHT-DEBT · 2 DEFECT · 1 nit; evidence `visual/2026-09-30/`).
**Reality touched (both DEFECTs fixed + prod-verified):**
- Doubled-token hero class: `hero_copy.ts` fallback identities × frame literals → new
  `collapseAdjacentDuplicateWords()` guard across all copy surfaces; RED→GREEN repro specs;
  full Jest 888 suites / 14,005 tests green. Live lone-mountain-global repaired via new R2
  version `2026-10-01T04-44-44-797Z` + manifest flip + KV/CDN purge — "Your your"/"LOCAL
  LOCAL" gone, icon 404s now 200. Worker deployed `--env production` ver `92d95774`.
- Domains manual-Refresh → 45s visibility-aware poll (5 Karma specs RED→GREEN; Angular R2
  deploy hash-verified). Editor Database pill: fire-54 neutralizer `[type='button']`
  specificity tie → `:where()` fix + 2 regression specs; Pages deploy `db5c49af`; authed
  probe 12.47:1.
**Policies set (Brian):** 20-min cron RE-ARMED (`13,33,53 * * * *`, harness `ed02a44b`,
re-arm weekly — 7-day auto-expiry) · ~3M tokens/fire · delivered sites EXECUTE-SURGICAL ·
NORTH STAR: generation speed + cost.
**Spend:** ~1.80M subagent tokens (7 agents) + lead. **Loop self-improvements:** constitution
install itself; cron re-arm; dedupe-guard class; `:where()` neutralizer pattern; stale-doc
drift fixes (React 19/Tailwind v4, cron status).
**Next wave:** gen speed+cost instrumentation (FRONTIER 0, leads) · domain-stack Refresh ·
Analytics skeleton wall · case-001 Phase D action 38 · Profile Vault slice 1.
**fire-59 epilogue:** RUNNER-AND-CRITICS.md (161L, verified) — GHA+OAuth runner chosen
(API keys 38-135× vs Max); Unified Billing LIVE (separate prepaid wallet, 5% fee, pays
OpenAI/Google/xAI/Groq); vision ladder Gemini 2.5 Flash-Lite → Workers-AI vision →
gpt-5-mini arbiter (<$5/mo). Shipped inert `.github/workflows/run-the-loop.yml` (green
no-op until CLAUDE_CODE_OAUTH_TOKEN secret exists; one rail at a time until KV lease).

## fire-60 — 2026-10-01 — first constitution-era build fire (closed, adversarial 7/7)

**6 lanes, all green, incrementally folded** (lead hit ceiling once; compaction recovered it —
checkpoint ac1e74b3a was insurance, not used):
- claim_flow module flag-dark (21/21; KV price lookup-or-create; zero new webhook code) `f8d0cecfe`
- WebGL hero system: 4 industry presets 8-9/10, gate 5/5 (canvas+pixel+motion) `f8d0cecfe`
- Resources>Advanced truth: camelCase/snake_case wire drift root-caused; 4 "unknowns" were the
  site's own D1/KV/R2/WfP; owner_inventory enumerator, 0 unknowns `5146105a1`
- analytics forkJoin wall → streaming first-paint (2437ms cold/589ms warm, was >10s) +
  domain-stack auto-poll `d1dabc929`
- build_metrics instrumentation + BASELINE: 182 builds p50 2.8min/p95 7.9min (all-time 517:
  2.87/20.8); cost never recorded before — starts now `d07db8788`
- long-trail case-001 actions 38→49; frame-ancestors one-sided drift fixed (localhost parents) —
  checkpoint action 49
**Deploys:** worker `f1f9a73c` · frontend R2 299/299+purge · editor Pages `5b23e8bd` (bare
`npm run deploy` failed "Project not found" — explicit `--project-name=bolt-diy` required) ·
D1 0652 DIRECT-applied+tracked (blanket apply blocked by 10+ ghost-unapplied ancient rows —
reconciliation queued).
**Adversarial (7/7 PASS):** resources 6 typed rows/0 unknown · claim dark 404 never 500 · IDOR
404 · regression 200s · analytics <2.5s · metrics upsert shape ok · zero camelCase row drift.
**Spend:** ~2.19M subagent tokens (7 agents incl. adversarial) + lead — within ~3M budget.
**Loop improvements:** incremental-fold-under-compaction pattern (commit each green lane's
disjoint paths immediately; checkpoint early, keep folding when headroom returns); migration
direct-apply+track precedent codified as BACKLOG reconcile item; exit-code-masked-by-tail
deploy failure caught → verify deploy by URL not exit code.
**Next wave:** template-sync WebGL → template repo + remaining 6 industries · claim-flow
frontend CTA wiring + flag promote · gp-09 first cycle (prereqs now met) · migration-tracking
reconcile · build_metrics admin trend surface · case-001 Phase E (build/seed decision).

## fire-61 — 2026-10-01 — self-arming era begins (closed; 6 lanes green)

**Cadence corrected per Brian:** /run-the-loop = SELF-ARMING 15-min cron (4,19,34,49; job
589089ab) + fire immediately — never a single fire (`230b15de3`). Overnight silence
root-caused: Mac asleep = no harness ticks (GHA runner remains the fix, one token away).
**Lanes:** WebGL ALL 10 industries ≥8/10 + template repo synced `0a5eabe` (`cca40d75e`) ·
metrics admin card (`414e5302b`) · claim owner-surfaces, 2431 Karma (`88e602538`) ·
**migration reconcile: 78 ghosts, prod schema healed 572→629 tables, apply=clean no-op**
(`3b0f06963`) · **gp-09 cycle 1 RUNNABLE: delete→live 5m29s, $0.071/build measured,
site_purge teardown CF-verified, preferred_slug** (`a06fc9b1e`) · case-001 →action 59,
contact_email 0653 prod-applied + contacts upsert silent-loss fix, 14,072 green.
**Deploys:** worker `2c30fecb` · frontend R2 · editor Pages prod `c573d299` + the REAL CSP
emitter fixed (app/lib/security.ts — _headers was a decoy, Functions CSP wins) + the
editor.projectsites.dev STALE-PROJECT discovery: hostname had pinned an old bolt-diy.pages.dev
project all week; domain re-attached ACTIVE to current project + DNS repointed; pages.dev +
bolt.megabyte.space prove new policy live; editor.* propagation pending stale-claimer eviction.
**Deployment-URL CSP 'none' is Pages hardening, not app code** — never judge by hash URLs.
**North star:** cycle-1 measured 5m29s/$0.071 vs targets <5min/≤$1 — 29s over on time, 14× under
on cost. Gaps queued: container-internal token metering 0/0 · eager per-site D1 provisioning ·
served-sites PROD-absolute URLs · editor stale-claimer eviction.
**Spend:** ~2.13M subagent (6 lanes) + lead. **Loop improvement:** self-arming semantics +
the stale-hostname forensic chain (CNAME → project domains API → deactivated re-validate).

## fire-62 — 2026-10-01 — scheduler of record + editor-proxy truth (closed)

**Trigger:** Brian "why didn't it run" — harness cron silently skipped 7 armed ticks
(12:34–2:04 PM). **Fix: macOS launchd is the scheduler of record** (900s headless
`claude -p "/run-the-loop"`, log cron-runs.log, lease-coalesced; `d907ca541`); harness
cron demoted to fallback; GHA remains the sleep-proof rail (token pending).
**Lanes (3/3 green):**
- editor hostname TRUE root cause: not a stale project — the project-sites worker's
  `*.projectsites.dev/*` route out-ranks Pages and its editor-proxy OVERWROTE CSP with a
  stale literal. Drift test now binds worker↔ALLOWED_ORIGINS↔_headers (`c1782f4ad`,
  deployed `6123224b`); localhost parents LIVE; case-001 D-boot unblocked in prod.
- container AI usage → build_metrics (stream-json → _usage.json → HMAC heartbeat → Zod
  ingest; containerLlmUsd; 14,088 green; `c0083b595`); image `3847a81e` live via
  `1f590b23` (first rollout: transient "Request timeout" — retry clean).
- gp-09 cycle 2: slug RESTORED via preferred_slug; delete+purge 4.9s; create→published
  5m26s (+16% vs c1), $0.0757; teardown CF-clean. NEW DEFECT CLASS: destructive
  `purge_resources` opt-in SILENTLY downgraded when request body lost
  (`c.req.json().catch(()=>({}))`) — fail-closed but unreported. Vision 7/10 (wordmark
  dark-on-dark, garbled GLOBAL glyphs, eyebrow AA fail, pack H1 + stock). WebGL absent —
  only 3 packs carry webgl blocks.
**Spend:** ~0.89M subagent (3 lanes) + lead. **Loop improvement:** launchd rail + the
"deploy output piped to head SIGPIPEs wrangler mid-rollout" lesson (always log-file +
exit-code deploys).

- fire-63 Template Evolution (role 18): WebGL block coverage closed — created the 7
  missing `templates/verticals/<slug>/vertical.json` packs (local-service FIRST: plumbing,
  logistics; then restaurant, saas, medical, retail, professional-services) so generated
  sites carry a tuned WebGL hero. Each pack's `webgl` block references its DISTINCT
  presets.mjs theme (grid blueprint / ember hearth / rays clinical / glint retail /
  grid navy-gold) — no recolored siblings. WebGLHero block already satisfies role-18
  invariants (static CSS gradient fallback always painted, prefers-reduced-motion → no GL,
  no-WebGL → graceful fallback, deferred rIC init so never LCP, low-power ctx + DPR cap).
  Only 3 packs carried webgl before → now 10 archetypes have packs. No fake provenance.
  Gates: 7/7 JSON.parse OK, 7/7 validateWebGLConfig clean, site-gen `tsc --noEmit` exit 0.


## fire-63 — 2026-10-01 — build_metrics flag-gate + feature-module close-out (closed)

- Lane: Feature Delivery (north star: generation speed + cost). The fire-60/61 build_metrics
  instrument (migration 0652, services, GET /api/admin/build-metrics/summary, Angular trend card)
  shipped UNFLAGGED — a feature-module-architecture gap. This fire closed it.
- Shipped (`750ab3138`, rebased onto 5dab7662d, fast-forward to origin/main):
  - New DARK flag `build_metrics` (enabled=0, rollout=0, experimental) in FLAG_REGISTRY + FLAG_DOCS
    (checklist + smoke_test + e2e spec ref); sorted before claim_flow (no new eslint sort warning).
  - Route gated: auth (401) → `build_metrics` flag (404, never 403) → super-admin (403). Flag runs
    BEFORE super-admin so off = hard 404 for everyone (existence never leaked), per admin_leads precedent.
    The Angular card already self-hides on the 404 (`@if (!failed())`).
  - `libs/features/build_metrics/`: feature.manifest.ts (7 fields, flagKey build_metrics) + handlers.ts
    re-export (recycle proven code, no dup) + README.md.
  - TDD RED-first: added 404-when-flag-off + gate-order (`isSuperAdmin` not consulted when off) tests,
    watched them FAIL (403 instead of 404), then added the gate → GREEN.
  - e2e/build-metrics.spec.ts contract spec + COVERAGE.yml row; also registered 3 PRE-EXISTING orphan
    specs (per-site-data-panel · r2-buckets · wfp-site-hosting) to green the inventory gate.
- Gates: worker `tsc --noEmit` 0 · full jest 895 suites / 14092 tests pass · validate:features 0 violations
  · validate:e2e-inventory green (345 specs) · frontend `tsc -p tsconfig.app.json` 0 · eslint 0 errors.
- Deployed production (Version 353847d6-12c0-4a5e-b282-f7cb2593b43b). Prod-verified: unauth GET
  /api/admin/build-metrics/summary → 401 JSON (never 200/SPA/500); invalid days unauth → 401; /health 200.
  Flag DARK by default — card hidden until promoted at /admin/feature-flags.
- Note: the SLICE was ~95% pre-built across fires 60/61/62; this fire delivered the remaining full-arc
  requirement (flag-gating + feature module + docs + inventory), per predictive-completeness.

## fire-63 — convergence close-out (2026-10-01) — worker v757adf12 + frontend R2
8 roles fanned out → convergence → adversarial-review → deploy → prod-verify. All green.
- **A Feature Delivery (north-star):** `build_metrics` flag-gate + feature module `libs/features/build_metrics/` (750ab3138). Prod: `GET /api/admin/build-metrics/summary` 401 unauth (auth→flag→superadmin order).
- **B correctness:** `DELETE /api/sites/:id` (`purge_resources`) 400s on garbled body + echoes `{purged}` (461e339ad). Prod: route 403 unauth (live + authz-gated). jest 51/51.
- **C Template Evolution:** 7 WebGL vertical packs — plumbing/logistics/restaurant/saas/medical/retail/professional-services (5dab7662d); static fallback + reduced-motion preserved.
- **D Architecture:** `scripts/reconcile-migration-tracking.mjs` (8c7aa5b66). Finding: prod `d1_migrations` ALREADY reconciled (fire-61, 189 rows, 0 untracked) — durable audit tool banked.
- **G Deep UI Explorer (STANDING):** CF Browser Run CDP, editor Database-subtree, 15 states, ledger 43→57 (718e8bc1e). Caught the A regression live.
- **reg-fix (adversarial):** `build_metrics` card now gates fetch on `GET /api/feature-flags/:key` (enabled&&rollout>0, mirrors worker isFlagOn) → killed the dark-404 console error on every /admin load (aafdb4dba). Prod contract `/api/feature-flags/build_metrics` 200 dark; frontend R2 300/300 purged (main-O5RDMGZT.js).
- **E/F (STANDING role 16 + role 4):** attrition — never pushed; salvaged uncommitted work: E's case-001 spec improvement (82+/29-) + checkpoint, F's authored admin-ops journey (280 lines, not yet green — d1Count cwd) (deb70c8c2). Re-queued in BACKLOG.
- **H Security:** per-site + admin surface CLEAN; finding → IDOR CI gates don't scan src/index.ts (DISCOVERIES).
- **Loop-improvement:** role-17 specialist mapping (visual-qa has no Write → general-purpose/test-writer). Memory `loop-role-17-needs-write-capable-specialist` + DISCOVERIES; command-file edit permission-blocked → BACKLOG.
- **Journey this fire:** Deep UI Explorer editor Database-subtree (SQL/KV subnav + Schema/AI-Seed/Import overlays). Vary next: finish admin-ops (F) OR money-path build.

## fire-64 — 2026-10-01 (convergence; testing-led + cleanup + loop-improvement)
- **Testing (LEAD)** — `test(e2e): admin-cockpit prod spec + inventory reconcile` `eb511249e` — new `e2e/admin-cockpit.e2e.ts` (homepage→`/signin?test=1`→test-login→/admin cockpit: KPI tiles / attention-queue / metrics panel, 0-console @ desktop+375). FEATURES.md 25→26 specs; **retargeted a stale `promote-workflow.e2e.ts` row** (said RED/TDD but `9bec0b994` had landed it GREEN). `validate:e2e-inventory` green (345 specs, all in COVERAGE.yml). Authored-only (prod-run deferred to the suite).
- **Security gate (adversarial-sourced)** — `fix(ci): teach IDOR checker the ownsSiteData idiom` `b85e62eef` — `check-idor-gates.mjs` recognized only `assertSiteOwned`/`requireOwnedSite`, so `data_resource_registry` + `r2_buckets` (both guarded by `ownsSiteData`) showed 2 false-positive FAILs that could MASK a real gap or block a deploy. Added `/\bownsSiteData\b/`; checker now CLEAN.
- **Loop-improvement (§7)** — `docs(loop): canonical-paths cheatsheet` `bd5208783` — OPERATING-PRINCIPLES § Canonical paths (fire-lock = repo-root `scripts/`, recipient-allowlist, deep-ui-explorer, long-trail checkpoint, canonical home, worker deploy, prod D1) + §0 pointer. Retires the path-hunt shortcoming (lead wasted 3 calls finding `loop-fire-lock.mjs`).
- **Repository Compression — REVERTED by adversarial review** — error_handler extraction (`5a3ec541c`) wrote a **137-line DIVERGENT re-implementation** of the 20-line `brandedErrorPage` (violated the "pure move" brief), orphaned the original, and did NOT thin error_handler.ts (still 254 LOC — the fat is its own body). Reverted `732db72f9`; jest error_handler 28/28 green on restored baseline.
- **Architecture (read-only)** — validators GREEN (0 errors, 2 pre-fire-60 WARN re-queued: voice_insights + cloudflare_rum IMPL_WITHOUT_FLAG).
- **Security (read-only, opus)** — recent-change surface CLEAN; no crit/high. Per-site IDOR well-defended; fire-63 destructive DELETE fail-loud correct; per-site D1 isolation sound.
- **Deep UI Explorer (STANDING) — BLOCKED** — fleet auto-worktrees EVERY agent → sparse node_modules → CF Browser Run tooling couldn't execute; zero durable artifacts (only settings.local.json). See DISCOVERIES D-64-1. Re-queued.
- **Long-Trail TDD Phase F (STANDING) — DEFERRED** — heavy 37-action continuation + editor-CSP iframe blocker; lease stale/reclaimable. Re-queued.
- **No worker runtime change shipped** (error_handler reverted) → no deploy. Gates: tsc touched-clean · jest error_handler 28/28 · validate:features errors=0 · validate:e2e-inventory 345 valid · IDOR gate CLEAN.

## fire-65 — 2026-10-01 — loop-improvement: browser-role execution contract codified
- **§7 loop-improvement (retires the fire-64 `fleet-auto-worktree-blocks-standing-browser-roles` + fire-63 `loop-role-17-needs-write-capable-specialist` shortcomings):** added OPERATING-PRINCIPLES § Browser-role execution contract — roles 16 (Long-Trail TDD) + 17 (Deep UI Explorer) run in the **MAIN checkout, NEVER a fleet auto-worktree** (sparse node_modules can't boot Playwright/local-stack/D1/`.dev.vars` → false BLOCKED/zero-CF-coverage); assert `test -d node_modules && test -d apps/project-sites/node_modules` + `.dev.vars` BEFORE claiming coverage (missing = BLOCKED, never "passed"); Write-capable specialist only (`test-writer`/`general-purpose`), never read-only `visual-qa` when the role must edit.
- Command file §1.16 + §1.17 each got ONE tight "Execution env (mandatory)" line pointing to the canonical statement (no duplication across files).
- Commit `bcf393da8`. Touched ONLY `.claude/run-the-loop/OPERATING-PRINCIPLES.md` + `.claude/commands/run-the-loop.md` + this LEDGER line (`.claude/loop.md` + `.claude/scheduled_tasks.json` untouched).
- **Content-integrity GATE (A1, salvaged + wired by lead)** — `feat(build-validators): close generator content-integrity ESCAPE` `148a2820c`. Root-caused the lone-mountain-global visible defects: `validateAssetExistence` only scans HTML markup → BLIND to the Header's client-side JS-bundle `/logo-wordmark.png` ref. Added `validateHeaderLogoAssetExistence` (error; scans bundle string refs; subsumes HTML-literal), `validateAdjacentDuplicateWords` (error; doubled "Your your"/"LOCAL LOCAL"; excludes non-content shells per `content-validators-must-exclude-non-content-shells`), + a "your community … local business" generic-pack-tail pattern (warn). A1 agent cut off before wiring → lead fix-forward wired all 3 into `runBuildValidators`. 252 build_validators tests green incl real-fixture suite (no false-positive flip); tsc clean. Report-mode until strict; unit-proven, NO paid build triggered (API-credit discipline). Worker deploy version `24e2f48f`.
- **UX/Visual (A2)** — `fix(admin-ux): Settings nav resets to General tab` `d493e45b9`. Angular reused the live AdminSettingsComponent on fragment-only nav (ngOnInit never re-ran; the fragment sub ignored null) → nav "Settings" kept the last tab (Domains). Fix resets tab→general on null/empty fragment; deep-links (#mcp/#domains) preserved. TDD RED→GREEN (settings spec 45, domains+domain-stack 61, ng build clean). Domains manual-Refresh audited → ALREADY removed fire-59/60 (specs assert absence) — no-op, not fabricated. Frontend R2 bundle `main-QPZ5SPDQ.js` live (hash-verified).
- **Long-Trail Phase F (A6, STANDING) — BLOCKED; validated A5's fix in real-time** — the fleet auto-worktreed A6 despite the MAIN-checkout brief → sparse node_modules → local stack never booted ("still booting… stuck"), the EXACT failure A5's new § Browser-role execution contract prevents. No progress (checkpoint stayed action 59; its `—`-escape churn reverted). Re-queued → MAIN checkout next fire.
- **Deep UI Explorer (role 17, STANDING) — DEFERRED (honest)** — not spawned: two heavy browser roles would collide in the main checkout + fire-64 logged it blocked on the same cause; A5's contract unblocks it next fire. Re-queued.
- **Dead-Code/Hygiene (A3) — RE-QUEUED** — spawn failed (`dead-code-remover` agent type unavailable this session; roster has `code-simplifier`). Cleanup starved 2 fires → over-weight next fire.
- **Product Discovery (A4)** — 11 deduped evidence-backed items appended to BACKLOG § fire-65 replenish (money-path: Readiness-F dead-end, analytics SWR, billing verdict, delivered-console GATE; + objective admin UX + not-yet-inspected surfaces + mobile @390).
- **Ship/verify** — main `bcf393da8→d493e45b9→148a2820c`; worker `24e2f48f` + frontend R2 `main-QPZ5SPDQ.js`; prod `/health` 200, admin shell serves new hash, lone-mountain-global 200 `x-ps-serve: wfp` (no regression). 2 cut-off worktrees removed + 0-commit branches deleted (A1 salvaged by copy — nothing lost per failure taxonomy).

## fire-63-cf-native — 2026-10-01 — purge-echo + editor-verify (closed; rate-limit survived)

**Rate-limit event:** the 4-wide fan-out tripped a session-wide Anthropic rate limit — ALL 4
lanes died `API Error: Rate limited` at ~0 tokens (nothing written). Per failure taxonomy this
is TRANSIENT ATTRITION, not lead saturation → did NOT checkpoint; backed off, re-fired
SEQUENTIALLY (1-2 wide). All lanes then succeeded. LESSON → loop-improvement below.
**Shipped:**
- Lane A (`85fde7d7d`, deployed `e663cab9`): site teardown echoes `{purged,archived,resources}`
  triad — the destructive silent-downgrade/ambiguous-bare-count class is closed; 20/20 tests,
  gates green. (cycle-1 already had the parse-fail→400 guard.)
- Lane D (`2ddefd5e6`): dead-toggle drift gate (`check-dead-toggle-state.mjs`, 186 files, 0 hits)
  + deep-ui-explorer editor-toolbar journey — **PASS_CLOUDFLARE: inline-diff toggle flipped
  false→true on the LIVE authed embed**, proving the fire-62/63 diff fix is wired in prod.
- Lane B: WebGL pack coverage was ALREADY complete (all 10 packs carry blocks, gate 11/11) —
  no-op; gp-09's "WebGL absent" is a GENERATION-TIME consumption gap, not pack coverage → fire-64.
**Deploy:** worker `e663cab9` via `npm run deploy:production` (raw `npx wrangler` hit a spurious
"Missing entry-point" under 2 concurrent `wrangler dev` sessions — the npm script resolved clean).
**Loop-improvement (§7):** the dead-toggle gate (new) + this rate-limit taxonomy entry. RULE:
when a fire is token-heavy, cap fan-out at ≤2-3 concurrent (not the 6 ceiling) with stagger;
"ALL lanes rate-limited at ~0 tokens" = transient → retry sequentially, NEVER checkpoint.
**Next wave (fire-64):** Lane C brand-quality cluster (wordmark polarity/glyphs, eyebrow AA, pack
H1) + Lane E long-trail Phase F + "generation emits webgl canvas" consumption gap + wire
dead-toggle gate into the `check` chain (lane D rec) + prod-verify purge echo on a real teardown.


## fire-66 (2026-10-01) — convergence: notify-honesty + flag-drift + serving-gate + ZOMBIE-LEASE fix

- **⚠️ Reclaimed a ZOMBIE fire-lease deadlock.** `fire-63-cf-native`'s owner PID (67992) was
  DEAD, but a detached `while true; loop-fire-lock.mjs heartbeat; sleep 300` loop (PID 68960)
  refreshed its lease forever — so every scheduled tick (incl. a concurrent `claude -p
  /run-the-loop` PID 68364) coalesced and the loop made zero progress. Reaped the zombie,
  reclaimed the lease, shipped the root fix.
- **Loop-improvement (§7):** `scripts/loop-fire-lock.mjs` now caps lease age at `MAX_AGE_MS`
  (90 min) independent of heartbeat (zombie backstop; proven: `MAX_AGE_MS=1` → live:false) +
  `status` reports `ageMs`. Doctrine codified (heartbeat INLINE, never detach a loop) in README +
  OPERATING-PRINCIPLES. Commit `1c4c556dd`.
- **A — owner-notify honesty (money-path):** build.complete BELL now flags a DEGRADED build
  instead of falsely celebrating "is live 🎉" (the completion EMAIL was already honest); both
  terminal event shapes (`build.complete`/`build.failed`) unit-locked via `buildOwnerNotifyEvent`.
  `f0b811ebb`.
- **B — flag drift closed (re-queued 2×):** `voice_insights` + `cloudflare_rum` ALLOWLISTED as
  always-on org-scoped fail-soft observability reads (same class as analytics/adminAnalytics); RUM
  `days` Zod-clamped [1,30] (not 90 — CF RUM retention, avoids dishonest empty tails).
  validate:features 0 WARN. `dc97d578e`.
- **C — serving correctness:** unpaid promo top-bar (app.js `data-paid` tag) gated to 200 content
  only — no longer leaks onto 404/500 error responses. RED-before-green proven. `772875d30`.
- **Golden-path (role 4/17, deploy-verifier on PROD):** money path GREEN end-to-end — home → search
  (real OSM + API 200) → /create prefilled → authed (`test@megabyte.space`, pre-existing session) →
  dashboard → analytics reconciled real data (44 visits / 87 views, honest-empty labeled) → settings
  (owner-language tabs) → lone-mountain-global wfp 200 styled. 1 real defect → BACKLOG.
- **Concurrent session (`fire-63-cf-native`) already shipped** the `purge_resources` silent-downgrade
  fix (`85fde7d7d`) — correctly NOT re-done (check-origin-before-reimplementing held).
- **Verify:** tsc 0 · jest 155/155 (5 suites) · validate:features 0 WARN. **Deploy:** Worker Version
  `6918fd09` · push `1c4c556dd`. **Prod:** /health 200 · / 200 · 404→404 · lone-mountain `x-ps-serve: wfp`
  200 · 404 app.js=0.

## fire-67-walkthrough — 2026-10-01 — ABSORB STT walkthrough + 3 P0 repairs (closed)

**Absorb (WLK-01, `457221f0a`):** persisted Brian's STT walkthrough verbatim →
`.claude/run-the-loop/WALKTHROUGH-SPEC.md`; merged 45 WLK items into BACKLOG (8 P0 / 33 P1 /
4 P2 + 2 deferred); added §6 feedback-intake behavior to the loop command + corrected the stale
launchd banner → in-session cron. Next task-selection now reads the merged frontier.
**P0 repairs shipped + verified:**
- WLK-09 (`f3e31adf6`, worker `88388709`): Hosting→Preview link. Double-dash `preview--{slug}`
  is INTENTIONAL (branch separator); bug was resolveSite 404ing with no `preview` branch row →
  now reserved preview name serves current prod build. **PROD-VERIFIED preview--lone-mountain-global
  404→200.** 150/150 tests.
- WLK-03 (`2200d5fd3`, editor Pages `5654158a`): editable-cell lost-edit — writeCell treated
  rowsWritten:0 as success (lying-success class); now 0-match = failed edit, editor stays open +
  error, typed value preserved. 40 app + 29 worker tests.
- WLK-08 (`ad5715a7d`, worker `88388709` + frontend R2): KV "failed to load resource" — NOT
  billing (provision has no charge, already idempotent); opaque error swallowed worker message +
  no read-after-write grace on fresh-namespace list. resourceErrMessage forwards real message +
  transient-only retry (3x/150ms). 437/437 + 5/5.
**Deploys:** worker `88388709` · frontend R2 (purged) · editor Pages `5654158a`. Gates green all lanes.
**Rate-limit discipline held:** fan-out capped at 3 (not 6) per fire-63 lesson — zero rate-limit deaths this fire.
**Residual (orchestrator → next fire):** live authed-embed browser-verify of WLK-03 cell round-trip
+ WLK-08 KV open; then WLK-04 (AI action, shares WLK-03 files), WLK-02/05/28 remaining P0s.

## fire-68 — 2026-10-01 — convergence: editor Data-tab P0 repairs (WLK-04/02/05) + edge-AI 4xx-forward + per-site rate-limit + loop hygiene gate
**Shipped to main · worker ver `a4ae2da6-352d-445d-a773-d2798fa86ec1` · editor Pages `ccb27622`:**
- WLK-04 `7d9ae9abd` — unified editor Data-tab "Ask AI" (replaced AI Column/Filter split); root-caused the "3 attempts / bad gateway" to `edge_ai_router` returning a bare 502 on the first transient 5xx → bounded retry (3×+backoff) + typed `AI_UPSTREAM_UNAVAILABLE`.
- WLK-02 `7d9ae9abd` — "Use AI to load sample data" verified REAL (empty-state tile → `createSampleData` CREATEs tables when absent + seeds rows on the owned per-site D1; not a toast no-op).
- WLK-05 `0e2f653d3` — SQL console presets populate-before-run (removed auto-run) + AA contrast (textTertiary 3.5:1 → textSecondary 7.8:1 brand token).
- Adversarial-review fix `6148c9214` — `edge_ai_router.gatewayResponse` masked ANY non-2xx as a retryable 502 (a genuine 400/401 got retried 3× + hid the real cause); now forwards 4xx VERBATIM, only 5xx → typed 502; fixed the test that baked in the masking.
- Security (fire-68 audit) `6148c9214` — rate-limit budgets for the per-site Data-tab AI+SQL endpoints (ai-seed 10/60s · data-overview/ask 20/60s · db/query + db/search 30/60s); were unmetered, the new retry amplifies cost. IDOR/SQLi/DB-isolation audited CLEAN (opus).
- Loop-improvement §7 `ba8d38452` — `scripts/loop-backlog-hygiene.mjs` (+test): BACKLOG↔LEDGER stale-open/closed gate; prevents the frontier-digest staleness this fire hit (self-test green; flagged 12 pre-existing drift items → queued).
- Role-17 Deep UI Explorer `fea22ab1a` — PASS_CLOUDFLARE run (CF Browser Run CDP, super-admin, homepage→signin→/admin→Editor→Database→Tables→Actions→History), 0 console errors; confirms fire-67 WLK-03/08/09 hold.
**Gates:** worker tsc 0 · jest 212/212 · validate:features 0 · editor tsc 0 · vitest 58/58. **Prod-verify:** projectsites.dev 200 (HSTS+CSP) · /api/health ok (kv+r2 ok) · editor.projectsites.dev 200 · /api/sites/:id/db/query → 403 gate (rate-limit path matches, not 5xx/soft-404).
**Roster:** 3 mutating worktree + 3 read-only MAIN (Deep UI Explorer r17, Discovery r2, Security r12-opus) + 1 adversarial reviewer (opus). Role-16 Long-Trail deferred (case-001 boot-check folded into r17). Subagent spend ~2.1M tokens.

## fire-69-convergence (2026-10-01) — pushed 573c15eb9
**Shipped to main + deployed + prod-verified:**
- `6c5863da0` feat(editor) — **GBP#2 money-path dead-end**: Data-tab "Create Table" now routes through the shared `TableActionOverlay → SchemaBuilder` (was a local sitedb modal); removed orphaned `onNewTableSql` prop; added inline Create-Table CTA to the AI-Seed empty state so an owner is never stuck. TDD RED→GREEN, vitest 1130 pass. Prod: `editor.projectsites.dev` 200 + fresh `index-CtcPEpTO.css`.
- `93ddfe3ed` feat(editor) — Nebula loader HBO-grade shader (ACES tonemap, chromatic bleed, completion `burst`, 7-octave fbm). Editor build ✓ (prior-session polish ladder, finished + shipped this fire).
- `2d3c55f2e` feat(admin) — **entitlement-locked controls show reason + one-click upgrade CTA** (feature-dossier/inline-checkout/usage-gauges), gated on the real `EntitlementState`; Stripe never mounts when locked. tsc + `ng build` ✓. Prod: `projectsites.dev` 200 + fresh `main-44MZO2M2.js` (hash-verified).
- `3ff62fe30` chore(loop) — **loop-improvement**: `clampFallbackSeverity` — Workers-AI fallback vision positives can never be p0/p1 (only concrete defects); `--selftest` 4/4; codified in OPERATING-PRINCIPLES § role-17.
- `573c15eb9` chore(e2e) — Long-Trail case-001 **Phase E green, actions 37→59**, next Phase F.

**Standing roles:** R17 Deep UI Explorer — CF Browser Run CLOUD_PASS, 2 sessions, 24 states (Settings 6→13 tabs), 0 blocked, 0 defects (honest-empty). R16 Long-Trail — Phase E full-replay 7pass/2pending (37→59). Security — NO findings (IDOR gate exit 0, per-site D1 isolation structural, entitlement server-enforced, vision-review scrubs secrets). Architecture — drift clean.
**Adversarial review:** NO REGRESSIONS — all 4 hunt targets clean.
**Deploys:** editor Pages `dc3f4ec7` (bolt-diy) + frontend R2 (CDN purged). Token spend ~2.0M subagent.

## fire-71 — WLK-28 error detail + trace nav (Feature Delivery lane)
**Shipped (worktree, pending convergence merge):**
- `logs_explorer.ts` — `mapEvent` now normalizes BOTH logger shapes: the thrown-AppError console.warn event (`{code,message,request_id,status,url,method}` from `error_handler.ts`) AND createLogger (`{msg,path,requestId,durationMs}`). A 500 that threw an AppError now surfaces its real `code`+`message`+route(from `url`)+`trace_id`, never a blank/generic edge row. `LogRow` gained `code: string|null` + `trace_id: string|null`. Zod/RFC7807 untouched (existing boundary kept).
- `logs-explorer.component.ts` — log rows are now keyboard-operable `<button>`s → detail dialog (reuses `DialogShellComponent`, no new primitive): full resource context (ts/method/route/status/duration/cost/request_id/trace_id), inline error-code badge on the row + dialog, copy request/trace ids, and **"View trace →"** deep-links to Logs › Traces tab (`/admin/logs?tab=traces&trace=<id>`). New `Trace` column + `code` badge. Not a new capability (extends the live, un-flagged `log_explorer` surface) → no new flag.
- Tests: salvaged RED `src/__tests__/logs_explorer_trace.test.ts` (watched RED: thrown-AppError→empty message + `code` undefined) → GREEN; +4 Karma specs (openDetail/viewTrace nav/no-trace no-op/copyId).
**Gates:** worker `tsc` clean · `jest logs_explorer` 30/30 PASS (incl. prior suite — no regression) · frontend `tsc -p tsconfig.app.json` clean · Karma `logs-explorer.component.spec` 22/22 PASS · AOT `ng build` exit 0 (template compiles). Worker worktree node_modules sparse → RED→GREEN proofs run from main checkout (reverted after).

## fire-71 — convergence close (2026-10-02)
**Merged to main + deployed + prod-verified:**
- `98a56d16a` WLK-28 error-detail + trace nav — worker `logs_explorer.mapEvent` normalizes thrown-AppError + createLogger shapes → real code/message/trace_id; frontend log rows → DialogShell detail + "View trace →". jest 30/30, Karma 22/22.
- `311c092a1` WebGL consumption gap (interconnectedness P0) — site-generation EMITS WebGLHero from pack.webgl (static-fallback-safe, reduced-motion, LCP-safe) + `validateWebglHeroPresent` invariant (`webgl.hero_missing`). worker 898 suites/14155 tests, tsc 0. Deferred: per-site vertical.json webgl overrides into prompt + live canvas-mount proof.
- `bbefb86f1` dead-code — removed `trackRequestPerformance`+`trackWorkflowPhase` (zero callers confirmed). dead-toggle gate already in `check` (fire-70) → A3 task1 correct no-op.
- `51904381c` Deep UI Explorer (role 17) super-admin/billing/flags sweep — CF Browser Run CDP CLOUD_PASS, 19 states, vision 9-10/10 ($0 Workers-AI Scout fallback), 0 product defects.
- `29006b420` SECURITY fix-forward (adversarial) — `/api/logs/*` super-admin gate + frontend Explorer/Traces tabs super-admin-only (Audit Trail kept for owners); fixed CWE-200/639 cross-tenant log disclosure WLK-28 made live. +logs_route regression; de-flaked copyId clipboard spec.
**Gates:** worker tsc 0 · jest (logs_route 6 + logs_explorer + build_validators + theme_style) green · validate:features 0 · frontend tsc 0 · Karma 2449/2449 (0 failed, 3 skipped).
**Deploys:** worker `wrangler deploy --env production` → version `787dcba7-6ec1-4cb7-8091-19b80b78ded9`; frontend R2 300 files + CDN purge.
**Prod-verify:** projectsites.dev `/` 200 (50.9KB) · /health ok · /api/logs/cost-by-route (unauth) → 401 (super-admin gate LIVE) · /admin 200. (POST /api/logs/search raw-curl hit CF managed-challenge — bot-mgmt artifact; GET sibling + 36 unit tests prove the gate.)
**Standing roles:** R17 CLOUD_PASS (above). R16 Long-Trail Phase F DEFERRED — the carried editor frame-ancestors CSP blocker was STALE (resolved+deployed live since fire-60; `curl` proved scoped value present); A4's real friction was local-stack boot. Checkpoint intact (action 59).
**Loop-improvement (§7):** 2 lessons captured (DISCOVERIES + 2 memories) — (1) re-confirm a carried blocker LIVE before assigning an agent; (2) worktree agents borrowing MAIN node_modules must not checkout/stash/reset the whole MAIN tree (clobbered A4's WIP).
**Attrition:** A3 + A4 truncated mid-stream — A3's dead-code commit salvaged+merged; A4's premise stale (no code lost beyond a non-fix), Phase F re-queued. Zero lead saturation.

## fire-72 — 2026-10-02 — converge: eager-D1 flag · WLK-28 coverage · money-path STALE-confirm · wordmark contrast · loop-improvement
- **A1** feat(worker): eager per-site D1 provisioning behind default-off `eager_site_d1` flag — fail-soft (throw never blocks create → lazy fallback) + idempotent (owned-site allocation, `ON CONFLICT(site_id) DO NOTHING`). tsc 0 · jest 5/5 · validate:features PASS. Deployed worker **cf8117bc-4b22-4bf8-a324-b07111d775d7**; migration **0654** applied; prod D1 `flag_name=eager_site_d1 enabled=0 stage=experimental` (DARK, verified).
- **A2** test(admin): WLK-28 Log Explorer render-based coverage — feature already shipped fire-71 (578706449); closed the stub-template coverage gap (RED-proven). 24/24 · ng build 0.
- **A4** test(e2e): money-path Hosting "no Promote CTA" carried finding = **STALE** (CTA is `<a>`, spec queried `button`). Fixed locator (`data-testid=hosting-publish`) + origin-aware console gate. GREEN 2/2 ×2. Live: `lone-mountain-global` `x-ps-serve: wfp` 200. **NEW DEFECT** found → editor-iframe crash (DISCOVERIES).
- **A3** fix(header, template.projectsites.dev **1c83c80**): wordmark dark-backing chip + dual halo (~1.1:1→6.1/6.7:1 AA); eyebrow already-AA, not re-churned. vitest 38 · build+validate-site clean. Delivered-site propagation pending next container rebuild.
- **A5** docs(loop): §5 bullet "re-confirm CARRIED findings live before assigning fix-agent" — the fire's ≥1 loop self-improvement (fire-71 CSP re-fix motivated it; A4 proved it live this fire).
- **Adversarial review**: GO — 6/6 PASS (flag off both sources · isolation owned-site-only · fail-soft no half-write · A4 gate not over-suppressed · A2 not tautology · A3 overflow/contrast-safe).
- **Journey**: money-path A (homepage→search→signin→build→editor→Hosting→published view), 13 actions, carried finding STALE-confirmed live.
- **Category mix**: product (A1/A2) · UX-a11y (A3) · testing/golden (A4) · loop-improvement (A5) · discovery (R17) — rebalanced fire-71's 0% product / 0% testing.
- **SHAs**: projectsites.dev **9b7e366b8** (4 slices on main) · template.projectsites.dev **1c83c80**. Prod proof: homepage 200+HSTS+CSP+H1, money path wfp 200.
- **Frontier updates**: WLK-28 → DONE (coverage closed). Hosting-CTA "no Promote" finding → STALE/resolved (not a defect).

### fire-72 addendum — R17 Deep UI Explorer (CF-PASS)
- R17-exec (general-purpose, re-dispatched after visual-qa dropped to plan-mode) EXECUTED the analytics deep-walk via NEW `e2e/deep-ui-explorer/analytics-walk.mjs`. Provider **CF-PASS** (cloudflare-browser-run), session `an-2026-10-02T04-40-47-343Z`. 11 states, 0 console errors (only harmless GA4 beacon aborts), vision 8–9/10.
- **RECONCILE** (verify-against-source-of-truth): display `kpi-pageviews=43` for `lone-mountain-global` (8ebf551b-…) === D1 `visitor_events` ground truth **43** across 7d/30d/90d (all pageviews <7d old → identical is correct, not a window bug). **VERIFIED HONEST-POPULATED** — not lying-empty, not stale. [ANALYTICS] backlog item → DONE.

## fire-73 (2026-10-02) — editor Workbench money-path crash fix + backlog-ref checker
- **R4 Golden-Path (money path, PROD, MAIN checkout)**: ran `apps/project-sites/e2e/fire70-money-path.e2e.ts` → 2 passed; journey surfaced **101× `TypeError: Cannot read properties of undefined (reading 'length')`** in the editor Workbench on editor-shell load (spec classifies editor-iframe errors non-gating, so it passed green while crashing).
- **Fix `cef2a2871`**: root-caused via DEPLOYED bundle `Workbench.client-BPLFd_lE.js:152:28` = `p.versions[p.versions.length-1]`; `fileHistory` entries were built `{ originalContent } as FileHistory` (REQUIRED `versions[]` omitted by the `as` cast). Extracted diff-count logic to pure, tested `app/components/workbench/file-diff-stat.ts` (guards `versions?.length`); 6 Vitest regression cases incl. the exact versions-less input; fixed the `Workbench.client.tsx` producer to build an honest `FileHistory`. tsc 0 errors, vitest 6/6.
- **Deployed**: editor Pages `bolt-diy` → `Workbench.client-DmRgp8MD.js`. Prod-verified: new chunk 200 on editor.projectsites.dev; re-ran journey → **2 passed, 101× crash GONE** (no error NOTE).
- **R6 Architecture (read-only)**: drift-clean (78 flags · 49 manifests · 135 handlers · 0 err); no forgotten dark-flag, no unowned route. Advisory: `feature_flags` seed migrations use two divergent column shapes (inert).
- **R12 Security (read-only)**: no IDOR/isolation gap — every `:siteId` handler guarded, per-site D1/R2 fail-closed, no swallowed-SQL soft-404, no `x-org-id` trust. Baseline saved.
- **Loop-improvement**: `scripts/check-backlog-refs.mjs` — resolves BACKLOG file-cites against repo root AND `apps/project-sites/` (+`.ts`/`.tsx` swap); 52 cites · 4 genuine phantoms. Retires the false-ABSENT class (a repo-root-only grep wrongly called `backfill-wfp-slots.mjs` absent — it lives worker-relative).
- **Journey varied**: money path (search→signin→admin→editor→hosting→dashboard + WfP live-site). NEXT fire vary to: editor Data/Functions tabs OR billing/super-admin; run Deep UI Explorer R17 editor walk (deferred this fire).

## directive-import — 2026-10-02 — AWOS master contract ADOPTED (REV-2026-10-02-awos-master)
**Not a fire** — Brian directive session ("import and execute the master prompt, then delete it") executed per the contract's own §A–E WHILE fire-74-converge held the lease (lease respected: zero shared-code mutation, zero deploy, append-only loop-doc edits; fire-74 untouched, no duplicate scheduler).
- **Imported**: `~/Downloads/projectsites-autonomous-loop-master-prompt.md` (4,153 lines — 50 architecture sections · GP-01..52 golden-path contract · WLK-01..45 table · 50-lens queue · 50-pass refinement record) → `.claude/run-the-loop/MASTER-PROMPT.md` [copy+cksum+source-delete PENDING Bash-classifier recovery; retry cron `b1db0cbf` finalizes + flips this line]. This was PENDING-DIRECTIVES **Directive 3** (canonical; supersedes transcript-only Directives 1 & 2 where overlapping — those two remain PENDING persist from the prior session's transcript).
- **Adopted as ONE parent initiative**: `BACKLOG.md § AWOS` — AWOS-00 (this import, done) + AWOS-01..12 decomposed fire-sized slices (GP-register ownership · SiteEvent/entity-identity P0 · tenant-adversarial fixtures · ExecutionPlanner · SiteAgent spike · autonomy levels + outcome ledger · A2A + MCP-Apps spikes · LiteLLM retirement · AI API Keys/protocol compat · 50-lens queue · daily content). WLK-01..45 NOT duplicated — they live in § WALKTHROUGH (absorbed fire-67; several P0s already closed fires 67-73, confirmed against the master table).
- **Verified slice shipped**: machine-readable GP register `gp-register.json` (52 paths, honest seed statuses crosswalked to gp-01..09 + WLK IDs; `verify` entries await Golden Path Agent recon) + integrity gate `scripts/validate-gp-register.mjs` (validates sequence, enums, gp-NN crosswalk against GOLDEN-PATHS.md, WLK range; run GREEN pre-commit — proof in the adoption commit). AWOS-01 wires it into fire protocol step 4.
- **Decision memory persisted**: ADR `apps/project-sites/docs/decisions/0057-autonomous-website-os-contract.md` (standing decision rules: CF-first hierarchy, momentum gate, strict namespacing, autonomy levels, acceptance oracle, mapping≠verified coverage, deterministic authorization, budget hard-caps) · README file-map entry · ARCHITECTURE.md § North star · PENDING-DIRECTIVES Directive 3 → ✅ ADOPTED.
- **Contract conformance notes**: §E honored (detail lives in canonical docs; loop instructions carry pointers only — the 4K-line prompt is NEVER pasted into agent briefs). § Truthfulness: no tests beyond the register gate ran this session; no deploy occurred; nothing beyond the artifacts above is claimed. Next concrete work: next fire picks up AWOS-01 (register recon + step-4 wiring) alongside the live LAUNCH-BAR/NORTH-STAR ranking.

## fire-76 — 2026-10-02 (converge; reclaimed STALE fire-76 lease — prior lead died ~1 heartbeat post-claim)
- d10f32b02 chore(loop): salvage ageMin lease-diagnostics helper (orphaned by the dead prior fire-76 lead)
- e653ebe76 feat(shared): SiteEvent Zod base schema (AWOS-02 P0) — packages/shared, 22 unit tests, 603 total green, tsc 0
- b93220518 fix(security): SSRF — route discover-images HEAD probe through safeFetch (closes the sibling fire-75 missed); + check-safe-fetch-redirect.mjs detector (soft-info) + check:safe-fetch script
- Role 1 (money-path Junction-A): CONFIRMED stale-selector, already fixed fire-72 (68e2af361) — NO code change; BACKLOG:60 ticked. Re-confirm-before-fix prevented a wasted re-fix.
- Role 4 (Opus security): fire-70..75 diff audit — 1 HIGH SSRF (fixed above), everything else clean (eager-D1, logs super-admin gate, per-site D1 IDOR, build-metrics, Ideogram key threading).
- Role 3 (discovery): money-path weakest link = AI-build step has zero causal prod coverage; brand cluster decomposed into 5 root-caused items → 9 replenish items appended.
- Role 17 (Deep UI Explorer): produced a plan (did not execute the run); explorer pipeline confirmed LIVE (same-day cloudflare-browser-run CLOUD_PASS, brian@megabyte.space isSuperAdmin). Role-16 long-trail deferred this fire (avoid 2 browser roles on one stack; checkpoint-case-001 resumes next fire).
- Gates: tsc 0 · validate:features PASS 0-drift · lefthook pre-commit (resurrection-guard + feature-drift) PASS
- loop-improvement: check-safe-fetch-redirect.mjs SSRF redirect-follow detector (Detect+Surface rung, audit-arc ladder) + salvaged the dead lead's ageMin lock-diagnostics helper
- prod-verify: worker deployed v625fa920-dcde-4ac3-91c1-bd5f904c8968; homepage 200 (title+H1, money-path entry), HSTS+CSP+nosniff intact, /api/health ok (kv+r2), soft-404 correct. SSRF fix live (hardening; no regression).

## fire-77 — 2026-10-02 (converge; SSRF push-gate promote + over-limit Upgrade CTA + discovery)
Lease fire-77-convergence. Weight: security + money-path product + discovery (no new arch/UX pass).

SHIPPED (main + prod):
- Security + loop-improvement — `16b05c6cc` — PROMOTED `check-safe-fetch-redirect.mjs` + `check-dead-toggle-state.mjs` from soft-info to BLOCKING push gates in `feature-architecture.yml`; migrated 3 un-`safeFetch`'d `redirect:'follow'` sites (lead_enrichment x2, domains RDAP) + annotated system_status first-party `// safe-fetch-ok`. tsc + 33 units green; touched-suite 373/373.
- Money-path product — `4457d93d6` — over-limit site-create (403 `BUILD_LIMIT_REACHED`) now renders an action-armed "Upgrade" toast -> `/admin/billing` instead of a dead generic toast (embarrassingly-easy + action-button-must-gate-on-server-precondition). TDD RED (`Expected undefined to be 'Upgrade'`) -> GREEN (`create.component.spec` 19/19).
- Doc — `check-safe-fetch-redirect.mjs` header soft-info -> blocking-gate (adversarial-reviewer Rec, shipped inline).

DEPLOY + PROD-VERIFY:
- Worker Version `fc784a1d-acef-4f00-b7d0-c9d34e9da9bf` (startup 138ms; transient DNS blip on first attempt, retried green). Prod: homepage 200 - /api/health ok (kv+r2) - HSTS+CSP intact - /api/domains/search 200 (RDAP safeFetch path live, not 500).
- Frontend R2 300/300; /create 200 + new bundle (`chunk-C7LTKA34.js`). CTA logic unit-proven; live over-limit render needs an at-cap org (verification boundary).

ADVERSARIAL REVIEW (Opus security-reviewer): PASS — safeFetch re-validates every redirect hop; `// safe-fetch-ok` genuinely first-party (test fetchImpl can't leak to prod); CTA exact-matches code + preserves generic path + authed route + dismissable sticky toast; no flag-on / IDOR / swallowed-error / lying-empty.

FAN-OUT ATTRITION (salvaged + re-queued, loop kept running):
- R-B money-path golden journey (test-writer) DIED — "Stream idle timeout", subagent_tokens:0 after 29 tool_uses; wrote nothing to disk -> nothing to salvage. Money-path LONG journey + fire-72 editor-crash LIVE re-confirm RE-QUEUED.
- R-C Deep UI Explorer (role 17) MIS-ASSIGNED to `visual-qa` (no Write tool -> recon only) — recurrence of memory `r17W`. RE-QUEUED with `test-writer`.

STALE CARRIED FINDINGS re-confirmed + archived (discipline paid off): build_metrics card self-hides on 404 (already flag-gated); editor `frame-ancestors` serves correct scoped value live.

LOOP-IMPROVEMENT (section 7): promoted SSRF + dead-toggle detectors to BLOCKING push gates (audit-arc "Promote" rung) — both classes now regression-locked in CI.
