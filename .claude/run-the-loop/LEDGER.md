# LEDGER — compact chronological record

> Compressed cycle log for `/run-the-loop`, most recent first. Each fire ≤5 bullets — shipped
> behavior/fix + closing SHA + prod proof. Cross-links: [`./README.md`](./README.md) ·
> [`./BACKLOG.md`](./BACKLOG.md) · [`./DISCOVERIES.md`](./DISCOVERIES.md).
>
> **Older detail lives in git history + the per-workstream sub-ledgers** (`_LOOP.md` ⟐ Cycle log,
> `_LOOP_LEDGER.md` (2.3MB — never main-thread-read), `_PROMOTE_WORKFLOW_CHECKPOINT.md`,
> `_CF_NATIVE_CONVERGENCE.md`, `_ADMIN_VQA_LEDGER.md`, `_INTERCONNECTEDNESS_LEDGER.md`). This is the
> INDEX, not a duplicate.

---

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
