/**
 * @file Data tab — the open project's REAL site data, live. COMPLETELY REDONE
 * (Brian directive 2026-09-08): a proper data browser, not just a row dump.
 *
 * @remarks
 * The embedded editor has no cross-origin projectsites session, so it can't call
 * the authed data API directly. It asks the admin parent frame via the PS_ bridge
 * (`PS_DATA_REQUEST` → admin runs `GET /api/sites/:id/data-overview[/:table]` →
 * `PS_DATA_RESPONSE`), exactly like the publish flow. Standalone bolt.diy (not
 * embedded) has no site context → a clear prompt.
 *
 * Elevated over the first cut: table overview with a live summary + row-count sort;
 * per-table browse with an HONEST "N total · showing latest M" disclosure (never
 * implies the window is all — the silent-cap lesson), an in-table search filter, a
 * CSV export of the current view, a click-to-expand row DETAIL drill-down (every
 * column, pretty-JSON for objects), and an auto-refresh toggle. Pure logic
 * (csv/filter/detail/summary) lives in `data-panel-logic.ts` (unit-tested).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEmbedded, postToParent, onParentMessage } from '~/lib/embed/embedded-mode';
import type { DataOverviewTable, ParentToChildMessage, SavedGridView } from '~/lib/embed/embedded-mode';
import { KvBrowser } from './KvBrowser';
import { R2Browser } from './R2Browser';
import { VectorizeBrowser } from './VectorizeBrowser';
import { QueuesBrowser } from './QueuesBrowser';
import { D1Browser } from './D1Browser';
import {
  iconForTable,
  formatCellValue,
  summarizeTables,
  newCorrelationId,
  columnLabel,
  toCsv,
  isRowActivationKey,
  isDismissKey,
  addToSqlHistory,
  addSavedQuery,
  removeSavedQuery,
  type SavedQuery,
  explainQuery,
  explainPlanHint,
  isExpensiveScan,
  analyzeRowLimit,
  detectChartable,
  buildChartSeries,
  sqlConsoleTarget,
  type QueryTab,
  MAX_QUERY_TABS,
  addQueryTab,
  closeQueryTab,
  updateQueryTabSql,
  type GridSort,
  nextSort,
  sortRows,
  clipboardValue,
  rowJson,
  visibleColumns,
  toggleHiddenColumn,
  coerceCellInput,
  inferCellEditor,
  buildInsertStatement,
  insertableColumns,
  buildDeleteByPk,
  buildBulkDeleteByPk,
  rowPkKey,
  MAX_BULK_DELETE,
  buildUpdateByPk,
  pkFromTableInfo,
  generatedFromTableXinfo,
  browsePageInfo,
  BROWSE_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  clampPageSize,
  sortToParams,
  filtersToParams,
  RowMutationError,
  friendlyModelLabel,
  canAskAi,
  MAX_AI_QUESTION_LEN,
  buildCsvImportPlan,
  CsvImportError,
  type CsvImportPlan,
  type CellInputKind,
  type BoundValue,
  type BrowseFilters,
  type FilterCondition,
  type FilterCombinator,
  FILTER_OP_OPTIONS,
  FILTER_COMBINATORS,
  MAX_FILTER_CONDITIONS,
  filterOpIsValueFree,
  normalizeFilterOp,
  normalizeCombinator,
  addCondition,
  removeCondition,
  updateCondition,
  activeConditions,
  type ViewMode,
  normalizeViewMode,
  galleryTitleField,
  galleryBodyFields,
  kanbanGroupKey,
  groupPageRows,
  buildChartBars,
  recordTitle,
  recordNavigation,
  calendarDateField,
  monthMatrix,
  addCalendarMonth,
  monthFromDayKey,
  viewQueryFingerprint,
} from './data-panel-logic';
import { bucketRowsByDate } from './view-models';
import { CellEditor } from './CellEditor';
import { SqlEditor } from './SqlEditor';
import { classNames } from '~/utils/classNames';
import { classifyCell, columnTypeBadge } from './data-cell-format';
import { JsonTree } from './JsonTree';
import { rowToInsert, rowToUpdateByPk, rowsToMarkdown } from './data-copy-as';
import { computeAggregates } from './data-aggregates';

type Status = 'loading' | 'ready' | 'error' | 'standalone';

const REQUEST_TIMEOUT_MS = 12_000;
const AUTO_REFRESH_MS = 30_000;

/** Debounce before a search box keystroke fires the whole-table (server-side) search. */
const SEARCH_DEBOUNCE_MS = 300;

/** localStorage key for the SQL-console query history (per-browser, best-effort). */
const SQL_HISTORY_KEY = 'ps-data-sql-history';

/** localStorage key for the NAMED saved queries (per-browser, best-effort). */
const SQL_SAVED_KEY = 'ps-data-sql-saved';

/** localStorage key for the open SQL query tabs + which is active (per-browser). */
const SQL_TABS_KEY = 'ps-data-sql-tabs';

/** localStorage key PREFIX for a table's hidden browse columns (`…-<tableKey>`, per-browser). */
const DATA_COLS_KEY = 'ps-data-cols-hidden';

/** Read a table's persisted hidden-column set (best-effort; private-mode / junk → []). */
function readHiddenCols(tableKey: string): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`${DATA_COLS_KEY}-${tableKey}`) : null;
    const parsed = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Rehydrate the SQL console's query tabs from localStorage, falling back to a single
 * default tab seeded with the "list tables" query. Best-effort + defensive: a malformed
 * blob, a private-mode throw, or an empty list all yield the seed tab so the console
 * always opens with at least one usable buffer.
 *
 * @param seedId - a fresh id for the default tab when there's nothing valid to restore
 */
function hydrateQueryTabs(seedId: string): { tabs: QueryTab[]; activeId: string } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SQL_TABS_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;

    if (parsed && Array.isArray(parsed.tabs)) {
      const tabs = (parsed.tabs as unknown[])
        .filter(
          (t): t is QueryTab =>
            !!t &&
            typeof (t as QueryTab).id === 'string' &&
            typeof (t as QueryTab).title === 'string' &&
            typeof (t as QueryTab).sql === 'string',
        )
        .slice(0, MAX_QUERY_TABS);

      if (tabs.length) {
        const activeId =
          typeof parsed.activeId === 'string' && tabs.some((t) => t.id === parsed.activeId)
            ? (parsed.activeId as string)
            : tabs[0].id;
        return { tabs, activeId };
      }
    }
  } catch {
    // ignore — fall through to the seed tab
  }
  return { tabs: [{ id: seedId, title: 'Query 1', sql: LIST_TABLES_SQL }], activeId: seedId };
}

/** `sqlite_master` table/view listing — the D1 manager's "show me every table" query. */
const LIST_TABLES_SQL =
  "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;";

/** Honest write-target descriptor for the SQL console's safety banner (computed once). */
const SQL_TARGET = sqlConsoleTarget();

/** Outerbase-Studio-inspired one-click starters for the read-only console. */
const SQL_STARTERS: ReadonlyArray<{ label: string; query: string }> = [
  { label: 'All tables', query: LIST_TABLES_SQL },
  {
    label: 'Indexes',
    query:
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name;",
  },
  {
    label: 'Schema DDL',
    query: 'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name;',
  },
  {
    /*
     * Full column structure for every table (a real SQLite-editor "Structure" view) via the
     * pragma_table_info table-valued function — name · type · PK · not-null · default, in one SELECT.
     */
    label: 'Columns',
    query: `SELECT m.name AS "table", p.cid, p.name AS "column", p.type, p.pk, p."notnull" AS not_null, p.dflt_value AS default_value FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid;`,
  },
  {
    // Foreign-key relationships across every table via pragma_foreign_key_list.
    label: 'Foreign keys',
    query: `SELECT m.name AS "table", f."from" AS "column", f."table" AS references_table, f."to" AS references_column, f.on_delete, f.on_update FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name;`,
  },
];

/** True when a result row looks like a `sqlite_master` listing → offer a one-click browse. */
const isTableListRow = (r: Record<string, unknown>): boolean =>
  typeof r.name === 'string' && (r.type === 'table' || r.type === 'view' || !('type' in r));

/** Client-side write detection — mirrors the worker's guards so the UI can prompt BEFORE sending. */
const WRITE_RE = /^\s*(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE)\b/i;
const DESTRUCTIVE_RE = /^\s*(DROP|ALTER|TRUNCATE)\b/i;

/** DELETE/UPDATE with no WHERE = whole-table mutation → treated as destructive (type-to-confirm). */
const UNSCOPED_MUT_RE = /^\s*(DELETE\s+FROM|UPDATE)\b(?![\s\S]*\bWHERE\b)/i;
const isWriteSql = (q: string): boolean => WRITE_RE.test(q);
const isDestructiveSql = (q: string): boolean => DESTRUCTIVE_RE.test(q) || UNSCOPED_MUT_RE.test(q);

/** A working CREATE TABLE template the "＋ New table" action drops into the editor (edit, then Run). */
const NEW_TABLE_TEMPLATE =
  'CREATE TABLE my_table (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at INTEGER DEFAULT (unixepoch())\n);';

/** Trigger a client-side file download of `content` (a Blob) — no server round-trip, no bearer needed. */
function triggerDownload(filename: string, content: string, mime: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const DataPanel = memo(() => {
  const [status, setStatus] = useState<Status>(isEmbedded ? 'loading' : 'standalone');
  const [tables, setTables] = useState<DataOverviewTable[]>([]);
  const [overviewError, setOverviewError] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [search, setSearch] = useState('');

  /**
   * Record drawer — a right-side panel showing ALL fields of one row, opened by clicking a gallery or
   * kanban CARD (the grid keeps its inline row-detail). Read-only + copy; one detail surface for the
   * card views. `null` → closed.
   */
  const [drawerRow, setDrawerRow] = useState<Record<string, unknown> | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  /*
   * Client-side column sort of the LOADED browse window (the grid honestly discloses it's
   * showing the latest N). null = original (server) order; a header click cycles asc→desc→off.
   */
  const [browseSort, setBrowseSort] = useState<GridSort | null>(null);

  /*
   * View-only column selection for the browse grid (per-table, localStorage-persisted). Hidden
   * columns are dropped from the GRID render only — the row-detail + CSV/JSON exports keep every
   * column, so hiding never omits data (it's a scan aid for wide tables). `colMenuOpen` toggles
   * the "Columns" checklist dropdown.
   */
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);
  const [colMenuOpen, setColMenuOpen] = useState(false);

  /*
   * Transient "✓ Copied …" flash for clipboard actions (announced via aria-live). A token
   * guards the timeout so a rapid second copy doesn't get cleared by the first's timer.
   */
  const [copied, setCopied] = useState('');
  const copyToken = useRef(0);

  /*
   * D1 manager — read-only SQL console (super-admin only; the sql/exec endpoint reads the shared
   * multi-tenant DB). `canRunSql` arrives on the overview reply; `mode` toggles the console view.
   */
  const [canRunSql, setCanRunSql] = useState(false);
  const [mode, setMode] = useState<'tables' | 'sql' | 'd1' | 'kv' | 'r2' | 'vec' | 'queues'>('tables');

  /*
   * Add-row — a typed row editor that builds a PARAMETERIZED INSERT (values BOUND via ?N, never
   * concatenated) and sends it through the super-admin-gated write path. Only reachable when
   * `canRunSql`. A column left at 'default' is omitted so its DB default / autoincrement applies.
   */
  const [addingRow, setAddingRow] = useState(false);

  // CSV → table import (super-admin write path): paste CSV, preview, import the parameterized batch.
  const [importingCsv, setImportingCsv] = useState(false);
  const [importCsvText, setImportCsvText] = useState('');
  const [addKinds, setAddKinds] = useState<Record<string, CellInputKind | 'default'>>({});
  const [addValues, setAddValues] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const addPending = useRef(false); // an add is in flight → route the next PS_SQL_RESPONSE to the form
  const addTargetRef = useRef<string | null>(null); // the table to re-open on success

  /*
   * Row DELETE — the open table's primary-key column(s) (fetched via PRAGMA table_info when the
   * viewer is a super-admin) power a SAFE single-row DELETE (`buildDeleteByPk`, PK-scoped +
   * parameterized). Empty `browsePkCols` → no Delete affordance (the row stays read-only + we say
   * why). PRAGMA runs on its OWN correlation id so it never clobbers the SQL-console result grid.
   */
  const [browsePkCols, setBrowsePkCols] = useState<string[]>([]);

  /** Declared SQLite type per column name — populated from the PRAGMA table_info reply. */
  const [browseColTypes, setBrowseColTypes] = useState<Record<string, string>>({});

  /**
   * GENERATED (computed) columns of the open table — from `pragma_table_xinfo`'s `hidden` field
   * (2 = VIRTUAL, 3 = STORED generated). SQLite REJECTS writing a generated column's value, so the
   * grid presents them read-only (never a doomed edit) and omits them from INSERT (add/duplicate).
   */
  const [browseGeneratedCols, setBrowseGeneratedCols] = useState<ReadonlySet<string>>(() => new Set<string>());

  /** 0-based row offset of the current browse page (server-side pagination). */
  const [browseOffset, setBrowseOffset] = useState(0);

  /**
   * Rows-per-page (the selector). A ref mirrors it so `requestRows` always reads the CURRENT size even
   * when a size change fires the re-fetch in the same tick (avoids a stale-closure). Persists across
   * tables (a user preference), so a fresh table opens at the chosen size.
   */
  const [browsePageSize, setBrowsePageSize] = useState<number>(BROWSE_PAGE_SIZE);
  const pageSizeRef = useRef<number>(BROWSE_PAGE_SIZE);

  /**
   * Total rows for the CURRENT browse query from the worker (reflects any active `search` filter) — the
   * authoritative denominator for pagination + the "N matches" count. `null` until the first page lands
   * (pageInfo falls back to the overview `row_count`).
   */
  const [browseTotal, setBrowseTotal] = useState<number | null>(null);

  /** Debounce timer for the whole-table (server-side) search box. */
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Multi-condition column filter (worker `filters` JSON + `filterCombinator`) — an AND/OR group of
   * `{col,op,val}` conditions. Empty → no column filter; each condition APPLIES only when its column is
   * chosen AND (its op is value-free OR its value is non-empty) (see {@link activeConditions}). Composes
   * with search + sort.
   */
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [filterCombinator, setFilterCombinator] = useState<FilterCombinator>('AND');

  /**
   * Saved grid views for the OPEN table (the isolated ProjectSites.dev metadata store, fetched via
   * PS_VIEW_REQUEST). A view names the whole-table query (search + filter group + sort); applying one
   * reloads that query in a click. Stored server-side — NEVER in the customer's tables.
   */
  const [savedViews, setSavedViews] = useState<SavedGridView[]>([]);
  const [viewsMenuOpen, setViewsMenuOpen] = useState(false);
  const [viewsBusy, setViewsBusy] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [savingView, setSavingView] = useState(false);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const viewListCid = useRef<string | null>(null);
  const viewSaveCid = useRef<string | null>(null);
  const viewDeleteCid = useRef<string | null>(null);
  const viewUpdateCid = useRef<string | null>(null);

  /**
   * The saved view currently APPLIED (if any) + its query fingerprint at apply time. When the live
   * query drifts from it, the Views control shows a "modified" badge + a one-click Update/Reset (so the
   * owner discovers the Update verb instead of it hiding in the menu).
   */
  const [appliedViewId, setAppliedViewId] = useState<string | null>(null);
  const [appliedFingerprint, setAppliedFingerprint] = useState<string | null>(null);

  /**
   * Whole-query export (CSV/JSON) of ALL rows matching the current search + filter group + sort — NOT
   * just the visible page. The worker bounds it + flags `truncated`; the editor formats + downloads.
   */
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const exportCid = useRef<string | null>(null);
  const exportFormat = useRef<'csv' | 'json'>('csv');

  /**
   * Browse render mode: the dense spreadsheet `grid` (default) or Airtable-style `gallery` cards over
   * the SAME page of rows (honest page-parity with the grid — no extra fetch, no record duplication).
   * `galleryTitleCol` picks the card-title field (null → a sensible default via {@link galleryTitleField}).
   */
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [galleryTitleCol, setGalleryTitleCol] = useState<string | null>(null);

  /**
   * Kanban board: the group-by column (null → pick one first) + the WHOLE-QUERY lane counts fetched from
   * the group-counts endpoint (honest totals; the cards in each lane are the current page's rows). No
   * client-side auto-detect — the owner chooses a status-like column.
   */
  const [kanbanGroupCol, setKanbanGroupCol] = useState<string | null>(null);
  const [kanbanGroups, setKanbanGroups] = useState<Array<{ value: unknown; count: number }>>([]);
  const [kanbanGroupsTruncated, setKanbanGroupsTruncated] = useState(false);
  const [kanbanBusy, setKanbanBusy] = useState(false);
  const kanbanGroupsCid = useRef<string | null>(null);

  /*
   * Calendar view: the date column to place records on (null → auto-detect the first ISO-date column
   * via {@link calendarDateField}) + the visible month `{year, month}` (0-based; null → derive from the
   * page's latest dated row, else the current month). Records are placed by their UTC day — honest
   * page-parity like kanban cards (only the current page's rows, not a whole-table month query).
   */
  const [calendarDateCol, setCalendarDateCol] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<{ year: number; month: number } | null>(null);

  /*
   * The current open table, mirrored into a ref so the mount-only message listener (deps []) reads the
   * LATEST value instead of the stale mount-time closure (the []-deps stale-ref gotcha).
   */
  const activeRef = useRef<string | null>(null);

  /** Debounce timer for the exact-column filter value input. */
  const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pkCid = useRef<string | null>(null); // PRAGMA table_info round-trip id (distinct from the SQL console)
  const deletePending = useRef(false); // a row delete is in flight → route the next PS_SQL_RESPONSE
  const deleteTargetRef = useRef<string | null>(null); // the table to re-open after a delete

  /*
   * Row EDIT (single cell, single row) — reuses the resolved PK to build a `UPDATE … SET "col"=?1
   * WHERE pk=?2` (parameterized). One editor open at a time; a PK column is never editable (it's the
   * predicate). Non-super-admin / no-PK rows have no edit affordance (read-only).
   */
  const [editCol, setEditCol] = useState<string | null>(null); // the column whose inline editor is open
  const [editKind, setEditKind] = useState<CellInputKind>('text');
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const updatePending = useRef(false); // a row edit is in flight → route the next PS_SQL_RESPONSE
  const updateTargetRef = useRef<string | null>(null); // the table to re-open after an edit

  /*
   * BULK row delete — checkbox selection (tracked by stable PK key so it survives re-sort/filter) →
   * one batched parameterized DELETE (capped). Selection CLEARS on every re-fetch/table-switch so a
   * stale id can never be deleted. Super-admin + resolvable-PK only.
   */
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const bulkPending = useRef(false); // a bulk delete is in flight → route the next PS_SQL_RESPONSE
  const bulkTargetRef = useRef<string | null>(null); // the table to re-open after a bulk delete
  const bulkCount = useRef(0); // how many rows the batch targeted (for "deleted X of N" reporting)

  /*
   * Multi-tab SQL console — independent query buffers you can switch between (each keeps
   * its own text). Hydrated once from localStorage via a lazy ref so the three related
   * states (tabs, active id, editor buffer) all initialise from the SAME restored bundle.
   */
  const tabsInit = useRef<{ tabs: QueryTab[]; activeId: string } | null>(null);

  if (tabsInit.current === null) {
    tabsInit.current = hydrateQueryTabs(newCorrelationId());
  }

  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(tabsInit.current.tabs);
  const [activeTabId, setActiveTabId] = useState<string>(tabsInit.current.activeId);
  const [sql, setSql] = useState(
    () => tabsInit.current!.tabs.find((t) => t.id === tabsInit.current!.activeId)?.sql ?? LIST_TABLES_SQL,
  );

  /** Persist the tab set + active id (best-effort; private mode / quota throws are ignored). */
  const persistTabs = useCallback((tabs: QueryTab[], activeId: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SQL_TABS_KEY, JSON.stringify({ tabs, activeId }));
      }
    } catch {
      // ignore — tabs are a convenience, never load-bearing
    }
  }, []);

  /**
   * Change the editor buffer AND mirror it into the active tab (persisted). EVERY buffer
   * change — typing, a starter, a template, a history/saved recall — goes through here so
   * no tab ever silently loses its text when you switch away.
   */
  const updateSql = useCallback(
    (next: string) => {
      setSql(next);

      const updated = updateQueryTabSql(queryTabs, activeTabId, next);
      setQueryTabs(updated);
      persistTabs(updated, activeTabId);
    },
    [queryTabs, activeTabId, persistTabs],
  );

  /*
   * Latest-ref for updateSql so the ONE-TIME (`[]`-deps) parent-message effect can drop
   * AI-generated SQL into the CURRENT tab without capturing a stale queryTabs/activeTabId.
   */
  const updateSqlRef = useRef(updateSql);
  updateSqlRef.current = updateSql;

  /** Switch to a tab — loads its buffer into the editor (never writes the old buffer back). */
  const switchTab = useCallback(
    (id: string) => {
      const t = queryTabs.find((x) => x.id === id);

      if (!t) {
        return;
      }

      setSql(t.sql);
      setActiveTabId(id);
      persistTabs(queryTabs, id);
    },
    [queryTabs, persistTabs],
  );

  /** Open a new empty tab and focus it (no-op at MAX_QUERY_TABS — the strip hides "+"). */
  const addTab = useCallback(() => {
    const { tabs, activeId } = addQueryTab(queryTabs, newCorrelationId(), '');
    setQueryTabs(tabs);
    setActiveTabId(activeId);
    setSql(tabs.find((t) => t.id === activeId)?.sql ?? '');
    persistTabs(tabs, activeId);
  }, [queryTabs, persistTabs]);

  /** Close a tab; the neighbour becomes active (closing the last yields one fresh tab). */
  const closeTab = useCallback(
    (id: string) => {
      const { tabs, activeId } = closeQueryTab(queryTabs, id, newCorrelationId());
      setQueryTabs(tabs);
      setActiveTabId(activeId);
      setSql(tabs.find((t) => t.id === activeId)?.sql ?? '');
      persistTabs(tabs, activeId);
    },
    [queryTabs, persistTabs],
  );
  const [sqlRows, setSqlRows] = useState<Record<string, unknown>[]>([]);
  const [sqlColumns, setSqlColumns] = useState<string[]>([]);

  // Client-side sort of the SQL result grid (honest — it reorders the full returned result).
  const [sqlSort, setSqlSort] = useState<GridSort | null>(null);

  // Query-result mini-chart: whether the chart view is toggled on + which numeric column to plot.
  const [chartOn, setChartOn] = useState(false);
  const [sqlChartCol, setSqlChartCol] = useState<string | null>(null);
  const [sqlError, setSqlError] = useState('');
  const [sqlRunning, setSqlRunning] = useState(false);
  const [sqlMeta, setSqlMeta] = useState<{
    rows: number;
    ms?: number;
    read?: number | null;
    written?: number | null;
  } | null>(null);

  // Write results (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE) — shown as an executed banner, not a grid.
  const [writeResult, setWriteResult] = useState<{ rows_affected: number; last_row_id: number | null } | null>(null);

  // Query history (real-editor staple) — most-recent-first, de-duped, localStorage-backed per browser.
  const [sqlHistory, setSqlHistory] = useState<string[]>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SQL_HISTORY_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : [];

      return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === 'string') : [];
    } catch {
      return [];
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);

  /*
   * Saved queries (NAMED, manual — the reusable-snippet companion to the auto-history).
   * localStorage-backed per browser; dedup-by-name; recall loads into the editor (never auto-runs).
   */
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SQL_SAVED_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : [];

      return Array.isArray(parsed)
        ? parsed.filter((s): s is SavedQuery => !!s && typeof s.name === 'string' && typeof s.query === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const [savedOpen, setSavedOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const overviewCid = useRef<string | null>(null);
  const browseCid = useRef<string | null>(null);
  const sqlCid = useRef<string | null>(null);
  const overviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sqlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * AI SQL assistant — a natural-language question the editor forwards to the worker's
   * super-admin `/sql/nl2sql`; the reply drops SQL into the editor for REVIEW (never auto-run).
   */
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiModel, setAiModel] = useState<string | null>(null); // set once SQL has been dropped in
  const aiCid = useRef<string | null>(null);
  const aiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestOverview = useCallback(() => {
    if (!isEmbedded) {
      return;
    }

    setOverviewError('');

    const cid = newCorrelationId();
    overviewCid.current = cid;

    if (overviewTimer.current) {
      clearTimeout(overviewTimer.current);
    }

    overviewTimer.current = setTimeout(() => {
      if (overviewCid.current === cid) {
        setOverviewError('The editor bridge did not respond. Open this project from the projectsites.dev admin.');
        setStatus('error');
      }
    }, REQUEST_TIMEOUT_MS);
    postToParent({ type: 'PS_DATA_REQUEST', correlationId: cid });
  }, []);

  /**
   * Fire the paginated browse request for `key` at a 0-based `offset` (page size {@link BROWSE_PAGE_SIZE}).
   * Shared by {@link openTable} (offset 0) and {@link goToPage} (page nav) so the correlation-id + timeout
   * handling lives in one place. The admin bridge forwards `offset`/`limit` to the worker's paginated
   * `data-overview/:table` endpoint (server-side LIMIT/OFFSET — the browser never loads the whole table).
   */
  const requestRows = useCallback(
    (key: string, offset: number, sort: GridSort | null, filters: BrowseFilters, withCount: boolean): void => {
      const cid = newCorrelationId(key);
      browseCid.current = cid;

      if (browseTimer.current) {
        clearTimeout(browseTimer.current);
      }

      browseTimer.current = setTimeout(() => {
        if (browseCid.current === cid) {
          setBrowseError('Timed out loading rows.');
          setBrowseLoading(false);
        }
      }, REQUEST_TIMEOUT_MS);

      /*
       * `orderBy`/`dir` (sort) + `search` (OR-of-LIKE) + `filterCol`/`filterVal` (exact-column) all
       * apply WHOLE-table server-side — the worker allowlist-validates the sort + filter columns,
       * parameterizes every value, and reflects the result in `total`. `count:0` SKIPS the server
       * COUNT(*) when only paging/sorting (the total is unchanged → the client reuses its cached
       * total), avoiding an expensive exact count on every nav. All are display requests, never SQL.
       */
      postToParent({
        type: 'PS_DATA_REQUEST',
        table: key,
        offset,
        limit: pageSizeRef.current, // the current rows-per-page (ref → always fresh, no stale closure)
        count: withCount ? 1 : 0,
        ...sortToParams(sort),
        ...filtersToParams(filters),
        correlationId: cid,
      });
    },
    [postToParent],
  );

  const openTable = useCallback(
    (key: string) => {
      setActive(key);
      setRows([]);
      setColumns([]);
      setBrowseError('');
      setSearch('');
      setBrowseSort(null);
      setHiddenCols(readHiddenCols(key)); // restore this table's column selection
      setColMenuOpen(false);
      setBrowseLoading(true);
      setBrowsePkCols([]); // clear the prior table's PK until this one's PRAGMA returns
      setBrowseGeneratedCols(new Set<string>()); // clear the prior table's generated-column set
      setBrowseColTypes({});
      setBrowseOffset(0); // a fresh table opens at the first page
      setBrowseTotal(null); // until the first page lands, pageInfo falls back to the overview count
      setFilterConditions([]); // clear the prior table's column filter group
      setFilterCombinator('AND'); // reset the join to the default
      setViewMode('grid'); // a fresh table opens in the dense grid
      setGalleryTitleCol(null); // and with the default card-title field
      setDrawerRow(null); // close any open record drawer on table switch
      setAppliedViewId(null); // no saved view applied to a freshly-opened table
      setAppliedFingerprint(null);
      setKanbanGroupCol(null); // no kanban group chosen yet
      setKanbanGroups([]);
      setKanbanGroupsTruncated(false);
      setCalendarDateCol(null); // re-auto-detect the date column for the new table
      setCalendarMonth(null); // re-derive the visible month from the new table's data

      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      } // drop a pending search from the prior table

      if (filterTimer.current) {
        clearTimeout(filterTimer.current);
      } // drop a pending column-filter apply

      setSelectedKeys(new Set()); // never carry a bulk selection across a table switch / re-fetch

      requestRows(key, 0, null, { search: '', conditions: [], combinator: 'AND' }, true); // fresh: page 0, count

      /*
       * Super-admins get row DELETE — resolve the PK via PRAGMA table_info on its OWN correlation id
       * (a plain valid identifier only, so the quoted PRAGMA arg is injection-free). Read-only path.
       */
      if (canRunSql && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        const pcid = newCorrelationId(`pk-${key}`);
        pkCid.current = pcid;

        /*
         * `pragma_table_xinfo` via the table-valued-FUNCTION form (a SELECT, not a bare PRAGMA) so it
         * survives the CF D1 REST authorizer's PRAGMA block, AND returns the extra `hidden` field
         * (2/3 = generated) alongside the same cid/name/type/pk/notnull the PK+type parse already read.
         * `key` is a validated bare identifier, so the single-quoted arg is injection-free.
         */
        postToParent({
          type: 'PS_SQL_REQUEST',
          query: `SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo('${key}')`,
          correlationId: pcid,
        });
      }
    },
    [canRunSql, requestRows],
  );

  /**
   * Load a different PAGE of the open table (server-side offset) WITHOUT the full table reset —
   * keeps the column selection / sort / PK + generated sets (same table), only the rows change.
   * Clears the row selection + detail so a stale index can't point past the new page.
   */
  const goToPage = useCallback(
    (nextOffset: number): void => {
      if (!active || nextOffset < 0) {
        return;
      }

      setBrowseOffset(nextOffset);
      setRows([]);
      setBrowseLoading(true);
      setBrowseError('');
      setDrawerRow(null);
      setSelectedKeys(new Set());

      // Page-nav: keep sort+search+filter, and SKIP the count (the total is unchanged → reuse cache).
      requestRows(
        active,
        nextOffset,
        browseSort,
        { search, conditions: filterConditions, combinator: filterCombinator },
        false,
      );
    },
    [active, browseSort, search, filterConditions, filterCombinator, requestRows],
  );

  /*
   * Run ONE statement through the admin bridge (super-admin only). READS → POST /sql/exec;
   * WRITES (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE) → POST /sql/exec-write. Destructive writes
   * (DROP/ALTER, or DELETE/UPDATE without WHERE) get a type-to-confirm BEFORE sending; the worker
   * re-guards server-side (protected-table denylist + confirm). A 403/400 comes back as `sqlError`.
   */
  const runSql = useCallback((query: string, params?: BoundValue[]) => {
    const q = query.trim();

    if (!q || !isEmbedded) {
      return;
    }

    const write = isWriteSql(q);
    let confirmDestructive: boolean | undefined;

    if (write && isDestructiveSql(q)) {
      const ok =
        typeof window !== 'undefined' &&
        window.confirm(
          `This is a DESTRUCTIVE statement and cannot be undone:\n\n${q.slice(0, 300)}\n\nRun it against the live database?`,
        );

      if (!ok) {
        return;
      }

      confirmDestructive = true;
    }

    setSqlError('');
    setWriteResult(null);
    setSqlRunning(true);
    setSqlMeta(null);
    setSqlSort(null); // a fresh result starts in its natural (query) order
    setChartOn(false); // a new query hides the chart until re-toggled
    setSqlChartCol(null);

    const cid = newCorrelationId('sql');
    sqlCid.current = cid;

    if (sqlTimer.current) {
      clearTimeout(sqlTimer.current);
    }

    sqlTimer.current = setTimeout(() => {
      if (sqlCid.current === cid) {
        setSqlError('The editor bridge did not respond.');
        setSqlRunning(false);
      }
    }, REQUEST_TIMEOUT_MS);

    // Record the run in history (on send, so a failed query stays re-runnable). Best-effort persist.
    setSqlHistory((h) => {
      const next = addToSqlHistory(h, q);

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(next));
        }
      } catch {
        /* quota / SSR / private-mode never breaks a query run */
      }

      return next;
    });

    postToParent({
      type: 'PS_SQL_REQUEST',
      query: q,
      correlationId: cid,
      ...(params && params.length ? { params } : {}),
      ...(write ? { write: true, confirm: confirmDestructive } : {}),
    });
  }, []);

  /*
   * Ask AI — translate a natural-language question to SQL via the admin bridge (super-admin only,
   * gated server-side). The reply is dropped into the editor for the user to REVIEW and Run
   * themselves; it is NEVER auto-executed. Honest states: busy spinner, error banner, model label.
   */
  const askAi = useCallback(() => {
    const guard = canAskAi(aiQuestion);

    if (!guard.ok || !isEmbedded) {
      if (guard.reason) {
        setAiError(guard.reason);
      }

      return;
    }

    setAiError('');
    setAiBusy(true);

    const cid = newCorrelationId('nl2sql');
    aiCid.current = cid;

    if (aiTimer.current) {
      clearTimeout(aiTimer.current);
    }

    aiTimer.current = setTimeout(() => {
      if (aiCid.current === cid) {
        setAiError('The editor bridge did not respond.');
        setAiBusy(false);
        aiCid.current = null;
      }
    }, REQUEST_TIMEOUT_MS);

    postToParent({
      type: 'PS_NL2SQL_REQUEST',
      question: aiQuestion.trim(),
      correlationId: cid,
    });
  }, [aiQuestion]);

  const openAddRow = useCallback(() => {
    setAddError('');
    setAddKinds({}); // every column starts at 'default' (omitted) — user opts in per column
    setAddValues({});
    setAddingRow(true);
    setImportingCsv(false); // one write panel at a time
  }, []);

  const openImport = useCallback(() => {
    setImportCsvText('');
    setImportingCsv(true);
    setAddingRow(false);
  }, []);

  /**
   * The parameterized import plan for the pasted CSV → the CURRENT table, or a human error. The plan
   * is chunked (each batch ≤ the exec-write param cap); this UI runs the FIRST batch and honestly
   * discloses when more rows remain (a promise-based bridge for auto-sequencing all batches is a
   * follow-up — see the coverage matrix). Recomputed as the CSV / target table changes.
   */
  const importPlan = useMemo<{ plan: CsvImportPlan | null; error: string | null }>(() => {
    if (!importCsvText.trim() || !active) {
      return { plan: null, error: null };
    }

    try {
      return { plan: buildCsvImportPlan(importCsvText, active), error: null };
    } catch (e) {
      return { plan: null, error: e instanceof CsvImportError ? e.message : 'Could not parse the CSV.' };
    }
  }, [importCsvText, active]);

  /** Import the first parameterized batch through the existing super-admin write rail. */
  const submitImport = useCallback(() => {
    const p = importPlan.plan;

    if (!p || p.batches.length === 0) {
      return;
    }

    // Values are BOUND (batch.params), never concatenated — the write-result banner reports the count.
    runSql(p.batches[0].statement, p.batches[0].params);
    setImportingCsv(false);
    setImportCsvText('');
  }, [importPlan, runSql]);

  const cancelAddRow = useCallback(() => {
    setAddingRow(false);
    setAddError('');
  }, []);

  const setAddKind = useCallback((col: string, kind: CellInputKind | 'default') => {
    setAddError('');
    setAddKinds((prev) => ({ ...prev, [col]: kind }));
  }, []);

  const setAddValue = useCallback((col: string, value: string) => {
    setAddError('');
    setAddValues((prev) => ({ ...prev, [col]: value }));
  }, []);

  /*
   * Columns the user opted to set (kind !== 'default'), in table-column order. Generated columns are
   * excluded defensively — the form no longer offers them, but SQLite rejects inserting one, so never
   * let a stale addKinds entry put a generated column into the INSERT.
   */
  const addActiveCols = useMemo(
    () => insertableColumns(columns, addKinds, browseGeneratedCols),
    [columns, addKinds, browseGeneratedCols],
  );

  /*
   * Live preview of the EXACT parameterized statement we'll send (honest: shows the `?N` SQL + the
   * bound-value count, never the interpolated values). Uses null placeholders for the count so a
   * half-typed number never throws mid-edit.
   */
  const addPreview = useMemo(() => {
    if (!active || addActiveCols.length === 0) {
      return null;
    }

    try {
      const stmt = buildInsertStatement(
        active,
        addActiveCols,
        addActiveCols.map(() => null),
      );

      return { sql: stmt.sql, count: addActiveCols.length };
    } catch {
      return null;
    }
  }, [active, addActiveCols]);

  const submitAddRow = useCallback(() => {
    if (!active) {
      return;
    }

    setAddError('');

    const cols = insertableColumns(columns, addKinds, browseGeneratedCols);

    if (cols.length === 0) {
      setAddError('Set at least one column value to add a row.');

      return;
    }

    let values: BoundValue[];

    try {
      values = cols.map((c) => coerceCellInput(addKinds[c] as CellInputKind, addValues[c] ?? ''));
    } catch (e) {
      setAddError(e instanceof RowMutationError ? e.message : 'Could not read one of the values.');

      return;
    }

    let stmt: { sql: string; params: BoundValue[] };

    try {
      stmt = buildInsertStatement(active, cols, values);
    } catch (e) {
      setAddError(e instanceof RowMutationError ? e.message : 'Could not build the statement.');

      return;
    }

    addPending.current = true;
    addTargetRef.current = active;
    setAddBusy(true);
    runSql(stmt.sql, stmt.params);
  }, [active, columns, addKinds, addValues, browseGeneratedCols, runSql]);

  // Subscribe to PS_DATA_RESPONSE from the admin parent.
  useEffect(() => {
    if (!isEmbedded) {
      return undefined;
    }

    const off = onParentMessage((msg: ParentToChildMessage) => {
      // Saved grid views (metadata store) — match on the list/save/delete correlation ids.
      if (msg.type === 'PS_VIEW_RESPONSE') {
        if (msg.correlationId === viewListCid.current) {
          viewListCid.current = null;
          setViewsBusy(false);

          if (!msg.error && Array.isArray(msg.views)) {
            setSavedViews(msg.views);
          }

          return;
        }

        if (msg.correlationId === viewSaveCid.current) {
          viewSaveCid.current = null;
          setSavingView(false);

          if (!msg.error && msg.view) {
            const saved = msg.view;
            setSaveViewName('');
            setSavedViews((prev) =>
              [...prev.filter((v) => v.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)),
            );
          }

          return;
        }

        if (msg.correlationId === viewUpdateCid.current) {
          viewUpdateCid.current = null;

          if (!msg.error && msg.view) {
            const updated = msg.view;
            setSavedViews((prev) =>
              prev.map((v) => (v.id === updated.id ? updated : v)).sort((a, b) => a.name.localeCompare(b.name)),
            );
          }

          return;
        }

        if (msg.correlationId === viewDeleteCid.current) {
          viewDeleteCid.current = null;

          // On a delete error, reload to undo the optimistic removal; success needs no action.
          if (msg.error && activeRef.current) {
            loadViews(activeRef.current);
          }

          return;
        }

        return;
      }

      // AI SQL assistant reply — drop the generated SQL into the editor for REVIEW (never auto-run).
      if (msg.type === 'PS_NL2SQL_RESPONSE') {
        if (msg.correlationId !== aiCid.current) {
          return;
        }

        if (aiTimer.current) {
          clearTimeout(aiTimer.current);
        }

        aiCid.current = null;
        setAiBusy(false);

        if (msg.error || !msg.ok) {
          setAiError(msg.error || 'Could not generate SQL.');

          return;
        }

        const generated = (msg.sql ?? '').trim();

        if (!generated) {
          setAiError('The assistant did not return any SQL — try rephrasing.');

          return;
        }

        setAiError('');
        setAiModel(msg.model ?? '');
        updateSqlRef.current(generated); // populate the editor — the user reviews + runs it themselves

        return;
      }

      // SQL console reply (D1 manager) — match on the sql correlation id.
      if (msg.type === 'PS_SQL_RESPONSE') {
        /*
         * PRAGMA table_info reply for the browse grid's DELETE affordance — its OWN correlation id,
         * handled BEFORE the SQL-console id check so it never touches the console result grid.
         */
        if (msg.correlationId === pkCid.current) {
          pkCid.current = null;

          if (!msg.error && Array.isArray(msg.rows)) {
            const tableInfoRows = msg.rows as Array<Record<string, unknown>>;
            setBrowsePkCols(pkFromTableInfo(tableInfoRows));

            /*
             * Also extract declared types for columnTypeBadge display + the GENERATED-column set
             * (pragma_table_xinfo `hidden`: 2 = VIRTUAL, 3 = STORED generated — both non-writable).
             */
            const typeMap: Record<string, string> = {};

            for (const row of tableInfoRows) {
              const colName = String(row.name ?? row.column ?? '').trim();
              const colType = String(row.type ?? '').trim();

              if (colName && colType) {
                typeMap[colName] = colType;
              }
            }
            setBrowseColTypes(typeMap);
            setBrowseGeneratedCols(generatedFromTableXinfo(tableInfoRows));
          }

          return;
        }

        if (msg.correlationId !== sqlCid.current) {
          return;
        }

        if (sqlTimer.current) {
          clearTimeout(sqlTimer.current);
        }

        sqlCid.current = null;
        setSqlRunning(false);

        if (msg.error) {
          /*
           * An in-flight Add-row failed → surface the error IN the form (the user is in tables
           * mode; the SQL-tab error banner would be invisible), keep the form open to fix.
           */
          if (addPending.current) {
            addPending.current = false;
            setAddBusy(false);
            setAddError(msg.error);

            return;
          }

          /*
           * A row DELETE failed (e.g. FK constraint) → surface it visibly (the user is in tables
           * mode) and keep the row; never a silent failure.
           */
          if (deletePending.current) {
            deletePending.current = false;

            if (typeof window !== 'undefined') {
              window.alert(`Could not delete the row:\n\n${msg.error}`);
            }

            return;
          }

          /*
           * A BULK delete failed (e.g. a foreign-key constraint) → surface the raw error verbatim
           * (preserves FK detail); the selection stays so the user can adjust. Atomic in SQLite: no
           * rows were deleted, so nothing to refresh.
           */
          if (bulkPending.current) {
            bulkPending.current = false;

            if (typeof window !== 'undefined') {
              window.alert(`Could not delete the selected rows:\n\n${msg.error}`);
            }

            return;
          }

          // A row EDIT failed → surface the error IN the cell editor (keep it open to fix).
          if (updatePending.current) {
            updatePending.current = false;
            setEditBusy(false);
            setEditError(msg.error);

            return;
          }

          setSqlError(msg.needs_confirm ? `${msg.error}` : msg.error);
          setSqlRows([]);
          setSqlColumns([]);
          setWriteResult(null);

          return;
        }

        /*
         * Write result (no columns) → show an "executed" banner instead of an empty grid, and
         * refresh the Tables tab so a CREATE/DROP is reflected there too.
         */
        if (typeof msg.rows_affected === 'number') {
          /*
           * An Add-row succeeded → close + reset the form, refresh counts, and re-open the target
           * table so the new row appears in the grid immediately.
           */
          if (addPending.current) {
            addPending.current = false;
            setAddBusy(false);
            setAddingRow(false);
            setAddKinds({});
            setAddValues({});
            requestOverview();

            const t = addTargetRef.current;

            if (t) {
              openTable(t);
            }

            return;
          }

          /*
           * A row DELETE succeeded → collapse the detail, flash a status, refresh counts, re-open
           * the table so the row is gone from the grid. (Inline flash — flashStatus is defined
           * after this effect, so we set the aria-live line directly via the in-scope token.)
           */
          if (deletePending.current) {
            deletePending.current = false;
            setDrawerRow(null);

            const tok = ++copyToken.current;
            setCopied('Row deleted');
            setTimeout(() => {
              if (copyToken.current === tok) {
                setCopied('');
              }
            }, 1800);
            requestOverview();

            const t = deleteTargetRef.current;

            if (t) {
              openTable(t);
            }

            return;
          }

          /*
           * A BULK delete succeeded → report "deleted X of N" (rows_affected vs the batch size, so a
           * row already gone is counted honestly), clear the selection, refresh the table.
           */
          if (bulkPending.current) {
            bulkPending.current = false;
            setDrawerRow(null);
            setSelectedKeys(new Set());

            const affected = typeof msg.rows_affected === 'number' ? msg.rows_affected : 0;
            const requested = bulkCount.current;
            const tok = ++copyToken.current;
            setCopied(
              affected === requested
                ? `Deleted ${affected} ${affected === 1 ? 'row' : 'rows'}`
                : `Deleted ${affected} of ${requested} (some were already gone)`,
            );
            setTimeout(() => {
              if (copyToken.current === tok) {
                setCopied('');
              }
            }, 2400);
            requestOverview();

            const t = bulkTargetRef.current;

            if (t) {
              openTable(t);
            }

            return;
          }

          /*
           * A row EDIT succeeded → close the cell editor, flash, re-open the table so the new value
           * shows. (Inline flash — flashStatus is defined after this effect; set aria-live directly.)
           */
          if (updatePending.current) {
            updatePending.current = false;
            setEditBusy(false);
            setEditCol(null);
            setDrawerRow(null);

            const tok = ++copyToken.current;
            setCopied('Row updated');
            setTimeout(() => {
              if (copyToken.current === tok) {
                setCopied('');
              }
            }, 1800);
            requestOverview();

            const t = updateTargetRef.current;

            if (t) {
              openTable(t);
            }

            return;
          }

          setSqlColumns([]);
          setSqlRows([]);
          setWriteResult({ rows_affected: msg.rows_affected, last_row_id: msg.last_row_id ?? null });
          setSqlMeta({ rows: msg.rows_affected, ms: msg.duration_ms, read: msg.rows_read, written: msg.rows_written });
          requestOverview();

          return;
        }

        setSqlColumns(msg.columns ?? []);
        setSqlRows(msg.rows ?? []);
        setWriteResult(null);
        setSqlMeta({
          rows: (msg.rows ?? []).length,
          ms: msg.duration_ms,
          read: msg.rows_read,
          written: msg.rows_written,
        });

        return;
      }

      if (msg.type !== 'PS_DATA_RESPONSE') {
        return;
      }

      /*
       * Whole-query export reply — matched on the export cid BEFORE the browse handling so it downloads
       * a file instead of replacing the grid. Uses refs only (mount-only listener → no stale closure).
       */
      // Kanban whole-query lane counts — matched on its own cid (refs only → no stale closure).
      if (msg.correlationId === kanbanGroupsCid.current) {
        kanbanGroupsCid.current = null;
        setKanbanBusy(false);

        if (!msg.error) {
          setKanbanGroups(Array.isArray(msg.data?.groups) ? msg.data.groups : []);
          setKanbanGroupsTruncated(!!msg.data?.truncated);
        }

        return;
      }

      if (msg.correlationId === exportCid.current) {
        exportCid.current = null;
        setExportBusy(false);

        if (msg.error) {
          setExportNote(`Export failed: ${msg.error}`);

          return;
        }

        const exportRows = msg.data?.rows ?? [];
        const exportCols = msg.data?.columns ?? [];
        const fmt = exportFormat.current;
        const content = fmt === 'json' ? JSON.stringify(exportRows, null, 2) : toCsv(exportCols, exportRows);
        triggerDownload(
          `${activeRef.current ?? 'export'}.${fmt}`,
          content,
          fmt === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
        );
        setExportNote(
          msg.data?.truncated
            ? `Exported the first ${exportRows.length.toLocaleString()} rows (capped — narrow with filters for the rest).`
            : `Exported ${exportRows.length.toLocaleString()} row${exportRows.length === 1 ? '' : 's'}.`,
        );

        return;
      }

      // Overview reply (no `table`).
      if (!msg.table && msg.correlationId === overviewCid.current) {
        if (overviewTimer.current) {
          clearTimeout(overviewTimer.current);
        }

        overviewCid.current = null;

        if (msg.error) {
          setOverviewError(msg.error);
          setStatus('error');

          return;
        }

        setTables(msg.data?.tables ?? []);
        setCanRunSql(!!msg.data?.canRunSql);
        setStatus('ready');

        return;
      }

      // Browse reply (matching `table`).
      if (msg.table && msg.correlationId === browseCid.current) {
        if (browseTimer.current) {
          clearTimeout(browseTimer.current);
        }

        browseCid.current = null;
        setBrowseLoading(false);

        if (msg.error) {
          setBrowseError(msg.error);
          return;
        }

        setColumns(msg.data?.columns ?? []);
        setRows(msg.data?.rows ?? []);

        /*
         * The worker's total for THIS query (reflects search/filter) → drives pagination + the "N
         * matches" count. A NUMBER updates it; `null` means the count was SKIPPED for a page-nav/sort
         * request (the total is unchanged), so we KEEP the cached value rather than clobber it.
         */
        setBrowseTotal((prev) => (typeof msg.total === 'number' ? msg.total : prev));
      }
    });

    return off;
  }, []);

  // Kick off the first overview request on mount.
  useEffect(() => {
    setStatus(isEmbedded ? 'loading' : 'standalone');
    requestOverview();

    return () => {
      if (overviewTimer.current) {
        clearTimeout(overviewTimer.current);
      }

      if (browseTimer.current) {
        clearTimeout(browseTimer.current);
      }

      if (sqlTimer.current) {
        clearTimeout(sqlTimer.current);
      }
    };
  }, [requestOverview, openTable]);

  /*
   * Auto-refresh: re-pull the overview (and the open table) on an interval when enabled.
   * Pauses while the tab is hidden — no wasted round-trips.
   */
  useEffect(() => {
    if (!autoRefresh || !isEmbedded) {
      return undefined;
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      requestOverview();

      if (active) {
        postToParent({
          type: 'PS_DATA_REQUEST',
          table: active,
          correlationId: (browseCid.current = newCorrelationId(active)),
        });
      }
    };
    const iv = setInterval(tick, AUTO_REFRESH_MS);

    return () => clearInterval(iv);
  }, [autoRefresh, active, requestOverview]);

  const summary = summarizeTables(tables);
  const totalRows = useMemo(() => tables.reduce((s, t) => s + (t.row_count ?? 0), 0), [tables]);
  const sortedTables = useMemo(() => [...tables].sort((a, b) => (b.row_count ?? 0) - (a.row_count ?? 0)), [tables]);
  const activeTable = tables.find((t) => t.key === active) ?? null;

  /*
   * The conditions that actually filter (the summary count/label in the "· where …" note reflects the
   * WHOLE-TABLE filtered set the worker applies), and a one-line human summary of the group.
   */
  const activeFilterConds = activeConditions(filterConditions);
  const filterApplied = activeFilterConds.length > 0;
  const filterSummary = ((): string => {
    if (activeFilterConds.length === 0) {
      return '';
    }

    if (activeFilterConds.length === 1) {
      const c = activeFilterConds[0];
      const label = FILTER_OP_OPTIONS.find((o) => o.value === normalizeFilterOp(c.op))?.label ?? '=';

      return filterOpIsValueFree(c.op) ? `where ${c.col} ${label}` : `where ${c.col} ${label} “${c.val.trim()}”`;
    }

    return `${activeFilterConds.length} filters (${filterCombinator})`;
  })();

  // The applied saved view + whether the live query has DRIFTED from it (→ show the "modified" badge).
  const appliedView = appliedViewId ? (savedViews.find((v) => v.id === appliedViewId) ?? null) : null;
  const liveFingerprint = viewQueryFingerprint({
    search,
    conditions: filterConditions,
    combinator: filterCombinator,
    sortCol: browseSort?.col ?? null,
    sortDir: browseSort?.dir ?? null,
    type: viewMode,
    titleField: galleryTitleCol,
    groupField: kanbanGroupCol,
    dateField: calendarDateCol,
  });
  const viewModified = !!appliedView && appliedFingerprint !== null && appliedFingerprint !== liveFingerprint;

  /*
   * Schema-aware SQL completion feed — REAL table + column identifiers from the inspected schema
   * (never fabricated). Table keys + the de-duplicated union of every table's columns.
   */
  const sqlSchema = useMemo(
    () => ({
      tables: tables.map((t) => t.key),
      columns: [...new Set(tables.flatMap((t) => t.columns ?? []))],
    }),
    [tables],
  );

  /*
   * Rows arrive ALREADY sorted by the server (browseSort → orderBy/dir), so we do NOT re-sort them
   * client-side — a client re-sort (different NULL/collation ordering) would diverge from the
   * server's page boundaries. `search` still filters THIS page only ("find on this page").
   */
  /*
   * Rows arrive already server-SORTED and server-FILTERED (search runs a whole-table OR-of-LIKE on the
   * worker), so we render them as-is — a client re-filter/re-sort would diverge from the server's page
   * boundaries + match `total`. `search` now drives that server query (see onSearchChange), not a
   * client filter.
   */
  const visibleRows = rows;

  /**
   * Columns the GRID renders — the full set minus the user's hidden selection (view-only;
   *  row-detail + exports still use `columns`).
   */
  const visibleCols = useMemo(() => visibleColumns(columns, hiddenCols), [columns, hiddenCols]);

  /*
   * Calendar derivations (only meaningful in the calendar view): the effective date column (owner pick,
   * else auto-detected first ISO-date column), the current page's rows bucketed by UTC day (wiring the
   * tested `bucketRowsByDate` foundation), and the visible month — owner nav state, else the latest
   * dated row's month, else the current month. Page-parity: only the current page's rows are placed.
   */
  const calendarCol = useMemo(
    () => calendarDateField(visibleCols, visibleRows, calendarDateCol),
    [visibleCols, visibleRows, calendarDateCol],
  );
  const calendarDayMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();

    if (calendarCol) {
      for (const b of bucketRowsByDate(visibleRows, calendarCol, 'day')) {
        map.set(b.bucket, b.rows as Record<string, unknown>[]);
      }
    }

    return map;
  }, [visibleRows, calendarCol]);
  const calendarView = useMemo(() => {
    if (calendarMonth) {
      return calendarMonth;
    }

    // Seed from the latest dated row on the page (bucket keys sort ascending → last is newest).
    const keys = [...calendarDayMap.keys()];
    const fromData = keys.length ? monthFromDayKey(keys[keys.length - 1]) : null;

    if (fromData) {
      return fromData;
    }

    const now = new Date();

    return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  }, [calendarMonth, calendarDayMap]);

  /*
   * Record-drawer prev/next: the open row's position + neighbors WITHIN the current page (`visibleRows`).
   * `drawerRow` is a reference into `visibleRows`, so recordNavigation locates it by identity. Stepping
   * never crosses the page boundary (prev/next are null at the ends — that would need a separate fetch).
   */
  const drawerNav = useMemo(() => recordNavigation(visibleRows, drawerRow), [visibleRows, drawerRow]);

  /**
   * Server-side pagination display (range label) + prev/next availability. Uses the worker's
   * `browseTotal` for THIS query (reflects the search filter) once a page has landed; before that it
   * falls back to the overview `row_count` so the first paint isn't blank.
   */
  const pageInfo = useMemo(
    () => browsePageInfo(browseOffset, rows.length, browseTotal ?? activeTable?.row_count ?? 0),
    [browseOffset, rows.length, browseTotal, activeTable],
  );

  /** Toggle a browse column's visibility (last-column-guarded) + persist per table. */
  const toggleCol = useCallback(
    (col: string) => {
      setHiddenCols((prev) => {
        const next = toggleHiddenColumn(prev, col, columns);

        try {
          if (active && typeof localStorage !== 'undefined') {
            localStorage.setItem(`${DATA_COLS_KEY}-${active}`, JSON.stringify(next));
          }
        } catch {
          /* private mode / quota — hiding is a convenience, never load-bearing */
        }

        return next;
      });
    },
    [columns, active],
  );

  /**
   * Toggle the browse sort for a column (asc→desc→off) + close any open row detail
   *  (its index would otherwise point at a different row once the order changes).
   */
  const toggleBrowseSort = useCallback(
    (col: string) => {
      /*
       * Server-side sort: cycle asc→desc→default, then re-fetch PAGE 0 in the new order (a new sort
       * re-pages the WHOLE table, so the current offset is meaningless). Close the row detail (its
       * index would point at a different row) + clear selection. browseSort still drives the header
       * ▲/▼ indicator; the WORKER allowlist-validates the column before it touches SQL.
       */
      const next = nextSort(browseSort, col);
      setBrowseSort(next);
      setDrawerRow(null);

      if (active) {
        setBrowseOffset(0);
        setRows([]);
        setBrowseLoading(true);
        setBrowseError('');
        setSelectedKeys(new Set());

        // Sort change: keep search+filter, SKIP the count (sorting doesn't change the total).
        requestRows(active, 0, next, { search, conditions: filterConditions, combinator: filterCombinator }, false);
      }
    },
    [browseSort, active, search, filterConditions, filterCombinator, requestRows],
  );

  /**
   * Run the WHOLE-TABLE (server-side) search: reset to page 0 in the current sort with the new needle
   * and re-fetch. The worker runs the parameterized OR-of-LIKE over its allowlisted columns + returns
   * the match `total`. Called debounced from the search box (immediately from Clear).
   */
  const runServerSearch = useCallback(
    (value: string): void => {
      if (!active) {
        return;
      }

      setBrowseOffset(0);
      setRows([]);
      setBrowseLoading(true);
      setBrowseError('');
      setDrawerRow(null);
      setSelectedKeys(new Set());
      requestRows(
        active,
        0,
        browseSort,
        { search: value, conditions: filterConditions, combinator: filterCombinator },
        true,
      ); // search → re-count
    },
    [active, browseSort, filterConditions, filterCombinator, requestRows],
  );

  /** Search-box change: update the input immediately, debounce the whole-table server search. */
  const onSearchChange = useCallback(
    (value: string): void => {
      setSearch(value);
      setDrawerRow(null);

      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }

      searchTimer.current = setTimeout(() => runServerSearch(value), SEARCH_DEBOUNCE_MS);
    },
    [runServerSearch],
  );

  /**
   * Re-run the browse with a specific filter group → reset to page 0 in the current sort + search and
   * re-fetch (re-count). `filtersToParams` serializes only the ACTIVE conditions and joins them by
   * `combinator`; the worker re-validates every column against the allowlist, maps each op to a fixed
   * clause, bounds the count, and parameterizes all values. Callers pass the NEXT group explicitly
   * (computed from the latest state) so a re-fetch never races React's async setState.
   */
  const runFilterGroup = useCallback(
    (conditions: FilterCondition[], combinator: FilterCombinator): void => {
      if (!active) {
        return;
      }

      setBrowseOffset(0);
      setRows([]);
      setBrowseLoading(true);
      setBrowseError('');
      setDrawerRow(null);
      setSelectedKeys(new Set());
      requestRows(active, 0, browseSort, { search, conditions, combinator }, true); // filter → re-count
    },
    [active, browseSort, search, requestRows],
  );

  /** Add a fresh (empty) condition row — no fetch (a blank row filters nothing yet). */
  const addFilterCondition = useCallback((): void => {
    setFilterConditions((prev) => addCondition(prev));
  }, []);

  /** Remove the condition at `index` and re-fetch (dropping a condition can change the result set). */
  const removeFilterCondition = useCallback(
    (index: number): void => {
      setDrawerRow(null);

      if (filterTimer.current) {
        clearTimeout(filterTimer.current);
      }

      const next = removeCondition(filterConditions, index);
      setFilterConditions(next);
      runFilterGroup(next, filterCombinator);
    },
    [filterConditions, filterCombinator, runFilterGroup],
  );

  /** Condition column select: set (or clear) the row's column and re-apply immediately (a discrete change). */
  const onConditionColChange = useCallback(
    (index: number, col: string): void => {
      setDrawerRow(null);

      if (filterTimer.current) {
        clearTimeout(filterTimer.current);
      }

      const next = updateCondition(filterConditions, index, { col: col || null });
      setFilterConditions(next);
      runFilterGroup(next, filterCombinator);
    },
    [filterConditions, filterCombinator, runFilterGroup],
  );

  /** Condition operator select: value-free ops apply instantly; value-ops re-run with the current value. */
  const onConditionOpChange = useCallback(
    (index: number, rawOp: string): void => {
      setDrawerRow(null);

      if (filterTimer.current) {
        clearTimeout(filterTimer.current);
      }

      const op = normalizeFilterOp(rawOp);

      // clear the value when switching to a value-free op so a stale value can't linger in state
      const patch = filterOpIsValueFree(op) ? { op, val: '' } : { op };
      const next = updateCondition(filterConditions, index, patch);
      setFilterConditions(next);
      runFilterGroup(next, filterCombinator);
    },
    [filterConditions, filterCombinator, runFilterGroup],
  );

  /** Condition value input: update immediately, debounce the re-fetch. */
  const onConditionValChange = useCallback(
    (index: number, val: string): void => {
      setDrawerRow(null);

      const next = updateCondition(filterConditions, index, { val });
      setFilterConditions(next);

      if (filterTimer.current) {
        clearTimeout(filterTimer.current);
      }

      filterTimer.current = setTimeout(() => runFilterGroup(next, filterCombinator), SEARCH_DEBOUNCE_MS);
    },
    [filterConditions, filterCombinator, runFilterGroup],
  );

  /** Combinator toggle (AND/OR): re-fetch (only changes results when ≥2 conditions are active). */
  const onCombinatorChange = useCallback(
    (raw: string): void => {
      const combinator = normalizeCombinator(raw);
      setFilterCombinator(combinator);
      setDrawerRow(null);

      if (filterTimer.current) {
        clearTimeout(filterTimer.current);
      }

      runFilterGroup(filterConditions, combinator);
    },
    [filterConditions, runFilterGroup],
  );

  /** Clear the whole filter group (instant, no debounce) — conditions + combinator reset, unfiltered re-fetch. */
  const clearFilter = useCallback((): void => {
    setFilterConditions([]);
    setFilterCombinator('AND');
    setDrawerRow(null);

    if (filterTimer.current) {
      clearTimeout(filterTimer.current);
    }

    runFilterGroup([], 'AND');
  }, [runFilterGroup]);

  // ── Saved grid views (metadata store via PS_VIEW_REQUEST) ──────────────────────────────
  /** Fetch this table's saved views from the org-gated metadata store. */
  const loadViews = useCallback((tableKey: string): void => {
    if (!isEmbedded || !tableKey) {
      return;
    }

    const cid = newCorrelationId('view-list');
    viewListCid.current = cid;
    setViewsBusy(true);
    postToParent({ type: 'PS_VIEW_REQUEST', action: 'list', table: tableKey, correlationId: cid });
  }, []);

  /** Save the CURRENT query (search + filter group + sort) as a named view. */
  const saveCurrentView = useCallback((): void => {
    const name = saveViewName.trim();

    if (!active || !name) {
      return;
    }

    const cid = newCorrelationId('view-save');
    viewSaveCid.current = cid;
    setSavingView(true);

    // Reuse filtersToParams so the persisted `filters` JSON is byte-identical to what the grid sends.
    const params = filtersToParams({ search, conditions: filterConditions, combinator: filterCombinator });
    postToParent({
      type: 'PS_VIEW_REQUEST',
      action: 'save',
      table: active,
      name,
      filters: params.filters ?? '[]',
      combinator: filterCombinator,
      sortCol: browseSort?.col ?? null,
      sortDir: browseSort?.dir ?? null,
      search,

      // Persist the render type + gallery card-title so applying the view restores the whole layout.
      viewType: viewMode,
      viewConfig: {
        ...(galleryTitleCol ? { titleField: galleryTitleCol } : {}),
        ...((viewMode === 'kanban' || viewMode === 'chart') && kanbanGroupCol ? { groupField: kanbanGroupCol } : {}),
        ...(viewMode === 'calendar' && calendarDateCol ? { dateField: calendarDateCol } : {}),
      },
      correlationId: cid,
    });
  }, [
    active,
    saveViewName,
    search,
    filterConditions,
    filterCombinator,
    browseSort,
    viewMode,
    galleryTitleCol,
    kanbanGroupCol,
    calendarDateCol,
  ]);

  /** Delete a saved view (optimistic removal; the list reloads on error). */
  const deleteView = useCallback(
    (id: string): void => {
      if (!active) {
        return;
      }

      const cid = newCorrelationId('view-del');
      viewDeleteCid.current = cid;
      setSavedViews((prev) => prev.filter((v) => v.id !== id));

      // If the deleted view was the applied one, drop the "modified" tracking (the query stays as-is).
      setAppliedViewId((prev) => (prev === id ? null : prev));
      postToParent({ type: 'PS_VIEW_REQUEST', action: 'delete', table: active, viewId: id, correlationId: cid });
    },
    [active],
  );

  /** Overwrite view `id` with a full query payload (used by both "update to current" and "rename"). */
  const sendViewUpdate = useCallback(
    (
      id: string,
      name: string,
      q: {
        filters: string;
        combinator: string;
        sortCol: string | null;
        sortDir: string | null;
        search: string;
        viewType: string;
        viewConfig: { titleField?: string; groupField?: string; dateField?: string };
      },
    ): void => {
      if (!active) {
        return;
      }

      const cid = newCorrelationId('view-upd');
      viewUpdateCid.current = cid;
      postToParent({
        type: 'PS_VIEW_REQUEST',
        action: 'update',
        table: active,
        viewId: id,
        name,
        filters: q.filters,
        combinator: q.combinator,
        sortCol: q.sortCol,
        sortDir: q.sortDir,
        search: q.search,
        viewType: q.viewType,
        viewConfig: q.viewConfig,
        correlationId: cid,
      });
    },
    [active],
  );

  /** Update a saved view to match the CURRENT on-screen query (keeps the view's name). */
  const updateViewToCurrent = useCallback(
    (view: SavedGridView): void => {
      const params = filtersToParams({ search, conditions: filterConditions, combinator: filterCombinator });
      sendViewUpdate(view.id, view.name, {
        filters: params.filters ?? '[]',
        combinator: filterCombinator,
        sortCol: browseSort?.col ?? null,
        sortDir: browseSort?.dir ?? null,
        search,
        viewType: viewMode,
        viewConfig: {
          ...(galleryTitleCol ? { titleField: galleryTitleCol } : {}),
          ...((viewMode === 'kanban' || viewMode === 'chart') && kanbanGroupCol ? { groupField: kanbanGroupCol } : {}),
          ...(viewMode === 'calendar' && calendarDateCol ? { dateField: calendarDateCol } : {}),
        },
      });
    },
    [
      search,
      filterConditions,
      filterCombinator,
      browseSort,
      viewMode,
      galleryTitleCol,
      kanbanGroupCol,
      calendarDateCol,
      sendViewUpdate,
    ],
  );

  /** Rename a saved view — new name, but PRESERVE its stored query (rename must not rewrite the query). */
  const commitRename = useCallback(
    (view: SavedGridView): void => {
      const name = renameValue.trim();

      if (!name) {
        setRenamingViewId(null);
        return;
      }

      sendViewUpdate(view.id, name, {
        filters: JSON.stringify(view.conditions),
        combinator: view.combinator,
        sortCol: view.sortCol,
        sortDir: view.sortDir,
        search: view.search,
        viewType: view.type,
        viewConfig: view.config ?? {},
      });
      setRenamingViewId(null);
    },
    [renameValue, sendViewUpdate],
  );

  /** Apply a saved view — load its search + filter group + sort and re-fetch page 0. */
  const applyView = useCallback(
    (view: SavedGridView): void => {
      if (!active) {
        return;
      }

      const conditions: FilterCondition[] = view.conditions.map((cnd) => ({
        col: cnd.col || null,
        op: cnd.op,
        val: cnd.val,
      }));
      const sort: GridSort | null = view.sortCol ? { col: view.sortCol, dir: view.sortDir ?? 'desc' } : null;
      setSearch(view.search);
      setFilterConditions(conditions);
      setFilterCombinator(view.combinator);
      setBrowseSort(sort);

      /*
       * Restore the saved render type (grid | gallery | kanban | chart | calendar) + gallery/kanban/
       * calendar config (config may be absent on legacy views). normalizeViewMode guards a stale value.
       * A saved calendar view also resets the visible month (null → re-derive from the restored data).
       */
      setViewMode(normalizeViewMode(view.type));
      setGalleryTitleCol(view.config?.titleField ?? null);
      setKanbanGroupCol(view.config?.groupField ?? null);
      setCalendarDateCol(view.config?.dateField ?? null);
      setCalendarMonth(null);

      // Remember which view is applied + its query fingerprint so a later drift shows a "modified" badge.
      setAppliedViewId(view.id);
      setAppliedFingerprint(
        viewQueryFingerprint({
          search: view.search,
          conditions: view.conditions,
          combinator: view.combinator,
          sortCol: view.sortCol,
          sortDir: view.sortDir,
          type: view.type,
          titleField: view.config?.titleField ?? null,
          groupField: view.config?.groupField ?? null,
          dateField: view.config?.dateField ?? null,
        }),
      );
      setViewsMenuOpen(false);
      setBrowseOffset(0);
      setRows([]);
      setBrowseLoading(true);
      setBrowseError('');
      setDrawerRow(null);
      setSelectedKeys(new Set());
      requestRows(active, 0, sort, { search: view.search, conditions, combinator: view.combinator }, true);
    },
    [active, requestRows],
  );

  /*
   * Load the open table's saved views (and close the menu + clear a stale list on table switch).
   * Also mirror `active` into activeRef for the mount-only message listener.
   */
  useEffect(() => {
    activeRef.current = active;
    setViewsMenuOpen(false);
    setExportNote('');
    setRenamingViewId(null);

    if (active) {
      loadViews(active);
    } else {
      setSavedViews([]);
    }
  }, [active, loadViews]);

  /** Fetch the kanban board's WHOLE-QUERY lane counts (honest totals over the current search+filters). */
  const loadKanbanGroups = useCallback((): void => {
    if (!isEmbedded || !active || !kanbanGroupCol) {
      return;
    }

    const cid = newCorrelationId('kanban-groups');
    kanbanGroupsCid.current = cid;
    setKanbanBusy(true);

    const params = filtersToParams({ search, conditions: filterConditions, combinator: filterCombinator });
    postToParent({
      type: 'PS_DATA_REQUEST',
      table: active,
      groupBy: kanbanGroupCol,
      ...(params.search ? { search: params.search } : {}),
      ...(params.filters ? { filters: params.filters } : {}),
      ...(params.filterCombinator ? { filterCombinator: params.filterCombinator } : {}),
      correlationId: cid,
    });
  }, [active, kanbanGroupCol, search, filterConditions, filterCombinator]);

  /*
   * Re-fetch whole-query group counts whenever a grouped view (kanban board OR chart) is shown, the
   * group column changes, or the filters change (so lane/bar totals stay honest to the current query);
   * clear them otherwise. Both views share the same group-counts data + endpoint.
   */
  useEffect(() => {
    if ((viewMode === 'kanban' || viewMode === 'chart') && kanbanGroupCol && active) {
      loadKanbanGroups();
    } else {
      setKanbanGroups([]);
      setKanbanGroupsTruncated(false);
    }
  }, [viewMode, kanbanGroupCol, active, loadKanbanGroups]);

  /*
   * Record-drawer keyboard: Escape closes; ←/→ step to the prev/next record on this page. Arrow-nav is
   * suppressed while a cell is being edited (editCol set) so the arrows move the input caret instead,
   * and re-computes neighbors fresh each keypress (deps include drawerRow/editCol/visibleRows — no stale
   * closure). Stepping cancels any open editor and never crosses the page boundary.
   */
  useEffect(() => {
    if (!drawerRow) {
      return undefined;
    }

    const onKey = (e: KeyboardEvent): void => {
      if (isDismissKey(e.key)) {
        setDrawerRow(null);
        setEditCol(null);

        return;
      }

      if (editCol || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) {
        return;
      }

      const nav = recordNavigation(visibleRows, drawerRow);
      const target = e.key === 'ArrowLeft' ? nav.prev : nav.next;

      if (target) {
        e.preventDefault();
        setDrawerRow(target);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [drawerRow, editCol, visibleRows]);

  /**
   * Rows-per-page change: update the ref (so `requestRows` uses the new size THIS tick) + state, then
   * reset to page 0 (page boundaries shift) and re-fetch keeping the current sort + search + filter.
   */
  const onPageSizeChange = useCallback(
    (size: number): void => {
      const clamped = clampPageSize(size);
      pageSizeRef.current = clamped;
      setBrowsePageSize(clamped);

      if (!active) {
        return;
      }

      setBrowseOffset(0);
      setRows([]);
      setBrowseLoading(true);
      setBrowseError('');
      setDrawerRow(null);
      setSelectedKeys(new Set());

      // Page-size change: same query, SKIP the count (page size doesn't change the total).
      requestRows(active, 0, browseSort, { search, conditions: filterConditions, combinator: filterCombinator }, false);
    },
    [active, browseSort, search, filterConditions, filterCombinator, requestRows],
  );

  /**
   * Write `text` to the clipboard and flash a polite "✓ Copied {label}" confirmation. Fail-soft:
   * a blocked/absent clipboard (insecure context, denied permission) is a no-op — never throws,
   * never a scary error. `writeClipboard` is isolated so a unit/e2e test can spy on it.
   */
  const writeClipboard = useCallback((text: string): void => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable → no-op */
    }
  }, []);

  /** Flash a transient aria-live status line (~1.8s, token-guarded so a rapid second flash wins). */
  const flashStatus = useCallback((message: string): void => {
    const token = ++copyToken.current;
    setCopied(message);
    setTimeout(() => {
      if (copyToken.current === token) {
        setCopied('');
      }
    }, 1800);
  }, []);

  const flashCopied = useCallback((label: string): void => flashStatus(`Copied ${label}`), [flashStatus]);

  /** Copy one cell's RAW value (never the display em-dash); no-op + no flash for an empty cell. */
  const copyValue = useCallback(
    (value: unknown, label: string): void => {
      const text = clipboardValue(value);

      if (!text) {
        return;
      }

      writeClipboard(text);
      flashCopied(label);
    },
    [writeClipboard, flashCopied],
  );

  /** Copy a whole row as pretty JSON — the "grab this record" action. */
  const copyRow = useCallback(
    (row: Record<string, unknown>): void => {
      writeClipboard(rowJson(row));
      flashCopied('row as JSON');
    },
    [writeClipboard, flashCopied],
  );

  /**
   * Permanently delete ONE row by its primary key (super-admin only; the write goes through the
   * gated `/sql/exec-write`). Builds a PK-scoped PARAMETERIZED DELETE, shows the exact statement +
   * bound values in a confirm, then sends it. On success the response handler refreshes the table.
   */
  const deleteRow = useCallback(
    (row: Record<string, unknown>): void => {
      if (!active || browsePkCols.length === 0) {
        return;
      }

      let stmt: { sql: string; params: BoundValue[] };

      try {
        stmt = buildDeleteByPk(active, browsePkCols, row);
      } catch (e) {
        flashStatus(e instanceof RowMutationError ? e.message : 'This row cannot be deleted safely.');

        return;
      }

      const ok =
        typeof window !== 'undefined' &&
        window.confirm(
          `Permanently delete this row? This cannot be undone.\n\n${stmt.sql}\nvalues: ${JSON.stringify(stmt.params)}`,
        );

      if (!ok) {
        return;
      }

      deletePending.current = true;
      deleteTargetRef.current = active;
      runSql(stmt.sql, stmt.params);
    },
    [active, browsePkCols, runSql, flashStatus],
  );

  // Bulk selection is available only to a super-admin on a table with a resolvable PK.
  const selectable = canRunSql && browsePkCols.length > 0;

  /** The stable PK keys of the rows currently on screen that CAN be selected (have a usable PK). */
  const selectableVisibleKeys = useMemo(
    () => (selectable ? visibleRows.map((r) => rowPkKey(r, browsePkCols)).filter((k): k is string => k !== null) : []),
    [selectable, visibleRows, browsePkCols],
  );

  /** True when every selectable row on this page is already selected (drives the header checkbox). */
  const allVisibleSelected = useMemo(
    () => selectableVisibleKeys.length > 0 && selectableVisibleKeys.every((k) => selectedKeys.has(k)),
    [selectableVisibleKeys, selectedKeys],
  );

  /**
   * Aggregates over every cell value in the currently-selected rows (DataGrip/TablePlus-style
   * selection stats). Null when nothing is selected; the footer only renders numeric stats when the
   * selection actually contains numbers, so a text-only selection never shows a meaningless "sum 0".
   */
  const selectionAgg = useMemo(() => {
    if (selectedKeys.size === 0) {
      return null;
    }

    const values = visibleRows
      .filter((r) => {
        const k = rowPkKey(r, browsePkCols);
        return k !== null && selectedKeys.has(k);
      })
      .flatMap((r) => visibleCols.map((c) => r[c]));

    return computeAggregates(values);
  }, [selectedKeys, visibleRows, visibleCols, browsePkCols]);

  const toggleRowSelect = useCallback(
    (row: Record<string, unknown>): void => {
      const key = rowPkKey(row, browsePkCols);

      if (!key) {
        return;
      }

      setSelectedKeys((prev) => {
        const next = new Set(prev);

        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }

        return next;
      });
    },
    [browsePkCols],
  );

  const toggleSelectAll = useCallback((): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      const allOn = selectableVisibleKeys.length > 0 && selectableVisibleKeys.every((k) => next.has(k));

      for (const k of selectableVisibleKeys) {
        if (allOn) {
          next.delete(k);
        } else {
          next.add(k);
        }
      }

      return next;
    });
  }, [selectableVisibleKeys]);

  const clearSelection = useCallback((): void => setSelectedKeys(new Set()), []);

  /**
   * Bulk-delete the selected rows in ONE batched parameterized statement (capped). Confirms with the
   * exact count + statement; on success the response handler reports "deleted X of N" (rows already
   * gone are counted honestly) and refreshes. Selection is by stable PK key, so only rows still on
   * screen + still selected are targeted.
   */
  const bulkDeleteSelected = useCallback((): void => {
    if (!active || selectedKeys.size === 0) {
      return;
    }

    const rows = visibleRows.filter((r) => {
      const k = rowPkKey(r, browsePkCols);
      return k !== null && selectedKeys.has(k);
    });

    if (rows.length === 0) {
      return;
    }

    let stmt: { sql: string; params: BoundValue[] };

    try {
      stmt = buildBulkDeleteByPk(active, browsePkCols, rows);
    } catch (e) {
      flashStatus(e instanceof RowMutationError ? e.message : 'These rows cannot be deleted safely.');
      return;
    }

    const ok =
      typeof window !== 'undefined' &&
      window.confirm(
        `Permanently delete ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}? This cannot be undone.\n\n${stmt.sql}`,
      );

    if (!ok) {
      return;
    }

    bulkPending.current = true;
    bulkTargetRef.current = active;
    bulkCount.current = rows.length;
    runSql(stmt.sql, stmt.params);
  }, [active, selectedKeys, visibleRows, browsePkCols, runSql, flashStatus]);

  /** Open the inline editor for one cell — infer the initial type from the current value, prefill it. */
  const startEdit = useCallback(
    (col: string, rawValue: unknown): void => {
      // A generated (computed) column is not writable — never open an editor on it (no doomed edit).
      if (browseGeneratedCols.has(col)) {
        return;
      }

      setEditError('');
      setEditCol(col);

      const { kind, value } = inferCellEditor(rawValue);
      setEditKind(kind);
      setEditValue(value);
    },
    [browseGeneratedCols],
  );

  /**
   * Duplicate a row — open the Add-row form PREFILLED from this row, with the PRIMARY-KEY column(s)
   * left at 'default' (omitted) so the DB generates a fresh key (no UNIQUE collision). The user
   * reviews + edits + Saves → a normal parameterized INSERT. When the table has no known PK, every
   * column is prefilled (the user clears any unique value before saving).
   */
  const duplicateRow = useCallback(
    (row: Record<string, unknown>): void => {
      const kinds: Record<string, CellInputKind | 'default'> = {};
      const values: Record<string, string> = {};

      for (const col of columns) {
        /*
         * Omit the PK (DB assigns a fresh key) AND any generated column (SQLite computes its value —
         * an INSERT that supplies one is rejected), leaving both at 'default'.
         */
        if (browsePkCols.includes(col) || browseGeneratedCols.has(col)) {
          kinds[col] = 'default';
          continue;
        }

        const { kind, value } = inferCellEditor(row[col]);
        kinds[col] = kind;
        values[col] = value;
      }

      setAddError('');
      setAddKinds(kinds);
      setAddValues(values);
      setAddingRow(true);
      setDrawerRow(null); // close the record drawer; the prefilled Add-row form is at the top
    },
    [columns, browsePkCols, browseGeneratedCols],
  );

  const cancelEdit = useCallback((): void => {
    setEditCol(null);
    setEditError('');
  }, []);

  /**
   * Live preview of the exact parameterized UPDATE for a specific row (SQL shape only — value binds as
   * ?1). Row-parameterized so BOTH the grid detail (its detail row) and the record drawer (`drawerRow`)
   * can preview against the correct record.
   */
  const editPreviewFor = useCallback(
    (row: Record<string, unknown> | null): string | null => {
      if (!active || !editCol || !row) {
        return null;
      }

      try {
        return buildUpdateByPk(active, browsePkCols, row, editCol, null).sql;
      } catch {
        return null;
      }
    },
    [active, editCol, browsePkCols],
  );

  const submitEdit = useCallback(
    (row: Record<string, unknown>): void => {
      if (!active || !editCol) {
        return;
      }

      setEditError('');

      let value: BoundValue;

      try {
        value = coerceCellInput(editKind, editValue);
      } catch (e) {
        setEditError(e instanceof RowMutationError ? e.message : 'Could not read the value.');

        return;
      }

      let stmt: { sql: string; params: BoundValue[] };

      try {
        stmt = buildUpdateByPk(active, browsePkCols, row, editCol, value);
      } catch (e) {
        setEditError(e instanceof RowMutationError ? e.message : 'Could not build the statement.');

        return;
      }

      updatePending.current = true;
      updateTargetRef.current = active;
      setEditBusy(true);
      runSql(stmt.sql, stmt.params);
    },
    [active, editCol, editKind, editValue, browsePkCols, runSql],
  );

  /** The SQL result grid, client-sorted (honest — reorders the full returned result). */
  const sqlVisibleRows = useMemo(() => sortRows(sqlRows, sqlSort), [sqlRows, sqlSort]);

  /** Toggle the SQL result sort for a column (asc→desc→off). */
  const toggleSqlSort = useCallback((col: string) => setSqlSort((s) => nextSort(s, col)), []);

  /*
   * Query-result mini-chart — a chartable result (a label column + numeric column, summary-sized)
   * can be rendered as a zero-dep horizontal bar chart. Pure client-side over the already-fetched
   * rows (no re-query). `chartOn` is reset on each new run (below, in runSql).
   */
  const chartSpec = useMemo(() => detectChartable(sqlColumns, sqlVisibleRows), [sqlColumns, sqlVisibleRows]);
  const chartValueCol = useMemo(
    () =>
      chartSpec && sqlChartCol && chartSpec.valueCols.includes(sqlChartCol)
        ? sqlChartCol
        : (chartSpec?.valueCols[0] ?? null),
    [chartSpec, sqlChartCol],
  );
  const chartData = useMemo(
    () => (chartSpec && chartValueCol ? buildChartSeries(sqlVisibleRows, chartSpec.labelCol, chartValueCol) : []),
    [chartSpec, chartValueCol, sqlVisibleRows],
  );
  const chartMax = useMemo(() => chartData.reduce((m, p) => Math.max(m, p.value), 0), [chartData]);

  /**
   * Export the WHOLE current query (search + filter group + sort) to CSV/JSON — not just the loaded
   * page. Embedded: ask the admin to fetch all matching rows (bounded) via the /export endpoint, then
   * format + download here (the response also carries `truncated` for an honest note). Standalone (no
   * cross-origin session): fall back to the loaded rows, clearly labelled as the visible page.
   */
  const startExport = useCallback(
    (format: 'csv' | 'json'): void => {
      if (!active || !activeTable) {
        return;
      }

      if (!isEmbedded) {
        const content = format === 'json' ? JSON.stringify(visibleRows, null, 2) : toCsv(columns, visibleRows);
        triggerDownload(
          `${activeTable.key}.${format}`,
          content,
          format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
        );
        setExportNote(`Exported ${visibleRows.length.toLocaleString()} loaded rows (standalone preview).`);

        return;
      }

      const cid = newCorrelationId('export');
      exportCid.current = cid;
      exportFormat.current = format;
      setExportBusy(true);
      setExportNote('');

      // Same filter serialization the grid sends → the file matches exactly what's on screen.
      const params = filtersToParams({ search, conditions: filterConditions, combinator: filterCombinator });
      postToParent({
        type: 'PS_DATA_REQUEST',
        table: active,
        exportAll: true,
        ...(params.search ? { search: params.search } : {}),
        ...(params.filters ? { filters: params.filters } : {}),
        ...(params.filterCombinator ? { filterCombinator: params.filterCombinator } : {}),
        ...(browseSort ? { orderBy: browseSort.col, dir: browseSort.dir } : {}),
        correlationId: cid,
      });
    },
    [active, activeTable, columns, visibleRows, search, filterConditions, filterCombinator, browseSort],
  );

  /** Export the SQL-console result grid to CSV (parity with the table-browse export). */
  const exportSqlCsv = useCallback(() => {
    if (typeof document === 'undefined' || sqlColumns.length === 0) {
      return;
    }

    const blob = new Blob([toCsv(sqlColumns, sqlVisibleRows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query-result.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [sqlColumns, sqlVisibleRows]);

  /** Index guidance when the current result is an EXPLAIN QUERY PLAN (null otherwise). */
  const sqlPlanHint = useMemo(() => explainPlanHint(sqlRows), [sqlRows]);

  /** "Bare SELECT with no LIMIT" pre-run guard — offers a bounded first page (see analyzeRowLimit). */
  const rowLimitAdvice = useMemo(() => analyzeRowLimit(sql), [sql]);

  /** Persist the saved-query list to localStorage (best-effort — never breaks a save). */
  const persistSaved = useCallback((next: readonly SavedQuery[]): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SQL_SAVED_KEY, JSON.stringify(next));
      }
    } catch {
      /* quota / SSR / private-mode never breaks the console */
    }
  }, []);

  /** Save the current editor buffer under the entered name (dedup-by-name; recall later). */
  const saveCurrentQuery = useCallback(() => {
    const name = saveName.trim();

    if (!name || !sql.trim()) {
      return;
    }

    setSavedQueries((prev) => {
      const next = addSavedQuery(prev, name, sql);
      persistSaved(next);

      return next;
    });
    setSaveName('');
    setSavedOpen(true);
  }, [saveName, sql, persistSaved]);

  /** Delete a saved query by name. */
  const deleteSavedQuery = useCallback(
    (name: string) => {
      setSavedQueries((prev) => {
        const next = removeSavedQuery(prev, name);
        persistSaved(next);

        return next;
      });
    },
    [persistSaved],
  );

  /*
   * Sub-tab metadata + a single renderer, so the nav can group tabs by SCOPE — this SITE's data
   * vs the GLOBAL platform database + account resources — without duplicating the button. The
   * testids + click behaviour are unchanged (grouping is purely visual).
   */
  const MODE_META = {
    tables: { icon: 'i-ph:table', label: 'Tables' },
    sql: { icon: 'i-ph:terminal-window', label: 'SQL' },
    d1: { icon: 'i-ph:database', label: 'D1' },
    kv: { icon: 'i-ph:key', label: 'KV' },
    r2: { icon: 'i-ph:hard-drives', label: 'R2' },
    vec: { icon: 'i-ph:graph', label: 'Vectors' },
    queues: { icon: 'i-ph:stack', label: 'Queues' },
  } as const;
  const renderModeTab = (m: keyof typeof MODE_META) => (
    <button
      key={m}
      type="button"
      role="tab"
      aria-selected={mode === m}
      data-testid={`data-mode-${m}`}
      onClick={() => {
        setMode(m);

        if (m === 'sql' && !sqlMeta && !sqlRunning && !sqlError) {
          runSql(sql);
        }
      }}
      className={classNames(
        'px-2.5 py-1 cursor-pointer transition-colors flex items-center gap-1',
        mode === m
          ? 'bg-bolt-elements-item-backgroundActive text-bolt-elements-textPrimary'
          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary',
      )}
    >
      <div className={MODE_META[m].icon} />
      {MODE_META[m].label}
    </button>
  );

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 overflow-y-auto modern-scrollbar relative"
      style={{ colorScheme: 'dark' }}
    >
      {/* Clipboard confirmation — a polite live-region toast; visually a small pill, and
          announced to screen readers. Empty (no node rendered) when nothing was just copied. */}
      <div aria-live="polite" className="sr-only" data-testid="data-copy-live">
        {copied}
      </div>
      {copied && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 z-50 rounded-full bg-bolt-elements-item-contentAccent/90 text-bolt-elements-background-depth-1 text-[10px] font-semibold px-2.5 py-1 shadow"
          data-testid="data-copy-toast"
        >
          ✓ {copied}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor">
        <div className="i-ph:database-duotone text-xl text-bolt-elements-textSecondary" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Data</h2>
          <p className="text-[10px] text-bolt-elements-textTertiary">
            {status === 'ready'
              ? `${summary.total} tables · ${summary.populated} with data · ${totalRows.toLocaleString()} rows`
              : status === 'loading'
                ? 'Loading live data…'
                : status === 'standalone'
                  ? 'Open from the admin to view live data'
                  : 'Data unavailable'}
          </p>
        </div>
        {status === 'ready' && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Tables ⇆ SQL (D1 manager) — the console is super-admin-only, so the toggle
                only appears when the admin bridge reported canRunSql. */}
            {canRunSql && (
              <div className="flex items-center gap-2 text-[10px] font-medium" role="tablist" aria-label="Data view">
                {/* Scope 1 — THIS SITE's own data (site_id-scoped rows in the platform D1). */}
                <div className="flex items-center gap-1.5" title="This site's own data">
                  <span className="text-[8px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary/60">
                    Site
                  </span>
                  <div className="flex items-center overflow-hidden rounded-md border border-bolt-elements-borderColor">
                    {renderModeTab('tables')}
                  </div>
                </div>

                <div className="h-4 w-px bg-bolt-elements-borderColor/60" aria-hidden="true" />

                {/* Scope 2 — the GLOBAL platform database + account resources (spans all sites). */}
                <div
                  className="flex items-center gap-1.5"
                  title="The global platform database + account resources (all sites)"
                >
                  <span className="text-[8px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary/60">
                    Platform
                  </span>
                  <div className="flex items-center overflow-hidden rounded-md border border-bolt-elements-borderColor">
                    {(['sql', 'd1', 'kv', 'r2', 'vec', 'queues'] as const).map(renderModeTab)}
                  </div>
                </div>
              </div>
            )}
            {mode === 'tables' && (
              <>
                <button
                  type="button"
                  onClick={() => setAutoRefresh((v) => !v)}
                  data-testid="data-autorefresh"
                  aria-pressed={autoRefresh}
                  title={autoRefresh ? 'Auto-refresh on (30s)' : 'Auto-refresh off'}
                  className={classNames(
                    'text-[10px] flex items-center gap-1 rounded-full px-2 py-0.5 border transition-colors cursor-pointer',
                    autoRefresh
                      ? 'border-green-500/40 bg-green-500/10 text-green-400'
                      : 'border-bolt-elements-borderColor text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary',
                  )}
                >
                  <div className={classNames('i-ph:pulse', autoRefresh && 'animate-pulse')} /> Live
                </button>
                <button
                  type="button"
                  onClick={requestOverview}
                  className="text-[10px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer flex items-center gap-1"
                  title="Refresh"
                >
                  <div className="i-ph:arrow-clockwise" /> Refresh
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Standalone (not embedded) */}
      {status === 'standalone' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="i-ph:plugs text-3xl text-bolt-elements-textTertiary" />
          <p className="text-sm text-bolt-elements-textSecondary">Live data lives with your site</p>
          <p className="text-[11px] text-bolt-elements-textTertiary max-w-xs">
            Open this project from your projectsites.dev admin dashboard to browse its real visitor events, form
            submissions, snapshots and more.
          </p>
        </div>
      )}

      {/* Loading */}
      {status === 'loading' && (
        <div className="p-3 space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-14 rounded-lg bg-bolt-elements-background-depth-2 animate-pulse border border-bolt-elements-borderColor/40"
            />
          ))}
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="i-ph:warning-circle-duotone text-3xl text-red-400" />
          <p className="text-sm text-bolt-elements-textSecondary">{overviewError || 'Could not load data.'}</p>
          <button
            type="button"
            onClick={requestOverview}
            className="px-3 py-1.5 rounded-md text-xs bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 cursor-pointer flex items-center gap-1.5"
          >
            <div className="i-ph:arrow-clockwise" /> Try again
          </button>
        </div>
      )}

      {/* Overview — table cards, row-count sorted */}
      {status === 'ready' && mode === 'tables' && !active && (
        <div className="p-3 space-y-2">
          {sortedTables.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => t.browsable && openTable(t.key)}
              disabled={!t.browsable}
              data-testid={`data-table-${t.key}`}
              className={classNames(
                'w-full text-left border border-bolt-elements-borderColor/50 rounded-lg bg-bolt-elements-background-depth-2 px-3 py-2.5 flex items-center gap-3 transition-colors',
                t.browsable
                  ? 'hover:border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-background-depth-3 cursor-pointer'
                  : 'opacity-70 cursor-default',
              )}
            >
              <div className={classNames(iconForTable(t.key), 'text-xl text-bolt-elements-textSecondary')} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-bolt-elements-textPrimary">{t.label}</div>
                <div className="text-[10px] text-bolt-elements-textTertiary truncate">{t.description}</div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={classNames(
                    'px-1.5 py-px rounded-full text-[10px] font-medium tabular-nums border',
                    t.row_count > 0
                      ? 'bg-green-500/10 text-green-400 border-green-500/20'
                      : 'bg-bolt-elements-background-depth-1 text-bolt-elements-textTertiary border-bolt-elements-borderColor',
                  )}
                >
                  {t.row_count.toLocaleString()} {t.row_count === 1 ? 'row' : 'rows'}
                </span>
                {t.browsable && t.row_count > 0 && <div className="i-ph:caret-right text-bolt-elements-textTertiary" />}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Browse — one table's recent rows */}
      {status === 'ready' && mode === 'tables' && active && activeTable && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor/50">
            <button
              type="button"
              onClick={() => setActive(null)}
              className="text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary cursor-pointer flex items-center gap-1 text-xs"
              title="Back to tables"
            >
              <div className="i-ph:arrow-left" /> Tables
            </button>
            <span className="text-sm font-medium text-bolt-elements-textPrimary">{activeTable.label}</span>
            {/* HONEST paginated disclosure — an explicit "X–Y of N" range with Prev/Next (server-side
                LIMIT/OFFSET); never implies the page is the whole table (silent-cap lesson). When a
                search is active, N is the WHOLE-TABLE match count (server OR-of-LIKE), and the range
                pages through the matches — labelled `matching "<q>"` so it's clearly a table-wide query. */}
            <span
              className="flex items-center gap-1 text-[10px] text-bolt-elements-textTertiary"
              data-testid="data-window-note"
            >
              <button
                type="button"
                onClick={() => goToPage(Math.max(0, browseOffset - browsePageSize))}
                disabled={!pageInfo.hasPrev || browseLoading}
                data-testid="data-page-prev"
                title="Previous page"
                aria-label="Previous page"
                className="rounded px-0.5 py-0.5 hover:text-bolt-elements-textPrimary disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
              >
                <div className="i-ph:caret-left text-[11px]" />
              </button>
              <span data-testid="data-page-range" className="tabular-nums">
                {pageInfo.label}
              </span>
              <button
                type="button"
                onClick={() => goToPage(browseOffset + browsePageSize)}
                disabled={!pageInfo.hasNext || browseLoading}
                data-testid="data-page-next"
                title="Next page"
                aria-label="Next page"
                className="rounded px-0.5 py-0.5 hover:text-bolt-elements-textPrimary disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
              >
                <div className="i-ph:caret-right text-[11px]" />
              </button>
              <select
                value={browsePageSize}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                disabled={browseLoading}
                data-testid="data-page-size"
                aria-label="Rows per page"
                title="Rows per page"
                className="ml-0.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[10px] text-bolt-elements-textPrimary focus:outline-none disabled:opacity-40"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}/page
                  </option>
                ))}
              </select>
              {search ? (
                <span className="truncate max-w-[160px]" title={`Searching the whole table for “${search}”`}>
                  · matching “{search}”
                </span>
              ) : null}
              {filterApplied ? (
                <span
                  className="truncate max-w-[220px]"
                  data-testid="data-filter-note"
                  title={`Filtering the whole table — ${filterSummary}`}
                >
                  · {filterSummary}
                </span>
              ) : null}
            </span>
            {(canRunSql || rows.length > 0) && (
              <div className="ml-auto flex items-center gap-3">
                {/* View mode — dense grid or Airtable-style gallery cards over the SAME page of rows
                    (no extra fetch, no duplication; the gallery is honest page-parity with the grid). */}
                {active && activeTable && activeTable.browsable !== false && rows.length > 0 && (
                  <div
                    className="flex items-center gap-0.5"
                    role="group"
                    aria-label="View mode"
                    data-testid="data-view-mode"
                  >
                    <button
                      type="button"
                      onClick={() => setViewMode('grid')}
                      aria-pressed={viewMode === 'grid'}
                      data-testid="data-view-grid"
                      title="Grid view"
                      className={classNames(
                        'rounded p-1 text-xs transition-colors',
                        viewMode === 'grid'
                          ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                      )}
                    >
                      <div className="i-ph:table" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('gallery')}
                      aria-pressed={viewMode === 'gallery'}
                      data-testid="data-view-gallery"
                      title="Gallery (card) view"
                      className={classNames(
                        'rounded p-1 text-xs transition-colors',
                        viewMode === 'gallery'
                          ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                      )}
                    >
                      <div className="i-ph:squares-four" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('kanban')}
                      aria-pressed={viewMode === 'kanban'}
                      data-testid="data-view-kanban"
                      title="Kanban (board) view — group by a column"
                      className={classNames(
                        'rounded p-1 text-xs transition-colors',
                        viewMode === 'kanban'
                          ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                      )}
                    >
                      <div className="i-ph:kanban" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('chart')}
                      aria-pressed={viewMode === 'chart'}
                      data-testid="data-view-chart"
                      title="Chart view — bar chart of whole-table counts by a column"
                      className={classNames(
                        'rounded p-1 text-xs transition-colors',
                        viewMode === 'chart'
                          ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                      )}
                    >
                      <div className="i-ph:chart-bar" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('calendar')}
                      aria-pressed={viewMode === 'calendar'}
                      data-testid="data-view-calendar"
                      title="Calendar view — place the current page's records on a month grid by a date column"
                      className={classNames(
                        'rounded p-1 text-xs transition-colors',
                        viewMode === 'calendar'
                          ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                      )}
                    >
                      <div className="i-ph:calendar-blank" />
                    </button>
                  </div>
                )}
                {(viewMode === 'kanban' || viewMode === 'chart') && active && rows.length > 0 && columns.length > 0 && (
                  <label
                    className="flex items-center gap-1 text-[10px] text-bolt-elements-textTertiary"
                    data-testid="data-kanban-group-field"
                  >
                    Group by
                    <select
                      value={kanbanGroupCol ?? ''}
                      onChange={(e) => setKanbanGroupCol(e.target.value || null)}
                      aria-label="Kanban group-by field"
                      className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none"
                    >
                      <option value="">Choose column…</option>
                      {columns.map((c) => (
                        <option key={c} value={c}>
                          {columnLabel(c)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {viewMode === 'gallery' && active && rows.length > 0 && columns.length > 0 && (
                  <label
                    className="flex items-center gap-1 text-[10px] text-bolt-elements-textTertiary"
                    data-testid="data-gallery-title-field"
                  >
                    Title
                    <select
                      value={galleryTitleField(columns, galleryTitleCol) ?? ''}
                      onChange={(e) => setGalleryTitleCol(e.target.value || null)}
                      aria-label="Gallery card title field"
                      className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none"
                    >
                      {columns.map((c) => (
                        <option key={c} value={c}>
                          {columnLabel(c)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {viewMode === 'calendar' && active && rows.length > 0 && columns.length > 0 && (
                  <div className="flex items-center gap-2" data-testid="data-calendar-controls">
                    <label className="flex items-center gap-1 text-[10px] text-bolt-elements-textTertiary">
                      Date
                      <select
                        value={calendarCol ?? ''}
                        onChange={(e) => {
                          setCalendarDateCol(e.target.value || null);
                          setCalendarMonth(null); // re-seed the visible month from the new column's data
                        }}
                        aria-label="Calendar date field"
                        data-testid="data-calendar-date-field"
                        className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none"
                      >
                        <option value="">Choose column…</option>
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {columnLabel(c)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setCalendarMonth(addCalendarMonth(calendarView.year, calendarView.month, -1))}
                        data-testid="data-calendar-prev"
                        aria-label="Previous month"
                        title="Previous month"
                        className="i-ph:caret-left cursor-pointer rounded p-0.5 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                      />
                      <span
                        className="min-w-[7.5rem] text-center text-[11px] font-medium text-bolt-elements-textPrimary"
                        data-testid="data-calendar-month-label"
                      >
                        {new Date(Date.UTC(calendarView.year, calendarView.month, 1)).toLocaleDateString(undefined, {
                          month: 'long',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCalendarMonth(addCalendarMonth(calendarView.year, calendarView.month, 1))}
                        data-testid="data-calendar-next"
                        aria-label="Next month"
                        title="Next month"
                        className="i-ph:caret-right cursor-pointer rounded p-0.5 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                      />
                      <button
                        type="button"
                        onClick={() => setCalendarMonth(null)}
                        data-testid="data-calendar-today"
                        title="Jump to the latest dated records (or the current month)"
                        className="rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                )}
                {/* Applied-view drift badge — when a saved view is applied and the live query has drifted,
                    surface "modified" + one-click Update (discoverable) / Reset (re-apply the saved view). */}
                {appliedView && (
                  <div className="flex items-center gap-1 text-[10px]" data-testid="data-applied-view">
                    <span
                      className="max-w-[120px] truncate text-bolt-elements-textSecondary"
                      title={`Applied view: ${appliedView.name}`}
                    >
                      {appliedView.name}
                    </span>
                    {viewModified && (
                      <>
                        <span
                          className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold text-amber-400"
                          data-testid="data-view-modified"
                        >
                          modified
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            updateViewToCurrent(appliedView);
                            setAppliedFingerprint(liveFingerprint);
                          }}
                          data-testid="data-applied-view-update"
                          title="Update this view to the current query"
                          className="rounded bg-[#00e5ff]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#00e5ff] hover:bg-[#00e5ff]/25"
                        >
                          Update
                        </button>
                        <button
                          type="button"
                          onClick={() => applyView(appliedView)}
                          data-testid="data-applied-view-reset"
                          title="Discard changes — re-apply the saved view"
                          className="text-[9px] text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                        >
                          Reset
                        </button>
                      </>
                    )}
                  </div>
                )}
                {/* Saved views — name the current query (search + filter group + sort) and re-apply it in
                    a click. Stored in the isolated ProjectSites.dev metadata store, NEVER in the
                    customer's tables. Hidden for non-browsable tables/views (no query to save). */}
                {active && activeTable && activeTable.browsable !== false && (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setViewsMenuOpen((o) => !o)}
                      data-testid="data-views-toggle"
                      aria-expanded={viewsMenuOpen}
                      aria-haspopup="menu"
                      className="flex cursor-pointer items-center gap-1 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                      title="Saved views for this table"
                    >
                      <div className="i-ph:bookmarks-simple" />
                      Views{savedViews.length > 0 ? ` (${savedViews.length})` : ''}
                      <div className="i-ph:caret-down text-[8px]" />
                    </button>
                    {viewsMenuOpen && (
                      <div
                        className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2 shadow-lg"
                        data-testid="data-views-menu"
                        role="menu"
                      >
                        {viewsBusy ? (
                          <div className="px-1 py-1 text-[11px] text-bolt-elements-textTertiary">Loading…</div>
                        ) : savedViews.length === 0 ? (
                          <div className="px-1 py-1 text-[11px] text-bolt-elements-textTertiary">
                            No saved views yet.
                          </div>
                        ) : (
                          <ul className="mb-2 max-h-48 overflow-auto">
                            {savedViews.map((v) => (
                              <li key={v.id} className="group flex items-center gap-1">
                                {renamingViewId === v.id ? (
                                  <input
                                    autoFocus
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onBlur={() => commitRename(v)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        commitRename(v);
                                      } else if (e.key === 'Escape') {
                                        setRenamingViewId(null);
                                      }
                                    }}
                                    data-testid={`data-view-rename-input-${v.id}`}
                                    aria-label={`Rename view ${v.name}`}
                                    maxLength={80}
                                    spellCheck={false}
                                    className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-1 text-[11px] text-bolt-elements-textPrimary focus:outline-none"
                                  />
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => applyView(v)}
                                    data-testid={`data-view-apply-${v.id}`}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-[11px] text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2"
                                    title={`Apply “${v.name}” (${v.type === 'gallery' ? 'gallery' : 'grid'} view)`}
                                  >
                                    <div
                                      className={classNames(
                                        'shrink-0 text-bolt-elements-textTertiary',
                                        v.type === 'gallery' ? 'i-ph:squares-four' : 'i-ph:table',
                                      )}
                                    />
                                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                                  </button>
                                )}
                                {renamingViewId !== v.id && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => updateViewToCurrent(v)}
                                      data-testid={`data-view-update-${v.id}`}
                                      aria-label={`Update view ${v.name} to the current query`}
                                      title="Update this view to the current filters, sort, search + view mode"
                                      className="i-ph:arrows-clockwise shrink-0 cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-[#00e5ff]"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setRenameValue(v.name);
                                        setRenamingViewId(v.id);
                                      }}
                                      data-testid={`data-view-rename-${v.id}`}
                                      aria-label={`Rename view ${v.name}`}
                                      title="Rename this view"
                                      className="i-ph:pencil-simple shrink-0 cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => deleteView(v.id)}
                                      data-testid={`data-view-delete-${v.id}`}
                                      aria-label={`Delete view ${v.name}`}
                                      title="Delete this view"
                                      className="i-ph:trash shrink-0 cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-red-400"
                                    />
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex items-center gap-1 border-t border-bolt-elements-borderColor/40 pt-2">
                          <input
                            value={saveViewName}
                            onChange={(e) => setSaveViewName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                saveCurrentView();
                              }
                            }}
                            placeholder="Save current view as…"
                            data-testid="data-view-save-name"
                            aria-label="Name for the new saved view"
                            maxLength={80}
                            spellCheck={false}
                            className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={saveCurrentView}
                            disabled={!saveViewName.trim() || savingView}
                            data-testid="data-view-save"
                            className="shrink-0 rounded bg-[#00e5ff]/15 px-2 py-1 text-[11px] font-semibold text-[#00e5ff] hover:bg-[#00e5ff]/25 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {savingView ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Add row — super-admin only (writes go through the gated /sql/exec-write path);
                    hidden for non-browsable tables/views so we never show a doomed control. */}
                {canRunSql && columns.length > 0 && activeTable.browsable !== false && (
                  <button
                    type="button"
                    onClick={openAddRow}
                    data-testid="data-add-row-toggle"
                    aria-expanded={addingRow}
                    className="text-[10px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer flex items-center gap-1"
                    title="Insert a new row with typed values (parameterized — values are bound, never concatenated)"
                  >
                    <div className="i-ph:plus" /> Add row
                  </button>
                )}
                {/* Import CSV — super-admin only; parameterized bulk INSERT into the current table. */}
                {canRunSql && columns.length > 0 && activeTable.browsable !== false && (
                  <button
                    type="button"
                    onClick={openImport}
                    data-testid="data-import-csv-toggle"
                    aria-expanded={importingCsv}
                    className="text-[10px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer flex items-center gap-1"
                    title="Import rows from CSV (parameterized — values are bound, never concatenated)"
                  >
                    <div className="i-ph:upload-simple" /> Import CSV
                  </button>
                )}
                {rows.length > 0 && columns.length > 1 && (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setColMenuOpen((v) => !v)}
                      data-testid="data-cols-toggle"
                      aria-expanded={colMenuOpen}
                      title="Show or hide columns (view only — exports keep every column)"
                      className="text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary cursor-pointer flex items-center gap-1"
                    >
                      <div className="i-ph:columns" /> Columns
                      {hiddenCols.length ? ` (${visibleCols.length}/${columns.length})` : ''}
                    </button>
                    {colMenuOpen && (
                      <div
                        className="absolute right-0 top-full mt-1 z-20 min-w-[160px] max-h-64 overflow-auto rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg p-1"
                        data-testid="data-cols-menu"
                      >
                        {columns.map((c) => {
                          const visible = !hiddenCols.includes(c);
                          const isLastVisible = visible && visibleCols.length <= 1;

                          return (
                            <label
                              key={c}
                              title={isLastVisible ? 'At least one column must stay visible' : undefined}
                              className={classNames(
                                'flex items-center gap-2 px-2 py-1 text-[11px] rounded hover:bg-bolt-elements-background-depth-1',
                                isLastVisible ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={visible}
                                disabled={isLastVisible}
                                onChange={() => toggleCol(c)}
                                data-testid="data-cols-checkbox"
                                className="h-3.5 w-3.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                style={{ accentColor: '#00E5FF' }}
                              />
                              <span className="truncate">{columnLabel(c)}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {rows.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => startExport('csv')}
                      disabled={exportBusy}
                      data-testid="data-export-csv"
                      className="flex cursor-pointer items-center gap-1 text-[10px] text-bolt-elements-item-contentAccent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                      title="Export the WHOLE filtered query to CSV (all matching rows, not just this page)"
                    >
                      <div className="i-ph:download-simple" /> {exportBusy ? 'Exporting…' : 'CSV'}
                    </button>
                    <button
                      type="button"
                      onClick={() => startExport('json')}
                      disabled={exportBusy}
                      data-testid="data-export-json"
                      className="flex cursor-pointer items-center gap-1 text-[10px] text-bolt-elements-item-contentAccent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                      title="Export the WHOLE filtered query to JSON (all matching rows, not just this page)"
                    >
                      <div className="i-ph:download-simple" /> JSON
                    </button>
                  </>
                )}
              </div>
            )}
            {exportNote && (
              <div
                className="px-3 pb-1.5 text-[10px] text-bolt-elements-textTertiary"
                data-testid="data-export-note"
                role="status"
              >
                {exportNote}
              </div>
            )}
          </div>

          {/* Add-row form — typed editors → a parameterized INSERT (values BOUND, never concatenated). */}
          {addingRow && (
            <div
              className="border-b border-bolt-elements-borderColor/50 bg-bolt-elements-background-depth-1 px-3 py-2"
              data-testid="data-add-row-form"
            >
              <div className="mb-2 flex items-center gap-2">
                <div className="i-ph:plus-circle text-bolt-elements-item-contentAccent" />
                <span className="text-xs font-medium text-bolt-elements-textPrimary">
                  Add row to {activeTable.label}
                </span>
                <span className="text-[10px] text-bolt-elements-textTertiary">
                  values are bound as parameters — never concatenated into SQL
                </span>
              </div>

              <div className="max-h-56 space-y-1 overflow-auto pr-1">
                {columns.map((c) => {
                  const kind = addKinds[c] ?? 'default';
                  const disabled = kind === 'default' || kind === 'null';

                  /*
                   * A generated (computed) column can't be inserted — SQLite sets it automatically.
                   * Show it read-only + explained (never a doomed input) instead of an editable row.
                   */
                  if (browseGeneratedCols.has(c)) {
                    return (
                      <div key={c} className="flex items-center gap-2" data-testid="data-add-generated">
                        <span
                          className="w-32 shrink-0 truncate font-mono text-[10px] text-bolt-elements-textSecondary"
                          title={c}
                        >
                          {c}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-amber-300">
                          <span className="rounded bg-amber-500/15 px-1 text-[8px]">computed</span>
                          set automatically by SQLite — not insertable
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div key={c} className="flex items-center gap-2">
                      <span
                        className="w-32 shrink-0 truncate font-mono text-[10px] text-bolt-elements-textSecondary"
                        title={c}
                      >
                        {c}
                      </span>
                      <select
                        value={kind}
                        onChange={(e) => setAddKind(c, e.target.value as CellInputKind | 'default')}
                        data-testid="data-add-kind"
                        aria-label={`Type for ${c}`}
                        className="shrink-0 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[10px] text-bolt-elements-textPrimary focus:outline-none"
                      >
                        <option value="default">default</option>
                        <option value="text">text</option>
                        <option value="number">number</option>
                        <option value="boolean">boolean</option>
                        <option value="null">NULL</option>
                        <option value="json">JSON</option>
                      </select>
                      <input
                        value={addValues[c] ?? ''}
                        onChange={(e) => setAddValue(c, e.target.value)}
                        disabled={disabled}
                        data-testid="data-add-value"
                        aria-label={`Value for ${c}`}
                        placeholder={
                          kind === 'default'
                            ? 'uses column default'
                            : kind === 'null'
                              ? 'NULL'
                              : kind === 'boolean'
                                ? 'true / false'
                                : kind === 'json'
                                  ? '{"key":"value"}'
                                  : ''
                        }
                        spellCheck={false}
                        className={classNames(
                          'min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-0.5 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none',
                          disabled ? 'opacity-40' : '',
                        )}
                      />
                    </div>
                  );
                })}
              </div>

              {addPreview && (
                <div
                  className="mt-2 overflow-x-auto rounded bg-bolt-elements-background-depth-2 px-2 py-1 font-mono text-[10px] text-bolt-elements-textTertiary"
                  data-testid="data-add-preview"
                >
                  {addPreview.sql}
                  <span className="ml-1 text-bolt-elements-textSecondary">
                    · {addPreview.count} value{addPreview.count === 1 ? '' : 's'} bound
                  </span>
                </div>
              )}

              {addError && (
                <p className="mt-2 text-[11px] text-red-400" role="alert" data-testid="data-add-error">
                  {addError}
                </p>
              )}

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={submitAddRow}
                  disabled={addBusy || addActiveCols.length === 0}
                  data-testid="data-add-submit"
                  className={classNames(
                    'rounded px-2.5 py-1 text-[11px] font-medium',
                    addBusy || addActiveCols.length === 0
                      ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
                      : 'cursor-pointer bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:opacity-90',
                  )}
                >
                  {addBusy ? 'Adding…' : 'Add row'}
                </button>
                <button
                  type="button"
                  onClick={cancelAddRow}
                  disabled={addBusy}
                  data-testid="data-add-cancel"
                  className="cursor-pointer text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Import CSV → the current table (parameterized bulk INSERT via the super-admin write rail). */}
          {importingCsv && (
            <div
              className="border-b border-bolt-elements-borderColor/50 bg-bolt-elements-background-depth-1 px-3 py-2"
              data-testid="data-import-csv-form"
            >
              <div className="mb-2 flex items-center gap-2">
                <div className="i-ph:upload-simple text-bolt-elements-item-contentAccent" />
                <span className="text-xs font-medium text-bolt-elements-textPrimary">
                  Import CSV into {activeTable.label}
                </span>
                <span className="text-[10px] text-bolt-elements-textTertiary">
                  header row = column names · values bound as parameters, never concatenated
                </span>
              </div>

              <textarea
                value={importCsvText}
                onChange={(e) => setImportCsvText(e.target.value)}
                placeholder={`${columns.slice(0, 3).join(',') || 'col_a,col_b'}\nvalue,value,…`}
                data-testid="data-import-csv-input"
                rows={5}
                spellCheck={false}
                className="w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 font-mono text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
              />

              {importPlan.error && (
                <p className="mt-2 text-[11px] text-red-400" role="alert" data-testid="data-import-error">
                  {importPlan.error}
                </p>
              )}

              {importPlan.plan && (
                <div
                  className="mt-2 overflow-x-auto rounded bg-bolt-elements-background-depth-2 px-2 py-1 text-[10px] text-bolt-elements-textTertiary"
                  data-testid="data-import-preview"
                >
                  {importPlan.plan.rowCount.toLocaleString()} row
                  {importPlan.plan.rowCount === 1 ? '' : 's'} · {importPlan.plan.columns.length} column
                  {importPlan.plan.columns.length === 1 ? '' : 's'} ({importPlan.plan.columns.join(', ')})
                  {importPlan.plan.batches.length > 1 && (
                    <span className="text-amber-300">
                      {' '}
                      · only the first {importPlan.plan.batches[0].rowCount.toLocaleString()} rows import per run
                      (parameterized-write limit) — import, then re-run with the remaining rows
                    </span>
                  )}
                  <div
                    className="mt-1 truncate font-mono text-bolt-elements-textSecondary"
                    title={importPlan.plan.batches[0].statement}
                  >
                    {importPlan.plan.batches[0].statement}
                  </div>
                </div>
              )}

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={submitImport}
                  disabled={!importPlan.plan || sqlRunning}
                  data-testid="data-import-submit"
                  className={classNames(
                    'rounded px-2.5 py-1 text-[11px] font-medium',
                    !importPlan.plan || sqlRunning
                      ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
                      : 'cursor-pointer bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:opacity-90',
                  )}
                >
                  {importPlan.plan
                    ? `Import ${importPlan.plan.batches[0].rowCount.toLocaleString()} row${importPlan.plan.batches[0].rowCount === 1 ? '' : 's'}`
                    : 'Import'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImportingCsv(false);
                    setImportCsvText('');
                  }}
                  data-testid="data-import-cancel"
                  className="cursor-pointer text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Whole-table search — server-side OR-of-LIKE (debounced); stays visible when a search
              returns 0 rows so it can be refined/cleared. */}
          {(rows.length > 0 || search) && (
            <div className="px-3 py-1.5 border-b border-bolt-elements-borderColor/30">
              <div className="flex items-center gap-2 rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-2 py-1">
                <div className="i-ph:magnifying-glass text-bolt-elements-textTertiary text-xs" />
                <input
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder={`Search all ${activeTable.label.toLowerCase()}…`}
                  data-testid="data-search"
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-transparent text-xs text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');

                      if (searchTimer.current) {
                        clearTimeout(searchTimer.current);
                      }

                      runServerSearch(''); // clear is instant — no debounce
                    }}
                    className="i-ph:x text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary text-xs cursor-pointer"
                    title="Clear search"
                  />
                )}
              </div>
            </div>
          )}

          {/* Multi-condition column filter — worker `filters` JSON + `filterCombinator` (each leaf:
              allowlist-validated column, fixed operator clause, parameterized value). An AND/OR group of
              conditions composing with search + sort. Value-ops apply when a value is present; the
              value-free is-null / is-not-null ops apply on the column alone (the value box is hidden).
              Stays visible while any condition exists so a 0-result filter can be changed/cleared. */}
          {columns.length > 0 && (rows.length > 0 || filterConditions.length > 0) && (
            <div className="px-3 py-1.5 border-b border-bolt-elements-borderColor/30 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <div className="i-ph:funnel text-bolt-elements-textTertiary text-xs shrink-0" />
                <span className="text-[11px] text-bolt-elements-textTertiary">Filter</span>
                {filterConditions.length >= 2 && (
                  <div
                    className="ml-1 flex items-center gap-0.5"
                    data-testid="data-filter-combinator"
                    role="group"
                    aria-label="Join conditions with AND or OR"
                  >
                    {FILTER_COMBINATORS.map((comb) => (
                      <button
                        key={comb}
                        type="button"
                        onClick={() => onCombinatorChange(comb)}
                        aria-pressed={filterCombinator === comb}
                        className={classNames(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors',
                          filterCombinator === comb
                            ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                            : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                        )}
                      >
                        {comb}
                      </button>
                    ))}
                  </div>
                )}
                {filterApplied && (
                  <button
                    type="button"
                    onClick={clearFilter}
                    data-testid="data-filter-clear"
                    className="ml-auto text-[10px] text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                  >
                    Clear all
                  </button>
                )}
              </div>

              {filterConditions.map((cond, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-9 shrink-0 text-right text-[10px] lowercase text-bolt-elements-textTertiary">
                    {i === 0 ? 'where' : filterCombinator}
                  </span>
                  <select
                    value={cond.col ?? ''}
                    onChange={(e) => onConditionColChange(i, e.target.value)}
                    data-testid={`data-filter-col-${i}`}
                    aria-label={`Filter ${i + 1} column`}
                    className="shrink-0 max-w-[34%] truncate rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none"
                  >
                    <option value="">Column…</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {cond.col && (
                    <>
                      <select
                        value={normalizeFilterOp(cond.op)}
                        onChange={(e) => onConditionOpChange(i, e.target.value)}
                        data-testid={`data-filter-op-${i}`}
                        aria-label={`Filter ${i + 1} operator`}
                        className="shrink-0 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none"
                      >
                        {FILTER_OP_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {filterOpIsValueFree(cond.op) ? (
                        <span
                          className="min-w-0 flex-1 truncate text-[11px] italic text-bolt-elements-textTertiary"
                          data-testid={`data-filter-valuefree-${i}`}
                        >
                          no value needed
                        </span>
                      ) : (
                        <input
                          value={cond.val}
                          onChange={(e) => onConditionValChange(i, e.target.value)}
                          placeholder="value…"
                          data-testid={`data-filter-val-${i}`}
                          aria-label={`Filter ${i + 1} value`}
                          spellCheck={false}
                          className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-0.5 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
                        />
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => removeFilterCondition(i)}
                    data-testid={`data-filter-remove-${i}`}
                    aria-label={`Remove filter ${i + 1}`}
                    title="Remove this condition"
                    className="i-ph:x shrink-0 cursor-pointer text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                  />
                </div>
              ))}

              {filterConditions.length < MAX_FILTER_CONDITIONS && (
                <button
                  type="button"
                  onClick={addFilterCondition}
                  data-testid="data-filter-add"
                  className="flex items-center gap-1 text-[11px] text-[#00e5ff]/80 hover:text-[#00e5ff]"
                >
                  <span className="i-ph:plus text-[10px]" />
                  {filterConditions.length === 0 ? 'Add filter' : 'Add condition'}
                </button>
              )}
            </div>
          )}

          {browseLoading && (
            <div className="p-3 space-y-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-7 rounded bg-bolt-elements-background-depth-2 animate-pulse" />
              ))}
            </div>
          )}

          {!browseLoading && browseError && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="i-ph:warning-circle-duotone text-2xl text-red-400" />
              <p className="text-xs text-bolt-elements-textSecondary">{browseError}</p>
              <button
                type="button"
                onClick={() => openTable(active)}
                className="text-[11px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!browseLoading && !browseError && rows.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <div className={classNames(iconForTable(active), 'text-2xl text-bolt-elements-textTertiary')} />
              <p className="text-xs text-bolt-elements-textSecondary">No rows yet</p>
              <p className="text-[10px] text-bolt-elements-textTertiary">
                Rows appear here as your site collects {activeTable.label.toLowerCase()}.
              </p>
            </div>
          )}

          {!browseLoading && !browseError && rows.length > 0 && visibleRows.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="i-ph:magnifying-glass text-2xl text-bolt-elements-textTertiary" />
              <p className="text-xs text-bolt-elements-textSecondary">No rows match “{search}”</p>
            </div>
          )}

          {/* Bulk action bar — appears once rows are selected (super-admin + resolvable PK). */}
          {selectable && selectedKeys.size > 0 && (
            <div
              className="flex items-center gap-3 px-3 py-1.5 border-b border-bolt-elements-borderColor/30 bg-bolt-elements-background-depth-1"
              data-testid="data-bulk-bar"
            >
              <span className="text-[11px] text-bolt-elements-textSecondary">
                {selectedKeys.size} selected{selectedKeys.size >= MAX_BULK_DELETE ? ` (max ${MAX_BULK_DELETE})` : ''}
              </span>
              {selectionAgg && selectionAgg.numericCount > 0 && (
                <span
                  className="text-[11px] text-bolt-elements-textTertiary tabular-nums"
                  data-testid="data-agg-footer"
                  title={`${selectionAgg.numericCount} of ${selectionAgg.count} selected cells are numeric`}
                >
                  sum <b style={{ color: '#00E5FF' }}>{selectionAgg.sum}</b>
                  {' · '}avg <b style={{ color: '#00E5FF' }}>{selectionAgg.avg}</b>
                  {' · '}min <b style={{ color: '#00E5FF' }}>{selectionAgg.min}</b>
                  {' · '}max <b style={{ color: '#00E5FF' }}>{selectionAgg.max}</b>
                </span>
              )}
              <button
                type="button"
                onClick={bulkDeleteSelected}
                data-testid="data-bulk-delete"
                className="flex items-center gap-1 text-[10px] rounded px-2 py-0.5 border border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/70 cursor-pointer"
              >
                <div className="i-ph:trash text-[11px]" /> Delete selected
              </button>
              <button
                type="button"
                onClick={clearSelection}
                data-testid="data-bulk-clear"
                className="text-[10px] text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary cursor-pointer"
              >
                Clear
              </button>
            </div>
          )}

          {!browseLoading && !browseError && visibleRows.length > 0 && viewMode === 'grid' && (
            <div className="flex-1 overflow-auto modern-scrollbar">
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-bolt-elements-background-depth-2 z-10">
                  <tr>
                    {selectable && (
                      <th className="w-8 border-b border-bolt-elements-borderColor/50 px-2 py-1.5 align-middle">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAll}
                          data-testid="data-bulk-select-all"
                          aria-label="Select all rows on this page"
                          title="Select all rows on this page"
                          className="h-3.5 w-3.5 cursor-pointer align-middle"
                          style={{ accentColor: '#00E5FF' }}
                        />
                      </th>
                    )}
                    {visibleCols.map((c) => (
                      <th
                        key={c}
                        aria-sort={
                          browseSort?.col === c ? (browseSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                        }
                        className="text-left font-medium text-bolt-elements-textTertiary border-b border-bolt-elements-borderColor/50 whitespace-nowrap p-0"
                      >
                        <button
                          type="button"
                          onClick={() => toggleBrowseSort(c)}
                          data-testid="data-browse-sort"
                          title={`Sort by ${columnLabel(c)}`}
                          className="w-full flex items-center gap-1 px-3 py-1.5 text-left hover:text-bolt-elements-textPrimary cursor-pointer"
                        >
                          <span className="truncate">{columnLabel(c)}</span>
                          {(() => {
                            const badge = columnTypeBadge(browseColTypes[c]);
                            return badge ? (
                              <span
                                className="shrink-0 rounded px-1 py-px text-[8px] font-mono font-medium bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary/70 border border-bolt-elements-borderColor/30"
                                title={badge.title}
                                aria-label={`Type: ${badge.title}`}
                              >
                                {badge.label}
                              </span>
                            ) : null;
                          })()}
                          <span
                            aria-hidden="true"
                            className={classNames(
                              'shrink-0 text-[8px]',
                              browseSort?.col === c
                                ? 'text-bolt-elements-item-contentAccent'
                                : 'text-bolt-elements-textTertiary/40',
                              browseSort?.col === c && browseSort.dir === 'desc'
                                ? 'i-ph:caret-down-bold'
                                : 'i-ph:caret-up-bold',
                            )}
                          />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r, i) => (
                    <tr
                      key={i}
                      onClick={() => setDrawerRow(r)}
                      onKeyDown={(e) => {
                        /*
                         * Enter/Space opens this row in the record drawer (WCAG 2.1.1 parity with the
                         * click). Space would otherwise scroll the table body — prevent that. Escape is
                         * owned by the drawer's own handler once it's open, so the row needs none.
                         */
                        if (isRowActivationKey(e.key)) {
                          e.preventDefault();
                          setDrawerRow(r);
                        }
                      }}
                      tabIndex={0}
                      aria-haspopup="dialog"
                      aria-label={`Open record ${i + 1} of ${visibleRows.length}`}
                      data-testid="data-row"
                      className="border-b border-bolt-elements-borderColor/20 cursor-pointer hover:bg-bolt-elements-background-depth-2/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent"
                    >
                      {selectable && (
                        <td
                          className="w-8 px-2 py-1.5 align-top"
                          onClick={(e) => e.stopPropagation()} // the checkbox toggles selection, not the row detail
                        >
                          <input
                            type="checkbox"
                            checked={rowPkKey(r, browsePkCols) !== null && selectedKeys.has(rowPkKey(r, browsePkCols)!)}
                            disabled={rowPkKey(r, browsePkCols) === null}
                            onChange={() => toggleRowSelect(r)}
                            data-testid="data-bulk-select-row"
                            aria-label={`Select row ${i + 1}`}
                            className="h-3.5 w-3.5 cursor-pointer align-middle disabled:opacity-30 disabled:cursor-not-allowed"
                            style={{ accentColor: '#00E5FF' }}
                          />
                        </td>
                      )}
                      {visibleCols.map((c) => {
                        const cell = classifyCell(r[c]);

                        /*
                         * url/email cells render as a safe link. classifyCell only ever emits an
                         * http(s)/mailto href (never javascript:/data:), so this can't be an XSS
                         * vector; stopPropagation keeps a link click from triggering a parent
                         * row/cell handler. Honest: the stored value is still text.
                         */
                        return (
                          <td
                            key={c}
                            className="px-3 py-1.5 align-top max-w-[220px] truncate"
                            title={cell.title ?? cell.display}
                          >
                            {cell.href ? (
                              <a
                                href={cell.href}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                onClick={(e) => e.stopPropagation()}
                                className={cell.className}
                              >
                                {cell.display}
                              </a>
                            ) : (
                              <span className={cell.className}>{cell.display}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Gallery (card) view — the SAME page of rows the grid shows (honest page-parity: same
              pagination + "N of total" count, no extra fetch, no record duplication), rendered as
              Airtable-style cards. Respects hidden columns; reuses classifyCell for typed display. */}
          {!browseLoading && !browseError && visibleRows.length > 0 && viewMode === 'gallery' && (
            <div className="flex-1 overflow-auto modern-scrollbar p-3" data-testid="data-gallery">
              {(() => {
                const galTitle = galleryTitleField(visibleCols, galleryTitleCol);
                const galBody = galleryBodyFields(visibleCols, galTitle);

                return (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleRows.map((r, i) => {
                      const titleCell = galTitle ? classifyCell(r[galTitle]) : null;

                      return (
                        <div
                          key={rowPkKey(r, browsePkCols) ?? `row-${i}`}
                          data-testid="data-gallery-card"
                          role="button"
                          tabIndex={0}
                          onClick={() => setDrawerRow(r)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setDrawerRow(r);
                            }
                          }}
                          title="Open record"
                          className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-3 text-left hover:border-[#00e5ff]/40"
                        >
                          <div
                            className="truncate text-xs font-semibold text-bolt-elements-textPrimary"
                            title={titleCell?.title ?? titleCell?.display ?? ''}
                          >
                            {titleCell?.display ? (
                              <span className={titleCell.className}>{titleCell.display}</span>
                            ) : (
                              <span className="italic text-bolt-elements-textTertiary">(untitled)</span>
                            )}
                          </div>
                          <dl className="flex flex-col gap-0.5">
                            {galBody.map((c) => {
                              const cell = classifyCell(r[c]);

                              return (
                                <div key={c} className="flex items-baseline gap-2 text-[10px]">
                                  <dt
                                    className="w-24 shrink-0 truncate text-bolt-elements-textTertiary"
                                    title={columnLabel(c)}
                                  >
                                    {columnLabel(c)}
                                  </dt>
                                  <dd
                                    className="min-w-0 flex-1 truncate text-bolt-elements-textSecondary"
                                    title={cell.title ?? cell.display}
                                  >
                                    {cell.href ? (
                                      <a
                                        href={cell.href}
                                        target="_blank"
                                        rel="noopener noreferrer nofollow"
                                        onClick={(e) => e.stopPropagation()}
                                        className={cell.className}
                                      >
                                        {cell.display}
                                      </a>
                                    ) : (
                                      <span className={cell.className}>{cell.display}</span>
                                    )}
                                  </dd>
                                </div>
                              );
                            })}
                          </dl>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Kanban board — lanes = the WHOLE-QUERY group counts (honest totals from the group-counts
              endpoint); the CARDS in each lane are the current page's rows for that group (labeled
              "N of <count> shown"). Cards reuse the gallery card render + classifyCell. */}
          {!browseLoading && !browseError && visibleRows.length > 0 && viewMode === 'kanban' && (
            <div className="flex-1 overflow-auto modern-scrollbar p-3" data-testid="data-kanban">
              {!kanbanGroupCol ? (
                <div className="p-4 text-center text-[11px] text-bolt-elements-textTertiary">
                  Choose a column to group by (top right) to build the board.
                </div>
              ) : (
                (() => {
                  const galTitle = galleryTitleField(visibleCols, galleryTitleCol);
                  const galBody = galleryBodyFields(visibleCols, galTitle).filter((c) => c !== kanbanGroupCol);
                  const pageBuckets = groupPageRows(visibleRows, kanbanGroupCol);

                  return (
                    <>
                      {kanbanGroupsTruncated && (
                        <div
                          className="mb-2 text-[10px] text-bolt-elements-textTertiary"
                          data-testid="data-kanban-truncated"
                        >
                          Showing the top {kanbanGroups.length} groups by size.
                        </div>
                      )}
                      <div className="flex items-start gap-3">
                        {kanbanGroups.map((lane) => {
                          const key = kanbanGroupKey(lane.value);
                          const laneRows = pageBuckets.get(key) ?? [];
                          const label =
                            lane.value === null || lane.value === undefined ? '(empty)' : String(lane.value);

                          return (
                            <div
                              key={key}
                              data-testid="data-kanban-lane"
                              className="w-64 shrink-0 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1"
                            >
                              <div className="flex items-baseline justify-between gap-2 border-b border-bolt-elements-borderColor/50 bg-bolt-elements-background-depth-2 px-2.5 py-1.5">
                                <span
                                  className="truncate text-[11px] font-semibold text-bolt-elements-textPrimary"
                                  title={label}
                                >
                                  {label}
                                </span>
                                <span
                                  className="shrink-0 text-[10px] text-[#00e5ff]"
                                  title="Whole-table count for this group"
                                >
                                  {lane.count.toLocaleString()}
                                </span>
                              </div>
                              <div className="flex flex-col gap-2 p-2">
                                {laneRows.map((r, i) => {
                                  const titleCell = galTitle ? classifyCell(r[galTitle]) : null;

                                  return (
                                    <div
                                      key={rowPkKey(r, browsePkCols) ?? `row-${i}`}
                                      data-testid="data-kanban-card"
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => setDrawerRow(r)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          setDrawerRow(r);
                                        }
                                      }}
                                      title="Open record"
                                      className="cursor-pointer rounded-md border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2 p-2 text-left hover:border-[#00e5ff]/40"
                                    >
                                      <div
                                        className="truncate text-[11px] font-medium text-bolt-elements-textPrimary"
                                        title={titleCell?.title ?? titleCell?.display ?? ''}
                                      >
                                        {titleCell?.display ? (
                                          <span className={titleCell.className}>{titleCell.display}</span>
                                        ) : (
                                          <span className="italic text-bolt-elements-textTertiary">(untitled)</span>
                                        )}
                                      </div>
                                      <dl className="mt-1 flex flex-col gap-0.5">
                                        {galBody.slice(0, 4).map((c) => {
                                          const cell = classifyCell(r[c]);

                                          return (
                                            <div key={c} className="flex items-baseline gap-1.5 text-[10px]">
                                              <dt className="shrink-0 text-bolt-elements-textTertiary">
                                                {columnLabel(c)}
                                              </dt>
                                              <dd
                                                className="min-w-0 flex-1 truncate text-bolt-elements-textSecondary"
                                                title={cell.title ?? cell.display}
                                              >
                                                {cell.href ? (
                                                  <a
                                                    href={cell.href}
                                                    target="_blank"
                                                    rel="noopener noreferrer nofollow"
                                                    onClick={(e) => e.stopPropagation()}
                                                    className={cell.className}
                                                  >
                                                    {cell.display}
                                                  </a>
                                                ) : (
                                                  <span className={cell.className}>{cell.display}</span>
                                                )}
                                              </dd>
                                            </div>
                                          );
                                        })}
                                      </dl>
                                    </div>
                                  );
                                })}
                                <div
                                  className="text-[9px] text-bolt-elements-textTertiary"
                                  data-testid="data-kanban-lane-note"
                                >
                                  {laneRows.length} of {lane.count.toLocaleString()} shown (current page)
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {kanbanGroups.length === 0 && !kanbanBusy && (
                          <div className="p-4 text-[11px] text-bolt-elements-textTertiary">No groups found.</div>
                        )}
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          )}

          {/* Chart view — a horizontal bar chart of WHOLE-QUERY counts by the group column (honest by
              construction: the bars are the same group-counts the kanban lanes use, over the full
              filtered set, never the loaded page). Pick a column to build it. */}
          {!browseLoading && !browseError && visibleRows.length > 0 && viewMode === 'chart' && (
            <div className="flex-1 overflow-auto modern-scrollbar p-4" data-testid="data-chart">
              {!kanbanGroupCol ? (
                <div className="p-4 text-center text-[11px] text-bolt-elements-textTertiary">
                  Choose a column to group by (top right) to build the chart.
                </div>
              ) : (
                (() => {
                  const { bars, total } = buildChartBars(kanbanGroups);

                  return (
                    <div className="mx-auto max-w-2xl">
                      <div className="mb-3 flex items-baseline justify-between gap-2 text-[10px] text-bolt-elements-textTertiary">
                        <span className="truncate">Count by {columnLabel(kanbanGroupCol)} — whole table</span>
                        <span className="shrink-0">
                          {total.toLocaleString()} across {bars.length} group{bars.length === 1 ? '' : 's'}
                          {kanbanGroupsTruncated ? ' (top 50)' : ''}
                        </span>
                      </div>
                      {bars.length === 0 && !kanbanBusy ? (
                        <div className="p-4 text-[11px] text-bolt-elements-textTertiary">No data.</div>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {bars.map((b) => (
                            <div key={b.label} className="flex items-center gap-2" data-testid="data-chart-bar">
                              <span
                                className="w-32 shrink-0 truncate text-right text-[11px] text-bolt-elements-textSecondary"
                                title={b.label}
                              >
                                {b.label}
                              </span>
                              <div className="relative h-4 flex-1 rounded bg-bolt-elements-background-depth-2">
                                <div
                                  className="absolute inset-y-0 left-0 rounded bg-[#00e5ff]/60"
                                  style={{ width: `${Math.max(b.pct, 2)}%` }}
                                />
                              </div>
                              <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-bolt-elements-textPrimary">
                                {b.count.toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()
              )}
            </div>
          )}

          {/* Calendar view — the current page's records placed on a Sunday-first month grid by a date
              column (auto-detected or chosen). HONEST page-parity like the kanban cards: only this page's
              rows are placed, by their UTC day (never a whole-table month query); undated rows aren't
              shown. Each event opens the SAME record drawer. Wires the tested bucketRowsByDate foundation. */}
          {!browseLoading && !browseError && visibleRows.length > 0 && viewMode === 'calendar' && (
            <div className="flex-1 overflow-auto modern-scrollbar p-3" data-testid="data-calendar">
              {!calendarCol ? (
                <div className="p-4 text-center text-[11px] text-bolt-elements-textTertiary">
                  No date column detected on this page. Pick a date column (top right) to build the calendar.
                </div>
              ) : (
                (() => {
                  const cells = monthMatrix(calendarView.year, calendarView.month);
                  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                  const placed = [...calendarDayMap.values()].reduce((n, rs) => n + rs.length, 0);
                  const galTitle = galleryTitleField(visibleCols, galleryTitleCol);

                  return (
                    <>
                      <div
                        className="mb-2 text-[10px] text-bolt-elements-textTertiary"
                        data-testid="data-calendar-caption"
                      >
                        {placed.toLocaleString()} of {visibleRows.length.toLocaleString()} rows on this page placed by{' '}
                        <span className="text-bolt-elements-textSecondary">{columnLabel(calendarCol)}</span> (UTC day) —
                        the current page only, not a whole-table month query; undated rows aren’t shown.
                      </div>
                      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-borderColor/40">
                        {weekdays.map((w) => (
                          <div
                            key={w}
                            className="bg-bolt-elements-background-depth-2 px-2 py-1 text-center text-[10px] font-semibold text-bolt-elements-textTertiary"
                          >
                            {w}
                          </div>
                        ))}
                        {cells.map((cell) => {
                          const dayRows = calendarDayMap.get(cell.dayKey) ?? [];

                          return (
                            <div
                              key={cell.dayKey}
                              data-testid="data-calendar-day"
                              className={classNames(
                                'min-h-[76px] bg-bolt-elements-background-depth-1 p-1 align-top',
                                cell.inMonth ? '' : 'opacity-40',
                              )}
                            >
                              <div className="mb-0.5 text-right text-[10px] text-bolt-elements-textTertiary">
                                {cell.dayOfMonth}
                              </div>
                              <div className="flex flex-col gap-0.5">
                                {dayRows.slice(0, 3).map((r, i) => {
                                  const titleCell = galTitle ? classifyCell(r[galTitle]) : null;

                                  return (
                                    <button
                                      type="button"
                                      key={rowPkKey(r, browsePkCols) ?? `${cell.dayKey}-${i}`}
                                      onClick={() => setDrawerRow(r)}
                                      data-testid="data-calendar-event"
                                      title="Open record"
                                      className="truncate rounded bg-[#00e5ff]/10 px-1 py-0.5 text-left text-[10px] text-bolt-elements-textPrimary hover:bg-[#00e5ff]/20"
                                    >
                                      {titleCell?.display || '(untitled)'}
                                    </button>
                                  );
                                })}
                                {dayRows.length > 3 && (
                                  <span className="px-1 text-[9px] text-bolt-elements-textTertiary">
                                    +{dayRows.length - 3} more
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          )}
        </div>
      )}

      {/* Record drawer — a right-side panel showing ALL fields of a row, opened by clicking a gallery,
          kanban, or calendar record (one detail surface for every non-grid view). View · edit · copy ·
          delete. JSON values render as an expandable tree. Backdrop / ✕ / Escape close it. */}
      {drawerRow && (
        <div
          className="fixed inset-0 z-[60] flex justify-end"
          data-testid="data-record-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Record detail"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              setDrawerRow(null);
              setEditCol(null);
            }}
            aria-hidden="true"
          />
          <div className="relative z-10 flex h-full w-full max-w-sm flex-col border-l border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-2xl">
            <div className="flex items-center justify-between gap-2 border-b border-bolt-elements-borderColor px-3 py-2">
              <span
                className="truncate text-xs font-semibold text-bolt-elements-textPrimary"
                title={recordTitle(drawerRow, columns, galleryTitleCol)}
              >
                {recordTitle(drawerRow, columns, galleryTitleCol)}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyRow(drawerRow)}
                  data-testid="data-drawer-copy"
                  title="Copy this record as JSON"
                  className="flex items-center gap-1 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:copy text-[11px]" /> JSON
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDrawerRow(null);
                    setEditCol(null);
                  }}
                  data-testid="data-drawer-close"
                  aria-label="Close record detail"
                  title="Close"
                  className="i-ph:x cursor-pointer text-sm text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary"
                />
              </div>
            </div>
            {/* Prev/next within THIS PAGE (honest — stepping never crosses to the next page; that would
                need a fetch). ←/→ keys mirror these buttons. Hidden for a single-row page. */}
            {drawerNav.index >= 0 && drawerNav.total > 1 && (
              <div
                className="flex items-center justify-between gap-2 border-b border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2 px-3 py-1"
                data-testid="data-drawer-nav"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (drawerNav.prev) {
                      setDrawerRow(drawerNav.prev);
                      setEditCol(null);
                    }
                  }}
                  disabled={!drawerNav.prev}
                  data-testid="data-drawer-prev"
                  aria-label="Previous record"
                  title="Previous record (←)"
                  className={classNames(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                    drawerNav.prev
                      ? 'cursor-pointer text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary'
                      : 'cursor-not-allowed text-bolt-elements-textTertiary opacity-40',
                  )}
                >
                  <div className="i-ph:caret-left text-[11px]" /> Prev
                </button>
                <span className="text-[10px] text-bolt-elements-textTertiary" data-testid="data-drawer-position">
                  Record {drawerNav.index + 1} of {drawerNav.total.toLocaleString()}{' '}
                  <span className="opacity-60">(this page)</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (drawerNav.next) {
                      setDrawerRow(drawerNav.next);
                      setEditCol(null);
                    }
                  }}
                  disabled={!drawerNav.next}
                  data-testid="data-drawer-next"
                  aria-label="Next record"
                  title="Next record (→)"
                  className={classNames(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                    drawerNav.next
                      ? 'cursor-pointer text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary'
                      : 'cursor-not-allowed text-bolt-elements-textTertiary opacity-40',
                  )}
                >
                  Next <div className="i-ph:caret-right text-[11px]" />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <dl className="flex flex-col gap-2.5">
                {columns.map((c) => {
                  const cell = classifyCell(drawerRow[c]);
                  const editingThisField = editCol === c;

                  // Editable = super-admin + resolvable PK + not part of the key + not a generated column.
                  const editable =
                    canRunSql && browsePkCols.length > 0 && !browsePkCols.includes(c) && !browseGeneratedCols.has(c);

                  return (
                    <div key={c} className="group flex flex-col gap-0.5">
                      <dt className="text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
                        {columnLabel(c)}
                      </dt>
                      <dd
                        className="flex items-start gap-1.5 break-words text-[11px] text-bolt-elements-textPrimary"
                        title={cell.title ?? cell.display}
                      >
                        {editingThisField ? (
                          <CellEditor
                            label={columnLabel(c)}
                            editKind={editKind}
                            onKindChange={(k) => {
                              setEditError('');
                              setEditKind(k);
                            }}
                            editValue={editValue}
                            onValueChange={(v) => {
                              setEditError('');
                              setEditValue(v);
                            }}
                            previewSql={editPreviewFor(drawerRow)}
                            editError={editError}
                            editBusy={editBusy}
                            onSave={() => submitEdit(drawerRow)}
                            onCancel={cancelEdit}
                          />
                        ) : (
                          <>
                            <div className="min-w-0 flex-1">
                              {cell.isJson ? (
                                <JsonTree value={drawerRow[c]} />
                              ) : cell.href ? (
                                <a
                                  href={cell.href}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  className={cell.className}
                                >
                                  {cell.display}
                                </a>
                              ) : (
                                <span className={cell.className}>{cell.display}</span>
                              )}
                            </div>
                            {clipboardValue(drawerRow[c]) && (
                              <button
                                type="button"
                                onClick={() => copyValue(drawerRow[c], columnLabel(c))}
                                data-testid="data-drawer-copy-cell"
                                title={`Copy ${columnLabel(c)}`}
                                aria-label={`Copy ${columnLabel(c)}`}
                                className="shrink-0 cursor-pointer text-bolt-elements-textTertiary opacity-0 transition-opacity hover:!opacity-100 hover:text-bolt-elements-item-contentAccent focus:opacity-100 group-hover:opacity-60"
                              >
                                <div className="i-ph:copy text-[11px]" />
                              </button>
                            )}
                            {editable && (
                              <button
                                type="button"
                                onClick={() => startEdit(c, drawerRow[c])}
                                data-testid="data-drawer-edit-open"
                                title={`Edit ${columnLabel(c)}`}
                                aria-label={`Edit ${columnLabel(c)}`}
                                className="shrink-0 cursor-pointer text-bolt-elements-textTertiary opacity-0 transition-opacity hover:!opacity-100 hover:text-bolt-elements-item-contentAccent focus:opacity-100 group-hover:opacity-60"
                              >
                                <div className="i-ph:pencil-simple text-[11px]" />
                              </button>
                            )}
                            {browseGeneratedCols.has(c) && (
                              <span
                                data-testid="data-drawer-cell-generated"
                                title="Generated (computed) column — SQLite derives its value; it can't be edited."
                                className="shrink-0 rounded bg-amber-500/15 px-1 text-[8px] text-amber-300"
                              >
                                computed
                              </span>
                            )}
                          </>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            {/* Record actions — parity with the grid's inline detail (copy-as-SQL/Markdown + delete),
                reusing the SAME row-based handlers. Copy is always available; UPDATE/Delete need a
                resolvable primary key; Delete needs super-admin. Delete refreshes → the drawer closes. */}
            <div className="flex flex-wrap items-center gap-2 border-t border-bolt-elements-borderColor px-3 py-2">
              {active && (
                <button
                  type="button"
                  onClick={() => {
                    writeClipboard(rowToInsert(active, drawerRow));
                    flashStatus('Copied INSERT');
                  }}
                  data-testid="data-drawer-insert"
                  title="Copy this record as an INSERT statement"
                  className="flex items-center gap-1 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:code text-[11px]" /> INSERT
                </button>
              )}
              {active && browsePkCols.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    writeClipboard(rowToUpdateByPk(active, drawerRow, browsePkCols));
                    flashStatus('Copied UPDATE');
                  }}
                  data-testid="data-drawer-update"
                  title="Copy this record as an UPDATE statement"
                  className="flex items-center gap-1 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:pencil-line text-[11px]" /> UPDATE
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  writeClipboard(rowsToMarkdown(columns, [drawerRow]));
                  flashStatus('Copied Markdown');
                }}
                data-testid="data-drawer-markdown"
                title="Copy this record as a Markdown table row"
                className="flex items-center gap-1 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
              >
                <div className="i-ph:table text-[11px]" /> Markdown
              </button>
              {/* Duplicate — super-admin only; opens the Add-row form prefilled from this record
                  (primary key + generated columns omitted so the DB assigns fresh values). */}
              {canRunSql && (
                <button
                  type="button"
                  onClick={() => duplicateRow(drawerRow)}
                  data-testid="data-drawer-duplicate"
                  title="Duplicate this record — opens the Add-row form prefilled (primary key omitted so a new one is generated)"
                  className="flex items-center gap-1 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:copy-simple text-[11px]" /> Duplicate
                </button>
              )}
              {canRunSql && browsePkCols.length > 0 && (
                <button
                  type="button"
                  onClick={() => deleteRow(drawerRow)}
                  data-testid="data-drawer-delete"
                  title="Permanently delete this record (parameterized DELETE by primary key)"
                  className="ml-auto flex items-center gap-1 rounded border border-red-500/40 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10"
                >
                  <div className="i-ph:trash text-[11px]" /> Delete
                </button>
              )}
              {canRunSql && browsePkCols.length === 0 && (
                <span
                  className="ml-auto text-[10px] text-bolt-elements-textTertiary"
                  title="This table has no primary key, so a single record can't be safely targeted for update/delete."
                >
                  No primary key — read-only
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SQL console — the D1 manager (super-admin). Outerbase-Studio-style: one-click starters,
          a query editor (⌘/Ctrl+↵ to run), and a results grid; runs read-only SELECT/PRAGMA. */}
      {mode === 'kv' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-auto modern-scrollbar">
          <KvBrowser postToParent={postToParent} />
        </div>
      )}
      {mode === 'r2' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-auto modern-scrollbar">
          <R2Browser postToParent={postToParent} />
        </div>
      )}
      {mode === 'vec' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-auto modern-scrollbar">
          <VectorizeBrowser postToParent={postToParent} />
        </div>
      )}
      {mode === 'queues' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-auto modern-scrollbar">
          <QueuesBrowser postToParent={postToParent} />
        </div>
      )}
      {mode === 'd1' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-auto modern-scrollbar">
          <D1Browser postToParent={postToParent} />
        </div>
      )}
      {status === 'ready' && mode === 'sql' && (
        <div className="flex-1 flex flex-col min-h-0" data-testid="data-sql-console">
          {/* Write-target safety banner — the prompt requires surfacing the account/env/database
              PROMINENTLY before writes. This console runs against the SHARED, multi-tenant
              platform D1, so make that impossible to miss. Facts come from sqlConsoleTarget() (SSOT). */}
          <div
            className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-200"
            data-testid="data-sql-target"
            role="note"
          >
            <div className="i-ph:warning-diamond-fill mt-0.5 shrink-0 text-amber-400" aria-hidden />
            <span>
              Target: <strong className="text-amber-100">{SQL_TARGET.environment}</strong>
              {' · '}
              <strong className="text-amber-100">{SQL_TARGET.database}</strong>
              {' — '}
              {SQL_TARGET.scope}
            </span>
          </div>
          {/* ✨ Ask AI — describe what you want in plain English; the assistant writes SQL for you to
              REVIEW and Run. It never executes automatically (honest, per the AI-SQL contract). The
              worker grounds the model on the REAL server-fetched schema and is super-admin-gated. */}
          <div
            className="mx-3 mt-3 rounded-lg border border-bolt-elements-item-contentAccent/30 bg-gradient-to-r from-bolt-elements-item-contentAccent/10 to-transparent p-2.5"
            data-testid="data-sql-ai"
          >
            <div className="flex items-center gap-2">
              <div className="i-ph:sparkle-fill shrink-0 text-bolt-elements-item-contentAccent" aria-hidden />
              <input
                type="text"
                value={aiQuestion}
                onChange={(e) => {
                  setAiQuestion(e.target.value);

                  if (aiError) {
                    setAiError('');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !aiBusy && aiQuestion.trim()) {
                    e.preventDefault();
                    askAi();
                  }
                }}
                disabled={aiBusy}
                maxLength={MAX_AI_QUESTION_LEN}
                placeholder="Ask in plain English — e.g. “the 10 newest form submissions”"
                data-testid="data-sql-ai-input"
                aria-label="Describe the query you want in plain English"
                className="flex-1 min-w-0 rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-2.5 py-1.5 text-xs text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={askAi}
                disabled={aiBusy || !aiQuestion.trim()}
                data-testid="data-sql-ai-ask"
                title="Generate SQL from your question — it lands in the editor for you to review, then Run"
                className={classNames(
                  'shrink-0 text-xs rounded-md px-3 py-1.5 flex items-center gap-1.5 transition-colors',
                  aiBusy || !aiQuestion.trim()
                    ? 'bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary cursor-not-allowed'
                    : 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/25 border border-bolt-elements-item-contentAccent/30 cursor-pointer',
                )}
              >
                <div className={aiBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:sparkle'} />
                {aiBusy ? 'Thinking…' : 'Ask AI'}
              </button>
            </div>
            {aiError && (
              <p
                className="mt-1.5 flex items-start gap-1 text-[11px] text-red-400"
                data-testid="data-sql-ai-error"
                role="alert"
              >
                <div className="i-ph:warning-circle mt-0.5 shrink-0" aria-hidden />
                <span>{aiError}</span>
              </p>
            )}
            {aiModel !== null && !aiError && !aiBusy && (
              <p
                className="mt-1.5 flex items-start gap-1 text-[11px] text-bolt-elements-textTertiary"
                data-testid="data-sql-ai-note"
              >
                <div className="i-ph:info mt-0.5 shrink-0 text-bolt-elements-item-contentAccent" aria-hidden />
                <span>
                  <strong className="text-bolt-elements-textSecondary">{friendlyModelLabel(aiModel)}</strong> drafted
                  the query below — <strong className="text-bolt-elements-textSecondary">review it</strong>, then Run.
                  Nothing runs automatically.
                </span>
              </p>
            )}
          </div>
          <div className="p-3 border-b border-bolt-elements-borderColor/50 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary mr-1">
                Starters
              </span>
              {SQL_STARTERS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => {
                    updateSql(s.query);
                    runSql(s.query);
                  }}
                  className="text-[10px] rounded-full px-2 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary cursor-pointer"
                >
                  {s.label}
                </button>
              ))}
              <span className="mx-0.5 h-3 w-px bg-bolt-elements-borderColor" aria-hidden />
              <button
                type="button"
                onClick={() => updateSql(NEW_TABLE_TEMPLATE)}
                data-testid="data-sql-new-table"
                title="Drop a CREATE TABLE template into the editor — edit the name + columns, then Run"
                className="text-[10px] rounded-full px-2 py-0.5 border border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer flex items-center gap-1"
              >
                <div className="i-ph:plus" /> New table
              </button>
              <button
                type="button"
                onClick={() => updateSql(`INSERT INTO my_table (column_a, column_b)\nVALUES ('value a', 'value b');`)}
                data-testid="data-sql-new-row"
                title="Drop an INSERT template into the editor — set the table, columns + values, then Run"
                className="text-[10px] rounded-full px-2 py-0.5 border border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer flex items-center gap-1"
              >
                <div className="i-ph:plus" /> New row
              </button>
              {sqlHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  data-testid="data-sql-history-toggle"
                  aria-expanded={historyOpen}
                  title="Recent queries you have run (this browser)"
                  className="text-[10px] rounded-full px-2 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary cursor-pointer flex items-center gap-1"
                >
                  <div className="i-ph:clock-counter-clockwise" /> History ({sqlHistory.length})
                </button>
              )}
              {savedQueries.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSavedOpen((v) => !v)}
                  data-testid="data-sql-saved-toggle"
                  aria-expanded={savedOpen}
                  title="Your saved queries (this browser) — click to recall into the editor"
                  className="text-[10px] rounded-full px-2 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary cursor-pointer flex items-center gap-1"
                >
                  <div className="i-ph:bookmark-simple" /> Saved ({savedQueries.length})
                </button>
              )}
              <span className="inline-flex items-center gap-1">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveCurrentQuery();
                    }
                  }}
                  placeholder="Name…"
                  data-testid="data-sql-save-name"
                  aria-label="Name to save the current query under"
                  className="w-24 rounded-full bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-2 py-0.5 text-[10px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
                />
                <button
                  type="button"
                  onClick={saveCurrentQuery}
                  disabled={!saveName.trim() || !sql.trim()}
                  data-testid="data-sql-save"
                  title="Save the current query under this name for one-click reuse"
                  className={classNames(
                    'text-[10px] rounded-full px-2 py-0.5 border flex items-center gap-1',
                    !saveName.trim() || !sql.trim()
                      ? 'border-bolt-elements-borderColor text-bolt-elements-textTertiary cursor-not-allowed'
                      : 'border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer',
                  )}
                >
                  <div className="i-ph:bookmark-simple" /> Save
                </button>
              </span>
            </div>
            {historyOpen && sqlHistory.length > 0 && (
              <div
                data-testid="data-sql-history"
                className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 max-h-40 overflow-auto modern-scrollbar"
              >
                {sqlHistory.map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      updateSql(h);
                      setHistoryOpen(false);
                      runSql(h);
                    }}
                    title={h}
                    className="w-full text-left px-2.5 py-1.5 text-[11px] font-mono text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 hover:text-bolt-elements-textPrimary cursor-pointer truncate border-b border-bolt-elements-borderColor/20 last:border-b-0"
                  >
                    {h}
                  </button>
                ))}
              </div>
            )}
            {savedOpen && savedQueries.length > 0 && (
              <div
                data-testid="data-sql-saved"
                className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 max-h-40 overflow-auto modern-scrollbar"
              >
                {savedQueries.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center border-b border-bolt-elements-borderColor/20 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        updateSql(s.query);
                        setSavedOpen(false);
                      }}
                      title={s.query}
                      data-testid="data-sql-saved-load"
                      className="flex-1 min-w-0 text-left px-2.5 py-1.5 text-[11px] text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 hover:text-bolt-elements-textPrimary cursor-pointer truncate"
                    >
                      <span className="font-medium text-bolt-elements-item-contentAccent">{s.name}</span>
                      <span className="ml-2 font-mono text-bolt-elements-textTertiary">{s.query}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSavedQuery(s.name)}
                      title={'Delete saved query: ' + s.name}
                      aria-label={'Delete saved query: ' + s.name}
                      data-testid="data-sql-saved-delete"
                      className="shrink-0 px-2 py-1.5 text-[11px] text-bolt-elements-textTertiary hover:text-red-400 cursor-pointer"
                    >
                      <div className="i-ph:trash" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Query tabs — independent buffers you can switch between; each keeps its own
                text (localStorage-persisted). Hold a SELECT, an EXPLAIN, and a schema lookup
                side by side without losing any of them. */}
            <div
              className="flex items-center gap-1 px-3 pt-2 overflow-x-auto"
              role="tablist"
              aria-label="Query tabs"
              data-testid="data-sql-tabs"
            >
              {queryTabs.map((t) => (
                <div
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === activeTabId}
                  tabIndex={0}
                  data-testid="data-sql-tab"
                  onClick={() => switchTab(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      switchTab(t.id);
                    }
                  }}
                  className={classNames(
                    'group flex items-center gap-1 shrink-0 rounded-t-md px-2 py-1 text-[11px] cursor-pointer border-b-2',
                    t.id === activeTabId
                      ? 'border-bolt-elements-item-contentAccent text-bolt-elements-textPrimary'
                      : 'border-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
                  )}
                >
                  <span className="max-w-[10rem] truncate">{t.title}</span>
                  {queryTabs.length > 1 && (
                    <button
                      type="button"
                      data-testid="data-sql-tab-close"
                      aria-label={`Close ${t.title}`}
                      title={`Close ${t.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                      className="shrink-0 opacity-40 hover:opacity-100 hover:text-red-400 cursor-pointer"
                    >
                      <div className="i-ph:x text-[10px]" />
                    </button>
                  )}
                </div>
              ))}
              {queryTabs.length < MAX_QUERY_TABS && (
                <button
                  type="button"
                  data-testid="data-sql-tab-add"
                  aria-label="New query tab"
                  title="New query tab"
                  onClick={addTab}
                  className="shrink-0 px-1.5 py-1 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent cursor-pointer"
                >
                  <div className="i-ph:plus text-[12px]" />
                </button>
              )}
            </div>
            <SqlEditor
              value={sql}
              onValueChange={updateSql}
              onRun={() => runSql(sql)}
              schema={sqlSchema}
              placeholder="SELECT … · CREATE TABLE … · INSERT/UPDATE/DELETE …  (⌘↵ to run · ↑↓/Tab complete · destructive statements confirm first)"
              testId="data-sql-input"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => runSql(sql)}
                disabled={sqlRunning || !sql.trim()}
                data-testid="data-sql-run"
                className={classNames(
                  'text-xs rounded-md px-3 py-1.5 flex items-center gap-1.5 transition-colors',
                  sqlRunning || !sql.trim()
                    ? 'bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary cursor-not-allowed'
                    : 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/25 border border-bolt-elements-item-contentAccent/30 cursor-pointer',
                )}
              >
                <div className={sqlRunning ? 'i-ph:circle-notch animate-spin' : 'i-ph:play'} />
                {sqlRunning ? 'Running…' : 'Run'}
                <kbd className="text-[9px] opacity-60 ml-0.5">⌘↵</kbd>
              </button>
              <button
                type="button"
                onClick={() => runSql(explainQuery(sql))}
                disabled={sqlRunning || !sql.trim()}
                data-testid="data-sql-explain"
                title="Show the SQLite query plan (EXPLAIN QUERY PLAN) + index guidance — a read-only optimizer view; never modifies data"
                className={classNames(
                  'text-xs rounded-md px-3 py-1.5 flex items-center gap-1.5 transition-colors',
                  sqlRunning || !sql.trim()
                    ? 'bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary cursor-not-allowed'
                    : 'bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary border border-bolt-elements-borderColor hover:border-bolt-elements-item-contentAccent/40 cursor-pointer',
                )}
              >
                <div className="i-ph:git-fork" /> Explain
              </button>
              {rowLimitAdvice.needsLimit && !sqlRunning && (
                <button
                  type="button"
                  onClick={() => runSql(rowLimitAdvice.limitedSql)}
                  data-testid="data-sql-add-limit"
                  title={`This SELECT has no LIMIT — it can return every row and scan the whole table. Run a bounded first ${rowLimitAdvice.limit} rows instead (you can still Run the full query).`}
                  className="text-[10px] text-amber-300 rounded-md px-2 py-1 flex items-center gap-1 border border-amber-300/30 hover:bg-amber-300/10 cursor-pointer transition-colors"
                >
                  <div className="i-ph:warning" /> Add LIMIT {rowLimitAdvice.limit}
                </button>
              )}
              {sqlMeta && !sqlError && (
                <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums" data-testid="data-sql-meta">
                  {sqlMeta.rows.toLocaleString()} {sqlMeta.rows === 1 ? 'row' : 'rows'}
                  {typeof sqlMeta.ms === 'number' ? ` · ${sqlMeta.ms} ms` : ''}
                  {typeof sqlMeta.read === 'number' ? ` · read ${sqlMeta.read.toLocaleString()}` : ''}
                  {typeof sqlMeta.written === 'number' && sqlMeta.written > 0
                    ? ` · wrote ${sqlMeta.written.toLocaleString()}`
                    : ''}
                </span>
              )}
              {sqlMeta && !sqlError && isExpensiveScan(sqlMeta.read) && (
                <span
                  className="text-[10px] text-amber-300 flex items-center gap-1"
                  data-testid="data-sql-scan-warn"
                  role="status"
                  title="This query read a large number of rows — add an index on the column(s) you filter or join by to keep it fast at scale."
                >
                  <div className="i-ph:warning" /> expensive scan — {sqlMeta.read!.toLocaleString()} rows read
                </span>
              )}
              {!sqlError && sqlColumns.length > 0 && (
                <button
                  type="button"
                  onClick={exportSqlCsv}
                  data-testid="data-sql-export-csv"
                  className="text-[10px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer flex items-center gap-1"
                  title="Export the query result to CSV"
                >
                  <div className="i-ph:download-simple" /> CSV
                </button>
              )}
              {!sqlError && chartSpec && (
                <button
                  type="button"
                  onClick={() => setChartOn((v) => !v)}
                  data-testid="data-sql-chart-toggle"
                  aria-pressed={chartOn}
                  title="Chart this result — a bar chart of the label column vs a numeric column"
                  className={classNames(
                    'text-[10px] cursor-pointer flex items-center gap-1',
                    chartOn
                      ? 'text-bolt-elements-item-contentAccent'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent',
                  )}
                >
                  <div className={chartOn ? 'i-ph:table' : 'i-ph:chart-bar'} />
                  {chartOn ? 'Table' : 'Chart'}
                </button>
              )}
              <span
                className="ml-auto text-[10px] text-bolt-elements-textTertiary flex items-center gap-1"
                title="Reads + writes (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE). Platform tables are protected; destructive statements confirm first."
              >
                <div className="i-ph:pencil-simple-line" /> read + write
              </span>
            </div>
          </div>

          {sqlError && (
            <div
              className="mx-3 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300 font-mono whitespace-pre-wrap"
              data-testid="data-sql-error"
              role="alert"
            >
              {sqlError}
            </div>
          )}

          {!sqlError && writeResult && (
            <div
              className="mx-3 mt-3 rounded-md border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/10 px-3 py-2 text-[11px] text-bolt-elements-item-contentAccent flex items-center gap-2"
              data-testid="data-sql-write-result"
              role="status"
            >
              <div className="i-ph:check-circle" />
              Statement executed — {writeResult.rows_affected.toLocaleString()}{' '}
              {writeResult.rows_affected === 1 ? 'row' : 'rows'} affected
              {writeResult.last_row_id != null ? ` · last row id ${writeResult.last_row_id}` : ''}. Tables refreshed.
            </div>
          )}

          {!sqlError && sqlPlanHint && (
            <div
              className={classNames(
                'mx-3 mt-3 rounded-md border px-3 py-2 text-[11px] flex items-center gap-2',
                sqlPlanHint.level === 'warn'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : sqlPlanHint.level === 'good'
                    ? 'border-green-500/30 bg-green-500/10 text-green-300'
                    : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary',
              )}
              data-testid="data-sql-plan-hint"
              role="status"
            >
              <div
                className={
                  sqlPlanHint.level === 'warn'
                    ? 'i-ph:warning'
                    : sqlPlanHint.level === 'good'
                      ? 'i-ph:check-circle'
                      : 'i-ph:info'
                }
              />
              <span>{sqlPlanHint.message}</span>
            </div>
          )}

          {/* Query-result mini-chart — a zero-dep horizontal bar chart of the label column vs a
              numeric column. Client-side over the already-fetched result (no re-query). */}
          {!sqlError && chartOn && chartSpec && chartValueCol && (
            <div className="flex-1 overflow-auto modern-scrollbar mt-1 p-3" data-testid="data-sql-chart">
              <div className="mb-2 flex items-center gap-2 text-[10px] text-bolt-elements-textTertiary">
                <span>
                  {chartSpec.labelCol} × <strong className="text-bolt-elements-textSecondary">{chartValueCol}</strong>
                </span>
                {chartSpec.valueCols.length > 1 && (
                  <select
                    value={chartValueCol}
                    onChange={(e) => setSqlChartCol(e.target.value)}
                    data-testid="data-sql-chart-col"
                    aria-label="Value column to plot"
                    className="rounded bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] text-bolt-elements-textPrimary"
                  >
                    {chartSpec.valueCols.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                <span className="ml-auto">
                  {chartData.length} {chartData.length === 1 ? 'bar' : 'bars'}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {chartData.map((p, i) => (
                  <li key={`${p.label}-${i}`} className="flex items-center gap-2" data-testid="data-sql-chart-bar">
                    <span
                      className="w-28 shrink-0 truncate text-right font-mono text-[10px] text-bolt-elements-textSecondary"
                      title={p.label}
                    >
                      {p.label}
                    </span>
                    <span className="relative h-4 flex-1 rounded bg-bolt-elements-background-depth-2">
                      <span
                        className="absolute inset-y-0 left-0 rounded bg-bolt-elements-item-contentAccent/70"
                        style={{ width: `${chartMax > 0 ? Math.max(2, Math.round((p.value / chartMax) * 100)) : 0}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-bolt-elements-textPrimary">
                      {p.value.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!sqlError && sqlColumns.length > 0 && !(chartOn && chartSpec) && (
            <div className="flex-1 overflow-auto modern-scrollbar mt-1">
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-bolt-elements-background-depth-2 z-10">
                  <tr>
                    {sqlColumns.map((c) => (
                      <th
                        key={c}
                        aria-sort={sqlSort?.col === c ? (sqlSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className="text-left font-medium text-bolt-elements-textTertiary border-b border-bolt-elements-borderColor/50 whitespace-nowrap p-0"
                      >
                        <button
                          type="button"
                          onClick={() => toggleSqlSort(c)}
                          data-testid="data-sql-sort"
                          title={`Sort by ${c}`}
                          className="w-full flex items-center gap-1 px-3 py-1.5 text-left hover:text-bolt-elements-textPrimary cursor-pointer"
                        >
                          <span className="truncate">{c}</span>
                          <span
                            aria-hidden="true"
                            className={classNames(
                              'shrink-0 text-[8px]',
                              sqlSort?.col === c
                                ? 'text-bolt-elements-item-contentAccent'
                                : 'text-bolt-elements-textTertiary/40',
                              sqlSort?.col === c && sqlSort.dir === 'desc'
                                ? 'i-ph:caret-down-bold'
                                : 'i-ph:caret-up-bold',
                            )}
                          />
                        </button>
                      </th>
                    ))}
                    <th className="w-8 border-b border-bolt-elements-borderColor/50" />
                  </tr>
                </thead>
                <tbody>
                  {sqlVisibleRows.map((r, i) => (
                    <tr
                      key={i}
                      data-testid="data-sql-row"
                      className="border-b border-bolt-elements-borderColor/20 hover:bg-bolt-elements-background-depth-2/50"
                    >
                      {sqlColumns.map((c) => (
                        <td
                          key={c}
                          className="px-3 py-1.5 text-bolt-elements-textSecondary align-top max-w-[280px] font-mono"
                        >
                          {clipboardValue(r[c]) ? (
                            <button
                              type="button"
                              onClick={() => copyValue(r[c], c)}
                              data-testid="data-sql-copy-cell"
                              title={`Click to copy · ${c}`}
                              className="block max-w-full truncate text-left hover:text-bolt-elements-item-contentAccent cursor-pointer"
                            >
                              {formatCellValue(r[c])}
                            </button>
                          ) : (
                            <span className="block truncate" title={formatCellValue(r[c])}>
                              {formatCellValue(r[c])}
                            </span>
                          )}
                        </td>
                      ))}
                      <td className="px-1 py-1.5 text-right">
                        {/* One-click drill: a sqlite_master listing row → browse that table; + Drop. */}
                        {isTableListRow(r) && typeof r.name === 'string' && (
                          <span className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              title={`SELECT * FROM ${r.name}`}
                              aria-label={`Browse ${r.name}`}
                              onClick={() => {
                                const q = `SELECT * FROM "${r.name}" LIMIT 100;`;
                                updateSql(q);
                                runSql(q);
                              }}
                              className="i-ph:arrow-square-out text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent cursor-pointer"
                            />
                            <button
                              type="button"
                              title={`Structure of ${r.name}`}
                              aria-label={`Structure of ${r.name}`}
                              data-testid="data-sql-structure"
                              onClick={() => {
                                const q = `SELECT cid, name AS "column", type, "notnull" AS not_null, dflt_value AS default_value, pk FROM pragma_table_info('${r.name}') ORDER BY cid;`;
                                updateSql(q);
                                runSql(q);
                              }}
                              className="i-ph:table text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent cursor-pointer"
                            />
                            <button
                              type="button"
                              title={`DROP TABLE ${r.name}`}
                              aria-label={`Drop ${r.name}`}
                              data-testid="data-sql-drop-table"
                              onClick={() => runSql(`DROP TABLE "${r.name}";`)}
                              className="i-ph:trash text-bolt-elements-textTertiary hover:text-red-400 cursor-pointer"
                            />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!sqlError && !sqlRunning && sqlMeta && sqlColumns.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="i-ph:check-circle-duotone text-2xl text-green-400" />
              <p className="text-xs text-bolt-elements-textSecondary">Query ran — no rows returned.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

DataPanel.displayName = 'DataPanel';
