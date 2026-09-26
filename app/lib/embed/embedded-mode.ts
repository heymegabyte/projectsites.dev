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

/**
 * Child → Parent (R2 Browser): ask the admin to proxy a Cloudflare R2 read on
 * behalf of the editor (read-only object inspection — never object bodies).
 *
 * ops: `buckets` (list bucket bindings) · `objects` (prefix + cursor-paged list
 * in `bucket`) · `object` (HEAD metadata for a single `key`).
 */
export interface R2RequestMessage {
  type: 'PS_R2_REQUEST';
  correlationId: string;
  op: 'buckets' | 'objects' | 'object';

  /** Required for `objects` + `object` — the R2 bucket binding name. */
  bucket?: string;

  /** For `objects` — key prefix filter. */
  prefix?: string;

  /** For `objects` — opaque pagination cursor from the previous page. */
  cursor?: string;

  /**
   * For `objects` — grouping delimiter (typically `/`). When set, the response `delimitedPrefixes`
   * lists the "folders" at this level and `objects` holds only the keys AT this level (folder browsing).
   */
  delimiter?: string;

  /** For `object` — the exact object key. */
  key?: string;
}

export interface R2BucketsData {
  buckets: string[];
}

export interface R2ObjectsData {
  objects: R2ObjectDescriptor[];
  cursor?: string;

  /**
   * The "folders" at this level when a delimiter was sent — key-prefixes up to the delimiter, NOT real
   * directories (R2 keys are flat). Clicking one drills in (sets it as the new prefix). May be empty.
   */
  delimitedPrefixes?: string[];
}

export interface R2ObjectData {
  key: string;
  size: number;
  uploaded: string | null;
  contentType: string | null;
  metadata?: unknown;
}

/** Parent → Child (R2 Browser): the admin's reply to {@link R2RequestMessage}. */
export interface R2ResponseMessage {
  type: 'PS_R2_RESPONSE';
  correlationId: string;
  ok: boolean;
  data?: R2BucketsData | R2ObjectsData | R2ObjectData;
  error?: string;
}

/** A Vectorize index summary from the `indexes` op. */
export interface VectorizeIndexSummary {
  name: string;
  dimensions: number | null;
  metric: string | null;
}

/**
 * Child → Parent (Vectorize Browser): ask the admin to proxy a read-only Cloudflare Vectorize
 * inspection (list indexes / describe one). No query / insert / delete is exposed.
 */
export interface VectorizeRequestMessage {
  type: 'PS_VEC_REQUEST';
  correlationId: string;
  op: 'indexes' | 'index';

  /** Required for the `index` op — the index name to describe. */
  name?: string;
}

export interface VectorizeIndexesData {
  indexes: VectorizeIndexSummary[];
  available: boolean;
  reason?: string;
}

export interface VectorizeIndexData {
  found: boolean;
  name: string;
  dimensions: number | null;
  metric: string | null;
  vectorCount: number | null;
  processedUpToMutation: string | null;
  available?: boolean;
  reason?: string;
}

/** Parent → Child (Vectorize Browser): the admin's reply to {@link VectorizeRequestMessage}. */
export interface VectorizeResponseMessage {
  type: 'PS_VEC_RESPONSE';
  correlationId: string;
  ok: boolean;
  data?: VectorizeIndexesData | VectorizeIndexData;
  error?: string;
}

/** A Queue summary from the `queues` op. */
export interface QueueSummary {
  id: string;
  name: string;
  producers: number;
  consumers: number;
}

/** A producer / consumer endpoint bound to a queue. */
export interface QueueEndpoint {
  script?: string | null;
  environment?: string | null;
}

/**
 * Child → Parent (Queues Browser): ask the admin to proxy a read-only Cloudflare Queues inspection
 * (list queues / describe one). No send / purge / ack is exposed.
 */
export interface QueueRequestMessage {
  type: 'PS_QUEUE_REQUEST';
  correlationId: string;
  op: 'queues' | 'queue';

  /** Required for the `queue` op — the queue id to describe. */
  queueId?: string;
}

export interface QueuesData {
  queues: QueueSummary[];
  available: boolean;
  reason?: string;
}

export interface QueueDetailData {
  found: boolean;
  id: string;
  name?: string;
  created?: string | null;
  modified?: string | null;
  settings?: { deliveryDelaySeconds: number | null; messageRetentionSeconds: number | null };
  producers?: QueueEndpoint[];
  consumers?: QueueEndpoint[];
  available?: boolean;
  reason?: string;
}

/** Parent → Child (Queues Browser): the admin's reply to {@link QueueRequestMessage}. */
export interface QueueResponseMessage {
  type: 'PS_QUEUE_RESPONSE';
  correlationId: string;
  ok: boolean;
  data?: QueuesData | QueueDetailData;
  error?: string;
}

/** One D1 database row for the D1 Overview strip. */
export interface D1DatabaseSummary {
  id: string;
  name: string;
  created?: string | null;
  version?: string | null;
}

/**
 * Child → Parent (D1 Overview): ask the admin to proxy a read-only Cloudflare D1 inspection
 * (list databases / one database's Overview metadata). No query / write / restore is exposed.
 */
export interface D1RequestMessage {
  type: 'PS_D1_REQUEST';
  correlationId: string;
  op: 'databases' | 'overview' | 'tables' | 'export' | 'explain' | 'profile' | 'insights';

  /** Required for the `overview` / `tables` / `export` / `explain` / `profile` / `insights` ops — the D1 database UUID. */
  databaseId?: string;

  /** `explain` + `profile` ops: the single table the server re-fetches its DDL by (name only). */
  table?: string;

  /** `export` op: scope the SQL dump to specific tables (fewer ⇒ shorter DB-unavailability). */
  tables?: string[];

  /** `export` op: schema-only / data-only dump (mutually exclusive). */
  schemaOnly?: boolean;
  dataOnly?: boolean;

  /** `export` op: resume an in-progress export (the `bookmark` from a prior `processing` response). */
  currentBookmark?: string;
}

export interface D1DatabasesData {
  databases: D1DatabaseSummary[];
  available: boolean;
  reason?: string;
}

export interface D1OverviewData {
  found: boolean;
  id: string;
  name?: string | null;

  /** On-disk size in bytes, or null when the CF API omits it (never a fabricated 0). */
  fileSize?: number | null;
  numTables?: number | null;
  version?: string | null;
  region?: string | null;
  readReplication?: string | null;
  available?: boolean;
  reason?: string;
}

/** One schema object (table/view/index/trigger) from the D1 schema catalog, with its CREATE SQL. */
export interface D1SchemaObjectSummary {
  type: 'table' | 'view' | 'index' | 'trigger';
  name: string;

  /** The table this object belongs to (`tbl_name`) — equals `name` for tables/views. */
  tableName: string;

  /** The CREATE statement (DDL); null for auto-created objects. */
  sql: string | null;
}

/** Reply to the `tables` op — the read-only schema catalog for one database. */
export interface D1TablesData {
  found: boolean;
  id: string;
  objects: D1SchemaObjectSummary[];
  counts?: { table: number; view: number; index: number; trigger: number };
  available?: boolean;
  reason?: string;
}

/**
 * One column, PARSED CLIENT-SIDE from a table's CREATE SQL (the CF D1 REST `/query` authorizer blocks
 * `PRAGMA table_info`, so the DDL — returned by the catalog — is the column source). `pk` is the
 * 1-based PK position (0 = not part of the PK); >1 on any column reveals a composite key.
 */
export interface D1ColumnInfo {
  cid: number;
  name: string;

  /** Declared type as written in the DDL (may be '' for an untyped SQLite column). */
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  pk: number;

  /**
   * `true` when the column is a GENERATED (computed) column (`… AS (expr) [STORED|VIRTUAL]`). SQLite
   * rejects writing a value to a generated column, so the grid must present it read-only. Optional /
   * defaults to `false` for a plain column.
   */
  generated?: boolean;
}

/**
 * One foreign-key relationship, PARSED CLIENT-SIDE from a table's CREATE SQL (D1's REST `/query`
 * blocks `PRAGMA foreign_key_list`, like `table_info`). Both the table-level `FOREIGN KEY (c)
 * REFERENCES t(x)` and the inline `c … REFERENCES t(x)` forms are captured.
 */
export interface D1ForeignKey {
  /** The local column that references another table. */
  column: string;

  /** The referenced table. */
  refTable: string;

  /** The referenced column, or null when the DDL omits it (⇒ the referenced table's primary key). */
  refColumn: string | null;
}

/** The D1 SQL-dump export result (mirrors the worker's `d1_manager` export response). */
export interface D1ExportData {
  status: 'complete' | 'processing' | 'error' | 'unavailable';

  /** Signed SQL-dump download URL — only when complete (valid ~1h). Never fabricated. */
  signedUrl?: string;
  filename?: string;

  /** Resume token when processing; the export's `at_bookmark` when complete. */
  bookmark?: string;
  messages?: string[];
  reason?: string;

  /** Honest caveat: exporting briefly makes the DB unavailable to serve queries. */
  note: string;
}

/** Parent → Child (`explain` op): the plain-English table summary + the model that wrote it. */
export interface D1ExplainData {
  summary: string;
  model: string;
}

/** One column's profile stats (from the single-scan aggregate). `avg` is null for non-numeric columns. */
export interface D1ColumnProfile {
  name: string;
  type: string;
  nonNull: number;
  nullCount: number;
  distinct: number;
  min: string | null;
  max: string | null;
  avg: number | null;
}

/** Parent → Child (`profile` op): row count + per-column stats + the scan cost (`rowsRead`). */
export interface D1ProfileData {
  rowCount: number;
  columns: D1ColumnProfile[];

  /** Rows the profiling scan READ (D1-billed cost), or null when the runtime omits it. */
  rowsRead: number | null;

  /** True when the table has more columns than were profiled (the rest are omitted). */
  capped: boolean;
}

/** Parent → Child (`insights` op): per-table row counts + structural counts → the overview strip. */
export interface D1InsightsData {
  found: boolean;
  tables: Array<{ name: string; rows: number }>;
  counts: { table: number; view: number; index: number; trigger: number };
  totalRows: number;

  /** True when the database has more tables than were row-counted (the rest are omitted). */
  capped: boolean;
}

/** Parent → Child (D1 Overview): the admin's reply to {@link D1RequestMessage}. */
export interface D1ResponseMessage {
  type: 'PS_D1_RESPONSE';
  correlationId: string;
  ok: boolean;
  data?:
    | D1DatabasesData
    | D1OverviewData
    | D1TablesData
    | D1ExportData
    | D1ExplainData
    | D1ProfileData
    | D1InsightsData;
  error?: string;
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
  | KvResponseMessage
  | R2ResponseMessage
  | VectorizeResponseMessage
  | QueueResponseMessage
  | D1ResponseMessage
  | ViewResponseMessage
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
  | KvRequestMessage
  | R2RequestMessage
  | VectorizeRequestMessage
  | QueueRequestMessage
  | D1RequestMessage
  | ViewRequestMessage
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
