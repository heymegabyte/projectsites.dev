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
*Ranked by user/money-path leverage × dependency order. Shipped: B1 shell · B1-polish grid · B2 two-default ·
B3 menu + shortcut sheet · owner-friendly copy · B14 (roving listbox + modal focus-trap + SR status roles) ·
**B5 slice 1 (per-site S3 token service + migration `0660` — prod-applied, flag-dark)**.
The a11y FOUNDATION is complete. ★ **DECISION MADE (Brian 2026-10-10): build B5 scoped tokens (`#2`)** to unblock
the ~8 object features — see the SCOPE LOCKED block in GAPS.*

**★ TOP PRIORITY — B5 slice 2 (the object-ops FLIP). START IN A FRESH SESSION.**
0. **B5 slice 2 — wire object ops to the per-site token** — `getS3Config`/`hasObjectOps` (site_r2.ts) resolve the
   site's token via `ensureSiteS3Token` (slice 1, shipped) instead of the global `R2_S3_*`; sign
   `listSiteR2Objects`/`put`/`get`/`delete` with it. **Flips `objectOpsAvailable` true per-site → unblocks
   B6–B12/B15/grid tiles/upload/browse/download/previews.** During impl: confirm the exact R2-object-RW
   permission-group id live (slice 1 used a documented-but-unverified id, TODO-marked in `ensureSiteS3Token`) and
   that the SHA-256(token.value) → access-key-id derivation matches CF's live S3 credential. Prod-verify with a
   REAL browser: a real bucket lists + uploads + downloads objects in the editor. · **new-backend: YES (wires slice 1).**

**Fully-verifiable FE-only remainders (do these if a fire can't take on B5's backend):**
1. **B14 residual — axe @ 6bp** · needs `@axe-core/playwright` added to the PROD E2E (not a jsdom unit dep); run axe
   on the Buckets panel @ 6 breakpoints, fix violations. Keyboard is already done (B14). · **new-backend: NO.**
1b. **B1-polish — ≥3 "lit"-dark aesthetic rounds** · subjective screenshot-verified refinement. · **new-backend: NO.**
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
- [~] **B1-polish Grid view + aesthetic rounds** *(split out of B1, fire-312)* — finish B1's visual arc.
  - [x] **list⇄grid toggle** *(fire-buckets-b1polish — ✅ DONE, live)* — `ObjectBrowser` now has a session-persisted
    (`ps.buckets.filesView`, jsdom-guarded) aria-pressed segmented toggle; grid = responsive tiles reusing
    `iconForObject` + real `<img>` thumbnails for images in PUBLIC buckets (onError→icon) + the same multi-select +
    hover actions (copy/download/delete). 3 new Vitest cases, 14/14 green; live-verified (toggle clicked in a real
    browser via the hardened `editor-nav.mjs` buckets probe). Skeletons already existed (`BucketsSkeleton`/`ObjectsSkeleton`).
  - [ ] **remaining:** ≥3 "lit"-dark refinement rounds (airier spacing, thin cyan borders, restrained shadow), each
    screenshot-verified; optional grid image thumbnails for PRIVATE buckets (needs a signed-URL/gateway, pairs with B9).
    New-backend: **NO** (private thumbnails would need B9's gateway). Priority: **P1 (next)**.
- [x] **B2 Two-default-buckets model** *(fire-buckets-b2 — ✅ DONE, prod-migrated)* — the two site-visible defaults
  are now named **Preview** (preview) + **Production** (production); the legacy `'uploads'`/`'production'` display
  names are retired. Seed (`site_r2.ts`): `ensureDefaultSiteR2` seeds `'Preview'`, `ensureProductionSiteR2` seeds
  `'Production'`; an existing default keeps its stored display_name. Migration `0649` renamed existing rows
  **display_name-only** (physical `bucket_name` + objects untouched — proven on prod: `ps-site-…-uploads` now reads
  `display_name='Preview'`); additive + reversible + idempotent + collision-guarded + default-scoped. TDD: 5 Jest
  cases (real-SQLite + mocked CF fetch). Prod rollout: migration applied to `project-sites-db-production` (3
  uploads→Preview + 1 production→Production, 4 rows written, bucket_name preserved); worker deployed (seed) `af35afb4`.
- [~] **B3 Context menus + keyboard + command palette** — make every bucket/file action reachable by
  right-click, ellipsis, long-press, and desktop shortcuts.
  - [x] **bucket row actions menu** *(fire-buckets-b3 — ✅ DONE, live)* — a Radix `DropdownMenu` ellipsis (⋯) per
    bucket nav row (`BucketRowMenu` in `BucketsPanel.tsx`): Address · Make public/private · Promote · Delete
    (non-default), reusing the existing handlers (all CF-REST bucket ops — work WITHOUT object creds). Discoverable
    + keyboard + touch + a11y (Radix roles/Escape/portal). 2 Vitest cases; live-verified (menu opened in a real
    browser via the hardened `editor-nav.mjs` buckets probe).
  - [x] **discoverable "?" shortcut sheet** *(fire-buckets-b3sheet — ✅ DONE, live)* — a header keyboard (?) trigger
    opens a `ShortcutsSheet` (reuses `ModalShell`) documenting the panel's interaction model (navigator arrow/Home/
    End+Enter, ⋯/right-click actions, list/grid toggle, Esc). 2 Vitest cases; live-verified (`editor-nav.mjs` opens it).
  - [x] **navigator keyboard** — done fire-buckets-b14 (roving-tabindex listbox + arrows). See B14.
  - [ ] **remaining (⚠ BLOCKED on object ops):** object-row context menu + multi-select shortcuts (Cmd/Ctrl-click,
    Shift-range, Cmd+A, Delete, F2[B8], Esc, Cmd+C) + a command palette — all need objects. New-backend: **NO**.
    Priority: **P2** (gated on the Object-ops blocker below). **B3 is now FE-complete except the object-level parts.**

> **⚠ OBJECT-OPS BLOCKER + DECISION (discovered fire-buckets-b3).** The worker's R2 **S3** credentials
> (`R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY`) are **unset** → `hasObjectOps(env)` is false →
> `objectOpsAvailable=false` for EVERY site (the UI shows "Object storage needs R2 keys"; bucket CRUD still works).
> This BLOCKS live-verification of every object-centric slice: **B6 clone · B7 zip · B8 move/rename · B9 per-object
> public · B11 search · B12 previews · B15 Code selector · B1-polish grid tiles · B3 object-row menus · upload/
> browse/download**. These can be built + UNIT-tested but NOT prod-verified in a real browser until object ops are
> enabled. **Brian-gated decision:** (a) provision the WORKER's internal R2 S3 key (one account-wide key; per-site
> isolation stays in code via the `ps-site-` prefix + `FORBIDDEN_BUCKET_NAMES`) to unblock all object ops — a NEW
> secret (`wrangler secret put`), reversible, but an account-level credential decision; OR (b) prioritize **B4/B5**
> (customer-facing SCOPED tokens — the spec's "never account-wide" model) which also provision usable creds; OR
> (c) keep shipping the FULLY-verifiable non-object work (B1-polish aesthetic rounds, B14 a11y pass, the B3 shortcut
> sheet). Until resolved, the loop should prefer (c) + surface this each fire — do NOT claim an object feature
> "works" without a real-browser object-op proof.

**P2 — capability depth (backend-heavy):**
> **★ SCOPE LOCKED (Brian 2026-10-10 — chose option `#2`, the scoped-token path): B5 is THE LEAD + the object-ops
> UNBLOCK.** The worker turns on the editor's own object ops (browse/upload/download → previews, grid, Code selector,
> clone/zip) by using each site's SCOPED R2 token — NEVER an account-wide `R2_S3_*` key. Three locked decisions:
> (1) **worker uses per-site scoped tokens** to unblock the editor; (2) **owner-facing keys are SHOW-ONCE** (secret
> shown once on create, never persisted; rotate if lost); (3) **B5 (per-site) first, B4 (per-bucket) fast-follow**.
> Defaults (decide-and-proceed): reuse the DARK `r2_bucket_manager` flag + `site_r2_manager.ts` + `ai_crypto`; new
> owner keys default **R/O + bounded expiry** (R/W + never with a warning); **audit-log** every create/rotate/revoke;
> per-bucket **CORS** = fast-follow. **⚠ Key nuance:** the WORKER's internal per-site token MUST be stored ENCRYPTED
> (it reuses it every request — can't be show-once); SHOW-ONCE applies only to OWNER-facing keys (a separate token the
> owner copies for external use). **Start the implementation in a FRESH session** (the deciding session was 10 fires deep).

- [~] **B5 Per-site scoped token — THE OBJECT-OPS UNBLOCK** *(scope-locked; NOW THE LEAD — slice 1 shipped)* — one R2 S3
  token scoped to a SITE's buckets (enumerated, never account-wide); the worker uses it for the editor's object ops.
  **Sliced plan (each a fire, TDD-first):**
  1. [x] **Token service + migration** *(fire-buckets-b5-slice1 — ✅ DONE, prod-migrated flag-dark)* —
     `ensureSiteS3Token(env, siteId, tenantId, orgId)` in `site_r2.ts`: idempotently reuses the existing ACTIVE token
     (decrypts `secret_enc`) else mints a CF R2 api_token **scoped to the site's own buckets** (`listSiteR2Allocations`
     → `bucketScopeResources`, filtering `FORBIDDEN_BUCKET_NAMES` — never account-wide), stores the secret ENCRYPTED
     (`ai_crypto.encrypt`, AES-GCM) in NEW D1 table `site_r2_s3_tokens` (id, tenant_id, site_id, access_key_id,
     secret_enc, cf_token_id, scope_bucket_ids JSON, status, created/updated/rotated/deleted_at + idx on (site_id,status)).
     Migration `0660_site_r2_s3_tokens.sql` — additive + reversible + idempotent (`IF NOT EXISTS`); **applied to
     `project-sites-db-production` (table verified present)**; worker deployed (dormant — not wired until slice 2).
     TDD: 3 Jest cases (real-SQLite `createD1Sqlite` + mocked CF fetch — creates token fetch-once + encrypted row that
     decrypts back + bucket-scope + idempotent reuse + no-creds failure) 3/3; tsc 0; `validate:features` PASS.
     ⚠ slice-2-confirm items (TODO-marked in-service): the exact R2-object-RW permission-group id + the
     SHA-256(token.value)→access-key-id derivation are documented-but-unverified-live (fine — flag-dark + mocked).
  2. [ ] **Wire object ops to the per-site token** — `getS3Config`/`hasObjectOps` (site_r2.ts) resolve the site's token
     (lazy-provision via slice 1) instead of the global `R2_S3_*`; sign `listSiteR2Objects`/`put`/`get`/`delete` with it.
     **Flips `objectOpsAvailable` true per-site → unblocks B6–B12/B15/grid/upload/previews.** Prod-verify: a real bucket
     lists objects in the editor. **← NEXT (the object-ops flip).**
  3. **Perms auto-extend on new bucket** — when `provisionSiteR2` adds a bucket, extend the site token's scope + re-store.
  4. **Owner credential strip UI** (editor, Vitest) — a SEPARATE owner-facing scoped key: masked id + **show-once** secret
     on create/rotate, copy-id, rotate, revoke, live status; honest "secret not recoverable → rotate".
  5. **Flag promote + docs + prod-verify** once 1–4 are green + live.
  Acceptance: a site's object ops work via its OWN scoped token (no account-wide key); scope excludes unrelated
  buckets/account (asserted); owner secret show-once; rotate/status live. New-backend: **YES (heavy, multi-fire)**.
  Priority: **P1 — THE LEAD**.
- [ ] **B4 Per-bucket Access Keys** *(FAST-FOLLOW after B5)* — per-BUCKET scoped owner keys (granularity below B5's
  per-site token), reusing B5's token + record machinery. Route `POST/GET/DELETE /api/sites/:siteId/r2/buckets/:bucket/keys`
  + CF `POST /accounts/{acct}/r2/api_tokens` (bucket-scoped). SHOW-ONCE secret; default R/O + bounded expiry (R/W +
  never with a warning); audit-log; Access Keys workspace tab (create/copy-id/rotate/revoke/rename). Authz + tenancy
  test. New-backend: **YES**. Priority: **P2 (after B5)**.
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
- [~] **B14 a11y + hardening pass** — WCAG 2.2 AA + visual-regression + authz/tenancy + failure-injection + 6bp.
  - [x] **navigator keyboard (roving listbox)** *(fire-buckets-b14 — ✅ DONE, live)* — the Buckets navigator is now a
    proper single-tab-stop `role=listbox`: the selected (or first) row is the ONE tab stop (roving tabindex), Arrow
    Up/Down/Home/End move selection + focus across all groups. 2 Vitest cases; live-verified (`editor-nav.mjs` asserts
    exactly 1 tabbable row LIVE).
  - [x] **modal focus trap + Escape** *(fire-buckets-modalfocus — ✅ DONE, live)* — `ModalShell` (create/delete/
    address/shortcuts) was `role=dialog aria-modal` but did NOT trap focus (Tab escaped to the background — WCAG
    2.4.3) and the shortcuts sheet had no Escape. Now moves focus IN on open, TRAPS Tab (cycles first↔last), and
    closes on Escape at the shell level. 2 Vitest cases; live-verified (`editor-nav.mjs` asserts Escape closes the sheet).
  - [x] **SR status roles (WCAG 4.1.3)** *(fire-buckets-livestatus — ✅ DONE, live)* — the centered status states carry
    `role=status` (ObjectsNeedsCreds, DisabledCard) / `role=alert` (ErrorCard) so a screen reader is notified when they
    appear. 3 Vitest cases; live-verified (`editor-nav.mjs` asserts the needs-creds `role=status`). Also dropped a
    residual "R2 buckets" → "buckets".
  - [ ] **remaining:** axe-clean @ 6bp (needs `@axe-core/playwright` in the prod E2E — a MODERATE slice, start fresh),
    `aria-live` announcement of the async upload/promote PROGRESS (the toasts go to the parent admin, so the editor-side
    progress strip could add a polite live region), visual-regression screenshots, handler authz/tenancy tests,
    long-job failure-injection. New-backend: **NO**. Priority: **P2**. *(The a11y FOUNDATION — roving listbox + modal
    trap + SR status roles — is now DONE; axe@6bp + B13 activity-timeline are the remaining decision-independent slices,
    both MODERATE → start fresh. Object features stay gated on the R2-S3-creds decision.)*

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
- **Prod data-migration recipe** *(fire-buckets-b2 §7 — reuse for B4–B13 which add backend/migrations):*
  TDD the migration SQL against **real SQLite** via `createD1Sqlite()` (`src/__tests__/helpers/d1_sqlite.ts`) —
  prove rename/transform + data-preservation + **idempotency** (apply twice) + collision/edge guards before prod.
  Then: (1) read-only **blast-radius** count on `project-sites-db-production` (`wrangler d1 execute … --remote --json`);
  (2) capture **BEFORE** rows (esp. the columns you promise NOT to touch, e.g. `bucket_name`); (3) apply the file
  `wrangler d1 execute project-sites-db-production --remote --file migrations/NNNN_*.sql`; (4) **AFTER** read-back
  proves the change landed AND the untouched columns are byte-identical. Data migrations are reversible + additive
  → canonical #3 (ship when green); a DESTRUCTIVE drop/bulk-overwrite is canonical #4 (pause). Schema-changing
  migrations still mirror the `[[env.production.migrations]]` tracked path.
- **Owner-facing copy = the owner's words, NEVER infra jargon** *(fire-buckets-ux §7).* Every user-visible string
  (headings, messages, button titles, errors, subtitles) must be understandable by a non-technical business owner —
  NEVER "R2 keys / R2 S3 credentials / object ops" etc. A "fix one place" does NOT cover all instances: GREP ALL
  user-facing strings for the jargon (the needs-creds jargon survived in 6 places after a prior banner-only fix).
  Regression-gated by the "owner-friendly needs-creds copy" Vitest case (needs-creds region has no `R2|S3|credential`).
- **⚠ Externally-blocked + saturated-session discipline** *(fire-buckets-ux §7).* When (a) the fully-verifiable
  backlog is nearly exhausted AND (b) the high-value work is externally-blocked (here: the R2-S3-creds decision) AND
  (c) the session is deep/saturated — do NOT grind thin ceremony slices (per [[focus-cron-on-completed-externally-blocked-target-stop-ceremony-fires]] + [[loop-fires-need-fresh-context-not-saturated-session]]). Ship a genuine
  decision-independent win if one exists (e.g. this fire's owner-copy fix), ESCALATE the gating decision crisply, and
  RECOMMEND Brian decide or pause the cron. The cron is NOT CronDelete'd (DoD unmet) but continued identical re-fires
  on a blocked target trend toward flooding.
- **Dormant backend-foundation slice → verify = migration-applied + deploy-clean + units, NOT real-browser**
  *(fire-buckets-b5-slice1 §7).* A slice that ships a NEW service/table but wires NOTHING to a route/UI yet
  (flag-dark, uncalled — B5 slice 1; future B6-Workflow / B9-gateway / B10-pointer foundations) has NO live
  surface to drive, so its correct proof is: (1) the migration applied + the table/column present on prod
  (`sqlite_master` read-back); (2) a CLEAN `wrangler deploy` (esbuild bundling the new code = integration
  proof); (3) the unit suite + `validate:features`. The real-browser proof lands on the CONSUMING slice that
  flips the behavior on — do NOT falsely ding a dormant foundation for "no real-browser verify", and do NOT
  claim it's user-visible. State plainly in the report that the slice is dormant until its consumer ships.
- **Retire the loop cron when this DoD is genuinely met** (per [[loop-cron-refires-one-prompt-retire-when-directive-complete]]) — don't flood.
