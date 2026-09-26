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

**NEXT slice (per delivery order): the AND/OR filter-group builder** (fuller slice-3 — multiple conditions, not one
column). The single-column operators just shipped are the deliberate stepping-stone: the builder needs a validated
filter-TREE worker endpoint that compiles a typed AND/OR tree of `{col, op, val}` leaves (REUSING this fire's
`FILTER_OPS` + `buildColumnFilter` clause logic) to parameterized SQL under the same `spec.columns` allowlist; scope
the worker side deliberately. OR wire `field-types.ts` richer INPUT widgets (single-select needs a field-config
metadata store; a date INPUT could reuse the ISO presentation + the new `null`/`notnull` ops). Then the grid eval
(RevoGrid vs Tabulator, license-checked) + **saved grid views** — the first slice needing the isolated
ProjectSites.dev metadata store (views/filters/sort/field-config live there, NEVER in customer tables; a good moment
to design that store: an `editor_grid_views` D1 table in the PLATFORM db + org-gated CRUD + a bridge msg).
