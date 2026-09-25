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
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEmbedded, postToParent, onParentMessage } from '~/lib/embed/embedded-mode';
import type { DataOverviewTable, ParentToChildMessage } from '~/lib/embed/embedded-mode';
import { KvBrowser } from './KvBrowser';
import { R2Browser } from './R2Browser';
import { VectorizeBrowser } from './VectorizeBrowser';
import { QueuesBrowser } from './QueuesBrowser';
import {
  iconForTable,
  formatCellValue,
  summarizeTables,
  newCorrelationId,
  columnLabel,
  toCsv,
  filterRows,
  detailEntries,
  isRowActivationKey,
  isDismissKey,
  addToSqlHistory,
  addSavedQuery,
  removeSavedQuery,
  type SavedQuery,
  explainQuery,
  explainPlanHint,
  isExpensiveScan,
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
  buildDeleteByPk,
  buildBulkDeleteByPk,
  rowPkKey,
  MAX_BULK_DELETE,
  buildUpdateByPk,
  pkFromTableInfo,
  RowMutationError,
  type CellInputKind,
  type BoundValue,
} from './data-panel-logic';
import { SqlEditor } from './SqlEditor';
import { classNames } from '~/utils/classNames';
import { classifyCell, columnTypeBadge } from './data-cell-format';
import { JsonTree } from './JsonTree';
import { rowToInsert, rowToUpdateByPk, rowsToMarkdown } from './data-copy-as';
import { computeAggregates } from './data-aggregates';

type Status = 'loading' | 'ready' | 'error' | 'standalone';

const REQUEST_TIMEOUT_MS = 12_000;
const AUTO_REFRESH_MS = 30_000;

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
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
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
  const [mode, setMode] = useState<'tables' | 'sql' | 'kv' | 'r2' | 'vec' | 'queues'>('tables');

  /*
   * Add-row — a typed row editor that builds a PARAMETERIZED INSERT (values BOUND via ?N, never
   * concatenated) and sends it through the super-admin-gated write path. Only reachable when
   * `canRunSql`. A column left at 'default' is omitted so its DB default / autoincrement applies.
   */
  const [addingRow, setAddingRow] = useState(false);
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

  const openTable = useCallback(
    (key: string) => {
      setActive(key);
      setRows([]);
      setColumns([]);
      setBrowseError('');
      setSearch('');
      setDetailIdx(null);
      setBrowseSort(null);
      setHiddenCols(readHiddenCols(key)); // restore this table's column selection
      setColMenuOpen(false);
      setBrowseLoading(true);
      setBrowsePkCols([]); // clear the prior table's PK until this one's PRAGMA returns
      setBrowseColTypes({});
      setSelectedKeys(new Set()); // never carry a bulk selection across a table switch / re-fetch

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
      postToParent({ type: 'PS_DATA_REQUEST', table: key, correlationId: cid });

      /*
       * Super-admins get row DELETE — resolve the PK via PRAGMA table_info on its OWN correlation id
       * (a plain valid identifier only, so the quoted PRAGMA arg is injection-free). Read-only path.
       */
      if (canRunSql && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        const pcid = newCorrelationId(`pk-${key}`);
        pkCid.current = pcid;
        postToParent({ type: 'PS_SQL_REQUEST', query: `PRAGMA table_info("${key}")`, correlationId: pcid });
      }
    },
    [canRunSql],
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

  const openAddRow = useCallback(() => {
    setAddError('');
    setAddKinds({}); // every column starts at 'default' (omitted) — user opts in per column
    setAddValues({});
    setAddingRow(true);
  }, []);

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

  // Columns the user opted to set (kind !== 'default'), in table-column order.
  const addActiveCols = useMemo(
    () => columns.filter((c) => addKinds[c] && addKinds[c] !== 'default'),
    [columns, addKinds],
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

    const cols = columns.filter((c) => addKinds[c] && addKinds[c] !== 'default');

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
  }, [active, columns, addKinds, addValues, runSql]);

  // Subscribe to PS_DATA_RESPONSE from the admin parent.
  useEffect(() => {
    if (!isEmbedded) {
      return undefined;
    }

    const off = onParentMessage((msg: ParentToChildMessage) => {
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
            // Also extract declared types for columnTypeBadge display.
            const typeMap: Record<string, string> = {};
            for (const row of tableInfoRows) {
              const colName = String(row.name ?? row.column ?? '').trim();
              const colType = String(row.type ?? '').trim();
              if (colName && colType) {
                typeMap[colName] = colType;
              }
            }
            setBrowseColTypes(typeMap);
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
            setDetailIdx(null);

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
            setDetailIdx(null);
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
            setDetailIdx(null);

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
  // Schema-aware SQL completion feed — REAL table + column identifiers from the inspected schema
  // (never fabricated). Table keys + the de-duplicated union of every table's columns.
  const sqlSchema = useMemo(
    () => ({
      tables: tables.map((t) => t.key),
      columns: [...new Set(tables.flatMap((t) => t.columns ?? []))],
    }),
    [tables],
  );
  const visibleRows = useMemo(
    () => sortRows(filterRows(rows, columns, search), browseSort),
    [rows, columns, search, browseSort],
  );

  /**
   * Columns the GRID renders — the full set minus the user's hidden selection (view-only;
   *  row-detail + exports still use `columns`).
   */
  const visibleCols = useMemo(() => visibleColumns(columns, hiddenCols), [columns, hiddenCols]);

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
  const toggleBrowseSort = useCallback((col: string) => {
    setBrowseSort((s) => nextSort(s, col));
    setDetailIdx(null);
  }, []);

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
    if (selectedKeys.size === 0) return null;
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
  const startEdit = useCallback((col: string, rawValue: unknown): void => {
    setEditError('');
    setEditCol(col);

    const { kind, value } = inferCellEditor(rawValue);
    setEditKind(kind);
    setEditValue(value);
  }, []);

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
        if (browsePkCols.includes(col)) {
          kinds[col] = 'default'; // omit the key → DB assigns a fresh one
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
      setDetailIdx(null); // collapse the source row-detail; the prefilled form is at the top
    },
    [columns, browsePkCols],
  );

  const cancelEdit = useCallback((): void => {
    setEditCol(null);
    setEditError('');
  }, []);

  /** Live preview of the exact parameterized UPDATE (SQL shape only — value is bound as ?1). */
  const editPreview = useCallback((): string | null => {
    const r = detailIdx != null ? visibleRows[detailIdx] : null;

    if (!active || !editCol || !r) {
      return null;
    }

    try {
      return buildUpdateByPk(active, browsePkCols, r, editCol, null).sql;
    } catch {
      return null;
    }
  }, [active, editCol, browsePkCols, detailIdx, visibleRows]);

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

  const exportCsv = useCallback(() => {
    if (typeof document === 'undefined' || !activeTable) {
      return;
    }

    const csv = toCsv(columns, visibleRows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTable.key}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [activeTable, columns, visibleRows]);

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
              <div
                className="flex items-center rounded-md border border-bolt-elements-borderColor overflow-hidden text-[10px] font-medium"
                role="tablist"
                aria-label="Data view"
              >
                {(['tables', 'sql', 'kv', 'r2', 'vec', 'queues'] as const).map((m) => (
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
                    <div
                      className={
                        m === 'sql'
                          ? 'i-ph:terminal-window'
                          : m === 'kv'
                            ? 'i-ph:key'
                            : m === 'r2'
                              ? 'i-ph:hard-drives'
                              : m === 'vec'
                                ? 'i-ph:graph'
                                : m === 'queues'
                                  ? 'i-ph:stack'
                                  : 'i-ph:table'
                      }
                    />
                    {m === 'sql'
                      ? 'SQL'
                      : m === 'kv'
                        ? 'KV'
                        : m === 'r2'
                          ? 'R2'
                          : m === 'vec'
                            ? 'Vectors'
                            : m === 'queues'
                              ? 'Queues'
                              : 'Tables'}
                  </button>
                ))}
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
            {/* HONEST disclosure — never imply the window is the whole table (silent-cap lesson). */}
            <span className="text-[10px] text-bolt-elements-textTertiary" data-testid="data-window-note">
              {activeTable.row_count.toLocaleString()} total · showing latest{' '}
              {Math.min(activeTable.row_count, rows.length || 0).toLocaleString()}
              {search && rows.length > 0 ? ` · ${visibleRows.length} match` : ''}
            </span>
            {(canRunSql || rows.length > 0) && (
              <div className="ml-auto flex items-center gap-3">
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
                  <button
                    type="button"
                    onClick={exportCsv}
                    data-testid="data-export-csv"
                    className="text-[10px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer flex items-center gap-1"
                    title="Export the current view to CSV (every column, not just the visible ones)"
                  >
                    <div className="i-ph:download-simple" /> CSV
                  </button>
                )}
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

          {/* In-table search */}
          {rows.length > 0 && (
            <div className="px-3 py-1.5 border-b border-bolt-elements-borderColor/30">
              <div className="flex items-center gap-2 rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-2 py-1">
                <div className="i-ph:magnifying-glass text-bolt-elements-textTertiary text-xs" />
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setDetailIdx(null);
                  }}
                  placeholder={`Filter ${activeTable.label.toLowerCase()}…`}
                  data-testid="data-search"
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-transparent text-xs text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="i-ph:x text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary text-xs cursor-pointer"
                    title="Clear"
                  />
                )}
              </div>
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

          {!browseLoading && !browseError && visibleRows.length > 0 && (
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
                    <React.Fragment key={i}>
                      <tr
                        onClick={() => setDetailIdx(detailIdx === i ? null : i)}
                        onKeyDown={(e) => {
                          /*
                           * Keyboard parity with the click toggle (WCAG 2.1.1). Space would
                           * otherwise scroll the table body — prevent that before toggling.
                           */
                          if (isRowActivationKey(e.key)) {
                            e.preventDefault();
                            setDetailIdx(detailIdx === i ? null : i);
                          } else if (isDismissKey(e.key) && detailIdx === i) {
                            /* Escape collapses the open detail — the natural "close this" gesture. */
                            e.preventDefault();
                            setDetailIdx(null);
                          }
                        }}
                        tabIndex={0}
                        aria-expanded={detailIdx === i}
                        aria-label={`Row ${i + 1} of ${visibleRows.length} — ${detailIdx === i ? 'hide' : 'show'} detail`}
                        data-testid="data-row"
                        className={classNames(
                          'border-b border-bolt-elements-borderColor/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                          detailIdx === i
                            ? 'bg-bolt-elements-item-backgroundActive'
                            : 'hover:bg-bolt-elements-background-depth-2/50',
                        )}
                      >
                        {selectable && (
                          <td
                            className="w-8 px-2 py-1.5 align-top"
                            onClick={(e) => e.stopPropagation()} // the checkbox toggles selection, not the row detail
                          >
                            <input
                              type="checkbox"
                              checked={
                                rowPkKey(r, browsePkCols) !== null && selectedKeys.has(rowPkKey(r, browsePkCols)!)
                              }
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
                          return (
                            <td
                              key={c}
                              className="px-3 py-1.5 align-top max-w-[220px] truncate"
                              title={cell.display}
                            >
                              <span className={cell.className}>{cell.display}</span>
                            </td>
                          );
                        })}
                      </tr>
                      {/* Row detail drill-down — every column, pretty-JSON for objects. */}
                      {detailIdx === i && (
                        <tr data-testid="data-row-detail">
                          <td
                            colSpan={visibleCols.length + (selectable ? 1 : 0)}
                            className="bg-bolt-elements-background-depth-1 px-3 py-2"
                          >
                            <div className="flex items-center justify-end gap-2 mb-1.5">
                              {/* No primary key → can't target this row safely; explain, never a doomed Delete. */}
                              {canRunSql && browsePkCols.length === 0 && (
                                <span
                                  className="text-[10px] text-bolt-elements-textTertiary"
                                  data-testid="data-no-pk-note"
                                  title="This table has no primary key, so a single row can't be safely targeted for delete."
                                >
                                  No primary key — read-only
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => copyRow(r)}
                                data-testid="data-copy-row"
                                title="Copy this row as JSON"
                                className="flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 cursor-pointer"
                              >
                                <div className="i-ph:copy text-[11px]" /> Copy row (JSON)
                              </button>
                              {active && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    writeClipboard(rowToInsert(active, r));
                                    flashStatus('Copied INSERT');
                                  }}
                                  data-testid="data-copy-insert"
                                  title="Copy this row as an INSERT statement"
                                  className="flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 cursor-pointer"
                                >
                                  <div className="i-ph:code text-[11px]" /> INSERT
                                </button>
                              )}
                              {active && (
                                <button
                                  type="button"
                                  disabled={browsePkCols.length === 0}
                                  onClick={() => {
                                    if (browsePkCols.length === 0) return;
                                    writeClipboard(rowToUpdateByPk(active, r, browsePkCols));
                                    flashStatus('Copied UPDATE');
                                  }}
                                  data-testid="data-copy-update"
                                  title={
                                    browsePkCols.length === 0
                                      ? 'UPDATE not available — no primary key'
                                      : 'Copy this row as an UPDATE statement'
                                  }
                                  className={classNames(
                                    'flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border cursor-pointer',
                                    browsePkCols.length === 0
                                      ? 'border-bolt-elements-borderColor/30 text-bolt-elements-textTertiary opacity-40 cursor-not-allowed'
                                      : 'border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40',
                                  )}
                                >
                                  <div className="i-ph:pencil-line text-[11px]" /> UPDATE
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  writeClipboard(rowsToMarkdown(columns, [r]));
                                  flashStatus('Copied Markdown');
                                }}
                                data-testid="data-copy-markdown"
                                title="Copy this row as a Markdown table"
                                className="flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 cursor-pointer"
                              >
                                <div className="i-ph:table text-[11px]" /> Markdown
                              </button>
                              {/* Duplicate row — super-admin only; opens the Add-row form prefilled
                                  from this row, with the PK omitted (DB assigns a fresh key). */}
                              {canRunSql && (
                                <button
                                  type="button"
                                  onClick={() => duplicateRow(r)}
                                  data-testid="data-duplicate-row"
                                  title="Duplicate this row — opens the Add-row form prefilled (primary key omitted so a new one is generated)"
                                  className="flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 cursor-pointer"
                                >
                                  <div className="i-ph:copy-simple text-[11px]" /> Duplicate
                                </button>
                              )}
                              {/* Delete row — super-admin only (gated /sql/exec-write) + a resolvable PK. */}
                              {canRunSql && browsePkCols.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => deleteRow(r)}
                                  data-testid="data-delete-row"
                                  title="Permanently delete this row (parameterized, keyed by primary key)"
                                  className="flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/70 cursor-pointer"
                                >
                                  <div className="i-ph:trash text-[11px]" /> Delete row
                                </button>
                              )}
                            </div>
                            <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1">
                              {detailEntries(r, columns).map(([label, val], idx) => {
                                const col = columns[idx];

                                // Editable = super-admin + a resolvable PK + this column is NOT part of the key.
                                const editable = canRunSql && browsePkCols.length > 0 && !browsePkCols.includes(col);
                                const editing = editCol === col;

                                return (
                                  <React.Fragment key={label}>
                                    <dt className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary pt-0.5">
                                      {label}
                                    </dt>
                                    <dd className="group text-[11px] text-bolt-elements-textPrimary font-mono whitespace-pre-wrap break-words flex items-start gap-1.5">
                                      {editing ? (
                                        <div className="flex w-full flex-col gap-1" data-testid="data-edit-cell">
                                          <div className="flex items-center gap-1.5">
                                            <select
                                              value={editKind}
                                              onChange={(e) => {
                                                setEditError('');
                                                setEditKind(e.target.value as CellInputKind);
                                              }}
                                              data-testid="data-edit-kind"
                                              aria-label={`Type for ${label}`}
                                              className="shrink-0 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[10px] text-bolt-elements-textPrimary focus:outline-none"
                                            >
                                              <option value="text">text</option>
                                              <option value="number">number</option>
                                              <option value="boolean">boolean</option>
                                              <option value="null">NULL</option>
                                              <option value="json">JSON</option>
                                            </select>
                                            <input
                                              value={editValue}
                                              onChange={(e) => {
                                                setEditError('');
                                                setEditValue(e.target.value);
                                              }}
                                              disabled={editKind === 'null'}
                                              data-testid="data-edit-value"
                                              aria-label={`New value for ${label}`}
                                              placeholder={
                                                editKind === 'null'
                                                  ? 'NULL'
                                                  : editKind === 'boolean'
                                                    ? 'true / false'
                                                    : ''
                                              }
                                              spellCheck={false}
                                              className={classNames(
                                                'min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-0.5 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none',
                                                editKind === 'null' ? 'opacity-40' : '',
                                              )}
                                            />
                                          </div>
                                          {editPreview() && (
                                            <div
                                              className="overflow-x-auto rounded bg-bolt-elements-background-depth-2 px-2 py-1 text-[10px] text-bolt-elements-textTertiary"
                                              data-testid="data-edit-preview"
                                            >
                                              {editPreview()}
                                            </div>
                                          )}
                                          {editError && (
                                            <p
                                              className="text-[10px] text-red-400"
                                              role="alert"
                                              data-testid="data-edit-error"
                                            >
                                              {editError}
                                            </p>
                                          )}
                                          <div className="flex items-center gap-2">
                                            <button
                                              type="button"
                                              onClick={() => submitEdit(r)}
                                              disabled={editBusy}
                                              data-testid="data-edit-save"
                                              className={classNames(
                                                'rounded px-2 py-0.5 text-[10px] font-medium',
                                                editBusy
                                                  ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
                                                  : 'cursor-pointer bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:opacity-90',
                                              )}
                                            >
                                              {editBusy ? 'Saving…' : 'Save'}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={cancelEdit}
                                              disabled={editBusy}
                                              data-testid="data-edit-cancel"
                                              className="cursor-pointer text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <>
                                          {classifyCell(r[col]).isJson ? (
                                            <div className="min-w-0 w-full" data-testid="data-json-tree">
                                              <JsonTree
                                                value={
                                                  typeof r[col] === 'object'
                                                    ? (r[col] as Record<string, unknown> | unknown[])
                                                    : (() => {
                                                        try { return JSON.parse(r[col] as string) as Record<string, unknown> | unknown[]; } catch { return {}; }
                                                      })()
                                                }
                                                rootLabel={col}
                                              />
                                            </div>
                                          ) : (
                                            <span className="min-w-0 break-words">{val}</span>
                                          )}
                                          {clipboardValue(r[col]) && (
                                            <button
                                              type="button"
                                              onClick={() => copyValue(r[col], label)}
                                              data-testid="data-copy-cell"
                                              title={`Copy ${label}`}
                                              aria-label={`Copy ${label}`}
                                              className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 focus:opacity-100 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent cursor-pointer transition-opacity"
                                            >
                                              <div className="i-ph:copy text-[11px]" />
                                            </button>
                                          )}
                                          {editable && (
                                            <button
                                              type="button"
                                              onClick={() => startEdit(col, r[col])}
                                              data-testid="data-edit-cell-open"
                                              title={`Edit ${label}`}
                                              aria-label={`Edit ${label}`}
                                              className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 focus:opacity-100 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent cursor-pointer transition-opacity"
                                            >
                                              <div className="i-ph:pencil-simple text-[11px]" />
                                            </button>
                                          )}
                                        </>
                                      )}
                                    </dd>
                                  </React.Fragment>
                                );
                              })}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

          {!sqlError && sqlColumns.length > 0 && (
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
