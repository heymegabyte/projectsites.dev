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
| **Owner Data-tab UI** (table picker · server-paginated sortable grid · row-detail JSON · **whole-table CSV/JSON export (paged, ≤5k)** · **read-only pill** · loading/empty/error states) | `SiteDataBrowserComponent` + `utils/csv-export` → `/data-overview[/:table]` | owner | ✅ DONE — `/admin/sites/:id?tab=data`, focused standalone component, 19 Karma specs + 10 csv-export specs | read-only (PKs deliberately not in the projection → not editable; explained via the pill); REAL endpoints only (no mock); export pages the whole table to a **5,000-row cap** (honest capped note); true streaming/async export for >5k = future slice |
| **Schema introspection** (columns/pk/indexes/FKs/DDL) | `PRAGMA table_info/index_list/index_info/foreign_key_list` | superadmin | ✅ DONE — endpoint `GET /api/sites/:siteId/sql/schema` **+ Schema-tab UI** (`SiteSchemaBrowserComponent`, `/admin/sites/:id?tab=schema`, 7 Karma specs): searchable table list → columns (type/nullable/default/**PK badge**) · indexes · FKs · copyable CREATE SQL | PRAGMA args can't bind → enumerate from `sqlite_master`, format-check each identifier; the endpoint was **built-but-unwired** until this UI landed |
| Read SQL console | `.prepare().all()` | superadmin | DONE | 8 000-char cap; SELECT/EXPLAIN/WITH/PRAGMA only |
| Write SQL console | `.prepare().run()` | superadmin | DONE | PROTECTED_TABLES + destructive-confirm; single-statement |
| Row edit / delete (typed, PK-stable) | parameterized UPDATE/DELETE | owner | PLANNED | needs schema PK (this arc's schema endpoint) |
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
2. Row edit/delete with schema-derived stable PK predicates (owner). **N/A for the
   data-overview grid** — its 5 tables are read-only system/analytics data whose safe-column
   allowlist deliberately OMITS the `id` (no stable PK to target; `verify-against-source-of-truth`
   + PII-safety). The only owner-editable data (`site_data` CMS rows) has its OWN CRUD endpoints
   (`PUT/DELETE /data/:table/:rowId`) and is edited in the site editor, not a raw grid. So the grid
   correctly stays read-only + says so (the pill). A future write surface would target `site_data` only.
3. SQL console upgrades — **query-cost + expensive-scan warning ✅ DONE; EXPLAIN QUERY PLAN + index
   guidance ✅ DONE; plain-language SQLite/D1 error explanations ✅ DONE** (`explainSqlError` maps no-such-
   table/column/function · syntax · unrecognized-token · UNIQUE/FK-constraint · too-complex → a friendly
   line, with the RAW error always retained below for debugging; unknown error → raw only, never hidden).
   Multi-tab + saved queries remain (history already present).
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
