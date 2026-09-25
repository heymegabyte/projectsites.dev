# Editor Data Section — Capability Matrix (implementation checklist)

> Honest source of truth for the "Data" section epic (Editor workbench + admin).
> **Never present an unsupported operation as a working feature.** Every row's
> status is one of: **DONE** (shipped + verified), **SLICE** (in-flight this arc),
> **PLANNED** (feasible, not started), **BLOCKED** (platform can't do it today).
> Started 2026-09-23 from a 3-agent discovery pass. Update as slices land.
>
> **⭐ GOVERNING DECISION (ADR-0036, 2026-09-25) — the Data loop's current frontier:**
> the Data section manages exactly TWO per-site resources — **D1 + KV** (each site its OWN,
> isolated; KV backed by a `_kv` table inside the per-site D1). **Vectorize / Queues /
> Workflows / R2 are REMOVED from Data.** R2 mounts into the bolt.diy editor file tree. The
> loop's job now: (0) remove V/Q/W/R2 → (1) per-site D1+KV provisioning + isolation → (2)
> fully-featured D1 SQLite editor → (3) fully-featured KV manager. See
> `docs/decisions/0036-per-site-d1-kv-isolation.md` + Slice order below.

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
- **TARGET (ADR-0036):** each site gets its OWN isolated **D1** + **KV** (KV = a `_kv`
  table inside the per-site D1; the native KV-namespace cap is 1,000/account, so a
  namespace-per-site does NOT scale). The Data editor targets the SITE's own store; the
  shared-platform-D1 console stays super-admin-only + OFF the owner surface. Isolation is
  the WfP binding boundary (a tenant Worker sees only its own D1), NOT `WHERE site_id`.
- **WfP** (`USER_DISPATCH` dispatch namespace) is **wired but DORMANT** (`wfp_dispatch.ts`
  uploads a user Worker via the CF REST API + metadata bindings). Per-site D1/KV
  provisioning (Slice 1) is the PREREQUISITE — no tenant code runs until a site's Worker
  can be bound to ONLY its own D1 (never the shared platform DB).
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
| **Schema introspection** (tables/views/triggers · columns/pk/indexes/FKs/DDL) | `sqlite_master` (type IN table/view/trigger) + `PRAGMA table_info/index_list/index_info/foreign_key_list` | superadmin | ✅ DONE — endpoint `GET /api/sites/:siteId/sql/schema` **+ Schema-tab UI** (`SiteSchemaBrowserComponent`, `/admin/sites/:id?tab=schema`, 10 Karma specs): searchable object list (type badge for view/trigger) → columns (type/nullable/default/**PK badge + composite-key order**) · indexes · FKs · copyable CREATE SQL. **Triggers added** — each shows the table it fires on + its CREATE SQL (no columns/indexes/FKs → a note replaces the empty grid); views were already enumerated. **Composite-PK order (this fire)** — a multi-column PK now shows each column's 1-based key POSITION (PK 1 / PK 2) + a "Primary key · (col1, col2) composite" summary (8 platform tables use composite keys); the endpoint already returned the position (`table_info.pk`), the UI had collapsed it to a boolean. Now a complete SQLite schema tree (tables + views + indexes + triggers, composite keys ordered) matching DB Browser / Beekeeper / SQLiteStudio. | PRAGMA args can't bind → enumerate from `sqlite_master`, format-check each identifier; triggers skip the 3 useless PRAGMAs. Not surfaced (0 in the platform D1 → invisible): generated columns, WITHOUT ROWID. +2 Karma (composite-PK order + single-PK stays plain) |
| Read SQL console | `.prepare().all()` | superadmin | ✅ DONE — Run executes the whole editor OR, when text is highlighted, **just the selected statement** (epic's selection / current-statement execution; the Run label flips to "Run selection"). EXPLAIN respects the selection too; typing/recall drops a stale selection. | 8 000-char cap; SELECT/EXPLAIN/WITH/PRAGMA only; **syntax highlighting / schema-aware completion / multi-tab still pending** — need a code-editor lib (CodeMirror 6), a dependency decision |
| **Bind parameters (`?N` positional)** | `.prepare(q).bind(...params).all()` over a Zod-validated `params[]` | superadmin | ✅ **DONE (this fire)** — the read console now takes **positional bind params**: a "Bind params" JSON-array input (`["vitos", 42]`) binds to `?1`, `?2`, … so an operator filters by a VALUE without concatenating it into SQL (the epic's "parameterize values, never concatenate" as a first-class UI feature). Values are BOUND server-side (`.bind()` only when present; booleans → 0/1 since SQLite has no native bool; ≤50; Zod-typed union of string/number/bool/null); the audit logs only the param **count**, never the values (sensitive-filter redaction). Client guards each block the POST with an inline reason (never a doomed request): invalid-JSON · >50 · **params-but-no-`?`-placeholder**; starters clear stale binds. EXPLAIN honors params too. +5 Jest (bind + boolean→0/1 + no-bind-when-empty + >50-reject + count-only-audit) + 6 Karma (sends `{query,params}` / omits when blank / invalid-JSON-no-POST / no-`?`-guard / >50-guard / starter-clears). Live: worker `e7a61055`, frontend chunk `chunk-BXXDK73H.js` 200 with the `sql-params` + guard markers. | positional `?N` only (SQLite named `:name`/`@name` not exposed); a JSON body can't carry a real BLOB bind (values are string/number/bool/null) |
| **Saved queries + reusable snippets + history recall** | client-side (localStorage `ps_sql_saved_<siteId>`) | superadmin | ✅ DONE — name + Save the current query for one-click reuse (per-site, dedup-by-name, delete); built-in `sqlStarters` chips; query history is clickable-to-recall (loads into editor, no auto-run) | per-site + private-mode-safe; recall loads (never auto-runs) so the user reviews before running; multi-tab (concurrent buffers) still pending |
| **SQL result export (Copy JSON · Download CSV · Download JSON)** | client-side over the fetched result | superadmin | ✅ DONE — Copy JSON (existing) + **Download CSV + Download JSON** buttons on the result grid, over the shared `toCsv`/`downloadText` (formula-injection-safe `csvEscape`). Exports the FULL result set (every returned row, not just the 200-row render cap). | bounded by the query's own result size (the backend caps the query); no streaming needed at this scale |
| Write SQL console | `.prepare().run()` | superadmin | DONE | PROTECTED_TABLES + destructive-confirm; single-statement |
| **Row delete (own rows, PK-stable, allowlisted)** | `DELETE /api/sites/:siteId/data-overview/:table/:rowId` → parameterized `DELETE … WHERE id = ? AND site_id = ?` | owner | ✅ **DONE (this fire)** — the owner can permanently delete their OWN rows from a DELETABLE table (currently **Form Submissions** — deleting spam/test leads). `DELETABLE_OVERVIEW_TABLES` (a `key→real-table` map) is the allowlist boundary AND the killswitch; `form_submissions` browse now SELECTs a stable `id` (kept out of the display columns). Full safety chain: org auth (401) → `ownsSiteData` tenant gate (404, never 403) → allowlist resolves a trusted literal table name (a hostile `:table` never reaches SQL, 400) → parameterized double-scope `WHERE id=? AND site_id=?` → `meta.changes===0` → 404 (never a silent success) → audit-logged (`site_data.row_deleted`). UI: a danger-styled **Delete row** button in the row-detail bar (only for a deletable table + a stable-`id` row) → `ConfirmService` dialog showing the exact parameterized statement → refreshes grid + Overview counts. +11 Jest (5 route: 401/404-tenant/400-readonly/400-hostile/200-parameterized/404-no-match + 6 helper: allowlist boundary) + 6 Karma (button-visibility deletable-only · read-only-hidden · confirm+call+toast+refresh · cancel-noop · readonly/no-id-noop · error-toast). Prod-verified live (non-destructive): 401 · 400 read-only · 404 no-match · 404 tenant-isolation. | HARD delete (`form_submissions` has no `deleted_at`) → explicit confirm required; only `form_submissions` is deletable (others read-only) |
| **Bulk delete (multi-row select, own rows)** | `POST /api/sites/:siteId/data-overview/:table/bulk-delete` `{ids[]}` → parameterized `DELETE … WHERE id IN (?,…) AND site_id = ?` | owner | ✅ **DONE (this fire)** — grid row checkboxes + a select-all-on-page header check (deletable tables only) + a bulk bar ("N selected · Delete selected · Clear") → `ConfirmService` shows the count + the exact statement → one batched delete (clearing spam/test leads at once). Same safety chain as the single delete PLUS: ids deduped + validated (non-empty strings) + **capped at 100** (400 over-cap), every id a BOUND `?` in the `IN (…)` list (never interpolated), double-scoped by site, and an **honest `{requested, deleted, skipped}`** report (ids matching no row for this site are skipped, not errors). Audit-logged (`site_data.rows_bulk_deleted`, added to the activity-trail filter). Selection CLEARS on every re-fetch (page/table/filter/sort) so a stale id can never be deleted. +11 Jest (401 · tenant-404 · readonly-400 · hostile-400 · empty-400 · invalid-400 · over-cap-400 · parameterized-IN-200 · dedupe · partial) + 6 Karma (bulk call+toast · deletable-only checkboxes · select-all id-only · cancel-noop · clear-on-refetch · partial toast). Prod-verified live (non-destructive): 401 · 400 read-only · 400 empty · 200 `{requested:1,deleted:0,skipped:1}` via a nonexistent id · 404 foreign site. | HARD delete (no `deleted_at`); ≤100/batch; only `form_submissions` deletable |
| **Row edit (allowlisted typed column)** | `PATCH /api/sites/:siteId/data-overview/:table/:rowId` → parameterized `UPDATE … SET "col" = ? WHERE id = ? AND site_id = ?` | owner | ✅ **DONE (this fire)** — the owner can edit an allowlisted, typed column of their OWN row. First column: **`form_submissions.status`** (an enum — retriage a lead received→forwarded). `EDITABLE_OVERVIEW_COLUMNS` (a per-table `{column → {type,options}}` map) is the boundary + killswitch: only a SAFE, constraint-bounded column is exposed (never PII like email/payload, never a structural column). Safety chain mirrors delete: auth (401) → `ownsSiteData` (404) → `editableTableName` (read-only table → 400) → `editableColumn` (non-editable/hostile column → 400, never reaches SQL) → `validateEditableValue` (out-of-enum → 400, never written) → parameterized double-scope `WHERE id=? AND site_id=?` → `meta.changes===0` → 404 → audit (`site_data.row_updated`). UI: an enum `<select>` + **Save** in the row-detail (only for editable tables/columns), Save-enabled only when changed, `ConfirmService` shows the exact UPDATE, reverts the draft on cancel. **Reversible** (unlike delete). +12 Jest (7 route: 401/tenant-404/readonly-400/column-400/enum-400/parameterized-200/no-match-404 + 5 helper: editable allowlist + enum validation) + 7 Karma. Prod-verified live (non-destructive): 401 · 400×3 (table/column/value) · 404 no-match · 404 tenant. | enum-typed only today (mirrors the D1 CHECK); NULL/number/bool/JSON editors + INSERT (add-row) are the next slice on this same allowlist |
| **Activity (data-mutation audit trail)** | `GET /api/sites/:siteId/data-activity` → `audit_logs` filtered to `site_data.*` + `json_extract($.site_id)` | owner | ✅ **DONE (this fire)** — answers the epic's "Activity and observability" pillar: a collapsible **"Recent activity"** panel in the Data browser lists the owner's OWN row deletes + edits (actor + safe human summary + table + relative timestamp via the Cycle-29 `compactAge`), newest first. Read-only, org+site-scoped (`ownsSiteData` + `json_extract($.site_id)`), action-allowlisted so app traffic never leaks in; the raw audit `metadata_json` (which may carry a column value) is NEVER returned (only `message`/table/actor/time). Refreshes after each delete/edit; hidden when empty (honest). Distinct path (`/data-activity`, NOT `/data-overview/activity` — the latter is shadowed by the `/data-overview/:table` browse route). +4 Jest (401/404-tenant/mapped-shape+scoped-query/fail-soft-empty) + 3 Karma (panel renders · hidden-when-empty · loads-on-init+refreshes-after-delete). Prod-verified live: 401 · 404 tenant · 200 honest-empty (no mutations for this site). | shows only THIS Data browser's mutations (delete/edit); not app traffic or general audit events |
| CSV export (bounded) | client-side | owner/superadmin | DONE | filtered rows only |
| EXPLAIN QUERY PLAN + index hints | `EXPLAIN QUERY PLAN` via `/sql/exec` | superadmin | ✅ DONE — "Explain" button shows the plan (`detail` per step) + an **index hint** (flags a bare full-table `SCAN` / `USE TEMP B-TREE` sort → "add an index"; ✓ when the plan is index-covered) | EXPLAIN plans but never EXECUTES — safe for any query the editor holds |
| Query cost (rows read/written, D1 duration) + **expensive-scan warning** | D1 `meta` | superadmin | ✅ DONE — `/sql/exec` returns `rows_read/rows_written/d1_duration_ms` AND the SQL console now **displays** "read N · wrote N · D1 Xms" + a ⚠ **expensive-scan warning** above 10k rows read ("add an index") | null (never a fabricated 0) when the runtime omits meta; shown only for a reported value |
| CSV / JSON row import (preview, conflict) | batched INSERT | owner | PLANNED | 100 KB SQL cap → chunk ≤500 rows/call |
| SQL import / export (full DB) | `POST /d1/database/{id}/{import,export}` (async, ETag poll) | superadmin | PLANNED | export = **SQL text dump, NOT a .sqlite file**; needs D1 REST creds |
| Time Travel (bookmark + restore) | `wrangler d1 time-travel` / REST | superadmin | PLANNED | retention **30 d paid / 7 d free**; ≤10 restores/10 min |
| **Migration status (applied ledger)** | `GET /api/sites/:id/sql/migrations` → `SELECT name, applied_at FROM d1_migrations ORDER BY id DESC` | superadmin | ✅ **DONE (this fire)** — an "Applied migrations" panel in the Schema tab (`SiteSchemaBrowserComponent`) lists the wrangler-managed `d1_migrations` ledger (name + applied_at, newest first, ≤500). Full auth chain: 401 unauth → **403 non-super-admin (ledger never read)** → 404 site-not-in-org (`dbQueryOne`) → read → audit (`site.sql.migrations`). Honest: `d1_migrations` absent → `available:false` (never a fake "0 migrations"); a 403/network failure fails soft to "ledger not available", never an error card. +5 Jest (401/403-no-read/404/list+audit/absent→available:false) + 3 Karma (renders newest-first / honest-unavailable / 403→unavailable). Prod-verified live+gated: 401 · 403 (E2E key) · endpoint 200-path locked by Jest. | Applied ledger only. **Drift / pending NOT offered** — the migration FILES aren't present in the running Worker, so applied-vs-pending can't be computed without lying; the UI states this. DB size / usage need D1 REST creds. |

### D1 platform facts (verified 2026)
- Query REST `POST /accounts/{acct}/d1/database/{id}/query` (+ `/raw`, batch via array);
  `meta` returns `duration, rows_read, rows_written, last_row_id, changes, size_after`.
- Limits: **100 KB** max SQL, **100** bound params, **2 MB** max row, **10 GB** DB (paid) / 500 MB (free).
- SQLite gaps in D1: **no** explicit `BEGIN/COMMIT/ROLLBACK`, `SAVEPOINT`, `ATTACH DATABASE`,
  loadable extensions; FKs **default OFF**. Supported PRAGMAs incl. table_info/table_list/
  index_list/index_info/foreign_key_list/quick_check/foreign_key_check.

## Resources in the "Data" section — DECIDED (ADR-0036, 2026-09-25)

**The Data section manages exactly TWO per-site resources: D1 and KV.** Everything else is
removed from Data.

| Resource | In "Data"? | Disposition |
|---|---|---|
| **D1** (per-site) | ✅ YES — first-class | Full SQLite editor — requirements below |
| **KV** (per-site, `_kv`-in-D1) | ✅ YES — first-class | Full KV manager — requirements below |
| **R2** | ❌ REMOVED | The whole bucket **mounts into the bolt.diy editor file tree** — files, not a data browser |
| **Vectorize** | ❌ REMOVED | Not a tenant store; only a dormant platform-internal use (`RAG_INDEX`/site-DNA). If ever offered → a WfP-Functions binding, never Data |
| **Queues** | ❌ REMOVED | Compute, not data → mediated Feature / WfP-Functions |
| **Workflows** | ❌ REMOVED | Compute, not data → mediated Feature / WfP-Functions (≠ the platform's own `SITE_WORKFLOW`) |
| **Hyperdrive · Durable Objects** | ❌ out of scope | Not Data-section resources |

The V/Q/W/R2 mockup was archived to `docs/mockups/_archived/`. Removal is Slice 0 below.

## D1 SQLite editor — full requirements (the "fully decked-out" target)

Targets the SITE's OWN per-site D1 (never the shared platform DB). Best-in-class SQLite
editor — DB Browser / Beekeeper / Outerbase parity:

- **Table browser** — tables/views/indexes/triggers · live row counts · per-table recent-activity. ✅ *(retarget to per-site)*
- **Row grid** — server-paginated · sortable · text search · per-column exact filter · column show/hide · click-to-copy · row-detail JSON · filtered CSV/JSON export. ✅ *(retarget to per-site)*
- **Row CRUD (full)** — add row (INSERT) · edit ANY typed cell (text / number / bool / null / JSON / date — not just enums) · delete · bulk delete · inline validation + confirm + undo where possible. ⟳ *(today: enum-only edit + `form_submissions` delete)*
- **Schema editor** — create / alter / drop table · add / drop / rename column · create / drop index · manage FKs — via UI + DDL. PLANNED
- **SQL console (full)** — SELECT/DDL/DML · run-selection · positional bind params · saved queries · history recall · EXPLAIN QUERY PLAN + index hints · query cost + expensive-scan warning · plain-language errors · **multi-tab buffers** · **CodeMirror 6 syntax highlighting + schema-aware autocomplete**. ⟳ *(most ✅; multi-tab + CodeMirror pending — a dep decision)*
- **Import / export** — CSV/JSON import (chunked · preview · conflict) · full SQL-dump export · **D1 Time Travel (bookmark / restore)** · applied-migrations ledger. PLANNED *(needs per-site D1 REST token)*
- **Isolation** — it's the tenant's OWN DB, so no cross-tenant PROTECTED_TABLES denylist is needed; still protect platform-reserved tables (`_kv`, `d1_migrations`) + confirm destructive ops.

## KV manager — full requirements (fully-featured target)

Targets the site's KV (the `_kv` table in its per-site D1). Best-in-class KV browser:

- **Key browser** — list keys with prefix filter + search · paginated · value preview + metadata + TTL/expiration per key · prefix-as-folder tree.
- **Value viewer / editor** — view/edit value (text · JSON pretty-print · binary/base64) · edit metadata · set/clear TTL.
- **CRUD** — put (create/update) · delete · bulk delete · bulk import (JSON/CSV of key→value [+metadata +ttl]) · export (JSON/CSV).
- **Affordances** — click-to-copy key/value · honest counts · loading / empty / error states · confirm on destructive.
- **Isolation** — scoped to the site's own `_kv`; a tenant Worker binds only its own store.

### Resource categorization + provenance (Brian, 2026-09-25)

- **These six rows are a 2026-09-23 discovery-pass INVENTORY of "what CF resources
  COULD be surfaced," NOT a committed product decision.** No ADR, no flag, no rendered
  tab — only D1 ships. Do not treat the inventory as agreed scope.
- **Data ≠ Compute — only stores the OWNER browses belong in "Data":**
  - **DATA (belongs here):** D1 (live) · **R2 / Media-Files** (per-org TODAY,
    `media/{orgId}/…` + full `/api/media/*` — the #1 real near-term add, needs no WfP) ·
    **Snapshots** (frozen build versions) · KV (once per-site KV exists).
  - **COMPUTE / plumbing (does NOT belong in Data → the Functions tab):** Queues +
    Workflows (in-flight messages / running processes, not stored data) · Durable Objects
    (RPC-only) · Hyperdrive (a connection, not a store).
- **Vectorize** is a real store but per-site vectors are speculative for our small-biz
  output → gate behind an AI-features flag, never default Data. It's already a platform
  binding (`RAG_INDEX`) accessed FROM a Worker; "doing vectors in a Worker" still means
  this binding (or a worse brute-force-in-D1 fallback — D1 has no vector index).
- **Workflows/Queues are NOT alternatives to Workers** — they're Workers-platform
  primitives (we already run `SITE_WORKFLOW`). Bind them; don't reimplement durability in
  a Durable Object + alarms.
- **Exposing compute to tenants — two models (WfP CAN bind Queues/Workflows per-tenant with
  full isolation; verified against CF docs 2026-09-25):**
  - **(1) Shared-infra Features (DEFAULT — scales to 1M):** WE run one shared Queue + a
    handful of `WorkflowEntrypoint` definitions on OUR account, tagged by `site_id`; the owner
    controls the *automation* (background job / scheduled task / event trigger), never the raw
    binding. Fits the account caps (few definitions + millions of sleeping instances).
  - **(2) Raw per-tenant bindings (WfP Functions / code-deploy tier ONLY):** a tenant that
    deploys its own `functions/` Worker binds its OWN Queue producer + `WorkflowEntrypoint`
    class, isolated (user Workers accept KV/R2/D1/DO/Queues/Workflows/Hyperdrive/AE bindings via
    the upload metadata array). **Gated by account caps: 10,000 queues + 500 workflow
    *definitions* (= Worker scripts) per account** → ~hundreds–10k code-deploy customers per WfP
    account, NOT 1M; shard across dispatch namespaces/accounts beyond that.
  - **Why dormant today:** a Workflow is a class IN the tenant's Worker and a Queue consumer IS
    a Worker — both need the customer running code. Our static-site output has no running Worker,
    so there is nowhere to host either until WfP Functions ships.

## Slice order (execution — reframed by ADR-0036, 2026-09-25)

> The DONE history in the D1 checklist above (owner browse / search / filter / export /
> delete / edit / activity + superadmin schema / SQL-console / EXPLAIN / cost / migrations)
> is RETAINED and STILL VALID — it re-targets from the shared DB to the per-site D1 in
> Slice 2. The old slices 1–4 are complete; the frontier is now Slices 0–4 below.

- **Slice 0 — Remove V/Q/W/R2 from Data.** Delete the Vectorize/Queues/Workflows/R2 PLANNED
  status (done in the DECIDED table above); remove the dormant Vectorize footprint
  (`RAG_INDEX` binding, `site_dna` vector calls, `service-registry` entry, `rag.ts`/AutoRAG
  doc drift). R2 → a bolt.diy editor file-tree mount (a separate editor slice).
- **Slice 1 — Per-site D1 + KV provisioning + isolation (PREREQUISITE, ADR-0036).**
  `provisionSiteResources(siteId)` (CF D1 REST create + base migration incl. `_kv`), persist
  the D1 id/name on the `sites` row, wire the isolated binding into the WfP upload metadata
  (ONLY that site's D1). Flag `per_site_data`, default-off. Gate: no tenant code until a
  Worker provably cannot read another site's DB.
- **Slice 2 — Fully-featured D1 SQLite editor** against the per-site D1 (requirements
  above): retarget existing browse/SQL to the site's own DB → full typed CRUD → schema
  editor → multi-tab + CodeMirror 6 → chunked import/export → Time Travel.
- **Slice 3 — Fully-featured KV manager** against the per-site `_kv` (requirements above):
  key browser + value/metadata/TTL editor + CRUD + bulk import/export.
- **Slice 4 — Backfill** existing shared-D1 rows (`site_data`/`form_submissions`/
  `visitor_events`, scoped by `site_id`) → each site's new per-site DB. One-way; run with
  D1 Time Travel as the safety net.

## Decided / still-needs-a-credential
- **Per-site D1 + KV: DECIDED** (ADR-0036) — one isolated per-site D1, KV backed by its
  `_kv` table. Supersedes the old "shared DB only" state. Provisioning (Slice 1) is the
  build; the shared DB + owner row-scoping remain the honest CURRENT state until it lands.
- **Still needs a scoped CF D1 REST token** (server-side, never the browser) for per-site
  D1 provisioning + import/export + Time Travel — the Slice-1 credential blocker.
