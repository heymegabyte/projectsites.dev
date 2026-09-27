# Data Platform — Scope & Roadmap (North Star)

> **This is the authoritative scope for the "Data" section re-architecture.** The recurring Data
> loop executes against THIS doc, top-down. Captured from a design session with Brian (2026-09-25,
> 7 question rounds / 27 decisions). Supersedes the incremental `data-section-capability-matrix.md`
> as the PLAN of record for the re-arch; the matrix keeps tracking SHIPPED increments.

## North star (one line)

**The ultimate Cloudflare D1 data-management tool with Airtable-class features (per-site), plus an
auxiliary KV manager — spreadsheet-first, AI-native, SQL completely hidden.** Not a site CMS; a
generic, brilliant data platform each site owns.

## Locked decisions (2026-09-25 design session)

### Architecture & provisioning
- **Per-site resources.** Every site is provisioned with its OWN D1 + KV + R2 under its namespace
  (Workers for Platforms) — NOT today's shared-D1-with-`site_id`.
- **One D1 per site, MANY tables** (grouped into folders for organization). No multi-base layer.
- **Provision on create, IN PARALLEL** with the other site-provisioning tasks (D1 must be one of them).
- **All platform-generated tenant data migrates into the site's own D1** — `form_submissions` (leads)
  + `visitor_events` (analytics) become first-class, owner-editable tables. Ingestion re-points to
  write per-site.
- **Scale = hard D1 limit (~10 GB) + upgrade prompt.** The Neon escape hatch stays MODELLED
  (`db_allocation.ts`) but DORMANT — do not auto-escalate for now.
- **Reuse existing scaffolding:** `src/services/db_allocation.ts` (`chooseDbAllocation` → `d1_tenant_db`),
  `src/services/site_capability_manifest.ts` (per-site db plan), migrations `0572_tenant_db_assignments`
  + `0573_site_database_allocations` (allocation tables + `status` state machine: active | provisioning |
  migrating | retired), and the `upstash_provisioner.ts` pattern for the new D1 provisioner.

### Rollout — greenfield reset (⚠️ GATED destructive step, Phase 0)
- **Remove ALL existing sites + all traces → clean slate.** No migration of old tenant data.
- ⚠️ **BLAST-RADIUS CAVEAT (must be precisely scoped + confirmed before ANY delete):** the shared prod D1
  has **hundreds of tables**, most of which are PLATFORM tables (users, orgs, billing/subscriptions,
  feature_flags, affiliates, agencies, api_tokens, audit_logs, wallets…) — NOT per-site data. "All traces
  of sites" must be defined as **the site-scoped rows/resources ONLY** (site_id-scoped D1 rows across the
  tenant tables + each site's R2 objects + KV keys + deployed WfP worker + hostnames/DNS), and must
  **preserve** the platform tables (auth/billing/flags/agencies) — else the reset wipes the whole product.
  Requires: (1) a full D1 export backup + R2/KV inventory (reversible), (2) an explicit enumerated
  delete-list, (3) a final human "execute" confirm. **Never run from a loop re-prompt.**
- **`brian@megabyte.space`** = the test account + **admin privileges** + **payment bypass** (test paid
  features without paying). This part is non-destructive (auth/entitlement config).
- New sites → per-site D1 (+KV+R2) provisioned in parallel on create.
- ⚠️ "Remove all sites" is destructive/prod: execute **deliberately** — take a backup, confirm the exact
  blast radius, keep it reversible, behind a one-time gated action. First thing in Phase 0. **Never run blind.**

### Plan gating
- **Paid = own DB + full Airtable-class platform.** Free = shared / read-only / limited. (Matches
  `db_allocation` paid → `d1_tenant_db`.)

### Editing UX
- **Spreadsheet-first, FULL parity:** inline typed cell editors, keyboard nav (arrows/Tab/Enter), range
  select + copy/paste to & from Sheets, AutoFill drag, frozen header + pinned columns, column
  resize/reorder/hide, virtualization past ~1k rows, state persistence (column order/width/filters/views).
- **Immediate save + undo** (optimistic; NOT staged-commit).
- **Single-editor + audit log** — no real-time multi-user (no live cursors/presence/comments).

### Field types (Airtable-class)
- Single/multi-select with color chips · file **attachments (→ the site's own R2)** · **full linked records**
  (bidirectional links, lookup + rollup across links, many-to-many via junction, referential display —
  show the linked row's title, not a raw id) · formulas · ratings · dates with formatting · + typed
  primitives (text / number / boolean / date / JSON / NULL).
- **Validation = the field TYPES carry it.** No separate rule layer, no AI data-cleaning.

### Schema builder
- **Full builder:** create tables, add/rename/retype columns, define relations — guided DDL + DDL
  preview + validation + impact summary + explicit confirm + safe **migration plans** (rebuild when
  ALTER can't do it).

### AI copilot (SQL fully hidden from the user)
- **Full copilot:** NL query (read) + NL edits ("archive all spam leads") + AI insights / anomaly
  detection + AI-generated formulas & columns + conversational chat over the data + AI data-cleaning/dedup.
- **AI-first onboarding:** "what do you want to track?" → AI generates the tables/fields/sample rows.
  Templates as fallback.
- **AI-made changes apply IMMEDIATELY + undo** (matching the immediate-save model) — NOT preview-confirm.
  The undo (and the audit log + row history) is the safety net for a wrong NL interpretation.
- The raw SQL console is **retired from the owner UI**; the existing `nl2sql` powers NL→query under the hood.

### Mobile
- **Full responsive touch grid — first-class editing on phones/tablets**, not desktop-only. The spreadsheet,
  inline editors, and core flows work on touch (owners updating data on the go).

### Views, forms, automations, API — CF-native
- **View types:** Grid (default) + Kanban (group-by column) + Calendar (date column) + Gallery (cards) +
  **public Form** (owner builds it → embeds on their site → submissions land as rows in their D1).
- **Automations:** row triggers → email / webhook.
- **Auto REST API** per table (secured, per-table keys + scopes) + shareable read-only view links / embeds.
- **Integration/ecosystem layer designed around Cloudflare + Workers-for-Platforms primitives**
  (dispatch workers, Queues, etc.) — CF-first; pick native integrations that fit CF/WfP.

### Import / export / sync
- **Full:** mapped CSV / Excel / JSON import (header/type mapping, NULL handling, conflict behavior,
  validation, progress, resumable chunks) + **2-way Google Sheets sync** + external API/DB sync
  (scheduled) + pre-built **table templates** (CRM / inventory / events / content calendar) + export /
  portability.

### Backup & recovery
- **Full:** per-site D1 **Time-Travel** (point-in-time) + owner-triggered **snapshots** + **one-click
  restore** + full **per-row change history** (undo across sessions). Confirm + identify exact DB before
  any restore; log the outcome.

### Findability
- **Global search** across every table/row in the base + a **Cmd+K command palette** (jump to any
  table/view/record + run actions: create table, import, ask AI).

### KV (auxiliary)
- **KV editor:** key/value grid, TTL, JSON values, bounded bulk ops, eventual-consistency disclosed.
  The site's own KV namespace.

### R2 / Files — via the EDITOR, not a Data tab
- R2 is **not** a Data-section tab. Instead **wire the editor's existing Files/Code panel to the site's R2**
  — the files shown + edited in the code editor ARE the R2 objects. **Load as fast as possible.** (The
  attachment field type writes to the same R2.)

### Explicitly OUT of the Data section
- Vectorize · Queues · R2-as-a-Data-tab (R2 lives in the editor Files panel instead) · real-time
  multi-user · field-level encryption (permission controls instead) · a separate notification system ·
  multi-base per site · auto-Neon-escalation (modelled but dormant).

## Phased roadmap (the loop ships one verified increment per fire, top-down)

**Phase 0 — Foundation & greenfield reset (gated)**
- 0a. ⚠️ Greenfield reset: remove all sites + traces (backup + confirm + reversible).
- 0b. `brian@megabyte.space` → admin + payment bypass + test account.
- 0c. **Per-site provisioning service** — on site-create, provision D1 (+ KV + R2) IN PARALLEL; record in
  `site_database_allocations`; bind to the site's WfP dispatch worker. Feature-flagged, dark by default.
  - **✅ 0c.1 DONE (2026-09-25):** the **D1 provisioner** — migration `0633` adds `d1_database_id`/`d1_database_name`
    to `site_database_allocations`; `src/services/d1_provisioner.ts` `provisionSiteD1()` creates a dedicated
    D1 via CF REST (`POST /accounts/{CF_ACCOUNT_ID}/d1/database`), server-side creds (`resolveCfCredentials`),
    idempotent (reuse existing active allocation — never a duplicate on retry), honest typed failures
    (no-creds / cf-fail) that record NOTHING. +5 Jest (real-SQLite + mocked CF → zero real resources). INERT
    until 0c.2.
  - **✅ 0c.3 DONE (2026-09-25, multi-agent fan-out):** the **KV + R2 provisioners** — migration `0634` adds
    `kv_namespace_id`/`kv_namespace_name`/`r2_bucket_name`; `src/services/kv_provisioner.ts` `provisionSiteKv()`
    (`POST …/storage/kv/namespaces`) + `src/services/r2_provisioner.ts` `provisionSiteR2()` (`POST …/r2/buckets`,
    bucket names lowercase ≤63). Same safety/idempotency/honest-failure contract as D1. +10 Jest (real-SQLite +
    mocked CF).
  - **✅ 0c.2 DONE (2026-09-25):** the three provisioners are now **wired live but DARK**. New `per_site_data`
    feature flag (registry + docs, `default_enabled:false, rollout:0, stage:'experimental'`); `createSite()`
    calls `provisionSiteD1/Kv/R2` **IN PARALLEL (`Promise.all`)** from a `waitUntil`'d, flag-gated, fail-soft
    block (mirrors the `github_repo_sync` pattern) — so a CF/provisioning hiccup NEVER blocks site creation and
    NO real Cloudflare resource is created until the flag is promoted. +5 Jest (flag ON→all three called with
    `{orgId,siteId,tenantId}` · flag OFF→none · no-execCtx→none · provisioner-throw→creation still returns ·
    anon create→`orgId:null`). Full worker suite 792/12706 green, tsc 0, eslint 0-err.
- 0d. **NEXT** — Re-point ingestion (`form_submissions`, `visitor_events`) to write to the site's own D1.

> **Multi-agent fan-out (2026-09-25)** also landed the PURE FOUNDATIONS for later phases (built by parallel
> agents, folded + verified foreground): **Phase 2** `app/components/workbench/field-types.ts` (Airtable field-type
> registry — 10 kinds, coerce/format, +63 Vitest) + `schema-ddl.ts` (pure DDL generators for create/alter table+
> column+index, identifier-safe, +32 Vitest); **Phase 4** `view-models.ts` (Kanban `groupRowsByColumn` / Calendar
> `bucketRowsByDate` / Gallery `galleryPages`, +22 Vitest). All pure + tested + INERT (wired when those phases' UI ships).

**Phase 1 — Spreadsheet core** (over per-site D1)
- Resource-aware Data shell: **Platform DB (read-only, super-admin)** · **My Site's Data (read/edit)** · **KV**.
  Remove the Vectorize/Queues/R2 tabs.
- Full-parity grid: typed inline editors · keyboard nav · immediate-save + undo · frozen header ·
  filter/sort chips · virtualization · CSV in/out · state persistence.

**Phase 2 — Schema builder + rich fields**
- Full builder (tables/columns/relations, guided DDL + migration plans).
- Rich field types (select, attachments→R2, linked records + lookup/rollup, formulas).

**Phase 3 — AI copilot (SQL hidden)**
- NL query + NL edits + insights + formula-gen + conversational chat + data-cleaning. AI-first onboarding.

**Phase 4 — Views · forms · automations · API**
- Kanban / Calendar / Gallery / public Form; automations (row → email/webhook); auto REST API +
  shareable links; CF-native integrations.

**Phase 5 — Backup · search · governance · import/sync**
- Time-Travel + snapshots + restore + row history; global search + Cmd+K; field + row permissions +
  roles (owner/editor/viewer) + PII masking; full import + 2-way Sheets sync + templates.

**Phase 6 — KV auxiliary + R2-in-editor-Files**
- KV editor; wire the editor Files panel to the site's R2 (fast-loading).

## Reuse / de-risk (do NOT throw the existing engine away)
- **Port, don't rebuild:** the mature `app/components/workbench/d1-browser-logic.ts` (schema parse, FK,
  ERD, insights) + `data-panel-logic.ts` (CRUD builders, `buildCsvImportPlan`, `analyzeRowLimit`, charts,
  `explainPlanHint`) + `nl2sql` become the ENGINE under the new spreadsheet UI.
- **Provisioning** follows `upstash_provisioner.ts`; reuses `db_allocation.ts` + `site_capability_manifest.ts`
  + migrations 0572/0573.
- Every phase behind a feature flag (`enabled=0, rollout=0, stage='experimental'`) per `rules/feature-flags`.

## Supersession
- This doc is the north star. `data-section-capability-matrix.md` keeps tracking shipped increments; new
  work is PLANNED here and reflected there as it lands. When in doubt, this doc wins on direction.

## Combined spec + loop (2026-09-26)
Brian merged the two Data loops into ONE 12-min loop (`347f0e04`) carrying the full "best-possible Data tab"
spec (Airtable record editing × DB-Browser/Beekeeper/DBeaver SQLite tooling × an AI assistant that helps at
every step; D1 = source of truth for schema+records, KV = keys+values). Delivery order (complete slices,
in order): (1) authorized resource discovery + binding reconciliation + empty state + resource creation;
(2) real D1 schema explorer + fast read-only paginated grid; (3) safe single-row + bulk editing + clipboard
+ filters + saved grid views; (4) SQL workspace + schema/migration workflow; (5) grounded "Ask your data"
(typed intent → deterministic parameterized SQL → visible SQL + evidence + eval fixtures); (6) import/export/
recovery + rich non-grid views; (7) KV browser/editor; (8) AI fields + copilots + budgets + optional
semantic search. Governance throughout: one server-side authz check per read/mutation/export/AI-tool-call;
never trust a client D1 id/namespace/binding as authz; parameterized values + quoted schema-validated
identifiers; CF + model creds server-side; AI via CF AI Gateway (current endpoints, not the deprecated
Universal Endpoint), task-aware model routing, per-tenant budget ledger; treat customer data/results/imports
as UNTRUSTED (test cross-tenant + prompt injection).

### Current-state audit (2026-09-26, two read-only scans — what EXISTS today)
- **Editor UI (`app/components/workbench/`):** `DataPanel.tsx` (3316 lines) + `D1Browser.tsx` (read-only
  resource inspector: db list / overview / schema / async SQL-dump export / AI explain / column profile,
  super-admin `PS_D1_REQUEST` → `/api/admin/d1/*`) + `KvBrowser.tsx`. Row CRUD lives in DataPanel's Tables
  tab via `PS_DATA_REQUEST`→`/api/sites/:id/data-overview` + `PS_SQL_REQUEST`→`/api/sites/:id/sql/{exec,
  exec-write,nl2sql,schema,migrations}`. Cell editors: text/number/boolean/null/json only (NO date/select/
  url/email/BLOB). No schema-builder (CREATE/ALTER) UI. **No mock buttons found** — all wired to real APIs.
- **Worker API:** D1 Manager (`libs/features/d1_manager/handlers.ts`) super-admin-gated (404 on fail, account
  from `env.CF_ACCOUNT_ID`, creds via `resolveCfCredentials` — never client). Site data (`libs/features/
  site_data_api` + `src/routes/site_detail_tabs.ts`): `ownsSiteData(db,siteId,orgId)` IDOR guard (org-scoped,
  404 on mismatch), parameterized `.bind()`, identifiers validated `SAFE_IDENT` before PRAGMA interpolation,
  SQL read-allowlist `^(SELECT|EXPLAIN|WITH|PRAGMA)` + write path with PROTECTED_TABLES denylist + destructive
  confirm. KV inspector: server allowlist `['CACHE_KV','PROMPT_STORE']`, super-admin, cursor pagination.
- **Inert tested foundations** (wire as their slice ships): `field-types.ts` (10 Airtable kinds), `schema-ddl.ts`
  (create/alter DDL generators), `view-models.ts` (Kanban/Calendar/Gallery). Per-site D1/KV/R2 provisioners
  (`d1_provisioner.ts` etc.) wired DARK behind `per_site_data` (Phase 0c) — no per-site resources in prod yet.
- **Grid decision (OPEN):** the spec wants RevoGrid Core vs Tabulator evaluated against a real paginated D1
  dev DB (license-checked, no Enterprise-only features). NOT yet done — the current grid is a hand-rolled
  `<table>` in DataPanel. **Next grid fire must run that eval + record the license boundary here BEFORE adopting.**

### ✅ Shipped this fire (2026-09-26) — honest URL/email cell presentation (slice 3, "typed presentation")
`classifyCell` (`data-cell-format.ts`, the pure grid chokepoint) gained `url` + `email` kinds: a whole-string
`http(s)` URL or single email becomes a SAFE clickable link (`href` = the URL / `mailto:<addr>`). XSS-guarded —
only http(s)/mailto are ever emitted; `javascript:`/`data:`/`vbscript:`/`ftp:`/`file:` never match → stay plain
text with no href. Anchored regexes (whole-string only) so prose that merely contains a URL/@ stays text; URL
checked before email so a userinfo URL isn't mis-read. DataPanel grid renders `href` cells as
`<a target=_blank rel="noopener noreferrer nofollow" onClick=stopPropagation>` (never triggers a parent
row/cell handler), else a plain span. HONEST: SQLite stores text; this is a UI interpretation (link affordance),
not a schema-enforced type. +10 Vitest (url/http/email/userinfo-url/XSS-guards ×3/false-positive-guards ×2/
regression). Verified: Vitest 77/77 (data-cell-format) + 369/369 (6 workbench specs), editor tsc 0, eslint 0,
`npm run build` ✓ (client 16.9s + server). Editor auto-deploys via CF Pages on push.
### ✅ Shipped next fire (2026-09-26 #2) — SQLite-accurate schema explorer (slice 2)
The D1 schema explorer (`D1Browser.tsx`, columns parsed client-side from CREATE SQL because D1's REST `/query`
blocks PRAGMA) now reflects REAL SQLite semantics the parser previously ignored — the DB-Browser/DBeaver-grade
accuracy the spec demands ("handle WITHOUT ROWID, STRICT tables, FTS5, generated columns"; "prevent editing
generated/non-writable fields"):
- **Generated (computed) columns** — `parseCreateTableColumns` now sets `generated` per column (detects
  `[GENERATED ALWAYS] AS (expr)`; precise — a `CAST(x AS INT)` in a DEFAULT is `AS <type>`, never `AS (`, so no
  false positive). `D1ColumnInfo.generated?: boolean`. A **GEN** badge renders beside PK/FK with a read-only
  tooltip (SQLite rejects writing a generated column — this is the foundation for the grid's future
  prevent-edit-generated safety).
- **Table modifiers** — new pure `parseTableModifiers(sql)` → `{withoutRowid, strict}` (inspects ONLY the tail
  after the balanced column-list `)`, so a column named `strict` or a CHECK mentioning the phrase can't
  false-positive). **WITHOUT ROWID** / **STRICT** badges above the columns grid.
- **Virtual/FTS5 tables** — new pure `virtualTableModule(sql)` → `'fts5'`/`'rtree'`/… (or null). A **VIRTUAL ·
  fts5** badge + an honest empty-columns note ("its columns are defined by the module … a full SQL export of an
  FTS table is a documented Cloudflare D1 limitation") instead of the generic "unavailable" message.
- +14 Vitest (generated ×4 incl. CAST false-positive guard; modifiers ×5 incl. column-named-strict guard +
  view/null; virtual-module ×3 + null). Verified: Vitest 57/57 (d1-browser-logic) + 134 with siblings, editor
  tsc 0, eslint 0, `npm run build` ✓ (12.97s). All pure + honest (parsed from real DDL, never fabricated).

### ✅ Shipped next fire (2026-09-26 #3) — generated columns are read-only in the grid EDIT path (slice 3)
SQLite REJECTS writing a generated (computed) column, so the row grid previously offered a **doomed edit** on
one. Now DataPanel detects them and presents them read-only + labelled ("never a doomed/dead control"):
- **Detection** — the per-table PK probe switched from `PRAGMA table_info("t")` to
  `SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo('t')` to also read `hidden`
  (2 = VIRTUAL, 3 = STORED generated). This runs on the **site SQL path** (`/api/sites/:id/sql/exec` →
  `c.env.DB.prepare`, the Worker BINDING), where PRAGMA + the `pragma_*` table-valued functions ARE allowed —
  UNLIKE the CF REST `/query` account path, which blocks them (see the `d1-rest-query-blocks-pragma` memory).
  So bare `PRAGMA table_xinfo` would work here too; the TVF SELECT form is chosen only for consistency with the
  bulk schema query. Same cid/name/type/pk fields → the existing PK + type parse is unchanged (no regression).
  `t` is a validated bare identifier, so the quoted arg is injection-free.
- **Pure helper** `generatedFromTableXinfo(rows)` → `Set<string>` (mirrors `pkFromTableInfo`; `hidden≥2`; accepts
  the `"column"` alias + string `hidden`; empty on `[]`/absent field). +4 Vitest.
- **Enforcement** — `browseGeneratedCols` state (reset per table): the row-detail `editable` gate excludes
  generated columns; `startEdit` early-returns on one (no editor ever opens); `duplicateRow` omits them from the
  prefilled INSERT (like the PK — SQLite rejects supplying a generated value). A small amber **"computed"** chip
  with a tooltip renders where the edit pencil would be, so it's an EXPLAINED read-only, not a silent dead cell.
- Verified: Vitest 177/177 (data-panel-logic) + 342 across 5 workbench specs, editor tsc 0, eslint 0,
  `npm run build` ✓ (13.86s). Honest: a checkbox/date is still just a UI interpretation; only generated-ness is
  schema-enforced (from `hidden`), and that's exactly what we gate on.

### ✅ Shipped next fire (2026-09-26 #4) — server-side pagination wired into the browse grid (slice 2 complete)
The worker's `GET /api/sites/:id/data-overview/:table` ALREADY paginated (clamped `limit` 1–100, `offset`,
server `orderBy`, returns `total` — `data_browse_pagination.test.ts`), but the editor never sent the params:
the admin bridge **hardcoded `{limit:'25'}` with no offset**, and `PS_DATA_REQUEST` carried no pagination — so
the grid was stuck on page 1 ("showing latest 25 of N", no way forward). Now it's real pagination end-to-end:
- **Admin bridge** (`bolt-embed.service.ts`) — `PsMessage` gains `offset?`/`limit?`; the `PS_DATA_REQUEST`
  handler forwards them to the query (re-clamped 1–100 / ≥0; defaults preserve the old first-page-of-25 behaviour).
- **Editor** (`DataPanel.tsx`) — `PS_DATA_REQUEST` message gains `offset`/`limit`; a shared `requestRows(key,
  offset)` (page size `BROWSE_PAGE_SIZE=25`) is used by `openTable` (offset 0, full reset) + a new `goToPage`
  (page nav, light reset — keeps columns/sort/PK/generated, clears rows+selection+detail). `browseOffset` state
  resets per table. The honest disclosure became **Prev · "26–50 of 1,234" · Next** (an explicit range, buttons
  disabled at the ends + while loading), and search is now labelled "match **on page**" (distinct from a
  whole-table query, per the spec). The browser never loads the whole table — one bounded page per request.
- **Pure helper** `browsePageInfo(offset, loadedCount, total)` → `{from,to,hasPrev,hasNext,label}` (1-based
  range, `hasNext` from `total` not a fetched extra row, floors/clamps hostile/NaN input, honest "No rows" /
  "0 of N"). +7 Vitest.
- Verified: Vitest 184/184 (data-panel-logic) editor tsc 0 / eslint 0 / build ✓ (12.68s); admin (Angular) tsc 0 /
  eslint 0 / `ng build` prod ✓ (8.4s). BOTH surfaces deploy on push (editor→Pages, admin→R2 via worker pipeline).
  Storage: unchanged — rows come live from the worker's paginated D1 read; no UI state in customer tables.

### ✅ Shipped next fire (2026-09-26 #5) — server-side SORT wired to the column headers (slice 2/3)
The column-header click already cycled a sort (asc→desc→off) but `sortRows` only sorted the LOADED PAGE
client-side — so "sort by name" sorted 25 rows, not the table. The worker's `data-overview/:table` already
accepted `orderBy`+`dir` (allowlist-validated: `spec.columns.includes(orderBy)` is the injection boundary; `dir`
clamped asc/desc). Now the header click sorts the WHOLE table server-side:
- **Editor** (`DataPanel.tsx`) — `PS_DATA_REQUEST` gains `orderBy`/`dir`; `requestRows(key, offset, sort)` sends
  them via the new pure `sortToParams(sort)`. `toggleBrowseSort` now cycles the sort, **resets to page 0** (a new
  order re-pages the whole table), closes the row-detail + clears selection, and re-fetches. `goToPage` preserves
  the active sort across page nav. Crucially, `visibleRows` **no longer client re-sorts** — the page arrives
  server-sorted, and a client re-sort (different NULL/collation ordering) would diverge from the server's page
  boundaries; `search` still filters THIS page only ("find on this page"). The header ▲/▼ + `aria-sort` still
  reflect `browseSort`. (`sortRows` stays — the SQL-console result grid still uses it.)
- **Admin bridge** (`bolt-embed.service.ts`) — `PsMessage` gains `orderBy?`/`dir?`; forwarded (length-capped /
  asc-desc-only) to the query, only when present. The worker remains the validation boundary.
- **Pure helper** `sortToParams(GridSort|null)` → `{orderBy?,dir?}` (null → `{}` = default order). +2 Vitest
  (`nextSort` cycle already covered). Verified: Vitest 186/186 (data-panel-logic), editor tsc 0 / eslint 0 /
  build ✓ (12.70s); admin tsc 0 / eslint 0 / `ng build` prod ✓ (8.4s). Both deploy on push. Storage unchanged.
- **Security:** the editor/admin never trust the sort column — the worker's `spec.columns.includes(orderBy)`
  allowlist is the sole injection boundary; a hostile `orderBy` is silently ignored (default sort kept).

### ✅ Shipped next fire (2026-09-26 #6) — whole-table server-side SEARCH (slice 2/3; server filter/sort/search now complete)
The search box previously filtered only the LOADED 25-row page client-side (`filterRows`). The worker's
`data-overview/:table` already ran a parameterized OR-of-LIKE over allowlisted columns and reflected it in
`total`, but the editor never sent `search` nor read the filtered `total`. Now the box searches the WHOLE table:
- **Editor** (`DataPanel.tsx`) — `PS_DATA_REQUEST` gains `search`; a **debounced** (300 ms) `onSearchChange`
  runs `runServerSearch` → **reset to page 0** + re-fetch with the needle (Clear is instant). `requestRows(key,
  offset, sort, search)` sends it via the new pure `browseSearchParam`. The client `filterRows` is **removed** —
  the page arrives already server-filtered+sorted, so a client re-filter would diverge from the server's page
  boundaries + match `total`. The response `total` (filtered) is captured into `browseTotal` and drives
  `pageInfo` (falls back to the overview `row_count` before the first page lands), so the range pages through the
  MATCHES; the disclosure shows `matching "<q>"` (honest: a whole-table query, not "on this page"). The search
  box now **persists when a search returns 0 rows** (was gated on `rows.length>0` → became un-clearable).
- **Response envelope** — the admin bridge now forwards the worker's `total` (was dropped); `DataResponseMessage`
  gains `total?`; `PsMessage`/admin forward `search` (trimmed, length-capped). Worker stays the validation boundary.
- **Pure helper** `browseSearchParam(search)` → `{search?}` (trims, omits blank). +2 Vitest.
- Verified: Vitest 188/188 (data-panel-logic), editor tsc 0 / eslint 0 / build ✓ (13.12s); admin tsc 0 / eslint 0 /
  `ng build` prod ✓ (8.5s). Both deploy on push. **Server filter/sort/search + pagination are now all wired.**
- **Security:** the editor/admin never build SQL — the worker's `buildDataSearch`/`buildColumnFilter` +
  `spec.columns` allowlist + parameterized values are the sole injection boundary; a hostile needle is just a LIKE value.
- **Cost note (follow-on):** the OR-of-LIKE is an UNINDEXED scan. Fine for the curated tables today, but the spec
  wants "warn before expensive unindexed scans / FTS5 when an index exists" — a future refinement once table sizes
  or FTS5 indexes are known (surface a subtle "scans all N rows" hint / prefer FTS5 `MATCH` where a virtual table exists).

### ✅ Shipped next fire (2026-09-26 #7) — exact-column FILTER UI (slice 3 filters; server filter/sort/search all wired)
The worker already ran `buildColumnFilter` (exact `"col" = ?`, allowlist-validated, blank value ignored,
reflected in `total`) but no UI drove it. Now a per-column filter composes with search + sort + pagination:
- **Editor** (`DataPanel.tsx`) — a compact filter row under the search box: a **column `<select>`** (all table
  columns) + a **value input** (shown once a column is chosen) + a clear `×`. Value edits are debounced (300 ms);
  choosing/clearing the column re-applies immediately. Any change **resets to page 0** and re-fetches with the
  current sort+search. The disclosure shows `where <col> = "<val>"` (honest whole-table filter), and the box
  persists on a 0-result filter so it's changeable. `filterCol`/`filterVal` state resets per table.
- **Consolidation** — the growing browse query is now a single `BrowseFilters` bundle `{search, filterCol,
  filterVal}`; `requestRows(key, offset, sort, filters)` sends it via the new pure `filtersToParams` (subsumes
  `browseSearchParam`, sends `filterCol`/`filterVal` only when BOTH set — matching the worker). +4 Vitest.
- **Response envelope + admin** — `PS_DATA_REQUEST`/`PsMessage` gain `filterCol`/`filterVal`; the admin forwards
  the trimmed, length-capped pair only when both present. Worker stays the validation boundary.
- Verified: Vitest 192/192 (data-panel-logic), editor tsc 0 / eslint 0 / build ✓ (12.85s); admin tsc 0 / eslint 0 /
  `ng build` prod ✓ (8.6s). Both deploy on push. **Server-side pagination + sort + search + exact-column filter are
  now ALL wired** — the read-only paginated grid (delivery #2) + its filter/sort/search (delivery #3) are complete.
- **Security:** the editor/admin never build SQL — the worker's `buildColumnFilter` + `spec.columns` allowlist +
  parameterized `?` value are the sole boundary; a hostile column is ignored, a hostile value is just a bound string.

### ✅ Shipped next fire (2026-09-26 #8) — rows-per-page selector (25/50/100); pagination UX complete
An **editor-only** slice (the admin already forwarded `limit`; the worker already clamps 1–100). The grid was
fixed at 25 rows/page; a big table (e.g. thousands of `visitor_events`) meant tedious paging. Now a `25/50/100`
selector sits beside Prev/Next:
- `browsePageSize` state + a `pageSizeRef` mirror so `requestRows` reads the CURRENT size even when the change
  fires the re-fetch the same tick (avoids a stale-closure — the size change resets to page 0 + re-fetches keeping
  sort+search+filter). Prev/Next step by the chosen size. Page size PERSISTS across tables (a user preference).
- Pure `clampPageSize(n)` → an offered `PAGE_SIZE_OPTIONS` size (else the 25 default) guards the request path;
  the worker's 1–100 clamp is the real boundary. +2 Vitest.
- Verified: Vitest 194/194 (data-panel-logic), editor tsc 0 / eslint 0 / build ✓ (13.31s). Editor-only → CF Pages
  deploy on push. **The read-only grid is now fully server-driven: pagination (+ page size) + sort + search + filter.**

### ✅ Shipped next fire (2026-09-26 #9) — Add-row form omits GENERATED columns (edit + add paths now both safe)
Completing the generated-column safety started in the edit path: the Add-row form rendered an opt-in type+value
input for EVERY column, so a user could set a value for a generated (computed) column → a doomed INSERT that
SQLite rejects. Now (editor-only):
- The Add-row form renders a generated column as a read-only **"computed — set automatically by SQLite, not
  insertable"** row (amber chip, matching the edit-path indicator) instead of an editable select+input — never a
  doomed control.
- New pure `insertableColumns(columns, kinds, generated)` → the INSERT column set (opted-in kind ≠ 'default' AND
  not generated), used by BOTH the live SQL preview and the submit so they can't diverge — a defensive guard even
  if a stale `addKinds` entry names a generated column. +3 Vitest.
- Verified: Vitest 197/197 (data-panel-logic), editor tsc 0 / eslint 0 / build ✓ (12.89s). Editor-only → CF Pages.
  **Generated columns are now non-writable across BOTH edit + add + duplicate paths** (SQLite's schema-enforced
  non-writability is honored end-to-end).

### ✅ Shipped next fire (2026-09-26 #10) — skip COUNT(*) on page-nav/sort (no expensive count on every nav)
The spec: "avoid expensive exact counts on every nav." The worker ran `COUNT(*)` on EVERY browse (a
`Promise.all([browse, count])`), yet the total only changes when the QUERY (search/filter/mutation) changes —
NOT when you page or sort. Now the count is conditional (worker + admin + editor, backward-compatible):
- **Worker** (`site_data_api/handlers.ts`) — `count=0` skips the `COUNT(*)` and returns `total: null`; any other
  value / absent still counts (existing callers unchanged). +2 Jest (asserts the COUNT query is NOT prepared when
  `count=0` → `total` null; default still prepares it → numeric total).
- **Editor** — `requestRows(…, withCount)` sends `count: withCount ? 1 : 0`. Table-open / search / filter /
  post-mutation re-open request the count (`true`); page-nav / sort / page-size skip it (`false`). The browse
  reply now KEEPS the cached `browseTotal` on a `null` total (`setBrowseTotal(prev => …)`) instead of clobbering
  it — correct because paging/sorting don't change the count. `PS_DATA_REQUEST` gains `count`;
  `DataResponseMessage.total` is now `number | null`.
- **Admin bridge** — forwards `count=0` (the skip signal) to the worker query; the existing `typeof total ===
  'number'` reply-guard already drops a null total, so the editor keeps its cache.
- Verified: worker Jest 10/10 (data_browse_pagination) + tsc 0; editor tsc 0 / Vitest 197 / eslint 0 / build ✓
  (12.94s); admin tsc 0 / eslint 0 / `ng build` prod ✓ (8.4s). Worker deploys via CI on push; editor→Pages, admin→R2.
- **Honesty:** the cached total is EXACT for page-nav/sort (those don't change the row count) — not an estimate;
  it refreshes on any query change or the editor's own add/delete (which re-open the table with a fresh count). A
  concurrent external write is the only staleness window, corrected on the next query change (acceptable per spec).

### ✅ Shipped next fire (2026-09-26 #11) — honest ISO date/datetime presentation in grid cells
The grid showed timestamps as raw ISO (`2024-01-01T15:45:00Z`); the spec wants "date-time presentation" but
warns "a date widget is a UI INTERPRETATION unless the schema enforces it." Now `classifyCell`
(`data-cell-format.ts`, the pure grid chokepoint) reformats **unambiguous** ISO-8601 values readably while keeping
the raw one hover away (honest, never lossy):
- New `date` `CellKind` + a `title?` on `ClassifiedCell` (the RAW value → the cell's `title` tooltip). The grid
  `<td>` now uses `title={cell.title ?? cell.display}` so a date shows the readable form (`Jan 1, 2024`) with the
  exact stored value on hover. Soft-blue class so it reads as a date.
- **Only unambiguous ISO:** a bare `YYYY-MM-DD` (formatted in UTC → never shifts a day) and a datetime with an
  EXPLICIT `Z`/`±HH:MM` (an instant → shown in the viewer's local zone). A **zone-LESS** datetime
  (`2024-01-01T12:00:00` / space form) is deliberately NOT reformatted — we won't GUESS UTC-vs-local (that would
  be a dishonest display) — it stays plain text. Anchored regex + `Date` validation → prose-with-a-date and
  `2024-13-45` stay text; `2024` stays number.
- Display-only: CSV export + copy-as-JSON/INSERT/UPDATE keep the RAW value (they use the raw, not `classifyCell`);
  only the browse cell display is reformatted. +6 Vitest (date/zone-marked/zone-less-stays-text/invalid/prose/
  non-date). Verified: Vitest 83/83 (data-cell-format) + 337 across 3 workbench specs, editor tsc 0 / eslint 0 /
  build ✓ (13.13s). Editor-only → CF Pages.

### ✅ Shipped next fire (2026-09-26 #12) — comparison OPERATORS on the column filter (slice 3 filters deepen)
The column filter was exact-match only (`"col" = ?`). It now supports the full comparison set
**`= · ≠ · contains · > · < · ≥ · ≤ · is null · is not null`**, end-to-end and injection-safe:
- **Worker (`site_data_api/handlers.ts`)** — `buildColumnFilter` gains `FILTER_OPS`/`FilterOp`/`normalizeFilterOp`
  + an operator `switch`. The operator is mapped to a **FIXED clause string from the switch** (never user text);
  the column stays allowlist-gated (`spec.columns`) and every value is a bound `?` param. `contains` → `LIKE ?`
  with `% _` **stripped** from the needle (never metacharacters); `null`/`notnull` → value-free `IS [NOT] NULL`;
  an absent/unknown/mixed-case op **defaults to `eq`** so existing requests are byte-identical. +7 Jest.
- **Bridge** — `PS_DATA_REQUEST` carries `filterOp?`; the admin (`bolt-embed.service.ts`) forwards only a
  worker-recognized op (mirrors `PS_FILTER_OPS`) and sends **no** `filterVal` for value-free ops.
- **Editor (`data-panel-logic.ts`)** — `BrowseFilters.filterOp?` + `filtersToParams` (omits the default `eq` so
  exact-match requests are unchanged; value-free ops send column+op, no value) + pure `normalizeFilterOp` /
  `filterOpIsValueFree` / `filterIsActive` + `FILTER_OP_OPTIONS` (the dropdown's single source). +34 Vitest.
- **Grid UI (`DataPanel.tsx`)** — an operator `<select>` between the column select and the value box;
  the value input is **hidden** for `is null`/`is not null` (replaced by an "no value needed" hint), and the
  "· where …" note renders the operator symbol (`where age ≥ "18"`, `where deleted_at is null`). `filterOp` in
  every `requestRows` call (open/page/sort/search/filter/page-size) so operator + paging/sort compose.
- Verified: worker Jest **12726/12726** + tsc 0; editor Vitest **292/292** (logic+cell-format) + tsc 0 + eslint 0
  + build ✓; admin tsc 0 + `ng build --configuration production` ✓ (no errors). Editor → CF Pages, admin → Worker CI.

### 🐛 Deploy-gate fix (2026-09-26 #13) — CI was silently NOT deploying the worker for ≥2 fires
Investigating why #12's worker+admin parts would go live surfaced that the **last two Worker-CI runs (#10
count-skip, #11 ISO dates) `completed failure`** — the `Test worker package` job failed, which **skips the
`Deploy to Production` job** (shown as `-` / 0s). So the count-skip + ISO-date **worker** changes never actually
deployed (their editor-only parts did, via the independent CF Pages pipeline). Root cause: CI pinned
`NODE_VERSION: '20.19.0'`, but Node 20 has **no built-in `node:sqlite`**; the 7 real-SQLite reconcile/provisioner
suites (`helpers/d1_sqlite` → `node:sqlite`, the `verify-against-source-of-truth` guards) **threw at COLLECTION**
on CI (`Object.<anonymous>` top-level) → 7 suites failed → deploy skipped. Local runs passed (Node 26 has sqlite
stable), hiding it — a collect-time-throw-disables-the-gate class. Fix: bump `NODE_VERSION` **20.19.0 → 22.20.0**
+ add **`--experimental-sqlite`** to the test-unit job's `NODE_OPTIONS` (Node 22 gates `node:sqlite` behind it;
jest workers inherit `NODE_OPTIONS`). **Second latent failure unmasked once the test gate passed:** the Angular
production build (`Deploy to Staging`) exited 3 because the **Angular CLI requires Node ≥ 22.12** — so the first
attempt at 22.11.0 cleared node:sqlite but tripped Angular's engine floor. 22.20.0 (latest 22 LTS) clears BOTH the
node:sqlite (≥22.5) and Angular (≥22.12) constraints while staying on the documented "Node 22" line. Validated in
Docker on `node:22.20.0` with the exact CI `NODE_OPTIONS`: `node:sqlite` loads (harmless ExperimentalWarning only)
and the version satisfies Angular's floor; the 7 suites pass locally with the flag (27 tests). Unblocks the
worker+admin deploy for #12 and every future worker fire. `.github/workflows/project-sites.yaml`.

### ✅ Shipped next fire (2026-09-26 #14) — AND/OR multi-condition filter builder (slice 3 filters complete)
The single-column operator filter became a full **AND/OR condition group** — an Airtable-style filter builder —
end-to-end and injection-safe:
- **Worker (`site_data_api/handlers.ts`)** — extracted the per-condition predicate into `buildFilterLeaf` (shared by
  the single + multi paths) and added **`buildColumnFilters(columns, conditions[], combinator)`** — joins the ACTIVE
  leaves with a single `AND`/`OR` (`(a AND b AND c)`), ANDed onto the base `WHERE`, single condition → no parens,
  bounded to **`MAX_FILTER_CONDITIONS=20`**. `combinator` is whitelisted (`normalizeCombinator`, default `AND`, never
  user text); every leaf stays `spec.columns`-allowlisted + parameterized. **`parseFilterConditions`** shape-hardens
  the `?filters=` JSON (never throws → `[]` on malformed). Handler: `?filters=` (JSON) + `?filterCombinator=` takes
  precedence; the single `?filterCol/Op/Val` stays as a backward-compatible fallback. +13 Jest.
- **Bridge** — `PS_DATA_REQUEST.filters` (JSON) + `filterCombinator`; the admin forwards them (sanity-parses to a
  non-empty array ≤4000 chars, whitelists the combinator) taking precedence over the single-column path.
- **Editor (`data-panel-logic.ts`)** — `BrowseFilters` is now `{ search, conditions: FilterCondition[], combinator }`;
  `filtersToParams` serializes the active conditions to `filters` JSON (value-free ops → empty `val`; combinator sent
  only when >1 AND not the default). Pure `FilterCondition`/`FilterCombinator`/`normalizeCombinator`/`blankCondition`/
  `addCondition`/`removeCondition`/`updateCondition`/`activeConditions`/`filterGroupIsActive` + `MAX_FILTER_CONDITIONS`.
  +25 Vitest (214 total in that spec).
- **Grid UI (`DataPanel.tsx`)** — the single filter row is REPLACED by a condition builder: N rows (`where`/`and`/`or`
  prefix, column select, operator select, value input or "no value needed", per-row remove), an **AND/OR segmented
  toggle** shown when ≥2 conditions, an **＋ Add filter/condition** button (capped at 20), and **Clear all**. The
  "· where …" note summarizes the group (`where age ≥ "18"` for one, `3 filters (OR)` for many). Empty state = a
  single "Add filter" launchpad. `filterConditions`/`filterCombinator` thread through every `requestRows`.
- Verified: worker Jest **12739/12739** + tsc 0; editor Vitest **297/297** + tsc 0 + eslint 0 + build ✓; admin tsc 0 +
  `ng build --configuration production` ✓. Editor → CF Pages, worker+admin → Worker CI (now green on Node 22.20).

### ✅ Shipped next fire (2026-09-26 #15) — SAVED GRID VIEWS + the isolated metadata store (slice 3 complete)
The first slice of the **isolated ProjectSites.dev metadata store**: a saved view names a table's whole-table query
(search + AND/OR filter group + single-column sort) so an owner re-applies it in one click. Stored in the PLATFORM
db — **NEVER** in the customer's own tables — end-to-end and org-gated:
- **Migration (`0641_editor_grid_views.sql`, APPLIED to prod)** — `editor_grid_views (id, site_id, org_id, table_key,
  name, filters_json, combinator, sort_col, sort_dir, search, created_by, created_at, updated_at)` + a
  `(site_id, table_key, name)` index. Applied to `project-sites-db-production` via `wrangler d1 execute --remote`
  (verified: table present, `num_tables` 561). Additive + isolated (two-way door).
- **Worker (`site_data_api/handlers.ts`)** — three org-gated routes on the existing `siteDataApi` app (distinct
  `grid-views` segment → no `:table` shadow): `GET /api/sites/:siteId/grid-views?table=`, `POST …/grid-views`,
  `DELETE …/grid-views/:viewId`. Every route re-checks `ownsSiteData` (404 on foreign) + double-scopes rows by
  `site_id AND org_id`. Pure helpers `validateViewName` (1–80), `normalizeSortDir`, `serializeGridView` (parses
  `filters_json` back through `parseFilterConditions` — corrupt → `[]`, never throws; hides `org_id`/`created_by`),
  `MAX_GRID_VIEWS_PER_TABLE=50`. Save re-hardens filters + re-whitelists combinator/sort server-side; reads fail-soft
  (missing table → `{views:[]}`, never 500). +7 Jest.
- **Bridge** — `PS_VIEW_REQUEST` (`list`/`save`/`delete`) + `PS_VIEW_RESPONSE` + a `SavedGridView` type; the admin
  (`bolt-embed.service.ts`) proxies to the grid-views endpoints with the held session (worker re-authorizes).
- **Editor (`DataPanel.tsx`)** — a **Views** dropdown in the grid toolbar: lists this table's saved views (fetched on
  open via an `active`-keyed effect), **apply** loads a view's search+filters+combinator+sort and re-fetches page 0,
  **delete** is optimistic (reloads on error), and a "Save current view as…" input persists the CURRENT query
  (reusing `filtersToParams` so the stored `filters` JSON is byte-identical to what the grid sends). A new `activeRef`
  fixes the mount-only listener's stale-closure on `active`. Save JSON stored server-side, never in customer tables.
- Verified: worker Jest **12746/12746** + tsc 0; editor Vitest **297/297** + tsc 0 + eslint 0 + build ✓; admin tsc 0 +
  `ng build --configuration production` ✓; migration live in prod D1. Editor → CF Pages, worker+admin → Worker CI.

### ✅ Shipped next fire (2026-09-26 #16) — honest WHOLE-QUERY CSV/JSON export (fixes silent page-only truncation)
The grid's "Export CSV" silently exported only the LOADED PAGE (`visibleRows`, 25–100 rows) — a filter to 5,000
matches + Export gave ~50 rows with no warning (the exact dishonest-export hazard the doctrine flags). Now export
emits the WHOLE current query (search + AND/OR filter group + sort), bounded + honestly labelled:
- **Worker (`site_data_api/handlers.ts`)** — new `GET /api/sites/:siteId/data-overview/:table/export` (distinct
  `/export` segment → no `:table` shadow). Same auth (`ownsSiteData` 404) + safe-column allowlist + masked email as
  the browse (export is safe by construction — only the columns the grid shows). Extracted **`composeBrowseFilter`**
  (search + filter-group WHERE-suffix) so browse + export share ONE composition (no drift). Bounded to
  **`MAX_EXPORT_ROWS=10000`** via a `LIMIT MAX+1` fetch → `truncated` flag when the match set overflows (sliced to
  the cap, never silently dropped). Fail-soft (missing table → empty). +8 Jest (composeBrowseFilter + the export
  route via the D1 mock: all-rows-not-a-page, LIMIT+1/no-offset, truncated slicing).
- **Bridge** — `PS_DATA_REQUEST.exportAll` routes to `/export` (drops limit/offset/count; keeps sort+search+filters);
  the reply `data` carries `rows`+`columns`+`truncated`+`cap` (`DataResponseMessage.data` extended).
- **Editor (`DataPanel.tsx`)** — the CSV button + a NEW JSON button now `startExport(fmt)`: embedded → asks the admin
  to fetch ALL matching rows (reusing `filtersToParams` so the file matches the grid exactly) then formats + downloads
  client-side (`toCsv` / `JSON.stringify`) via a module `triggerDownload`; the export cid is matched BEFORE the browse
  handler (refs only → no stale closure) so it downloads instead of replacing the grid. An honest note ("Exported N
  rows" / "first 10,000 — narrow with filters") + a busy state. Standalone falls back to the loaded page, labelled.
- Verified: worker Jest **12754/12754** + tsc 0; editor Vitest **297/297** + tsc 0 + eslint 0 + build ✓; admin tsc 0 +
  `ng build --configuration production` ✓. Editor → CF Pages, worker+admin → Worker CI.

### ✅ Shipped next fire (2026-09-26 #17) — GALLERY view mode (first Airtable-style non-grid view)
The browse grid gained a **Grid ⇄ Gallery** toggle — the first non-grid view (success-standard #4). Gallery renders
the SAME page of rows as Airtable-style **cards**, honestly page-parity with the grid (no extra fetch, no record
duplication, same pagination + "N of total" count — per the page-vs-whole-query honesty note):
- **Editor-only (`data-panel-logic.ts` + `DataPanel.tsx`)** — pure `ViewMode`/`normalizeViewMode`/`galleryTitleField`
  (default = first non-id column) / `galleryBodyFields` (+8 Vitest). A view-mode segmented toggle + a "Title" field
  dropdown (gallery only) in the grid toolbar; a responsive card grid (1/2/3-col) over `visibleRows`, each card a
  configurable **title** + the remaining columns as label:value — **reusing `classifyCell`** so typed display
  (dates/url/email/JSON/number) + safe links match the grid exactly, and **respecting hidden columns** (`visibleCols`).
  The grid `<table>` is gated on `viewMode === 'grid'`; both share the toolbar + pagination + empty state. Resets to
  grid on table open. NO migration/worker/bridge change → deploys via CF Pages only.
- **Grid choice unchanged** — the hand-rolled `<table>` + a hand-rolled card grid; zero new deps/licenses.
- Verified: editor Vitest **222/222** + tsc 0 + eslint 0 + build ✓; worker Jest **12754/12754** + tsc 0 (unchanged —
  the matrix-doc commit still triggers Worker CI, which stays green). Editor → CF Pages.

### ✅ Shipped next fire (2026-09-26 #18) — persist the gallery as a saved-view TYPE (view-type + config)
The gallery (#17) went from an ephemeral display toggle to a real, persisted per-view **type** — saving a view now
captures whether it's a `grid` or `gallery` (+ the gallery card-title field), and applying it restores the whole
layout. Extends the metadata store (#15) end-to-end:
- **Migration (`0642_editor_grid_views_type.sql`, APPLIED to prod)** — `editor_grid_views` gains `type TEXT NOT NULL
  DEFAULT 'grid'` + nullable `config_json`. Additive + two-way-door (existing rows → `grid`, config NULL). Applied via
  `wrangler d1 execute --remote`; both columns verified present in `project-sites-db-production`.
- **Worker (`site_data_api/handlers.ts`)** — pure `normalizeGridViewType` (whitelist grid|gallery, default grid) +
  `parseGridViewConfig` (accepts the stored string OR the incoming object; keeps only a bounded `titleField` ≤64;
  never throws → `{}`). `serializeGridView` returns `type`+`config`; the POST re-whitelists `type` + re-stringifies the
  shape-hardened `config` (never the raw client blob); GET/single-row selects include the new columns. +4 Jest (+ the
  serialize test now asserts type/config).
- **Bridge** — `SavedGridView` gains `type`+`config`; `PS_VIEW_REQUEST` save carries `viewType`+`viewConfig`; the admin
  forwards them as `type`+`config` (worker re-validates).
- **Editor (`DataPanel.tsx`)** — save sends the current `viewMode` + `{titleField}`; **apply restores** `viewMode` +
  `galleryTitleCol` (legacy views with no type default to grid). The saved-views list shows a grid/gallery icon per
  view. NO change to the browse/export paths.
- Verified: worker Jest **12758/12758** + tsc 0; editor Vitest **222/222** + tsc 0 + eslint 0 + build ✓; admin tsc 0 +
  `ng build --configuration production` ✓; migration live in prod. Editor → CF Pages, worker+admin → Worker CI.

### ✅ Shipped next fire (2026-09-26 #19) — saved-views UPDATE + RENAME (completes the metadata-store CRUD)
Saved views had create/read/apply/delete but no way to EDIT one — tweak a view's filters and you had to
delete + re-create. Added the missing verb end-to-end (no migration — reuses the #18 columns):
- **Worker (`site_data_api/handlers.ts`)** — `PUT /api/sites/:siteId/grid-views/:viewId` updates a view IN PLACE
  (name + whole query + type/config), re-validating with the SAME helpers as create; the bound `table` is immutable
  (`body.table` ignored). Double-scoped `WHERE id=? AND site_id=? AND org_id=?` → `meta.changes===0` ⇒ **404** (a
  foreign/unknown id updates nothing, never a silent success); sets `updated_at`. +4 Jest (the FIRST grid-views
  route-level test suite: cross-org 404 / missing-name 400 / 0-changes 404 / success round-trips type+config+filters).
- **Bridge** — `PS_VIEW_REQUEST` action `'update'`; the admin routes it to the PUT with the same body shape as save.
- **Editor (`DataPanel.tsx`)** — each saved-view row gains **Update-to-current** (⟳: overwrite the view with the
  on-screen filters/sort/search + view mode, keeping its name) and **Rename** (✎ → inline input, Enter/blur commit,
  Esc cancel — preserves the stored query). `sendViewUpdate` shared by both; the response replaces the row in the list.
- Verified: worker Jest **12762/12762** (795 suites) + tsc 0; editor Vitest **222/222** + tsc 0 + eslint 0 + build ✓;
  admin tsc 0 + `ng build --configuration production` ✓. Editor → CF Pages, worker+admin → Worker CI. Saved-views CRUD
  is now complete (create/read/apply/**update**/**rename**/delete).

### ✅ Shipped next fire (2026-09-26 #20) — KANBAN board with HONEST whole-query lane counts
The third non-grid view: a Grid⇄Gallery⇄**Kanban** toggle that groups the browse rows into lanes by a status-like
column, with lane totals computed over the WHOLE filtered query (not the loaded page — the honesty gate).
- **Worker (`site_data_api/handlers.ts`)** — new `GET /data-overview/:table/group-counts?groupBy=&…filters` returns
  `[{value,count}]` per distinct group over the SAME filtered set (reuses `composeBrowseFilter`), bounded to
  **`MAX_KANBAN_GROUPS=50`** via `LIMIT MAX+1` → `truncated`. `groupBy` MUST be an allowlisted column (else 400 — the
  injection boundary; the identifier is quoted, never bound). Pure `buildGroupCountSql` derives the `GROUP BY` count
  from the table's `countSql` (keeps the soft-delete filter). `kanban` added to `GRID_VIEW_TYPES`; `parseGridViewConfig`
  gains a bounded `groupField`. +9 Jest (buildGroupCountSql shape, group-counts route via D1 mock, config/type).
- **Bridge** — `PS_DATA_REQUEST.groupBy` routes to `/group-counts` (drops pagination); response `data.groups` +
  `truncated`. `SavedGridView.config` gains `groupField`.
- **Editor (`DataPanel.tsx` + `data-panel-logic.ts`)** — `ViewMode` gains `kanban`; pure `kanbanGroupKey` +
  `groupPageRows` (bucket the page's rows; null → collision-proof sentinel). A kanban toggle + a "Group by" picker;
  lanes render from the whole-query `kanbanGroups` (**lane header = honest whole-table count**, cyan), cards are the
  current page's rows for that group (**labeled "N of <count> shown (current page)"** — the honesty gate satisfied),
  reusing `classifyCell` + the gallery card fields. Group-counts re-fetch on filter/search/group-field change. Persists
  as a saved-view type (`kanban` + `{groupField, titleField}`); apply restores mode + group + title. +2 Vitest.
- Verified: worker Jest **12769/12769** (795 suites) + tsc 0; editor Vitest **224/224** + tsc 0 + eslint 0 + build ✓;
  admin tsc 0 + `ng build --configuration production` ✓. NO migration (reuses #18 `type`/`config_json`). Editor → CF
  Pages, worker+admin → Worker CI. Three views now: grid · gallery · kanban.

### ✅ Shipped next fire (2026-09-26 #21) — CHART view (whole-query bar chart), completes the rich-views set
The fourth view: a Grid⇄Gallery⇄Kanban⇄**Chart** toggle rendering a horizontal **bar chart of whole-query counts by
a column** — honest by construction (the bars are the SAME group-counts the kanban lanes use, over the full filtered
set, never the loaded page). Reuses the #20 group-counts endpoint + pipeline almost entirely:
- **Worker** — one line: `chart` added to `GRID_VIEW_TYPES` (so `normalizeGridViewType` persists it). No new endpoint
  (reuses `/data-overview/:table/group-counts` from #20). +1 Jest assertion.
- **Editor (`data-panel-logic.ts`)** — `ViewMode` gains `chart`; pure **`buildChartBars`** (group counts → `{label,
  count, pct}` bars with max/total; null → "(empty)"; no divide-by-zero). +3 Vitest.
- **Editor (`DataPanel.tsx`)** — a chart toggle; the group-counts effect + "Group by" picker + saved-view `groupField`
  config now fire for `kanban OR chart` (shared group pipeline — zero new fetch/bridge code); a bar-chart render from
  `kanbanGroups` with an honest caption ("Count by ‹col› — whole table · N across M groups (top 50)"). Persists as a
  `chart` view type; apply restores mode + group. No admin/bridge change (reuses #20's `groupBy` routing).
- Verified: worker Jest **12769/12769** (795 suites) + tsc 0; editor Vitest **227/227** + tsc 0 + eslint 0 + build ✓;
  admin tsc 0 + `ng build --configuration production` ✓. NO migration. **Rich-views set COMPLETE: grid · gallery ·
  kanban · chart.** Editor → CF Pages, worker → Worker CI.
- *Note:* a false-alarm cost time this fire — `grep`/`sed` silently returned nothing on the large
  `data-panel-logic.ts` (a tooling quirk), which looked like the file had been clobbered; the **Read tool** confirmed
  it was fully intact (tsc=0 all along). Verify file contents with Read, never trust an empty grep as "absent".

### ✅ Shipped next fire (2026-09-26 #22) — record DRAWER for gallery + kanban cards (cards no longer display-only)
Gallery + kanban cards were display-only; clicking one now opens a right-side **record drawer** showing ALL fields
(one detail surface for the card views). Editor-only, self-contained (no worker/bridge change):
- **Editor (`data-panel-logic.ts`)** — pure `recordTitle(row, columns, titleField?)` → the drawer heading (resolved
  title-field value; `(untitled)` for empty; `(record)` for no columns). +3 Vitest (230 total).
- **Editor (`DataPanel.tsx`)** — a `drawerRow` state; gallery + kanban cards are now keyboard-accessible clickable
  (`role=button`, Enter/Space) that open the drawer; inner url/email links `stopPropagation` so a link click doesn't
  also open it. The drawer is a `fixed` right-side panel (backdrop / ✕ / **Escape** close): a title header, a
  **Copy-JSON** action (reuses `copyRow`), and every column as label→value via `classifyCell` — JSON values render as
  an expandable `JsonTree`, url/email as safe links. Closes on table switch.
- Verified: editor Vitest **230/230** + tsc 0 + eslint 0 + build ✓; worker Jest **12769/12769** + tsc 0 (unchanged —
  the matrix-doc commit still triggers Worker CI, stays green); admin `ng build --prod` ✓. Editor → CF Pages.
- **Scope note:** the drawer is READ-ONLY (+ Copy-JSON) and wired to the CARD views; the grid keeps its richer inline
  row-detail (copy/INSERT/UPDATE/Markdown/delete). Unifying all three onto ONE drawer (moving the grid's inline detail
  into it) is the follow-up — deferred deliberately (the grid detail is a large `<tr>`-coupled, index-based, delete-
  bearing block; a careful extraction, not a rushed one).

### ✅ Shipped next fire (2026-09-26 #23) — drift-aware "modified — update view?" badge (+ applyView kanban/chart fix)
Completes the #19 Update UX: applying a saved view then tweaking the query now surfaces a **"modified"** badge next to
the Views control with one-click **Update** (persist the change — the Update verb was buried in the menu, undiscoverable)
and **Reset** (re-apply the saved view). Editor-only:
- **Editor (`data-panel-logic.ts`)** — pure **`viewQueryFingerprint`**: a stable string of a view's whole query
  (search + ACTIVE conditions op-normalized + combinator-when-≥2 + sort + type + gallery/kanban config) that mirrors
  what `filtersToParams` sends — two queries that fetch+render identically hash equal, so drift is exact. +4 Vitest
  (234 total).
- **Editor (`DataPanel.tsx`)** — `appliedViewId` + `appliedFingerprint` set on apply; `viewModified` = applied
  fingerprint ≠ live fingerprint; a badge (name + amber "modified" + Update/Reset) near the Views button. Cleared on
  table switch + when the applied view is deleted. Update reuses #19's `updateViewToCurrent` + optimistically clears
  the dirty flag.
- **Bonus latent-bug fix:** `applyView` restored only `gallery`/`grid` (written when only gallery existed, #18) — so
  applying a saved **kanban/chart** view silently opened as grid. Now `normalizeViewMode(view.type)` restores all four.
- Verified: editor Vitest **234/234** + tsc 0 + eslint 0 + build ✓; worker Jest **12769/12769** + tsc 0 (unchanged);
  admin `ng build --prod` ✓. Editor → CF Pages. Saved views are now fully round-trip: apply · detect drift · Update/Reset.

### ✅ Shipped next fire (2026-09-26 #24) — record-drawer ACTION toolbar (unify step 1a: copy-as-SQL + delete parity)
The card record drawer (#22) went from read-only + Copy-JSON to full **record-action parity** with the grid's inline
detail — a site owner reviewing a gallery/kanban card can now act on the record:
- **Editor-only (`DataPanel.tsx`)** — a footer action bar in the drawer: **Copy INSERT** + **Copy UPDATE** (pk-gated) +
  **Copy Markdown** + **Delete** (super-admin + pk-gated; "No primary key — read-only" note otherwise), all reusing
  the SAME row-based handlers as the grid detail (`rowToInsert`/`rowToUpdateByPk`/`rowsToMarkdown`/`writeClipboard`/
  `flashStatus`/`deleteRow`). Delete → confirm → parameterized DELETE-by-PK → the table refreshes → the drawer closes.
  No duplicated logic (handlers shared); no new endpoint/bridge/migration.
- Verified: editor Vitest **234/234** + tsc 0 + eslint 0 + build ✓; worker Jest **12769/12769** + tsc 0 (unchanged);
  admin `ng build --prod` ✓. Editor → CF Pages.
- **Why split:** the grid's inline detail also has typed inline CELL EDITING (a ~70-line editor: kind-select + value +
  SQL preview + Save/Cancel, using `editCol`/`editKind`/`editValue`/`startEdit`/`submitEdit`). Porting that verbatim
  would DUPLICATE it; the right move is to extract a shared `<CellEditor>` — done next (1b), not rushed here.

### ✅ Shipped next fire (2026-09-26 #25) — editable drawer via shared `<CellEditor>` (unify step 1b)
The record drawer's fields are now EDITABLE, via a new **shared `<CellEditor>`** component used by BOTH the grid inline
detail AND the drawer — no duplicated editor JSX (the ~70-line editor now lives in one place):
- **New `app/components/workbench/CellEditor.tsx`** — presentational typed cell editor (kind-select text/number/boolean/
  NULL/JSON + value input + live parameterized-UPDATE SQL preview + error + Save/Cancel). State stays in DataPanel;
  the parent passes `onSave`/`previewSql` so it can target the grid detail row OR `drawerRow`.
- **`DataPanel.tsx`** — the grid inline detail's inline editor block was REPLACED by `<CellEditor>` (behavior-preserving);
  the drawer field list gained a per-field edit affordance (pencil, hover-revealed) that opens `<CellEditor>` targeting
  `drawerRow`. `editPreview()` → **`editPreviewFor(row)`** (row-parameterized so both surfaces preview the right record).
  Editable gate identical to the grid: canRunSql + resolvable PK + not-a-key + not-generated. Save reuses the SAME
  `submitEdit`/`buildUpdateByPk`/`runSql` path (parameterized UPDATE-by-PK); closing the drawer (✕/backdrop/Escape)
  cancels any open edit. No worker/bridge/migration change.
- Verified: editor Vitest **234/234** + tsc 0 + eslint 0 + build ✓; worker Jest **12769/12769** + tsc 0 (unchanged);
  admin `ng build --prod` ✓. Editor → CF Pages. The drawer now has full parity with the grid detail: view · edit ·
  copy-as-SQL · delete — one editor component, two surfaces.

### ✅ Shipped next fire (2026-09-26 #26) — grid rows open the DRAWER; inline `<tr>` detail RETIRED (unify step 2 — arc complete)
The record drawer is now the SINGLE detail surface for every view (grid · gallery · kanban). A grid row click/Enter/Space
opens `drawerRow`; the 213-line inline `<tr data-testid="data-row-detail">` block is gone and `detailIdx` is fully retired:
- **Drawer grown to full parity FIRST (so retiring the inline detail loses nothing)** — before this fire the drawer lacked
  three things the inline detail had; all added: **per-cell copy** (`data-drawer-copy-cell`, gated on `clipboardValue`),
  the **computed** badge for generated columns (`data-drawer-cell-generated`), and **Duplicate** (`data-drawer-duplicate`,
  super-admin → opens the prefilled Add-row form). Drawer surface = view · edit · per-cell copy · copy-JSON · INSERT ·
  UPDATE · Markdown · Duplicate · Delete.
- **`DataPanel.tsx`** — the grid `<tr>` is now a drawer-opener: `onClick`/Enter+Space → `setDrawerRow(r)`; `aria-expanded`
  → **`aria-haspopup="dialog"`**, label "Open record N of M". Escape is owned by the drawer's own handler (now via
  `isDismissKey` → both `Escape` **and** `Esc` close it). The inline detail block + its copy/INSERT/UPDATE/Markdown/
  duplicate/delete/per-cell/edit JSX (all now in the drawer) deleted; `detailIdx` state removed; the 17 `setDetailIdx(null)`
  reset sites → `setDrawerRow(null)` (deduped in `openTable`, which already closed the drawer); `duplicateRow`'s collapse →
  `setDrawerRow(null)`.
- **Obsolete code removed** — `detailEntries` (superseded by the drawer's own richer field render) deleted from
  `data-panel-logic.ts` + its 2 unit tests; the `React` default import dropped (no more `React.Fragment` — automatic JSX
  runtime). No worker/bridge/migration change. **Net −232 lines** (118+/350−) across 3 editor files.
- Verified: editor Vitest **848/848** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under `apps/project-sites`
  → worker tsc/jest unchanged from the last green fire `574f3487e`). Editor → CF Pages on push. *Honest residual:* the
  interactive open→drawer path runs in a WebContainer behind an authed admin session (verify-by-build per the established
  DataPanel pattern); the click-through wasn't exercised in a live browser.

### ✅ Shipped next fire (2026-09-26 #27) — CALENDAR view (Airtable rich-view set COMPLETE: grid · gallery · kanban · chart · calendar)
The current page's records place on a Sunday-first month grid by a date column; each event opens the SAME record drawer.
The last enumerated Airtable view now ships. Wires the INERT tested `view-models.ts` foundation (`bucketRowsByDate`).
- **New pure logic (TDD-first, all tested):** `data-cell-format.ts` `isoDayKey(v)` — STRICT UTC `YYYY-MM-DD` for a bare
  ISO date or a zone-marked datetime, else null (regex-gated, so a numeric id like `20240101` — which `new Date(n)` parses
  as a 1970 ms timestamp — is NEVER mistaken for a date, the classic auto-detect trap). `data-panel-logic.ts`
  `calendarDateField` (owner pick, else auto-detect first `isoDayKey`-able column), `monthMatrix(y,m)` (42-cell UTC grid),
  `addCalendarMonth` (prev/next w/ rollover), `monthFromDayKey` (seed month from data). `ViewMode`/`normalizeViewMode` +
  `viewQueryFingerprint` extended with `calendar`/`dateField`.
- **Wired the foundation:** day-bucketing uses `view-models.ts` `bucketRowsByDate(rows, col, 'day')` (UTC, tested) — the
  first INERT foundation brought into the live UI per the directive.
- **`DataPanel.tsx`** — Calendar toggle + a date-field picker + month ‹/›/Reset nav; a 7×6 month grid whose day cells list
  up to 3 events (click → `setDrawerRow(r)`), "+N more" beyond. HONEST caption: "N of M rows on this page placed by
  <field> (UTC day) — the current page only, not a whole-table month query; undated rows aren't shown" (page-parity, same
  discipline as kanban cards). No group-counts fetch (calendar is page-local).
- **Saved views + worker** — `type:'calendar'` + `config.dateField` persist through the whole path: worker
  `GRID_VIEW_TYPES`/`parseGridViewConfig`/`serializeGridView` + editor `SavedGridView`/`viewConfig`/save/apply/fingerprint.
  Also fixed two LATENT type gaps found en route: `SavedGridView.type` was missing `'chart'`, and `viewConfig`/the save
  payload type was missing `groupField` (both worked at runtime; the TS types under-declared them). **No migration** —
  `editor_grid_views.type` is `TEXT` with no CHECK; the worker whitelist governs.
- Verified: editor Vitest **870/870** + tsc 0 + eslint 0 + build 0; worker Jest **12770/12770** + tsc 0. Editor → CF Pages
  on push. *Honest residual:* the interactive calendar (open→place→drawer) runs in a WebContainer behind an authed admin
  session — verify-by-build per the established DataPanel pattern; not click-through-tested in a live browser. Day cells cap
  at 3 visible events (+N more is a count, not yet an expander) — page-parity keeps most days ≤3 at the default page size.

### ✅ Shipped next fire (2026-09-26 #28) — record-drawer prev/next navigation (‹ › + ←/→)
Step through the CURRENT PAGE's records inside the drawer without closing it — the Airtable record-modal
gesture. Works from every view (grid · gallery · kanban · calendar) since the drawer is the universal surface.
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `recordNavigation(rows, current)` →
  `{ index, total, prev, next }`, locating the open row by **reference identity** (`indexOf` — `drawerRow`
  is the exact object a surface passed) and returning the neighbor row objects (null at each end). 5 cases
  incl. single-row page, current-null/off-page (index -1), and reference-vs-value identity.
- **`DataPanel.tsx`** — a `drawerNav` memo; a nav strip under the drawer header with **‹ Prev / Record N of M
  (this page) / Next ›** (buttons disabled at the ends); **←/→ keys** mirror them (extended the drawer keydown
  effect, deps `[drawerRow, editCol, visibleRows]` — no stale closure). Arrow-nav is **suppressed while a cell
  is being edited** (`editCol` set) so arrows move the input caret; stepping cancels any open editor.
- **HONEST page-boundary:** prev/next never cross to the next page (label says "(this page)"; crossing would
  need a fetch) — same page-parity discipline as kanban cards + the calendar. Hidden for a single-row page.
- Verified: editor Vitest **875/875** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites` — worker tsc/jest unchanged from `ce181ec0f`). Editor → CF Pages on push. *Honest
  residual:* verify-by-build (WebContainer + authed admin session) per the established DataPanel pattern.

### ✅ Shipped next fire (2026-09-26 #29) — chart SUM/AVG/MIN/MAX aggregates (beyond COUNT)
A chart bar can now be **"SUM(amount) by status"**, not just row counts — a whole-query numeric aggregate over
an allowlisted measure column, per group. Extends the existing `/group-counts` endpoint (backward-compatible).
- **Worker (`handlers.ts`):** `GROUP_AGGS = [sum,avg,min,max]` + `normalizeGroupAgg` + `buildGroupAggregateSql`
  (adds `<AGG>("measure") AS agg`, orders by the aggregate desc). The `/group-counts` route takes optional
  `measure`+`agg`; **both** must validate (measure ∈ `spec.columns` = the injection boundary, agg ∈ whitelist
  → uppercase SQL keyword, never raw) or it **silently falls back to COUNT**. Each group gains a numeric
  `aggregate` (null when all-NULL); response echoes `agg`/`measure`. Still bounded to `MAX_KANBAN_GROUPS`,
  whole-query (search+filters apply), fail-soft.
- **Editor:** `buildChartBars(groups, metric)` gains a `metric:'count'|'aggregate'` mode + per-bar `value`
  (clamps negatives so a MIN-of-negatives bar never inverts); new `numericColumns(cols, rows, exclude)` offers
  only numeric-looking page columns as measures (SQLite would silently coerce a text column to 0). Chart gets a
  **Measure** picker ("Count of records" + numeric cols) + an **Agg** picker (Sum/Avg/Min/Max); `loadKanbanGroups`
  forwards measure+agg only in chart mode. Kanban stays COUNT-only.
- **HONEST labeling:** header shows `SUM(amount) by status` (or `Count`); a grand total is shown ONLY for
  COUNT+SUM (summing per-group AVG/MIN/MAX is nonsense → just the group count); each bar shows the aggregate
  value + `n=<rows>`.
- **Bridge/admin:** `DataRequestMessage` + `PsMessage` gain `measure`/`agg`; `DataResponseMessage.data.groups`
  gains `aggregate?` + `agg`/`measure` echo; `bolt-embed.service.ts` forwards the pair to `/group-counts`.
- Verified: editor Vitest **881/881** + tsc 0 + eslint 0 + build 0; admin tsc 0; worker Jest **12774/12774** +
  tsc 0. *Honest residual:* verify-by-build (WebContainer + authed session) per the established DataPanel pattern;
  the aggregate over a genuinely numeric D1 column wasn't exercised in a live browser this fire.

### ✅ Shipped next fire (2026-09-26 #30) — calendar day-cell "+N more" → a day popover
The calendar caps 3 events/cell; "+N more" was a dead count. It's now a button opening a **day popover**
that lists ALL of that day's page records — each opens the shared record drawer. Every record on a busy day
is now reachable from the calendar (was: only the first 3).
- **`DataPanel.tsx` (editor-only):** `openDayKey` state (a `YYYY-MM-DD`); the "+N more" span → a
  `data-calendar-more` button (`setOpenDayKey(cell.dayKey)`); a centered modal popover
  (`data-calendar-day-popover`, backdrop / ✕ / Escape) listing every row from `calendarDayMap.get(openDayKey)`
  as a title+body card (reuses `galleryTitleField`/`galleryBodyFields`/`classifyCell`) → `setDrawerRow` + close.
  Escape effect gated to not fight the drawer; `openDayKey` reset in `openTable`; the popover **auto-closes**
  if a filter change empties the day (renders null when the day has 0 rows).
- **HONEST:** header says "· N on this page" (page-parity — the same rows the calendar placed, not a
  whole-table day query). No worker/bridge change; pure reuse of the existing page data.
- Verified: editor Vitest **881/881** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites` — unchanged from `20d2aabd2`). *Honest residual:* verify-by-build (WebContainer + authed
  session) per the established DataPanel pattern.

### ✅ Shipped next fire (2026-09-26 #31) — column REORDER (persisted per table; grid mandate "reorder")
Columns can now be arranged left/right and the order sticks — applied to the grid, gallery, kanban, calendar,
AND the record drawer (one consistent arrangement). Client-only display pref, mirroring the existing hide-column
pattern; **no worker/bridge/migration** (exports keep canonical `columns` order, per the column-menu note).
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `orderColumns(all, order)` (schema-drift robust —
  new columns append, stale order entries drop, always a permutation of `all`) + `moveColumn(all, order, col, dir)`
  (one step left/right, clamped, normalizes a partial saved order first). 6 cases.
- **`DataPanel.tsx` (editor-only):** `colOrder` state + `readColOrder`/`DATA_COLORDER_KEY` localStorage (per table,
  mirrors `readHiddenCols`); `orderedColumns = orderColumns(columns, colOrder)` → `visibleCols =
  visibleColumns(orderedColumns, hiddenCols)` so the order flows to every view; the drawer renders
  `orderedColumns`; the Columns menu lists `orderedColumns` with per-row ▲/▼ (`data-col-move-up/down`, end-clamped)
  → `moveCol` persists. `openTable` restores the saved order.
- Verified: editor Vitest **887/887** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites`). *Honest residual:* verify-by-build (WebContainer + authed session) per the DataPanel pattern.

### ✅ Shipped next fire (2026-09-26 #32) — grid row DENSITY toggle (compact · cozy · comfortable)
The browse grid now has a 3-way density control — **compact** fits ~2× the rows for scanning wide/tall tables,
**comfortable** loosens for touch, **cozy** is the historical default. A global personal pref (not per-table).
Chosen over column-resize this fire because density is fully **verify-by-build + unit-testable** (pure class
mapping), whereas resize needs a mouse-drag interaction I can't browser-test in the loop.
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `GridDensity`/`GRID_DENSITIES`/`normalizeDensity`
  (unknown → `cozy`) + `densityCellClass` (cozy = the historical `px-3 py-1.5`; compact `px-2 py-0.5`; comfortable
  `px-3 py-3`) + `densitySelectCellClass` (checkbox cell tracks row height). 4 cases incl. distinctness.
- **`DataPanel.tsx` (editor-only):** `density` state (lazy-init from `readDensity()`; global `ps-data-density`
  localStorage) + `changeDensity` (persists); a toolbar segmented toggle (`data-density-{compact,cozy,comfortable}`,
  grid-view only). The header sort button + data `<td>` + both checkbox cells now compose `densityCellClass`/
  `densitySelectCellClass`. Scoped to the browse grid (the SQL-results grid is untouched).
- Verified: editor Vitest **891/891** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites`). *Honest residual:* verify-by-build (WebContainer + authed session) per the DataPanel pattern.

### ✅ Shipped next fire (2026-09-26 #33) — column RESIZE (drag handles + persisted widths)
Drag any column's right edge to set an exact width; double-click the handle resets it to auto. Per-table,
persisted, mirroring the reorder/density prefs. Completes the grid-mandate "resize/reorder/hide" trio.
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `MIN_COL_WIDTH`/`MAX_COL_WIDTH` (60–600) +
  `clampColWidth(px)` (clamp+round; non-finite → min) + `parseColWidths(raw)` (defensive `{col:px}` parse — keeps
  positive finite widths clamped, drops junk, non-object → {}). 2 describes.
- **`DataPanel.tsx` (editor-only):** `colWidths` state + `readColWidths`/`DATA_COLWIDTH_KEY` localStorage (per table,
  mirrors reorder); `startResize` (mousedown on a right-edge handle → window mousemove/mouseup; `stopPropagation` so
  it never fires the sort button; drag-local move/up handlers → no stale closure), `resetColWidth` (double-click →
  delete the width), `persistColWidths`, `colStyle(c)` (min=max=width forces an exact width in auto-layout). Applied
  to the browse-grid `<th>` (+`relative`) + data `<td>`; SQL-results grid untouched. `openTable` restores widths.
- Verified: editor Vitest **893/893** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites`). **⚠ Honest residual (must-verify):** the width MATH + clamp + persistence parse are
  unit-tested, but the actual mouse-**drag** interaction (mousedown→move→up→persist, handle-vs-sort click
  separation, width application to `<th>`+`<td>`) is NOT browser-testable in this loop — it ships verify-by-build.
  A REAL-browser drag check on `editor.projectsites.dev` (drag a column, confirm width sticks on reload, confirm the
  handle doesn't trigger a sort) is a REQUIRED follow-up before calling resize fully done.

### ✅ Shipped next fire (2026-09-26 #34) — per-column summary footer (Airtable "summaries")
The browse grid gains a sticky footer where each column can show a summary — **Count / Filled / Empty / Sum / Avg
/ Min / Max** — over the current page. Configurable per column, persisted per table. Chosen over the two matrix
options (resize real-browser verify = not loop-actionable; pinned column = has an unverifiable sticky-CSS visual)
because summaries are **fully verify-by-build + unit-testable** (pure aggregation + deterministic render, no
interaction). Directly in the AIRTABLE VIEWS mandate ("summaries").
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `SummaryKind`/`SUMMARY_KINDS`/`normalizeSummaryKind`
  + `summaryLabel` + `summaryValue(kind, agg)` (count/filled=count−null/empty=null/sum/avg/min/max; **numeric stats
  return null → footer shows "–"** on a non-numeric column, never a fake 0) + `parseColSummaries` (defensive persist
  parse). Reuses the tested `computeAggregates` from `data-aggregates.ts`. 5 cases.
- **`DataPanel.tsx` (editor-only):** `colSummaries` state + `readColSummaries`/`DATA_COLSUMMARY_KEY` localStorage
  (per table) + `setSummary` (persist/clear); a `colAggregates` memo computing `computeAggregates` **only for
  summarized columns** (a wide table pays nothing until a summary is set); a `<tfoot className="sticky bottom-0">`
  with a per-column value + a compact picker (`data-col-summary`, faint until hover when unset). Grid-view only;
  SQL-results grid untouched.
- **HONEST:** page-parity — the summary is over the loaded page (labelled "· this page"), like the selection
  footer + kanban cards; a whole-table summary would need a server aggregate (see NEXT).
- Verified: editor Vitest **898/898** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites`). *Honest residual:* verify-by-build (WebContainer + authed session) per the DataPanel pattern.

**STILL-OPEN manual QA (not loop-actionable):** the #33 column-resize DRAG + this footer's picker need a
real-browser pass on `editor.projectsites.dev` (authed admin session) — logic is unit-tested, the interactions ship
verify-by-build (per `interaction≠build`).

### ✅ Shipped next fire (2026-09-26 #35) — WHOLE-QUERY column summaries (footer "· all" vs "· page")
The footer summaries now reflect the **entire filtered table**, not just the loaded page — a footer Sum is the
real total. Additive over #34: the whole-query value is fetched + shown when fresh ("· all"); otherwise it
gracefully falls back to the page aggregate ("· page") — never a mock (the page footer already works).
- **Worker (`handlers.ts`, fully jest-tested):** `buildColumnAggregatesSql(spec, columns, extraClause)` — ONE
  ungrouped SELECT computing `COUNT(*)` + per-column `COUNT/SUM/AVG/MIN/MAX` with positional aliases (`c0/s0/…`);
  new route `GET /data-overview/:table/column-aggregates?columns=a,b,c` (+ search/filter params) → `{ aggregates:
  { col: {count, filled, sum, avg, min, max} } }`. Columns re-validated against the allowlist (injection boundary),
  de-duped, bounded to the table's column count; empty/all-invalid → `{}` (no query); org-gated + ownsSiteData +
  fail-soft. 3 SQL-builder tests + full worker Jest **12777/12777**.
- **Bridge/admin:** `DataRequestMessage.columnsAgg` (comma-list) + response `data.aggregates`; `bolt-embed.service.ts`
  routes it to `/column-aggregates` (a 4th mode beside export/group-counts/browse) + `PsMessage.columnsAgg`.
- **Editor (`DataPanel.tsx`):** `columnAggs` + `columnAggKey` (the query fingerprint they're valid for) +
  `columnAggCid`; a `columnAggQueryKey` memo (search + filters + summarized-col set); `loadColumnAggregates`
  (one batched request, key set optimistically to prevent refire) + an effect refetching on fingerprint drift; the
  footer maps the server shape → `CellAggregates` and shows `summaryValue` with a **"·all"** (whole-table) vs
  **"·page"** suffix + honest tooltip. Falls back to the page aggregate whenever the server value isn't fresh.
- Verified: editor Vitest **898/898** + tsc 0 + eslint 0 + build 0; admin tsc 0; worker Jest **12777/12777** + tsc 0.
  *Honest residual:* the worker aggregate SQL/endpoint is fully tested (server-computed values are trustworthy);
  the editor fetch/cache wiring ships verify-by-build (WebContainer + authed session) per the DataPanel pattern.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize DRAG + the footer picker/whole-query fetch need a
real-browser pass (authed admin session) — logic/SQL tested; the interactions + live fetch ship verify-by-build.

### ✅ Shipped next fire (2026-09-26 #36) — pinned/frozen identifying columns
Pin any column(s) to the left so they stay visible while scrolling wide tables horizontally — the DBeaver/
Airtable frozen-column. Per-table, persisted; a pin toggle in the column menu (lit when pinned, hover-revealed
when not). Completes the grid-mandate "Pinned identifying columns".
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `applyPins(cols, pinned)` (pinned → a stable
  leading prefix — the frozen region must be contiguous at the left) + `pinnedLeftOffsets(cols, pinned, widths,
  leadOffset, defaultWidth)` (cumulative sticky-left px over the pinned prefix; a pinned column renders at a
  definite width so offsets are exact; stops at the first unpinned). 6 cases.
- **`DataPanel.tsx` (editor-only):** `colPinned` state + `readColPinned`/`DATA_COLPINNED_KEY` localStorage (per
  table) + `togglePin`; `visibleCols` now `applyPins(visibleColumns(...))`; a `pinOffsets` memo + `stickyPinStyle`
  (z-tiers: pinned header 30 > checkbox 31/21 > pinned body 20) applied to the `<th>`/`<td>`/`<tfoot>` cells + the
  select-checkbox column (freezes at left:0 when any pin exists); `colStyle` gives pinned columns a definite width
  (resized, else `DEFAULT_PIN_WIDTH` 180) so the offsets are exact; pinned cells get an opaque bg so scrolled
  content doesn't bleed through. Column-menu pin button (`data-col-pin`).
- Verified: editor Vitest **904/904** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites`). **⚠ Honest residual (visual QA):** the offset MATH + pin/order/width logic are unit-tested,
  but the sticky-left CSS + z-index layering + opaque-bg (does the frozen region actually stay put + not bleed on
  horizontal scroll?) ship **verify-by-build** — a real-browser pass is required (per `interaction≠build`).

### ✅ Shipped next fire (2026-09-26 #37) — saved views capture the FULL column layout (Airtable "views save fields/order/…")
A saved view now restores its whole COLUMN ARRANGEMENT — field visibility, order, widths, pins, per-column
summaries, and density — not just the query. This makes all the recent display features (#31/#32/#33/#34/#36)
shareable/saveable per view (previously they were per-table localStorage only, lost on view-apply). Pure
serialization, no new interaction, **no migration** (rides the existing `config_json` blob).
- **Worker (`handlers.ts`, jest-tested):** `parseGridViewLayout(raw)` shape-hardens a `{hidden,order,widths,
  pinned,summaries,density}` sub-object — bounded string arrays (≤`MAX_LAYOUT_ENTRIES` 200, each ≤64 chars), a
  positive-number widths map, a string summaries map, a density string; merged into `parseGridViewConfig().layout`.
  Size/type-hardening only (the editor re-validates semantics on apply); never throws. 3 tests.
- **Bridge/editor:** `SavedGridViewLayout` type; `SavedGridView.config.layout` + `viewConfig.layout` (+ the admin
  `PsMessage.viewConfig` tightened — it already forwarded `config` opaquely, so layout flowed at runtime). A
  `currentLayout` memo (only non-empty parts; density always carried) added to both save paths; **applyView**
  restores each via the SAME parsers the localStorage reads use (`parseColWidths`/`parseColSummaries`/
  `normalizeDensity`; hidden/order/pinned as string[]) — a legacy view without a layout leaves the arrangement
  untouched (never blanks it).
- Verified: editor Vitest **904/904** + tsc 0 + eslint 0 + build 0; admin tsc 0; worker Jest **12780/12780** + tsc 0.
  *Honest residual:* worker layout-parse fully tested; the save/apply round-trip ships verify-by-build (WebContainer
  + authed session). Deploy-skew is graceful (old worker drops the unknown `layout` key → views persist query-only
  until the worker lands; apply's `if (layout)` guard → no breakage), per `editor-worker-deploy-skew`.
### ✅ Shipped next fire (2026-09-26 #38) — "modified" badge now tracks column-LAYOUT drift (honesty fix)
Closes #37's known gap + fixes a subtle **lying badge**: after applying a saved view then rearranging columns
(hide/reorder/resize/pin/summary/density), the view read "saved" when it wasn't. Now any layout change flags it
"modified" (prompting re-save). Small, complete, **fully verify-by-build + unit-tested** (pure fingerprint logic;
fingerprints are ephemeral — recomputed each session, never persisted — so extending the shape is safe).
- **New pure logic (TDD-first, tested):** `data-panel-logic.ts` `layoutSignature(l)` — a CANONICAL layout key:
  arrays (hidden/order/pinned) kept in order (order is meaningful), maps (widths/summaries) flattened to
  key-SORTED entry pairs (map key order is NOT meaningful), empties normalized (`[]`/`cozy`). `viewQueryFingerprint`
  gains an optional `layout` → included in the hash. 3 cases incl. map-order-insensitive / array-order-sensitive /
  sparse-vs-empty equivalence.
- **`DataPanel.tsx` (editor-only):** `currentLayout` moved above `liveFingerprint` (which now passes it); applyView's
  appliedFingerprint baselines against `view.config?.layout ?? currentLayout` — a view WITH a layout baselines on
  it, a LEGACY view (no layout) baselines on the untouched current arrangement, so **neither wrongly shows
  "modified"** on apply. `currentLayout` added to applyView deps (no stale baseline).
- Verified: editor Vitest **907/907** + tsc 0 + eslint 0 + build 0; worker **untouched** (0 files under
  `apps/project-sites`). Fully verifiable (pure logic + tested); no new interaction/visual.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize drag · #34 footer picker · #35 whole-query fetch · #36
sticky-pin render · #37 view save/apply round-trip — all need one real-browser pass (authed admin session). Logic/
SQL fully tested; the interactions/visuals/round-trips ship verify-by-build (per `interaction≠build`). **A dedicated
real-browser QA fire is the highest-value next step** to convert this debt to verified.

### ✅ Shipped next fire (2026-09-26 #39) — `starts with` / `ends with` filter operators
The column-filter builder gains two anchored text ops beside `contains` — `starts with` (prefix) + `ends with`
(suffix). Small, contained, **fully verify-by-build + unit-tested** (all logic; the result is server-computed via
the worker's LIKE) — no bridge round-trip, no new endpoint, no new interaction (2 options in the existing op
`<select>`, rendered from `FILTER_OP_OPTIONS`). Chosen over the wide multi-sort to ship a complete slice cleanly.
- **Worker (`handlers.ts`, jest-tested):** `FILTER_OPS` + `buildFilterLeaf` gain `startswith`/`endswith` — same
  wildcard-STRIP discipline as `contains` (the user's `%`/`_` are stripped → a LITERAL prefix/suffix, never a
  metacharacter; value BOUND as `?`, never concatenated), anchored `needle%` / `%needle`; all-wildcards → inactive.
  4 assertions incl. an injection-shaped value bound literally.
- **Editor (`data-panel-logic.ts`):** `FILTER_OPS` + `FILTER_OP_OPTIONS` (labels "starts with"/"ends with"); they're
  value-ops (not value-free). Multi-condition filters flow through the `filters` JSON (worker re-validates each
  leaf), so no bridge change was needed; `PS_FILTER_OPS` (admin, legacy single-filter path) tightened for consistency.
- Verified: editor Vitest **907/907** + tsc 0 + eslint 0 + build 0; admin tsc 0; worker Jest **12781/12781** + tsc 0.
  Fully verifiable — logic tested + server-computed result; the only UI delta is 2 select options.

### ✅ Shipped next fire (2026-09-26 #40) — MULTI-COLUMN sort (header-click cycling + priority badges + persistence)
`browseSort` goes from a single `{col,dir}` to an ordered `GridSort[]` ([0] = primary). Header clicks now CYCLE
none→asc→desc→remove and APPEND to the sort order, so a second header click adds a SECONDARY key rather than
replacing the first — Airtable/DBeaver-class multi-sort. Each header shows its `aria-sort` caret, and when >1 key is
active a priority badge (1,2,3…) marks the order. A "Clear sort" toolbar chip (with the key-count) resets to the
table's natural order. Persisted in the saved-view `config.sorts` string — **NO schema change** (config_json blob).
- **Worker (`handlers.ts`, jest-tested):** `buildOrderByClause(columns, sortParam)` parses `col:dir,col2:dir2,…`,
  each column **allowlist-validated + quoted** (NEVER bound — identifiers can't be SQL parameters), dir coerced
  ASC/DESC, de-duped (first wins), bounded to `MAX_SORT_KEYS=4`; returns `ORDER BY "a" ASC, "b" DESC` or `''`. Wired
  into BOTH browse + export (takes precedence over the legacy single `orderBy`/`dir`). `parseGridViewConfig` preserves
  a `sorts` string (trim · drop non-string · bound 512). +5 assertions (multi-col · dedup/coerce · MAX cap · empty · config).
- **Editor (`data-panel-logic.ts`, pure+tested):** `cycleSortMulti` (immutable none→asc→desc→remove), `sortsToParam`
  (`GridSort[]` → `col:dir,…`), `parseSortSpec` (inverse; coerce dir, drop blanks/dupes); `viewQueryFingerprint`
  extended with `sorts` so the "modified — update view?" badge fires on sort-ORDER drift too. +6 Vitest.
- **DataPanel + bridge:** `browseSort: GridSort[]` threaded through `requestRows`/liveFingerprint/save/update/apply/
  export; `applyView` prefers `config.sorts`, falls back to `[primary]` for legacy single-sort views. Bridge
  (`DataRequestMessage.sort`) + admin (`PsMessage.sort`, opaque-forward → worker re-validates) mirrored.
- **Simplification vs. the plan:** chose header-click CYCLING as the multi-sort UI (verifiable, in-grid, one
  interaction) over a separate Sort panel — fewer new surfaces. A dedicated add/remove panel can layer on later.
- Verified: editor Vitest **913/913** + tsc 0 + eslint 0 + build 0; admin tsc 0; worker Jest **12786/12786** + tsc 0.
  Logic + server-computed order fully verifiable; the header-click cycle + priority badge + Clear-sort chip are
  verify-by-build (deep lazy chunk, not headless-reachable) → added to the standing real-browser QA list.

### ✅ Shipped next fire (2026-09-26 #41) — SQLite-AFFINITY-aware typed cell editors + native DATE/DATETIME pickers
The cell editor stops guessing the type from the VALUE and instead chooses it from the column's DECLARED SQLite type:
a `DATE` column opens a native `<input type="date">`, a `DATETIME`/`TIMESTAMP` column a `datetime-local` picker
(`step="1"`, seconds preserved), a numeric column a number input — **even when the cell is NULL** (so entering the
first value needs no manual type switch; the NULL option stays one click away). Wired into BOTH the inline/drawer
edit path (`startEdit`) AND the Add-row + Duplicate prefill (`duplicateRow`). Editor-only — values still bind as `?`
through the existing gated `coerceCellInput → buildUpdateByPk → runSql` path, so **no worker/bridge/admin change**.
- **Editor logic (`data-panel-logic.ts`, pure+tested, +13 Vitest):** `editorKindForColumn(declaredType, value)` —
  declared-type-first with **honest LOSSLESS fallbacks**: a zone-marked datetime, a non-numeric value in a numeric
  column, or a DATE column holding a full datetime all fall back to a plain TEXT editor rather than silently
  truncating. `CellInputKind` gains `'date'`/`'datetime'`; `coerceCellInput` validates their shape + binds as TEXT
  (SQLite has no date type — stored zone-less exactly as entered). `toDateInputValue`/`toDatetimeLocalValue` reformat
  a stored value into the native-input format (or `''` → text fallback). `declaredKindFromType` applies SQLite
  affinity (INT/REAL/NUMERIC→number) + the conventional DATE/DATETIME/BOOL/JSON declarations.
- **DRY (`CELL_INPUT_KIND_OPTIONS`):** ONE shared `{value,label}[]` now renders BOTH the `<CellEditor>` type select
  AND the Add-row select (Add-row prepends its own `default`) — the two hardcoded 5-option lists that would have
  drifted as kinds were added are gone (the exact drift class the loop keeps hitting).
- **Honesty:** a date/checkbox widget is a UI INTERPRETATION over TEXT/NUMERIC storage, not a schema guarantee — the
  grid type badge (`columnTypeBadge`) still shows the real declared type; the picker is only an input affordance.
- **Architectural call:** did NOT wire the inert `field-types.ts` verbatim — that's a richer Airtable *field-kind*
  registry (singleSelect/multiSelect/rating/attachment) for a FUTURE per-column "field configuration" feature. The
  raw D1 cell editor needed a SQLite-affinity→`CellInputKind` mapper that integrates the EXISTING coerce/CellEditor
  machinery; `field-types.ts` stays inert until the field-config feature lands.
- Verified: editor Vitest **926/926** + tsc 0 + eslint 0 + build 0. No worker/admin files touched (worker Jest
  **12786/12786** unchanged from #40). The affinity/coerce/reformat logic is fully unit-tested; the native date/
  datetime picker RENDERING is verify-by-build (DataPanel is a deep lazy chunk, not headless-reachable).

### ✅ Shipped next fire (2026-09-26 #42) — finished typed-editor control set: BOOLEAN checkbox + JSON textarea
Closes the typed-editor set from #41. `boolean` cells now render a real **checkbox** with an explicit `true`/`false`
label (cyan when true) instead of a "true / false" text box; `json` cells render a multi-line **`<textarea>`** (monospace,
resizable) with a live **"not valid JSON yet"** hint that appears only while the non-empty text fails to parse. Both
the grid/drawer `<CellEditor>` AND the Add-row form get the upgrade. Editor-only — the widget edits the same STRING the
parent already coerces + binds as `?` (`coerceCellInput`), so **no worker/bridge/admin change**.
- **New shared widget (`TypedValueField.tsx`):** ONE presentational component now renders the per-kind value control
  for BOTH consumers (text/number/date/datetime → input; boolean → checkbox; json → textarea+hint). The two hardcoded
  value `<input>`s that would drift as kinds gain widgets are gone — the render-side sibling of #41's
  `CELL_INPUT_KIND_OPTIONS` (the select-side single source). Consumers pass `kind/value/onValueChange/disabled/testId`.
- **Editor logic (`data-panel-logic.ts`, +3 Vitest):** `isValidJsonText(s)` — accepts any valid JSON (obj/array/
  string/number/bool/null), rejects malformed + blank; a property test asserts it AGREES with `coerceCellInput('json')`
  (validity hint ⇔ save won't throw), so the live hint and on-save validation can never disagree.
- **Honesty:** a checkbox is a UI affordance over a 0/1 INTEGER, not a schema-enforced boolean — the label shows the
  literal stored value (`true`/`false`) and the type badge still shows the real declared type.
- Verified: editor Vitest **929/929** + tsc 0 + eslint 0 + build 0. No worker/admin files touched (worker Jest
  **12786/12786** unchanged). Logic (isValidJsonText) fully unit-tested; the checkbox + textarea RENDERING is
  verify-by-build (deep lazy chunk, not headless-reachable).

### ✅ Shipped next fire (2026-09-26 #43) — `singleSelect`-style value datalist (DISTINCT values; first full-stack slice in a while)
Editing a low-cardinality TEXT cell now offers a native **`<datalist>`** of the column's existing distinct values
(Airtable single-select feel) — the input stays open free-text (pick OR type), values still bound as `?`. Spans all
four layers (worker + bridge + admin + editor) mirroring the `/column-aggregates` precedent.
- **Worker (`handlers.ts`, jest-tested +3):** `buildColumnDistinctSql(spec, col)` — col **allowlist-validated + quoted**
  (never bound — the injection boundary), non-null/non-empty, ordered, `LIMIT ?`. New route
  `GET /data-overview/:table/column-distinct?column=` (auth + `ownsSiteData` + `overviewTable` 400-on-unknown + column
  re-validation; fail-soft → empty). Fetches `MAX_DISTINCT_VALUES(50)+1` → `truncated` flags a high-cardinality column.
  Does NOT apply the grid filter — the suggestion set is the column's whole value domain, not the filtered slice.
- **Bridge (`embedded-mode.ts`) + admin (`bolt-embed.service.ts`):** `columnDistinct` request field + `distinctValues`/
  `distinctColumn` response fields mirrored; admin adds an `isColumnDistinct` routing mode → `/column-distinct?column=`.
- **Editor (`DataPanel.tsx` + `data-panel-logic.ts` +3 Vitest):** `startEdit` fetches distinct values for a TEXT column
  (on-demand, own cid); `distinctSuggestions(values, truncated)` (pure, tested) applies the **honest select-like
  heuristic** — a high-cardinality (`truncated`) column surfaces NO suggestions (it's free-text, not a select).
  Threaded editor → `<CellEditor>` → `<TypedValueField>` (native `<datalist>` on the text widget only; date/datetime
  keep their pickers).
- **Deploy-skew (editor ~2min before worker ~14min):** an older worker 404s `/column-distinct` → admin replies error →
  editor leaves suggestions empty → **plain text input** (graceful; no broken window). Verified the fallback path.
- Verified: editor Vitest **932/932** + tsc 0 + eslint 0 + build 0; admin tsc 0 (+ prettier); worker Jest **12789/12789**
  + tsc 0. Worker fn + heuristic fully unit-tested; the `<datalist>` RENDERING is verify-by-build (deep lazy chunk).

### ✅ Shipped next fire (2026-09-26 #44) — value datalist on Add-row + per-(table,col) memoization (editor-only)
Generalizes #43's single-cell datalist. The distinct-value suggestions now ALSO appear on the **Add-row** form (lazy —
fetched on a text field's focus, not on form open, so an N-column form fires zero requests until a field is used), and
every distinct result is **memoized per (table,column)** so re-opening an editor for the same column never refetches.
Editor-only — no worker/bridge/admin change (the `/column-distinct` route + `columnDistinct` bridge field shipped #43).
- **Unified fetch (`DataPanel.tsx`):** the single `distinctValues`/`distinctCid` pair is replaced by `distinctByCol`
  (`{ col: values }` for the current table, read by BOTH the single-cell editor and the Add-row) + a persistent
  `distinctCache` `Map` ref (survives table switches) + `pendingDistinct` (cid → `{key,col}`). One `ensureDistinct(col)`
  is CACHE-FIRST + idempotent (skips when a request for the same key is in flight); the receive handler routes the
  reply via the pending map to its column + fills the cache. `distinctByCol` clears on table switch; the cache persists.
- **Pure key (`data-panel-logic.ts`, +3 Vitest):** `distinctCacheKey(table, col)` — newline-separated so the cache never
  mixes two tables sharing a column name (`('ab','c') ≠ ('a','bc')`).
- **Lazy trigger:** `<TypedValueField>` gains `onRequestSuggestions` (fired on the text widget's `onFocus`); the Add-row
  wires it only for text-kind columns (no wasted fetch on numeric/date/etc). The single-cell editor still prefetches in
  `startEdit` so suggestions are ready when the drawer editor renders.
- Verified: editor Vitest **935/935** + tsc 0 + eslint 0 + build 0. No worker/admin files touched (worker Jest
  **12789/12789** unchanged). Cache key + heuristic unit-tested; the datalist/focus RENDERING is verify-by-build.
  *(Incidental fix: stripped 5 stray NUL bytes that a prior edit left in `data-panel-logic.ts` — grep goes silent on
  NUL-containing files, so this had been invisible; file re-verified clean via tsc + a byte sweep.)*

### ✅ Shipped next fire (2026-09-26 #45) — NULL vs empty-string affordance (toggle chip + live "saves as…" hint)
Resolves the SQLite `NULL` vs `''` ambiguity a blank text field can't express — the choice was buried as one of 7
options in the type `<select>`. The single-cell editor now shows (a) an explicit **"∅ NULL" toggle chip** beside the
value (pressed = NULL; one click flips text⇄null) and (b) a live one-line **hint** stating exactly what Save will
store. Editor-only — the mechanism (`null` kind binds NULL, blank `text` binds `''`) was already correct; this makes
it OBVIOUS + one-click, matching the grid's honest NULL vs `""` cell rendering.
- **Pure hint (`data-panel-logic.ts`, +3 Vitest):** `nullabilityHint(kind, value)` — `null`→"Saves as NULL (no
  value)."; blank `text`→"Saves as an empty string (\"\"). Use NULL for no value."; every unambiguous state → `''`
  (no hint). Drives an inline hint, never a mutation.
- **Toggle (`CellEditor.tsx`):** shown only for the ambiguous **text/null** pair (number/boolean/date have
  unambiguous widgets; an empty date/json already throws on save → guides to NULL). `aria-pressed` reflects NULL;
  click calls `onKindChange('null'↔'text')` (reuses the existing kind machinery — no new state).
- Verified: editor Vitest **938/938** + tsc 0 + eslint 0 + build 0. No worker/admin files touched (worker Jest
  **12789/12789** unchanged). Hint logic unit-tested; the chip + hint RENDERING is verify-by-build (deep lazy chunk).

### ✅ Shipped next fire (2026-09-26 #46) — honest BLOB rendering (worker envelope + read-only "BLOB · N bytes" chip)
D1 returns a BLOB column as an `ArrayBuffer`; `JSON.stringify` mangles it to a useless `{}` (indistinguishable from an
empty object), and a text editor opened on it would corrupt the binary. BLOBs surface only via the super-admin **SQL
console** today (the fixed overview tables have no BLOB columns) — so this is a real correctness fix for that path,
applied defensively across every cell renderer. Full-stack (worker serialization + editor classification).
- **Worker (`site_detail_tabs.ts`, +4 jest):** `toBlobCell(value)` — an `ArrayBuffer`/typed-array view → a JSON-safe
  envelope `{ __blob: true, bytes, hex }` (hex = first 16 bytes, offset/length respected); non-binary passes through.
  `serializeSqlRows(rows)` maps every `/sql/exec` result cell through it (column keys unchanged). Pure + exported.
- **Editor (`data-cell-format.ts` + `data-panel-logic.ts`, +7 Vitest):** shared `blobCellInfo(value)` + `humanBytes(n)`
  detect the envelope. `classifyCell` gains a **`'blob'`** kind → a muted-violet read-only "BLOB · N bytes" chip with a
  hex tooltip (ellipsis when bytes>preview); `formatCellValue` (SQL console) renders the same label; `clipboardValue`
  returns `''` (binary isn't text-copyable → no copy affordance). Read-only is inherent — SQL results aren't editable,
  and the editable overview tables have no BLOB columns.
- **No bridge/admin change:** the envelope is just an object value in the existing SQL-response `rows` (forwarded opaquely).
- Verified: worker Jest **12793/12793** + tsc 0; editor Vitest **945/945** + tsc 0 + eslint 0 + build 0. Serialization +
  classification fully unit-tested; the chip RENDERING is verify-by-build (deep lazy chunk).

### ✅ Shipped next fire (2026-09-26 #47) — KV value-edit PRESERVES metadata + expiration (real worker bug)
Phase-0 audit finding: much of the matrix is MORE built than the per-fire framing assumed — **EXPLAIN QUERY PLAN is
already fully wired** (button + `explainQuery`/`explainPlanHint`/`isExpensiveScan`, #46's proposed NEXT was redundant),
Schema (DDL/indexes/FKs via `/sql/schema` + console quick-queries + completion) is present, and **KV is fully built
end-to-end** (`kv_inspector` read+write endpoints + admin proxy + a 522-line `<KvBrowser>` with namespace picker, key
list, value viewer, edit/delete — the 2026-09-25 "read-only" memory was stale). The real gap was a **correctness bug**:
- **Bug:** `PUT /api/admin/kv/:binding/value` did `kv.put(key, value, expirationTtl ? {expirationTtl} : undefined)`.
  CF KV `put()` REPLACES the whole entry, so editing a value **silently wiped the key's metadata** and **cleared its
  TTL** (key became permanent) — a direct violation of the epic's "preserve metadata+expiry unless explicitly changed."
  User-visible: the value viewer shows metadata + expiration, which vanished on the next read after an edit.
- **Fix (`kv_inspector/handlers.ts`, +7 jest):** before the put, `readKvEntryMeta` reads existing metadata
  (`getWithMetadata`) + absolute expiration (`list({prefix:key})` matched on the exact name; fail-soft). Pure
  `buildKvPutOptions({expirationTtl, existingMetadata, existingExpiration, nowSec})` decides the put opts: an explicit
  new TTL WINS; else the existing expiration is re-applied **only when still ≥60s out** (KV's floor — never re-apply a
  past/near expiry); metadata is always preserved (no metadata-edit path). Returns `undefined` for a plain create.
- Verified: worker Jest **12800/12800** (+7: 5 pure `buildKvPutOptions` + 2 route preservation/TTL-wins) + tsc 0.
  Worker-only (the `<KvBrowser>` edit flow already calls PUT — the fix makes it honest). No editor/bridge change.

### ✅ Shipped next fire (2026-09-26 #48) — KV value-editor TTL controls: set new expiry + explicit "make permanent"
Completes #47. The `<KvBrowser>` value editor gains real expiration controls, and the viewer now SHOWS the selected
key's expiration. Full-stack (worker schema + logic + bridge + admin + editor).
- **Worker (`kv_inspector`, +3 jest):** `KvPutSchema` gains `clearExpiration?: boolean`; `buildKvPutOptions` honors it
  (precedence: explicit `expirationTtl` WINS → else `clearExpiration` makes the key permanent, deliberately NOT
  re-applying the existing expiration → else preserve). The only way to drop a TTL now that a bare edit preserves it.
- **Bridge + admin:** `KvRequestMessage`/`PsMessage` put op gains `clearExpiration?`; the admin PUT-proxy forwards it
  (`expirationTtl` was already forwarded).
- **Editor (`kv-browser-logic.ts` +4 Vitest · `KvBrowser.tsx`):** pure `decideKvExpiry({clearExpiration, ttlInput})` →
  `preserve | clear | ttl | invalid` (the checkbox WINS; blank = preserve; a TTL must be a whole number ≥60 else
  **blocked with a message, never a silent no-op**). The edit form adds a "Remove expiration (make permanent)" checkbox
  + a "Set new expiry (s)" input (mutually exclusive); both the viewer and the editor show the selected key's current
  expiration (from the already-fetched key list — KV has no exact-key expiration getter, so the value endpoint can't
  return it). `saveValue` blocks an invalid TTL with the message before any write.
- Verified: worker Jest **12803/12803** (+3) + tsc 0; editor Vitest **949/949** (+4) + tsc 0 + eslint 0* + build 0;
  admin tsc 0. (*one PRE-EXISTING `react-hooks/exhaustive-deps` "rule not found" in KvBrowser — the editor eslint
  config lacks that plugin, repo-wide + not mine.) Decision logic + put-options fully unit-tested; the form is verify-by-build.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize drag · #34 footer picker · #35 whole-query fetch · #36
sticky-pin render · #37 view round-trip · #40 multi-sort · #41 date/datetime picker · #42 boolean checkbox + JSON
textarea · #43–#44 value datalist · #45 NULL toggle + hint · #46 BLOB chip · #47–#48 KV metadata/TTL preserve + set/clear
— one real-browser pass (authed admin session). **A dedicated real-browser QA fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #49) — R2/Vectorize/Queues audit (CLEAN) + R2 delimiter "folder" grouping
**Audit outcome (the committed #48 task): all three inspector browsers are CLEAN** — `<R2Browser>`/`<VectorizeBrowser>`/
`<QueuesBrowser>` are honestly read-only (their backends are GET-only; each carries an explicit "no downloads / no
query-insert-delete / no send-purge-ack" note), so NO doomed controls and NO replace-semantics writes (the KV bug class
is absent). The one real gap found: R2 listed **flat** (`r2.list({prefix})`, no `delimiter`), so a bucket with many
`/`-delimited keys had no folder navigation — and the KV/R2 mandate is "group keys by prefix visually." Shipped that.
- **Worker (`r2_inspector`, +2 jest):** `R2ListQuerySchema` gains `delimiter`; the objects handler forwards it to
  `r2.list({delimiter})` and returns `delimitedPrefixes` (the "folders" at this level; `[]` when no delimiter). Caught a
  real self-introduced bug via the test — the `safeParse` INPUT object omitted `delimiter: c.req.query('delimiter')`, so
  the schema stripped it (added it → green). Column keys unchanged; still read-only.
- **Bridge + admin:** `R2RequestMessage.delimiter` + `R2ObjectsData.delimitedPrefixes`; admin forwards the delimiter.
- **Editor (`r2-browser-logic.ts` +5 Vitest · `R2Browser.tsx`):** pure `r2ParentPrefix` (up-nav) + `r2PrefixLabel`
  (folder display name relative to the current prefix). The object list now renders an "up" row + clickable "folder"
  rows (from `delimitedPrefixes`) above the objects; clicking drills in (sets the prefix + reloads). Honestly titled
  "key-prefix (folder-like) — R2 keys are flat; this is a display grouping" (never claims real directories).
- Verified: worker Jest **12805/12805** (+2) + tsc 0; editor Vitest **954/954** (+5) + tsc 0 + build 0; admin tsc 0.
  Pure nav helpers + the worker delimiter path unit-tested; the folder UI is verify-by-build. (`R2Browser.tsx` carries
  27 PRE-EXISTING editor-eslint style errors — a known repo-wide-dirty file; my additions match its style; the editor
  build doesn't gate on eslint. Not mine, confirmed via a stash check.)

**STILL-OPEN manual QA (not loop-actionable):** #33 resize drag · #34 footer picker · #35 whole-query fetch · #36
sticky-pin render · #37 view round-trip · #40 multi-sort · #41 date/datetime picker · #42 boolean checkbox + JSON
textarea · #43–#44 value datalist · #45 NULL toggle + hint · #46 BLOB chip · #47–#48 KV metadata/TTL · #49 R2 folder
nav — one real-browser pass (authed admin session). **A dedicated real-browser QA fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #50) — grounded "Ask your data" slice 1: deterministic `compileQueryIntent` (the AI→SQL core)
The SECURITY-CRITICAL deterministic core of delivery-order slice 5: a strict typed intent (which an AI proposes, or a
UI builds) → parameterized SQLite over an ALLOWLISTED overview table. The model NEVER emits SQL — it emits an intent
that this PURE function validates + compiles. Worker-only, no UI/model yet (the executor endpoint + AI pipeline are
later fires); fully unit-tested first.
- **`compileQueryIntent(intent, spec)` (`handlers.ts`, +13 jest):** two modes, never mixed — PROJECTION (plain columns)
  or AGGREGATE (count/sum/avg/min/max + optional single `groupBy`). Every column is re-validated against `spec.columns`
  + quoted (the injection boundary, NEVER bound); every aggregate against a fixed `INTENT_AGGS` whitelist; filter VALUES
  are bound via the REUSED `buildColumnFilters` (composes the existing tested boundary); the query is always site-scoped
  (`WHERE site_id = ?` first, derived from `spec.countSql` — so soft-delete tables keep `AND deleted_at IS NULL`) and
  LIMIT-bounded (`clampIntentLimit` → `[1, MAX_INTENT_LIMIT=1000]`). Returns `{ ok, sql, params }` (run as
  `.bind(siteId, ...params)`) or a TYPED refusal (`unknown column/aggregate`, `cannot mix`, `groupBy requires an
  aggregate`, empty select). Aggregate mode auto-orders by the primary aggregate alias DESC (top-N); projection honors
  the intent's `orderBy` via `buildOrderByClause` (allowlist-validated). Pure — no I/O, never executes.
- **Security proof (tests):** an injection-shaped filter value rides as a bound param (SQL unchanged); an unknown/
  injection-shaped column is REJECTED before reaching SQL; a bad aggregate is rejected by the whitelist; the site scope
  + soft-delete predicate are always present; the limit is clamped into params.
- Verified: worker Jest **12818/12818** (+13) + tsc 0 + 0 eslint errors. Worker-only — no editor/bridge/admin change;
  this is the deterministic compiler the AI pipeline will target. FULLY verifiable (pure fn, no verify-by-build debt).

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders — one real-browser pass (authed admin). **A dedicated real-browser QA fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #51) — "Ask your data" slice 2: the authorized EXECUTOR endpoint
Wires #50's compiler into a real gated route: `POST /api/sites/:siteId/data-overview/:table/query`. Safety chain: org
auth (401) → `ownsSiteData` tenant gate (404, never a 403 leak) → `overviewTable` allowlist (400 unknown) →
`compileQueryIntent` (400 with the TYPED reason on an invalid intent) → BOUND execution
(`DB.prepare(sql).bind(siteId, ...params).all()`) → returns `{ table, sql (echoed for transparency), rows, rowsRead }`.
Read-only, LIMIT-bounded, fail-soft (a runtime SQL error → 502, never a fabricated empty result). Worker-only.
- **PII hardening (compiler, `handlers.ts`):** `compileQueryIntent`'s spec param gains `maskedColumns` — a masked
  column (the route passes `email` on `form_submissions`, which the browse route masks) may be FILTERED (WHERE, like
  the browse path) but is REJECTED in SELECT / aggregate / groupBy (would leak the raw PII via a row or the `grp`
  alias). Also added `MAX_SELECT_FIELDS=64` (bounds a hostile huge select; columns are allowlisted anyway).
- **Route tests (`query.test.ts`, NEW, 9 jest) + compiler tests (+2):** 401 unauth · 404 foreign-site (never a 403
  leak) · 400 unknown table · 400 unknown-column (compiler reason surfaced, nothing reaches the DB) · 400 masked-email
  select · 200 projection (asserts BOUND `[siteId, limit]` + echoed SQL) · 200 aggregate count+groupBy · 502 on a
  runtime throw · 400 non-JSON body. Compiler: masked-col reject-in-output/allow-in-filter + select-count bound.
- Verified: worker Jest **12829/12829** (+11, +1 suite) + tsc 0 + 0 eslint errors. Worker-only. Fully verifiable
  (route jest with a mock DB + pure-compiler tests) — no verify-by-build debt. The route is live for the AI pipeline
  (slice 3) + a future UI query-builder to call; a post-deploy 401-liveness check confirms the route exists once the
  worker CI deploys (~14min).

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders — one real-browser pass (authed admin). **A dedicated real-browser QA fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #52) — "Ask your data" slice 3: NL→intent via AI Gateway (grounded, model-untrusted)
The `POST /api/sites/:siteId/data-overview/:table/ask` route completes the NL→answer pipeline: question + the table's
authorized schema → a CF-hosted model (via the observed, cost-ledgered `runObservedWorkersAI` rail) with
`response_format: json_object` proposes a `QueryIntent` (NEVER SQL) → shape-harden → **re-validate with the #50/#51
`compileQueryIntent` boundary server-side** → execute via the #51 path → return `{ question, intent, sql, rows, rowsRead }`.
The model is UNTRUSTED: a disobedient/attacked proposal can never widen access (the compiler is the boundary, not the prompt).
- **Pure NL helpers (`handlers.ts`, +7 jest):** `askSystemPrompt(spec)` (JSON-only guidance; lists authorized columns +
  flags masked columns as filter-only) + `parseProposedIntent(raw)` (untrusted model output — object OR JSON string —
  → shape-hardened intent or `null`; bounded to the compiler's field/condition/sort caps; NO authorization, that's the
  compiler's job).
- **Route (`ask.test.ts`, NEW, 9 jest):** the full pipeline with a MOCKED AI binding + mock DB. **Security proof:** a
  hostile proposal selecting a MASKED column (`email`) or an UNKNOWN column is REJECTED (400) with NO SQL executed
  (proves the model can't widen access); unparseable → 422; AI down → 502; runtime SQL error → 502; auth chain (401 →
  404 tenant → 400 unknown table → 400 empty question). Falsifiable response echoes question + intent + exact SQL + rows.
- **AI cost/observability:** the call goes through `runObservedWorkersAI` → PostHog `$ai_generation` + Langfuse + the
  cost ledger (`promptId: 'data_ask'`, per-org `distinctId`) — per-tenant AI accounting for free. `temperature: 0.1`,
  `max_tokens: 512`, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (hard schema reasoning → the stronger CF model).
- Verified: worker Jest **12846/12846** (+17, +1 suite) + tsc 0 + 0 eslint errors. Worker-only. The AI call is real code
  (mocked in tests, live in prod); the deterministic pipeline (parse + compile + execute) is fully unit-tested.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52 the live-model NL→answer path (a real browser/authed call — the mocked pipeline is proven; a live
model quality/eval RUN with golden fixtures is the remaining out-of-loop step). **A dedicated real-browser + live-model
eval fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #53) — "Ask your data" slice 4: the editor "Ask this table" panel (falsifiable UI)
The owner-facing UI for the #52 `/ask` route: a compact **`<AskPanel>`** at the top of the active-table view — a
plain-English question box that returns a COMPUTED answer AND shows how it was computed (the AI's interpretation + the
exact SQL). Full-stack UI (editor + bridge + admin); no worker change (the `/ask` route + all worker logic shipped #52).
- **Bridge (`embedded-mode.ts`):** `PS_ASK_REQUEST` `{table, question}` + `PS_ASK_RESPONSE` `{ok, data:{question,
  intent, sql, rows, rowsRead}, error}` — distinct from `PS_NL2SQL_REQUEST` (super-admin "draft SQL", not executed).
- **Admin (`bolt-embed.service.ts`):** a `PS_ASK_REQUEST` handler proxies to `POST /sites/:id/data-overview/:table/ask`
  (owner session) + maps the worker's typed errors to friendly, status-specific messages (404/422/400-compiler-reason/502).
- **Editor (`AskPanel.tsx`, NEW · `data-panel-logic.ts` +5 Vitest):** self-contained (own `PS_ASK_RESPONSE` listener +
  30s timeout, mirrors `<KvBrowser>`); question → answer as a compact rows table + an **"Interpreted as: …"** summary
  (pure `describeIntent` — tested) + a **"Show the exact SQL"** disclosure (falsifiable, per the AI mandate) + honest
  loading/error/empty states. A prominent one-line note: "The AI proposes a query; the server validates + runs it — the
  exact SQL is shown, nothing is hidden." Wired into the browsable active-table view.
- Verified: editor Vitest **959/959** (+5) + tsc 0 + eslint 0 + build 0; admin tsc 0. `describeIntent` unit-tested; the
  panel is verify-by-build. **Deploy-skew note:** the editor (CF Pages ~2min) ships the panel before the admin
  (worker/frontend CI ~14min) ships the `PS_ASK` handler → in the gap the panel's 30s timeout yields an honest error
  (never a crash); the feature works once the admin deploys.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#53 the live-model NL→answer path (a real authed browser Ask + a live-model golden-fixture eval RUN
— the mocked pipeline + the panel are proven; the live model quality is the remaining out-of-loop step). **A dedicated
real-browser + live-model eval fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #54) — "Ask your data" slice 5: executed-answer EVAL harness (real SQLite)
The AI mandate's eval suite — "compare EXECUTED answers vs expected, not plausible-looking SQL." `ask-eval.test.ts`
seeds a **two-tenant** `form_submissions` fixture in a REAL SQLite (`node:sqlite` via the `d1_sqlite` facade) and runs
golden `{question, intent}` fixtures through the REAL pipeline — `parseProposedIntent → compileQueryIntent → EXECUTE` —
asserting the COMPUTED rows (not the SQL string). Deterministic + CI-safe (recorded golden intents; the live model
call is exercised separately in `ask.test.ts` with a mocked binding; a live-model quality run stays opt-in/out-of-loop).
`PROMPT_VERSION = 'ask-v1'` tags the run so a regression is attributable.
- **7 golden fixtures, executed against real SQLite:** count-by-status (grouped counts, `ORDER BY n DESC`) · filter
  (open only) · NULLs (`notes IS NULL` matches only the genuine null) · dates/order (newest-first) · **tenant isolation**
  (a broad projection returns ONLY site-A's 3 rows — site-B's 2 excluded by the `site_id` scope; the site-B-only `spam`
  status never leaks) · **prompt-injection** (a proposal to select/group the MASKED `email` is REJECTED by the compiler,
  never executed) · **injection-shaped value** (a `'; DROP TABLE …` filter value is BOUND → 0 rows, and the 5-row table
  survives intact — proves binding safety at EXECUTION, not just in the SQL string).
- Verified: worker Jest **12853/12853** (+7, +1 suite) + tsc 0 + 0 eslint errors. Worker/test-only (no prod code
  change) — the eval is pure regression protection for slices #50–#53 (the compiler + executor + parse boundary),
  FULLY verifiable (real SQL execution, no mock-double blind spots).

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#53 live-model NL→answer path (real authed browser Ask + a LIVE-model quality run — the deterministic
pipeline is now eval-proven end-to-end; only the live model's question→intent QUALITY is unmeasured). **A dedicated
real-browser + live-model eval fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #55) — "Ask your data" slice 6: save an Ask answer as a saved view (SUCCESS-STANDARD item 5 tail)
The grounded-query analog of a saved grid view: a **"Save as view"** action in `<AskPanel>` turns a computed answer into
a reusable entry under the grid's **Views** list — so an owner who asked "how many rows by status?" can pin that as a
one-click view. **Editor-only fire** — reuses the EXISTING `editor_grid_views` store + the `PS_VIEW_REQUEST` save path
(NO worker / bridge / admin / schema change): the ask intent is MAPPED onto a real grid/chart view, so it reopens via
the existing `applyView` with zero contamination of the saved-views list.
- **Pure mapping (`data-panel-logic.ts` · `askIntentToSavedView(intent, question)`, +4 Vitest):** aggregate + `groupBy`
  → a **`chart`** view (`viewConfig.groupField`); otherwise a **`grid`** view carrying the filters (JSON), combinator,
  primary sort (`sortCol`/`sortDir`) + a `viewConfig.sorts` string for multi-sort; the question (≤80 chars) becomes the
  view name (blank → "Saved question"). Deterministic + fully unit-tested — the security-relevant fields (filters, type)
  are re-validated server-side by the existing `/views` save (unchanged).
- **Editor (`AskPanel.tsx`):** widened the `postToParent` prop to `AskRequestMessage | ViewRequestMessage`; a second
  branch in the message listener resolves the save ack (`PS_VIEW_RESPONSE` matched by a dedicated `saveCid` ref — never
  crosses wires with DataPanel's own view round-trips); a **"Save as view"** button (idle → "Saving…" → "Saved ✓" /
  honest error) beside the "Show SQL" disclosure; resets on each new ask.
- Verified: editor Vitest **963/963** (+4) + tsc 0 + eslint 0 + build 0; admin tsc 0. Verify-by-build for the button
  (deep lazy chunk); the mapping is unit-proven. **No deploy skew** — the reused `PS_VIEW_REQUEST` save handler already
  ships in the admin; only the editor changed (CF Pages ~2min).

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 the live NL→answer + save-as-view path (a real authed browser Ask + a LIVE-model quality run —
the deterministic pipeline + the intent→view mapping are eval/unit-proven; only the live model's question→intent QUALITY
and the in-browser save round-trip are unmeasured). **A dedicated real-browser + live-model eval fire remains the
highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #56) — schema workflow slice 1: guided "New table" builder (wires the inert `schema-ddl.ts`)
DELIVERY-ORDER 4 (SQL workspace + **schema/migration workflow**): the first guided schema-mutation surface — a super-admin
**"New table"** builder in the tables overview that compiles a reviewable `CREATE TABLE` and runs it on the EXISTING
authorized write rail. Wires the previously-inert, well-tested `schema-ddl.ts` (`buildCreateTable` + `quoteIdent` +
`DdlError`) into the real UI.
- **Why CREATE TABLE (not ALTER):** the editor manages the SHARED platform D1, so altering an existing table (e.g.
  `form_submissions`) is a platform-schema action (foot-gun). **Creating a NEW object can't corrupt or expose existing
  data** — the safest DDL. The new table is then browsable via the SQL console's "All tables" canned query (line 306) +
  one-click-browse (`isTableListRow`), so it's coherent with today's developer surface.
- **Pure core (`data-panel-logic.ts` · `planCreateTable(name, columns)`, +10 Vitest):** maps the form → `{ ddl, error,
  warning }` via `buildCreateTable`; drops blank placeholder rows; returns a human error instead of throwing (dup column,
  illegal/injection-shaped identifier → the `DdlError` message); a non-fatal `warning` when no PK is chosen (rows only
  rowid-identifiable → grid edit/delete unavailable). Identifier validation + quoting is the SQL-injection boundary; the
  DDL is SHOWN before it runs (falsifiable). Fully unit-proven incl. composite PK + injection refusal.
- **UI (`DataPanel.tsx`):** a "+ New table" affordance (super-admin `canRunSql`) → a builder panel: table name + typed
  column rows (name / TEXT·INTEGER·REAL·BLOB / PK / NOT NULL / remove) + "Add column"; live DDL `<pre>` preview; PK
  warning; apply via `runSql(ddl)` (→ the existing super-admin `/sql/exec-write`, re-guarded server-side; CREATE is
  non-destructive so no scary confirm). A dedicated `createTablePending` ref routes the reply for INLINE success/error
  (name captured in `createNameRef` — the message effect has empty deps, per the stale-closure lesson); success flashes,
  resets, and `requestOverview()` refreshes.
- Verified: editor Vitest **973/973** (+10) + tsc 0 + eslint 0 + build 0. **No worker/bridge/admin change** (reuses the
  `PS_SQL_REQUEST` write path — zero deploy skew). Verify-by-build for the form (deep lazy chunk); the compiler + all
  refusals are unit-proven. **Phase-0 correction:** the prior fire's proposed NEXT (a) "render chart views as bars" was
  found ALREADY DONE — `viewMode==='chart'` renders a whole-query bar chart via `buildChartBars` + measure/agg controls,
  and `applyView` restores it; a saved Ask→chart view already reopens as a real chart. Not rebuilt.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 live NL→answer + save-as-view · **#56 the New-table builder round-trip in a real authed browser
(the DDL compiler + refusals are unit-proven; the form + write-rail apply are verify-by-build).** **A dedicated
real-browser + live-model eval fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #57) — schema workflow slice 2: guided "Add index" builder (wires `schema-ddl.ts`'s `buildCreateIndex`)
Completes the tables/indexes pair of the schema builder, reusing the exact #56 pattern (CREATE = non-destructive new
object · super-admin `canRunSql` · existing `/sql/exec-write` rail · unit-proven pure planner + verify-by-build UI). A
super-admin **"Add index"** affordance on the OPEN table → pick columns (pick-order = index order) + optional name +
UNIQUE → reviewable `CREATE [UNIQUE] INDEX` → runs on the write rail → the index surfaces in the SQL "Indexes" canned
query. Serves the perf story ("warn before unindexed scans" / "FTS5 search only when an index exists" / "make index
costs visible"). Non-destructive → no scary confirm; target EXISTS + is browsable → fully coherent.
- **Pure core (`data-panel-logic.ts`, +11 Vitest):** `planCreateIndex(table, name, columns, unique)` → `{ ddl, error }`
  via `buildCreateIndex` (drops blank cols; human error not a throw; injection-shaped column name → the `DdlError`
  message). `suggestIndexName(table, cols)` → a sanitised `idx_<table>_<cols>` legal-identifier default so a blank name
  auto-derives (pick columns → create). Single/composite/UNIQUE + injection refusal + name-sanitisation all proven.
- **UI (`DataPanel.tsx`):** an "Add index" toolbar button (beside Add row / Import CSV, super-admin) → a builder panel:
  name input (placeholder = the live suggestion), column chips with pick-order badges, a UNIQUE toggle (with an honest
  "fails if existing rows already collide" note), live DDL `<pre>` preview, apply via `runSql(ddl)`. A dedicated
  `createIndexPending` ref routes the reply for INLINE success/error; the flash message avoids the stale-closure trap
  (uses a constant, not `indexUnique` state — the message effect has empty deps, per the #56 lesson).
- Verified: editor Vitest **984/984** (+11) + tsc 0 + eslint 0 + build 0. **No worker/bridge/admin change** (reuses the
  `PS_SQL_REQUEST` write path — zero deploy skew). Verify-by-build for the form; the compiler + refusals are unit-proven.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 live NL→answer + save-as-view · **#56–#57 the New-table + Add-index builder round-trips in a
real authed browser (the DDL compilers + refusals are unit-proven; the forms + write-rail apply are verify-by-build).**
**A dedicated real-browser + live-model eval fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #58) — schema workflow slice 3: index MANAGER (list + drop) on the open table
Turns the Add-index affordance (#57) into a full **create → see → drop** index manager, completing index CRUD. Opening
"Indexes" now loads the open table's existing indexes and offers a per-index **Drop** (user-created indexes only).
- **Read (fetch):** `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='<table>'` on its OWN cid (a
  quiet read mirroring the PK PRAGMA fetch; `<table>` guarded to a bare identifier → injection-free). ONE plain
  sqlite_master SELECT (no PRAGMA/table-valued-fn/join) — the D1-safest shape. `sql` non-null ⇒ user index (droppable,
  parseable); null ⇒ constraint/PK auto-index (shown "system", never droppable via `DROP INDEX`).
- **Pure core (+10 Vitest across two files):** `summarizeIndexRow({name,sql})` → `{name, unique, droppable, columns}`
  (parses UNIQUE + best-effort columns from the CREATE SQL; defensive on odd shapes). `planDropIndex(name)` →
  `{ddl,error}` via new `buildDropIndex(name)` in `schema-ddl.ts` (+3 tests — uses `quoteIdent` for real-object quoting,
  NOT `assertSafeIdent`, so a legitimately-quoted index name isn't over-rejected; throws on blank).
- **Drop apply:** DROP is destructive → keeps a **type-to-confirm**, then posts `write:true, confirm:true` on the sql
  cid/timer (own `dropIndexPending` ref; the worker exec-write re-guards super-admin + confirm; `DROP INDEX` passes the
  PROTECTED_TABLES denylist because `sqlTargetTable` finds no INTO/FROM/UPDATE/TABLE keyword). On success the index is
  **optimistically removed** from the list (functional `setState`, so no stale-closure re-fetch — per the #56 lesson).
- **UI:** the index panel now has an "Existing indexes" section (loading / error / empty / list with UNIQUE + system
  badges + `(columns)` + a Drop button on droppable rows) above the "Create index" form; toolbar button relabeled
  "Indexes". Honest: a UNIQUE/PK auto-index shows "system" and offers no Drop (it's managed by its table).
- Verified: editor Vitest **994/994** (+10) + tsc 0 + eslint 0 + build 0. **No worker/bridge/admin change** (reuses the
  `PS_SQL_REQUEST` read + write paths — zero deploy skew). Verify-by-build for the list/drop UI; compiler + parse + refusals unit-proven.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 live NL→answer + save-as-view · **#56–#58 the New-table + index-manager (create/list/drop)
round-trips in a real authed browser (the DDL compilers + parse + refusals are unit-proven; the forms + write-rail
apply + the sqlite_master index fetch are verify-by-build).** **A dedicated real-browser + live-model eval fire remains
the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #59) — import wizard slice: JSON-array import (auto-detected) alongside CSV
The import panel was CSV-only; the directive mandates a "CSV/TSV/**JSON** wizard." Now the ONE import panel accepts a
CSV paste OR a JSON array of objects — auto-detected, same preview + the same parameterized `/sql/exec-write` rail, no
mode toggle. Chosen because it's a meaty, fully-verifiable, editor-only slice (the live-model eval RUN is genuinely
out-of-loop — it needs a dedicated authed-prod session + a verified worker `/ask` deploy — so it stays the standing
out-of-loop step, not forced into a 12-min in-loop fire).
- **Pure core (`data-panel-logic.ts`, +10 Vitest):** `buildJsonImportPlan(jsonText, table)` → the SAME `CsvImportPlan`
  shape (columns = union of object keys in first-seen order; ragged objects → missing key binds `null`; primitives bind
  directly so numbers stay numbers; nested object/array → `JSON.stringify` text; injection-shaped value rides as an
  inert bound param; chunked to the exec-write param cap). `detectImportFormat(text)` (leading `[` ⇒ json) +
  `buildImportPlan(text, table)` dispatcher. All refusals proven (bad JSON / non-array / empty / non-object element /
  bad field or table identifier / too-wide).
- **UI (`DataPanel.tsx`):** the `importPlan` memo now calls `buildImportPlan` (auto-dispatch); the panel shows a live
  **format badge** (CSV/JSON), a dual-format hint + placeholder, and the toolbar button is relabeled "Import". The
  existing preview (columns/rowCount/first-batch statement) + submit + partial-batch disclosure are reused unchanged.
- Verified: editor Vitest **1004/1004** (+10) + tsc 0 + eslint 0 + build 0. **No worker/bridge/admin change** (reuses
  the CSV import's `PS_SQL_REQUEST` write path — zero deploy skew). Verify-by-build for the panel; the plan builders +
  refusals are unit-proven.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 live NL→answer + save-as-view · #56–#58 schema builder (table/index create + index drop) ·
**#59 the JSON-import round-trip in a real authed browser (the plan builders + refusals are unit-proven; the panel +
write-rail apply are verify-by-build).** **A dedicated real-browser + live-model eval fire remains the highest-value
out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #60) — grid: "Copy selected" rows to the clipboard (the bulk copy/paste verb)
The bulk selection footer had Delete + Clear + live aggregates but **no copy** — a directive-named gap ("range
copy/paste", "bulk copy"). Now a **"Copy"** button copies the selected rows to the clipboard as a **TAB-separated block
(header + rows)** — the spreadsheet-native format, so it pastes straight into Google Sheets / Excel cells with no import
dialog. Reuses the existing page-scoped selection + `writeClipboard` (fail-soft) + `flashStatus`.
- **Pure core (`data-panel-logic.ts` · `toTsv(columns, rows)`, +4 Vitest):** labelled tab header + CRLF rows; a cell is
  double-quote-wrapped ONLY on tab/quote/CR/LF (a comma stays bare, unlike CSV — correct for spreadsheet paste); null →
  empty; object → JSON. Same escaping discipline as the sibling `toCsv`.
- **UI (`DataPanel.tsx`):** a `selectedRows` memo (page-scoped, matching the aggregates footer) + a `copySelected`
  callback (`writeClipboard(toTsv(visibleCols, selectedRows))` + a "Copied N rows" flash); a "Copy" button placed before
  "Delete selected" in the bulk bar (`data-bulk-copy`).
- Verified: editor Vitest **1008/1008** (+4) + tsc 0 + eslint 0 + build 0. **No worker/bridge/admin change** (pure
  client-side clipboard — zero deploy skew). Verify-by-build for the button; `toTsv` unit-proven.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 live NL→answer + save-as-view · #56–#58 schema builder · #59 JSON import · **#60 the
Copy-selected clipboard write in a real authed browser (a secure-context clipboard call; `toTsv` is unit-proven).**
**A dedicated real-browser + live-model eval fire remains the highest-value out-of-loop step.**

### ✅ Shipped next fire (2026-09-26 #61) — SQL workspace: JSON export + clipboard copy (result-grid export parity)
The SQL console result grid exported CSV only; the browse grid has CSV+JSON+copy (#60). Now the SQL result grid has
**JSON export** + a **"Copy"** (TSV → clipboard) beside the CSV button — completing the directive's SQL-workspace
"CSV/JSON export" + bringing the browse grid's copy affordance to query results. All client-side, read-only.
- **Pure core (`data-panel-logic.ts` · `toJsonRows(columns, rows)`, +5 Vitest):** pretty-printed JSON array, each row
  projected to the columns using the **raw keys** (round-trip fidelity, not human labels) and **preserving value types**
  (a number stays a number; a nested object/array stays STRUCTURED, not stringified — unlike CSV/TSV); a missing key
  binds `null`; empty rows → `[]`. The developer-facing sibling of `toCsv`/`toTsv`.
- **UI (`DataPanel.tsx`):** `exportSqlJson` (downloads `query-result.json`) + `copySqlResult`
  (`writeClipboard(toTsv(sqlColumns, sqlVisibleRows))` + a "Copied N rows" flash, reusing #60's `toTsv`); a **JSON** +
  **Copy** button added to the SQL result toolbar (`data-sql-export-json` / `data-sql-copy`), same gating as the CSV button.
- Verified: editor Vitest **1013/1013** (+5) + tsc 0 + eslint 0 + build 0. **No worker/bridge/admin change** (client-side
  serialize/clipboard/blob-download — zero deploy skew). Verify-by-build for the buttons; `toJsonRows` unit-proven.

**STILL-OPEN manual QA (not loop-actionable):** #33 resize · #34 footer · #35 whole-query · #36 pins · #37 view · #40
multi-sort · #41 date picker · #42 checkbox/JSON · #43–#44 datalist · #45 NULL toggle · #46 BLOB · #47–#48 KV meta/TTL ·
#49 R2 folders · #52–#55 live NL→answer + save-as-view · #56–#58 schema builder · #59 JSON import · #60 grid copy ·
**#61 SQL-result JSON export + copy in a real authed browser (blob-download + secure-context clipboard; `toJsonRows`
unit-proven).** **A dedicated real-browser + live-model eval fire remains the highest-value out-of-loop step.**

**NEXT slice: the live-model eval RUN (dedicated prod fire) — OR "save SQL result as a grid view" / a performance copilot.**
The in-loop export/copy/schema-builder surfaces are now broad + mature; the highest-value remaining work is increasingly
prod/AI-side. Candidates: (a) **Live-model eval RUN** (standing out-of-loop): real `@cf/meta/llama-3.3-70b` over the
golden `{question,intent}` fixtures on prod; score question→intent QUALITY; record a `PROMPT_VERSION` baseline. FIRST
verify the worker `/ask` route is live on prod (the loop has been editor-only since #52; a worker deploy needs Docker +
~14min CI). (b) **Performance copilot — actionable EXPLAIN**: the SQL console already runs EXPLAIN QUERY PLAN +
`explainPlanHint`; make the hint actionable — when the plan shows a full-table SCAN, offer a one-click "Add index on
<table>" that opens the index manager (#57–58) pre-scoped. Ties EXPLAIN → the index builder; needs the scanned-table
parse + the cross-table open (moderate). (c) **`field-types.ts` semantic layer** (needs the per-column metadata-config
arc) + per-customer D1 discovery (slice 1, unlocks ALTER-existing/Rename). Recommend (a) as the next dedicated
real-browser/prod fire — it closes the Ask arc's last unmeasured link; (b) is the best remaining in-loop editor slice.

### ✅ Shipped next fire (2026-09-26 #62) — SCOPE CUT (Brian directive): Data tab = Tables + SQL + KV only; removed D1/R2/Vectors/Queues tabs
**Brian, 2026-09-26:** "SQL and Tables look good… remove all the other non-used tabs like D1, R2, Vectors, Queues and their
related code" + "it doesn't seem like you built out KV yet." Root cause of the KV confusion: KV **is** built (`KvBrowser.tsx`,
596 lines — full browse/prefix/edit/TTL) but was **buried** among 7 tabs; and the whole surface is super-admin-gated (see
`editor-data-tab-features-are-superadmin-gated-and-deep-lazy-verify-in-browser` memory). Refocused the Data tab to its
actual mission (authorized **D1 + KV**), removing the account-wide resource browsers that were scope-creep.
- **Removed (editor side, this fire):** the `d1`, `r2`, `vec`, `queues` tabs from `MODE_META` + the tab-bar array + the
  `mode` union + the 4 render branches in `DataPanel.tsx`; deleted the components + their pure-logic + specs —
  `D1Browser.tsx` (1257 lines — a real resource-discovery/schema/SQL-dump-export surface; git-recoverable if wanted back),
  `R2Browser`+`r2-browser-logic`(+spec), `QueuesBrowser`+`queues-browser-logic`(+spec), `VectorizeBrowser`+
  `vectorize-browser-logic`(+spec), `d1-browser-logic`(+spec); removed their bridge message types (`PS_R2_*` `PS_VEC_*`
  `PS_QUEUE_*` `PS_D1_*` + interfaces) from `embedded-mode.ts` (carefully preserving `SavedGridView`/`SavedGridViewLayout`,
  which had been interleaved in the deleted range and are used by the KEPT View messages).
- **KV is now 1 of 3 tabs (Tables · SQL · KV)** → discoverable. No KV code change needed (it was already complete).
- Verified: editor Vitest **934/934** (32→28 files as the 4 deleted specs' ~79 tests go with them) + tsc 0 + eslint 0 +
  build 0. Editor-only (CF Pages ~2min). **Verify-by-hash on deploy:** confirm `data-mode-kv` present + `data-mode-d1`/
  `-r2`/`-vec`/`-queues` ABSENT in the live chunk.
- **DEFERRED to the next (worker/frontend) fire — "their related code" on the platform side:** the admin
  `bolt-embed.service.ts` `PS_D1_/PS_R2_/PS_VEC_/PS_QUEUE_` handlers + proxy fields, and the worker feature-modules
  `libs/features/{d1_inspector?,r2_inspector,vectorize_inspector,queues_inspector}/` (+ their routes in `index.ts` +
  feature-flag registry entries). These are now DEAD (the editor no longer sends those messages) but harmless; removing
  them needs the ~14min worker/frontend CI + the `validate:features` drift gate, so it's its own fire.

**NEXT slice: remove the platform-side D1/R2/Vectors/Queues dead code (worker + admin) — completes Brian's "remove their
related code."** Delete the admin `bolt-embed.service.ts` handlers/fields for `PS_D1_/PS_R2_/PS_VEC_/PS_QUEUE_`; delete the
worker `libs/features/{r2_inspector,vectorize_inspector,queues_inspector}` + any `d1_inspector` module + unregister their
routes/flags; keep `kv_inspector` + the D1 SQL/table routes (`site_detail_tabs.ts`). Worker `tsc`+`jest` + `validate:features`
+ frontend `tsc`; deploy `--env production` + prod-verify. (Then the standing live-model eval RUN + the owner-visibility
work — much of Tables/KV value is owner-relevant, currently super-admin-gated.)
