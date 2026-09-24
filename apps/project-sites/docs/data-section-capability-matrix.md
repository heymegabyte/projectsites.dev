# Editor Data Section — Capability Matrix (implementation checklist)

> Honest source of truth for the "Data" section epic (Editor workbench + admin).
> **Never present an unsupported operation as a working feature.** Every row's
> status is one of: **DONE** (shipped + verified), **SLICE** (in-flight this arc),
> **PLANNED** (feasible, not started), **BLOCKED** (platform can't do it today).
> Started 2026-09-23 from a 3-agent discovery pass. Update as slices land.

## Architecture reality (READ FIRST — do not skip)

- **One shared multi-tenant platform D1** (`env.DB`). There are **NO per-site D1
  databases** today. A site's data lives as **rows in shared tables** scoped by
  `site_id` / `org_id`. So "multiple D1 databases per site" from the brief is a
  future infra capability, not current state — do not render it as existing.
- **Two authorization surfaces:**
  - **Owner** — org-scoped `GET/PUT/DELETE /api/sites/:siteId/data[/:table[/:rowId]]`
    (`libs/features/site_data_api/handlers.ts`). IDOR guard: `sites WHERE id=? AND
    org_id=?` (404, not 403). Per-table **column allowlist** (email masked). This is
    the tenant-safe surface — an owner sees ONLY their site's rows.
  - **Superadmin** — raw SQL console `POST /api/sites/:siteId/sql/{exec,exec-write}`
    (`src/routes/site_detail_tabs.ts`). `isSuperAdmin(env,userId)` gate because it
    targets the SHARED DB. Read: regex allowlist SELECT/EXPLAIN/WITH/PRAGMA. Write:
    `PROTECTED_TABLES` denylist (users/orgs/sessions/billing/… + `sqlite_*` +
    `d1_migrations`) + destructive-confirm (`needs_confirm`) + audit log.
- **Editor DataPanel** (`app/components/workbench/DataPanel.tsx` + pure
  `data-panel-logic.ts`, Vitest-covered) talks to the Worker THROUGH the admin
  bridge (`PS_DATA_REQUEST` / `PS_SQL_REQUEST` postMessage). UnoCSS + bolt tokens.
- **WfP** (`USER_DISPATCH` dispatch namespace) is **wired but DORMANT** — flag
  `user_worker_functions` default-off, zero per-site User Workers deployed,
  `resolveUserFunctionBindings` not implemented. "User Worker bindings" browsing is
  BLOCKED until per-site Workers + real D1/KV/R2 provisioning exist.
- **Consolidation note:** the admin `site-detail.component.ts` SQL tab and the bolt
  DataPanel are intentionally different (power-user vs embedded editor), NOT drift.

## D1 — feature checklist

| Feature | CF API / binding | Permission | Status | Limitation |
|---|---|---|---|---|
| Table list + row counts | `sqlite_master` + `COUNT(*)` | owner (allowlist) / superadmin | DONE | counts are live per request |
| Browse table rows | allowlist SELECT | owner | DONE | server-paginated; owner **Data-tab UI** now surfaces it |
| **Server-side pagination** (`limit≤100/offset/orderBy/dir`) | SELECT … LIMIT/OFFSET + COUNT | owner | ✅ DONE — additive `total/limit/offset` on `/data-overview/:table` | orderBy validated against the column allowlist; unknown col keeps default sort (no injection) |
| **Owner Data-tab UI** (table picker · server-paginated sortable grid · **text search** · row-detail JSON · **whole-table CSV/JSON export (paged, ≤5k)** · **read-only pill** · loading/empty/error states) | `SiteDataBrowserComponent` + `utils/csv-export` → `/data-overview[/:table]` | owner | ✅ DONE — `/admin/sites/:id?tab=data`, focused standalone component | read-only (PKs deliberately not in the projection → not editable; explained via the pill); REAL endpoints only (no mock); export pages the whole table to a **5,000-row cap** (honest capped note); true streaming/async export for >5k = future slice |
| **Server-side text search** (grid filter) | `?search=` → `buildDataSearch` (parameterized `LIKE` over the non-timestamp safe columns) | owner | ✅ DONE (this fire) — search box on the grid; server filters BOTH the browse + count queries so `total` reflects the match; LIKE wildcards STRIPPED from user input; bounded 100 chars; resets to page 1; cleared on table switch | searches the safe-column allowlist only (same injection boundary as orderBy); prod-verified (unfiltered 1886 → `/` 1686 → no-match 0) |
| **Per-column exact filter** (grid `col = value`) | `?filterCol=&filterVal=` → `buildColumnFilter` (parameterized `AND "col" = ?`, column allowlist-validated) | owner | ✅ DONE (this fire) — a column dropdown + value input add a precise server-side `= ?` over the browse + count queries (so `total` reflects the filter), complementing the OR-of-LIKE search; resets to page 1, cleared on table switch, value gated on a chosen column. The column MUST be in the safe allowlist (same injection boundary as orderBy/search); the value is a bound param (never concatenated), bounded 200 chars. +4 Jest (`buildColumnFilter`: exact clause / allowlist-reject incl. `;DROP` + quoted / empty cases / param-not-interpolated + 200-char bound) + 4 Karma (apply sends params + resets · clear · cleared-on-switch · value-gated-on-column) → 1991 Karma / 12270 Jest. Prod-verified: unfiltered 27 → `event_type=pageview` 15 → no-match 0 → **non-allowlist column IGNORED (27, no injection)**. | read-only; exact-match only (search covers substring); tenant scope unchanged (`ownsSiteData` → `WHERE site_id = ?`) |
| **Overview summary** (table count · total records · largest table) | client-side computed from the `/data-overview` per-table `row_count` | owner | ✅ DONE — an at-a-glance strip above the table picker: "N tables · M records · largest: <table> (K)", derived from the already-fetched row counts (no extra request). Null (hidden) until tables load so it never flashes a misleading "0 records"; `aria-live` polite. Partial answer to the epic's "database metadata / table count" Overview — D1 size/usage/limits still need the D1 REST API (blocked, no token). | honest sum of real per-table counts; no fabricated size/usage |
| **Recent activity (per-table freshness)** | server `SELECT MAX(<ts>) AS ts` per table (`lastActivitySql`, same ts column + soft-delete filter as browse) → `last_activity` on the overview response | owner | ✅ **DONE (this fire)** — answers the epic's Overview "recent activity" ask: each table chip shows a compact relative age ("just now"/"5m"/"3h"/"2d"/"3w"/"5mo"/"1y") from the table's most-recent row, so an owner sees at a glance "is my contact form still getting leads?". Timestamps are UTC `YYYY-MM-DD HH:MM:SS` (no zone) → `compactAge`/`fullTimestamp` normalize to UTC before diffing (never a local-tz-shifted delta); the exact instant is in the chip `title`. Honest: an empty table's `MAX` is null → NO chip (never a fabricated "0"/"now"). +5 Jest (1 spec-shape invariant + 4 route: 401/404-tenant/returns-last_activity/null-when-empty) + 4 Karma (chip present-vs-null · compactAge buckets+UTC-parse · empty→"" · fullTimestamp). Prod-verified live REAL data: visitor_events 37 rows→'2026-09-24 12:54:02', empty tables→null. | freshness only (MAX of the ts column); no per-table size/usage (D1 REST blocked) |
| **Filter-aware export** (CSV/JSON of the FILTERED view) | client-side paged fetch → the same `/data-overview/:table?search=&filterCol=&filterVal=` | owner | ✅ DONE (this fire) — the CSV/JSON export now threads the ACTIVE search + per-column filter into its paged fetches, so the file is the WHOLE MATCHING set (not the whole table when a filter is on); `total` = the filtered count so the ≤5k cap + honest capped note ("N matching rows") are correct; filtered files are named `-filtered`; the export button title/aria say "filtered rows" vs "whole table" honestly. +2 Karma (export threads search+filterCol+filterVal · `filterActive()`). No new endpoint (reuses the prod-verified browse filter). | read-only; still bounded to the 5,000-row client cap; a filter matching 0 rows disables Export (`total()===0`) |
| **Column show/hide** (grid column selection, per-table) | client-side view state (localStorage `ps_datacols_hidden_<siteId>_<table>`) | owner | ✅ DONE (this fire) — a "Columns" disclosure in the Data-tab toolbar toggles which columns the grid renders (wide tables no longer force horizontal scroll); per-(site,table) persisted + private-mode-safe; **refuses to hide the LAST visible column** (no dead-end empty grid); the row-detail JSON + CSV/JSON exports STILL include EVERY column, so hiding is a view-only scan aid that never omits data. +7 Karma specs (default-all / hide-keeps-`columns()` / header-renders-visible-only / show-all / last-column-guard / persistence / per-table isolation) → 1974 total. | view-only — the authoritative `columns()` set (detail + export) is untouched; the picker only renders when a table has >1 column |
| **Copy affordances** (cell click-to-copy + row JSON) | client-side (`navigator.clipboard`) | owner | ✅ DONE (this fire) — every non-null grid cell is a click-to-copy `<button>` (grab a lead's email/value instantly); the row-detail panel has a "Copy JSON" action; a polite `aria-live` "✓ Copied …" flash confirms each copy (~1.8s, token-guarded). Read-only, frontend-only; `writeClipboard` isolated for spy-testing. +5 Karma specs (string copy + flash / object→JSON / row JSON / cell-button click / aria-live). | read-only — no mutation, no worker/endpoint change; clipboard write fail-soft (blocked context → no-op) |
| **Schema introspection** (columns/pk/indexes/FKs/DDL) | `PRAGMA table_info/index_list/index_info/foreign_key_list` | superadmin | ✅ DONE — endpoint `GET /api/sites/:siteId/sql/schema` **+ Schema-tab UI** (`SiteSchemaBrowserComponent`, `/admin/sites/:id?tab=schema`, 7 Karma specs): searchable table list → columns (type/nullable/default/**PK badge**) · indexes · FKs · copyable CREATE SQL | PRAGMA args can't bind → enumerate from `sqlite_master`, format-check each identifier; the endpoint was **built-but-unwired** until this UI landed |
| Read SQL console | `.prepare().all()` | superadmin | DONE | 8 000-char cap; SELECT/EXPLAIN/WITH/PRAGMA only |
| **Saved queries + reusable snippets + history recall** | client-side (localStorage `ps_sql_saved_<siteId>`) | superadmin | ✅ DONE — name + Save the current query for one-click reuse (per-site, dedup-by-name, delete); built-in `sqlStarters` chips; query history is clickable-to-recall (loads into editor, no auto-run) | per-site + private-mode-safe; recall loads (never auto-runs) so the user reviews before running; multi-tab (concurrent buffers) still pending |
| **SQL result export (Copy JSON · Download CSV · Download JSON)** | client-side over the fetched result | superadmin | ✅ DONE — Copy JSON (existing) + **Download CSV + Download JSON** buttons on the result grid, over the shared `toCsv`/`downloadText` (formula-injection-safe `csvEscape`). Exports the FULL result set (every returned row, not just the 200-row render cap). | bounded by the query's own result size (the backend caps the query); no streaming needed at this scale |
| Write SQL console | `.prepare().run()` | superadmin | DONE | PROTECTED_TABLES + destructive-confirm; single-statement |
| **Row delete (own rows, PK-stable, allowlisted)** | `DELETE /api/sites/:siteId/data-overview/:table/:rowId` → parameterized `DELETE … WHERE id = ? AND site_id = ?` | owner | ✅ **DONE (this fire)** — the owner can permanently delete their OWN rows from a DELETABLE table (currently **Form Submissions** — deleting spam/test leads). `DELETABLE_OVERVIEW_TABLES` (a `key→real-table` map) is the allowlist boundary AND the killswitch; `form_submissions` browse now SELECTs a stable `id` (kept out of the display columns). Full safety chain: org auth (401) → `ownsSiteData` tenant gate (404, never 403) → allowlist resolves a trusted literal table name (a hostile `:table` never reaches SQL, 400) → parameterized double-scope `WHERE id=? AND site_id=?` → `meta.changes===0` → 404 (never a silent success) → audit-logged (`site_data.row_deleted`). UI: a danger-styled **Delete row** button in the row-detail bar (only for a deletable table + a stable-`id` row) → `ConfirmService` dialog showing the exact parameterized statement → refreshes grid + Overview counts. +11 Jest (5 route: 401/404-tenant/400-readonly/400-hostile/200-parameterized/404-no-match + 6 helper: allowlist boundary) + 6 Karma (button-visibility deletable-only · read-only-hidden · confirm+call+toast+refresh · cancel-noop · readonly/no-id-noop · error-toast). Prod-verified live (non-destructive): 401 · 400 read-only · 404 no-match · 404 tenant-isolation. | HARD delete (`form_submissions` has no `deleted_at`) → explicit confirm required; only `form_submissions` is deletable (others read-only) |
| **Row edit (allowlisted typed column)** | `PATCH /api/sites/:siteId/data-overview/:table/:rowId` → parameterized `UPDATE … SET "col" = ? WHERE id = ? AND site_id = ?` | owner | ✅ **DONE (this fire)** — the owner can edit an allowlisted, typed column of their OWN row. First column: **`form_submissions.status`** (an enum — retriage a lead received→forwarded). `EDITABLE_OVERVIEW_COLUMNS` (a per-table `{column → {type,options}}` map) is the boundary + killswitch: only a SAFE, constraint-bounded column is exposed (never PII like email/payload, never a structural column). Safety chain mirrors delete: auth (401) → `ownsSiteData` (404) → `editableTableName` (read-only table → 400) → `editableColumn` (non-editable/hostile column → 400, never reaches SQL) → `validateEditableValue` (out-of-enum → 400, never written) → parameterized double-scope `WHERE id=? AND site_id=?` → `meta.changes===0` → 404 → audit (`site_data.row_updated`). UI: an enum `<select>` + **Save** in the row-detail (only for editable tables/columns), Save-enabled only when changed, `ConfirmService` shows the exact UPDATE, reverts the draft on cancel. **Reversible** (unlike delete). +12 Jest (7 route: 401/tenant-404/readonly-400/column-400/enum-400/parameterized-200/no-match-404 + 5 helper: editable allowlist + enum validation) + 7 Karma. Prod-verified live (non-destructive): 401 · 400×3 (table/column/value) · 404 no-match · 404 tenant. | enum-typed only today (mirrors the D1 CHECK); NULL/number/bool/JSON editors + INSERT (add-row) are the next slice on this same allowlist |
| **Activity (data-mutation audit trail)** | `GET /api/sites/:siteId/data-activity` → `audit_logs` filtered to `site_data.*` + `json_extract($.site_id)` | owner | ✅ **DONE (this fire)** — answers the epic's "Activity and observability" pillar: a collapsible **"Recent activity"** panel in the Data browser lists the owner's OWN row deletes + edits (actor + safe human summary + table + relative timestamp via the Cycle-29 `compactAge`), newest first. Read-only, org+site-scoped (`ownsSiteData` + `json_extract($.site_id)`), action-allowlisted so app traffic never leaks in; the raw audit `metadata_json` (which may carry a column value) is NEVER returned (only `message`/table/actor/time). Refreshes after each delete/edit; hidden when empty (honest). Distinct path (`/data-activity`, NOT `/data-overview/activity` — the latter is shadowed by the `/data-overview/:table` browse route). +4 Jest (401/404-tenant/mapped-shape+scoped-query/fail-soft-empty) + 3 Karma (panel renders · hidden-when-empty · loads-on-init+refreshes-after-delete). Prod-verified live: 401 · 404 tenant · 200 honest-empty (no mutations for this site). | shows only THIS Data browser's mutations (delete/edit); not app traffic or general audit events |
| CSV export (bounded) | client-side | owner/superadmin | DONE | filtered rows only |
| EXPLAIN QUERY PLAN + index hints | `EXPLAIN QUERY PLAN` via `/sql/exec` | superadmin | ✅ DONE — "Explain" button shows the plan (`detail` per step) + an **index hint** (flags a bare full-table `SCAN` / `USE TEMP B-TREE` sort → "add an index"; ✓ when the plan is index-covered) | EXPLAIN plans but never EXECUTES — safe for any query the editor holds |
| Query cost (rows read/written, D1 duration) + **expensive-scan warning** | D1 `meta` | superadmin | ✅ DONE — `/sql/exec` returns `rows_read/rows_written/d1_duration_ms` AND the SQL console now **displays** "read N · wrote N · D1 Xms" + a ⚠ **expensive-scan warning** above 10k rows read ("add an index") | null (never a fabricated 0) when the runtime omits meta; shown only for a reported value |
| CSV / JSON row import (preview, conflict) | batched INSERT | owner | PLANNED | 100 KB SQL cap → chunk ≤500 rows/call |
| SQL import / export (full DB) | `POST /d1/database/{id}/{import,export}` (async, ETag poll) | superadmin | PLANNED | export = **SQL text dump, NOT a .sqlite file**; needs D1 REST creds |
| Time Travel (bookmark + restore) | `wrangler d1 time-travel` / REST | superadmin | PLANNED | retention **30 d paid / 7 d free**; ≤10 restores/10 min |
| Migration status / drift | repo migrations + `d1_migrations` | superadmin | PLANNED | avoid prod schema edits a deploy would overwrite |

### D1 platform facts (verified 2026)
- Query REST `POST /accounts/{acct}/d1/database/{id}/query` (+ `/raw`, batch via array);
  `meta` returns `duration, rows_read, rows_written, last_row_id, changes, size_after`.
- Limits: **100 KB** max SQL, **100** bound params, **2 MB** max row, **10 GB** DB (paid) / 500 MB (free).
- SQLite gaps in D1: **no** explicit `BEGIN/COMMIT/ROLLBACK`, `SAVEPOINT`, `ATTACH DATABASE`,
  loadable extensions; FKs **default OFF**. Supported PRAGMAs incl. table_info/table_list/
  index_list/index_info/foreign_key_list/quick_check/foreign_key_check.

## Other resources — honest status

| Resource | Inspect/manage via | Status | Hard limitation |
|---|---|---|---|
| **KV** | binding `list/get/put/delete` + REST keys | PLANNED | eventual consistency; bulk ≤100 keys |
| **R2** | binding `list/get/put/delete` (+ S3) | PLANNED | no public REST *query*; binding-only; multipart for large objects |
| **Vectorize** | binding `insert/query/deleteByIds/listVectors` + v2 REST | PLANNED | query is binding-only; mutations async (1–2 s) |
| **Hyperdrive** | REST config + health | PLANNED | **no** inspect/query API; browser only via an authorized DB connection path |
| **Durable Objects** | classes/bindings list | BLOCKED (data) | internal SQLite is **RPC-only**, NOT arbitrarily queryable via public API |
| **Queues** | REST pull/publish + binding | PLANNED | pull consumer needs explicit ack |

## Slice order (execution)
1. **Authorized discovery + safe browse** — schema introspection (superadmin) +
   owner-browse pagination. ✅ backend DONE; **owner UI shipped** — the `/admin/sites/:id`
   **Data tab** (`SiteDataBrowserComponent`): table picker with live row counts →
   server-paginated, column-sortable grid → per-row JSON detail, all on real endpoints.
   **Superadmin Schema tab shipped** — `SiteSchemaBrowserComponent` (searchable table list →
   columns/indexes/FKs/DDL), consuming the previously-unwired `/sql/schema` endpoint.
2. Row edit/delete with stable PK predicates (owner). **Row DELETE shipped for
   `form_submissions`** (this fire) — the owner's most common data-management need is deleting
   spam/test leads. The `form_submissions` browse now SELECTs a stable `id` (kept OUT of the
   display columns), and `DELETABLE_OVERVIEW_TABLES` gates which tables expose a delete (only
   `form_submissions` today; the other 4 overview tables — visitor_events/snapshots/mcp/site_data —
   stay READ-ONLY, they're system/analytics data or have their own lifecycle). The delete is
   allowlist-bounded + tenant-gated + parameterized `WHERE id=? AND site_id=?` + affected-rows-checked
   + audit-logged + confirmed in the UI (HARD delete — `form_submissions` has no `deleted_at`).
   **Row EDIT shipped for `form_submissions.status`** (this fire) — an allowlisted enum column
   (`EDITABLE_OVERVIEW_COLUMNS`), edited via a typed `<select>` + confirm + `PATCH`, server-validated
   against the enum + double-scoped by site + audited (`site_data.row_updated`). Reversible.
   **Next: broaden the typed editors** — NULL/number/bool/JSON cell editors + INSERT (add-row) on
   the same allowlist + stable-id plumbing (only enum-typed columns are editable today).
3. SQL console upgrades — **query-cost + expensive-scan warning ✅ DONE; EXPLAIN QUERY PLAN + index
   guidance ✅ DONE; plain-language SQLite/D1 error explanations ✅ DONE** (`explainSqlError` maps no-such-
   table/column/function · syntax · unrecognized-token · UNIQUE/FK-constraint · too-complex → a friendly
   line, with the RAW error always retained below for debugging; unknown error → raw only, never hidden).
   **Saved queries + reusable reuse ✅ DONE (this fire)** — user-named, per-site-persisted saved queries
   (`ps_sql_saved_<siteId>`, dedup-by-name, load-to-review + delete), the built-in `sqlStarters` chips, and
   **query history is now clickable-to-recall** (loads into the editor without auto-running). Multi-tab
   (multiple concurrent editor buffers) is the only remaining SQL-workspace item.
4. Import (CSV/JSON, chunked) + bounded exports. **Whole-table CSV/JSON export ✅ DONE**
   (owner grid, paged to a 5k cap via `utils/csv-export`, honest capped note); chunked import +
   true streaming/async export for >5k rows remain.
5. D1 REST import/export + Time Travel (needs a scoped D1 REST token — see below).
6. Resource adapters (KV, R2, Vectorize, …) behind a shared authz/audit/UI base.

## Needs a decision / credential (surface, don't fake)
- **Per-site D1 provisioning** (the "multiple D1 per site" vision) needs a CF D1 REST
  token + a WfP binding-management pipeline — infra not present. Until then, the Data
  section manages the shared platform DB (superadmin) + per-site rows (owner).
- D1 **import/export + Time Travel** REST calls need a least-privilege D1 token stored
  server-side (never in the browser).
