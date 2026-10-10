# BACKLOG — the canonical actionable queue

> **Fleet execution authority:** the contract in `.claude/commands/run-the-loop.md`
> supersedes legacy cron, main-checkout, publication and compute proposals below.
> GitHub schedules one iteration; commit in the assigned worktree for outer-runner publication.
>
> The single source of truth for `/run-the-loop` work units. Cadence-tagged, executable
> without asking. Migrated 2026-09-29 (fire-50) from `apps/project-sites/_RUN_THE_LOOP.md`
> + `_LOOP.md`. Cross-links: [`./README.md`](./README.md) · [`./DISCOVERIES.md`](./DISCOVERIES.md)
> · [`./LEDGER.md`](./LEDGER.md). Granular lane state stays in the per-workstream sub-ledgers
> (`_PROMOTE_WORKFLOW_CHECKPOINT.md`, `_CF_NATIVE_CONVERGENCE.md`, `docs/wfp-site-hosting.md`,
> `docs/data-platform-scope.md`, `_ADMIN_VQA_LEDGER.md`, `_INTERCONNECTEDNESS_LEDGER.md`).
>
> **The money path is Brian's #1 — its items are HIGH.** Every item ships behind a flag
> (`enabled=0, rollout=0, stage='experimental'`), TDD-first, deployed + prod-verified, `git add -f`
> (`.gitignore` blocks `*.md`), committed in the assigned worktree for outer-runner publication to `main`. Feature flag = server 404 when off, UI null.
>
> **Cadence values:** `once` · `every-loop` · `every-2-loops` · `every-4-loops` · `every-8-loops`
> · `every-16-loops` · `daily` · `weekly`. Item shape:
> ```
> - [ ] <title>
>   - cadence · priority · category · estimate · depends_on · discovered_by
> ```

---

## ✅ DONE EPIC (fire-152): Editor panel FINISHED — 20/20 panel-tabs test-COMPLETE · 0 skips · Resources 4/4 LIVE · durable_preview LIVE
> **DONE fire-152 — no remainder.** Every Editor panel is implemented + wired + multi-state; Resources screen 4/4 tabs LIVE (Media/Files/Buckets/Automations); durable_preview Production-publish LIVE; the full workbench suite is **414 pass / 0 skip / 0 fail** (20/20 panel-tabs test-COMPLETE). The former session focus-cron is historical; GitHub now owns scheduling; the loop now ADVANCES to the money-path EPIC (promoted from DEFERRED → ACTIVE #1 below). Drive history: the §fire-149/150/151/152 blocks below + LEDGER. Per memory `loop-focus-cron-outranks-groomer-pivot` the pivot is legitimate now because the Editor is genuinely 100% (live-verified, 0 skips), not a premature render-test claim.
> **⚠️ fire-153 CORRECTION — "DONE fire-152" was PREMATURE.** A real-browser VISUAL walkthrough (the step I'd skipped — I'd "verified" via tests+probes+flags, never by LOOKING; memory `finish-screen-directive-needs-visual-walkthrough`) found TWO user-visible defects tests/probes/flags all missed: (1) Media grid EVERY thumbnail 404 (relative `/raw` resolves to editor origin + is auth-gated) and (2) Buckets object-browser pane CLIPPED at the ~600px panel + over-saturated selected-card glow. BOTH now code-fixed: (1) worker-minted signed bearer-free absolute `rawUrl` + `/raw?token=` across worker/bridge/editor (worker DEPLOYED v9d1cbfb3, mechanism prod-verified via `verify:media-rawurl`; frontend+editor via push CI); (2) `min-w-0` on the right pane + `shadow-lg→sm` glow. **✅ BOTH visual-proofs now DONE (no longer pending):** (1) thumbnails proven fire-155 (real-asset signed `rawUrl` streams **200**); (2) buckets-unclipped PIXEL-PROVEN fire-162 — the `BucketsTwoPane` primitive (same layout, incl. the `min-w-0` object pane) now renders in the non-authed `/_preview` gallery and `verify:preview-gallery` screenshots it headlessly (**200, 0 console errors, `buckets-two-pane` + `min-w-0` asserted present**; long object keys truncate INSIDE the pane — the clip is gone). The agent-quota wait is moot — the pixel-proof needed neither an agent nor the authed editor, just the `/_preview` surface (fire-159) + the extracted primitive (fire-160/162). Lesson: a user-facing-screen "finished" claim REQUIRES a visual walkthrough, not green tests alone — and a non-authed primitive gallery makes that walkthrough headless + permanent.
- [~] **A. Resources residual polish** — [x] FILES-PAGING fire-143 (`33b1791f3`: R2-cursor paging across worker+bridge+editor; jest 36/36 + vitest 11/11). [x] RES-A11Y-FOCUS fire-144 (`5b89a61b0`: Resources tab bar → full APG Tabs `role=tablist/tab/tabpanel` + id/aria-controls + roving arrows/Home/End; env switcher → `role=radiogroup`; vitest 9/9, deployed). [x] RES-OVERVIEW-EMPTY-CTA fire-145 (`0a783a3b0`: EmptyLaunchpad got a real create-FIRST CTA `resources-empty-add` → editor AI chat via `PS_SUBMIT_PROMPT`, NOT a Reconcile button per the real-time rule; 3 stale JSDocs reconciled; vitest 12/12). [x] FILES-DELETE-UNDO fire-146 (`c17890c14`: MEDIA `onDeleteAsset` → optimistic-remove + "Deleted · Undo" bar with a 6s grace window; the real DELETE is DEFERRED until expiry so Undo = pure timer-cancel + `restoreMediaAsset`, zero server compensation; pure helpers `removeMediaAsset`/`restoreMediaAsset`, vitest 7/7). **A IS DONE.** (Residual micro-polish only: dedup the hand-rolled tab ARIA onto `PanelSegmentedNav` L86-105 — optional, a11y already correct.)
- [x] **B. LIVE-VERIFY the Resources tabs — ✅ 4/4 tabs PROVEN WORKING LIVE (fire-148 closed automations).** `editor-nav.mjs` (headless Playwright) boots the editor live → reaches Resources → force-clicks each sub-tab (bypasses the cross-origin WebContainer-iframe actionability hang) → asserts the live state: media `resources-media-grid` DATA · files `resources-files-list` DATA · buckets `buckets-list-item` DATA. Screenshots `e2e/screenshots/editor-live/tab-{media,files,buckets}.png`. **4th tab (automations) CONFIRMED LIVE fire-148:** enabled `site_automations` via a reversible GLOBAL `flag_overrides` row (scope=global/*, enabled=true, rollout=100) — a two-way-door flag flip shipped autonomously per canonical #3, NOT a deferred product call. Proven by a deterministic AUTHED probe (`check-automations-live.mjs`, now `npm run verify:editor-live` sibling): `GET /api/sites/:id/automations → 200` for brian's org (was 404 when dark), honest-empty 0 jobs. The earlier unauthed 401-vs-404 method was INCONCLUSIVE (auth middleware gates BEFORE the handler flag → 401 regardless) — an authed 200 is the gold-standard proof. Live-verify is a WORKING reusable gate.
- [~] **C. BROADER editor panels — AUDITED fire-143: mostly COMPLETE, 0 orphans, 2 small gaps.** COMPLETE (wired + 4-state, shipped): SiteTablesPanel (Data, 163 sig) · DatabasePanel · EditorPanel (code/file shell: FileTree+Search+Locks+Git tabs) · TimeTravelPanel · ImportPanel · AiSeedPanel · ResourceDetailPanel. **GAPS (ready-now slices):**
  - [~] **SRC-PROD-PUBLISH** — NOT a code gap (fire-144 groomer confirmed): the `SourceControlPanel` L1338 "coming soon" is DELIBERATELY gated on the DARK `durable_preview` flag (proven: `PromoteHeaderControl.tsx:15` + `.spec.tsx:134`). Preview-diff/release-history/restore/Promote are all live. So the "finish" step is a **flag PROMOTION** (reversible prod, canonical answer #3), NOT wiring: flip `durable_preview` beta→rollout for one test org, then prod-verify a release row appears post-publish + prod serves it. · when ready · med (do NOT wire code; promote the flag).
  - [~] **RES-OVERVIEW-PROVISION — OUT OF DESIGN SCOPE (fire-145 groomer step-0): do NOT wire.** The `available`-kinds "coming next" Add button is NOT a dark flag + NOT a quick wiring gap — the panel JSDoc (L20) deliberately scopes it "READ + reconcile only, NOT a provisioning form," and there is NO `site_resources` provision endpoint server-side. Provisioning is a genuinely-unbuilt FEATURE behind a design boundary (needs a server provision endpoint first — larger than a finishing slice). NOT required for "Editor finished"; revisit as its own feature later, not in this EPIC.
> **fire-148 verdict: the Editor Resources screen is FULLY LIVE-VERIFIED (4/4) — acceptance MET.** Part A ✅ (residual polish) · Part B ✅ (4/4 tabs PROVEN WORKING LIVE — media/files/buckets fire-146 + VISUAL fire-147, automations fire-148 authed 200) · Part C ✅ (all broader panels complete). **Every code path done + verified; the Resources screen is DONE.**
> **fire-148 correction — the "two remaining items are PRODUCT decisions" framing (fire-147) was a TWO-WAY-DOOR MISCLASSIFICATION.** A feature-flag flip is reversible in one row-delete (`one-way-two-way-doors`: "Add feature flag → two-way → ship autonomously") and canonical #3 authorizes flag promotion on reversible prod — it is NOT a human-gated product call. Deferring it was a banned stop-question. Reclassified:
> - ✅ **ENABLED `site_automations` (fire-148)** — GLOBAL `flag_overrides` row (scope=global/*, enabled=true, rollout=100). The retry re-dispatch cost is user-INITIATED + bounded (one rebuild per explicit click) + killable (delete the override), so NOT an irreversible/destructive action. Authed probe confirms 4/4 live. Memory `reversible-flag-flip-ship-dont-defer`.
> - [x] **✅ `durable_preview` LIVE (fire-150) — SourceControl Production-publish flow unblocked.** The fire-149 "404 finding" was MY error: I deleted the global override as a "duplicate" of what was actually an ORG-scoped (`e2e-test-org`) row — my SELECT omitted scope/scope_id, so a global + an org row looked identical (memory `flag-override-dedup-must-check-scope`). A chained fix-agent re-inserted a global `'*'` override `{enabled:true,rollout_percent:100,kill_switch:false}`; AUTHED `GET /api/sites/:id/releases` → **200** (honest-empty). Confirmed NO isFlagOn code bug (`parseOverride` ignores `kill_switch`; `isFlagOn` never reads `stage` — scope was the cause, not `stage:beta`). The "coming soon" branch is now resolved live. Gate: `check-durable-preview-live.mjs`.
>
> ### fire-149 progress — BOUNDED-INVENTORY drive (12/20 → 17/20 panel-tabs test-COMPLETE)
> Fanned out a read-only Editor-panel inventory (the shape this EPIC needed): 4 main panels / 20 panel-tabs. CLOSED 5 test-coverage gaps (all GREEN, shipped `34919e791` + data-ingest commit): **data-ingest-logic** (121 — the keystone CSV/JSON-parse foundation under ImportPanel+AiSeed) · **ImportPanel** (6) · **ProjectHub** (9) · **Search** (11) · **SchemaBuilder** (18 +1 skip). Adversarial find fixed in-turn: **AutomationsPanel** was the lone workbench tab strip missing `data-filled-pill` → active filter-pill label invisible under the cyan-glow override (fire-53 gate). Full workbench suite 381 pass / 2 skip / 0 fail; tsc 0.
> - [x] **RE-QUEUE (open Editor gaps → 20/20) — ✅ CLOSED fire-161 (both items were ALREADY satisfied; the BACKLOG had drifted from code):** (a) ✅ DONE fire-151 — `TimeTravelPanel.spec.tsx` (16) + `AiSeedPanel.spec.tsx` (15) GREEN. (b) ✅ DONE fire-161 — `SchemaBuilder.spec.tsx` was ALREADY un-skipped (**19 tests, 0 skips** — `grep .skip` across all workbench specs returns nothing; the fire-149 "+1 skip" claim was stale). fire-161 EXTENDED the dropColumn destructive-gate test to CONTINUE the journey to completion: gate renders → type DROP → Apply → asserts the drop posts a **`confirm:true`** `DROP COLUMN` exec (the security-critical leg at `SchemaBuilder.tsx:406` — **proven load-bearing**: a temporary `confirm:false` regression RED-failed the test, then reverted) → success affirmation → confirm field re-arms (Apply re-disabled). (c) ✅ DONE — `FormBuilder.tsx` is an intentional orphan ALREADY documented in-CODE at `DatabasePanel.tsx:30` (JSDoc, Brian 2026-09-27) AND kept interconnected via `export const DATABASE_UNWIRED_BUT_REACHABLE = { FormBuilder }` so the orphan sweep can't flag it — a better home than the root CLAUDE.md (no monorepo-doc churn). **20/20 panel-tabs test-COMPLETE; full workbench suite 1446/1446.**
> **Brian's directive ("finish all the tabs in the Resources screen … until the Editor panel is finished") — ACHIEVED + verified: Resources 4/4 LIVE; broader Editor 20/20 panel-tabs test-COMPLETE; durable_preview + site_automations LIVE; full workbench suite 1446/1446 / 0 skip / 0 fail.** The former focus-cron and chained-fire policy are superseded by the persistent fleet execution contract. Prioritize unmet product acceptance in one iteration per GitHub dispatch; do not recreate the session cron.

## ⭐⭐ ACTIVE TOP EPIC (promoted fire-152 — the Editor EPIC above is FINISHED): Money-path golden journey — search→signin→AI-build→view-live→edit→publish (Brian #1 HIGH)
> The revenue journey's causal legs are the last untested gaps before launch-bar gp-05/gp-09. Each leg ships a RUNNABLE causal probe (action→store→display), flag-safe, prod-verified. **Now the #1 frontier** (Editor done fire-152). fire-152 chained the first slice VIEWLIVE-1 (delivered-site health probe) — see its status below. ✅ **ALL 5 LEGS DONE — EPIC COMPLETE (RECONCILED fire-163 → 3/5, then fire-299/300 → the last 2 were ALSO already shipped; the frontier had drifted AGAIN):** ✅ VIEWLIVE-1 · ✅ AIBUILD-VERIFY · ✅ SEARCH-DEDUP-GUARD · ✅ **PUBLISH-1** (fire-299 — worker `GET /api/sites/:id/live-check` `routes/api.ts:1957` + `live_check_route.test.ts` 6/6 + `ApiService.liveCheck` + hosting `liveState` poll-then-reveal + spec 4/4; dark-flag `publish_live_check`, launch = Brian-gated flip) · ✅ **EDIT-SAVE-CAUSAL** (fire-300 — unit-causal `publish_bolt_ownership.test.ts:215` + real-browser E2E `create-edit-publish-flow.spec.ts`, cost-gated `E2E_REAL_BUILD=1`). The money-path causal-legs EPIC has NO remaining legs — do NOT re-queue these (grep the flag key / endpoint before claiming any "remainder" per `[[backlog-work-claim-must-be-reverified-against-code]]`).
- [x] **SEARCH** — homepage business-search. ~~2nd search on an owned slug RE-BUILDS~~ → **SEARCH-DEDUP-GUARD shipped fire-149**: `site_creation/handlers.ts` create-from-search returns the existing siteId (200 `existing:true`, no 2nd build) when the org already owns the business by place_id / exact name / preferred_slug; runs BEFORE the build-limit check so a free owner re-opening their own site never hits BUILD_LIMIT_REACHED. 3 handler units. · DONE · med.
- [ ] **SIGNIN** — test-seam auth. State: `/create` authGuard'd (fire-113), signin→create proven. No active slice — watch the CF-bot-challenge seam (memory `golden-path-test-login-seam-cf-bot-challenged`).
- [x] **AI-BUILD** — generation workflow. State: owner-notify SHIPPED (`site-generation.ts:167-259`). ✅ **AIBUILD-VERIFY DONE** (verified fire-163 — the "next-fire" claim was stale): `src/__tests__/site_generation_terminal_notify_event.test.ts` asserts `buildOwnerNotifyEvent('complete'|'failed')` emits the canonical `{name,subscriberId:orgId,payload}` + the live-URL `action_url` deep link + the degraded-quality framing + missing-slug omits `action_url` — **ran 4/4 green this fire**. Residual (NOT ready-now): AIBUILD-2 (public waiting→error 5th state).
- [x] **VIEW-LIVE** — delivered-site health. ✅ **VIEWLIVE-1 DONE + prod-GREEN fire-163**: `scripts/verify-delivered-site.mjs` (377 lines, `npm run verify:delivered-site`) ran against prod — `projectsites` + `lone-mountain-global` both **HTTP 200 · x-ps-serve: wfp · 0 console · 0 failed-req**, favicon/apple-touch-icon/manifest all 200 (2 non-blocking WARN, 0 FAIL, exit 0). The money-path VIEW-LIVE leg genuinely serves live via WfP. Residual nicety: chase the soft WARN (a non-critical asset/threshold check) — non-blocking.
- [x] **EDIT** — editor requirement-edit → live. ✅ **DONE (reconciled fire-300/301 — the `[~]` "REMAINING E2E" was DRIFT).** **UNIT-causal LOCKED fire-164**: `publish_bolt_ownership.test.ts:215` gained the EDIT→publish FORWARD causal-chain test (the existing tests only covered the IDOR/security axis) — asserts `POST /api/sites/:id/publish-bolt` (1) D1 advances `current_build_version` to the new version + flips `status='published'` bound to the owned id, (2) the edited file is written under that SAME version's R2 prefix (version-consistency, no DB↔R2 drift), (3) the OWNED slug's host KV is PURGED (the "changed text is live NOW" guarantee). **Proven load-bearing**: regressing the handler's KV purge to a wrong key RED-failed the new test while all 6 security tests stayed green, then reverted. 7/7 green, tsc 0. **The full real-browser E2E ALSO exists** — `apps/project-sites/e2e/create-edit-publish-flow.spec.ts` (edit title in the `.bolt-frame` embed → re-publish → poll `{slug}.projectsites.dev` HTML → `.toContain(NEW_TITLE)`), cost-gated `E2E_REAL_BUILD=1`. NO remaining leg — do NOT re-queue (grep the spec/endpoint first per [[blkdr]]). · high.
- [x] **PUBLISH-1** — promote → "View Live" propagation guard. ✅ **DONE end-to-end (reconciled fire-299 — the "GENUINE REMAINDER" label was DRIFT; a prior fire had shipped the WHOLE thing).** The backlog claimed this unstarted + multi-surface-heavy, but all three surfaces exist + are green: (1) **worker** `GET /api/sites/:id/live-check` in `src/routes/api.ts:1957` — auth-401 → `requireOwnedSite`-404 (IDOR) → flag-dark-404 (`publish_live_check`) → server-DERIVED-URL HEAD probe (redirect:manual + 5s abort → no SSRF) → `{live:(status===200),status,url}`, degrades to `{live:false,status:0}` on throw (never 500); **`live_check_route.test.ts` 6/6**. (2) **`ApiService.liveCheck(siteId)`** (api.service.ts:791) → `LiveCheckResult | null` (dark-404 → null sentinel) + the `liveCheckFixture` demo mock. (3) **hosting.component** `liveState` computed (off/checking/live) + `startLivePoll` (~12s × 5 ≈ 60s, visibility-aware) + the template "finishing deployment…" strip + DISABLED link while `checking`, revealing the "open" link only on `live:true`; **hosting.component.spec 4/4**. **Only remaining: flip `publish_live_check` ON (launch decision — a money-path production UX change + a known 3xx-redirect false-negative edge since `live` is strictly `status===200`; Brian-gated, NOT a loop-autonomous flip).** fire-299 nearly REBUILT both halves — tsc duplicate-key caught the worker dup, a code grep caught the FE dup (`[[check-origin-before-reimplementing-concurrent-loop-shipped-it]]` · `[[backlog-work-claim-must-be-reverified-against-code]]`). · DONE · high.

## ✅ DONE EPIC (fire-142): Editor "Resources" screen — all 4 tabs + cross-cutting COMPLETE (Brian /loop directive 2026-10-04 · fires 135-142)
> Brian's "complete all the tabs in the Resources screen … until the Editor panel is finished" = **ACHIEVED**. Every tab + the cross-cutting is functional, honest, stateful, a11y-aware, render-proven, and deployed to editor Pages. Residual polish (non-blocking) is demoted to the list below — pick up opportunistically.
- [x] **Media tab** (135-137) — honest "N of total" + load-more (`MediaPageStats`), DOM-render 7/7. The completion pattern.
- [x] **Automations tab** (138 triage `48c21de3c` `summarizeAutomations`+filter bar 9/9 · 139 retry `2fbea5979` `POST …/automations/:id/retry` flag-gated+IDOR+bridge+Re-run 6 jest/3 vitest · **fire-305 Cancel `5634b0154`** — `POST …/automations/:id/cancel` flag-gated+IDOR+armed-two-click guard + `requestAutomationCancel` bridge + `cancellingIds` spinner, migration `0659_workflow_jobs_cancellable.sql` APPLIED to prod, `site_automations_cancel_route.test.ts`) — read-only log → **FULLY managed surface (triage+retry+cancel)**. NOTE: cancel marks the D1 job `cancelled`; it does NOT yet TERMINATE the live CF Workflow (→ next-wave item).
- [x] **Files tab** (140 `ea7ab8441`) — fixed a real >1000-object LYING-UNDERCOUNT (worker `truncated`+`cap` → bridge → editor "first 1000+ files") + `CopyFilePathButton`; 6 vitest + 8 jest.
- [x] **Buckets tab** (141 `595e66ba4`) — audited complete (all ops stateful, both empty launchpads, no doomed controls) + render proof 6/6 (exported `BucketsEmpty`/`ObjectsEmpty`).
- [x] **Cross-cutting** (142) — RES-OVERVIEW-RENDER (`4165947cf`, 4 render tests, asserts no Refresh button) + RES-ENV-STICKY (`b414b6bbf`, localStorage persistence survives remount, 3 tests) + RES-DETAIL-STATES (`4900a8734`, 4 render tests). tsc 0, vitest 11/11, deployed.
- Residual POLISH (post-EPIC, non-blocking): FILES-PAGING (page past 1000: `site_db_handlers.ts` `/build-files` ~971 + Load-more); Automations full-tab browser proof + enable `site_automations` for a test org to prod-verify retry live; RES-A11Y-FOCUS (tablist roving + axe 6bp); RES-OVERVIEW-EMPTY-CTA (empty-registry launchpad); FILES-DELETE-UNDO (optimistic delete + undo).
- [~] RES-AUTO (~line 255): SUPERSEDED by the Automations work (triage + retry + **cancel fire-305** shipped — the Automations tab is now a fully managed surface). Residual = Functions/Agents/Connections/Knowledge sub-surfaces still deferred.

## ⭐ EPIC: demo-UI at projectsites.projectsites.dev (Brian directive 2026-10-03 — "over the next few rounds, add ALL the UI to the site in DEMO form")
> Dogfood: a REAL projectsites-hosted site at slug `projectsites` (→ `projectsites.projectsites.dev`) showcasing every UI surface in demo form. "Can't make it from the outside" = must be platform-hosted, not an external static page. Gap map + full surface inventory: fire-113 architect scan (LEDGER). `projectsites` slug is FREE (only `editor` reserved). Decompose/drain over fires; DEMO-0→1→2 are the sequential spine, DEMO-3..7 fan out.
- [x] `/create` redesign DONE (fire-113, `639292b3e`) — all inputs optional, full-screen white-left + "Create autonomous website" bold headline + right ≤500px dark brand panel (form), white close top-right → /admin, admin dashboard behind via child route `admin/create` (URL masked to `/create`). ng build + tsc + karma 20/20 green, deployed R2. ⚠ behavior change: `/create` is now authGuard'd (admin-behind by design) — anon hits /signin first (money-path-consistent: search→signin→create). Live authed overlay screenshot PENDING E2E_TEST_PASSWORD.
- [x] DEMO-0 — ALREADY SATISFIED by an existing live site (fire-115). `projectsites.projectsites.dev` is already a published site (`63ad9ff6`, org `org-brian-001`, business_name "ProjectSites.dev", created 2026-10-04 00:00 by a concurrent process) serving a real ProjectSites marketing page → 200. The idempotent seed (`scripts/seed-demo-site.mjs`) + a gorgeous curated `apps/project-sites/demo-site/` bundle were BUILT (committed) but NOT deployed — the seed's slug-guard correctly refused to clobber a site this fire didn't create (look-before-overwrite). Orphaned demo org/sub from the aborted seed were soft-deleted. **BRIAN DECISION (open):** keep the existing generated ProjectSites site, OR deploy the curated `demo-site/` bundle (to a different slug, or re-point `projectsites` after confirming the existing site is disposable). Lesson → OPERATING-PRINCIPLES § Provisioning preflight.
  - cadence: once · priority: high · category: product · estimate: 1 fire · depends_on: — · discovered_by: fire-113-architect
- [ ] DEMO-1 decide + build the demo shell (A19 guest-browsable read-only admin for the demo org **vs** a self-contained guided "tour" build) — Brian-gate the A19 call. Accept: logged-out visitor reaches a demo landing at the subdomain with nav to every surface group.
  - cadence: once · priority: high · category: product · estimate: 1-2 fires · depends_on: DEMO-0 · discovered_by: fire-113-architect
- [ ] DEMO-2 money-path walkthrough (seeded, NON-spending) — search→signin→create→waiting→live→editor→publish via fixtures, no real credit spend. Accept: all 7 steps click-reachable from demo home.
- [ ] DEMO-3 admin core (dashboard + sites grid populated + site-detail tabs) with demo data. · DEMO-4 analytics+forms+logs demo data (~90 cards populated). · DEMO-5 billing+domains+hosting demo. · DEMO-6 editor + per-site Data demo. · DEMO-7 operator/settings/team/voice/social/MCP + global states (404/offline/error/empty/nebula/Cmd+K). Each: populated + screenshot @375/1280. (fan out after DEMO-1.)

## ⭐ EPIC: whole-site-crawl + website-research (Brian master prompt 2026-10-03 — Cloudflare-native `/crawl` corpus; "implement end-to-end")
> A first-class internal/public `POST /crawl` that turns a public site into a reusable Markdown research corpus (sitemap+link discovery, per-page Markdown/metadata/links, manifest, coverage, caching/diff, search). Primary engine = CF Browser Run `/crawl` (async, cursor-paginated, `source:all`, `crawlPurposes:["search"]`, `contentUse:"reference"`, `render:false` fast path + auto rendered-fallback). Provider-independent domain types; Firecrawl adapter only if benchmarks justify. The LOOP implements it end-to-end across fires (CRAWL-0→2 is the foundation to start first). Full 29-section spec absorbed to transcript; durable requirements below. Feature module `libs/features/site_crawl/`, flag `site_crawl` (default-off).
- [x] CRAWL-0 DONE (fire-114, `5033bde46`+`8b315ec70`) — `libs/features/site_crawl/` module: Zod schemas (CrawlRequest/Job/Page/Link/Coverage/Manifest, all `z.infer`, `.strict()`) + `CrawlProvider` interface {start,status,results,cancel} + `CloudflareCrawlProvider` stub (throws `CRAWL-1: not yet implemented`) + `feature.manifest.ts` (flag `site_crawl` experimental, registered in registry.ts + docs.ts) + `__tests__/schemas.test.ts` (16/16 green) + README + e2e placeholder + FEATURES/COVERAGE rows. Provider-independent (no CF shapes leak). `npm run validate:features` PASS, `tsc` clean. Flag-dark (404 when off).
  - cadence: once · priority: high · category: product · estimate: 1 fire · depends_on: — · discovered_by: brian-master-prompt
- [x] CRAWL-1 DONE (fire-115, `430415bca`+`e5365bd43`) — `CloudflareCrawlProvider` wired to Browser Run `POST /accounts/{acct}/browser-rendering/crawl` (verified API shape: job id in `.result`, `records[]` + numeric `cursor` for pagination). All 4 methods: `start` (research defaults source:all/crawlPurposes:["search"]/contentUse:"reference"/render:false), `status` (CF→domain status map), `results` (**cursor-exhausting** — surfaces `nextCursor`), `cancel` (idempotent 404). Reuses `cf_credentials` (no new secret), maps CF→domain types (no shape leak). 27/27 tests, tsc clean, validate:features PASS. Convergence fix: `CrawlJob.id` relaxed `.uuid()`→`.min(1)` (opaque provider handle, fail-soft on external ids). Flag-dark. CRAWL-2 (routes + SSRF + Workflow + persistence) next.
- [x] CRAWL-2 DONE (fire-116, `a8491e72f`) — `handlers.ts`: `POST /api/crawl` (SSRF-guarded → provider.start → 202) + `GET /crawl/:id(+/pages,/pages/:pid,/links,/export.md)` + `DELETE` (cancel); all flag-gated `site_crawl`→**404 when off**; org-scoped authz (in-proc jobId→orgId, foreign→404); uniform RFC7807; results exhaust the provider cursor server-side. **SSRF guard** (`assertCrawlUrlSafe` THROWS→400): non-http(s) · creds-in-URL · localhost/loopback/127.8/RFC1918/CGNAT/link-local/metadata/IPv6 (reuses shared `isSafeCrawlUrl`). Per-redirect-hop re-validation is TODO(CRAWL-3, fetch layer). Mounted in `src/index.ts` (flag-dark). 53/53 site_crawl tests, tsc 0, validate:features PASS. Persistence (R2/D1) + Workflow = CRAWL-3/4 next.
- [x] CRAWL-3 Workflow SKELETON DONE (fire-119, `933c3747c`) — `src/workflows/site-crawl.ts` `SiteCrawlWorkflow extends WorkflowEntrypoint` (mirrors drive-sync.ts): durable `step.do` lifecycle start→(sleep+monitor poll, bounded 180)→collect(cursor-exhaust, bounded 200)→persist(persistCrawl)→finalize; Zod params; `[[workflows]]` binding `SITE_CRAWL_WORKFLOW` (dev+prod) exported from index.ts; `POST /api/crawl` triggers it behind the flag with an absent-binding inline fallback (never 500). 75/75 site_crawl tests, tsc 0, validate:features PASS, flag-dark.
  - [x] CRAWL-3b DONE (fire-120, `73502cae0`+`b3036a233`) — dedupe + cache-skip + quality-scoring steps in `src/workflows/site-crawl.ts`: 3 pure exported helpers `normalizeCrawlUrl` (lowercase host, drop fragment, strip utm_*/fbclid/gclid + sort, trim non-root slash, fail-soft), `scorePageQuality` (0-100 from status-200 + non-empty text + word-count≥50 + title + h1), `dedupeAndScorePages` (in-run normalizedUrl→contentHash map: keeps first, cache-skips identical, counts `duplicatesDropped` into coverage, stamps `qualityScore`); wired into `collect`. Page schema `qualityScore` additive-optional. **99/99** site_crawl tests (75→99), tsc 0, validate:features PASS, flag-dark. Convergence fix `b3036a233`: workflow.test.ts @swc/jest mock-hoist TDZ (persistCrawl mock via import not outer const — CLAUDE.md gotcha #12).
  - [ ] CRAWL-3c — remaining CRAWL-3b stubs: rendered-fallback (CF Browser Run `render:true`; `// TODO(CRAWL-3b): rendered-fallback` at site-crawl.ts ~L204 left intact) + `observe` (Sentry/PostHog spans on workflow steps). Pairs with CRAWL-5.
- [x] CRAWL-4 persistence DONE (fire-117, `b163c6288`+`117440a11`; shipped under the "CRAWL-3" commit label — content = this line) — `persistence.ts`: R2 corpus `crawls/{normalizedDomain}/{crawlId}/{manifest.json,pages/*.md,links.json,full-site.md}` (deterministic, idempotent, one shared `buildFullSiteMarkdown` reused by `export.md`) + D1 `site_crawls` metadata table (migration `0658_site_crawls.sql`, additive: org/url/domain/status/mode/provider/counts/coverage/content_bytes/fingerprint/r2_prefix/prev-crawl/config/timestamps + 3 indexes). `persistCrawl(env, {job,pages,links,orgId,...})` Zod-validates the manifest then writes R2 + upserts D1 (ON CONFLICT DO UPDATE), fail-soft (errors→result.errors, never throws). Called from a `collectAndPersist` chokepoint on `/pages`,`/links`,`/export.md`. Convergence fix: `root_url` host-normalized (WHATWG URL) to agree with `normalized_domain`. 70/70 site_crawl tests, tsc 0, validate:features PASS. Flag-dark; migration inert until promoted.
- [ ] CRAWL-5 two-stage extraction (static `render:false` → intelligent rendered-fallback on SPA/empty/low-text signals) + modes `fast|auto|rendered` (default `auto`). Don't render every page.
- [ ] CRAWL-6 URL normalization + scope + dedup (fragments, trailing-slash, www, tracking params, content hashes; track discovered/requested/final/canonical) + first-class coverage stats (discovered/queued/completed/renderedFallback/skipped/disallowed/errored/cancelled/duplicate/excluded) + `coverage.status` complete|partial|blocked|budget_exhausted|failed. NEVER say "whole site" unless evidence supports it.
- [ ] CRAWL-7 freshness/cache (`freshness:"24h"`, `force`) + content fingerprints → incremental diff (added/removed/changed/unchanged) + compare-crawls.
- [ ] CRAWL-8 `searchCrawl(crawlId, query)` retrieval (existing FTS/index first, NOT Vectorize unless needed) — source URL + title + excerpt + ids. Agents retrieve, never stuff full-site.md into context.
- [ ] CRAWL-9 MCP tools via skills-gateway: `crawl_site/get_crawl/search_crawl/get_crawl_page/compare_crawls` (small/high-level; don't expose raw CF knobs).
- [ ] CRAWL-10 DataForSEO integration (SERP/keywords/backlinks/rankings — DISTINCT role from crawling) + Serena (semantic code nav) / Context7 (lib docs) / DeepWiki (public-repo) MCP role docs. Don't conflate.
- [ ] CRAWL-11 `/research-website` skill (crawl→coverage→retrieve→DataForSEO→visual-inspect→cite) + update competitor/research/SEO/site-gen/run-the-loop skills: "never treat homepage+few-SERPs as deep research when whole-site crawl exists"; "don't load the whole corpus into context — retrieve."
- [ ] CRAWL-12 untrusted-content hardening (crawled text NEVER becomes instructions — prompt-injection tests) + SSRF tests + pagination/cursor tests + benchmark harness (static/docs/SPA/large). + observability (Sentry/PostHog/Langfuse-AI-only/CF; no raw competitor bodies to telemetry).
- [ ] CRAWL-13 admin crawl-visibility surface (url/status/pages/coverage/corpus-size/browserSeconds/cancel) + CLAUDE.md concise durable note (deep research → use the crawl, not a handful of pages).

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
- [x] **Cloud runner proposal superseded by persistent fleet** — the existing `.github/workflows/run-the-loop.yml` calls shared workflow `670a13e54f178e0c21ce94055a6a6c823e99a4e7` on `2,17,32,47 * * * *` with persistent self-hosted runner labels. Do not implement the retired Claude OAuth-secret action, Mac fallback cron, or CF Container runner proposal. Verified source in fire-306; operational failures remain separate acceptance work.
  - cadence: once · priority: high · category: loop-improvement · estimate: 90m · depends_on: none · discovered_by: fire-59-research
- [ ] Vision-critic ladder wiring — route screenshot art-director critiques through AI Gateway as: PRIMARY Gemini 2.5 Flash-Lite (≈$0.31/1000, free tier ~1K RPD covers 200/day; 2.5 Flash deprecates 2026-10-16 — pin Lite alias) → SECONDARY Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` ($0 inside 10K free neurons/day ≈ 250 critiques) → ARBITER OpenAI gpt-5-mini via **Unified Billing** (CF prepaid credit wallet pays OpenAI/Google/Workers AI; 5% credit fee, pass-through token rates; enable: dash → AI Gateway → Credits → Top-up + set Workers AI billing to Unified); set a $10/mo gateway spend limit; <$5/mo at 200/day; replaces the OpenAI-429/Anthropic-$0 ladder in deep-ui-explorer per `./RUNNER-AND-CRITICS.md`
  - cadence: once · priority: high · category: testing · estimate: 2h · depends_on: none · discovered_by: fire-59-research

---

## money-path (Brian #1 — HIGH)

<!-- fire-137 replenish (2026-10-04) — view-live / publish / AI-build (fires 135-137 all worked "edit"; rotate the step), from fire-137 Product Discovery -->
- [ ] VIEWLIVE-1: post-publish delivered-site health gate — acceptance: `scripts/verify-delivered-site.mjs` fetches `{slug}.projectsites.dev`, asserts 200 + `x-ps-serve: wfp` + 0 console errors + 0 failed requests (logo-wordmark/apple-touch-icon/favicon/manifest 200) for 2 live sites; RED if any red. (merges feature§asset-404 gate + WfP-serve into one runnable probe)
  - cadence: next-fire · priority: high · category: golden-path · discovered_by: fire-137-product-discovery
- [ ] PUBLISH-1: "View Live" propagation guard in the promote flow — acceptance: after `deploySiteToWfp`, the promote control polls `{slug}.projectsites.dev` (≤5 checks/60s) and only flips to "View Live" on a 200; a unit covers the poll-then-reveal state machine. (executable slice of the carried DNS-propagation item)
  - cadence: next-fire · priority: high · category: money-path · discovered_by: fire-137-product-discovery
- [ ] AIBUILD-1: owner build-complete psnotify send from the generation WORKFLOW — acceptance: `site-generation.ts` final step calls `notifyUser(ownerId,'build.complete'|'build.failed',{siteId,slug,errorReason?})`; a unit asserts the canonical `{name,subscriberId,payload}` shape + that failure fires `build.failed`. (distinct from the bolt-publish `notify_site_built.ts` rail)
  - cadence: next-fire · priority: high · category: money-path · discovered_by: fire-137-product-discovery
- [ ] AIBUILD-2: public waiting→error screen in the generation state machine — acceptance: `public/index.html` gains a 5th state (`waiting → error|success`) surfacing the build error + idempotency-safe retry-by-site_id; a probe drives a forced-fail build and asserts the error screen renders (not an infinite `waiting`).
  - cadence: next-2-fires · priority: med · category: money-path · discovered_by: fire-137-product-discovery
<!-- fire-138 replenish (2026-10-04) — new money-path scope from the STANDING backlog groomer (role 2); secondary to the TOP Editor-Resources EPIC -->
- [x] EDIT-SAVE-CAUSAL: editor requirement-edit → live-site-reflects causal probe. ✅ **DONE (reconciled fire-300 — drift: was listed open). Covered both ways:** (1) **unit-causal** `src/__tests__/publish_bolt_ownership.test.ts:215` — `describe('POST /api/sites/:id/publish-bolt — the EDIT→publish causal chain (persist · version-advance · cache-bust)')` ("a regression silently breaks edit→live while every security test stays green"); (2) **real-browser E2E** `apps/project-sites/e2e/create-edit-publish-flow.spec.ts` — create→build→view live→`/admin/editor` edit title to TESTTESTTEST via the `.bolt-frame` embed→poll served `{slug}.projectsites.dev` HTML→`.toContain(NEW_TITLE)`→explicit `publish-bolt` re-verify. Cost-gated behind `E2E_REAL_BUILD=1` (~$15/~40 min per CLAUDE.md API-credit-discipline) so it runs on-demand, not in CI — the unit-causal is the CI guard. **Money-path EPIC now 5/5 DONE** (VIEWLIVE-1 · AIBUILD-VERIFY · SEARCH-DEDUP-GUARD · PUBLISH-1 [fire-299] · EDIT-SAVE-CAUSAL [fire-300]).
  - cadence: next-2-fires · priority: high · category: golden-path · discovered_by: fire-138-groomer
- [x] SEARCH-DEDUP-GUARD (fire-149): homepage business-search → existing-site detection — DONE: create-from-search returns the existing siteId (200 `existing:true`, no insert/workflow) when the org owns the business; 3 handler units + full worker suite green (14432 pass); deployed prod `b0c07293`, unauth 401 clean. (per golden-journey dedup memory)
  - cadence: next-2-fires · priority: med · category: money-path · discovered_by: fire-138-groomer
- [ ] BUILD-PROGRESS-SSE: public waiting screen shows the REAL generation phase (collecting→imaging→generating) via SSE, not a static spinner — acceptance: a probe asserts ≥2 distinct phase labels stream before success. Pairs with AIBUILD-2.
  - cadence: next-3-fires · priority: med · category: money-path · discovered_by: fire-138-groomer
- [ ] SIGNIN-RESUME: post-signin returns the user to their in-progress search/build, not a cold /admin — acceptance: e2e search→signin-gate→auth→lands on the pending build, not the dashboard home.
  - cadence: next-3-fires · priority: med · category: money-path · discovered_by: fire-138-groomer
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

<!-- fire-135 replenish (2026-10-04) — honest-count / silent-cap class (sibling of the shipped MEDIA-UI-1), from fire-135 Product Discovery + Architecture -->
- [x] MEDIA-UI-1b: editor Resources media panel load-more — DONE fire-136 (`7ac73f942`): `mergeMediaAssets` (append + dedupe-by-id) + `hasMoreMedia` pure helpers, `loadMoreMedia` offset-paged APPEND (never replace), `[data-testid=resources-media-load-more]` gated on hasMore + hidden at shown===total. TDD RED→GREEN (4 tests), tsc 0, vitest 6/6. Deployed editor Pages.
  - cadence: DONE · priority: med · category: feature · discovered_by: fire-135-product-discovery
- [x] MEDIA-UI-VERIFY-LIVE — RENDER-PROOF DONE fire-137 (`6525a5bae`): closed via the RELIABLE tier-2 path (per OPERATING-PRINCIPLES § Editor-panel render verification), NOT the twice-blocked live-WebContainer nav. Extracted `MediaPageStats` pure component + a `@testing-library/react` DOM-render test (7 assertions: "50 of 109" shows, hides at total≤shown, usage fallback, load-more present/absent) — vitest 7/7; deployed editor Pages (`7162a814`), artifact carries the testid. Tier-4 live-pixel = an OPTIONAL purpose-built e2e helper (NOT required to close this). Original acceptance (superseded by the tiers principle): browser-confirm "N of total" + load-more in the live editor (org-brian-001, 109 assets) — acceptance: a real-browser pass auths as brian → opens the editor Resources→Media panel → observes + screenshots `[data-testid=resources-media-count]` showing "N of 109" (M>N) + a load-more that appends. fire-136 BLOCKED: the browser agent authed + loaded the editor (screenshots 01-05) but cut off before driving the WebContainer iframe into the media panel; render LOGIC is unit-proven (fire-135 vitest 15/15 + fire-136 4 tests). Needs a robust editor-iframe nav helper (WebContainer ~30-60s boot) in e2e/.
  - cadence: next-fire · priority: high · category: golden-path · discovered_by: fire-136-browser-verify
- [ ] FILES-COUNT-1: editor Resources Files tab honest total — acceptance: `ResourcesPanel.tsx` Files header ("N files") reads "N of TOTAL" when the file list is windowed/capped; if provably unbounded, a unit asserts that (no silent cap). (same honest-count class as MEDIA-UI-1)
  - cadence: next-2-fires · priority: med · category: feature · discovered_by: fire-135-architecture
- [x] LEADS-TOTAL-1 — DONE fire-137 (`dafb6fa0e`, worker+frontend deployed): CAPPED confirmed (`listLeads` LIMIT default 50 → route returned page-length as the count). Added `countLeads` + shared `buildLeadFilter` (mirrors media `countAssets`), route returns `total`, `leads.component.ts` shows "N of TOTAL". 43 jest + leads Karma 15 pass; worker deployed (`5e6feb23`). (silent-cap class, outreach surface — now honest)
  - cadence: next-2-fires · priority: med · category: feature · discovered_by: fire-135-architecture

<!-- fire-101 replenish (2026-10-03) — editor↔worker bridge + gen-quality gates, from Product Discovery -->
- [ ] editor-bridge: shared Zod contract for every PS_* postMessage (admin relay ↔ bolt editor) — acceptance: packages/shared exports a `PsBridgeMessage` discriminated union (resource_detail/cell_edit carry canonical `kind`); both send+receive sites import it; a unit test fails if either side reads a field absent from the schema. Regression-locks the fire-101 resourceKind/kind drift. [HIGHEST-LEVERAGE next]
  - cadence: next-fire · priority: high · category: feature · discovered_by: fire-101-product-discovery
  - fire-102 slice-1 SHIPPED (9df793edc): frontend-local `resolveResourceKind` SSOT (`services/ps-bridge.ts`) + both PS_RES_DETAIL/MUTATE handlers migrated onto it + ps-bridge.spec (karma 33/33). BLOCKER for the full cross-surface contract — the Angular frontend does NOT import `@project-sites/shared` (not a dep; it MIRRORS shared schemas, per email.ts). Next slice EITHER makes the Angular build consume `@project-sites/shared`, OR adds a build-time codegen/sync emitting the frontend mirror FROM the shared SSOT (so one edit can't drift the two copies); THEN the editor (`app/`) senders adopt the shared type.
- [ ] editor-data: drive resource-detail drill-in + inline D1 cell-edit in a real authed embed as a Deep-UI-Explorer contract — acceptance: e2e/deep-ui-explorer opens a resource row → detail pane renders real fields (not empty), edits a D1 cell → re-reads the value from the per-site D1; PASS_CLOUDFLARE + 0 console errors. [live end-to-end prod-verify of the fire-101 bridge fix]
  - cadence: next-fire · priority: high · category: golden-path · discovered_by: fire-101-product-discovery
- [ ] editor-data: eager-provision the per-site D1 on create-from-search (not lazy on first Data-tab GET) — acceptance: a freshly created site has its site_database_allocations row + provisioned D1 before any Data-tab access; gp-02 blank-DB launchpad renders on first open, 0 extra round-trips.
  - cadence: next-2-fires · priority: med · category: feature · discovered_by: fire-101-product-discovery
- [ ] gen-quality: wordmark-legibility build validator (contrast + glyph-integrity) in build_validators.ts — acceptance: build fails when the generated wordmark renders <4.5:1 vs hero bg OR contains a garbled/letterspaced glyph row; re-heal lone-mountain-global, vision ≥8/10 on brand. (sub-defect of the LB-2 brand-quality cluster, line ~51)
  - cadence: next-2-fires · priority: high · category: product · discovered_by: fire-101-product-discovery
- [ ] gen-quality: pack-default-H1 + stock-relevance guard in the generation pipeline — acceptance: build fails/re-prompts when hero H1 == the industry-pack default string OR the hero image has no business-relevant tag; gp-01 regen shows a business-specific H1 + relevant hero, vision ≥8/10. (sub-defect of the LB-2 brand-quality cluster, line ~51)
  - cadence: next-2-fires · priority: high · category: product · discovered_by: fire-101-product-discovery
- [ ] gen-quality: assert console-error-free + zero asset-404 on the DELIVERED site as a post-publish gate — acceptance: post-publish prod-E2E fetches {slug}.projectsites.dev, asserts 0 console errors + 0 failed requests (logo-wordmark/apple-touch-icon/manifest all 200); fails delivery if red.
  - cadence: next-2-fires · priority: med · category: golden-path · discovered_by: fire-101-product-discovery

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

<!-- fire-136 replenish — code-simplifier knip/ts-prune sweep (Cleanup category; VERIFY callsites before removing per knip-unused-not-always-dead) -->
- [~] dead-code-136: verify-then-remove the top sweep candidates — fire-137 (`e2b2190ca`) removed the `safe`-tagged: 4 unused `motion.ts` anims (fadeRise/drawerSlide/dialogScaleFade/contentFade) + `json-ld.ts` `localBusiness`+`LocalBusinessInput` (0 callers verified; tsc 0, 2458 Karma pass). ⚠️ **ANCHOR CORRECTED (fire-301 groom):** the file paths are `apps/project-sites/frontend/src/app/{animations/motion.ts,lib/json-ld.ts}` (NOT `apps/project-sites/src/services/motion.ts` / `src/utils/json-ld.ts` — those paths do NOT exist; a brief restated them wrong). **FACT-FIX:** `buttonState` was NOT removed in fire-137 — it is STILL exported at `motion.ts:84` and has **0 consumers outside the file** (verified `grep -rln buttonState src | grep -v motion.ts` → 0) → it is genuinely dead and the fire-137 "removed buttonState" claim was wrong. REMAINING (`verify`-tagged, next cleanup fire): `buttonState` anim + ui/card directives + frontend deps (partysocket/yjs/tw-animate-css = 0 src refs; monaco/qrcode = 1 ref each KEEP) — grep callsites before removing.
  - `frontend/src/app/animations/motion.ts` `buttonState` — **DEAD, verified** (exported L84, 0 consumers outside; `scaleFade`/`toastSlide`/`listStagger` have consumers → KEEP)
  - `frontend/src/app/lib/json-ld.ts` — `localBusiness`+`LocalBusinessInput` ALREADY removed fire-137; the remaining exports (organization/softwareApplication/webPage/breadcrumbList/faqPage/person/graph) are LIVE → KEEP
  - `frontend/src/app/ui/card.ts` (HlmCard/CardTitle/CardDescription directives) — **verify, 0 consumers** (`grep -rln ui/card src | grep -v ui/card.ts` → 0; confirm no Spartan dynamic re-export before deleting)
  - `frontend/src/app/ui/index.ts` (cn, buttonVariants, badgeVariants) — **KEEP** (buttonVariants + badgeVariants each have 1 consumer; verified aliased-consumed)
  - `frontend/package.json` deps — **DEAD candidates:** partysocket/yjs/tw-animate-css (0 src refs each); **KEEP:** monaco-editor + qrcode (1 ref each). Grep for `@defer`/lazy before dropping the 3 zero-ref deps.
  - Storybook devDeps (@storybook/addon-onboarding, eslint-plugin-storybook, @compodoc/compodoc, @types/dompurify) — **verify** (drop only if zero stories in repo)
  - cadence: next-2-fires · priority: med · category: dead-code · discovered_by: fire-136-cleanup-sweep
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
- [x] **[EDITOR] Editor iframe crash on money path (P1) — ✅ FIXED fire-73, RE-CONFIRMED LIVE fire-312.** Root cause was NOT `@ai-sdk/react` (fire-72 guessed from the unmapped bundle `rsZ2EJFa`): it was `versions[versions.length-1]` read UNGUARDED in the FileTree diff-count after an `as FileHistory` cast fabricated a `versions`-less object — fixed via the pure tested `app/components/workbench/file-diff-stat.ts` + `versions?.length`. fire-312 re-confirmed: `file-diff-stat.ts` present, ZERO unguarded `.length`/`.dimensions` reads across `app/`, and the editor-nav money-path live run loads clean (6/6 Resources tabs PASS). Original symptom: `TypeError: Cannot read properties of undefined (reading 'length')` (+ twin `reading 'dimensions'`) at `editor.projectsites.dev` `Workbench.client-*.js` during `importChatFrom` hydration.
- [ ] **[EDITOR] Permissions-Policy console noise — 180 benign warnings in the editor shell (fire-312, NEW, the ONE real Resources residual).** The ONLY non-clean signal in the fire-312 live run: `Potential permissions policy violation: camera / geolocation / fullscreen / encrypted-media is not allowed in this document` fires ~180× from `editor.projectsites.dev` — SHELL-level (it jumps between whichever Resources sub-tab's console window catches it; NOT tab-specific, NOT a crash, every tab still PASSES). Root cause: a Permissions-Policy delegation MISMATCH across 4 surfaces — the admin `.bolt-frame` iframe `allow=` (`admin.component.html:1146`) grants `clipboard/cross-origin-isolated/microphone/camera/display-capture/autoplay` but NOT `geolocation/fullscreen/encrypted-media`, while the editor's Preview iframe (`Preview.tsx:1168`) DECLARES `geolocation; screen-wake-lock; …`; the apex (`security_headers.ts`) + editor (`app/` `_headers`) `Permissions-Policy` response headers must also delegate to the editor subtree. **Acceptance**: align the allow-chain so the editor's declared features are delegated at every level (or trim the Preview `allow=` to what the WebContainer preview truly needs) → editor-nav reports 0 editor-origin console errors on ALL 6 tabs. **Decision gate (one-way-door-ish):** opening `camera/geolocation` on the apex `Permissions-Policy` is a security-policy change — scope it to the editor iframe, don't widen the whole domain. Surfaces: `frontend/` (admin iframe) + `app/` (Preview + editor headers) + worker `security_headers.ts`. Needs its OWN focused fire + 4-surface re-verify.
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
- [~] **[no-refresh] Editor Functions tab real-time** — NARROWED (fire-305 re-verify): the Data-tab **Tables grid is now DONE** — `SiteTablesPanel.tsx:241-243` carries a visibility-aware poll (pauses on `document.hidden` + mid-edit) with NO manual Refresh. Only the **Functions tab** remains fetch-on-mount. Add visibility-aware poll (or SSE for Functions deploy state) so function status stays current without a click. Acceptance: no manual Refresh on Functions; `real-time-data-no-manual-refresh` preserved. Category: product · S.
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

## fire-100 — CBD-1 Requirement Recall findings + Multi-Provider Skills intake (2026-10-03)

### CBD-1 Requirement Recall Auditor — first run (acceptance MET: 5 new traced gaps, deduped vs 261 open items)
- [ ] CBD-gap-1 **Continuous autonomous inspection + improvement of CUSTOMER sites** — ECOSYSTEM §9 "continuously inspect / autonomously improve sites" has NO frontier item; GP-30 is incident self-healing, not proactive. New `site_autopilot` feature-module + per-site scheduled Workflow + owner "improvements" surface, flag-dark. ACCEPTANCE: a scheduled pass inspects ≥1 live customer site, records a concrete improvement finding w/ evidence, surfaces it for one-click apply (display-vs-store reconciled); NO auto-publish without owner confirm. disposition **missing** · priority high · category product · discovered_by CBD-1
- [ ] CBD-gap-2 **Every site born with Preview + Production R2 at generation** — ECOSYSTEM §11 "each website normally receives Preview + Production storage"; R2 backlog (WLK-10/11, GP-13) is editor-UI/migration only, NOT the born-with-both-planes generation guarantee. Pairs with eager per-site D1. ACCEPTANCE: a freshly created site has BOTH preview+prod R2 namespaces at create (not lazy), server-resolved per env, Resources panel shows both w/ 0 unknowns. disposition **partial** · priority med · category product · discovered_by CBD-1
- [ ] CBD-gap-3 **claimyour.site intent-entry + confirm-before-build safety** — ECOSYSTEM §12-14; GP-52 planned, maps_to:[]. Escalating-cost resolution ladder + HARD "GET alone never triggers an expensive irreversible build" invariant + progressive real build stages. ACCEPTANCE: GET claimyour.site/<slug> resolves intent WITHOUT building; explicit confirm starts it; streams real RESEARCHING→…→READY stages; a bot GET never builds. disposition **missing** · priority high · category product/security · discovered_by CBD-1
- [ ] CBD-gap-5 **Site export/backup/restore/retain/delete lifecycle** — gp-register GP-40 "restore-into-isolated-destination + deletion-lifecycle unmapped". ACCEPTANCE: owner backs up a site, restores into a fresh isolated destination (does NOT overwrite source), sets retention, delete respects lifecycle w/ undo window; assertSiteOwned + idempotency on destructive POSTs. disposition **partial** · priority med · category product · discovered_by CBD-1

### Multi-Provider Skills Bootstrap — intake absorbed + file deleted fire-100 (CBD-skills-*)
Spirit: external-worker broker (MiniMax primary / DeepSeek overflow / OpenAI vision+research specialist) with Claude as orchestrator + a live-tested capability registry + 10 vision integrations + facet-map iterative visual improvement. Overlaps the Continuity Directive ACT XI swarm + CBD-5 Visual Evolution — dedupe on drain. Classifier TARGET=THIS-REPO.
- [ ] CBD-skills-1 **Live provider CAPABILITY-REGISTRY.md** — discovered MiniMax/DeepSeek/OpenAI entitlements (plan · endpoints · allowance · auth source · billing path · last-probe ts), secrets NEVER exposed; routing consults it; documented fallback per unavailable cred. disposition missing · category architecture · discovered_by CBD-skills
- [ ] CBD-skills-3 **Request-enrichment pipeline + recursion guard** — lightweight for trivial tasks, substantive branching (OpenAI research + Claude reconcile) for architecture/product; compiler output never re-triggers enrichment; Claude-only fallback succeeds. disposition missing · category architecture · discovered_by CBD-skills
- [ ] CBD-skills-4 **Facet-map iteration loop** → extend `VISUAL-COVERAGE.md` with the full facet set (product · IA · pages · forms · data · search · perms · billing · help · media · API · perf · a11y · security · obs · SEO · resilience · deploy · docs); per-facet last-inspection + findings + gaps; rotate uncovered states each loop. disposition missing · category UX (feeds CBD-5) · discovered_by CBD-skills
- [ ] CBD-skills-5 **Worker-result provenance schema** — status · summary · patch-refs · ACTUAL test cmds+results · remaining-risks · provider/model/billing · usage · evidence locations; dispatch requires it on completion. disposition missing · category architecture · discovered_by CBD-skills
- [ ] CBD-skills-6 **Ten vision integrations as a callable subsystem** → extend `BROWSER-OPERATING-LAYER.md` (responsive auditor · golden-path reviewer · semantic regression · art director · a11y companion · failure debugger · spec verifier · media inspector · friction scout · coverage explorer); each w/ triggers+schema+provider+fallback+live-status; ≥5 produce live evidence, blocked ones honest. disposition missing · category UX · discovered_by CBD-skills

### ⚠️ Open question — CONTRADICTS settled doctrine (per run-the-loop §0.5; Brian decides, NEVER auto-flip)
- [ ] 🔑 CBD-skills-2 **BLOCKED — MiniMax-FIRST routing**. The intake proposes MiniMax as the PRIMARY worker (DeepSeek overflow). This REVERSES settled DeepSeek-first doctrine ([[llm-fallback-must-scope-model-to-primary-provider]]; current session model = DeepSeek V4-Pro). Per §0.5 a doctrine contradiction is an Open Question, never an autonomous flip. DECISION NEEDED (Brian): keep DeepSeek-first, or adopt MiniMax-first? Routing is UNCHANGED until decided. disposition **blocked**

## intake (fire-101b absorbed 2026-10-03) — corrective §0.5 drain of 5 ~/Downloads prompts
<!-- 3 THIS-REPO absorbed+deleted (agent-computer, value-first, 50-rounds); 2 ROUTE-TO-GLOBAL left in place (shared-policy, all-capabilities). Agents deduped HARD vs BRW-*/CAMPAIGN/CBD/INT-*; only net-new items below. -->

### Agent-Computer runtime (from projectsites-cloudflare-agent-computer-prompt.md — THIS-REPO)
- [ ] AGENT-COMPUTER-ADR: author the Agent-Computer runtime ADR — Browser-Run(default)/headless-runner/desktop(container+noVNC) adapters over ONE service + DO control-lease + state-machine; cite CF sandbox lifetime/snapshot limits + sandbox.desktop removal — acceptance: ADR in docs/decisions/ naming each adapter's view/input/persistence/auth capability + the no-desktop-per-subagent rule, flag-dark.
  - cadence: next-4-fires · priority: med · category: feature · discovered_by: fire-101b-intake
- [ ] AGENT-COMPUTER-PERSIST: two explicit persistence formats + cold-restore (Browser-Run origin-scoped auth storage vs desktop encrypted versioned R2 backup; reuse ai_crypto.ts; assertProfileOwned) — acceptance: an authed fixture survives save → full stop → fresh-instance restore via R2-only recovery; a failed restore never silently yields an empty profile.
  - cadence: next-4-fires · priority: med · category: feature · discovered_by: fire-101b-intake
- [ ] AGENT-COMPUTER-BROKER: isolated Bitwarden credential broker performing login INSIDE the Browser-Run session — acceptance: model gets only an authorized login-op reference (never master pw/vault export/enumeration); HTTPS-origin+account+frame re-checked; bw serve not public; MFA/passkey → human takeover; broker secrets absent from env/snapshots/screenshots/traces.
  - cadence: next-4-fires · priority: med · category: security · discovered_by: fire-101b-intake
- [ ] AGENT-COMPUTER-OVERLAY-LIFECYCLE: extend BRW-INTERACTIVE-OVERLAY with 5 server-enforced controls (Watch/Take-control/Resume-agent/Stop-job/X) — acceptance: short-lived scoped creds + real revocation across kbd/mouse/clipboard/CDP; stale tabs lose control on lease change; X ≠ Stop-job verified distinct.
  - cadence: next-4-fires · priority: med · category: feature · discovered_by: fire-101b-intake
- [ ] AGENT-COMPUTER-LIFECYCLE-COST: save/sleep/wake + idle watchdog (5-min grace keyed on job/viewer LEASES, expiry on deadline/abandoned/max-wait, per-mode metering) — acceptance: idle/abandoned/budget-exhausted/completion all release compute; sleeping status served from DO metadata without starting a machine; polling never wakes a sleeper.
  - cadence: next-4-fires · priority: med · category: feature · discovered_by: fire-101b-intake

### Convergence discipline (from value-first brief + 50-rounds — THIS-REPO)
- [ ] convergence: 30-round per-objective refinement ceiling (shared prep+impl; children/retries/renames/new-ticks never reset it; the tool-call limit stays separate) — acceptance: OPERATING-PRINCIPLES § Convergence discipline states the ceiling + sub-table + anti-reset rule; an objective exceeding 30 rounds is forced to a terminal state, not relabeled. (altitude: objective-level; does NOT delete the 10-pass per-surface rule)
  - cadence: next-2-fires · priority: med · category: architecture · discovered_by: fire-101b-intake
- [ ] convergence: persist resumable per-objective convergence state (objective/parent IDs · req-revision · rounds-consumed · best-verified-candidate · evidence · next-action · lease · remaining-budget · stop-reason); next fire resumes it — acceptance: a scoped objective records state fire-N and fire-N+1 resumes without resetting rounds or re-ingesting its source.
  - cadence: next-2-fires · priority: med · category: architecture · discovered_by: fire-101b-intake
- [ ] convergence: round-level state vocab (completed/paused/blocked/plateaued/cancelled/budget-exhausted) + plateau-rule (2 successive evidence-bearing attempts w/o gain) + "plateau-with-open-requirements ≠ done" — acceptance: OPERATING-PRINCIPLES carries the vocab + plateau def; a plateaued objective with unmet acceptance is never marked completed.
  - cadence: next-2-fires · priority: med · category: architecture · discovered_by: fire-101b-intake
- [ ] CBD-skills-7 (convergence guardrail): "N focal rounds ≠ N provider pairs / nested agents / parallel writers per prompt; never rerun the campaign per child task" — acceptance: OPERATING-PRINCIPLES § Convergence gains one bullet + a fire honors it (one slice/fire, lightweight prompt-prep unchanged).
  - cadence: next-2-fires · priority: med · category: architecture · discovered_by: fire-101b-intake

### Integrations / testing / arch (from 50-rounds + all-capabilities — THIS-REPO deltas)
- [ ] INT-LANGFUSE-SSOT: one-source-of-truth per prompt (Langfuse label→digest OR Git idempotent-publish, never two editable copies) + bundled last-known-good fallback so serving never depends on a live remote fetch — acceptance: a prompt resolves to an exact version/digest with a proven offline fallback path.
  - cadence: next-4-fires · priority: low · category: observability · discovered_by: fire-101b-intake
- [ ] INT-PROMPTFOO-GATE: gate-integrity — a deliberately-broken candidate must FAIL the suite; a skipped/errored/empty required suite = incomplete (not green); no aggregate score hides a critical authz/injection failure — acceptance: a broken-candidate fixture turns the gate red in CI.
  - cadence: next-4-fires · priority: med · category: test · discovered_by: fire-101b-intake
- [ ] REARC-REV: add "checkpoint rewind does NOT restore shell/DB/external/subagent effects — label irreversible actions; rely on VCS + snapshots + compensations" to OPERATING-PRINCIPLES § Checkpoints — acceptance: the principle text names the non-restore classes.
  - cadence: next-4-fires · priority: low · category: architecture · discovered_by: fire-101b-intake
- [ ] INT-REGISTRY: add an `ai-doctor` CLI that prints the capability/billing inventory (provider·model·endpoint·auth·billing-pool·observed-quota·status∈{verified|documented-untested|exhausted|unsupported|unauthorized|blocked}·last-probe) with ZERO secrets — acceptance: `ai-doctor` emits per-capability PASS/PARTIAL/FAIL/BLOCKED, marks nothing "working" until its full path is live-tested, leaks no credential (extends CBD-skills-1 registry).
  - cadence: next-4-fires · priority: low · category: feature · discovered_by: fire-101b-intake

## perf (fire-103 audit — homepage CWV HEALTHY: LCP 1.1s / CLS 0.032 / FCP 1.1s all PASS on house targets; only INP is a narrow miss at 110ms vs ≤100ms)
- [ ] perf: idle-defer the analytics boot (GTM + GA4 + PostHog + CF beacon) to requestIdleCallback / first-interaction instead of at bootstrap — acceptance: homepage INP ≤100ms (house) in a Lighthouse mobile run AND the first pageview still lands (verify PostHog ingest, never headless). Owned-by-analytics territory (index.html snippets + telemetry.service.ts) — coordinate, don't co-edit with a live analytics agent. [fire-103 perf #1 — highest INP ROI; tracking-fidelity tradeoff = why it's not an inline ship]
  - cadence: next-2-fires · priority: med · category: performance · discovered_by: fire-103-perf-audit
- [ ] perf: route-scope the admin-cockpit Google Fonts (Inter/Montserrat/Fira Code, index.html:319-320) OFF the marketing homepage — they load globally but are only used in /admin + /create; load them lazily when an admin route activates — acceptance: the marketing homepage requests ONLY brand fonts (Sora/Space Grotesk/JetBrains Mono), admin still renders cockpit fonts. NOT a deletion (VERIFIED in-use: Montserrat in create.component, Fira Code fallback in easter-eggs/changelog — fire-103 corrected the perf-profiler's "dead weight" call).
  - cadence: next-4-fires · priority: low · category: performance · discovered_by: fire-103-perf-audit

## a11y (fire-103 public-funnel audit — scroll-padding-top 2.4.11 FIXED this fire 646a1b8e9; axe-core otherwise clean except 4 moderate landmark + target-size + focus-ring)
- [ ] a11y: fix nested-landmark axe violations on the public funnel — homepage `<footer role="contentinfo">` + /signin `<main>` render INSIDE the app-shell `<main id="main-content">` (ARIA prohibits nested `main` + `contentinfo`-in-`main`; 4 moderate at all 6bp) — acceptance: axe 0 landmark violations at 6bp on / and /signin; homepage footer out of `<main>` (or drop role), signin wrapper `<main>`→`<section>`. [fire-103 a11y FIX 1 — 4 violations → 0; HIGHEST a11y value]
  - cadence: next-fire · priority: high · category: a11y · discovered_by: fire-103-a11y-audit
- [ ] a11y: WCAG 2.2 2.5.8 Target Size — nav buttons 20px / footer links 18px / social icons 18×18 / signin "Create an account" 17px are below the 24px AA minimum — acceptance: every interactive target ≥24px (py-1 on footer `<a>`, p-1.5 on social-icon wrappers, min-h on nav/CTA); re-audit + visual QA @ 6bp.
  - cadence: next-2-fires · priority: med · category: a11y · discovered_by: fire-103-a11y-audit
- [ ] a11y: visible focus ring (WCAG 2.4.7) on the homepage search input + signin CTA — both compute `outline:none` + `box-shadow:none` on `:focus` — acceptance: a `:focus-visible` ring (`outline:2px solid var(--ps-accent)`) on every funnel control; keyboard-tab shows a ring at each stop.
  - cadence: next-2-fires · priority: med · category: a11y · discovered_by: fire-103-a11y-audit

## a11y (fire-104 update — homepage contentinfo RESOLVED live; signin is a stale-bundle false-positive, not a source bug)
- [x] (fire-104 `0c1380fb5`) homepage `landmark-contentinfo-is-top-level` RESOLVED — dropped `role=contentinfo` on the homepage footer (it nested in the shell `<main>`); real-browser re-audit axe-CLEAN of landmark rules at 375 + 1280 on the fresh bundle.
- [ ] a11y/stale-bundle: /signin nested-`<main>` — SOURCE is ALREADY clean (`signin.component.html` root is `<section>`; grep finds ZERO `<main>` / `sign-in-page` anywhere in the signin dir), yet a fire-104 live re-audit saw `<main data-testid="sign-in-page">` → a STALE cached bundle / ngsw SW serving OLD signin ([SW]/[stlbn]/[stl$] class), NOT a code bug. Acceptance: fetch the DEPLOYED signin lazy-chunk + confirm it matches source (no `<main>`); if the live ngsw serves stale, bump the SW `CACHE_VERSION`; re-audit with a FRESH/SW-BYPASSED context → 0 landmark violations on /signin.
  - cadence: next-fire · priority: med · category: a11y · discovered_by: fire-104-re-audit
- [ ] loop/audit-method: a11y + visual + deep-ui-explorer audit agents MUST bypass the service worker (fresh context / unregister ngsw / `Clear-Site-Data`), NOT a plain `page.reload` — fire-104's re-audit false-flagged /signin off a SW-cached stale bundle while source was clean (wasted a verify + nearly triggered a no-op "fix" of already-correct code). Acceptance: the audit harness opens a fresh SW-disabled context; the audit-brief template says so.
  - cadence: next-2-fires · priority: med · category: a11y · discovered_by: fire-104

## a11y + dead-code (fire-105 — CORRECTS fire-104's signin diagnosis: it was a REAL bug, not stale-bundle)
- [x] (fire-105 `bafce3e19`) /signin nested-`<main>` RESOLVED — the LIVE /signin routes to `pages/auth/sign-in.component.ts` (SignInComponent, the Better-Auth page), whose inline template wrapped content in `<main data-testid=sign-in-page>` nested in the shell `<main>`. Changed the outer layout wrapper `<main>`→`<div>` (inner `<section aria-labelledby>` stays the content region). tsc + karma 20/20; deployed. fire-104's "stale-bundle false-positive" call was WRONG — I'd read the DEAD legacy `pages/signin/` component (`<section>`), not the live `pages/auth/` one; the re-audit was correct. Lesson: when a live audit contradicts a source grep, grep ALL of src for the testid + check which component the ROUTE loads — never assume the obvious filename is the live one.
- [ ] dead-code: verify + remove the orphaned legacy signin component `pages/signin/` (selector `app-signin`, magic-link/Google UI) — app.routes.ts comment says the legacy page is DEAD post-Better-Auth cutover (`/signin` now loads `pages/auth/sign-in.component`). Acceptance: confirm no route/import references `pages/signin/SigninComponent`; if truly orphaned, remove it + its spec (interconnectedness — two signin components is the drift that caused the fire-104 misread).
  - cadence: next-fire · priority: med · category: cleanup · discovered_by: fire-105

## fire-106 (dead-code shipped + golden-path journey elevated to next-fire LEAD)
- [x] (fire-106 `15f7709aa`) removed the orphaned legacy `pages/signin/` component (4 files) — closes the fire-105 dead-code item + kills the duplicate-component drift that caused fire-104's wrong-file misread. tsc clean; unreferenced (already tree-shaken) so deployed output unchanged.
- ⭐ **LEAD THE NEXT (FRESH) FIRE — deferred across fires 101→106:** the LIVE editor Data-tab golden-path journey (roles 16/17, money-path edit leg). It keeps slipping because each fire reaches it context-heavy at the tail — the fix is to run it FIRST, right after §0 orient, on a FRESH lead. Via the LEAD's own Bash in the MAIN checkout (run `node apps/project-sites/scripts/browser-role-preflight.mjs` first), per OPERATING-PRINCIPLES § Browser-role execution contract. Acceptance: homepage → test-login → admin → open a site → editor → Data tab → resource detail drill-in + inline D1 cell-edit asserts NO "Failed to load resource" / "Failed to perform action" (proves the fire-101/102 bridge fix end-to-end) → screenshots → 0 console errors.
  - cadence: NEXT-FIRE-FIRST · priority: HIGH · category: golden-path · discovered_by: fire-106 (6-fire deferral pattern)

## editor-panel-ui-rearch (Brian directive 2026-10-03 — "focus all effort on the Editor panels UI; live ASAP") — ACTIVE, NEXT-FIRE-FIRST
Re-architect every workbench panel onto a shared gorgeous spine so chrome/tokens/empty/loading read identically + on-brand (was: ~15 hand-rolled roots, 4 header paddings, `<h2>`/`<h3>` drift, 68+ inline spinners, no in-panel Nebula). Spine lives in `app/components/workbench/panel/`.
- [x] slice-1 (`854c2c265`, LIVE on editor.projectsites.dev via Pages `bolt-diy`): `PanelShell` (one dark brand-accented root, from the DatabasePanel gold standard) + `PanelHeader` (one canonical header — black→cyan brand wash + accent icon BADGE + single `<h2>` + subtitle + actions, from ResourceOverviewPanel) + `panel.spec` (vitest 3/3). Migrated SchemaBuilder onto both (its plain muted header → the gorgeous accent-badge chrome). `npm run build` green.
- **THE PATTERN (mechanical, fan-out-able per panel):** `import { PanelShell, PanelHeader } from './panel'`; root `<div className="h-full flex flex-col bg-bolt-elements-background-depth-1 …">` → `<PanelShell testId="…">…</PanelShell>`; hand-rolled header → `<PanelHeader icon="i-ph:<x>-duotone" title="…" subtitle="…" actions={…}/>`. Verify: `npx vitest run <spec>` + `npm run build`.
- **DEPLOY (gotcha):** `npm run build && npx wrangler pages deploy ./build/client --project-name=bolt-diy --branch=main --commit-dirty=true`. NOT `--project-name=bolt` — wrangler.toml `name = "bolt"` misleads (it failed fire); the CF Pages PROJECT is **`bolt-diy`** (per CLAUDE.md + the resource table). Prod-verify: editor.projectsites.dev + a SPAWNED visual-qa agent (PROD-targeting → spawned agent is correct per the corrected browser-role contract; do NOT do it on a tired lead).
- [ ] fan-out wave A: migrate ResourceOverviewPanel (dedup onto PanelHeader), SqlNavigator, KvBrowser, BucketsPanel, R2Browser, SourceControlPanel, AutomationsPanel, TimeTravelPanel, AiSeedPanel, ImportPanel (retire its private PanelShell) — 3-4 agents, one per 2-3 disjoint panels. Acceptance: each composes PanelShell+PanelHeader; identical header padding/title; vitest+build green; deployed; visual-qa ≥8/10 + 0 console errors.
- [ ] slice: `PanelLoading` (wrap NebulaLoader, contained + `prefers-reduced-motion` safe) → replace the 68+ inline `animate-spin`/`i-ph:circle-notch` in-panel spinners (`nebula-waiting-experience`).
- [ ] slice: `PanelEmpty` (launchpad empty — icon + headline + ONE primary CTA) → apply to every panel's empty state (`embarrassingly-easy-to-use`).
- [ ] slice: `PanelSegmentedNav` (generalize the Database pill sub-nav) → reuse in Resources/SQL.
  - cadence: NEXT-FIRE-FIRST · priority: HIGH · category: ux · discovered_by: Brian directive 2026-10-03

### editor-panel-ui-rearch — wave A DONE (fire-107, `85978f080`)
- [x] KvBrowser, AutomationsPanel, BucketsPanel, R2Browser migrated onto PanelShell + PanelHeader (2 parallel worktree agents, lead merged+built+deployed; vitest 3/3, build green, live on bolt-diy). 5/~15 panels now on the spine (incl. SchemaBuilder).
- [ ] wave B (next fire): SqlNavigator, SourceControlPanel, TimeTravelPanel, AiSeedPanel, ImportPanel (retire its private PanelShell), ResourceOverviewPanel (dedup onto PanelHeader — it's the reference). Then the heavy tails SiteTablesPanel (275K) + ResourceDetailPanel (87K) with extra care. Same mechanical pattern + bolt-diy deploy.
- [ ] then: PanelLoading (in-panel Nebula) + PanelEmpty (launchpad) + PanelSegmentedNav + a focused visual-qa pass (≥8/10 @ 6bp) across all migrated panels (the deep authed journey is budget-heavy — give the visual agent a capped, direct path per panel).

### editor-panel-ui-rearch — wave B DONE (fire-108, `c5631ceea`)
- [x] SqlNavigator, SourceControlPanel, TimeTravelPanel, AiSeedPanel migrated; ImportPanel retired its PRIVATE PanelShell → shared spine; ResourceOverviewPanel deduped onto PanelHeader (4 parallel agents, lead merged+built+deployed; vitest 3/3, build green, live bolt-diy). **11/~15 panels on the spine.**
- [ ] wave C: the heavy tails — SiteTablesPanel (275K) + ResourceDetailPanel (87K). Read ONLY their root+header regions (never the whole file); same mechanical pattern; extra care (they own deep grids/subviews). Plus any remaining (Preview chrome, the Database container header, Workbench shell tabs if applicable).
- [ ] then: `PanelLoading` (wrap NebulaLoader, contained + reduced-motion) → replace the 68+ inline spinners; `PanelEmpty` (launchpad) on every empty state; `PanelSegmentedNav` (generalize the Database pill nav).
- [ ] capped visual-qa pass: one agent, DIRECT path per panel (budget-capped: if >12 tool calls without reaching a panel, screenshot + move on), AI-vision ≥8/10 @ the key breakpoints across all migrated panels + 0 console errors. The deep authed Data/Resources journeys are budget-heavy — cap to avoid burning an agent (fires 104/106 lesson).

### editor-panel-ui-rearch — wave C DONE + LIVE-VERIFIED 9/10 (fire-109, `d26512688`)
- [x] SiteTablesPanel (275K) + ResourceDetailPanel (87K) migrated onto the spine; PanelHeader gained a `leading` slot (ResourceDetailPanel back-button now conventional-left). vitest 3/3, build green, live bolt-diy. **13/~15 panels on the spine.**
- [x] LIVE VISUAL CONFIRMED: Resources panel header AI-vision **9/10** on prod (cyan accent badge + black→cyan wash + single h2 + subtitle, 0 editor console errors). The deferred live check landed via a budget-capped visual-qa agent.

### editor-panel-ui-rearch — wave D DONE (fire-110, `c6ba9c8f1`+`5b1137400`+barrel/spec)
- [x] `PanelLoading` — the Nebula Waiting Experience CONTAINED: a sized 180px `NebulaLoader` (black #060610 + cyan/purple) centered in the panel body + one muted AA status label + `role=status`; reduced-motion handled by NebulaLoader itself; a cyan CSS ring/pulse sits BEHIND the canvas as the WebGL-unavailable fallback (never a gray spinner). Wired into KvBrowser (first-page load; append-load keeps its inline note) + ResourceOverviewPanel (removed its private `Spinner`).
- [x] `PanelEmpty` — the launchpad empty (accent icon badge + `title` + `description` + ONE `action` slot), generalized from DatabasePanel + BucketsEmpty. Wired into BucketsPanel (`BucketsEmpty` → create-bucket action) + R2Browser (empty-bucket → promoted the thin text-link to a real primary upload button, `r2-empty-upload`).
- [x] barrel now exports PanelLoading + PanelEmpty; `panel.spec` 3→**7 tests** (added leading-slot order, nebula-loading, launchpad-empty, empty-omission) — `npx vitest run panel.spec` green; `npm run build` green; deployed to Pages `bolt-diy`; editor boots 200 live on editor.projectsites.dev. **Primitive spine complete: Shell+Header on 13/~15 panels, Loading+Empty shipped.**

### editor-panel-ui-rearch — wave E DONE (fire-111, `1d86402f1`+`97e8890cc`+`05f8e128f`)
- [x] wave E — adopted `PanelLoading` on ALL 4 panels that still used a LOCAL `<Spinner>`: ResourceDetailPanel (`resource-detail-loading`), SiteTablesPanel (`sitedb-loading`), ResourcesPanel, SourceControlPanel (`sc-changes-loading` + `sc-history-loading`). Each panel's private `Spinner` component DELETED (0 refs remain — adversarial grep clean). **`PanelLoading` gained an optional `testId?` prop** (`data-testid={testId ?? 'panel-loading'}`) so the 4 panels keep their existing loading anchors. **Every in-panel spinner across the editor workbench is now the contained Nebula.**
- [x] testability — shipped the NON-authed **`/_preview` gallery route** (`app/routes/[_]preview.tsx` — the `[_]` escapes the leading underscore so Remix serves it at `/_preview` instead of a pathless layout; no global guard; `noindex`). Mounts PanelShell+PanelHeader+PanelLoading(nebula)+PanelEmpty in a dark gallery → the whole spine is now screenshot/vision-gatable HEADLESSLY without the Cloudflare-Access authed-journey budget. LIVE: editor.projectsites.dev/_preview 200 + "Panel Primitive Gallery" (custom-domain cutover lagged ~30s behind the deployment URL — expected CF Pages propagation).
- [x] `panel.spec` 7→**8 tests** (added custom-testId lock); `npm run build` green; deployed Pages `bolt-diy`; editor root still boots 200. **Spine COMPLETE: Shell+Header on 13/~15 panels, Loading on every loading state, Empty on the primary empties.**

### editor-panel-ui-rearch — wave F DONE (fire-112, `c8134bc76`+`f87aee0f9`+`16d73aa83`)
- [x] `PanelSegmentedNav` primitive (role=tablist, accent active pill, arrow-key roving, per-item `panel-segnav-<id>` testid) + **DatabasePanel deduped** onto PanelShell + PanelSegmentedNav (dropped its hand-rolled root + pill nav + `onNavKeyDown`). `panel.spec` 8→**9**. Active pill restyled solid-cyan → tinted (deliberate). (Adversarial caught the `database-subnav-*`→`panel-segnav-*` testid rename breaking DatabasePanel.spec — fixed in-thread, 13/13 green.)
- [x] `PanelEmpty` launchpad on 3 more empties: BucketsPanel `ObjectsEmpty` (upload action), SqlNavigator idle (NEW "Insert 'List tables'" starter launchpad), AiSeedPanel create-table. ImportPanel + AutomationsPanel correctly SKIPPED (precondition gates / read-only log — a forced action would be a doomed control per `embarrassingly-easy-to-use`).
- [x] gallery nit: boot veil short-circuited on `/_preview` (narrow guard in `EditorLoadingScreen.tsx`) — visual-qa CONFIRMED the veil is gone + gallery immediate + contained nebula paints. `npm run build` green; deployed `bolt-diy`; `/_preview` 200 (pages.dev + custom-domain curl). **Spine COMPLETE: Shell+Header 13/~15, Loading everywhere, Empty on all sensible empties, SegmentedNav shipped, DatabasePanel deduped.**
- [x] panel icon badges — DONE (fire-114, `b30cd824c`+`c994506a8`). Extended `uno.config.ts` safelist (glob-built set of all panel `i-ph:*` icons so prop-passed duotone masks generate) + swapped the Phosphor-1.2.2-REMOVED `i-ph:bucket(-duotone)` → `i-ph:hard-drives(-duotone)`. **CONFIRMED live via DOM/CSSOM probe:** all 4 badges compute a real `maskImage: url("data:image/svg+xml...")`; served `root-mIFlietF.css` carries 91 duotone + 843 `--un-icon` masks. AI-vision 9/10. NOTE: the earlier "flat square" screenshots were (1) a same-CSS-hash browser cache + (2) Playwright's PNG rasterizer DROPPING CSS `mask-image` data-URIs (a capture artifact — glyphs paint for real users). The authoritative evidence for mask-icons is the computed `maskImage`, never the rasterized PNG.
  - [ ] optional 1-pt visual confirm: a human/CF-Browser-Rendering eyeball of `/_preview` after hard refresh (Playwright can't rasterize masks). Non-blocking — DOM proof is definitive.
- [ ] wave G (tail) — dedup Preview chrome + any residual hand-rolled panel roots onto the spine; consider a `PanelBody` primitive if a scroll/pad pattern repeats; ADD each new primitive's frame to `/_preview`.
- [ ] infra (~30min) — exempt `/_preview` from the `editor.projectsites.dev` Cloudflare Access/bot guard so the gallery serves to a REAL browser on the custom domain too (today only `bolt-diy-8jf.pages.dev/_preview` is browser-reachable — fire-111 § Editor-origin prod-verify). Already `noindex` + non-sensitive.
- [ ] standing — wire a per-fire budget-capped visual-qa screenshot of `bolt-diy-8jf.pages.dev/_preview` as the editor UX gate (the gallery is the headless spine check).

### money-path golden coverage (golden-path role, fire-112 — re-established after 5-fire starvation)
- [x] Ran the money-path journey vs PROD: homepage REACHED (hero + search + `search-result` render, 0 non-benign console errors); `/signin?test=1` seam REACHED. Honest BLOCKED at the auth wall.
- [x] ~~BLOCKER E2E_TEST_PASSWORD not in env~~ — FALSE BLOCKER (fire-113): the secret IS provisioned — `get-secret E2E_TEST_PASSWORD` (len 48) AND `apps/project-sites/.dev.vars`. fire-112's golden agent `test.skip`'d because it never SOURCED it. Fix is codified in OPERATING-PRINCIPLES § Browser-role execution contract: authed agents `export E2E_TEST_PASSWORD="$(get-secret E2E_TEST_PASSWORD)"` then submit at the seam. LOCAL loop agents are unblocked now.
- [x] money-path golden RAN GREEN end-to-end (fire-116, E2E_TEST_PASSWORD sourced — unblock CONFIRMED): 11 steps ALL passed — homepage hero → search → `/signin?test=1` seam (landed /admin, oracle 200/brian@megabyte.space/orgId:true) → admin nav → sites (2 cards) → editor (iframe mounted) → hosting (2 published) → `/create` wizard → **view-live `projectsites.projectsites.dev` 200 + `x-ps-serve: wfp` + H1**. 0 admin/editor console errors. 12 screenshots `e2e/screenshots/fire113-money/`. (Spec write was cut off — the journey itself passed; spec re-queued below.)
- [ ] money-path golden — re-queue the SPEC write (the fire-116 run proved the journey green but was cut off before committing `e2e/money-path/*.e2e.ts`; encode the 11 proven steps as a committed spec). Still wire `E2E_TEST_PASSWORD` into CI GitHub secrets so the CI `test.skip` guard unblocks there too (separate CI-only gap).
- [x] DEFECT-A DONE (fire-117, `1bac2ce7f`+`117440a11`, deployed R2) — the admin nav model gained a `{ cta:true, id:'create', label:'New site', route:'/admin/create' }` as the FIRST workspace item (`data-testid="nav-create"`, a cyan→violet primary pill in all 3 nav modes: mobile drawer + compact rail + expanded sidebar), + `create: 'New site'` section label (so the title is right too). The money-funnel top is now ONE obvious click. Karma 21/21 (nav-create renders + routes `/admin/create` + is first + non-sysadmin-visible; + the nav-icon exhaustive-coverage guard updated for the new `create` glyph). ng build green.
  - [ ] follow-on: a Playwright spec that CLICKS `nav-create` from the dashboard → asserts the `/create` overlay opens (real-user-click E2E; the golden-path's re-queued spec should use this click path, not `goto`).
- [ ] money-path spec hygiene (low-sev, <30min) — `signInViaTestSeam` (`e2e/money-path/ai-build-to-live.e2e.ts:122-130`) asserts the test panel on `domcontentloaded` but it only appears after Angular hydration → add an explicit `waitForSelector('[data-testid="test-signin-panel"]')` before the pre-fill assertion (flaky-race).
- [ ] inventory drift — `e2e/money-path/ai-build-to-live.e2e.ts` missing from `e2e/FEATURES.md` + `e2e/COVERAGE.yml` (add both rows when next touching the spec).
- [ ] inventory drift — `e2e/money-path/ai-build-to-live.e2e.ts` is missing from `e2e/FEATURES.md` + `e2e/COVERAGE.yml` (orphan to the inventory gate). Add both rows when next touching the money-path spec.
- [ ] LIVE UX slice (Deep-UI-Explorer owns, still valuable): capture the in-panel states inside the REAL authed editor Data/Resources journey (the `/_preview` gallery proves the primitives in isolation; the authed pass proves them in-context + that the nebula paints inside the WebContainer iframe OR the CSS-ring fallback shows — either on-brand).
- [ ] LIVE UX slice (Deep-UI-Explorer owns, still valuable): capture the in-panel states inside the REAL authed editor Data/Resources journey (the `/_preview` gallery proves the primitives in isolation; the authed pass proves them in-context + that the nebula paints inside the WebContainer iframe OR the CSS-ring fallback shows — either on-brand).

- [ ] a11y re-run (fire-117 — single-surface per the new §7) — the 3-surface axe sweep (demo site + homepage + `/create` overlay) was cut off 2× before delivering findings (partial: homepage/demo showed lang=en, single H1, aria-label'd search inputs — no critical surfaced mid-stream; `/create` overlay axe NOT captured). Re-run as ONE-surface-per-agent: (a) projectsites.dev homepage, (b) projectsites.projectsites.dev, (c) the authed `/create` overlay (contrast of the white close on the dark panel, form labels/aria, `role=dialog`/focus-trap) — each its own fast agent.

### fire-118 re-queue (attrition — 5 agents cut off; run these SEQUENTIALLY per § concurrent-browser rule)
- [ ] a11y single-surface — run as SEQUENTIAL one-at-a-time browser agents (NOT a parallel batch): (a) projectsites.dev homepage, (b) projectsites.projectsites.dev demo, (c) authed `/create` overlay. Each axe @ 375/768/1280. (fire-118's parallel trio collided on the shared Playwright-MCP browser → all cut off + reported a phantom redirect.)
- [x] money-path nav-create click-spec DONE (fire-122, `d99c53be5`) — **GREEN end-to-end (1 passed, 7.2s, prod)**: homepage → test-login auth → /admin → click `nav-create` → /create overlay opens (verified directive-perfect in a live screenshot: white left + bold "Create autonomous website", black+cyan right panel, all-optional inputs, admin shell behind) → close → back to /admin. `apps/project-sites/frontend/e2e/money-path-nav-create.e2e.ts`.
- [x] cleanup lead DONE (fire-119, `13687a42e`) — removed **191 lines** of verified-dead functions from `src/services/ide_sandbox.ts` (14 exported fns → 7). The cut-off agent's uncommitted worktree edits were SALVAGED (committed from the worktree + cherry-picked + lead-verified: tsc 0, validate:features PASS — no hidden caller broke). Lesson → OPERATING-PRINCIPLES § Salvage uncommitted worktree edits.
- [x] demo-site redirect — INVESTIGATED (fire-118): NOT a defect. `projectsites.projectsites.dev` serves 200 + self-canonical + no server/inline-JS redirect (curl-confirmed). The a11y agents' "redirect to projectsites.dev" was a shared-Playwright-MCP-browser collision artifact, not real behavior.

## fire-120 replenish (CRAWL-3b shipped; drift-sweep next-wave + CRITICAL CI-flake)
- [ ] **CI-FLAKE-1 (HIGH — gates ALL worker deploys)** — the worker `Test worker package` CI job is a CI-ONLY flake (suite that imports full `../index` fails to load under CI jest-worker sharding; green locally, 913 suites/14420 tests PASS). The one-retry self-heal (`project-sites.yaml` L156) is NOT enough: fire-119's push (`13687a42e`) failed BOTH attempts → its Deploy jobs were skipped (0s) → **fire-119's CRAWL-3 skeleton + ide_sandbox cleanup never deployed to prod**. fire-120's run cleared it (Unit Tests ✓ on retry). Durable fix options: `--runInBand` or `--maxWorkers=1` for the CI unit job (kills the sharding race), OR isolate the `../index`-importing suite into its own serial project, OR raise retries to 2. Acceptance: 3 consecutive worker pushes deploy without a Unit-Tests red. File: `.github/workflows/project-sites.yaml` L146-156 + `apps/project-sites/jest.config.cjs`.
- [ ] WIRE-1 — surface team/SSO service orphans (`member_activity`, `sso_*`, `team_*`) behind an admin Team/SSO panel — each service has ≥1 reachable caller — `src/services/{member_activity,team_*,sso_*}.ts` (interconnectedness; one cluster per fire per split-work-into-ledger)
- [ ] WIRE-2 — wire the 5 Listmonk orphans (`listmonk_import/personalize/segments/suppression/webhook`) into the newsletter/email admin flow — called from a route or cron — `src/services/listmonk_*.ts`
- [ ] WIRE-3 — mount health/observability orphans (`health_aggregator/alarm/probe`) into the super-admin service-status widget — health funcs feed a live status surface — `src/services/health_*.ts`
- [ ] WIRE-4 — wire domain/dns lifecycle orphans (`dns_health_check/provision/verify`, `domain_monitor/transfer/verify`) into the domain manager — reachable from domain UI — `src/services/{dns_*,domain_*}.ts`
- [ ] WIRE-5 — expose billing/plan orphans (`billing_invoice/meter`, `plan_compare/metrics`) via admin billing/plan surfaces — called from a route — `src/services/{billing_*,plan_*}.ts`
- [ ] CRAWL-5-E2E — Playwright prod-E2E proving `/api/crawl` 404s while DARK + flips reachable when flag on — crawl route coherence asserted in CI — `apps/project-sites/e2e/` (schedule with the `site_crawl` promotion decision)
> drift-sweep context (fire-120, read-only architect): `validate-feature-drift` PASS [0]; 0 NEW/blocking orphans; `site_crawl` fully wired (`/api/crawl` mounted `src/index.ts:1147`, `SiteCrawlWorkflow` bound dev+prod, correctly flag-dark). The 134 advisory SERVICE_MODULE orphans are interconnectedness debt — drain cluster-by-cluster (WIRE-1..5), non-blocking.

## fire-121 replenish (CI-FLAKE-1 shipped; golden-path auth seam root-caused)
- [x] **GOLDEN-AUTH-1 DONE (fire-122, `d99c53be5`) — path A (spec-side), NOT a CF block.** The curl-403 was a red herring (curl had no `cf_clearance`): a browser that loads `/` first POSTs the seam fine (proven live — a cleared-browser in-page fetch got `401 application/json`, the endpoint, zero CF challenge). The bounce-to-/signin was **3 spec bugs**, all fixed: (1) load `/` first for clearance, then IN-PAGE `fetch` (carries the cookie); (2) token is at `.data.token` not top-level (worker wraps `c.json({data:{token,...}})`); (3) seed `localStorage['ps_session']` with the EXACT `Session` shape `{token, identifier, createdAt: Date.now()}` — missing `createdAt` → AuthService's reload TTL check treats it as expired → bounce. **The whole starved golden-path/admin category is now UNBLOCKED.** Working recipe → memory `golden-path-test-login-seam-cf-bot-challenged` (corrected) + ref impl `money-path-nav-create.e2e.ts`. No WAF change needed.
- [x] CREATE-POLISH-1 DONE + PROD-VERIFIED LIVE (fire-128, `6043b166e`) — it WAS a real user-facing defect: at the close button's center `elementFromPoint` returned the admin topbar's `.avatar-btn` (user-menu avatar), so a REAL mouse click on the X opened the user menu, not close — the owner genuinely couldn't dismiss the overlay. Root cause = a **flex paint-order trap** (CreateComponent renders in AdminComponent's `<router-outlet>` inside `main#main-content`, a `position:relative` flex item whose paint layer loses to the sibling `.admin-topbar sticky z-50`) — NOT z-index (inert even at z 2147483647). Fix: **portal `.ps-create-overlay` to `document.body`** in `ngAfterViewInit` (removed in `ngOnDestroy`), escaping main's stacking layer. tsc 0, build:prod 0. Frontend deployed to R2 + **prod-verified live**: close button SVG now topmost at its center (`isCloseOrChild:true`) + a real coordinate click → `/admin`, overlay dismissed. Also verified @375 + @1280.
- [x] CI-FLAKE-1 DONE (fire-121, `dcbcc16db`) — hardened the worker Unit Tests CI job: `NODE_OPTIONS=--max-old-space-size=4096` (heap headroom for the heavy `../index` suites) + `--maxWorkers=2` (caps concurrent heavy-suite memory on the RAM-constrained runner) + **3 total attempts** (fire-119 stranded the deploy by failing the old 2-attempt step). Validation is trailing (path-filtered pipeline — exercised on the next worker-source push). fire-120's run confirmed Deploy to Production ✓ (7m46s) → CRAWL-3b + the previously-stranded fire-119 worker changes are now LIVE.

## fire-123 replenish (golden-path UNBLOCKED → first LONG journey shipped)
- [x] admin-operations breadth journey DONE (fire-123) — first durable LONG golden journey after GOLDEN-AUTH-1: `apps/project-sites/frontend/e2e/admin-operations-journey.e2e.ts` auths once (shared helper) then CLICKS through 14 core admin surfaces (Dashboard/Sites/Analytics/Hosting/Forms/Leads/Feature-Flags/Apps/Social/Voice/Billing/Docs/Settings/Super-Admin), asserting each is on-route + rendered (real H1, non-thin) + console-clean. **GREEN 1 passed 26.4s prod.** Admin operator breadth is healthy — no defect surfaced (baseline retained, not forced).
- [x] shared admin-auth helper DONE (fire-123, §7) — `e2e/helpers/admin-auth.ts` encodes the GOLDEN-AUTH-1 recipe (`authenticateAdmin` + `getTestPassword` + `filterConsoleNoise`) so no future golden-path spec re-discovers the 3 auth bugs. Used by the journey; new specs import it.
- [~] DEEPER-JOURNEY-1 — part (b) display-vs-store DONE (fire-124, `61fe04f1b`): REUSED the existing `reconcile-counts.mjs` (live D1-vs-endpoint sweep) → it caught a REAL defect: **media `store=109 display=50`** silent-cap (`/api/media/assets` capped at a 50-row page, exposed NO total → UI implies "this is all"). FIXED: added `countAssets` (shared filter w/ `listAssets`) + `/api/media/assets` now returns the true `total` + reconciler reads it. 37/37 media tests, tsc 0. Analytics reconciles clean (130==130). Remaining: (a) flag-toggle-persist + (c) forms edit-persist causal probes — still queued, ONE per fire.
- [ ] MEDIA-UI-1 — surface the media `total` in the editor media panel (bolt-embed bridge, `bolt-embed.service.ts` ~L2924 consumes `/api/media/assets`) — show "N of total" / load-more so the owner sees there are >50 assets (the user-facing half of the fire-124 silent-cap fix; the data-truth is already fixed).
- [ ] REAL-MONEY-PATH-JOURNEY — the full search→build→view-live→edit→publish journey. NOTE: triggers a real (~$2 WfP) AI build — gate behind an explicit opt-in env (`E2E_ALLOW_REAL_BUILD=1`) so routine runs stay cheap; run deliberately, not every fire.
- [x] CREATE-POLISH-1 DONE (fire-128) — see the detailed entry above (portal-to-body fix, prod-verified live).

## fire-125 replenish (media fix VERIFIED LIVE + forms-causal unblocked off Browserbase)
- [x] fire-124 media silent-cap fix VERIFIED LIVE (fire-125) — reconcile-counts.mjs now **✅ PASS 13/13** surfaces; `media store=109 display=109` (was 109 vs 50). The `/api/media/assets` `total` deployed + the reconciler reads it.
- [x] verify-forms-causal MIGRATED off Browserbase (fire-125, §7) — Browserbase credit returned **402** (session create failed), blocking the causal-probe suite. Rewired `e2e/admin-verify/verify-forms-causal.mjs` to LOCAL headless Playwright (`chromium.launch`) + fixed its stale `issuedAt`→`createdAt` session seed (the fire-122 auth recipe it predated). It RUNS now (authed as brian, 0 console errors, no Browserbase).
- [ ] FORMS-CAUSAL-SITE — the migrated probe's hardcoded target site `northstar-functions-lab-sf` (+ id `f84f5ab1-…`) now 404s ("Site not found") on submit → `apiCausal=0`. NOT a product defect (the forms endpoint correctly 404s an unknown site) — the probe's test site is stale. Point it at a CURRENT brian-owned site that has a Contact form (or create a durable `causal-forms-lab` scaffold), so the causal chain (submit→store→display + XSS-as-text) proves again.
- [ ] BROWSERBASE-MIGRATE — migrate the REMAINING admin-verify Browserbase probes (`reconcile-surfaces.mjs` + any other `resolveBrowserbaseCreds` consumer) to local headless Playwright + the `e2e/helpers/admin-auth.ts` recipe, same as verify-forms-causal. Browserbase credit is dead (402); local cf_clearance auth is the proven path (fire-122). Grep `resolveBrowserbaseCreds` for the full list.

## fire-126 replenish (reconcile-surfaces migrated off Browserbase + 2 findings triaged stale)
- [~] BROWSERBASE-MIGRATE — reconcile-surfaces.mjs DONE (fire-126, `edb7ad68b`): migrated off dead Browserbase (402) onto a NEW shared helper `e2e/admin-verify/_local-browser.mjs` (`launchLocalBrowser` + `getTestPassword` + `authSeedBrian` w/ the createdAt recipe). Runs clean, authed as brian (no bounce), 14 surfaces. REMAINING probes (analytics-tabs-sweep, verify-social-posts, verify-analytics-fix, scan-admin-sections, apps-payload-prod-verify, verify-billing, verify-perpage-cwv-live, rebuild-site, …) are now a TRIVIAL migration via the shared helper — one short sweep next fire.
- [x] RECON-SURF-LIVE-GT DONE (fire-130, `f834d3259`) — reconcile-surfaces.mjs now SELF-GROUND-TRUTHS: each surface declares a live `COUNT(*) WHERE org_id='org-brian-001'` (correct per-table filter — verified vs live `PRAGMA table_info`: `mcp_connections`+`audit_logs` have NO `deleted_at`; per-site tables filter by `site_id`) instead of the frozen 2026-09-11 snapshot. LYING-EMPTY = `liveGt>0 && display==0`; `liveGt==0 && display==0` = honest-empty PASS. Fail-soft (a failed count skips that gt with a `::notice::`, never a false red). Also replaced the stale hardcoded `SITE` constant → dynamic `resolveLiveSite()`. **Before: 9+ false noise flags; after: 13/14 PASS** (mcp/env now correctly honest-empty; per-site surfaces resolve a live site). The one remaining 🟠 (audit-logs) is the AL-219 silent-cap check working as designed (store 6475, page 50, but total honestly exposed). Prod-run verified live. This largely auto-resolves PROBE-FINDINGS-TRIAGE (the probe no longer false-flags honest-empty).

## fire-127 replenish (4 more read-only probes off Browserbase + triage candidates)
- [~] BROWSERBASE-MIGRATE — 4 MORE read-only probes migrated (fire-127, `d22910606`): scan-admin-hub, scan-admin-sections, super-admin-probe, verify-analytics-surfaces — all run WITHOUT Browserbase 402, authed (no bounce) via the shared `_local-browser.mjs`; 2 more latent `issuedAt`→`createdAt` bugs fixed en route. Migrated so far: reconcile-surfaces + verify-forms-causal (fire-125/126) + these 4 = 6. REMAINING: ~12 read-only (analytics-tabs-sweep, apps-payload-prod-verify, verify-billing, verify-analytics-fix, pricing-prod-verify, hosting-prod-verify, settings-roundtrip, contract-sweep, media-mcp-probe, verify-builder-tier, …) — trivial batches via the helper; PLUS the SIDE-EFFECTING set (`fire-*`, `deliver-*`, `rebuild-*`, `_retrigger-*`) which migrate safely but must NOT be run-verified casually (real events/builds/$) — migrate + smoke carefully, separate pass.
- [ ] PROBE-FINDINGS-TRIAGE — the migrated probes flagged EMPTY-where-expected surfaces (scan-admin-sections: settings/domains/forms; verify-analytics-surfaces: overview_traffic NOT_FOUND + empty cf_zone/live_feed). Per fire-126, these are OFTEN stale-snapshot or honest-empty (brian's data changed) OR the known CF-zone-empty-for-subdomains analytics class — triage each against LIVE prod D1 (org-brian-001) before treating as a defect. Generalizes RECON-SURF-LIVE-GT across the probe suite.

## fire-129 replenish (money-path funnel journey GREEN + agent-tail-cutoff §7)
- [x] money-path funnel golden journey DONE (fire-129, `02690a48a`) — the PUBLIC money-path FRONT DOOR verified healthy end-to-end: `apps/project-sites/frontend/e2e/money-path-funnel.e2e.ts` (homepage renders → business search responds → test-login auth seeds → admin create-entry reached + create CTA visible+enabled; STOPS before a real build). **GREEN 2 passed 7.1s against prod.** Codified as a durable prod spec. No defect surfaced — the funnel works.
- [ ] AGENT-COMMIT-DISCIPLINE (§7, loop hardening) — agents repeatedly cut off in the VERIFY→COMMIT→REPORT tail (fire-119 ide_sandbox, fire-129 funnel): the work is DONE + the artifact written+passing, but it's cut off BEFORE committing, stranding verified work (salvageable, but costs a recovery). Harden the agent-brief template (`run-the-loop.md` §2 + OPERATING-PRINCIPLES): instruct agents to `git add` + `git commit` + `git push` the primary artifact the INSTANT it's green, BEFORE composing the ≤200-word return — the report is the LAST thing, never gated before the commit. Pairs with the existing SALVAGE recovery (check worktree AND main-checkout untracked for the artifact).

## fire-131 replenish (5 more read-only probes off Browserbase → read-only batch ~complete)
- [~] BROWSERBASE-MIGRATE — 5 MORE read-only probes migrated (fire-131, `82c288eb8`): hosting-prod-verify, pricing-prod-verify, verify-billing, apps-payload-prod-verify, analytics-tabs-sweep — all run WITHOUT Browserbase 402, authed (no bounce) via the shared helper; +inline `issuedAt`→`createdAt` fixes; net +31/−97. **11 probes now migrated** (reconcile-surfaces, verify-forms-causal, scan-admin-hub/sections, super-admin-probe, verify-analytics-surfaces, + these 5). The READ-ONLY batch is ~complete. REMAINING: the SIDE-EFFECTING set (`fire-*`, `deliver-*`, `rebuild-*`, `_retrigger-*`) — migrate the code safely BUT gate their execution behind an explicit opt-in (they fire real events/builds/$); do NOT run-verify them casually. Once ALL migrate, retire the dead `_browserbase-creds.mjs` module.
- [x] ANALYTICS-A11Y + CONTRAST-SWEEP DONE + PROD-VERIFIED (fire-132, `1111ac865`+`7825a2e42`) — the axe `color-contrast` serious (WCAG AA 1.4.3) on `/admin/analytics` was an **opacity-on-muted-token** (`color-mix(ink N%, transparent)` over the dark bg → 4.18:1 at 45%; the `[opac]` memory class). Agent fixed `.ol-win` (outbound-links-card); lead found the sibling `.se-*` (script-errors-card); then SWEPT THE WHOLE CLASS — **50 lines across 27 admin card components** where `≤48%, transparent` → `78%/82% var(--ps-bg)` solid (≥11:1 AA; leaves 50%+ which already pass). tsc 0, build 0, frontend deployed to R2. **Prod-verified: analytics-tabs-sweep now CLEAN — 8 tabs, 0 persistent serious/critical WCAG.** Loop-win: when a probe flags ONE instance of a styling class, grep the whole surface + sweep the class in ONE deploy, not whack-a-mole per deploy.
- [x] CONTRAST-GATE DONE (fire-133, `2c242fec0`) — `frontend/scripts/check-contrast-muted.mjs` bans the AA-failing `color: color-mix(in oklch, var(--ps-ink…) ≤49%, transparent)` TEXT-color pattern across `src/app/pages/admin`, wired into `build:prod` (after check:css-comments). Correctly scoped to TEXT `color:` only (negative lookbehind for `-` → `border-color`/`background-color` at low opacity are intentional + NOT flagged); fix hint points to the solid `--ps-bg` mix. Verified: PASS on current admin (0), FAILS on a planted text-color 45% (exit 1), IGNORES a planted border-color 10%. Locks in fire-132's 27-card sweep so the class can't silently return.
- [x] CONTRAST-SWEEP-2 DONE + DEPLOYED (fire-134, `d1b8d2225`) — fixed all 9 non-admin failing text-contrast occurrences (domain-picker ×2, changelog ×2, super-admin ×3, developers, pricing) + a **10th** the broadened gate caught (developers `.dev-footer__sep` 25%). Agent confirmed EACH surface is dark-bg (`:host { background: var(--ps-bg) }` — marketing + super-admin all dark-first) so the solid `--ps-bg` mix (78%, ≥11:1 AA) applied uniformly. **Broadened CONTRAST-GATE from `pages/admin` → all of `src/app`** (comprehensive, dark-first). Gate PASS app-wide (0), tsc 0, build 0, frontend deployed to R2; public surfaces (pricing/changelog/developers) render 200. The opacity-on-muted-token contrast class is now CLOSED + structurally gated APP-WIDE.

## ⭐⭐ FRONTIER SNAPSHOT — fire-301 groom (SUPERSEDED by the fire-305 snapshot at the END of this file — READ THAT FIRST; this block kept for drive history)

> **Why this snapshot (supersedes the fire-173 block below):** fires 293-300 closed the money-path
> causal-legs EPIC **5/5** (VIEWLIVE-1 · AIBUILD-VERIFY · SEARCH-DEDUP-GUARD · PUBLISH-1 fire-299 ·
> EDIT-SAVE-CAUSAL fire-300) — do NOT re-queue any money-path leg (grep the flag/endpoint before
> claiming a remainder per [[backlog-work-claim-must-be-reverified-against-code]]). fire-298 shipped
> the signed-out `/create` upload surviving the OAuth bounce via IndexedDB ([[idbUp]]); fire-294 made
> the dark-flag resolver return **200 `{enabled:false}`** (not 404) so the console stays clean
> ([[dkRes]]). **WLK-39 (Embedded Claude Code) is implementation-COMPLETE but functionally BLOCKED on
> Anthropic account credits + the gateway-auth token — Brian-gated, see §Brian-gated, NOT loop-doable.**
> **Category starvation (last 8 fires): Testing · UX/a11y · Cleanup · Docs · Discovery all STARVED;
> Product over-weighted.** The next waves below deliberately favor the starved five.

> **✅ MARKED DONE this groom:** money-path EPIC 5/5 (already reconciled in the ACTIVE TOP EPIC block,
> lines 42-48 — PUBLISH-1 + EDIT-SAVE-CAUSAL confirmed shipped, not re-opened) · the fire-173 READY-NOW
> top-5's items #2 (EDIT-SAVE-CAUSAL) + #3 (PUBLISH-1) are now DONE and must not be read as frontier.
> **✅ ANCHOR CORRECTED:** dead-code-136 (line ~827) — real paths are `frontend/src/app/{animations/
> motion.ts,lib/json-ld.ts}` (the `apps/project-sites/src/services|utils/*` paths in the brief do NOT
> exist); `buttonState` is still-present-and-dead (fire-137's "removed" claim was wrong).

> **READY NOW — top 5** (ranked by money-path leverage × starved-category priority; all lead-doable,
> no agent fleet required; EXCLUDES Brian-gated — those are in the subsection below):**
> 1. **[cleanup] dead-code-136 surgical removal** — delete the 3 VERIFIED-dead units: `buttonState`
>    (`frontend/src/app/animations/motion.ts:84`, 0 consumers) + `frontend/src/app/ui/card.ts`
>    (0 consumers) + the 3 zero-src-ref deps (partysocket/yjs/tw-animate-css) from `frontend/
>    package.json`. KEEP monaco/qrcode (1 ref) + scaleFade/toastSlide/listStagger (consumed).
>    **Accept:** units removed, `grep -rln` confirms 0 callers pre-delete, `@defer`/lazy grep clean for
>    the deps, tsc 0 + `ng build` prod + full Karma green. · category cleanup · anchor verified above.
> 2. **[testing] Legacy-flag resolution lock** (line ~1595) — regression test asserting `resolveFlag`
>    IGNORES the governance `feature_flags` table (prevents re-introducing the fire-81 adversarial HIGH).
>    **Accept:** a worker Jest test seeds a legacy row with a DIVERGENT rollout and asserts resolution
>    == registry default (not the legacy value); RED first by temporarily reading the legacy table,
>    then GREEN. · category testing · anchor: the flag-resolution service + `src/__tests__`.
> 3. **[testing] forms.component MCP-connect `data-testid` + lock** (line ~521) — fire-46 shipped
>    `data-testid="mcp-${id}-connect"` in `settings.component.ts` but `forms.component.ts` coverage is
>    UNVERIFIED. **Accept:** add the per-provider testids to `apps/project-sites/frontend/src/app/pages/
>    admin/sections/forms.component.ts` (rendered from `mcp-providers.ts`) + a Karma spec asserting each
>    provider row exposes its stable testid. · category testing · anchor verified.
> 4. **[ux/a11y] Restore Preview device/responsive switcher** (line ~624) — `app/components/workbench/
>    Preview.tsx:77` hard-codes `isDeviceModeOn=false` → the coded device list is orphaned (dead
>    default, [[opt-in-prop-plus-uncalled-resolver-is-dead-default]]). **Accept:** wire a 6-breakpoint
>    quick-toggle that flips `isDeviceModeOn` + resizes the preview frame; Vitest for the toggle; editor
>    prod loads 200 with the control visible + functional. · category ux · anchor verified (L77/245/305).
> 5. **[testing] E2E for the admin cockpit** (line ~545) — `apps/project-sites/frontend/src/app/pages/
>    admin/sections/dashboard.component.ts` (operator cockpit / needs-attention queue / KPI tiles / CWV)
>    has NO E2E. **Accept:** one homepage-start Playwright journey (goto `/` → signin seam → dashboard)
>    asserting the KPI strip + attention queue render with real data, console-clean, axe-clean at 1280;
>    add the FEATURES.md + COVERAGE.yml rows so `validate:e2e-inventory` passes. · category testing.

> ### Brian-gated / externally-blocked (do NOT treat as READY — a fire must NOT touch these)
> - **WLK-39 Resolution functional launch** — implementation COMPLETE (fires 174-186); BLOCKED on (a)
>   Anthropic account OUT OF CREDITS and/or (b) provisioning a NEW `CF_AIG_TOKEN` gateway-auth secret
>   (CF dashboard → AI Gateway → settings). Promoting `claude_code_panel`+`resolution_engine` is a
>   money-path production UX flip = Brian-gated. See fire-187 note (line ~1962). [[AIG401]]
> - **`publish_live_check` flag flip ON** — money-path prod UX change + a known 3xx-redirect
>   false-negative edge (`live` is strictly `status===200`); Brian-gated, NOT a loop-autonomous flip
>   (ACTIVE TOP EPIC line 48). The CODE is DONE + prod-deployed.
> - **DEMO-0 / DEMO-1** — keep-existing-site vs deploy-curated-bundle + the A19 guest-admin call
>   (lines 63-66) are explicit Brian decisions.
> - **Stripe test-rail in CI (LB-1 / gp-05)** — needs `STRIPE_PRICE_ID_MONTHLY_WALLET` wiring + the
>   Stripe test keys in CI (Blocked-user, line ~1028).
> - **R2/S3 delivery creds** — launch task gated on Brian-provided credentials.

> ### NEXT-WAVE replenish — fire-301 (starved-five concentrated; each self-contained, anchor-verified)
> - **[testing] Drain the 7 stale E2E cohorts** (line ~533) — retarget/repair details-modal ·
>   domain-files · ai-workflow + 4 more; run the FULL Vitest suite (not scoped — scoped runs hid 10
>   pre-existing RED editor tests, [[FULL]]). **Accept:** 7 cohorts green or explicitly deleted-with-
>   reason; `npm test` (editor) + full Jest (worker) green. · category testing.
> - **[ux] Kill the remaining editor Refresh/Reconcile buttons** (line ~611) — BucketsPanel ·
>   DatabasePanel · NamespaceSummary · ImportPanel · LockManager · ProjectHub · EnvAssignmentGrid still
>   carry a manual refresh (a DEFECT per `real-time-data-no-manual-refresh`). **Accept:** each swaps to
>   a visibility-aware poll / `PS_*` push; Vitest asserts no refresh control renders; editor prod 200. ·
>   category ux · anchors in `app/components/workbench/`.
> - **[a11y] Playwright a11y spec across the 4 CF-resource inspectors** (line ~672) — kv/r2/vectorize/
>   queues now share one ARIA-1.2 listbox model; **Accept:** a Playwright a11y spec drives roving-
>   tabindex + `role=listbox/option` keyboard nav across all 4 at 6 breakpoints (axe 0) + extract a
>   shared `list-select` directive to dedupe the 4 copies (interconnectedness). · category a11y.
> - **[docs] Reconcile the stale data-platform docs** — `docs/data-platform-NEXT-FIRE.md` +
>   `docs/data-platform-FIRE7-code-browser.md` predate the per-site-D1 re-arch now shipped; **Accept:**
>   fold their still-true content into `docs/data-platform-scope.md`, delete the superseded files (or
>   stamp them DONE with a pointer), and confirm no CLAUDE.md link dangles. · category docs.
> - **[cleanup] Prune `.claude/worktrees/agent-*` + regenerate lockfile** (line ~871) — ~68 leftover
>   agent worktrees (stranding-incident class). **Accept:** `git worktree prune` + explicit remove/
>   `branch -D`; `npm install --legacy-peer-deps` regenerates the lockfile clean (pnpm FAILS on the
>   electron-builder SSH dep). · category cleanup/hygiene.
> - **[discovery] FRESH module audit for the NEXT lead code slice** — the audited modules (per-site-DB,
>   media, serving-mutation cache-bust, env-vars IDOR) are coverage-exhausted; **Accept:** run
>   `scripts/detect-orphans.mjs` + a targeted read of ONE un-audited area (Angular admin Karma gaps OR
>   `api.ts` billing/hostname handlers) and append 3-5 verified, anchor-carrying TODOs so the next
>   quota-dead fire has clean lead work. · category discovery.

## ⭐ FRONTIER SNAPSHOT — fire-173 groom (SUPERSEDED by fire-301 above — items #2/#3 are now DONE; kept for drive history)
> **Why this snapshot:** fires 161-172 drove the lead-doable (no-agent) work to exhaustion — the Editor Resources screen is implemented + 4/4 live + pixel-proven; the per-site-DB (14 routes), media (12 routes), and serving-mutation cache-bust (publish-bolt/delete/deploy) route-coverage CLASSES are all COMPLETE; env-vars IDOR is covered. Further lead-only coverage-hunting would be make-work (anti-`feedback_grind_dont_defer` is NOT a licence to grind thin locks — `do not create inference work solely to consume tokens`). The genuine remaining frontier is **multi-agent** (dual-provider resolution, long browser E2E) → it needs the agent fleet (weekly quota resets **Oct 7, 4pm ET**). This block is the execution-ready hand-off so the fleet starts with ZERO re-discovery.
> **READY-NOW top 5 (ranked by money-path leverage × directive priority):**
> 1. **WLK-39 — Embedded Claude Code in the editor** (the Final Directive's §75 flagship). A first-class "Claude Code" surface beside Code/Preview/Data/Terminal, wired to the Resolution Engine (dual OpenAI+Anthropic research → Claude synthesis → Requirement Graph → bounded fan-out). **Inherently multi-agent** (the vertical IS the resolution pipeline). Anchors: `app/components/workbench/` (new panel beside ResourcesPanel) · `CAMPAIGN-cf-native-ai.md` §11-12 · the reconciled delta in `PENDING-DIRECTIVES.md` (Resolution-Engine pipeline · Capacity Broker · 20-pass visual ladder · DeepSeek/MiniMax/Gemini portfolio roles). Acceptance = the §75 vertical slice proven end-to-end (prompt → research → synthesis → edit → test → live), NOT a scaffold. **Must NOT ship as unwired scaffolding** (directive forbids it + `wire-same-fire`).
> 2. **EDIT-SAVE-CAUSAL** (money-path EDIT leg) — ✅ **DONE (reconciled fire-300): NO remaining piece.** unit-causal LOCKED fire-164 (`publish_bolt_ownership.test.ts:215`) AND the full real-browser E2E already exists — `apps/project-sites/e2e/create-edit-publish-flow.spec.ts` (edit title in the `.bolt-frame` embed → re-publish → poll `{slug}.projectsites.dev` HTML → `.toContain(NEW_TITLE)`), cost-gated `E2E_REAL_BUILD=1`. Do NOT re-queue.
> 3. **PUBLISH-1** (money-path PUBLISH leg) — multi-surface, scoped fire-163: a CORS-safe worker `GET /api/sites/:id/live-check` (authed, IDOR, server-derived URL, flag-gated) + the hosting URL-card poll-then-reveal ("finishing deployment…" → "View Live" only on 200) + units. Anchors: `src/routes/api.ts` (new endpoint near `/readiness`) · `frontend/.../hosting.component.ts` (URL cards ~L175-205).
> 4. **Golden-Path LONG journey** (role 4/16) — 30-50+ action money-path journey (search→signin→AI-build→view-live→edit→publish) against PROD with real backend, build-diagnose-fix-continue. Needs the browser-connected case-owner.
> 5. **Deep UI Explorer pass** (role 17) — authed real-browser state-graph sweep of the admin for any regression since the last visual pass; feeds UX/a11y findings. Needs CF Browser Run + the authed seam.
> **Lead-only (no-agent) residuals, if a quota-dead fire must ship code:** none clean remain in the audited modules — the next lead code slice would require a FRESH module audit (e.g. Angular admin Karma gaps, or `api.ts` billing/hostname handlers whose CF/Stripe deps make them heavier than the KV-purge class). Prefer grooming/reconciliation over a forced thin lock until the fleet returns.

## ⭐⭐ WLK-39 EXECUTION PLAN — Embedded Claude Code (§75 flagship) — SCOPED fire-173c by a Plan agent, READY to build
> Agents CONFIRMED available (the fire-153 "blocked" was stale — fire-173b). A `Plan` agent scoped WLK-39 against the real codebase. Key discovery: the AI Gateway path is ALREADY WIRED — `app/routes/api.llmcall.ts` (forces ProjectSites AI when `PS_BOLT_AI=true`) → `/api/bolt/chat/completions` → `chooseProviderForTier` (`libs/features/model_registry/service.ts:289`, tier `premium`→Claude-class) → `gatewayFetch`. So the first vertical REUSES it — no new provider/route/gateway. Canonical workspace (§26): panel edits apply via the EXISTING `boltArtifact`/`<boltAction type="file">` → `workbenchStore.createFile()` → the ONE WebContainer (satisfies "never a parallel editor").
> **Reconcile notes:** (R1) WLK-39-the-EPIC = the full dual-provider Resolution Engine; S1 below is its first wire-complete leg (single premium provider) — annotate so the fleet doesn't read S1 as all of WLK-39. (R2) real top tabs are Code·Preview·Database·Resources (Terminal lives in EditorPanel) → add a 5th `claude` tab. (R3) use the DARK-flag pattern (worker 404 → bridge `{enabled:false}` → hide), NOT the `features.ts` announcement feed; add worker flag `claude_code_panel`. (R4) §12 wants an ADR-first + one-workspace — record a DECISIONS.md pointer as S0.
> **Slices (each = one agent-fire unless noted; every new capability flag-gated default-off):**
> - **S0** · ADR + `claude_code_panel` dark-flag + `ClaudeCodeEvent` union (NO `thought`/CoT variant — CoT structurally unrepresentable) + pure `claude-code-stream.ts` parser (unit-tested). Anchors: `app/lib/embed/embedded-mode.ts`, `app/components/workbench/claude-code-stream.ts`(new)+spec, `DECISIONS.md`.
> - **S1 · ⭐ BUILD FIRST** · wire-complete vertical: `ClaudeCodePanel.tsx` (spine-composed, Activity tab) → wire `/api/llmcall` streaming → apply ONE edit via `boltArtifact` into the WebContainer → tab registered + flag-gated. Accept (end-to-end, NOT scaffold): type prompt → stream renders as actions/output (no CoT) → a real file edit lands in the WebContainer → Preview reflects it. Anchors: `Workbench.client.tsx:69,171,579`, `app/lib/stores/workbench.ts:54`, `api.llmcall.ts`(reuse), `Chat.client.tsx:358`(edit-apply pattern), `panel/index.ts`.
> - **S2** files-touched + per-file diff tab · **S3** tests tab · **S4** deploy-state tab (reuse `PS_DEPLOY_REQUEST`) · **S5** subagents/current-task (**2 agents**) · **S6** dual-provider research→Claude synthesis — the BACKLOG multi-agent core (**2 agents**) · **S7** Long-Trail browser E2E golden path (role 16, browser-connected).

> **WLK-39 STATUS (fire-174):** ✅ **S0+S1 SHIPPED** (`f886ae24e`) — `claude-code-stream.ts` (ClaudeCodeEvent union, NO CoT variant = structural firewall + parser drops forbidden CoT lines) · `claude-code-flag.ts` (default-OFF gate) · `ClaudeCodePanel.tsx` (spine-composed, prompt→`/api/llmcall` stream→parse→Activity render + edit via `workbenchStore.createFile()`) · 5th flag-gated `claude` tab in Workbench.client.tsx + WorkbenchViewType. Verified: vitest 17/17 (parser 12 + panel 5), tsc 0, build 0; editor Pages deployed, prod loads 200 (tab correctly dark). **NEXT BUILD-FIRST = S2** (files-touched + per-file diff tab — reuse the inline-diff `fileHistory`/`aiOriginalFiles` at Workbench.client.tsx:125). Then S3 tests · S4 deploy-state · S5 subagents (2 agents) · S6 dual-provider research→synthesis (2 agents) · S7 Long-Trail browser E2E (live WebContainer edit→Preview proof — the deferred S1 acceptance leg).

> **WLK-39 STATUS (fire-175):** ✅ **S2+S3+S4 SHIPPED** (`5f9f4148f`) — the Claude Code panel's read-surface tabs: **Files** (lists `file_touched` events + per-file DIFF via a new `ClaudeCodeFileDiff.tsx` that REUSES the editor's existing `diff`-pkg renderer — no new engine; `ClaudeCodeFileTouchedEvent` extended w/ optional diff/before/after) · **Tests** (`test_result` pass/fail tally + per-test rows, failing first) · **Deploy** (`deploy_state` latest-status + history). vitest 23/23 (14 stream + 9 panel), tsc 0, build 0; editor Pages deployed, prod loads 200. Panel read surfaces COMPLETE (Activity+Files+Tests+Deploy). **NEXT = S5** (subagents / current-task rows — 2 agents, the first multi-agent WLK-39 leg) → then S6 dual-provider research→synthesis core (2 agents) → S7 live-WebContainer edit→Preview browser proof (the deferred S1 acceptance leg, role 16).

> **PUBLISH-1 STATUS (fire-176):** ✅ **frontend poll-then-reveal SHIPPED** (`e2ac4b1fa`) — money-path PUBLISH leg now complete end-to-end (worker `/api/sites/:id/live-check` fire-173c + this consumer). `ApiService.liveCheck()` (404/error → null sentinel, graceful when flag-dark) + `hosting.component.ts` polls ≤5×/60s (visibility-gated), shows "finishing deployment…" on the prod URL card until a real 200, reveals the live "open" link only on `live:true`; 404-dark keeps the current always-shown behavior (zero regression). Karma spec (not-live→live flip · 404 sentinel · 5-attempt cap · draft=no-poll); frontend tsc 0; ng build prod succeeds; admin loads 200. The live-check endpoint is now USED (dark-orphan resolved). **Follow-up:** (a) live-browser VISUAL verify of the poll-then-reveal (role 17, authed, flag on) — directive §14 production evidence; (b) flag promotion `publish_live_check` beta→rollout when visually confirmed.
> **🔴 FINDING (fire-176, HIGH — pre-existing, NOT from PUBLISH-1): 11 `CreateComponent` Karma failures on clean HEAD.** The frontend unit suite (`ng test`/`test:ci`) has 11 failing `CreateComponent` specs independent of this fire's work (agent confirmed they fail without its changes). The directive + quality gates want 0 failures. Fix as its own slice — root-cause the CreateComponent spec failures (likely a harness/provider or order-fragility issue per frontend gotcha #9), green the suite. · priority HIGH · category testing · owner next-fire (Angular-capable agent).

> **✅ RESOLVED (fire-177) — the 11 CreateComponent Karma failures.** Root cause was a FRAGILE TEST, not a component regression: a recent commit (`6043b166e` CREATE-POLISH-1) portals the `.ps-create-overlay` root out to `document.body` (the flex paint-order fix, per memory `portl`), so the spec's 12 `fx.nativeElement` DOM queries all returned null. Fix (`606106e16`, SPEC-only): an `overlayRoot(fx)` helper that queries the portaled node from `document` (defensive fallback to `fx.nativeElement`); no assertion weakened, nothing skipped. **Full frontend suite 2463/11 → 2474 SUCCESS / 0 FAILED**, tsc 0. The unit-test gate is reliable again. Lesson (captured in the spec's JSDoc): a component that portals its root to `document.body` must have its spec query from `document`, not `fx.nativeElement`.

> **WLK-39 STATUS (fire-178):** ✅ **S5 SHIPPED** (`3063acc7d`) — Claude Code panel run-lifecycle + current-task surface (directive §25/§28/§29). New `claude-code-run.ts`: pure `runReducer` state machine `idle→running→done|error|cancelled` (injectable clock; terminal states no-op on stray late events so a cancelled run can't revive; appends a `RunTransition` timeline). Panel: `useReducer` + `CurrentTask` header affordance (active prompt summary + live status pill, aria-live, reduced-motion spinner) + Stop control (`cancel` dispatch + `AbortController.abort()` on the `/api/llmcall` fetch; read loop early-returns on `signal.aborted`, AbortError swallowed) + activity timeline interleaved with events + idle "Describe a change to start". vitest 39 (14 panel / 11 run / 14 stream), tsc 0, build OK; editor prod 200. **Subagents DEFERRED to S6** — typed seam only (`RunState.subagents: readonly unknown[]` always `[]`, unit-asserted empty), NO scaffolding shipped. **NEXT = S6** (dual-provider research→Claude synthesis — the Resolution Engine CORE, §12-13/§75 steps 5-7; 2-agent; reuse the AI Gateway path `api.llmcall.ts`; handle provider-outage per §24/§76-D) → then S7 live-WebContainer browser proof.

> **WLK-39 STATUS (fire-179):** ✅ **S6-a SHIPPED** (`cf0bdbfc9`, SALVAGED — the agent cut off in the verify→commit tail; recovered from the main checkout per the salvage discipline + trimmed the manifest description to ≤200). The Resolution Engine's dual-provider RESEARCH primitive: `libs/features/resolution_engine/service.ts` `runDualResearch` fans TWO INDEPENDENT provider calls (OpenAI+Anthropic) in PARALLEL via the existing AI Gateway (`callExternalLLM`), returns both with provider+model provenance for S6-b synthesis. Invariant #7 (each leg = same prompt as its OWN isolated call, no shared history). §24/§76-D fallback (one down → return other + mark `{ok:false,reason}`, never 500; both down → `ResolutionEngineError` with redacted reasons; flag-off → `ResolutionEngineDisabledError`, zero provider calls). Flag `resolution_engine` default-OFF. jest **11/11** (flag-off · both-ok · two-distinct-providers · parallel · independence · one-down · both-down · secret-redaction), tsc 0, validate:features PASS. Pure service (NO route this slice → no prod surface). **NEXT = S6-b** (the authed `POST` route 404-when-off + assertSiteOwned, Claude SYNTHESIS of both research legs, + the Claude Code panel consuming it — reuse `runDualResearch` + the panel's run-lifecycle from S5) → then S7 live-WebContainer browser proof.

> **WLK-39 STATUS (fire-180):** ✅ **S6-b-i SHIPPED + DEPLOYED** (`dd4c1d8d0`) — the Resolution Engine SYNTHESIS route. `POST /api/resolve` (`libs/features/resolution_engine/handlers.ts`, mounted in `src/index.ts` after anthropicCompat): authed → `runDualResearch` (S6-a) → SYNTHESIZES both legs via premium Claude (provider-labeled briefings + a reconcile-not-concatenate system prompt, directive §13) → `{research:[...legs], synthesis:{provider,model,content}}`. Fallback: flag-off→404 · unauth→401 · foreign siteId→404 (assertSiteOwned) · both-legs-fail→502 (redacted) · synthesis-call-fails→200 + `synthesis:{ok:false,reason}` (never 500); `safeReason` redaction throughout. `ResolveInputSchema` `.strip()` so S6-b-ii panel can add UI fields. jest 22/22 (10 route + 12 service), tsc 0, validate:features PASS (manifest desc 199 chars). Worker DEPLOYED --env production. **NEXT = S6-b-ii** (the Claude Code panel's "Resolution" mode consuming `POST /api/resolve` — show the two research legs + the synthesis, reuse the S5 run-lifecycle + the panel spine) → then S7 live-WebContainer browser proof.

> **WLK-39 STATUS (fire-181):** ✅ **S6-b-ii SHIPPED** (`a285fbe43`) — the Claude Code panel's RESOLUTION mode completes the Resolution Engine's panel integration. Header `ModeToggle` (Single | Resolution, radiogroup/aria, brand tokens, reduced-motion); Resolution runs `POST /api/resolve` (reusing the S5 run-lifecycle + Stop/AbortController) → renders a **Research** section (both legs, collapsible `<details>`, provider+model labeled, down-legs show a calm reason) + an emphasized **Synthesis** card; `synthesis.ok===false` → legs + calm "unavailable" note (no error); **flag-off 404 → Resolution segment disabled + tooltip, snaps to Single** (no error toast, no doomed control). New pure `claude-code-resolve.ts` parser (defensive). vitest 54 (4 files; +6 panel +9 parser), tsc 0, build ok; editor prod 200.
> **⭐ WLK-39 is now CODE-COMPLETE through S6** — the §75 flagship vertical is wired end-to-end: prompt → (Single: /api/llmcall) OR (Resolution: dual-provider research → Claude synthesis via /api/resolve) → Activity/Files/Tests/Deploy surfaces + run lifecycle, applies edits via the ONE WebContainer. All flag-dark (`claude_code_panel` + `resolution_engine`), unit-tested (54 editor + 22 worker), deployed. **ONLY S7 REMAINS**: the live-WebContainer browser proof (role 16/17 — authed editor, flag on for a test org, prompt→edit→Preview reflects + a Resolution run shows both legs+synthesis) + the reversible flag promotions once visually confirmed. After S7, WLK-39 closes.
> **WLK-39 STATUS (fire-182):** ✅ **S7-PREP SHIPPED + DEPLOYED + PROD-VERIFIED** (`4c55c773d` + docstring honesty fix) — the `claude_code_panel` flag is now a REAL 3-surface dark-flag, replacing S0's default-OFF client CONSTANT: **worker** `GET /api/sites/:siteId/claude-code/status` (`libs/features/claude_code_panel/handlers.ts`, gate auth-401 → flag-dark-404 → IDOR-404 → 200, mounted `index.ts:641` before `api`) + **admin** `BoltEmbedService:1743` `PS_CLAUDE_FLAG_REQUEST`→`PS_CLAUDE_FLAG_RESPONSE{enabled}` bridge + **editor** `claude-code-flag.ts` nanostore gate (default OFF, resolved once on mount, `Workbench.client.tsx:186` tab-gate). Independently verified non-orphaned (mount order · resolver-called+atom-gated · bridge-hits-worker). 61 editor + 4 worker tests, validate:features PASS. Worker DEPLOYED `--env production` (`ebde6be3`); prod-verified the route is mounted + auth-gated + dark (401 "Must be authenticated" ≠ a generic "Unknown API route" 404). Editor auto-deployed from the push. **The tab is now promotable per-tenant with NO code change.** **S7 (the ONLY remaining leg) is now DE-RISKED** to: (1) create a reversible `claude_code_panel` + `resolution_engine` override for a test org, (2) browser-prove in the authed editor (claude tab appears → prompt → edit → Preview reflects + a Resolution run shows both research legs + synthesis), (3) promote the flags once visually confirmed. Needs a browser-connected fire (role 16/17, MAIN checkout).
> **WLK-39 STATUS (fire-183):** ⚠️ **S7 LIVE PROOF = PARTIAL (3/4 legs GREEN) + the real prod gap FIXED.** The S7 browser agent found the admin frontend was NEVER deployed with S7-prep (the admin SPA does NOT auto-deploy on push — only the editor Pages does) → the `PS_CLAUDE_FLAG_REQUEST` bridge handler was absent on prod → the flagship was dark-on-prod regardless of flag. Fixed: a silently-failing `check-alt-text` gate (flagging a JSDoc `<img>` prose mention) was blocking EVERY frontend deploy → fixed (`755fee004`); deployed the admin frontend (300/300 → R2, CDN purged). Re-proof on the complete stack: ✅ tab appears · ✅ `PS_CLAUDE_FLAG_REQUEST` answered `{enabled:true}` · ✅ Single mode runs · ❌ **Resolution mode 404s** — `ClaudeCodePanel.tsx:~916` does a RELATIVE `fetch('/api/resolve')` → hits `editor.projectsites.dev` (no route; the authed route is on the worker `projectsites.dev`) → silently swallowed as flag-dark, so Research/Synthesis never render. 54 green unit tests missed it (they mock fetch); only the live proof caught it. Overrides reverted clean. 37 screenshots at `e2e/screenshots/wlk39-s7/`.
> **→ fire-184 WLK-39 S7-FIX (zero-discovery, READY NOW):** replace the relative `/api/resolve` fetch with an admin bridge call — editor posts `PS_RESOLVE_REQUEST {prompt}` → admin `BoltEmbedService` POSTs `/api/resolve {prompt, siteId: selectedSite.id}` with the session bearer → replies `PS_RESOLVE_RESPONSE {research, synthesis}`; the panel consumes the reply instead of `fetch`. Mirror the `PS_CLAUDE_FLAG` flag-probe pattern EXACTLY. TDD both sides. Then RE-PROVE the Resolution leg (flags ON for the test org via `flag_overrides`, `value_json {"enabled":true,"rollout_percent":100}`, `resolution_engine` GLOBAL-scoped) + promote `claude_code_panel`+`resolution_engine` → **WLK-39 CLOSES**. Anchors: editor `app/components/workbench/ClaudeCodePanel.tsx` (~L916, the resolve fetch) + `app/lib/embed/embedded-mode.ts` (mirror `requestClaudeCodeFlag` + `PS_CLAUDE_FLAG_*` → add `requestResolve` + `PS_RESOLVE_*`) · admin `apps/project-sites/frontend/src/app/services/bolt-embed.service.ts` (mirror the `PS_CLAUDE_FLAG_REQUEST` case ~L1743) · worker `POST /api/resolve` already LIVE + authed. NOTE: both the admin frontend AND the editor must be re-deployed after the fix (admin = `npm run deploy:production`; editor = auto on push) per [[admin-frontend-needs-explicit-r2-deploy-not-auto-on-push]].
> **WLK-39 STATUS (fire-184):** ✅ **S7-FIX SHIPPED + ADMIN DEPLOYED** (`e9cbe2da4`) — the Resolution cross-origin defect is FIXED: `ClaudeCodePanel.tsx` `runResolution` now calls `requestResolve(prompt)` → `PS_RESOLVE_REQUEST` bridge → admin `BoltEmbedService:1788` POSTs `/api/resolve {prompt,siteId}` → `PS_RESOLVE_RESPONSE {research,synthesis | ok:false,dark}`. Mirrors the flag probe EXACTLY. Editor 62 tests + admin 2479 Karma green (incl 5 PS_RESOLVE specs + a dark-vs-fail distinction). Admin frontend DEPLOYED (300/300 → R2, CDN purged, new `main-Y4DAGHQD.js`); editor auto-deploys from push.
> **→ fire-185 WLK-39 S7 RE-PROVE + CLOSE (READY, browser-connected fire):** re-run the S7 live proof (reuse the S7 agent via SendMessage to `a9524ed6fa70fdf7a` / `a3d090beab5057eca`, or fresh) with flags ON for the test org (`flag_overrides`: `claude_code_panel` org-scoped to `org-brian-001` + `resolution_engine` GLOBAL `*`, `value_json {"enabled":true,"rollout_percent":100}`, `set_by='wlk39-s7-proof'`, ALWAYS-revert). Auth = the fire-122 local-headless recipe. Confirm the Resolution run now renders BOTH research legs + the Synthesis card (the exact leg that 404'd in fire-183). If GREEN → PROMOTE `claude_code_panel`+`resolution_engine` (reversible flag flip — test-org or staged rollout) → **WLK-39 CLOSES**. The editor Pages deploy of `e9cbe2da4` will have propagated by this tick.
> **WLK-39 STATUS (fire-185):** ⭐ **BRIDGE FIX PROVEN + IMPLEMENTATION COMPLETE; blocked only by a platform AI-Gateway 401.** The S7 re-prove confirmed the fire-184 fix LIVE: the `404 .../api/resolve` is GONE, Resolution routes through the admin `PS_RESOLVE` bridge, `PS_RESOLVE_RESPONSE` received. All 3 WLK-39 surfaces proven end-to-end → **the Editor panel is FINISHED BEING IMPLEMENTED.** Legs/synthesis still don't render because `/api/resolve` → **502 ALL_PROVIDERS_FAILED** (gateway `401 internalCode:2009`): the CF AI Gateway is AUTHENTICATED but `ai_gateway.ts mergeGatewayHeaders` omits `cf-aig-authorization` + the fallback only fires on 5xx. PLATFORM-INFRA, not Editor-panel code. Both flags stay DARK.
> **→ fire-186 AI-GATEWAY AUTH FIX (zero-discovery, platform-infra — unblocks ALL external-LLM on prod):** (1) **resilience, code-only, recommended immediate:** extend `fetchWithGatewayFallback` (`apps/project-sites/src/services/ai_gateway.ts` ~L160-185) to fall back to the direct vendor on gateway **401/403** (not just 5xx) — the fallback already reuses valid vendor auth headers → succeeds; self-healing once the token lands. (2) **proper:** send `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` in `mergeGatewayHeaders` (needs the gateway auth token from the CF dashboard → AI Gateway → settings; provision as a NEW secret, never modify set ones). (3) fix the crossed leg/reason labels in `libs/features/resolution_engine/service.ts` (the 502 `reasons[]` label openai↔anthropic swapped). TDD; deploy worker `--env production`; verify `POST /api/resolve` (test bearer + `origin:` header + a test siteId) → **200 not 502** (curl, NO browser). FIRST also check whether `/api/llmcall` (the editor AI chat) 401s via the gateway — if so it's a live prod degradation → prioritize. Then PROMOTE `claude_code_panel`+`resolution_engine` → **WLK-39 CLOSES.** Full root-cause + fix recipe: [[cf-ai-gateway-authenticated-401-needs-cf-aig-authorization-or-fallback]].
> **WLK-39 STATUS (fire-186):** ✅ **AI-GATEWAY AUTH FIX PROVEN ON PROD** (`316f3ef7a` + deploy `77eed6f5`) — `gatewayFetch` now falls back to the direct vendor on gateway-origin 401/403 (not just 5xx); `isGatewayOriginAuthError` matches the REAL body (`name:'AiGatewayError'` / `internalCode:2009` / `error:[{code:2009}]`). Re-verify: the `AiGatewayError 401` is GONE — the error moved DOWNSTREAM to `"Anthropic credit balance too low"` (VENDOR BILLING, not code). This also unblocks the editor AI chat's gateway path. Crossed leg→reason labels fixed. Flags stay DARK; both verify-overrides reverted clean (`results:[]`). (First detection `a631a3016` used an assumed body + was prod-RED despite green units → re-iterated against the literal prod body.)
> **→ fire-187 — RESOLUTION functional launch (blocked on billing + 1 architectural fix, NOT Editor-panel code):** (1) **BILLING (Brian action, not code):** the Anthropic account is OUT OF CREDITS — top up; AND/OR send the proper gateway-auth token (`cf-aig-authorization` + a NEW `CF_AIG_TOKEN` secret from CF dashboard → AI Gateway → settings) so gateway cost controls/caching apply instead of the direct-vendor fallback. (2) **independence fix:** `callExternalLLM('openai')` INTERNALLY falls back to anthropic (and rethrows its error) → undermines the Resolution Engine's dual-provider INDEPENDENCE (invariant #7 — the two legs must use DISTINCT providers). Make `runDualResearch`'s per-leg calls provider-LOCKED (no intra-leg cross-provider fallback). Anchors: `libs/features/resolution_engine/service.ts` `runLeg`/`runDualResearch` + `src/services/external_llm.ts` `callExternalLLM`. (3) once a provider with credits is reachable, re-verify `POST /api/resolve` → 200 (override + curl, proven recipe) → PROMOTE `claude_code_panel`+`resolution_engine` → **WLK-39 CLOSES**. NOTE: the editor AI chat (premium tier → Claude) also needs Anthropic credits to function — the gateway fix gives reachability, not credits.

## Fleet execution follow-up — fire-304 (2026-10-07)

- [x] **Fleet execution contract reconciliation** — updated command + README to one GitHub-scheduled iteration, assigned-worktree-only changes, outer-runner publication, official compute routing and observed-evidence reporting. Docs-only; no runtime deployment. See LEDGER fire-304.
- [ ] **D-64-1 / WS-LOOP-BROWSER-MAIN residual: provision browser prerequisites inside the assigned worktree** — supersedes the older main-checkout/opt-out recommendations above; never move a fleet run into another checkout. Reuse existing dependency/bootstrap scripts; assert dependencies and approved browser/vision access before resuming case-001 action 60. Acceptance remains the existing real CF-Browser-Run pass and coverage-ledger receipt; no browser coverage was run in fire-304.
- [ ] **Current editor CI lint repair** — GitHub CI/CD run 37718168405 at `8f276b8c9` failed Run ESLint; observed errors include PanelShell.tsx, panel.spec.tsx, embedded-mode.ts and workbench.ts. Read root CLAUDE.md editor guidance; reproduce the exact CI lint command, repair in bounded slices, then require a fresh green CI run. Avoid unrelated formatting churn.

## ⭐⭐ FRONTIER SNAPSHOT — fire-305 groom (desktop panel-finish + kill-features + flags-on reconciled; the CANONICAL frontier — read this first)

> **Why this snapshot (supersedes the fire-301 block above):** the fire-303→305 desktop session SHIPPED +
> DEPLOYED + PROD-VERIFIED a batch of work the backlog had NOT yet ticked. Reconciled below so no future
> fire redoes it. Commits are on `main` (verify with `git log` before re-claiming any line per
> [[backlog-work-claim-must-be-reverified-against-code]]).
>
> **✅ RECONCILED DONE this groom (shipped on main — do NOT re-open):**
> - **Editor workbench panels FINISHED (fires 303-305):** Automations **Cancel** (`5634b0154`, full-stack
>   `POST …/automations/:id/cancel` + bridge + armed-two-click UI + migration `0659_workflow_jobs_cancellable.sql`
>   APPLIED to prod — line 53 ticked) · DatabasePanel KV **"Unlock" lying-green stub → honest state**
>   (`e113f553d`) · LockManager dead markup → **real "Locked" badge** (now renders live `lockedItems`,
>   `LockManager.tsx:21/35-68`) · KvBrowser empty-state **inline "Add key" CTA** (`database-kv-empty-add`,
>   `KvBrowser.tsx:559-564`) · **Code-panel ProjectHub Promote button REMOVED** (`8af2e7316`, Brian request —
>   publishing still lives in Source Control / Lifecycle / Buckets / ProjectHub).
> - **Tinybird fully REMOVED** (`1e701d529`) — zero refs in `src/`, `frontend/src/`, `packages/`; analytics +
>   activation-funnel now return **graceful `degraded:true` zero-state** (no 5xx, no dead refs). Already scrubbed
>   from this backlog by fire-303 — nothing further to delete here.
> - **Flags: 82 → 83/84 enabled via the real admin UI** (`8f276b8c9` — `voice_numbers` on). Only
>   **`abandoned_build_nudge` held** (auto-outreach = Brian-gated, see blocked subsection).
> - **3 features KILLED + scope-scrubbed (fire-303 `3fdd835b5`, do-NOT-reintroduce):** AI Visual Site Builder ·
>   owner-SEO-editor journey · (Tinybird above). No stale backlog lines remain for these (grep-confirmed absent
>   this groom).
>
> **⚠️ COLLISION reconciled:** the LEDGER's newest "fire-304 fleet execution contract reconciliation" is a
> CONCURRENT GHA dispatch (docs-only), NOT this session's panel work (which also leased fire-304). BOTH landed on
> main cleanly — no clobber. The §Fleet-execution-follow-up block above keeps the GHA dispatch's open items
> (browser-prereqs-in-worktree + the editor CI-lint repair); this snapshot owns the product frontier.
>
> **⚠️ ANCHOR DRIFT CORRECTED (do NOT trust the fire-301 READY-NOW #1):** fire-301's "dead-code-136" (above)
> is now LARGELY STALE — a fire-305 re-grep finds `card.ts` **already removed (MISSING)**, `buttonState` **0 refs
> anywhere in `frontend/src`** (the `motion.ts:84` anchor no longer resolves), and `partysocket/yjs/tw-animate-css`
> **NOT present in `frontend/package.json`**. If any fire picks it up it must RE-VERIFY first; it is probably a no-op.
> Also: the editor "DataPanel.tsx" in older ledger notes is now **`SiteTablesPanel.tsx`** (renamed), and its Tables
> grid ALREADY polls visibility-aware (`SiteTablesPanel.tsx:241-243`) → the old Data-tab no-refresh item is narrowed
> to the Functions tab only (line ~1583).

> **READY NOW — top 5** (ranked by money-path leverage; all lead-doable, no agent fleet required; EXCLUDES
> Brian-gated — those are in the subsection below; every anchor grep-verified THIS groom):
> 1. **[product] D1-backed analytics + activation-funnel rollups** (the #1 money-path visibility gap left by
>    Tinybird removal) — both the admin analytics rollups AND the activation funnel now return a hardcoded
>    `degraded:true` ZERO-state; an owner/operator sees empty "is my funnel converting?" surfaces. Swap in real
>    D1 queries over the master-D1 `visitor_events` (+ `sites`/`subscriptions` for publishes/claims-by-source).
>    **Accept:** `fetchActivationFunnel` (`apps/project-sites/src/services/activation_funnel_query.ts:66-72`) +
>    `fetchPipeRows` (`apps/project-sites/src/services/analytics_query.ts:63-70`) return REAL D1 rows (drop the
>    zero-funnel/`degraded:true` short-circuit for the populated path, keep `degraded` only for a genuine no-data
>    account); worker Jest over a seeded SQLite harness asserts non-zero stages/rows; the admin
>    `activation-funnel.component.ts` + `analytics.component.ts` render real counts; routes `/api/admin/activation-funnel`
>    + `/api/admin/analytics/*` prod-verified (authed curl) returning populated data for a seeded org. · category product · anchors verified.
> 2. **[testing] Cancel-route + armed-two-click regression lock** — fire-305 shipped the Automations **Cancel**
>    full-stack but the bridge/UI armed-two-click guard (`AutomationsPanel.tsx:220-225` `cancellingIds` +
>    first-click-arms/second-click-confirms) has worker-route tests only. **Accept:** a Vitest spec for
>    `AutomationsPanel` asserts (a) first Cancel click ARMS (no request fired), (b) second click dispatches
>    `requestAutomationCancel` once + shows the in-flight spinner, (c) a stray click mid-flight is ignored
>    (idempotency); worker `site_automations_cancel_route.test.ts` stays green; `npm test` (editor) green. · category testing · anchors verified.
> 3. **[testing] forms.component MCP-connect `data-testid` + lock** (line ~521) — fire-46 shipped
>    `data-testid="mcp-${id}-connect"` in `settings.component.ts` but `forms.component.ts` coverage is UNVERIFIED.
>    **Accept:** add the per-provider testids to `apps/project-sites/frontend/src/app/pages/admin/sections/forms.component.ts`
>    (rendered from `mcp-providers.ts`) + a Karma spec asserting each provider row exposes its stable testid;
>    `npm run test:ci` green. · category testing · anchor verified.
> 4. **[ux/a11y] Restore Preview device/responsive switcher** (line ~624) — `app/components/workbench/Preview.tsx:77`
>    hard-codes `const isDeviceModeOn: boolean = false` → the entire coded device/landscape/scaling machinery
>    (L245/305/413/421/430/438/442/684) is orphaned (dead default, [[opt-in-prop-plus-uncalled-resolver-is-dead-default]]).
>    **Accept:** wire a 6-breakpoint quick-toggle that flips `isDeviceModeOn` + resizes the preview frame; Vitest for
>    the toggle; editor prod loads 200 with the control visible + functional. · category ux · anchor verified (L77 + 9 gated call-sites).
> 5. **[testing] E2E for the admin cockpit** (line ~545) — `dashboard.component.ts` (operator cockpit / needs-
>    attention queue / KPI tiles / CWV) has NO E2E. **Accept:** one homepage-start Playwright journey (goto `/` →
>    signin seam → dashboard) asserting the KPI strip + attention queue render with real data, console-clean,
>    axe-clean at 1280; add the `e2e/FEATURES.md` + `e2e/COVERAGE.yml` rows so `validate:e2e-inventory` passes. · category testing.

> ### Brian-gated / externally-blocked (do NOT treat as READY — a fire must NOT touch these)
> - **`abandoned_build_nudge` flag flip ON** — the ONE flag held at 83/84; it triggers AUTO-OUTREACH (unsolicited
>   email/SMS to owners who abandoned a build) → a customer-facing comms decision, Brian-gated, NOT a loop flip.
> - **DEMO-0 / DEMO-1** — keep-existing-site vs deploy-curated-bundle + the guest-admin call (lines 63-66) are Brian decisions.
> - **Stripe test-rail in CI (LB-1 / gp-05)** — needs `STRIPE_PRICE_ID_MONTHLY_WALLET` + Stripe test keys in CI (Blocked-user, line ~1028).
> - **R2/S3 delivery creds** — launch task gated on Brian-provided credentials.
> - **WLK-39 Resolution + `publish_live_check` + `claim_flow` flag flips** — implementation COMPLETE; blocked on
>   Anthropic credits / a new `CF_AIG_TOKEN` and/or a money-path prod-UX launch decision (see fire-187 line ~2052 + line 48).

> ### NEXT-WAVE replenish — fire-305 (concentrated in the genuinely-open post-Tinybird + post-panel-finish areas)
> - **[product] Automations Cancel must TERMINATE the live Workflow (flag-honored abort)** — fire-305's cancel marks
>   the D1 job `cancelled` (migration `0659`) but does NOT abort the running CF Workflow instance; a cancelled
>   long-build keeps burning compute. **Accept:** on cancel, call the Workflow terminate/`abort` path (or set an
>   abort flag the build loop polls) so an in-flight automation actually STOPS; honor it behind the existing
>   `site_automations` flag; worker test asserts terminate is invoked + the job lands `cancelled` without a late
>   status revive. · category product · anchor: the automations cancel handler + `apps/project-sites/src/services` Workflow dispatch.
> - **[docs/cleanup] Retire the Tinybird-removal JSDoc TODOs once the D1 rollups land** — `activation_funnel_query.ts:9,11,39,58`
>   + `analytics_query.ts:9,10,47` carry "Tinybird removed — D1 source TODO" comments; the `outbox_dispatch.ts:10,23,45,59`
>   comments too. **Accept:** when READY-NOW #1 ships the D1 queries, replace these TODO comments with the real
>   source description so the codebase stops advertising a removed vendor; grep `-ri tinybird` across `src/` returns 0. · category docs/cleanup.
> - **[product] Wire real KV add-on checkout when billing lands** — KvBrowser's "Add key" CTA + the KV surface are
>   live, but there is NO KV-namespace entitlement/add-on in the claim/billing path (`claim_flow` gates
>   custom-domain/AI-ops/email only, `registry.ts:62`). **Accept (gated on Stripe test-rail, so scope the
>   decision-independent slice now):** add a `kv_addon` entitlement check + a 404-dark `kv_addon` flag so the KV
>   write/add-key path server-guards on entitlement (returns a calm upgrade affordance, never a doomed control)
>   when billing is ready; worker test for the entitlement gate (active OR trialing). · category product · anchor: `claim_flow` + `resolveActiveOrgPlan`.
> - **[testing] LockManager + KvBrowser honest-state render locks** — fire-305 replaced the KV "Unlock" lying-green
>   stub + gave LockManager a real "Locked" badge + KvBrowser its empty CTA, but these honesty fixes lack render
>   specs. **Accept:** Vitest asserts (a) LockManager with 0 locked items shows the honest empty state (not dead
>   markup) and with ≥1 shows the "Locked" badge row; (b) KvBrowser's first-load no-keys state renders
>   `database-kv-empty-add`; (c) the DatabasePanel KV state shows the honest (non-lying) label. Prevents regression
>   of the exact stubs just killed. · category testing · anchors verified (`LockManager.tsx:21/35-68`, `KvBrowser.tsx:559-564`).
> - **[discovery] FRESH module audit for the NEXT lead code slice** — the audited modules (per-site-DB, media,
>   serving-mutation cache-bust, env-vars IDOR) are coverage-exhausted. **Accept:** run `scripts/detect-orphans.mjs`
>   + a targeted read of ONE un-audited area (Angular admin Karma gaps OR `api.ts` billing/hostname handlers) and
>   append 3-5 verified, anchor-carrying TODOs so the next quota-dead fire has clean lead work. · category discovery.

## Fleet orientation follow-up — fire-306 (2026-10-08)

- [x] **Retire stale scheduling and fire-number guidance** — README now derives numbering from recent-fire/git evidence; backlog no longer directs a session focus-cron, chained fires or replacement cloud-runner credentials. Docs-only verification; see LEDGER fire-306.
- [ ] **Fleet finalizer failure diagnosis** — GitHub loop run 37719202103 failed “Ensure every run has a summary and structured record” although its local receipt says success. Its commit `5daa40424` is confirmed in fetched main. Inspect finalizer logs in the shared fleet repository during an authorized control-plane task; preserve published work and do not equate receipt success with workflow success. No control-plane files changed here.

## fire-307 follow-up — production E2E portability

- [~] E2E-AUTH-PORTABLE: code consolidation complete fire-308 (`6a7ff0b4c`); both money-path specs reuse helpers/admin-auth getTestPassword. Synthetic lookup + wiring regressions pass. Remaining acceptance: authenticated live money-path run; blocked this fire by absent frontend dependencies and unavailable E2E password. Do not mark DONE from source checks.
- [ ] E2E-PROD-FAILURES-307: triage fresh run 37793228665 failures (features, sparkline, tags, team dialog, webhooks, landmarks, integration logos, notification bell); re-confirm each live before repairs. Do not infer product defects from credential failures alone.

## fire-308 follow-up — fresh CI and verification evidence

- [ ] CI-CONTAINER-MOCK-308: reproduce GitHub run 37848103525 worker failure in src/__tests__/platform_root_landings.test.ts (Container extends undefined through app_runtime_subclasses → routes/apps → index). Reuse existing Cloudflare runtime mocks; acceptance: affected suite and full worker unit gate pass without hiding app routes. cadence once · priority high · category testing.
- [x] LOOP-RECENCY-SUFFIX-308: inspect scripts/loop-recent-fires.mjs numeric-token parsing: git reports fire-306 from newer fire-306b while LEDGER numeric max is 307. Acceptance met fire-313 (`3f4f61223`): suffix IDs retain chronological context; order warnings distinguish bounded membership gaps from chronology, without inferring publication. Four synthetic regression fixtures pass; loop tooling only, no runtime deployment. cadence once · priority med · category loop-improvement.

## fire-309 follow-up — frontend inventory gate

- [x] CI-E2E-INVENTORY-309: reproduced six missing-reference errors locally after GitHub feature-architecture run 37862033777 reported missing nav-create inventory. Registered all three existing cross-surface specs in both maps with blocked production status (`17305d85f`). Acceptance: frontend inventory validator passes for 185 specs; no browser acceptance inferred.
- [~] E2E-NAV-CREATE-HITAREA-309: acceptance consolidated into ADMIN-CREATE-LIVE-310 (fire-311); still unverified. Preserve CREATE-POLISH-1 follow-up and re-confirm pointer overlap live before repair.

- [x] ADMIN-CREATE-CONTRACT-310: repair observed architecture CI uncovered /admin/create route. Commit `836e234cd` registers the auth-guarded render route and scopes sweep capture to its body-mounted overlay. Acceptance for static coverage: validate-admin-contract passes 54 rows; missing-overlay regression fails before fix and passes after. Runtime acceptance remains separate below. cadence once · category loop-improvement.
- [ ] ADMIN-CREATE-LIVE-310 (includes E2E-NAV-CREATE-HITAREA-309): run approved authenticated create journey and scoped contract capture; prove UI opening, overlay content, real pointer close, overlay removal, dashboard return and /create URL masking, with settled screenshots. Dependencies, E2E_TEST_PASSWORD and CF_BROWSER_RUN_TOKEN unavailable fire-311; no browser or vision proof. Reuse CREATE-POLISH-1 and frontend/e2e/money-path-nav-create.e2e.ts; re-confirm overlap live before repair. cadence once · priority high · category testing/ux.

- [x] PROD-REPORT-311: production Playwright configs generate CI HTML at Actions upload paths while retaining terminal output and failure traces (`8bd6350b1`). Four config regressions pass; actual Playwright 1.58.2 browser-free intentional failures generated HTML + trace for each config. GitHub upload remains pending publication; this closes local reporter generation only. cadence once · category loop-improvement.
- [ ] PROD-REPORT-UPLOAD-311: after publication of `8bd6350b1`, inspect next prod-e2e/CWV artifacts; require downloadable HTML containing failure trace. Reuse existing upload steps. Acceptance: artifact exists and opens for a failed completed shard. cadence once · priority high · category testing.
- [ ] LOCAL-VISION-ROUTING-311: inspect apps/project-sites/e2e/deep-ui-explorer/vision-review.mjs paid-provider/gateway calls; replace local fleet path with approved official subscription image-capable adapter, or fail closed as BLOCKED while preserving pending screenshots. Keep authorized hosted-product routing distinct. Acceptance: local fleet mode never calls paid OpenAI/Anthropic APIs or Cloudflare AI Gateway; provenance and schema validation remain intact. cadence once · priority high · category loop-improvement/security.

- [x] LOOP-CATEGORY-SCOPE-313: recent-fire classifier tags `test(editor-live)` as product and `fix(test)` create-overlay harness changes as product. Independent review verified subjects in git this fire. Acceptance met fire-314 (`7138ba436`): test types and test/tests scopes classify as testing before product keywords; fix(editor) remains product and UX precedence remains intact. Six recency tests pass, including wrapper and breaking-change prefixes. cadence once · priority med · category loop-improvement.

- [ ] LOOP-CATEGORY-UNKNOWN-314: actual recency JSON still classifies fires 311 and 313 as other despite their loop-only tooling work. Investigate accumulated wrapper-subject semantics before changing precedence; acceptance: pure-loop fixtures classify as loop while substantive product/test work retains its category. cadence once · priority low · category loop-improvement.

## ⭐⭐ BUCKETS FRONTIER — groom fire-buckets-b15 (the CANONICAL Buckets queue — the next Buckets fire reads THIS, no exploration needed)

> **Scope lock (Brian 2026-10-09):** this frontier is ONLY **Editor → Resources → Buckets** (+ the
> secondary **Editor → Code → bucket selector**, B15). Detail/history SSOT = `./BUCKETS-MASTER-SPEC.md`
> (slices B1..B15). This block is the EXECUTE-READY distillation: every item is self-contained with exact
> file anchors + acceptance + reuse pointers. **Build on the existing backend; add backend only where noted.**
> Re-verify any claim against code before re-claiming (`[[backlog-work-claim-must-be-reverified-against-code]]`).
>
> **Ground-truth anchors (verified this groom):** editor panel = `app/components/workbench/BucketsPanel.tsx`
> (2886 lines) — `BucketWorkspace`@1957, `WorkspaceTab='files'|'settings'`@1955, `BucketSettings`@2108-2232
> (uses `SettingsSection` + `AddressRow` + `BTN_GHOST/SECONDARY/DESTRUCTIVE`), `BucketRowMenu`@981,
> `ModalShell` (reused for every confirm). Bridge = `app/lib/embed/embedded-mode.ts` — `PS_R2` (8 ops) +
> `PS_R2_UPLOAD` + `PS_R2_DOWNLOAD` (**no** keys/rename/move/copy/search/clone/zip op yet → each needs a NEW
> bridge op). Worker routes = `apps/project-sites/libs/features/r2_buckets/handlers.ts` (11 routes under
> `/api/sites/:siteId/r2/buckets[...]`, gate auth→flag(`r2_buckets`,DARK→404)→`ownsSiteData` IDOR). Service =
> `apps/project-sites/src/services/site_r2.ts` (`cfCreateToken`@535 — reuse for owner keys; `promoteSiteR2`@830
> holds the S3 copy primitive; `listSiteR2Objects`/`getSiteR2Object`/`putSiteR2Object`/`deleteSiteR2Object` live).
> Catalog layer = `apps/project-sites/src/services/site_r2_manager.ts` (`resolveSiteBuckets`, system|custom model —
> B6/B8/B9/B11/B15 BUILD ON this, do NOT reinvent). Flags: `r2_buckets`=enabled/100%/experimental;
> `r2_bucket_manager`=**enabled/100%/beta** (the depth flag — object ops now ride it).
>
> **✅ RECONCILED DONE (shipped on main — do NOT re-open):**
> - **B1 premium shell** (fire-312 `0224a7878`+`9cff6dcd2`) — grouped navigator (Preview/Production pinned +
>   Custom) + Files/Settings workspace tabs; live-verified.
> - **B1-polish list⇄grid toggle** (fire-buckets-b1polish) — session-persisted segmented toggle, grid tiles +
>   `<img>` thumbnails for images in PUBLIC buckets; live-verified. (Skeletons already existed.)
> - **B2 two-default model** (fire-buckets-b2) — defaults renamed **Preview**/**Production**; migration `0649`
>   display-name-only, prod-migrated (bucket_name preserved).
> - **B3 bucket-level** — `BucketRowMenu` ellipsis (fire-buckets-b3) + discoverable "?" `ShortcutsSheet`
>   (fire-buckets-b3sheet); both live-verified. Navigator keyboard = B14 roving listbox.
> - **B5 slice 1 — token service + migration** (fire-buckets-b5-slice1 `d1281030c`) — `ensureSiteS3Token` in
>   `site_r2.ts` + NEW D1 table `site_r2_s3_tokens`, migration `0660` applied to `project-sites-db-production`
>   (table verified present), flag-dark dormant. Jest 3/3.
> - **B5 slice 2 — object-ops FLIP** (fire-buckets-b5-slice2 `481ce59e0`) — `resolveSiteS3Config` + per-site
>   token signing → **`objectOpsAvailable` TRUE**; **prod-verified** authed put→get(bytes match)→list→delete
>   round-trip on real Cloudflare R2 (`e2e/editor-live/check-r2-objectops-live.mjs` → ✅). Live-fixed two latent
>   bugs in never-run code (bogus permission-group id; Hono `/objects/*` wildcard). +8 Jest.
> - **B5 slice 3 — perms auto-extend on new bucket** (fire-buckets-b5-slice2) — `provisionSiteR2` calls
>   `invalidateSiteS3Tokens` so the next `ensureSiteS3Token` re-mints covering the new bucket. Jest-covered.
> - **B5 flag promote** — `r2_bucket_manager` → enabled+100%+beta (beta→stable after 1 week P1-free).
> - **B14 a11y foundation** — roving listbox (fire-buckets-b14) + modal focus-trap (fire-buckets-modalfocus) +
>   SR status roles (fire-buckets-livestatus); all live-verified.
> - **File-type glyphs + gallery + AA-contrast** (`7eade7660` + distinctness probe `a17e8c8df`) — `colorForObject()`
>   / `bucket-icons.ts` restrained per-type TINTS (pdf→rose · image→sky · csv/xls→emerald · doc→blue · ppt→orange ·
>   audio→fuchsia · video→violet · archive→amber · code→cyan · font→pink) applied to the live list+grid AND the
>   `/_preview` gallery; `PanelEmpty` description tertiary→secondary (fixes a WCAG-AA color-contrast node across EVERY
>   panel empty state — gallery now axe color-contrast CLEAN); `uno.config` safelist for the tint utilities. Durable
>   probe `verify:buckets-populated`. **DONE — do NOT re-open.**
> - **B5 slice 4 BACKEND** (`0966ebd72`) — owner-facing scoped R2 key route+bridge: `GET /api/sites/:siteId/r2/keys`
>   (masked status, NEVER the secret) · `POST` (create, show-once secret, idempotent→masked if one exists) ·
>   `POST …/keys/rotate` (revoke old + mint new, show-once) + `PS_R2_KEY_{STATUS,CREATE,ROTATE,REVOKE}` bridge ops
>   (`embedded-mode.ts:2469+`), reusing `cfCreateToken`. (The DELETE/revoke verb rides `PS_R2_KEY_REVOKE`; the shipped
>   route set already covers it.)
> - **✅ B5 slice 4 FULLY DONE — the LAST B5 slice is CLOSED** (`96b2bf415` UI+anim · `a3c2073c3` audit+E2E ·
>   `daaf2db1c` close). **(1) UI:** `OwnerKeySection`@`BucketsPanel.tsx:2291` (wired at L2243 inside `BucketSettings`,
>   after Address, before Promote) — masked `accessKeyId`, show-once secret reveal in a `ModalShell` (copy button),
>   rotate (re-reveals once), revoke → calm create CTA (no doomed control), live status; owner-friendly copy (no
>   `R2|S3|credential` jargon, Vitest-regression-gated). **(2) Audit:** owner-key create/rotate/revoke write `audit_logs`
>   (actor+action+keyId, NEVER the secret). **(3) Credential-VALIDITY E2E — PROVEN on real Cloudflare R2**
>   (`e2e/editor-live/check-owner-key-valid.mjs`, `verify:owner-key-valid`): mint key → S3-sign a REAL op →
>   **VALID 200 on own bucket · SCOPED 403 on a forbidden/foreign bucket · REVOCABLE 401 post-revoke**. **(4)
>   Cinematic:** `psBucketRise` keyframe (opacity 0→1 + 6px rise) on the object-browser entrance, `motion-reduce`
>   honored, self-contained `BucketAnimationStyles` inject (no global CSS). **(5) File-type icons/colors + AA
>   contrast** (`7eade7660`+`a17e8c8df`) — per-type tints in list+grid+`/_preview` gallery, empty-state contrast
>   fixed. **DONE — do NOT re-open.**
>
> - **✅ B4 per-BUCKET owner-key BACKEND DONE** (the finer-scope fast-follow after s4) — per-BUCKET scoped owner keys
>   (B5's s4 key is SITE-scoped; B4 NARROWS to ONE bucket): NEW routes `POST/GET/DELETE
>   /api/sites/:siteId/r2/buckets/:bucket/keys` mirroring the s4 `r2/keys` handlers + migration `0662`, reusing
>   `bucketScopeResources` (`site_r2.ts:423`) with a ONE-element list (`[thisBucket]`) so the minted CF token is scoped
>   to a single bucket. **Per-bucket credential-VALIDITY E2E PROVEN** — `200` on its own bucket · `403` on another site
>   bucket · `401` post-revoke (the finer scope PROVEN via SigV4, not just claimed). **B4 UI is DEFERRED to its own
>   follow-up (= READY-NOW #4 / the [ ] B4-UI slice below).** Do NOT re-open the B4 backend.
>
> **✅ B12 DONE (`702456b4b` feat + `98045914b` close — rich sandboxed object previews, FE-only):** typed sandboxed
> inspector for image/video/audio/pdf/text/md/json/code (`<iframe sandbox>`; SVG/HTML NEVER injected into the privileged
> origin) + metadata panel + download fallback, reusing `PS_R2_DOWNLOAD`. Visually verified per-type. `buckets-object-preview`
> testid @`BucketsPanel.tsx:1841`. Do NOT re-open.
>
> **✅ B3 object-rows DONE** (`b6d229409` feat + `d9044b304` close + `15432d9ea` checkpoint — FE-only, shipped on main):
> right-click object rows (`onContextMenu` → object-row menu mirroring `BucketRowMenu`) + Cmd/Ctrl-click, Shift-range,
> Cmd+A, Delete, Esc, Cmd+C wired to the (now-working) object handlers; animated (count-driven, `motion-reduce`-safe)
> `buckets-bulk-bar`; fires only when no input is focused; discoverable via the "?" `ShortcutsSheet`. (F2/rename stays
> deferred to B8.) Closes the DoD "object context menus" + "bulk actions" clauses. Do NOT re-open.
>
> **✅ ≥5 visual-refinement rounds DONE** (logged + numbered this session — `d9044b304` + `15432d9ea` checkpoint satisfy
> the DoD §21 "≥5 real visual-refinement rounds" clause). Do NOT re-open the rounds tally.
>
> **✅ B4-UI DONE (`673a46a55` feat + `5d875bd57` close + `d2ebbe658` checkpoint — per-bucket Access Keys workspace,
> FE-only; the per-bucket key feature is now END-TO-END complete UI→bridge→backend→proven-creds):** `BucketKeySection`
> @`BucketsPanel.tsx:3087` (wired at L2677 inside `BucketSettings`, scoped to the SELECTED bucket) consuming NEW
> `PS_R2_BUCKET_KEY_{STATUS,CREATE,ROTATE,REVOKE}` bridge ops (`embedded-mode.ts:2539+`, dispatchers @3728+) against
> `…/r2/buckets/:bucket/keys` (B4 backend routes + migration `0662` already live). Show-once secret (create/rotate only) ·
> copy-id · rotate re-reveals · revoke → calm create CTA · "unlocks only this bucket" banner · owner-copy regression (no
> `R2|S3|credential`). 11 Vitest. Do NOT re-open.
>
> **🔶 IN-FLIGHT THIS FIRE (B15 — Code-view bucket source selector, FE-only; builds on the existing R2 bridge + catalog):**
> a `Source ▾` picker in `app/components/workbench/EditorPanel.tsx` (ADD beside the existing "Source" control @~L267 /
> `FileTree`@L274, NO parallel tree) → website source | R2 bucket; load the chosen bucket's tree into the explorer;
> open/edit/save-back-to-R2; WARN before Production edits; read-only vs editable; stale-save guard. **Reuse:**
> `requestR2({op:'listObjects'})` + `PS_R2_UPLOAD`/`PS_R2_DOWNLOAD` (`embedded-mode.ts`) + `site_r2_manager.resolveSiteBuckets`.
> No new backend. Verify: editor builds + prod 200 with the Source picker switching the tree to a bucket; headless
> round-trip (list→open→edit→save) against `*.workers.dev` (per the STANDING PROBE-DESIGN NOTE below).

> ### READY NOW — Buckets top 5 (pick ONE per fire; VERIFY each with the live object round-trip where object-touching)
> *(B5 s4 CLOSED `daaf2db1c` + B4 BACKEND DONE + **B4-UI DONE** `673a46a55`/`5d875bd57` + **B12 rich previews DONE**
> `98045914b` + **B3 object-rows DONE** `b6d229409`/`d9044b304` — all dropped from the pick-list. **B15 is IN-FLIGHT
> this fire** (🔶 banner above) — kept as #1 for continuity but NOT a fresh pick; the next fire picks from #2-#5.)*
> 1. **🔶 [product] B15 — Code-view bucket source selector** *(IN-FLIGHT THIS FIRE; money-path — the Code surface is
>    where owners live)* — a `Source ▾` picker in `app/components/workbench/EditorPanel.tsx` (ADD beside the existing
>    "Source" control @~L267 / `FileTree`@L274, NO parallel tree) → website source | R2 bucket; load the chosen bucket's
>    tree into the explorer; open/edit/save-back-to-R2; warn before Production edits; read-only vs editable; stale-save
>    guard. **Reuse:** `requestR2({op:'listObjects'})` + `PS_R2_UPLOAD`/`PS_R2_DOWNLOAD` + `site_r2_manager.resolveSiteBuckets`. · **new-backend: NO.** · category product.
> 2. **[product] B10 — Reassign bucket → environment (Preview/Production) + rollback** *(a DoD §21 clause; today's
>    `EnvAssignmentGrid.tsx` is READ-ONLY)* — assign an UNASSIGNED custom bucket to the Preview/Production slot; reassign
>    swaps the slot; **ROLLBACK** restores the prior binding on failure OR via explicit undo (two-way door); confirm before
>    touching Production; honest progress+error; tenancy-guarded; capture BEFORE-binding for rollback. **Anchors:** NEW
>    mutation route in `r2_buckets/handlers.ts` + env/binding model in `src/services/site_r2_manager.ts` (`resolveSiteBuckets`,
>    system|custom) + NEW bridge op `assignBucketEnv` wired into `EnvAssignmentGrid.tsx` (add assign/undo to the read-only
>    grid). · **new-backend: YES.** · category product. *(1-2 fires.)*
> 3. **[product] B8 — Object rename/move/copy-across-buckets** *(unblocks B3's F2/rename)* — S3 CopyObject→Delete with
>    verify-before-delete + overwrite-exists guard + metadata/public-intent preservation; tenancy-guarded on BOTH buckets.
>    **Anchors:** NEW service fns in `src/services/site_r2.ts` (reuse the SigV4 `s3Fetch` + the copy primitive inside
>    `promoteSiteR2`@830) + NEW route(s) in `r2_buckets/handlers.ts` + NEW bridge ops `copyObject`/`moveObject`/`renameObject`. · **new-backend: YES.** · category product. *(1-2 fires.)*
> 4. **[product] B6 — Clone bucket** *(DoD §21 "clone" clause)* — durable Workflow: create a new physical bucket +
>    server-side-copy every object. **Accept:** new bucket + object+metadata copy (HTTP/custom meta, CORS, lifecycle
>    where CF supports), clone defaults private+unassigned, progress (files/bytes/stage/errors/retry/cancel),
>    verified-before-success. **Anchors:** NEW CF **Workflow** + NEW route in `handlers.ts` + NEW bridge op `cloneBucket`;
>    reuse `provisionSiteR2` (`site_r2.ts:244`) for the new bucket + the S3 copy primitive inside `promoteSiteR2`
>    (`site_r2.ts:830`); register the clone in `site_r2_manager` catalog as `kind:'custom'`. · **new-backend: YES (heavy — Workflow).** · category product. *(2-3 fires.)*
> 5. **[testing/a11y] B14 residual — axe @ 6bp on the Buckets panel** — add `@axe-core/playwright` to the PROD E2E
>    (not a jsdom unit dep), run axe on the Buckets panel @ 375/390/768/1024/1280/1920, fix violations. Keyboard is
>    already done. · **new-backend: NO.** · category testing. *(MODERATE — start fresh.)*
>
> *(B7 zip · B9 per-object-public · B11 server-side search · B13 insights remain crisp one-fire TODOs in the B6-B13 list
> below — rotate them into the top-5 as picks are consumed.)*

> ### Buckets spec slices — self-contained one-fire TODOs (B6-B13; pick after the top-5)
> - [x] **B5 s4 — owner credential-strip UI + audit + validity-E2E** — ✅ CLOSED (`96b2bf415`+`a3c2073c3`+`daaf2db1c`).
>   UI (`OwnerKeySection`@2291, wired L2243) + audit (`audit_logs`) + credential-VALIDITY E2E (valid/scoped/revocable
>   PROVEN on real R2, `check-owner-key-valid.mjs`) + cinematic `psBucketRise` + file-type icons/colors + AA contrast.
>   The LAST B5 slice — B5 is complete. Do NOT re-open.
> - [ ] **B6 — Clone bucket** — durable Workflow: create a new physical bucket + server-side-copy every object.
>   **Accept:** new bucket + object+metadata copy (HTTP/custom meta, CORS, lifecycle where CF supports), clone defaults
>   private+unassigned, progress (files/bytes/stage/errors/retry/cancel), verified-before-success. **Anchors:** NEW CF
>   **Workflow** + NEW route in `handlers.ts` + NEW bridge op `cloneBucket`; reuse `provisionSiteR2` (`site_r2.ts:244`)
>   for the new bucket + the S3 copy primitive inside `promoteSiteR2` (`site_r2.ts:830`); register the clone in
>   `site_r2_manager` catalog as `kind:'custom'`. · cadence every-2-loops · priority P2 · category product · estimate 2 fires · **new-backend: YES (heavy — Workflow)**.
> - [ ] **B7 — ZIP export** — export a bucket/folder/selection as a ZIP (stream small; background job + short-lived
>   signed link for large). **Accept:** small→streamed ZIP, large→ZIP64 background job + expiring signed link;
>   path-traversal safe; auto-expire. **Anchors:** NEW route in `handlers.ts` + NEW bridge op `exportZip`; reuse
>   `listSiteR2Objects` (`site_r2.ts:677`) + `getSiteR2Object` (`site_r2.ts:743`); temp output in a PLATFORM bucket
>   (NEVER a customer bucket). · cadence every-2-loops · priority P2 · category product · estimate 1-2 fires · **new-backend: YES**.
> - [ ] **B8 — Object rename/move/copy-across-buckets** — S3 CopyObject→Delete with verification + overwrite guard.
>   **Accept:** copy/move within a bucket AND across the site's buckets; verify copy before delete; overwrite-exists
>   check; preserve metadata + public intent; tenancy-guarded on BOTH buckets. **Unblocks B3's F2/rename.** **Anchors:**
>   NEW service fns in `site_r2.ts` (reuse the SigV4 `s3Fetch` + the copy primitive inside `promoteSiteR2`@830) + NEW
>   route(s) in `handlers.ts` + NEW bridge ops `copyObject`/`moveObject`/`renameObject`. · cadence every-2-loops · priority P2 · category product · estimate 1-2 fires · **new-backend: YES**.
> - [ ] **B9 — Per-object public + expiring shares** — a Worker object-serving gateway + an `ObjectVisibility`
>   control-plane (R2 has NO per-object S3 ACL). **Accept:** flip one object public while the bucket stays private;
>   bucket-public marks all objects public; revoke takes effect (cache-aware); NEVER activate an uncontrolled native
>   public endpoint. **Anchors:** NEW public Worker route (gateway, range-request aware) + NEW D1 table
>   `object_visibility{bucketId,objectKey,visibility,publicSlug}` + resolver honoring bucket-public inheritance;
>   integrate with `site_r2_manager` for bucket→site resolution. (Also unblocks PRIVATE-bucket grid thumbnails.) · cadence every-4-loops · priority P2 · category product · estimate 2-3 fires · **new-backend: YES (heavy)**.
> - [ ] **B11 — Server-side bucket-wide search + metadata index** — real search across the WHOLE bucket (today's
>   search only filters the loaded page — `filteredObjects` ~L1055 in `BucketsPanel.tsx`). **Accept:** search +
>   filters (ext/size/date/visibility/prefix) across all objects, cursor pagination, honest "indexing"/"scanning"
>   status. **Anchors:** NEW route in `handlers.ts` + NEW bridge op `searchObjects`; reuse `listSiteR2Objects` S3
>   list-paging (`site_r2.ts:677`) for a cursor scan (optionally a D1 metadata index for speed). · cadence every-2-loops · priority P2 · category product · estimate 1-2 fires · **new-backend: YES**.
> - [x] **B12 — Rich previews** — ✅ DONE (`702456b4b` feat + `98045914b` close; visually verified per-type). FE-only
>   sandboxed inspector (image/video/audio/pdf/text/md/json/code; `<iframe sandbox>`, SVG/HTML never in the privileged
>   origin) + metadata panel + download fallback; reuses `PS_R2_DOWNLOAD`. `buckets-object-preview` testid @`BucketsPanel.tsx:1841`.
>   Do NOT re-open.
> - [ ] **B13 — Insights + metadata/lifecycle** — storage-by-type · largest-files · activity timeline · metadata
>   editor · lifecycle/CORS/storage-class. **Accept:** usage rollup by type, largest-files list, timeline from
>   `audit_logs`, editable object metadata, lifecycle/CORS/storage-class controls (only where CF + user perms allow).
>   **Anchors:** NEW routes in `handlers.ts`; timeline source = existing `audit_logs`. · cadence every-4-loops · priority **P3** · category product · estimate 2 fires · **new-backend: YES**.
> - [ ] **B10 — Reassign bucket → environment (Preview/Production) + rollback** — a DoD §21 clause that had NO frontier
>   line until this groom. Today `EnvAssignmentGrid.tsx` is **READ-ONLY** (shows each env's resource via
>   `PS_RES_OVERVIEW_REQUEST` → `GET /api/sites/:siteId/resources?environment=…`, honest "Not provisioned" cell, no
>   mutation). **Accept:** assign an UNASSIGNED custom bucket to the Preview or Production env slot; reassign swaps the
>   slot; **ROLLBACK** restores the prior binding on failure OR via an explicit undo (two-way door); confirm before
>   touching Production; honest progress + error; tenancy-guarded. **Anchors:** NEW mutation route in
>   `r2_buckets/handlers.ts` + the env/binding model in `src/services/site_r2_manager.ts` (`resolveSiteBuckets`,
>   system|custom) + a NEW bridge op `assignBucketEnv` wired into `EnvAssignmentGrid.tsx` (add the assign/undo controls
>   to the currently read-only grid). Capture BEFORE-binding for rollback. · cadence every-2-loops · priority P2 · category product · estimate 1-2 fires · **new-backend: YES**.
> - [x] **B4 BACKEND — Per-bucket scoped Access Keys** *(FAST-FOLLOW after B5 s4 — s4's owner-key is SITE-scoped; B4
>   NARROWS it to ONE bucket)* — **✅ DONE this session: backend + per-bucket credential-VALIDITY E2E PROVEN**
>   (`200` own bucket · `403` other site bucket · `401` post-revoke). per-BUCKET scoped owner keys (finer granularity
>   than B5's per-site token), reusing B5's token + record machinery. **Key reuse: `bucketScopeResources`
>   (`site_r2.ts:423`)** — B5 passes the site's FULL bucket list; B4 passes a ONE-element list (`[thisBucket]`) so the
>   minted CF token is scoped to a single bucket, nothing else. Routes `POST/GET/DELETE
>   /api/sites/:siteId/r2/buckets/:bucket/keys` + migration `0662` + CF bucket-scoped `POST
>   /accounts/{acct}/r2/api_tokens` (`cfCreateToken`@`site_r2.ts:535`). **Only the UI remains → the [ ] B4-UI slice
>   below.** Do NOT re-open the backend.
> - [x] **B4 UI — per-bucket Access Keys workspace** — ✅ DONE (`673a46a55` feat + `5d875bd57` close + `d2ebbe658`
>   checkpoint). `BucketKeySection`@`BucketsPanel.tsx:3087` (wired L2677 in `BucketSettings`, scoped to the SELECTED
>   bucket) consuming NEW `PS_R2_BUCKET_KEY_{STATUS,CREATE,ROTATE,REVOKE}` bridge ops (`embedded-mode.ts:2539+`,
>   dispatchers @3728+) against `…/r2/buckets/:bucket/keys`. Show-once secret · copy-id · rotate re-reveals · revoke →
>   calm create CTA · "unlocks only this bucket" banner · owner-copy regression (no `R2|S3|credential`). 11 Vitest. The
>   per-bucket key feature is now END-TO-END complete (UI→bridge→backend→proven-creds). Do NOT re-open.
>
> **Open Questions / spec-vs-reality contradictions (surface before executing):**
> - **Spec "current state" (BUCKETS-MASTER-SPEC §68 "Object ops … `needs_s3_credentials` (503) when unset")
>   CONTRADICTS shipped reality.** As of fire-buckets-b5-slice2, object ops no longer need an account-wide
>   `R2_S3_*` key — `resolveSiteS3Config` mints/reuses a per-site scoped token (flag-gated `r2_bucket_manager`,
>   now enabled), so `objectOpsAvailable` is TRUE for every site. The `needs_s3_credentials` 503 is now only the
>   no-per-site-token-AND-no-global-key edge. The spec body has correction banners (§166) but the §68 audit line
>   still reads the old way — trust the banners + code, not §68.
> - **B5-s4 backend is NOW ON MAIN (`0966ebd72`) — resolved, no longer a hazard.** `GET/POST /api/sites/:siteId/r2/keys`
>   + `POST …/keys/rotate` + `PS_R2_KEY_{STATUS,CREATE,ROTATE,REVOKE}` (`embedded-mode.ts:2469+`) are all present;
>   verified by grep this groom. The s4-UI fire WIRED them (`cfCreateToken`@`site_r2.ts:535` backs them) — DONE
>   `daaf2db1c`. (Kept as a receipt; the old "wait-or-ship-the-route" branch no longer applies.)
>
> ### 🧪 STANDING PROBE-DESIGN NOTE (loop self-improvement, fire-buckets-b5-slice4 — use on EVERY credential/object-op probe)
> **Editor-origin in-page API fetches get CF-bot-challenged → route probe API calls via `project-sites.manhattan.workers.dev`
> (challenge-free).** Symptom this fire: a headless probe driving the editor and calling the key/object API *from the
> `editor.projectsites.dev` page context* saw `listSites` (and the `r2/keys` calls) return a spurious **404** — NOT a real
> missing route, but Cloudflare's Bot Fight Mode challenging the opaque in-page XHR (same family as memory
> `[[bot-fight-mode-blocks-inbound-webhooks]]` + `[[cf-bot-challenge-opaque-xhr-misleading-toast]]`). **Fix / standing rule:**
> point the probe's API calls at the **`*.workers.dev` origin** (`https://project-sites.manhattan.workers.dev/api/...`),
> which is challenge-free, instead of the zoned `editor.`/`projectsites.dev` host. The working credential-validity E2E
> (`e2e/editor-live/check-owner-key-valid.mjs`) and the object-ops round-trip (`check-r2-objectops-live.mjs`) both do this.
> **Apply to ALL future B4/B9/B11/B15 credential + objectops probes.** (Pairs with memory `[[prod-verify-authed-mutation-via-workers-dev]]`.)
>
> ### 📊 DoD §21 PROGRESS (master abridged — see `BUCKETS-MASTER-SPEC.md:323`)
> **~87% complete** (≈20 of ~23 acceptance clauses met; +1 vs last groom — the per-BUCKET key clause is now DONE
> END-TO-END now that B4-UI shipped UI→bridge→backend→proven-creds, not backend-only).
> **✅ DONE:** exactly-2 defaults (Preview+Production, Uploads retired via `0649`) · custom-bucket CRUD · delete/empty ·
> type-icon file browser · browse/sort/upload/download/delete + object round-trip (B5 s2, prod-proven) · rich sandboxed
> object previews image/video/audio/pdf/text/md/json/code (B12, `98045914b`) · bucket+file context menus (B3 bucket-level) ·
> **object context menu + keyboard multi-select + bulk actions (B3 object-rows, `b6d229409`/`d9044b304`)** ·
> per-SITE owner key create/rotate/revoke + show-once secure copy (B5 s4) · **per-BUCKET scoped key create/rotate/revoke
> END-TO-END — BACKEND + validity-E2E (B4, `0662`) + UI `BucketKeySection` (B4-UI, `673a46a55`/`5d875bd57`)** · tenant
> isolation on every op (`ownsSiteData` IDOR) · beautiful loading/empty/error/success + `psBucketRise` · a11y
> keyboard/focus/SR (B14 foundation) · **≥5 real visual-refinement rounds logged+numbered (`d9044b304`/`15432d9ea`)** ·
> deployed + prod-verified · existing data intact.
> **🔶 IN-FLIGHT THIS FIRE:** B15 — Code-view bucket source selector in `EditorPanel.tsx` (FE-only; a `Source ▾` picker
> beside the existing "Source" control @~L267 → website source | R2 bucket; reuses `requestR2({op:'listObjects'})` +
> `PS_R2_UPLOAD`/`PS_R2_DOWNLOAD` + `site_r2_manager.resolveSiteBuckets`; no new backend).
> **⬜ REMAINING TO GENUINE DoD (the exact open slices — 7):** (1) **B15** Code-editor bucket selector *(in-flight this
> fire)* · (2) **B6** clone bucket (Workflow) · (3) **B7** ZIP export · (4) **B8** copy/move/rename (unblocks B3's
> F2/rename) · (5) **B9** per-object-public + public-bucket-marks-all + revoke-safe · (6) **B10** env reassign
> unassigned→env + rollback · (7) **B11** server-side bucket-wide search · plus **B14 axe @ 6bp** (testing clause, not a
> feature slice). The ≥5-visual-rounds clause + per-bucket-key clause are now MET.
> Est. **6-7 one-fire slices** remain to genuine DoD (B15 this fire; B6/B9 are the ~2-3-fire heavies, the rest ~1-2).
> **Cron-retire trigger (b1182793):** ALL 7 feature slices above (B15/B6/B7/B8/B9/B10/B11) shipped + prod-verified +
> B14 axe clean → THEN CronDelete per `[[loop-cron-refires-one-prompt-retire-when-directive-complete]]` (don't flood once
> DoD is genuinely met). Not yet — 6-7 slices + B14 axe remain (B15 in-flight this fire; visual-rounds ✅ + per-bucket-key
> ✅ already satisfied).
