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
