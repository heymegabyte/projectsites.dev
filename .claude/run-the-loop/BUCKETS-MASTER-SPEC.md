# BUCKETS MASTER SPEC — The Ultimate Cloudflare R2 Bucket Manager

> **Scope lock (fire-307+, Brian 2026-10-09):** this loop focuses **ONLY** on
> **Editor → Resources → Buckets** (+ the secondary **Editor → Code → bucket selector**).
> Adapted from Brian's "ProjectSites.dev — Build the Ultimate Cloudflare R2 Bucket Manager"
> master prompt. Do NOT drift into other surfaces except the minimum needed to support Buckets.
> "Let a little light in" = elevate the aesthetic to premium/airy within the dark brand; be
> pragmatic, not ceremonial — SHIP verified slices, don't write 300-idea matrices.

## Mission
Make the Buckets screen one of the most beautiful, powerful, secure parts of ProjectSites.dev:
the file-management feel of Finder/Transmit, the polish of Linear/Raycast, the capability of
Cloudflare R2's dashboard — every visible control backed by a REAL implementation (no stubs).

## READY NOW — top 5 (next fires)
*Ranked by user/money-path leverage × dependency order. B1 (premium shell) is being built in fire-312.*

1. **B1-polish — grid view + skeletons + lit-dark rounds** · *why-now:* finishes the fire-312 shell so the
   flagship surface actually looks flagship (first-5s "it" factor); zero dependencies, pure FE. · *acceptance:*
   list⇄grid toggle on Files (session-persisted, grid tiles reuse `iconForObject` + image preview), skeleton
   loaders replace bare "loading", ≥3 screenshot-verified aesthetic rounds. · *files:* `BucketsPanel.tsx`
   (`ObjectBrowser` list render ~1225, `BucketsState` loading branch); `_polish.scss` tokens. · **new-backend: NO.**
2. **B2 — two-default model (Preview + Production), retire `'uploads'`** · *why-now:* the whole navigator's
   pinned-top premise (and B1's correctness) rests on this; today `ensureDefaultSiteR2` still hardcodes
   `'uploads'`. Small, high-trust, unblocks everything. · *acceptance:* new sites seed "Preview"; an idempotent
   data-preserving migration renames existing `'uploads'` display_name→"Preview" (bucket_name/objects untouched);
   exactly two pinned; nothing destroyed. · *files:* `site_r2.ts` `ensureDefaultSiteR2` (327) + `ensureProductionSiteR2`
   (351); NEW D1 migration on `site_r2_allocations`. · **new-backend: YES (small — migration + 1-line default).**
3. **B12 — rich sandboxed previews** · *why-now:* highest capability-for-cost of the P2 set and the ONLY backend-free
   one; makes Files feel like Finder/Transmit immediately, pairs perfectly with B1. · *acceptance:* sandboxed
   inspector for image/video/audio/pdf/text/md/json/code, SVG/HTML never in the privileged origin, metadata +
   download fallback. · *files:* `BucketsPanel.tsx` (extend inline-image preview into a `<iframe sandbox>`/typed
   viewer); reuse `PS_R2_DOWNLOAD`. · **new-backend: NO.**
4. **B15 — Code-view bucket source selector** · *why-now:* the Code surface is where owners spend real time
   (money path); surfacing buckets there compounds B1's value and the selector reuses every existing op. ·
   *acceptance:* `Source ▾` toggles website source | R2 bucket, loads the bucket tree into the explorer,
   open/edit/save-back-to-R2, warn before Production edits, read-only vs editable, stale-save guard. · *files:*
   `EditorPanel.tsx` (add beside the existing `FileTree`/"Source" control ~267 — no parallel tree); reuse
   `requestR2({op:'listObjects'})` + `PS_R2_UPLOAD/DOWNLOAD` + `site_r2_manager.resolveSiteBuckets`.
   · **new-backend: NO.**
5. **B3 — context menus + keyboard shortcuts** · *why-now:* turns the shell from browsable into operable (the
   "wow" on repeat use) and all actions already have handlers + a multi-select set; cheap, high daily leverage.
   · *acceptance:* right-click (bucket/file/empty/multi) wired to the SAME handlers as the buttons; Cmd/Ctrl-click,
   Shift-range, Cmd+A, Delete, Esc, Cmd+C fire only when no input is focused; discoverable "?" sheet. (F2/rename
   deferred until B8.) · *files:* `BucketsPanel.tsx` `BucketRow` row actions (~718) + object rows (~1276) +
   `selected` set (795). · **new-backend: NO.**

*Deferred from top-5 by dependency/cost:* B8 (rename/move/copy — new S3 route+op, unblocks B3's F2) · B11
(server-side search — new route+op) · B4/B5 (access keys + global strip — heaviest backend, token escrow) ·
B6/B7/B9/B10 (Workflows / gateway / env-pointer — large backend) · B13/B14 (insights + a11y hardening — run last).

---

## Current state (audited fire-307, build on this — do NOT reinvent)
**Backend is already strong** (`apps/project-sites`):
- `src/services/site_r2.ts` (871 lines) — per-site R2 plane. `SiteR2Allocation{id,bucketName,displayName,environment:'preview'|'production',isDefault,publicAccess,publicBaseUrl,createdAt}`.
  Functions: `listSiteR2Allocations`, `resolveSiteR2Allocation`, `provisionSiteR2`, `ensureDefaultSiteR2`
  (names default `'uploads'`, preview env), `ensureProductionSiteR2` (first prod-deploy hook),
  `deleteSiteR2` (empty-then-delete), `setSiteR2PublicAccess`, `promoteSiteR2` (preview→prod COPY),
  object ops `listSiteR2Objects`/`putSiteR2Object`/`getSiteR2Object`/`deleteSiteR2Object` (S3 SigV4).
- Bucket CRUD = CF **REST** API (`/accounts/{acct}/r2/buckets`, global key / per-org creds).
  Object ops = R2 **S3 API** (SigV4, `{acct}.r2.cloudflarestorage.com`) gated on
  `R2_S3_ACCESS_KEY_ID`/`R2_S3_SECRET_ACCESS_KEY` → `needs_s3_credentials` (503) when unset.
- `libs/features/r2_buckets/handlers.ts` — 10 routes under `/api/sites/:siteId/r2/buckets[...]`,
  gate order auth→flag(`r2_buckets`, DARK→404)→`ownsSiteData` IDOR. `bucketView` = {address,createdAt,environment,isDefault,name,public,publicUrl}.
- D1: `site_r2_allocations` (0645, live) + `site_r2_buckets` manager catalog (0647, kind system|custom,
  is_system, credential_ref, account_id) behind DARK flag `r2_bucket_manager`.
- Flag `r2_buckets` = **enabled, 100%, experimental**. Denylist `FORBIDDEN_BUCKET_NAMES` protects shared platform buckets.
- Naming: `ps-site-{siteId}-{displayName}` (3–63 char, `[a-z0-9-]`).

**Editor** (`app/`):
- `app/components/workbench/BucketsPanel.tsx` (~1400 lines) — functional TWO-PANE (left list + right
  object browser). List: name/default-badge/visibility/env/createdAt + row actions (address/visibility/promote/delete).
  Browser: breadcrumbs, client-side search of loaded page, sort (name/size/newest), upload, drag-drop, bulk delete,
  load-more, image preview, copy-URL, download, delete. States loading/disabled/error/ready. 30s visibility-aware poll.
- Wired via `app/lib/embed/embedded-mode.ts` `PS_R2`/`PS_R2_UPLOAD`/`PS_R2_DOWNLOAD` → Angular
  `bolt-embed.service.ts` (holds bearer) → worker. `requestR2()`/`requestBucketUpload()`/`requestBucketDownload()`.
- Resources tab registered in `ResourcesPanel.tsx` (`Section='buckets'`, 3rd tab).
- Code view (`EditorPanel.tsx`) has **NO** bucket source selector today.

## GAPS → the backlog (prioritized; mandatory features are not optional)

> **Bridge op inventory (verified fire-312 — reuse before adding):** the editor↔admin bridge
> (`app/lib/embed/embedded-mode.ts`) today exposes `PS_R2` with **8 ops**:
> `listBuckets · createBucket · deleteBucket · address · setPublic · promote · listObjects · deleteObject`,
> plus `PS_R2_UPLOAD` (putObject) + `PS_R2_DOWNLOAD` (getObject). **No** rename/move/copy/search/keys/clone/zip
> op exists → every such item below needs a NEW bridge op + a NEW worker route. Worker routes = the 10 in
> `handlers.ts`; service fns = the 17 in `site_r2.ts`.

> **⚠ Spec "current state" correction (fire-312):** the audit section above lists ONLY `site_r2.ts`, but a
> SECOND authoritative service already exists — `src/services/site_r2_manager.ts` (12K, Slice-1 shipped)
> with `resolveSiteBuckets` / `assertBucketMutable` / `assertBucketOwnedBySite` / `SystemBucketProtectedError`,
> the `BucketKind='system'|'custom'` model, `SYSTEM_BUCKET_ID='system:project-code-preview'`, and
> `isValidNewBucketName`. Feature dir `libs/features/r2_bucket_manager/` has `feature.manifest.ts` +
> `schemas.ts` + a REAL-SQLite service test, **but NO `handlers.ts`** (routes unbuilt) and **nothing is wired
> to the FE**. It is the intended "reconcile system + custom into ONE list" layer behind DARK `r2_bucket_manager`.
> Items that touch the catalog/system-bucket (B6/B8/B9/B11/B15) should BUILD ON this service, not reinvent it.

**P1 — visual + model (do first):**
- [x] **B1 Premium shell** *(FIRE 312 — ✅ DONE · live-verified on editor.projectsites.dev)* — redesigned `BucketsPanel.tsx`: left list → a
  grouped **NAVIGATOR** (Preview + Production pinned at top + a "Custom" group) and the right pane → a per-bucket
  **WORKSPACE** with tabs **Files** + **Settings** (Settings houses visibility toggle / copy-address / promote /
  delete — all on EXISTING ops `setPublic`/`address`/`promote`/`deleteBucket`; NO new backend). File-icon system
  already exists (`iconForObject`, line 168). **Deferred into B1-polish** (not this fire): list/grid view toggle,
  skeletons, and the extra "lit"-dark aesthetic rounds. Acceptance: `npm test` (Vitest) green; editor builds;
  headless screenshot shows the pinned-env navigator + Files/Settings tabs; Files browses objects, Settings
  toggles public + shows address + promotes + deletes. New-backend: **NO** (pure FE re-layout on existing ops).
  - *fire-312 result:* commits `0224a7878` (shell) + `9cff6dcd2` (active-tab contrast). TDD 4 new Vitest cases
    (grouped navigator · Files/Settings tabs · live Settings setPublic · default-bucket delete hidden), 11/11 +
    accent-pill 4/4 green, tsc 0, lint clean. Deployed Pages `bolt-diy` prod; **live-verified**: prod Workbench
    chunk 200s with `buckets-workspace-tab`/`buckets-nav-group`/`buckets-settings`, and `verify:editor-live`
    real-browser run = buckets PASS(data) with a screenshot showing **PREVIEW/PRODUCTION** pinned groups + the
    **Files/Settings** tab bar. Visual walkthrough caught + fixed a cyan-on-cyan active-tab label (filled-pill opt-out).
- [ ] **BKT-PILL-INK-SWEEP** *(discovered fire-312, cat: a11y/cleanup; NOT Buckets-scope)* — `AutomationsPanel.tsx`
  + `panel/PanelSegmentedNav.tsx` render filled accent `[role=tab]` pills that carry `data-filled-pill` (primary
  protection — NO live invisible-label bug) but lack the literal `text-[#061018]` ink hardening. Add literal ink to
  both, then upgrade `accent-pill-ink-contrast.spec.ts` test 4 from a hardcoded list to a DYNAMIC sweep (every
  `role="tab"`+`bg-bolt-elements-item-contentAccent` file must carry `text-[#061018]`) so the gate can't go stale.
  New-backend: **NO**. Priority: P3 (hardening). Deferred out of fire-312 by the Buckets scope-lock.
- [ ] **B1-polish Grid view + aesthetic rounds** *(split out of B1, fire-312)* — one-line: finish B1's visual arc.
  Acceptance: a list⇄grid toggle on the Files tab (persisted per-session; grid = thumbnail tiles reusing
  `iconForObject` + image preview), object/bucket skeleton loaders replacing the bare "loading" text, and ≥3
  "lit"-dark refinement rounds (airier spacing, thin cyan borders, restrained shadow) each screenshot-verified.
  Anchor: `BucketsPanel.tsx` `ObjectBrowser`/`filteredObjects` (list render ~line 1225) + `BucketsState` loading
  branch. Reuse `iconForObject`; brand tokens from `_polish.scss`. New-backend: **NO**. Priority: **P1 (next after B1)**.
- [ ] **B2 Two-default-buckets model** — one-line: make Preview + Production the two canonical site-visible
  defaults and retire the `'uploads'` default NAME (keep the physical bucket + its data). Anchor:
  `site_r2.ts` `ensureDefaultSiteR2` (line 327 — currently hardcodes `displayName ?? 'uploads'`) +
  `ensureProductionSiteR2` (line 351, prod-deploy hook, already seeds production). Acceptance: a new site seeds a
  "Preview" default (not "uploads"); an EXISTING `'uploads'` allocation is display-renamed to "Preview" by an
  idempotent, data-preserving migration (D1 `site_r2_allocations`, rename display_name only — bucket_name/objects
  untouched); navigator pins exactly these two; no existing bucket destroyed. Reuse the deploy-hook path for
  Production. New-backend: **YES (small)** — a migration + a one-line default-name change; no new route.
  Priority: **P1**.
- [ ] **B3 Context menus + keyboard + command palette** — one-line: make every bucket/file action reachable by
  right-click, ellipsis, long-press, and desktop shortcuts. Anchor: `BucketsPanel.tsx` `BucketRow` (row actions
  ~line 718) + `ObjectBrowser` object rows (~line 1276) + the existing `selected: Set<string>` multi-select
  state (line 795). Acceptance: right-click on bucket/file/empty/multi-select opens a context menu wired to the
  SAME handlers the visible buttons call; shortcuts Cmd/Ctrl-click, Shift-range, Cmd+A, Delete, F2 (rename —
  gated on B8), Esc, Cmd+C fire ONLY when no input/editor is focused; a discoverable "?" shortcut sheet.
  Reuse existing action callbacks + selection set — do NOT duplicate op calls. New-backend: **NO** (F2/rename
  needs B8 first; everything else is pure FE). Priority: **P1**.

**P2 — capability depth (backend-heavy):**
- [ ] **B4 Per-bucket Access Keys** — one-line: issue bucket-scoped R2 API tokens with lifecycle + an Access Keys
  tab. Anchor: NEW worker route under `handlers.ts` (`POST/GET/DELETE /api/sites/:siteId/r2/buckets/:bucket/keys`)
  + NEW service fns in `site_r2.ts` calling CF `POST /accounts/{acct}/r2/api_tokens`; escrow via existing
  `MCP_ENCRYPTION_KEY`/`ai_crypto` vault (NEVER plaintext); NEW bridge op `createKey`/`listKeys`/`rotateKey`/
  `revokeKey`. Acceptance: create a token scoped to ONE bucket (Object R/O or R/W), expiry presets
  (1mo/6mo/1yr/5yr/never), copy-id, step-up reveal, rotate, revoke, rename; warn on never-expiring write keys;
  authz on every action; tenancy test. New-backend: **YES (heavy)**. Priority: **P2**.
- [ ] **B5 Global site credential strip** — one-line: one site-scoped R2 token (its buckets only, never
  account-wide) with masked id/secret + rotate. Anchor: NEW service fn in `site_r2.ts` + NEW route in
  `handlers.ts`; reuses B4's token + escrow machinery (build B4 first). Acceptance: masked id/secret, copy,
  step-up reveal, rotate, live status; token perms auto-extend when a new bucket is created; honest "secret not
  recoverable → rotate" when not escrowed; scope asserted to exclude unrelated buckets. New-backend: **YES**
  (depends on B4). Priority: **P2**.
- [ ] **B6 Clone bucket** — one-line: durable Workflow that creates a new physical bucket + server-side-copies
  every object. Anchor: NEW Cloudflare **Workflow** + NEW route in `handlers.ts`; reuse `provisionSiteR2`
  (site_r2.ts:244) for the new bucket + the S3 copy primitive used by `promoteSiteR2` (site_r2.ts:830) for the
  object copy; register the clone in `site_r2_manager` catalog as `kind:'custom'`. Acceptance: new bucket +
  object+metadata copy (HTTP/custom meta, CORS, lifecycle where CF supports), clone defaults private+unassigned,
  progress (files/bytes/stage/errors/retry/cancel), verified-before-success. New-backend: **YES (heavy —
  Workflow)**. Priority: **P2**.
- [ ] **B7 ZIP export** — one-line: export a bucket/folder/selection as a ZIP (stream small, background job +
  short-lived signed link for large). Anchor: NEW route in `handlers.ts` + NEW bridge op `exportZip`; reuse
  `listSiteR2Objects`/`getSiteR2Object` (site_r2.ts:677/743); temp output in a PLATFORM bucket (never a customer
  bucket). Acceptance: small→streamed ZIP, large→ZIP64 background job + expiring signed link; path-traversal
  safe; auto-expire. New-backend: **YES**. Priority: **P2**.
- [ ] **B8 Object rename/move/copy-across-buckets** — one-line: S3 CopyObject→Delete with verification +
  overwrite guard. Anchor: NEW service fns in `site_r2.ts` (reuse the SigV4 `s3Fetch` + copy primitive inside
  `promoteSiteR2` at line 830) + NEW route(s) in `handlers.ts` + NEW bridge ops `copyObject`/`moveObject`/
  `renameObject`. Acceptance: copy/move within a bucket AND across the site's buckets; verify copy before delete;
  overwrite-exists check; preserve metadata + public intent; tenancy-guarded both buckets. **Unblocks B3's F2.**
  New-backend: **YES**. Priority: **P2**.
- [ ] **B9 Per-object public + expiring shares** — one-line: a Worker object-serving gateway + an
  `ObjectVisibility` control-plane (R2 has NO per-object S3 ACL). Anchor: NEW public Worker route (gateway,
  range-request aware) + NEW D1 table `object_visibility{bucketId,objectKey,visibility,publicSlug}` + resolver
  that honors bucket-public inheritance; integrate with `site_r2_manager` for bucket→site resolution. Acceptance:
  flip one object public while the bucket stays private; bucket-public marks all objects public; revoke takes
  effect (cache-aware); NEVER activate an uncontrolled native public endpoint. New-backend: **YES (heavy)**.
  Priority: **P2**.
- [ ] **B10 Zero-downtime env assignment** — one-line: a logical `EnvironmentBucketAssignment{siteId,environment,
  bucketId,generation}` pointer + runtime resolver that swaps the active bucket without a full copy. Anchor: NEW
  D1 table + NEW service/route; reuse the scoped-S3-creds access pattern (R2 bindings are static). Acceptance:
  assign an unassigned bucket → Preview/Production, health-check, rollback; explicitly **distinct from
  Deploy/Clone/Rollback**. New-backend: **YES (heavy)**. Priority: **P2** (lower — depends on B2 + B6 landing first).
- [ ] **B11 Server-side bucket-wide search + metadata index** — one-line: real search across the WHOLE bucket
  (today's search only filters the loaded page). Anchor: NEW route in `handlers.ts` + NEW bridge op `searchObjects`;
  reuse `listSiteR2Objects` S3 list-paging (site_r2.ts:677) for a cursor scan (optionally a D1 metadata index for
  speed). Acceptance: search + filters (ext/size/date/visibility/prefix) across all objects, cursor pagination,
  honest "indexing"/"scanning" status. Replaces the client-only `filteredObjects` (BucketsPanel ~line 1055).
  New-backend: **YES**. Priority: **P2**.
- [ ] **B12 Rich previews** — one-line: a SANDBOXED inspector for image/video/audio/pdf/text/md/json/code. Anchor:
  `BucketsPanel.tsx` (today only `iconForObject` + inline image preview); add a sandboxed `<iframe sandbox>` /
  typed viewer; reuse `PS_R2_DOWNLOAD` (getObject) for bytes. Acceptance: previews each type; SVG/HTML NEVER
  injected into the privileged origin; metadata panel + download fallback. New-backend: **NO** (FE-only on the
  existing download op). Priority: **P2** (high-leverage, low-risk, no backend — good early pick).

**P3 — intelligence + quality:**
- [ ] **B13 Insights + metadata/lifecycle** — one-line: storage-by-type · largest-files · activity timeline ·
  metadata editor · lifecycle/CORS/storage-class. Anchor: NEW routes in `handlers.ts`; timeline source = existing
  `audit_logs`; lifecycle/CORS/storage-class only where CF + user perms allow. Acceptance: usage rollup by type,
  largest-files list, timeline from `audit_logs`, editable object metadata, lifecycle/CORS/storage-class controls.
  New-backend: **YES**. Priority: **P3**.
- [ ] **B14 a11y + hardening pass** — one-line: WCAG 2.2 AA + visual-regression + authz/tenancy + failure-injection
  + responsive 6bp. Anchor: cross-cutting over `BucketsPanel.tsx` + `handlers.ts` tests + `e2e/r2-buckets/`.
  Acceptance: keyboard-complete, SR-friendly tables + live status, axe-clean 6bp, visual-regression screenshots,
  tenancy/authz tests, long-job failure-injection. New-backend: **NO** (tests + a11y). Priority: **P3**
  (run LAST, after features land).

**Secondary integration:**
- [ ] **B15 Code editor bucket selector** — one-line: a `Source ▾` picker in Code view → website source | R2
  buckets, loading a bucket's object tree into the file explorer. Anchor: `app/components/workbench/EditorPanel.tsx`
  (has `FileTree` + a "Source" control for Source-Control already at line ~267 — ADD the bucket source beside it,
  do NOT build a parallel tree) + reuse `requestR2({op:'listObjects'})` + `PS_R2_UPLOAD`/`PS_R2_DOWNLOAD` for
  open/edit/save; resolve the bucket list via `site_r2_manager.resolveSiteBuckets`. Acceptance: pick website
  source OR an R2 bucket; load the bucket tree into the explorer; open/edit supported text/code; save back to R2;
  warn before direct Production-bucket edits; clear read-only vs editable; stale-save/overwrite protection. Shares
  R2 abstractions with `BucketsPanel`. New-backend: **NO** (reuses existing ops; selector + explorer wiring is FE).
  Priority: **P2 (money-path — the Code surface is where owners live)**.

## Technical constraints (CF — respect; from master §18)
1. R2 has **no** per-object public S3 ACL → use a Worker gateway + control-plane (B9).
2. Worker R2 bindings are **static** → per-site/dynamic access is REST + S3 SigV4 (already the pattern).
3. Bucket delete requires **empty first** (already handled).
4. Presigned S3 URLs are short-lived → long-lived public = gateway, not presign.
5. R2 secret keys **cannot be re-fetched** from CF → escrow once or rotate.
6. Token scopes must **never** expose unrelated buckets/account.
7. Permission propagation may lag → handle gracefully.
8. Large copy/export → resumable, limited, failure-handled (Workflows).
10. Real zero-downtime switch = serving architecture, not a dashboard label.

## Definition of done (master §21 — abridged to this repo)
Exactly 2 default site-visible buckets (Preview+Production, Uploads name retired safely) · custom buckets
CRUD · clone/empty/delete/zip · polished file browser w/ type icons · browse/search/sort/preview/upload/
download/copy/move/rename/delete · bucket+file context menus · bulk actions · per-bucket keys (create/rotate/
revoke/expire) · global id+secret w/ secure copy · per-object public while rest private · public bucket marks
all public · revoke safe · reassign unassigned→env w/ rollback · Code-editor bucket selector · tenant isolation
on every op · beautiful loading/empty/error/success · a11y+keyboard+touch+responsive · E2E golden paths ·
≥5 real visual-refinement rounds · deployed + prod-verified · existing data intact.
**Never claim a feature works from appearance alone — verify against real backend + real browser.**

## Loop discipline
- One coherent VERIFIED slice per fire. Build on the existing backend; add backend only where a GAP needs it.
- TDD-first where practical (Vitest for editor, Jest for worker). Prod-verify after deploy.
- Flag depth additions behind `r2_bucket_manager` (DARK) until a slice is complete, then promote.
- **Retire the loop cron when this DoD is genuinely met** (per [[loop-cron-refires-one-prompt-retire-when-directive-complete]]) — don't flood.
