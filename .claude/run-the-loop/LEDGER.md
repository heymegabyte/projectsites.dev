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
