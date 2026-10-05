/**
 * Embedded mode detection and postMessage bridge for bolt.diy.
 *
 * When bolt.diy is loaded inside an iframe on projectsites.dev,
 * this module handles communication between the parent (Angular admin)
 * and the child (bolt.diy React app) via postMessage.
 *
 * @module embed/embedded-mode
 */

import type { DirectoryNode, FileSystemTree } from '@webcontainer/api';

// ── Types ────────────────────────────────────────────────────

/** Parent → Child messages */
export interface SubmitPromptMessage {
  type: 'PS_SUBMIT_PROMPT';
  prompt: string;
  siteId: string;
  slug: string;
  correlationId: string;
}

export interface ImportFilesMessage {
  type: 'PS_IMPORT_FILES';
  files: Record<string, string>; // path → content (text only)
  siteId: string;
  slug: string;
  correlationId: string;
}

export interface RequestFilesMessage {
  type: 'PS_REQUEST_FILES';
  includeChat?: boolean;
  correlationId: string;
}

export interface LoadBuildContextMessage {
  type: 'PS_LOAD_BUILD_CONTEXT';
  contextUrl: string;
  siteId: string;
  slug: string;
  correlationId: string;
}

/** Child → Parent messages */
export interface BoltReadyMessage {
  type: 'PS_BOLT_READY';
}

export interface FilesReadyMessage {
  type: 'PS_FILES_READY';
  files: Record<string, string>;
  chat?: { messages: unknown[]; description?: string; exportDate: string };
  correlationId: string;
}

export interface GenerationStatusMessage {
  type: 'PS_GENERATION_STATUS';
  status: 'idle' | 'generating' | 'complete' | 'error';
  error?: string;
  correlationId: string;
}

/**
 * Editor runtime error — relayed to admin so it can write to `audit_logs`
 * with `action: 'editor.runtime_error'` (item 46). Sourced from
 * `window.onerror`, `window.onunhandledrejection`, and WebContainer error
 * events. Used by the admin's `BoltEmbedService` → `POST /api/audit-logs/editor-error`.
 */
export interface PSErrorMessage {
  type: 'PS_ERROR';
  code: string;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  requestId: string;
}

/**
 * Funnel-event relay — admin already has PostHog loaded with the right
 * project keys + tenant context. bolt.diy postMessages the event name +
 * props, admin's `TelemetryService.capture()` fires it (item 48).
 */
export interface PSTelemetryMessage {
  type: 'PS_TELEMETRY';
  event: string;
  props?: Record<string, unknown>;
}

/**
 * Toast bridge — surfaces "Editor recovered" + similar admin-facing
 * messages after auto-recovery (item 47). Also used bi-directionally by
 * item 44 so admin-side toasts mirror inside the editor and vice-versa.
 * `kind` is the canonical field; `level` is kept as an alias for the
 * original Phase-2 emitters.
 */
export interface PSToastMessage {
  type: 'PS_TOAST';
  kind?: 'info' | 'success' | 'warning' | 'error';
  level?: 'info' | 'success' | 'warning' | 'error';
  message: string;
  correlationId?: string;
}

/**
 * Parent → Child (item 41): rebase the workbench to a snapshot. The child
 * resolves the snapshot's chat-export from the existing `by-slug/chat`
 * endpoint and runs the import-chat flow to load that revision's files.
 */
export interface OpenSnapshotMessage {
  type: 'PS_OPEN_SNAPSHOT';
  snapshot_id: string;
  slug?: string;
  correlationId: string;
}

/**
 * Parent → Child (item 42): jump to a specific file + optional 1-based line.
 * Used by the admin's "Open IDE" deep-links and Cmd+K palette file results.
 */
export interface OpenFileMessage {
  type: 'PS_OPEN_FILE';
  file: string;
  line?: number;
  correlationId: string;
}

/** Parent → Child (item 45): enumerate every text file in the workbench. */
export interface ListFilesMessage {
  type: 'PS_LIST_FILES';
  correlationId: string;
}

/**
 * Child → Parent (item 45): response to `PS_LIST_FILES`. Paths are
 * workbench-relative; size is the UTF-8 byte length of the text content.
 */
export interface FilesListMessage {
  type: 'PS_FILES_LIST';
  correlationId: string;
  files: { path: string; size: number }[];
}

/**
 * Child → Parent (item 43): replaces bolt.diy's standalone deploy flow.
 * Admin runs the actual deploy via its own site-deploy API so deploys land
 * in the same audit log as everything else.
 */
export interface DeployRequestMessage {
  type: 'PS_DEPLOY_REQUEST';
  files: Record<string, string>;
  chat?: { messages: unknown[]; description?: string; exportDate: string };
  correlationId: string;
}

/**
 * Child → Parent (AL-004 Data tab): ask the admin to read the site's REAL data
 * via `/api/sites/:id/data-overview[/:table]`. The embedded editor has no
 * cross-origin session, so the admin (which holds `selectedSite` + the bearer)
 * makes the authed call and replies with {@link DataResponseMessage}. Omit
 * `table` for the table-list overview; set it to browse one table's recent rows.
 */
export interface DataRequestMessage {
  type: 'PS_DATA_REQUEST';
  table?: string;

  /** 0-based row offset for the paginated browse grid (default 0). Ignored for the table overview. */
  offset?: number;

  /** Page size for the paginated browse grid (the worker clamps to 1–100; default 25). */
  limit?: number;

  /**
   * Server-side sort column for the browse grid. The worker ONLY honours it when it's in the table's
   * column allowlist (else it keeps the default sort) — so this is a display request, never trusted
   * as SQL. Omit for the table's default order.
   */
  orderBy?: string;

  /** Server-side sort direction for {@link orderBy} (default `desc`). */
  dir?: 'asc' | 'desc';

  /**
   * MULTI-column server sort as `col:dir,col2:dir2` (priority order) — takes precedence over the single
   * {@link orderBy}/{@link dir}. Each column is worker allowlist-validated (display request, never trusted
   * as SQL); bounded to a few keys. Sent by the browse grid + export. Omit for the default order.
   */
  sort?: string;

  /**
   * Whole-table search needle. The worker runs a parameterized OR-of-LIKE over the table's allowlisted
   * columns and reflects the match count in `total` — so this searches the WHOLE table, not just the
   * loaded page. Omit / empty → no search.
   */
  search?: string;

  /**
   * Filter column (a table column). The worker allowlist-validates it (else no filter) and applies the
   * filter per {@link filterOp}. Composes with {@link search} + sort.
   */
  filterCol?: string;

  /** Value for {@link filterCol} (parameterized by the worker). Ignored for the `null`/`notnull` ops. */
  filterVal?: string;

  /**
   * Comparison operator for {@link filterCol}: `eq | ne | contains | gt | lt | gte | lte | null |
   * notnull`. The worker maps it to a FIXED, parameterized clause (never user text) and defaults an
   * absent/unknown op to `eq`. `null`/`notnull` filter on the column alone (no {@link filterVal}).
   */
  filterOp?: string;

  /**
   * A multi-condition filter group as a JSON array of `{col,op,val}`. When present it takes precedence
   * over the single {@link filterCol}/{@link filterOp}/{@link filterVal}. The worker shape-hardens +
   * re-validates every leaf against the table's column allowlist, bounds the count, and joins the
   * conditions by {@link filterCombinator}. Composes with {@link search} + sort.
   */
  filters?: string;

  /** How to join the {@link filters} conditions — `AND` | `OR` (worker default `AND`). */
  filterCombinator?: string;

  /**
   * Export the WHOLE current query (search + filters + sort) instead of one page — routes to the
   * `/data-overview/:table/export` endpoint (bounded to the server cap). The response `data` carries all
   * matching rows + `truncated`. Ignores {@link offset}/{@link limit}/{@link count}.
   */
  exportAll?: boolean;

  /**
   * Kanban whole-query lane counts: when set (an allowlisted column), routes to
   * `/data-overview/:table/group-counts` and the response `data` carries `groups: [{value,count}]` over
   * the SAME filtered set (search + filters apply; pagination ignored). Lane totals are honest
   * (whole-table); the CARDS remain the current page. Omit for a normal browse.
   */
  groupBy?: string;

  /**
   * Chart measure aggregate (paired with {@link groupBy}): when both `measure` (an allowlisted numeric
   * column) and `agg` (`sum`|`avg`|`min`|`max`) are set, group-counts ALSO returns each group's
   * `aggregate` so a bar can be "SUM(amount) by status", not just row counts. Omit for COUNT (kanban +
   * count-mode charts). The worker re-validates the column against the allowlist + the agg whitelist.
   */
  measure?: string;
  agg?: string;

  /**
   * Whole-query column summaries: a comma-separated list of allowlisted columns → routes to
   * `/data-overview/:table/column-aggregates`, and the response `data.aggregates` carries `{ col: {count,
   * filled, sum, avg, min, max} }` over the SAME filtered set (search + filters apply). Powers the grid
   * footer's "· all" (whole-table) summaries vs the page-only fallback. Omit for a normal browse.
   */
  columnsAgg?: string;

  /**
   * Bounded DISTINCT values of ONE allowlisted column → routes to `/data-overview/:table/column-distinct`
   * (`?column=`), and the response carries `distinctValues: string[]` + `truncated`. Powers the cell
   * editor's "pick an existing value" datalist (a select-like hint). Omit for a normal browse.
   */
  columnDistinct?: string;

  /**
   * `0` = skip the server COUNT(*) (paging/sorting doesn't change the total, so the client reuses its
   * cached total — avoids an expensive exact count on every nav). Omitted / `1` = the worker counts
   * (table open, search/filter change, post-mutation). Then `total` on the response is `null`.
   */
  count?: number;
  correlationId: string;
}

/** One row of the data-overview table list. */
export interface DataOverviewTable {
  key: string;
  label: string;
  description: string;
  columns: string[];
  row_count: number;
  browsable: boolean;
}

/**
 * Parent → Child (AL-004 Data tab): the admin's reply to {@link DataRequestMessage}.
 * `data` mirrors the worker's `data` envelope — `{ tables }` for the overview,
 * `{ table, columns, rows }` for a browse. `error` is set when the authed call
 * failed (no site selected, network, 4xx).
 */
export interface DataResponseMessage {
  type: 'PS_DATA_RESPONSE';
  correlationId?: string;
  table?: string;
  data?: {
    tables?: DataOverviewTable[];
    table?: string;
    columns?: string[];
    rows?: Record<string, unknown>[];

    /**
     * True when the signed-in admin is a platform super-admin → the D1 manager unlocks the
     * read-only SQL console (arbitrary SELECT/PRAGMA over the site's D1 via {@link SqlRequestMessage}).
     * A normal site owner gets `false` → the curated, org-scoped table browser only (the raw
     * console reads the shared multi-tenant DB, so it MUST stay super-admin-gated — AL-792).
     */
    canRunSql?: boolean;

    /**
     * `true` when a bounded result was sliced to the server cap: EXPORT (rows > row cap) OR kanban
     * group-counts (distinct groups > group cap). The editor labels the partial result honestly.
     */
    truncated?: boolean;

    /** Export only: the server row cap ({@link MAX_EXPORT_ROWS}), for an honest "first N rows" message. */
    cap?: number;

    /**
     * group-counts only: whole-query lane/bar totals for `groupBy`. Each group carries `count` always,
     * plus a numeric `aggregate` (SUM/AVG/MIN/MAX of the measure column; null when all-NULL) when a
     * chart measure+agg was requested. Ordered by the aggregate (desc) when aggregating, else by count.
     */
    groups?: Array<{ value: unknown; count: number; aggregate?: number | null }>;

    /** group-counts only: the column the {@link groups} were grouped by. */
    groupBy?: string;

    /** group-counts only (aggregate mode): the echoed measure column + aggregate function, for honest labels. */
    measure?: string;
    agg?: string;

    /**
     * column-aggregates only: whole-query per-column stats for the grid footer, keyed by column —
     * `{ col: { count, filled, sum, avg, min, max } }` over the current filtered set (not just the page).
     */
    aggregates?: Record<
      string,
      { count: number; filled: number; sum: number | null; avg: number | null; min: number | null; max: number | null }
    >;

    /**
     * column-distinct only: bounded distinct values of {@link distinctColumn} (the column's whole value
     * domain, non-null/non-empty, ordered). With {@link truncated} true the column is high-cardinality —
     * the editor offers NO suggestions (it's a free-text column, not a select). Powers the value datalist.
     */
    distinctValues?: string[];

    /** column-distinct only: the column the {@link distinctValues} belong to. */
    distinctColumn?: string;
  } | null;

  /**
   * Browse only: the worker's total row count for the CURRENT query (reflects any `search`/filter), so
   * the grid pages through the matches + shows an honest "N of <total>". `null` when the count was
   * SKIPPED (a `count=0` page-nav/sort request) → the client keeps its cached total. Absent for the
   * table overview.
   */
  total?: number | null;
  error?: string;
}

/**
 * Child → Parent (D1 manager): ask the admin to run ONE SQL statement against the site's D1.
 * READS (default, `write` unset) go to `POST /api/sites/:id/sql/exec` (SELECT/EXPLAIN/WITH/PRAGMA
 * allowlist); WRITES (`write:true`) go to `POST /api/sites/:id/sql/exec-write`
 * (CREATE/DROP/ALTER TABLE + INSERT/UPDATE/DELETE/REPLACE). BOTH are super-admin-gated (the shared
 * multi-tenant DB — AL-792), so a non-super-admin gets a 403 surfaced as {@link SqlResponseMessage.error}.
 * The write path refuses to touch platform tables (denylist) and rejects destructive statements
 * (DROP/ALTER, or DELETE/UPDATE without WHERE) unless `confirm:true` — the editor's type-to-confirm.
 * Outerbase-Studio-inspired: table list from `sqlite_master`, schema via `PRAGMA table_info`,
 * create/drop table, row CRUD, and free-form queries — all through this one bridge message.
 */
export interface SqlRequestMessage {
  type: 'PS_SQL_REQUEST';
  query: string;
  correlationId: string;

  /** When true, route to the WRITE endpoint (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE). Default: read. */
  write?: boolean;

  /** Required `true` for destructive writes (DROP/ALTER, unscoped DELETE/UPDATE) — the type-to-confirm. */
  confirm?: boolean;

  /**
   * Positional bind params for `?1, ?2, …` — the worker BINDS these (never concatenates), so the
   * grid's typed row editors (Add/Edit/Delete) send a parameterized statement instead of
   * stringifying user values into SQL.
   */
  params?: Array<string | number | boolean | null>;
}

/** Parent → Child: the admin's reply to {@link SqlRequestMessage} (mirrors the sql/exec[-write] envelope). */
export interface SqlResponseMessage {
  type: 'PS_SQL_RESPONSE';
  correlationId?: string;
  ok?: boolean;

  /** Read results. */
  columns?: string[];
  rows?: Record<string, unknown>[];

  /** Write results. */
  rows_affected?: number;
  last_row_id?: number | null;

  /**
   * D1 query-cost meta (from `/sql/exec`): rows the query READ (the scan cost D1 bills +
   * that drives latency) and rows it WROTE. `null` when the runtime omits them — shown as
   * "—", never a fabricated 0. A large `rows_read` drives the expensive-scan warning.
   */
  rows_read?: number | null;
  rows_written?: number | null;

  /** Set when the server refused a destructive write pending `confirm:true` — the UI prompts. */
  needs_confirm?: boolean;
  duration_ms?: number;
  error?: string;
}

/**
 * Child → Parent (AI SQL assistant): a natural-language question the admin
 * forwards to `POST /sites/:id/sql/nl2sql`. The worker grounds the model on the
 * REAL server-fetched schema and returns SQL for the user to REVIEW — it is NOT
 * executed. Super-admin gated server-side (mirrors the SQL console).
 */
export interface Nl2SqlRequestMessage {
  type: 'PS_NL2SQL_REQUEST';
  question: string;
  correlationId: string;
}

/** Parent → Child: the admin's reply to {@link Nl2SqlRequestMessage}. */
export interface Nl2SqlResponseMessage {
  type: 'PS_NL2SQL_RESPONSE';
  correlationId?: string;
  ok?: boolean;

  /** The generated SQL — dropped into the editor for review, never auto-run. */
  sql?: string;

  /** The model that produced it (raw id; the UI shows a friendly label). */
  model?: string;
  error?: string;
}

/**
 * Child → Parent (grounded "Ask your data"): a natural-language question about ONE overview table the
 * admin forwards to `POST /sites/:id/data-overview/:table/ask`. The worker asks a model for a TYPED
 * INTENT (never SQL), re-validates it with the server-side compiler, EXECUTES the parameterized query,
 * and returns the computed rows + the AI's intent + the exact SQL (falsifiable). OWNER-gated
 * (ownsSiteData). Distinct from {@link Nl2SqlRequestMessage} (super-admin "draft SQL", NOT executed).
 */
export interface AskRequestMessage {
  type: 'PS_ASK_REQUEST';
  table: string;
  question: string;
  correlationId: string;
}

/** The AI's proposed query intent (editor mirror of the worker's `QueryIntent` — for display only). */
export interface AskQueryIntent {
  select: Array<{ col?: string; agg?: string }>;
  filters?: Array<{ col: string; op: string; val: string }>;
  combinator?: string;
  groupBy?: string;
  orderBy?: Array<{ col?: string; dir?: string }>;
  limit?: number;
}

/** Parent → Child: the admin's reply to {@link AskRequestMessage} (mirrors the worker `/ask` envelope). */
export interface AskResponseMessage {
  type: 'PS_ASK_RESPONSE';
  correlationId?: string;
  ok?: boolean;
  data?: {
    question: string;
    intent: AskQueryIntent;
    sql: string;
    rows: Record<string, unknown>[];
    rowsRead: number | null;
  };
  error?: string;
}

// ── Per-site D1 bridge messages ────────────────────────────────────────────────

/**
 * Child → Parent (per-site D1 Tables surface): list the tables in the site's OWN dedicated
 * Cloudflare D1 (blank at first, lazily provisioned) — NEVER the shared platform DB and NEVER
 * another site's. The embedded editor has no cross-origin session, so the admin (which holds
 * `selectedSite` + the bearer) calls `GET /api/sites/:siteId/db/tables` and replies with
 * {@link SiteDbTablesResponseMessage}. Gated server-side by the `per_site_data` flag (DARK → 404).
 */
export interface SiteDbTablesRequestMessage {
  type: 'PS_SITEDB_TABLES_REQUEST';
  correlationId: string;
}

/**
 * Child → Parent (per-site D1 Tables surface): browse one table's rows. The admin calls
 * `GET /api/sites/:siteId/db/tables/:table?limit&offset` and replies with
 * {@link SiteDbRowsResponseMessage}. Reads the site's OWN dedicated D1 only.
 */
export interface SiteDbRowsRequestMessage {
  type: 'PS_SITEDB_ROWS_REQUEST';
  correlationId: string;
  table: string;

  /** Page size for the paginated browse grid (worker-clamped). */
  limit?: number;

  /** 0-based row offset for the paginated browse grid (default 0). */
  offset?: number;
}

/**
 * Parent → Child (per-site D1 Tables surface): the admin's reply to {@link SiteDbTablesRequestMessage}
 * (mirrors the worker's `data` envelope — `{ databaseId, provisioned, tables:[{name}] }`). `enabled`
 * is `false` when the `per_site_data` flag is dark (the 404 "Per-site data is not enabled"); `error`
 * carries any other failure (no site selected, network, 4xx).
 */
export interface SiteDbTablesResponseMessage {
  type: 'PS_SITEDB_TABLES_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The site's dedicated D1 database id (blank until first provisioned). */
  databaseId?: string;

  /** True once the site's D1 has been lazily provisioned. */
  provisioned?: boolean;

  /** The tables in the site's OWN D1 (empty on a blank, freshly-provisioned DB). */
  tables?: { name: string }[];

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Parent → Child (per-site D1 Tables surface): the admin's reply to {@link SiteDbRowsRequestMessage}
 * (mirrors the worker's `data` envelope — `{ table, columns:[{name,type,notnull,pk}], rows, limit,
 * offset, total }`). `error` is set when the authed call failed.
 */
export interface SiteDbRowsResponseMessage {
  type: 'PS_SITEDB_ROWS_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The table that was browsed. */
  table?: string;

  /** The table's schema from `PRAGMA table_info` — `notnull`/`pk` are 0/1 SQLite ints. */
  columns?: { name: string; type: string; notnull: number; pk: number }[];

  /** The page of rows. */
  rows?: Record<string, unknown>[];

  /** Echoed page size. */
  limit?: number;

  /** Echoed 0-based row offset. */
  offset?: number;

  /** Total row count for the table, so the grid pages through the matches. */
  total?: number;
  error?: string;
}

/**
 * Child → Parent (per-site D1 — inline row edit, Revision 1): update ONE cell of ONE row in a table in
 * the site's OWN dedicated D1, targeted by its stable SQLite `rowid` (the `_rowid` the browse surface
 * exposes). The admin (which holds `selectedSite` + the bearer) calls
 * `PATCH /api/sites/:siteId/db/tables/:table/rows/:rowid` with `{ values: { [column]: value } }` and
 * replies with {@link SiteDbUpdateRowResponseMessage}. This is the id that exists for EVERY ordinary row
 * even when the table declares NO primary key — so it kills the old "no primary key ⇒ read-only"
 * limitation. The value is bound server-side, never interpolated. Gated by the `per_site_data` flag
 * (DARK → 404 → `enabled:false`). Mirrors {@link SiteDbRenameColumnRequestMessage}.
 */
export interface SiteDbUpdateRowRequestMessage {
  type: 'PS_SITEDB_UPDATE_ROW_REQUEST';
  correlationId: string;

  /** The table holding the row (the worker re-validates the identifier server-side). */
  table: string;

  /** The stable SQLite `rowid` of the row to update (the `_rowid` the browse surface exposes). */
  rowid: number;

  /** The single column to write (the worker allowlist-validates it against the table's real columns). */
  column: string;

  /** The new value to bind — a SQLite scalar (`string | number | boolean | null`), never interpolated. */
  value: string | number | boolean | null;
}

/**
 * Parent → Child (per-site D1 — inline row edit): the admin's reply to {@link SiteDbUpdateRowRequestMessage}.
 * `ok:true` when the row was updated (`updated` = rows written). A real DDL/validation error rides in
 * `error` (surfaced verbatim). `enabled:false` when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbUpdateRowResponseMessage {
  type: 'PS_SITEDB_UPDATE_ROW_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** How many rows were written (1 on a successful single-row update; 0 if the rowid didn't match). */
  updated?: number;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (per-site D1 SQL console): run ONE raw SQL statement against the site's OWN dedicated
 * D1. The admin (which holds `selectedSite` + the bearer) calls `POST /api/sites/:siteId/db/query` with
 * `{ sql, params }` and replies with {@link SiteDbQueryResponseMessage}. The statement only ever touches
 * the owner's OWN isolated D1 (server-resolved id, shared-platform ids denylisted), so arbitrary SQL is
 * safe. Gated server-side by the `per_site_data` flag (DARK → 404 → `enabled:false`).
 */
export interface SiteDbQueryRequestMessage {
  type: 'PS_SITEDB_QUERY_REQUEST';
  correlationId: string;

  /** The single SQL statement to run against the site's OWN D1. */
  sql: string;

  /** Optional positional bind params (primitives only) — values are bound, never interpolated. */
  params?: (string | number | boolean | null)[];
}

/**
 * Parent → Child (per-site D1 SQL console): the admin's reply to {@link SiteDbQueryRequestMessage}
 * (mirrors the worker's `data` envelope — `{ rows, meta, rowCount, truncated }`). A real SQL error rides
 * in `error` (the worker returns it verbatim — seeing the real error IS the point of a console).
 * `enabled:false` when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbQueryResponseMessage {
  type: 'PS_SITEDB_QUERY_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The rows the statement returned (empty for a write / DDL); capped server-side (see `truncated`). */
  rows?: Record<string, unknown>[];

  /** The number of rows returned before any cap. */
  rowCount?: number;

  /** `true` when the result was capped server-side (the grid shows a "first N rows" note). */
  truncated?: boolean;

  /** D1 execution meta (`rows_read` / `rows_written` / `duration` / `changes` / `last_row_id`). */
  meta?: {
    rows_read?: number;
    rows_written?: number;
    duration?: number;
    changes?: number;
    last_row_id?: number;
  };

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the console stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (per-site D1 search): ADVANCED cross-table search. The admin calls
 * `POST /api/sites/:siteId/db/search` with `{ q, limit }` and replies with {@link SiteDbSearchResponseMessage}.
 * Searches table NAMES + table CONTENT (text columns) in the site's OWN D1.
 */
export interface SiteDbSearchRequestMessage {
  type: 'PS_SITEDB_SEARCH_REQUEST';
  correlationId: string;

  /** The search query string. */
  q: string;

  /** Optional cap on total content hits (default 50). */
  limit?: number;
}

/**
 * Parent → Child (per-site D1 search): reply to {@link SiteDbSearchRequestMessage} — table-name matches PLUS
 * in-content matches (table · column · stable rowid · surrounding snippet). `enabled:false` when the
 * `per_site_data` flag is dark.
 */
export interface SiteDbSearchResponseMessage {
  type: 'PS_SITEDB_SEARCH_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** Tables whose NAME contains the query. */
  nameMatches?: string[];

  /** Rows whose CONTENT matched — table + column + stable rowid + a surrounding snippet. */
  contentMatches?: { table: string; column: string; rowid: number; snippet: string }[];

  /** `true` when the content-match set was capped server-side. */
  truncated?: boolean;
  enabled?: boolean;
  error?: string;
}

/** One column in a {@link SiteDbCreateTableRequestMessage} — a name + a SQLite storage class. */
export interface SiteDbColumnSpec {
  /** Raw column name (letters/digits/underscore; the worker re-validates + quotes it). */
  name: string;

  /** SQLite storage class the manual builder offers — TEXT / INTEGER / REAL. */
  type: 'TEXT' | 'INTEGER' | 'REAL';
}

/**
 * Child → Parent (per-site D1 — create table): the admin `POST /api/sites/:siteId/db/tables` with
 * `{ name, columns }` and replies with {@link SiteDbCreateTableResponseMessage}. Creates a NEW table in the
 * site's OWN dedicated D1 (server-resolved id, shared-platform ids denylisted). Gated server-side by the
 * `per_site_data` flag (DARK → 404 → `enabled:false`). Mirrors {@link SiteDbQueryRequestMessage}.
 */
export interface SiteDbCreateTableRequestMessage {
  type: 'PS_SITEDB_CREATE_TABLE_REQUEST';
  correlationId: string;

  /** The new table's name (the worker validates it's a safe identifier + not already taken). */
  name: string;

  /** The ordered column list (at least one) — each a name + a TEXT/INTEGER/REAL type. */
  columns: SiteDbColumnSpec[];
}

/**
 * Parent → Child (per-site D1 — create table): the admin's reply to {@link SiteDbCreateTableRequestMessage}.
 * `ok:true` when the table was created. A real DDL/validation error rides in `error` (surfaced verbatim).
 * `enabled:false` when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbCreateTableResponseMessage {
  type: 'PS_SITEDB_CREATE_TABLE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The created table's name (echoed by the worker on success). */
  table?: string;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the control stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (per-site D1 — drop table): the admin `DELETE /api/sites/:siteId/db/tables/:table` and
 * replies with {@link SiteDbDropTableResponseMessage}. Drops the table from the site's OWN dedicated D1.
 * Gated server-side by the `per_site_data` flag (DARK → 404 → `enabled:false`). Mirrors
 * {@link SiteDbQueryRequestMessage}.
 */
export interface SiteDbDropTableRequestMessage {
  type: 'PS_SITEDB_DROP_TABLE_REQUEST';
  correlationId: string;

  /** The table to drop (the worker re-validates the identifier server-side). */
  table: string;
}

/**
 * Parent → Child (per-site D1 — drop table): the admin's reply to {@link SiteDbDropTableRequestMessage}.
 * `ok:true` when the table was dropped. A real error rides in `error` (surfaced verbatim). `enabled:false`
 * when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbDropTableResponseMessage {
  type: 'PS_SITEDB_DROP_TABLE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The dropped table's name (echoed by the worker on success). */
  table?: string;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the control stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (per-site D1 — add column): the admin `POST /api/sites/:siteId/db/tables/:table/columns`
 * with `{ name, type }` and replies with {@link SiteDbAddColumnResponseMessage}. Adds ONE nullable column to
 * a table in the site's OWN dedicated D1 (server-resolved id, shared-platform ids denylisted). Gated
 * server-side by the `per_site_data` flag (DARK → 404 → `enabled:false`). Mirrors
 * {@link SiteDbCreateTableRequestMessage}.
 */
export interface SiteDbAddColumnRequestMessage {
  type: 'PS_SITEDB_ADD_COLUMN_REQUEST';
  correlationId: string;

  /** The table to add the column to (the worker re-validates the identifier server-side). */
  table: string;

  /** The new column's name (the worker validates it's a safe identifier + not already taken). */
  name: string;

  /**
   * The new column's SQLite storage class — TEXT / INTEGER / REAL (the worker re-validates). Named
   * `columnType` (not `type`) so it never collides with the message-discriminant `type` above.
   */
  columnType: 'TEXT' | 'INTEGER' | 'REAL';
}

/**
 * Parent → Child (per-site D1 — add column): the admin's reply to {@link SiteDbAddColumnRequestMessage}.
 * `ok:true` when the column was added. A real DDL/validation error rides in `error` (surfaced verbatim).
 * `enabled:false` when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbAddColumnResponseMessage {
  type: 'PS_SITEDB_ADD_COLUMN_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The added column's name (echoed by the worker on success). */
  column?: string;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the control stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (per-site D1 — rename column): the admin `PATCH
 * /api/sites/:siteId/db/tables/:table/columns/:column` with `{ name }` and replies with
 * {@link SiteDbRenameColumnResponseMessage}. Renames ONE column in a table in the site's OWN dedicated D1.
 * Gated server-side by the `per_site_data` flag (DARK → 404 → `enabled:false`). Mirrors
 * {@link SiteDbCreateTableRequestMessage}.
 */
export interface SiteDbRenameColumnRequestMessage {
  type: 'PS_SITEDB_RENAME_COLUMN_REQUEST';
  correlationId: string;

  /** The table holding the column (the worker re-validates the identifier server-side). */
  table: string;

  /** The current column name to rename (the worker re-validates it exists). */
  column: string;

  /** The new column name (the worker validates it's a safe identifier + not already taken). */
  name: string;
}

/**
 * Parent → Child (per-site D1 — rename column): the admin's reply to
 * {@link SiteDbRenameColumnRequestMessage}. `ok:true` when the column was renamed. A real error rides in
 * `error` (surfaced verbatim). `enabled:false` when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbRenameColumnResponseMessage {
  type: 'PS_SITEDB_RENAME_COLUMN_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The new column name (echoed by the worker on success). */
  column?: string;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the control stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (per-site D1 — drop column): the admin `DELETE
 * /api/sites/:siteId/db/tables/:table/columns/:column` and replies with
 * {@link SiteDbDropColumnResponseMessage}. Drops ONE column from a table in the site's OWN dedicated D1.
 * Gated server-side by the `per_site_data` flag (DARK → 404 → `enabled:false`). Mirrors
 * {@link SiteDbDropTableRequestMessage}.
 */
export interface SiteDbDropColumnRequestMessage {
  type: 'PS_SITEDB_DROP_COLUMN_REQUEST';
  correlationId: string;

  /** The table holding the column (the worker re-validates the identifier server-side). */
  table: string;

  /** The column to drop (the worker re-validates the identifier server-side). */
  column: string;
}

/**
 * Parent → Child (per-site D1 — drop column): the admin's reply to {@link SiteDbDropColumnRequestMessage}.
 * `ok:true` when the column was dropped. A real error rides in `error` (surfaced verbatim). `enabled:false`
 * when the `per_site_data` flag is dark (the 404 "not enabled").
 */
export interface SiteDbDropColumnResponseMessage {
  type: 'PS_SITEDB_DROP_COLUMN_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The dropped column's name (echoed by the worker on success). */
  column?: string;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the control stays hidden. */
  enabled?: boolean;
  error?: string;
}

// ── Resource-overview bridge messages ──────────────────────────────────────────

/**
 * Child → Parent (resource overview): list the site's platform resources (the per-site D1/KV/R2/queue/
 * function inventory) for the given environment. The embedded editor has no cross-origin session, so the
 * admin (which holds `selectedSite` + the bearer) calls `GET /api/sites/:siteId/resources` and replies
 * with {@link ResOverviewResponseMessage}. Gated server-side by its dark flag (a 404 whose message
 * includes "not enabled" → `{ok:false, enabled:false}`).
 */
export interface ResOverviewRequestMessage {
  type: 'PS_RES_OVERVIEW_REQUEST';
  correlationId: string;

  /** Which environment's resources to list (e.g. `production` | `preview`). Omit for the default. */
  environment?: string;
}

/**
 * Child → Parent (resource overview): reconcile the site's resources against the desired state for the
 * given environment. The admin calls `POST /api/sites/:siteId/resources/reconcile` and replies with
 * {@link ResReconcileResponseMessage}. Same dark-flag translation as {@link ResOverviewRequestMessage}.
 */
export interface ResReconcileRequestMessage {
  type: 'PS_RES_RECONCILE_REQUEST';
  correlationId: string;

  /** Which environment to reconcile (e.g. `production` | `preview`). Omit for the default. */
  environment?: string;
}

/** One resource row in the {@link ResOverviewResponseMessage} inventory. */
export interface ResourceOverviewEntry {
  id: string;
  resource_kind: string;
  resource_concept: string;
  environment: string;
  tenancy: string;
  lifecycle_state: string;

  /** Set when the resource has drifted from desired state (the drift taxonomy code). */
  drift_code?: string;

  /** The Worker binding name this resource is exposed under, when bound. */
  binding_name?: string;

  /** ISO timestamp of the last successful sync/reconcile, when known. */
  last_sync_at?: string;

  /** Owner-facing NAME of this specific resource ("lone-mountain-global build 2026-10-01…"). */
  display_name?: string;

  /** Owner-grade TYPE label ("Your site database" / "Your site worker") — never "unknown". */
  owner_label?: string;

  /** Advanced detail (CF id / script / prefix) — rendered behind a disclosure, never headline. */
  detail?: string;
}

/**
 * Parent → Child (resource overview): the admin's reply to {@link ResOverviewRequestMessage} (mirrors the
 * worker's `data` envelope — `{ resources:[…] }`). `enabled` is `false` when the surface's flag is dark
 * (the 404 "not enabled"); `error` carries any other failure (no site selected, network, 4xx).
 */
export interface ResOverviewResponseMessage {
  type: 'PS_RES_OVERVIEW_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** Echoed environment the resources belong to. */
  environment?: string;

  /** The site's platform resource inventory for the environment. */
  resources?: ResourceOverviewEntry[];

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Parent → Child (resource overview): the admin's reply to {@link ResReconcileRequestMessage} (mirrors
 * the worker's `data` envelope — `{ reconciled, drift }`). `error` is set when the authed call failed.
 */
export interface ResReconcileResponseMessage {
  type: 'PS_RES_RECONCILE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** How many resources were reconciled to desired state. */
  reconciled?: number;

  /** The residual drift after reconciliation (resource-specific shapes). */
  drift?: unknown[];

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/** The generic per-kind adapter result envelope the detail surface renders (mirrors the worker `AdapterResult`). */
export interface ResourceDetailResult {
  ok: boolean;

  /** The kind-specific payload on success (a list/table or one child's key-values). Rendered generically. */
  data?: unknown;

  /** A typed error on failure (`not_registered` / `not_supported` / `table_not_found` / `cf_unauthorized` / …). */
  error?: { code: string; message: string; retryable?: boolean };

  /** Log/trace correlation id from the adapter (or the resolver on a resolve-failure). */
  correlationId?: string;
}

/**
 * Child → Parent (resource detail): drill into ONE resource — `list` its children (D1 tables, KV keys,
 * R2 objects, Vectorize vectors, workflow runs, …) or `get` one child (a table page, one KV value, one
 * R2 object, one run). The embedded editor has no cross-origin session, so the admin (which holds
 * `selectedSite` + the bearer) calls `GET /api/sites/:siteId/resources/:kind/detail?action=…` and
 * replies with {@link ResDetailResponseMessage}. The caller NEVER names a CF id — only `kind` + `action`
 * + bounded, non-identifier `params`; every id is server-resolved. Same dark-flag translation as
 * {@link ResOverviewRequestMessage}.
 */
export interface ResDetailRequestMessage {
  type: 'PS_RES_DETAIL_REQUEST';
  correlationId: string;

  /** The resource kind to drill into (`d1` | `kv` | `r2` | `vectorize` | `workflow` | `durable_object` | …). */
  kind: string;

  /** `list` (enumerate children) | `get` (read one child). */
  action: 'list' | 'get';

  /** Which environment the resource belongs to (`production` | `preview`). Omit for the default. */
  environment?: string;

  /**
   * Safe, non-identifier operands forwarded into the adapter's `list`/`get` — a CF id is NEVER accepted.
   * The worker validates + each adapter reads the subset it understands: `d1.get` → `table`; `kv`/`r2` →
   * `key`/`prefix`/`cursor`; `workflow`/`durable_object`/`connection`/`queue` → `id`; `vectorize` →
   * `ids`; `limit`/`offset` are clamped per-adapter.
   */
  params?: {
    table?: string;
    key?: string;
    prefix?: string;
    cursor?: string;
    id?: string;
    ids?: string[];
    limit?: number;
    offset?: number;
  };
}

/**
 * Parent → Child (resource detail): the admin's reply to {@link ResDetailRequestMessage} (mirrors the
 * worker's `data` envelope — `{ kind, action, result }` where `result` is the adapter's typed
 * {@link ResourceDetailResult}). `enabled` is `false` when the surface's flag is dark (the 404 "not
 * enabled"); `error` carries any other transport failure (no site selected, network, 4xx).
 */
export interface ResDetailResponseMessage {
  type: 'PS_RES_DETAIL_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** Echoed resource kind the result belongs to. */
  kind?: string;

  /** Echoed action (`list` | `get`). */
  action?: string;

  /** The adapter's typed result envelope — success payload OR a typed error, rendered generically. */
  result?: ResourceDetailResult;

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (resource mutate): run a NAMED, typed WRITE verb on ONE resource — provision it, `put`/`delete`
 * a KV key, delete an R2 object, `exec` D1 SQL, start/terminate a workflow run, `upsert`/`delete` vectors, etc.
 * The embedded editor has no cross-origin session, so the admin (which holds `selectedSite` + the bearer) calls
 * `POST /api/sites/:siteId/resources/:kind/mutate` and replies with {@link ResMutateResponseMessage}. The caller
 * NEVER names a CF id — only `kind` + `action` + bounded, non-identifier `input`; every id is server-resolved
 * (or PRODUCED, for `provision`). A DESTRUCTIVE action (delete/terminate/reset/exec-DDL/provision) sends
 * `confirm:true` after the editor's own confirm dialog. Same dark-flag translation as
 * {@link ResOverviewRequestMessage}.
 */
export interface ResMutateRequestMessage {
  type: 'PS_RES_MUTATE_REQUEST';
  correlationId: string;

  /** The resource kind to act on (`d1` | `kv` | `r2` | `vectorize` | `workflow` | `durable_object` | …). */
  kind: string;

  /** The kind's named mutation (`put` | `delete` | `exec` | `provision` | `terminate` | `send` | …). */
  action: string;

  /** Which environment the resource belongs to (`production` | `preview`). Omit for the default. */
  environment?: string;

  /**
   * The mutation's SAFE, non-identifier operands (per-kind) — a CF id is NEVER accepted. The worker validates +
   * each adapter reads the subset it understands: `kv`/`r2` `put`/`delete` → `key`/`value`/`prefix`; `d1` `exec`
   * → `sql`/`params`; `vectorize` → `vectors`/`ids`; `workflow` → `instanceId`/`params`; `durable_object` →
   * `objectId`; `queue` → `messages`. `provision` needs none.
   */
  input?: Record<string, unknown>;

  /** `true` to approve a DESTRUCTIVE/billable mutation (delete/terminate/reset/exec-DDL/provision). */
  confirm?: boolean;
}

/**
 * Parent → Child (resource mutate): the admin's reply to {@link ResMutateRequestMessage} (mirrors the worker's
 * `data` envelope — `{ kind, action, result }` where `result` is the adapter's typed
 * {@link ResourceDetailResult}). A `confirmation_required` / `not_available` / `not_supported` adapter outcome
 * rides in `result` (an `ok:false` with a typed error), NOT `error` — `error` is a transport failure (no site
 * selected, network, 4xx). `enabled:false` when the surface's flag is dark (the 404 "not enabled").
 */
export interface ResMutateResponseMessage {
  type: 'PS_RES_MUTATE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** Echoed resource kind the result belongs to. */
  kind?: string;

  /** Echoed action performed (`put` | `delete` | `exec` | `provision` | …). */
  action?: string;

  /** The adapter's typed result envelope — success (what changed) OR a typed error/confirmation, rendered generically. */
  result?: ResourceDetailResult;

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

// ── KV Browser bridge messages ────────────────────────────────────────────────

/** KV namespace entry returned by the `namespaces` op. */
export type KvNamespaceEntry = string;

/** A single KV key descriptor from the `keys` op. */
export interface KvKeyDescriptor {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

/**
 * Child → Parent (KV Browser): ask the admin to proxy a Cloudflare KV
 * operation on behalf of the editor (the editor has no cross-origin session).
 *
 * @remarks
 * ops:
 * - `namespaces` — list all KV namespace binding names for the current site.
 * - `keys`       — list keys in `binding`; respects `prefix` + cursor paging.
 * - `value`      — fetch the value for a single `key` in `binding`.
 */
export interface KvRequestMessage {
  type: 'PS_KV_REQUEST';
  correlationId: string;
  op: 'namespaces' | 'keys' | 'value' | 'put' | 'delete';

  /** Required for `keys` / `value` / `put` / `delete` ops — the KV binding name (e.g. `"KV"`). */
  binding?: string;

  /** For `keys` op — filter to keys starting with this string. */
  prefix?: string;

  /** For `keys` op — opaque pagination cursor from the previous page. */
  cursor?: string;

  /** For `value` / `put` / `delete` ops — the exact key. */
  key?: string;

  /** For `put` op — the value to write (create/overwrite). Server-side size-capped. */
  value?: string;

  /** For `put` op — optional expiry in seconds (KV minimum 60); omitted ⇒ the EXISTING expiry is kept. */
  expirationTtl?: number;

  /**
   * For `put` op — explicitly REMOVE the key's expiration (make it permanent). The only way to drop a
   * TTL, since a bare edit now preserves it. Ignored when {@link expirationTtl} is also set (that wins).
   */
  clearExpiration?: boolean;
}

/** Data envelope variants keyed by op. */
export interface KvNamespacesData {
  namespaces: string[];
}

export interface KvKeysData {
  keys: KvKeyDescriptor[];
  cursor?: string;
}

export interface KvValueData {
  key: string;
  value: string | null;
  metadata?: unknown;

  /** True when the value was size-capped by the reader — editing is disabled (can't round-trip). */
  truncated?: boolean;
}

/**
 * Parent → Child (KV Browser): the admin's reply to {@link KvRequestMessage}.
 * `ok` indicates success; `data` carries the op-specific payload; `error`
 * is set on failure.
 */
export interface KvResponseMessage {
  type: 'PS_KV_RESPONSE';
  correlationId: string;
  ok: boolean;
  data?: KvNamespacesData | KvKeysData | KvValueData;
  error?: string;
}

/** A single R2 object descriptor from the `objects` op. */
export interface R2ObjectDescriptor {
  key: string;
  size: number;
  uploaded: string | null;
  contentType: string | null;
}

/** A saved grid view (the isolated ProjectSites.dev metadata store) — mirrors the worker's `serializeGridView`. */
export interface SavedGridView {
  id: string;
  table: string;
  name: string;
  conditions: Array<{ col: string; op: string; val: string }>;
  combinator: 'AND' | 'OR';
  sortCol: string | null;
  sortDir: 'asc' | 'desc' | null;
  search: string;

  /** Render type — the grid restores this view mode on apply. */
  type: 'grid' | 'gallery' | 'kanban' | 'chart' | 'calendar';

  /**
   * View-type display config: gallery/kanban card-title column (`titleField`); kanban/chart group-by
   * column (`groupField`); calendar date column (`dateField`); + the full column `layout` (field
   * visibility/order/widths/pins/summaries/density) so applying a view restores its whole arrangement.
   * All optional; worker shape-hardens.
   */
  config: {
    titleField?: string;
    groupField?: string;
    dateField?: string;

    /** Multi-column sort as `col:dir,…` (priority order). The primary also lives in `sortCol`/`sortDir`. */
    sorts?: string;
    layout?: SavedGridViewLayout;
  };
  updatedAt: string | null;
}

/** The saved column layout of a grid view — restored on apply (the editor re-validates each field). */
export interface SavedGridViewLayout {
  hidden?: string[];
  order?: string[];
  widths?: Record<string, number>;
  pinned?: string[];
  summaries?: Record<string, string>;
  density?: string;
}

/**
 * Child → Parent (Data tab): manage saved grid views. `list` fetches this table's views; `save`
 * persists the current query as a named view; `delete` removes one by id. The admin forwards to the
 * org-gated `/api/sites/:siteId/grid-views` endpoints and replies with {@link ViewResponseMessage}.
 */
export interface ViewRequestMessage {
  type: 'PS_VIEW_REQUEST';
  action: 'list' | 'save' | 'delete' | 'update';
  table: string;
  correlationId: string;

  /** save: the view name. */
  name?: string;

  /** save: JSON array of `{col,op,val}` (the worker re-validates every leaf). */
  filters?: string;

  /** save: `AND` | `OR`. */
  combinator?: string;

  /** save: the single-column sort. */
  sortCol?: string | null;
  sortDir?: string | null;

  /** save: the OR-of-LIKE search needle. */
  search?: string;

  /** save: the render type — `grid` | `gallery` | `kanban` | `chart` | `calendar` (worker whitelists, default grid). */
  viewType?: string;

  /** save: view display config (`titleField`/`groupField`/`dateField` + `sorts` + the full column `layout`; worker shape-hardens). */
  viewConfig?: {
    titleField?: string;
    groupField?: string;
    dateField?: string;
    sorts?: string;
    layout?: SavedGridViewLayout;
  };

  /** delete: the view id. */
  viewId?: string;
}

/** Parent → Child (Data tab): reply to {@link ViewRequestMessage}. */
export interface ViewResponseMessage {
  type: 'PS_VIEW_RESPONSE';
  correlationId: string;
  action: 'list' | 'save' | 'delete' | 'update';

  /** list. */
  views?: SavedGridView[];

  /** save. */
  view?: SavedGridView | null;

  /** delete. */
  deleted?: boolean;
  error?: string;
}

// ── Code / Git browser bridge messages (per-site source, read-first — FIRE 7) ────

/**
 * Child → Parent (Code tab): list the files that make up the site's current published build. The
 * embedded editor has no cross-origin session, so the admin (which holds `selectedSite` + the bearer)
 * calls `GET /api/sites/:siteId/files` and replies with {@link CodeTreeResponseMessage}. Reads the
 * site's OWN R2 code prefix (`sites/{slug}/[{version}/]`) only — never another site's.
 */
export interface CodeTreeRequestMessage {
  type: 'PS_CODE_TREE_REQUEST';
  correlationId: string;
}

/**
 * Child → Parent (Code tab): read ONE file's text content from the site's current build. The admin
 * calls `GET /api/sites/:siteId/files/:path` and replies with {@link CodeFileResponseMessage}. `path`
 * is relative to the site's R2 prefix; the worker sanitizes + prefix-guards it (traversal defense +
 * cross-site isolation) before any read.
 */
export interface CodeFileRequestMessage {
  type: 'PS_CODE_FILE_REQUEST';
  correlationId: string;

  /** The file path to read, relative to the site's R2 prefix (e.g. `index.html`, `assets/app.js`). */
  path: string;
}

/**
 * Child → Parent (Code tab): list the site's R2-stored git commit history (the dense AI-build
 * timeline). The admin calls `GET /api/sites/:siteId/git/history?depth=N` and replies with
 * {@link CodeHistoryResponseMessage}. Read-only; empty for sites with no committed builds (an honest
 * "no version history yet", never an error).
 */
export interface CodeHistoryRequestMessage {
  type: 'PS_CODE_HISTORY_REQUEST';
  correlationId: string;

  /** How many commits to walk back from HEAD (worker-clamped 1–100, default 20). */
  depth?: number;
}

/**
 * Parent → Child (Code tab): the admin's reply to {@link CodeTreeRequestMessage} (mirrors the worker's
 * `data` envelope — `{ files:[{key,name,size,uploaded,content_type}], prefix, version }`). `error`
 * carries any failure (no site selected, network, 4xx).
 */
export interface CodeTreeResponseMessage {
  type: 'PS_CODE_TREE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The site's files (capped at 500 by the worker); `name` is the path relative to `prefix`. */
  files?: {
    key: string;
    name: string;
    size: number;
    uploaded: string;
    content_type: string | null;
  }[];

  /** The R2 prefix the files were listed under (`sites/{slug}/[{version}/]`). */
  prefix?: string;

  /** The build version the tree was read from (null → the live top-level prefix). */
  version?: string | null;
  error?: string;
}

/**
 * Parent → Child (Code tab): the admin's reply to {@link CodeFileRequestMessage} (mirrors the worker's
 * `data` envelope — `{ key, content, size, content_type }`). `error` is set when the authed read failed
 * (binary/too-large, 404, network).
 */
export interface CodeFileResponseMessage {
  type: 'PS_CODE_FILE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The path that was read (echoed so a late reply targets the right viewer state). */
  path?: string;

  /** The full R2 key the content came from. */
  key?: string;

  /** The file's text content (UTF-8; binary files come back garbled — the viewer gates by extension). */
  content?: string;

  /** The file's byte size. */
  size?: number;

  /** The file's stored content type, when known. */
  content_type?: string | null;
  error?: string;
}

/**
 * Parent → Child (Code tab): the admin's reply to {@link CodeHistoryRequestMessage} (mirrors the
 * worker's `data` envelope — an array of `{ id, parent, message, timestamp, author, files:[{path,size}] }`).
 * `commits` is `[]` for a site with no committed builds (honest empty, not an error).
 */
export interface CodeHistoryResponseMessage {
  type: 'PS_CODE_HISTORY_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The commit chain from HEAD (newest first); empty for a site with no build history. */
  commits?: {
    id: string;
    parent?: string | null;
    message: string;
    timestamp: string;
    author: string;
    files?: { path: string; size: number }[];
  }[];
  error?: string;
}

/*
 * ── Source Control bridge messages (Preview working-tree + immutable releases — Slice 4) ──────────
 *
 * The Source Control view shows the Preview↔Production relationship. Preview is the latest durably-saved
 * working tree; Production is the last deployed release SHA. The embedded editor has no cross-origin
 * session, so — exactly like the Database tab — the admin (which holds `selectedSite` + the bearer)
 * makes the authed calls to the durable-preview worker API (`GET /api/sites/:id/preview-state`,
 * `GET /api/sites/:id/releases`) and replies over these bridge messages. Both are READ-ONLY: this view
 * NEVER commits, deploys, or changes Production. DARK behind the `durable_preview` flag (a 404 whose
 * message includes "not enabled" → `enabled:false`, an honest "not published yet" state, never an error).
 */

/**
 * Child → Parent (Source Control): read this site's current Preview working-tree record. The admin
 * calls `GET /api/sites/:id/preview-state` and replies with {@link PreviewStateResponseMessage}.
 */
export interface PreviewStateRequestMessage {
  type: 'PS_PREVIEW_STATE_REQUEST';
  correlationId: string;
}

/** The Preview working-tree record (mirrors the worker's `WorkingTree` — the durable-preview `working_tree`). */
export interface PreviewWorkingTreeRecord {
  base_main_sha: string | null;
  draft_revision: number;
  tree_digest: string | null;
  preview_deploy_revision: string | null;
  last_error: string | null;
  updated_at: string;
}

/**
 * Parent → Child (Source Control): the admin's reply to {@link PreviewStateRequestMessage} (mirrors the
 * worker's `{ working_tree }` envelope). `working_tree` is `null` when the site has never saved a Preview.
 * `enabled:false` when the `durable_preview` flag is dark (the 404 "not enabled").
 */
export interface PreviewStateResponseMessage {
  type: 'PS_PREVIEW_STATE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The site's Preview working-tree record, or null when none saved yet. */
  working_tree?: PreviewWorkingTreeRecord | null;

  /** `false` when the `durable_preview` flag is off (the dark-flag 404) → the surface stays honest. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (Source Control): read this site's immutable Production release history (newest first).
 * The admin calls `GET /api/sites/:id/releases` and replies with {@link ReleasesResponseMessage}.
 */
export interface ReleasesRequestMessage {
  type: 'PS_RELEASES_REQUEST';
  correlationId: string;
}

/** One immutable release record (mirrors the worker's `Release`). */
export interface ReleaseHistoryRecord {
  id: string;
  commit_sha: string | null;
  artifact_digest: string | null;
  deployment_id: string | null;

  /**
   * Proof-of-serving digest — the lowercase-hex SHA-256 of the promoted `index.html` bytes read BACK from
   * Production after the pointer flipped (mirrors the worker's `ReleaseSchema.serving_sha`). Present only on
   * an honest `success`; `null` on `commit_ok_deploy_failed`/`failed` and on older/pre-migration releases.
   */
  serving_sha: string | null;
  actor: string | null;
  draft_revision: number | null;
  outcome: 'success' | 'commit_ok_deploy_failed' | 'failed';
  created_at: string;
}

/**
 * Parent → Child (Source Control): the admin's reply to {@link ReleasesRequestMessage} (mirrors the
 * worker's `{ releases, count }` envelope). `releases` is `[]` for a site that's never been published
 * (honest empty, not an error). `enabled:false` when the `durable_preview` flag is dark.
 */
export interface ReleasesResponseMessage {
  type: 'PS_RELEASES_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The immutable release history, newest first; empty for a never-published site. */
  releases?: ReleaseHistoryRecord[];

  /** Echoed count of releases. */
  count?: number;

  /** `false` when the `durable_preview` flag is off (the dark-flag 404) → the surface stays honest. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (Source Control — Promote, Slice 5): PROMOTE the site's current Preview working tree to
 * Production. Unlike the read-only preview-state/releases bridges, this is a WRITE: the admin (which holds
 * `selectedSite` + the bearer) calls `POST /api/sites/:id/promote` with the frozen draft revision + tree
 * digest, the worker REALLY freezes the Preview artifact → publishes a new production version → points
 * Production at it → records the ACTUAL outcome, and the admin replies with {@link PromoteResponseMessage}.
 * The child NEVER supplies a site id (the admin injects the selected site's id). DARK behind the
 * `durable_preview` flag (a 404 whose message includes "not enabled" → `enabled:false`).
 */
export interface PromoteRequestMessage {
  type: 'PS_PROMOTE_REQUEST';
  correlationId: string;

  /** The Preview working-tree draft revision being promoted (the idempotency key). */
  draftRevision: number;

  /** The digest of the working tree being promoted (recorded on the release for byte-equality proof). */
  treeDigest: string;

  /** Optional commit SHA associated with this draft. */
  commitSha?: string | null;
}

/** One immutable release record as the promote bridge returns it (mirrors the worker `Release`). */
export interface PromoteReleaseRecord {
  id: string;
  commit_sha: string | null;
  artifact_digest: string | null;
  deployment_id: string | null;

  /**
   * Proof-of-serving digest — the lowercase-hex SHA-256 of the promoted `index.html` Production actually
   * serves post-promote (mirrors the worker's `ReleaseSchema.serving_sha`). Present only on an honest
   * `success`; `null` on `commit_ok_deploy_failed`/`failed`. Read directly (no narrowed cast) by use-promote.
   */
  serving_sha: string | null;
  actor: string | null;
  draft_revision: number | null;
  outcome: 'success' | 'commit_ok_deploy_failed' | 'failed';
  created_at: string;
}

/**
 * Parent → Child (Source Control — Promote): the admin's reply to {@link PromoteRequestMessage} (mirrors
 * the worker's `{ release, outcome, idempotent }` envelope). `outcome` is HONEST — `success` ONLY when
 * Production actually serves the promoted revision; `commit_ok_deploy_failed` when the artifact committed
 * but isn't servable; `failed` when nothing was promoted. `enabled:false` when the `durable_preview` flag
 * is dark (the 404 "not enabled"); `error` carries any transport failure (no site selected, network, 4xx).
 */
export interface PromoteResponseMessage {
  type: 'PS_PROMOTE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The recorded (or idempotently-returned) release row. */
  release?: PromoteReleaseRecord;

  /** The HONEST promotion outcome. */
  outcome?: 'success' | 'commit_ok_deploy_failed' | 'failed';

  /** True when an existing release for this draft was returned unchanged (idempotent replay). */
  idempotent?: boolean;

  /** `false` when the `durable_preview` flag is off (the dark-flag 404) → the control stays honest. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (Danger Zone — FIRE 8): the embedded editor asks the admin (which holds the bearer +
 * `selectedSite`) to PREVIEW or EXECUTE a per-site greenfield reset. The child NEVER supplies a site
 * id — the admin injects the currently-selected site's id server-side, and the worker resolves the
 * site's OWN dedicated D1/KV/R2 (never the shared platform DB, never another site).
 *
 * - `op: 'preview'` — take a backup bookmark + return the EXACT delete-list (per-site D1 tables + row
 *   counts, KV key count, R2 object count). No deletion.
 * - `op: 'execute'` — backup-first, then wipe. Requires `confirm: true` AND `confirmText` (the site
 *   slug, or the literal `RESET`) — the worker re-checks BOTH, so the UI gate is defense-in-depth.
 */
export interface ResetRequestMessage {
  type: 'PS_RESET_REQUEST';
  correlationId: string;
  op: 'preview' | 'execute';

  /** Execute only — must be `true`; a missing/false value is refused by the worker. */
  confirm?: boolean;

  /** Execute only — the type-to-confirm text (the site slug, or `RESET`). Re-validated server-side. */
  confirmText?: string;
}

/** The honest per-surface delete-list returned by a `preview` (and echoed on a successful `execute`). */
export interface ResetPreviewData {
  available: boolean;
  reason?: string;
  d1?: {
    databaseId: string | null;
    databaseName: string | null;
    tables: { name: string; rowCount: number | null }[];
    tablesAvailable: boolean;
  };
  kv?: { namespaceId: string | null; namespaceName: string | null; keyCount: number; keysAvailable: boolean };
  r2?: { bucket: string | null; objectCount: number; objectsAvailable: boolean };

  /** The D1 Time-Travel recovery receipt — surfaced up-front so the owner can copy it before confirming. */
  backupBookmark?: string | null;
  recoveryHint?: string | null;
}

/**
 * Parent → Child (Danger Zone): the admin's reply to {@link ResetRequestMessage}. `ok` indicates the
 * authed worker call succeeded; `data` carries the preview delete-list (preview) or the wipe result
 * (`droppedTables`, `kvDeleted`, `r2Deleted`, `backupBookmark`); `error` is set on failure.
 */
export interface ResetResponseMessage {
  type: 'PS_RESET_RESPONSE';
  correlationId: string;
  ok: boolean;
  op?: 'preview' | 'execute';
  data?: ResetPreviewData & {
    droppedTables?: string[];
    kvDeleted?: number;
    r2Deleted?: number;
    partialErrors?: string[];
  };
  error?: string;
}

// ── Database quick-fill bridge messages (empty-state launchpad + Tables toolbar) ───────────────

/**
 * Child → Parent (Database Tables — "📊 Load sample data"): ask the admin to seed the site's OWN D1
 * with a small, ready-made SAMPLE dataset (a couple of realistic starter tables + rows) so a brand-new,
 * empty database has something to show immediately (embarrassingly-easy first-run). The embedded editor
 * has no cross-origin session, so the admin (which holds `selectedSite` + the bearer) performs the seed
 * server-side against the site's server-resolved D1 and replies with {@link DbLoadSampleResponseMessage}.
 * DARK behind the `per_site_data` flag (a 404 whose message includes "not enabled" → `enabled:false`).
 *
 * @remarks Assumed response shape — see {@link DbLoadSampleResponseMessage}. The exact `data` field names
 * (`tablesCreated` / `rowsInserted`) are the editor's expectation; the backend agent should mirror them.
 */
export interface DbLoadSampleRequestMessage {
  type: 'PS_DB_LOAD_SAMPLE';
  correlationId: string;

  /** Which environment's D1 to seed (`production` | `preview`). Omit for the default. */
  environment?: string;
}

/** Parent → Child: the admin's reply to {@link DbLoadSampleRequestMessage}. */
export interface DbLoadSampleResponseMessage {
  type: 'PS_DB_LOAD_SAMPLE_RESULT';
  correlationId?: string;
  ok: boolean;

  /** How many sample tables were created. */
  tablesCreated?: number;

  /** How many sample rows were inserted across those tables. */
  rowsInserted?: number;

  /** The names of the tables the sample created — so the UI can jump straight to one. */
  tables?: string[];

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (Database Tables — "✨ Seed with AI"): ask the admin to fill a table in the site's OWN
 * D1 with realistic AI-generated rows that MATCH the real schema. The admin forwards to the platform AI
 * (grounded on the server-fetched schema), previews/inserts server-side (parameter-bound) against the
 * site's server-resolved D1, and replies with {@link DbAiSeedResponseMessage}. When `table` is omitted the
 * backend may seed the most-recently-created / only table (or return an error asking the UI to pick one).
 * DARK behind the `per_site_data` flag (a 404 whose message includes "not enabled" → `enabled:false`).
 *
 * @remarks Assumed response shape — see {@link DbAiSeedResponseMessage} (`rowsInserted` + echoed `table`).
 */
export interface DbAiSeedRequestMessage {
  type: 'PS_DB_AI_SEED';
  correlationId: string;

  /** The target table to fill. Omit to let the backend choose (or ask the UI to pick). */
  table?: string;

  /** An optional natural-language hint shaping the generated rows (e.g. "coffee shop menu items"). */
  prompt?: string;

  /** How many rows to generate (backend-clamped; a sensible default when omitted). */
  rowCount?: number;

  /** Which environment's D1 to seed (`production` | `preview`). Omit for the default. */
  environment?: string;
}

/** Parent → Child: the admin's reply to {@link DbAiSeedRequestMessage}. */
export interface DbAiSeedResponseMessage {
  type: 'PS_DB_AI_SEED_RESULT';
  correlationId?: string;
  ok: boolean;

  /** The table that was seeded (echoed — the backend may have chosen it). */
  table?: string;

  /** How many AI-generated rows were inserted. */
  rowsInserted?: number;

  /** `false` when the `per_site_data` flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

// ── Resources media library bridge messages (Resources tab) ─────────────────────────────────────

/** A single media asset descriptor in the {@link ResMediaResponseMessage} list. */
export interface MediaAssetEntry {
  /** Stable id used to `delete` the asset (the backend's own handle — an R2 key or a media-row id). */
  id: string;

  /** The asset's public/served URL (for the `<img>` preview + open-in-new). */
  url: string;

  /**
   * Signed, ABSOLUTE, bearer-free raw URL (worker-minted) the cross-origin `<img>` loads inside
   * the editor iframe — `url` is relative/same-origin and 404s against the editor origin.
   */
  rawUrl?: string;

  /** A friendly file name for display. */
  name?: string;

  /** The MIME type, when known (drives the image-vs-file thumbnail). */
  contentType?: string;

  /** Byte size, when known (drives the storage-usage summary). */
  size?: number;

  /** ISO timestamp the asset was uploaded/created, when known. */
  uploaded?: string;

  /** A coarse kind for the kind filter (`image` | `video` | `document` | `other`), when the backend classifies. */
  kind?: string;

  /** Where the asset came from (e.g. `upload` | `generated` | `build`), when the backend classifies. */
  source?: string;
}

/** Whole-library usage rollup echoed alongside a media `list` (powers the Resources storage-usage header). */
export interface MediaUsageSummary {
  /** Total byte size across all assets. */
  totalBytes?: number;

  /** Total asset count. */
  totalCount?: number;

  /** Per-kind counts, keyed by kind (`image` / `video` / `document` / `other`). */
  countsByKind?: Record<string, number>;
}

/**
 * Child → Parent (Resources — Media library): `list` the site's media assets (with optional kind/source
 * filter + search + paging), or `delete` one by id. The embedded editor has no cross-origin session, so the
 * admin (which holds `selectedSite` + the bearer) calls the site's media endpoint server-side (against the
 * site's server-resolved R2/media store) and replies with {@link ResMediaResponseMessage}. The caller NEVER
 * names a CF id — only the asset's opaque `id`. DARK behind its flag (a 404 whose message includes "not
 * enabled" → `enabled:false`).
 *
 * @remarks Assumed request/response shape — the backend agent should mirror the `list`/`delete` actions and
 * the {@link MediaAssetEntry} + {@link MediaUsageSummary} fields. Upload is a separate concern (see
 * {@link MediaUploadRequestMessage}); `delete` here removes an existing asset.
 */
export interface ResMediaRequestMessage {
  type: 'PS_RES_MEDIA';
  correlationId: string;

  /** `list` (enumerate assets) | `delete` (remove one by id). */
  action: 'list' | 'delete';

  /** Which environment's media to read/act on (`production` | `preview`). Omit for the default. */
  environment?: string;

  /** `list`: filter to one coarse kind (`image` | `video` | `document` | `other`). Omit for all kinds. */
  kind?: string;

  /** `list`: filter to one source (`upload` | `generated` | `build`). Omit for all sources. */
  source?: string;

  /** `list`: a case-insensitive name search needle. Omit / empty → no search. */
  search?: string;

  /** `list`: page size (backend-clamped). */
  limit?: number;

  /** `list`: opaque pagination cursor from the previous page. */
  cursor?: string;

  /** `delete`: the asset id to remove (the opaque handle from {@link MediaAssetEntry.id}). */
  id?: string;
}

/** Parent → Child: the admin's reply to {@link ResMediaRequestMessage}. */
export interface ResMediaResponseMessage {
  type: 'PS_RES_MEDIA_RESULT';
  correlationId?: string;
  ok: boolean;

  /** Echoed action (`list` | `delete`). */
  action?: string;

  /** `list`: the page of assets. */
  assets?: MediaAssetEntry[];

  /** `list`: opaque cursor for the next page (absent → last page). */
  cursor?: string;

  /** `list`: whole-library usage rollup for the storage-usage header. */
  usage?: MediaUsageSummary;

  /**
   * `list`: the FILTERED total match count for the active kind/source/search (respects the filter),
   * so the media header can show an honest "N of <filteredTotal>" rather than the org-wide
   * {@link MediaUsageSummary.totalCount} (which ignores the filter). Absent → fall back to that count.
   */
  filteredTotal?: number;

  /** `delete`: true when the asset was removed. */
  deleted?: boolean;

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent (Resources — Media library): upload one asset. The embedded editor reads the file locally
 * (a base64 data URL) and hands it to the admin, which uploads it server-side to the site's server-resolved
 * media store and replies with {@link MediaUploadResponseMessage} (the newly-created {@link MediaAssetEntry}).
 * DARK behind its flag (a 404 whose message includes "not enabled" → `enabled:false`).
 *
 * @remarks Assumed shape — the backend agent should accept a base64 `dataUrl` (or `content`) + `name` +
 * `contentType` and return the created asset. Kept separate from {@link ResMediaRequestMessage} because the
 * payload (file bytes) is large and shouldn't ride the list/delete verb.
 */
export interface MediaUploadRequestMessage {
  type: 'PS_RES_MEDIA_UPLOAD';
  correlationId: string;

  /** The file name (used to derive the stored name + extension). */
  name: string;

  /** The MIME type of the upload. */
  contentType: string;

  /** The file contents as a base64 data URL (`data:<type>;base64,<...>`). */
  dataUrl: string;

  /** Which environment's media store to upload to (`production` | `preview`). Omit for the default. */
  environment?: string;
}

/** Parent → Child: the admin's reply to {@link MediaUploadRequestMessage}. */
export interface MediaUploadResponseMessage {
  type: 'PS_RES_MEDIA_UPLOAD_RESULT';
  correlationId?: string;
  ok: boolean;

  /** The created asset (so the UI can prepend it to the grid without a full reload). */
  asset?: MediaAssetEntry;

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

// ── Resources site-build-files bridge messages (Resources tab) ──────────────────────────────────

/** A single build file descriptor in the {@link ResSiteFilesResponseMessage} list. */
export interface SiteBuildFileEntry {
  /** The full R2 key the file lives at. */
  key: string;

  /** The path relative to the build prefix (for display). */
  name: string;

  /** Byte size. */
  size: number;

  /** ISO timestamp the file was uploaded, when known. */
  uploaded?: string;

  /** The stored content type, when known. */
  contentType?: string | null;

  /** A directly-openable URL for the file, when the backend can mint one (open-in-new). */
  url?: string;
}

/**
 * Child → Parent (Resources — Site build files): list the files that make up the site's published build
 * (optionally for a specific version). The admin (which holds `selectedSite` + the bearer) lists the site's
 * OWN R2 build prefix (`sites/{slug}/[{version}/]`) server-side and replies with
 * {@link ResSiteFilesResponseMessage}. Reads the site's OWN code only. DARK behind its flag (a 404 whose
 * message includes "not enabled" → `enabled:false`).
 *
 * @remarks Assumed shape — parallels the existing {@link CodeTreeRequestMessage}, but scoped to the
 * Resources tab's build-files list (with size + open-in-new). The backend agent may back this with the same
 * `GET /api/sites/:siteId/files` endpoint.
 */
export interface ResSiteFilesRequestMessage {
  type: 'PS_RES_SITE_FILES';
  correlationId: string;

  /** An optional build version to list (omit → the live top-level prefix). */
  version?: string;

  /** Which environment's build to list (`production` | `preview`). Omit for the default. */
  environment?: string;

  /**
   * Opaque R2 pagination cursor from the previous page's {@link ResSiteFilesResponseMessage.cursor}.
   * Pages PAST the windowed first page for builds with more objects than the per-page cap
   * (FILES-PAGING). Omit for the first page.
   */
  cursor?: string;
}

/** Parent → Child: the admin's reply to {@link ResSiteFilesRequestMessage}. */
export interface ResSiteFilesResponseMessage {
  type: 'PS_RES_SITE_FILES_RESULT';
  correlationId?: string;
  ok: boolean;

  /** The build files (backend-capped); `name` is the path relative to `prefix`. */
  files?: SiteBuildFileEntry[];

  /** The R2 prefix the files were listed under (`sites/{slug}/[{version}/]`). */
  prefix?: string;

  /** The build version the list was read from (null → the live top-level prefix). */
  version?: string | null;

  /**
   * `true` when the R2 listing was WINDOWED (the build has more objects than {@link cap}) — so the shown
   * count is a partial "first N", not the real total. The editor labels it honestly ("first N of many")
   * instead of an under-reported total. Absent/false → the count is the complete file set.
   */
  truncated?: boolean;

  /** The server's per-page object cap (only set when {@link truncated}) — for an honest "first N" label. */
  cap?: number;

  /**
   * Opaque R2 cursor to the NEXT page — present only when {@link truncated} (the build has more
   * objects than this page). "Load more" sends it back as {@link ResSiteFilesRequestMessage.cursor}
   * to append the next page; absent → this is the last page (FILES-PAGING).
   */
  cursor?: string;

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/*
 * ── Resources Automations bridge messages (Resources → Automations tab) ──────────────────────────
 *
 * The per-site automation/workflow log (RES-AUTO slice 2). The embedded editor has no cross-origin
 * session, so the admin (which holds `selectedSite` + the bearer) proxies the read to the worker's
 * `GET /api/sites/:id/automations` (slice 1). Read-only — one request verb, no mutation. DARK behind
 * the `site_automations` flag → a 404 whose reply carries `{ok:false, enabled:false}` → the surface
 * shows a friendly "not enabled" card.
 */

/** One automation/workflow instance, shaped for the Automations panel list (mirrors the worker). */
export interface AutomationEntry {
  /** The job instance id (`workflow_jobs.id`). */
  id: string;
  /** The job kind (`workflow_jobs.job_name`), e.g. `site-generation`. */
  type: string;
  /** `queued | running | success | failed`. */
  status: string;
  /** ISO timestamp the job was created. */
  created_at: string;
  /** ISO timestamp the job finished, or `null` while still in flight. */
  finished_at: string | null;
}

/** Child → Parent: ask the admin to list this site's automations (read-only; no payload). */
export interface AutomationsRequestMessage {
  type: 'PS_RES_AUTOMATIONS';
  correlationId: string;
}

/** Parent → Child: the admin's reply to {@link AutomationsRequestMessage}. */
export interface AutomationsResponseMessage {
  type: 'PS_RES_AUTOMATIONS_RESULT';
  correlationId?: string;
  ok: boolean;

  /** The site's automation instances (backend-capped, newest first). */
  automations?: AutomationEntry[];

  /** `false` when the surface's flag is off (the dark-flag 404) → the surface stays hidden. */
  enabled?: boolean;
  error?: string;
}

/**
 * Child → Parent: RETRY one automation — re-run a (typically FAILED) job by re-dispatching
 * the site's generation workflow. The admin proxies to
 * `POST /api/sites/:id/automations/:automationId/retry` (RES-AUTO slice 3).
 */
export interface AutomationRetryRequestMessage {
  type: 'PS_RES_AUTOMATION_RETRY';
  correlationId: string;
  /** The failed `workflow_jobs` instance id to re-run. */
  automationId: string;
}

/** Parent → Child: the admin's reply to {@link AutomationRetryRequestMessage}. */
export interface AutomationRetryResponseMessage {
  type: 'PS_RES_AUTOMATION_RETRY_RESULT';
  correlationId?: string;
  ok: boolean;
  /** The status the site flipped to on success (`'building'`). */
  status?: string;
  /** `false` when the surface's flag is off (dark-flag 404). */
  enabled?: boolean;
  error?: string;
}

/*
 * ── Resources Buckets bridge messages (Resources → Buckets tab) ─────────────────────────────────
 *
 * The per-site R2 Buckets surface. The embedded editor has no cross-origin session, so the admin
 * (which holds `selectedSite` + the bearer) proxies each op to the worker's `/api/sites/:id/r2/*`
 * endpoints. Bucket CRUD + object browse ride ONE verb (`PS_R2` with an `op`), so the union stays
 * small; object bytes (upload/download) ride their own verbs (large payloads). DARK behind the
 * `r2_buckets` flag → a 404 whose message includes "not enabled" → `{ok:false, enabled:false}`.
 */

/** A per-site bucket in a {@link R2Response} list — display name + address bundle + flags. */
export interface BucketEntry {
  /** The tenant-facing display name (what the owner typed / what ops target). */
  name: string;

  /** The site's default (auto-provisioned) bucket, pinned first in the UI. */
  isDefault?: boolean;

  /** Whether a public base URL is enabled. */
  public?: boolean;

  /** The public base URL when `public` is true. */
  publicUrl?: string | null;

  /** `preview` | `production`. */
  environment?: string;

  /** ISO creation timestamp. */
  createdAt?: string;

  /** The copyable address bundle (S3 endpoint + binding name + bucket + public URL). */
  address?: BucketAddress;
}

/** The copyable "address" of a bucket — one-click copy on the card. */
export interface BucketAddress {
  s3Endpoint: string;
  bucketName: string;
  bindingName: string;
  publicUrl: string | null;
  accountId: string | null;
}

/** A single object in a {@link R2Response} object listing. */
export interface BucketObjectEntry {
  key: string;
  size: number;
  uploadedAt: string | null;
  contentType?: string | null;
}

/**
 * Child → Parent (Resources — Buckets): one bucket/object management op. `op` selects the action; the
 * admin maps it to the matching `/api/sites/:id/r2/*` worker call. Object BYTES (upload/download) use
 * the dedicated {@link BucketUploadRequestMessage} / {@link BucketDownloadRequestMessage} verbs.
 */
export interface R2RequestMessage {
  type: 'PS_R2';
  correlationId: string;

  /** The management op. */
  op:
    | 'listBuckets'
    | 'createBucket'
    | 'deleteBucket'
    | 'address'
    | 'setPublic'
    | 'promote'
    | 'listObjects'
    | 'deleteObject';

  /** The target bucket display name (all ops except `listBuckets`/`createBucket`). */
  bucket?: string;

  /** `createBucket`: the new bucket's display name. */
  name?: string;

  /** `createBucket`: make a public base URL available. */
  public?: boolean;

  /** `setPublic`: the desired public state. */
  makePublic?: boolean;

  /** `listObjects`: key prefix (folder path). */
  prefix?: string;

  /** `listObjects`: folder delimiter (usually `/`). */
  delimiter?: string;

  /** `listObjects`: pagination cursor from the previous page. */
  cursor?: string;

  /** `deleteObject`: the object key to remove. */
  key?: string;
}

/** Parent → Child: the admin's reply to {@link R2RequestMessage}. */
export interface R2ResponseMessage {
  type: 'PS_R2_RESULT';
  correlationId?: string;
  ok: boolean;

  /** Echoed op. */
  op?: string;

  /** `listBuckets`: the site's buckets. */
  buckets?: BucketEntry[];

  /** `listBuckets`: whether object ops (S3 creds) are available — the FE advertises this. */
  objectOpsAvailable?: boolean;

  /** `createBucket`/`address`/`setPublic`/`promote`: the affected bucket. */
  bucket?: BucketEntry;

  /** `address`: the standalone address bundle. */
  address?: BucketAddress;

  /** `listObjects`: the page of objects. */
  objects?: BucketObjectEntry[];

  /** `listObjects`: the "folders" at this level (common prefixes). */
  prefixes?: string[];

  /** `listObjects`: cursor for the next page (absent → last page). */
  cursor?: string;

  /** `listObjects`: true when more pages remain. */
  truncated?: boolean;

  /** `deleteBucket`: objects removed while emptying. */
  objectsDeleted?: number;

  /** `promote`: objects copied preview → production. */
  objectsCopied?: number;

  /** `false` when the surface's flag is off (the dark-flag 404) → the tab stays hidden. */
  enabled?: boolean;

  /** `true` when object ops need R2 S3 credentials (the actionable needs-creds state). */
  needsCreds?: boolean;
  error?: string;
}

/**
 * Child → Parent (Resources — Buckets): upload ONE object. The editor read the file locally (base64
 * data URL) + hands it to the admin, which PUTs it to `/api/sites/:id/r2/buckets/:bucket/objects/{key}`.
 */
export interface BucketUploadRequestMessage {
  type: 'PS_R2_UPLOAD';
  correlationId: string;
  bucket: string;

  /** The object key (path within the bucket, e.g. `images/logo.png`). */
  key: string;
  contentType: string;

  /** File contents as a base64 data URL. */
  dataUrl: string;
}

/** Parent → Child: reply to {@link BucketUploadRequestMessage}. */
export interface BucketUploadResponseMessage {
  type: 'PS_R2_UPLOAD_RESULT';
  correlationId?: string;
  ok: boolean;
  key?: string;
  size?: number;
  enabled?: boolean;
  needsCreds?: boolean;
  error?: string;
}

/**
 * Child → Parent (Resources — Buckets): download ONE object. The admin GETs the bytes from the worker
 * and returns them as a base64 data URL the editor can preview / save. Kept a distinct verb (large body).
 */
export interface BucketDownloadRequestMessage {
  type: 'PS_R2_DOWNLOAD';
  correlationId: string;
  bucket: string;
  key: string;
}

/** Parent → Child: reply to {@link BucketDownloadRequestMessage}. */
export interface BucketDownloadResponseMessage {
  type: 'PS_R2_DOWNLOAD_RESULT';
  correlationId?: string;
  ok: boolean;

  /** The object bytes as a base64 data URL. */
  dataUrl?: string;
  contentType?: string;
  size?: number;
  enabled?: boolean;
  needsCreds?: boolean;
  error?: string;
}

// ── Claude Code panel dark-flag bridge (WLK-39 §75 flagship, S7-prep) ───────────

/**
 * Child → Parent (Claude Code tab): resolve the `claude_code_panel` dark-flag for the selected
 * site. The embedded editor has no cross-origin session, so the admin (which holds `selectedSite` +
 * the bearer) calls `GET /api/sites/:siteId/claude-code/status` and replies with
 * {@link ClaudeFlagResponseMessage}. Resolved ONCE on mount — the Claude Code top tab renders only
 * when the reply says `enabled:true`. DARK behind the `per_site_data`-style 404 ("not enabled" →
 * `enabled:false`). Carries no payload beyond the correlation id.
 */
export interface ClaudeFlagRequestMessage {
  type: 'PS_CLAUDE_FLAG_REQUEST';
  correlationId: string;
}

/**
 * Parent → Child (Claude Code tab): the admin's reply to {@link ClaudeFlagRequestMessage}. `enabled`
 * is `true` ONLY when the `claude_code_panel` flag resolves on for the owned site (a 200 from the
 * status endpoint); it is `false` for the dark-flag 404, no selected site, or any transport failure
 * — so the flagship tab defaults OFF and only ever appears on an explicit ON (fail-safe).
 */
export interface ClaudeFlagResponseMessage {
  type: 'PS_CLAUDE_FLAG_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** `true` only when the flag resolved ON for the owned site; `false` (default) keeps the tab hidden. */
  enabled?: boolean;
  error?: string;
}

// ── Resolution-mode bridge (WLK-39 §75 flagship, S6-b-ii → S7 live-fix) ─────────

/**
 * Child → Parent (Claude Code tab — Resolution mode): run the Resolution Engine for the selected
 * site. The embedded editor has NO cross-origin session and CORS blocks a direct worker call, so —
 * exactly like {@link ClaudeFlagRequestMessage} — it asks the admin (which holds `selectedSite` +
 * the bearer) to `POST /api/resolve {prompt, siteId}` (dual-provider research → Claude synthesis).
 * The admin replies with {@link ResolveResponseMessage}. A relative `fetch('/api/resolve')` from the
 * editor origin 404s (the authed route lives on the WORKER), which is why this MUST go through the
 * bridge. Carries the `prompt` + a correlation id; the admin supplies the owned site's id.
 */
export interface ResolveRequestMessage {
  type: 'PS_RESOLVE_REQUEST';
  correlationId: string;

  /** The research prompt both legs receive, then Claude synthesizes (worker schema: 1–20000 chars). */
  prompt: string;
}

/**
 * Parent → Child (Claude Code tab — Resolution mode): the admin's reply to {@link ResolveRequestMessage}.
 * On a worker 200 `ok:true` + the worker's TOP-LEVEL `{research, synthesis}` body ride along (the panel
 * feeds it to `parseResolveResult`). `dark:true` is the `resolution_engine` DARK-flag 404 (and the
 * foreign-site 404) → the panel shows its calm "Resolution unavailable → snap to Single" state (NEVER
 * an error). Any other failure (no selected site, network, non-404) is `ok:false` with no `dark` → the
 * panel's run-lifecycle `fail`. Mirrors {@link ClaudeFlagResponseMessage}'s failure translation.
 */
export interface ResolveResponseMessage {
  type: 'PS_RESOLVE_RESPONSE';
  correlationId?: string;
  ok: boolean;

  /** The worker's two research legs (top-level `research`) on a 200 — passed to `parseResolveResult`. */
  research?: unknown;

  /** The worker's synthesis section (top-level `synthesis`) on a 200 — passed to `parseResolveResult`. */
  synthesis?: unknown;

  /**
   * `true` when the worker returned 404 — the `resolution_engine` flag is dark OR the site is
   * foreign/missing. The panel treats this as "Resolution unavailable" (disable the toggle, snap to
   * Single), NOT a failure. Absent on success + on a genuine transport error.
   */
  dark?: boolean;
  error?: string;
}

export type ParentToChildMessage =
  | SubmitPromptMessage
  | ImportFilesMessage
  | RequestFilesMessage
  | LoadBuildContextMessage
  | OpenSnapshotMessage
  | OpenFileMessage
  | ListFilesMessage
  | DataResponseMessage
  | SqlResponseMessage
  | Nl2SqlResponseMessage
  | AskResponseMessage
  | SiteDbTablesResponseMessage
  | SiteDbRowsResponseMessage
  | SiteDbUpdateRowResponseMessage
  | SiteDbQueryResponseMessage
  | SiteDbSearchResponseMessage
  | SiteDbCreateTableResponseMessage
  | SiteDbDropTableResponseMessage
  | SiteDbAddColumnResponseMessage
  | SiteDbRenameColumnResponseMessage
  | SiteDbDropColumnResponseMessage
  | ResOverviewResponseMessage
  | ResReconcileResponseMessage
  | ResDetailResponseMessage
  | ResMutateResponseMessage
  | KvResponseMessage
  | ViewResponseMessage
  | CodeTreeResponseMessage
  | CodeFileResponseMessage
  | CodeHistoryResponseMessage
  | PreviewStateResponseMessage
  | ReleasesResponseMessage
  | PromoteResponseMessage
  | ResetResponseMessage
  | DbLoadSampleResponseMessage
  | DbAiSeedResponseMessage
  | ResMediaResponseMessage
  | MediaUploadResponseMessage
  | ResSiteFilesResponseMessage
  | AutomationsResponseMessage
  | AutomationRetryResponseMessage
  | R2ResponseMessage
  | BucketUploadResponseMessage
  | BucketDownloadResponseMessage
  | ClaudeFlagResponseMessage
  | ResolveResponseMessage
  | PSToastMessage;
export type ChildToParentMessage =
  | BoltReadyMessage
  | FilesReadyMessage
  | GenerationStatusMessage
  | FilesListMessage
  | DeployRequestMessage
  | DataRequestMessage
  | SqlRequestMessage
  | Nl2SqlRequestMessage
  | AskRequestMessage
  | SiteDbTablesRequestMessage
  | SiteDbRowsRequestMessage
  | SiteDbUpdateRowRequestMessage
  | SiteDbQueryRequestMessage
  | SiteDbSearchRequestMessage
  | SiteDbCreateTableRequestMessage
  | SiteDbDropTableRequestMessage
  | SiteDbAddColumnRequestMessage
  | SiteDbRenameColumnRequestMessage
  | SiteDbDropColumnRequestMessage
  | ResOverviewRequestMessage
  | ResReconcileRequestMessage
  | ResDetailRequestMessage
  | ResMutateRequestMessage
  | KvRequestMessage
  | ViewRequestMessage
  | CodeTreeRequestMessage
  | CodeFileRequestMessage
  | CodeHistoryRequestMessage
  | PreviewStateRequestMessage
  | ReleasesRequestMessage
  | PromoteRequestMessage
  | ResetRequestMessage
  | DbLoadSampleRequestMessage
  | DbAiSeedRequestMessage
  | ResMediaRequestMessage
  | MediaUploadRequestMessage
  | ResSiteFilesRequestMessage
  | AutomationsRequestMessage
  | AutomationRetryRequestMessage
  | R2RequestMessage
  | BucketUploadRequestMessage
  | BucketDownloadRequestMessage
  | ClaudeFlagRequestMessage
  | ResolveRequestMessage
  | PSErrorMessage
  | PSTelemetryMessage
  | PSToastMessage;

// ── Allowed origins ──────────────────────────────────────────

const ALLOWED_ORIGINS = new Set(['https://projectsites.dev', 'http://localhost:4200', 'http://localhost:4300']);

// ── Detection (synchronous — must run before WebContainer boot) ──

function detectEmbedded(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const inIframe = window.parent !== window;

    if (!inIframe) {
      return false;
    }

    const hasParam = new URLSearchParams(window.location.search).has('embedded');

    /*
     * Embedded mode must SURVIVE SPA navigation (journey 2026-08-19).
     *
     * The chat-import flow navigates the document to `/chat/{id}` — a FULL
     * reload whose URL carries NO `embedded` param. The old param-only
     * detection silently turned embedded mode OFF on that reload: the
     * module-level `handleMessage` listener never attached, so the parent's
     * Save & Deploy (`PS_REQUEST_FILES`) found zero handlers and the
     * publish leg of the bridge dead-aired forever.
     *
     * An embedded session now stamps `ps_embedded=1` into localStorage at
     * first boot (param present). Any later reload inside the admin iframe
     * recovers the flag. Standalone visits are unaffected — a top-level
     * window has `inIframe === false` and never reads the stamp. The
     * origin allowlist on both sides of the bridge still gates every
     * message, so a third-party iframe can't act on the protocol.
     */
    if (hasParam) {
      try {
        window.localStorage.setItem('ps_embedded', '1');
      } catch {
        // storage may be unavailable (private mode) — param still wins this boot
      }

      return true;
    }

    try {
      return window.localStorage.getItem('ps_embedded') === '1';
    } catch {
      return false;
    }
  } catch {
    // Cross-origin access to window.parent may throw
    return false;
  }
}

/** True when bolt.diy is loaded inside a projectsites.dev iframe */
export const isEmbedded: boolean = detectEmbedded();

// ── postMessage helpers ──────────────────────────────────────

/** Send a message to the parent frame (projectsites.dev admin). */
export function postToParent(message: ChildToParentMessage): void {
  if (!isEmbedded || typeof window === 'undefined') {
    return;
  }

  // Post to all allowed origins (parent origin is unknown at send time)
  window.parent.postMessage(message, '*');
}

/** Validate that a MessageEvent comes from an allowed origin. */
function isAllowedOrigin(event: MessageEvent): boolean {
  return ALLOWED_ORIGINS.has(event.origin);
}

/** Check if a message has the PS_ prefix (our protocol). */
function isPSMessage(data: unknown): data is ParentToChildMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof (data as { type: unknown }).type === 'string' &&
    (data as { type: string }).type.startsWith('PS_')
  );
}

// ── Message listener ─────────────────────────────────────────

type MessageHandler = (message: ParentToChildMessage) => void;

const handlers: MessageHandler[] = [];

/*
 * Workbench materialization across the chat-import reload (journey
 * 2026-08-19 — the LAST rung of the editor bridge).
 *
 * The imported boltArtifact's <boltAction type="file"> blocks never reach
 * the workbench in embedded mode: importChat() creates a fresh chat and
 * does a FULL-DOCUMENT navigation, and the files store is memory-only —
 * everything is wiped on that reload. So Save & Deploy's PS_FILES_READY
 * answered with ZERO files and the publish leg could never carry content.
 *
 * Two-phase fix:
 *  - `materializeImportedFiles(messages)` parses every artifact file
 *    action from the chat export and STASHES {path → content} in
 *    sessionStorage (survives the reload).
 *  - `restoreMaterializedFiles()` — called from the module init below —
 *    drains the stash into workbenchStore.createFile() on the fresh
 *    document, so getTextFiles() (and therefore PS_FILES_READY) finally
 *    carries the real site files.
 *
 * sessionStorage is per-tab and per-origin; a standalone bolt visit (or a
 * different embed) never sees the stash. The regex mirrors
 * FileDiffBadges.tsx (tolerates unterminated actions, strips code fences).
 */
const MATERIALIZED_KEY = 'ps_materialized_files';
const FILE_ACTION_RE =
  /<boltAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)(?=<\/boltAction>|<boltAction|$)/g;

export function materializeImportedFiles(messages: Array<{ content?: string }>): number {
  try {
    const files: Record<string, string> = {};

    for (const m of messages) {
      const content = typeof m?.content === 'string' ? m.content : '';
      FILE_ACTION_RE.lastIndex = 0;

      let match: RegExpExecArray | null;

      while ((match = FILE_ACTION_RE.exec(content)) !== null) {
        const filePath = (match[1] ?? '').trim();

        if (!filePath) {
          continue;
        }

        const body = (match[2] ?? '').replace(/^\s*```\w*\n?/, '').replace(/\n```\s*$/, '');
        files[filePath] = body;
      }
    }

    const count = Object.keys(files).length;

    if (count > 0) {
      window.sessionStorage.setItem(MATERIALIZED_KEY, JSON.stringify(files));
    }

    return count;
  } catch {
    return 0;
  }
}

export function restoreMaterializedFiles(): void {
  try {
    const raw = window.sessionStorage.getItem(MATERIALIZED_KEY);

    if (!raw) {
      return;
    }

    window.sessionStorage.removeItem(MATERIALIZED_KEY);

    const files = JSON.parse(raw) as Record<string, string>;
    import('~/lib/stores/workbench')
      .then(({ workbenchStore }) => {
        /*
         * setVirtualFile — NOT createFile. createFile awaits the WebContainer
         * promise which never settles in embedded mode, so an await-based
         * restore hangs forever and getTextFiles() stays empty.
         */
        let restored = 0;

        for (const [filePath, content] of Object.entries(files)) {
          try {
            workbenchStore.setVirtualFile(filePath, content);
            restored++;
          } catch {
            // a single bad path must not abort the rest
          }
        }

        if (restored > 0) {
          postToParent({
            type: 'PS_TOAST',
            kind: 'info',
            level: 'info',
            message: `Editor workbench restored (${restored} files) — Save & Deploy now carries the site`,
          });
        }

        /*
         * If this embed is cross-origin-isolated, WebContainer CAN boot — so mount
         * the imported project into its filesystem and run `npm install` + `npm run
         * dev`, which makes the live Preview actually spin up (Brian 2026-08-21 —
         * "ensure the npm command runs that causes the Preview to display"). Files
         * were only written to the in-memory store above (for the FileTree +
         * Save & Deploy bridge); the dev server needs them on the REAL WC disk. A
         * non-isolated embed stays materialization-only — WebContainer never boots.
         */
        const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

        if (isolated && restored > 0) {
          void spinUpWebContainerPreview(files);
        }
      })
      .catch(() => {
        // workbench store failed to load — the stash is already drained; fail soft
      });
  } catch {
    // malformed stash — drop it
  }
}

/** Nest flat `{relPath -> contents}` into the WebContainer `FileSystemTree` shape. */
function filesToTree(files: Record<string, string>): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const [rawPath, contents] of Object.entries(files)) {
    const parts = rawPath.replace(/^\/+/, '').split('/').filter(Boolean);

    if (parts.length === 0) {
      continue;
    }

    let node: FileSystemTree = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];

      if (!node[dir]) {
        node[dir] = { directory: {} };
      }

      node = (node[dir] as DirectoryNode).directory;
    }

    node[parts[parts.length - 1]] = { file: { contents } };
  }

  return tree;
}

/**
 * Mount the imported project into WebContainer and start its dev server so the
 * embedded editor's Preview displays the running site. Fire-and-forget — every
 * phase toasts progress to the admin shell; failures fail soft.
 *
 * @remarks Impure — mounts to the WebContainer fs and spawns npm processes.
 */
async function spinUpWebContainerPreview(files: Record<string, string>): Promise<void> {
  try {
    const [{ webcontainer }, { workbenchStore }] = await Promise.all([
      import('~/lib/webcontainer'),
      import('~/lib/stores/workbench'),
    ]);
    const wc = await webcontainer; // resolves only when the isolated embed booted

    await wc.mount(filesToTree(files));

    // Pick the dev script (dev → start → serve), default `dev`.
    let devScript = 'dev';

    try {
      const scripts = (JSON.parse(files['package.json'] ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
      devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : 'dev';
    } catch {
      // no/invalid package.json — fall back to `dev`
    }

    /*
     * Prefer the BOLT SHELL TERMINAL so `npm install` + Vite's ready banner
     * (`VITE vX ready … Local: …`) + HMR update logs stream into the VISIBLE
     * terminal — that is the running dev server whose watcher live-reloads the
     * Preview on every file save (Brian 2026-08-21). Fall back to a detached
     * `spawn` only if the terminal never attaches, so the Preview still boots.
     */
    const shell = workbenchStore.boltTerminal;
    const shellReady = await Promise.race([
      shell.ready().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
    ]);

    postToParent({ type: 'PS_TOAST', kind: 'info', level: 'info', message: 'Installing dependencies…' });

    if (shellReady) {
      const install = await shell.executeCommand('ps-spinup', 'npm install');

      if (install && install.exitCode !== 0) {
        postToParent({
          type: 'PS_TOAST',
          kind: 'error',
          level: 'error',
          message: 'npm install failed — see the terminal',
        });
        return;
      }

      postToParent({ type: 'PS_TOAST', kind: 'info', level: 'info', message: 'Starting dev server…' });

      /*
       * Long-running — fire-and-forget so Vite keeps running + `server-ready`
       * (PreviewsStore) surfaces the URL into the Preview tab.
       */
      void shell.executeCommand('ps-spinup', `npm run ${devScript}`);

      return;
    }

    /*
     * Fallback (terminal never attached): detached spawn — no visible output,
     * but the dev server + Preview still come up.
     */
    const install = await wc.spawn('npm', ['install']);

    if ((await install.exit) !== 0) {
      postToParent({ type: 'PS_TOAST', kind: 'error', level: 'error', message: 'npm install failed' });
      return;
    }

    postToParent({ type: 'PS_TOAST', kind: 'info', level: 'info', message: 'Starting dev server…' });
    await wc.spawn('npm', ['run', devScript]);
  } catch (err) {
    postToParent({
      type: 'PS_TOAST',
      kind: 'error',
      level: 'error',
      message: 'Preview failed to start: ' + String(err).slice(0, 90),
    });
  }
}

/** Register a handler for incoming parent messages. Returns an unsubscribe function. */
export function onParentMessage(handler: MessageHandler): () => void {
  handlers.push(handler);

  return () => {
    const idx = handlers.indexOf(handler);

    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  };
}

function handleMessage(event: MessageEvent): void {
  /*
   * (Removed the per-message "[embed] Received postMessage" debug warn — it
   * fired on EVERY PS_ message in embedded mode, spamming the editor console.
   * The origin-reject + handler-error logs below remain — those are rare,
   * diagnostic, and security-relevant.)
   */
  if (!isAllowedOrigin(event)) {
    if (isEmbedded && event.data?.type?.startsWith?.('PS_')) {
      console.warn('[embed] REJECTED — origin not allowed:', event.origin, 'Allowed:', [...ALLOWED_ORIGINS]);
    }

    return;
  }

  if (!isPSMessage(event.data)) {
    return;
  }

  for (const handler of handlers) {
    try {
      handler(event.data);
    } catch (err) {
      console.warn('[embed] Handler error:', err);
    }
  }
}

// ── Convenience emitters (items 46-48) ───────────────────────

/**
 * Relay an editor runtime error to the admin so it can be persisted to
 * `audit_logs` with `action: 'editor.runtime_error'`. Safe to call from
 * any handler — silently no-ops outside embedded mode.
 */
export function postErrorToParent(input: Omit<PSErrorMessage, 'type' | 'requestId'> & { requestId?: string }): void {
  postToParent({
    type: 'PS_ERROR',
    code: input.code,
    message: input.message,
    stack: input.stack,
    file: input.file,
    line: input.line,
    requestId: input.requestId ?? (typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}`),
  });
}

/** Capture a PostHog event via the admin's TelemetryService. */
export function postTelemetryToParent(event: string, props?: Record<string, unknown>): void {
  postToParent({ type: 'PS_TELEMETRY', event, props });
}

/** Toast bridge — admin renders via its ToastService. */
export function postToastToParent(level: NonNullable<PSToastMessage['kind']>, message: string): void {
  /*
   * Send both `kind` (canonical) and `level` (legacy alias) so either
   * side of the bridge can match without coordination.
   */
  postToParent({ type: 'PS_TOAST', kind: level, level, message });
}

// ── Request/await-by-correlationId helper (shared by the new Database + Resources senders) ────────

/** Monotonic per-module counter so a helper-generated correlationId is always unique. */
let bridgeCorrelationCounter = 0;

/** Mint a unique correlationId (crypto.randomUUID when available, else a monotonic fallback). */
export function nextBridgeCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `bridge_${++bridgeCorrelationCounter}`;
}

const BRIDGE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Send ONE child→parent request + resolve with the parent's reply whose `type` is `expectType` AND whose
 * `correlationId` matches. Rejects on timeout so a dropped/unhandled parent never hangs the caller. Mirrors
 * the ad-hoc `request()` closures in SiteTablesPanel/ResourceOverviewPanel, extracted so the new Database
 * quick-fill + Resources senders share one implementation. Outside embedded mode it rejects immediately.
 *
 * @typeParam R - the expected `ParentToChildMessage` variant.
 * @param message - the child→parent message (its `correlationId` is used to match the reply).
 * @param expectType - the `type` string of the reply variant to resolve on.
 * @param timeoutMs - how long to wait before rejecting (default {@link BRIDGE_REQUEST_TIMEOUT_MS}).
 */
export function requestFromParent<R extends ParentToChildMessage>(
  message: ChildToParentMessage & { correlationId: string },
  expectType: R['type'],
  timeoutMs: number = BRIDGE_REQUEST_TIMEOUT_MS,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    if (!isEmbedded) {
      reject(new Error('Open this from the ProjectSites admin to use this feature.'));
      return;
    }

    const { correlationId } = message;
    let unsubscribe: () => void = () => {};

    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('The request timed out. Check the admin connection and retry.'));
    }, timeoutMs);

    unsubscribe = onParentMessage((reply) => {
      if (reply.type !== expectType) {
        return;
      }

      if ((reply as { correlationId?: string }).correlationId !== correlationId) {
        return;
      }

      clearTimeout(timer);
      unsubscribe();
      resolve(reply as R);
    });

    postToParent(message);
  });
}

/**
 * Resolve the `claude_code_panel` dark-flag for the selected site (WLK-39 S7-prep). Asks the admin
 * (over the PS_CLAUDE_FLAG bridge) to probe `GET /api/sites/:siteId/claude-code/status`; the editor
 * calls this ONCE on mount to decide whether to render the Claude Code top tab. Resolves with the
 * parent's {@link ClaudeFlagResponseMessage} — `enabled:true` ONLY on an explicit flag-on 200; the
 * dark-flag 404 / no-site / any failure resolves `enabled:false` (the tab stays hidden, fail-safe).
 */
export function requestClaudeCodeFlag(): Promise<ClaudeFlagResponseMessage> {
  return requestFromParent<ClaudeFlagResponseMessage>(
    { type: 'PS_CLAUDE_FLAG_REQUEST', correlationId: nextBridgeCorrelationId() },
    'PS_CLAUDE_FLAG_RESPONSE',
  );
}

/**
 * Run the Resolution Engine for the selected site (WLK-39 S7 live-fix). Asks the admin (over the
 * PS_RESOLVE bridge) to `POST /api/resolve {prompt, siteId}` — the embedded editor has no cross-origin
 * session and CORS blocks a direct worker call, so Resolution MUST go through the admin bridge exactly
 * like {@link requestClaudeCodeFlag}'s flag probe. Resolves with the parent's {@link ResolveResponseMessage}:
 * `ok:true` + the worker's `{research, synthesis}` on a 200; `ok:false, dark:true` on the
 * `resolution_engine` DARK-flag 404 / foreign-site 404 (the panel snaps to Single, NOT an error); and a
 * plain `ok:false` on any genuine transport failure (the panel's run-lifecycle `fail`). The `prompt` is
 * the only payload the editor sends — the admin supplies the owned site's id, so no bearer ever crosses
 * the postMessage boundary.
 *
 * @param prompt - the research prompt (the panel already trims it before calling).
 * @returns the parent's reply (resolved value; the panel branches on `dark`/`ok`).
 */
export function requestResolve(prompt: string): Promise<ResolveResponseMessage> {
  return requestFromParent<ResolveResponseMessage>(
    { type: 'PS_RESOLVE_REQUEST', correlationId: nextBridgeCorrelationId(), prompt },
    'PS_RESOLVE_RESPONSE',
  );
}

/**
 * "📊 Load sample data" — seed the site's OWN D1 with a ready-made starter dataset.
 * Resolves with the parent's {@link DbLoadSampleResponseMessage}.
 */
export function requestDbLoadSample(input: { environment?: string } = {}): Promise<DbLoadSampleResponseMessage> {
  return requestFromParent<DbLoadSampleResponseMessage>(
    { type: 'PS_DB_LOAD_SAMPLE', correlationId: nextBridgeCorrelationId(), environment: input.environment },
    'PS_DB_LOAD_SAMPLE_RESULT',
  );
}

/**
 * "✨ Seed with AI" — fill a table in the site's OWN D1 with realistic AI-generated rows.
 * Resolves with the parent's {@link DbAiSeedResponseMessage}.
 */
export function requestDbAiSeed(
  input: { table?: string; prompt?: string; rowCount?: number; environment?: string } = {},
): Promise<DbAiSeedResponseMessage> {
  return requestFromParent<DbAiSeedResponseMessage>(
    {
      type: 'PS_DB_AI_SEED',
      correlationId: nextBridgeCorrelationId(),
      table: input.table,
      prompt: input.prompt,
      rowCount: input.rowCount,
      environment: input.environment,
    },
    'PS_DB_AI_SEED_RESULT',
  );
}

/**
 * Run ONE raw SQL statement against the site's OWN dedicated D1 (the SQL console). Resolves with the
 * parent's {@link SiteDbQueryResponseMessage} — `{ rows, meta, rowCount, truncated }` on success, a
 * verbatim `error` on a SQL error, or `enabled:false` when the `per_site_data` flag is dark.
 */
export function requestDbQuery(input: {
  sql: string;
  params?: (string | number | boolean | null)[];
}): Promise<SiteDbQueryResponseMessage> {
  return requestFromParent<SiteDbQueryResponseMessage>(
    {
      type: 'PS_SITEDB_QUERY_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      sql: input.sql,
      params: input.params,
    },
    'PS_SITEDB_QUERY_RESPONSE',
  );
}

/**
 * Advanced cross-table search over the site's OWN D1 (matches table NAMES + row CONTENT). Resolves with the
 * parent's {@link SiteDbSearchResponseMessage} — `{ nameMatches, contentMatches, truncated }`.
 */
export function requestDbSearch(input: { q: string; limit?: number }): Promise<SiteDbSearchResponseMessage> {
  return requestFromParent<SiteDbSearchResponseMessage>(
    {
      type: 'PS_SITEDB_SEARCH_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      q: input.q,
      limit: input.limit,
    },
    'PS_SITEDB_SEARCH_RESPONSE',
  );
}

/**
 * Create a NEW table in the site's OWN dedicated D1 (manual name + typed columns) via
 * `POST /api/sites/:siteId/db/tables`. Resolves with the parent's {@link SiteDbCreateTableResponseMessage} —
 * `ok:true` on success, a verbatim `error` on a DDL/validation failure, or `enabled:false` when the
 * `per_site_data` flag is dark.
 */
export function requestDbCreateTable(input: {
  name: string;
  columns: SiteDbColumnSpec[];
}): Promise<SiteDbCreateTableResponseMessage> {
  return requestFromParent<SiteDbCreateTableResponseMessage>(
    {
      type: 'PS_SITEDB_CREATE_TABLE_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      name: input.name,
      columns: input.columns,
    },
    'PS_SITEDB_CREATE_TABLE_RESPONSE',
  );
}

/**
 * Drop a table from the site's OWN dedicated D1 via `DELETE /api/sites/:siteId/db/tables/:table`. Resolves
 * with the parent's {@link SiteDbDropTableResponseMessage} — `ok:true` on success, a verbatim `error` on
 * failure, or `enabled:false` when the `per_site_data` flag is dark.
 */
export function requestDbDropTable(input: { table: string }): Promise<SiteDbDropTableResponseMessage> {
  return requestFromParent<SiteDbDropTableResponseMessage>(
    {
      type: 'PS_SITEDB_DROP_TABLE_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      table: input.table,
    },
    'PS_SITEDB_DROP_TABLE_RESPONSE',
  );
}

/**
 * Add ONE nullable column to a table in the site's OWN dedicated D1 via
 * `POST /api/sites/:siteId/db/tables/:table/columns`. Resolves with the parent's
 * {@link SiteDbAddColumnResponseMessage} — `ok:true` on success, a verbatim `error` on a DDL/validation
 * failure, or `enabled:false` when the `per_site_data` flag is dark.
 */
export function requestDbAddColumn(input: {
  table: string;
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL';
}): Promise<SiteDbAddColumnResponseMessage> {
  return requestFromParent<SiteDbAddColumnResponseMessage>(
    {
      type: 'PS_SITEDB_ADD_COLUMN_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      table: input.table,
      name: input.name,
      columnType: input.type,
    },
    'PS_SITEDB_ADD_COLUMN_RESPONSE',
  );
}

/**
 * Rename ONE column in a table in the site's OWN dedicated D1 via
 * `PATCH /api/sites/:siteId/db/tables/:table/columns/:column`. Resolves with the parent's
 * {@link SiteDbRenameColumnResponseMessage} — `ok:true` on success, a verbatim `error` on failure, or
 * `enabled:false` when the `per_site_data` flag is dark.
 */
export function requestDbRenameColumn(input: {
  table: string;
  column: string;
  name: string;
}): Promise<SiteDbRenameColumnResponseMessage> {
  return requestFromParent<SiteDbRenameColumnResponseMessage>(
    {
      type: 'PS_SITEDB_RENAME_COLUMN_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      table: input.table,
      column: input.column,
      name: input.name,
    },
    'PS_SITEDB_RENAME_COLUMN_RESPONSE',
  );
}

/**
 * Revision 1 — update ONE cell of ONE row in the site's OWN dedicated D1, targeted by its stable
 * SQLite `rowid` (the `_rowid` the browse surface exposes), via
 * `PATCH /api/sites/:siteId/db/tables/:table/rows/:rowid`. This is the id that exists for EVERY
 * ordinary row even when the table has NO primary key — so it kills the "no primary key ⇒ read-only"
 * limitation. Resolves with the parent's {@link SiteDbUpdateRowResponseMessage} — `ok:true` (+ `updated`)
 * on success, a verbatim `error` on failure, or `enabled:false` when the `per_site_data` flag is dark.
 */
export function requestDbUpdateRow(input: {
  table: string;
  rowid: number;
  column: string;
  value: string | number | boolean | null;
}): Promise<SiteDbUpdateRowResponseMessage> {
  return requestFromParent<SiteDbUpdateRowResponseMessage>(
    {
      type: 'PS_SITEDB_UPDATE_ROW_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      table: input.table,
      rowid: input.rowid,
      column: input.column,
      value: input.value,
    },
    'PS_SITEDB_UPDATE_ROW_RESPONSE',
  );
}

/**
 * Drop ONE column from a table in the site's OWN dedicated D1 via
 * `DELETE /api/sites/:siteId/db/tables/:table/columns/:column`. Resolves with the parent's
 * {@link SiteDbDropColumnResponseMessage} — `ok:true` on success, a verbatim `error` on failure, or
 * `enabled:false` when the `per_site_data` flag is dark.
 */
export function requestDbDropColumn(input: {
  table: string;
  column: string;
}): Promise<SiteDbDropColumnResponseMessage> {
  return requestFromParent<SiteDbDropColumnResponseMessage>(
    {
      type: 'PS_SITEDB_DROP_COLUMN_REQUEST',
      correlationId: nextBridgeCorrelationId(),
      table: input.table,
      column: input.column,
    },
    'PS_SITEDB_DROP_COLUMN_RESPONSE',
  );
}

/** List / delete the site's media assets. Resolves with the parent's {@link ResMediaResponseMessage}. */
export function requestResMedia(input: {
  action: 'list' | 'delete';
  environment?: string;
  kind?: string;
  source?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  /** `list`: 0-based offset for "Load more" paging (the admin bridge clamps + forwards it to `/media/assets`). */
  offset?: number;
  id?: string;
}): Promise<ResMediaResponseMessage> {
  return requestFromParent<ResMediaResponseMessage>(
    { type: 'PS_RES_MEDIA', correlationId: nextBridgeCorrelationId(), ...input },
    'PS_RES_MEDIA_RESULT',
  );
}

/** Upload one media asset (base64 data URL). Resolves with the parent's {@link MediaUploadResponseMessage}. */
export function requestMediaUpload(input: {
  name: string;
  contentType: string;
  dataUrl: string;
  environment?: string;
}): Promise<MediaUploadResponseMessage> {
  return requestFromParent<MediaUploadResponseMessage>(
    { type: 'PS_RES_MEDIA_UPLOAD', correlationId: nextBridgeCorrelationId(), ...input },
    'PS_RES_MEDIA_UPLOAD_RESULT',
  );
}

/** List the site's build files. Resolves with the parent's {@link ResSiteFilesResponseMessage}. */
export function requestResSiteFiles(
  input: { version?: string; environment?: string; cursor?: string } = {},
): Promise<ResSiteFilesResponseMessage> {
  return requestFromParent<ResSiteFilesResponseMessage>(
    {
      type: 'PS_RES_SITE_FILES',
      correlationId: nextBridgeCorrelationId(),
      version: input.version,
      environment: input.environment,
      // `cursor` pages past the windowed first page (FILES-PAGING); omit for the first page.
      cursor: input.cursor,
    },
    'PS_RES_SITE_FILES_RESULT',
  );
}

/**
 * Resources → Automations: ask the parent admin to list THIS site's automation/workflow instances
 * (read-only). Resolves with the parent's {@link AutomationsResponseMessage} (the admin proxies to
 * `GET /api/sites/:id/automations`). DARK behind `site_automations` → `{ok:false, enabled:false}`.
 */
export function requestAutomations(): Promise<AutomationsResponseMessage> {
  return requestFromParent<AutomationsResponseMessage>(
    { type: 'PS_RES_AUTOMATIONS', correlationId: nextBridgeCorrelationId() },
    'PS_RES_AUTOMATIONS_RESULT',
  );
}

/**
 * Resources → Automations: ask the parent admin to RE-RUN one automation (re-dispatch the
 * site's workflow). Resolves with the parent's {@link AutomationRetryResponseMessage} (the
 * admin proxies to `POST /api/sites/:id/automations/:automationId/retry`). DARK behind
 * `site_automations` → `{ok:false, enabled:false}`.
 */
export function requestAutomationRetry(automationId: string): Promise<AutomationRetryResponseMessage> {
  return requestFromParent<AutomationRetryResponseMessage>(
    { type: 'PS_RES_AUTOMATION_RETRY', correlationId: nextBridgeCorrelationId(), automationId },
    'PS_RES_AUTOMATION_RETRY_RESULT',
  );
}

/**
 * Resources → Buckets: one bucket/object management op. Resolves with the parent's
 * {@link R2ResponseMessage} (the admin proxies to `/api/sites/:id/r2/*`). Bytes (upload/download) use
 * {@link requestBucketUpload} / {@link requestBucketDownload}.
 */
export function requestR2(input: Omit<R2RequestMessage, 'type' | 'correlationId'>): Promise<R2ResponseMessage> {
  return requestFromParent<R2ResponseMessage>(
    { type: 'PS_R2', correlationId: nextBridgeCorrelationId(), ...input },
    'PS_R2_RESULT',
  );
}

/** Upload one object to a bucket (base64 data URL). Resolves with the parent's {@link BucketUploadResponseMessage}. */
export function requestBucketUpload(input: {
  bucket: string;
  key: string;
  contentType: string;
  dataUrl: string;
}): Promise<BucketUploadResponseMessage> {
  return requestFromParent<BucketUploadResponseMessage>(
    { type: 'PS_R2_UPLOAD', correlationId: nextBridgeCorrelationId(), ...input },
    'PS_R2_UPLOAD_RESULT',
  );
}

/** Download one object from a bucket. Resolves with the parent's {@link BucketDownloadResponseMessage}. */
export function requestBucketDownload(input: { bucket: string; key: string }): Promise<BucketDownloadResponseMessage> {
  return requestFromParent<BucketDownloadResponseMessage>(
    { type: 'PS_R2_DOWNLOAD', correlationId: nextBridgeCorrelationId(), ...input },
    'PS_R2_DOWNLOAD_RESULT',
  );
}

// ── Initialize ───────────────────────────────────────────────

if (isEmbedded && typeof window !== 'undefined') {
  window.addEventListener('message', handleMessage);

  // Drain any pre-navigation materialization stash into the workbench.
  restoreMaterializedFiles();

  /*
   * ROUTE-INDEPENDENT PS_REQUEST_FILES responder (journey 2026-08-19 — the
   * publish leg of the editor bridge was dead).
   *
   * The only responder lived inside Chat.client.tsx's `useEffect` — a
   * ROUTE-scoped handler. "Click to open Workbench" (or any nav) unmounts
   * the chat route, the handler unsubscribes, and a later admin-side
   * Save & Deploy (`PS_REQUEST_FILES`) reaches an EMPTY handlers array —
   * the editor never replies, the parent times out with "Save timed out",
   * and a user's editor change can never publish. The workbench store is
   * module-global and survives route nav, so answer at this always-on
   * module level instead. Chat.client.tsx's own responder handles
   * `includeChat` (chat export) — keep both; the module responder only
   * guarantees the FILES reply so a publish can never dead-air again.
   */
  onParentMessage((msg) => {
    if (msg.type !== 'PS_REQUEST_FILES') {
      return;
    }

    import('~/lib/stores/workbench')
      .then(({ workbenchStore }) => {
        const textFiles = workbenchStore.getTextFiles();
        postToParent({
          type: 'PS_FILES_READY',
          files: textFiles,
          correlationId: msg.correlationId,
        });
      })
      .catch((err) => {
        console.warn('[embed] PS_REQUEST_FILES responder failed:', err);
      });
  });

  // ── Item 46: hook window-level errors + unhandled rejections ──
  window.addEventListener('error', (event: ErrorEvent) => {
    postErrorToParent({
      code: 'window.onerror',
      message: event.message ?? 'Unknown window error',
      stack: event.error?.stack,
      file: event.filename,
      line: event.lineno,
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled promise rejection';
    const stack = reason instanceof Error ? reason.stack : undefined;
    postErrorToParent({ code: 'window.unhandledrejection', message, stack });
  });

  /*
   * Notify parent that bolt.diy is ready
   * Delay slightly to allow React to mount
   */
  requestAnimationFrame(() => {
    postToParent({ type: 'PS_BOLT_READY' });

    // Item 48: editor.boot_started — first event in the PostHog funnel.
    postTelemetryToParent('editor.boot_started', { embedded: true });
  });
}
