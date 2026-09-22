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
} from './data-panel-logic';
import { classNames } from '~/utils/classNames';

type Status = 'loading' | 'ready' | 'error' | 'standalone';

const REQUEST_TIMEOUT_MS = 12_000;
const AUTO_REFRESH_MS = 30_000;

/** localStorage key for the SQL-console query history (per-browser, best-effort). */
const SQL_HISTORY_KEY = 'ps-data-sql-history';

/** `sqlite_master` table/view listing — the D1 manager's "show me every table" query. */
const LIST_TABLES_SQL =
  "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;";

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
   * D1 manager — read-only SQL console (super-admin only; the sql/exec endpoint reads the shared
   * multi-tenant DB). `canRunSql` arrives on the overview reply; `mode` toggles the console view.
   */
  const [canRunSql, setCanRunSql] = useState(false);
  const [mode, setMode] = useState<'tables' | 'sql'>('tables');
  const [sql, setSql] = useState(LIST_TABLES_SQL);
  const [sqlRows, setSqlRows] = useState<Record<string, unknown>[]>([]);
  const [sqlColumns, setSqlColumns] = useState<string[]>([]);
  const [sqlError, setSqlError] = useState('');
  const [sqlRunning, setSqlRunning] = useState(false);
  const [sqlMeta, setSqlMeta] = useState<{ rows: number; ms?: number } | null>(null);

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

  const openTable = useCallback((key: string) => {
    setActive(key);
    setRows([]);
    setColumns([]);
    setBrowseError('');
    setSearch('');
    setDetailIdx(null);
    setBrowseLoading(true);

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
  }, []);

  /*
   * Run ONE statement through the admin bridge (super-admin only). READS → POST /sql/exec;
   * WRITES (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE) → POST /sql/exec-write. Destructive writes
   * (DROP/ALTER, or DELETE/UPDATE without WHERE) get a type-to-confirm BEFORE sending; the worker
   * re-guards server-side (protected-table denylist + confirm). A 403/400 comes back as `sqlError`.
   */
  const runSql = useCallback((query: string) => {
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
      ...(write ? { write: true, confirm: confirmDestructive } : {}),
    });
  }, []);

  // Subscribe to PS_DATA_RESPONSE from the admin parent.
  useEffect(() => {
    if (!isEmbedded) {
      return undefined;
    }

    const off = onParentMessage((msg: ParentToChildMessage) => {
      // SQL console reply (D1 manager) — match on the sql correlation id.
      if (msg.type === 'PS_SQL_RESPONSE') {
        if (msg.correlationId !== sqlCid.current) {
          return;
        }

        if (sqlTimer.current) {
          clearTimeout(sqlTimer.current);
        }

        sqlCid.current = null;
        setSqlRunning(false);

        if (msg.error) {
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
          setSqlColumns([]);
          setSqlRows([]);
          setWriteResult({ rows_affected: msg.rows_affected, last_row_id: msg.last_row_id ?? null });
          setSqlMeta({ rows: msg.rows_affected, ms: msg.duration_ms });
          requestOverview();

          return;
        }

        setSqlColumns(msg.columns ?? []);
        setSqlRows(msg.rows ?? []);
        setWriteResult(null);
        setSqlMeta({ rows: (msg.rows ?? []).length, ms: msg.duration_ms });

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
  }, [requestOverview]);

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
  const visibleRows = useMemo(() => filterRows(rows, columns, search), [rows, columns, search]);

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

    const blob = new Blob([toCsv(sqlColumns, sqlRows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query-result.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [sqlColumns, sqlRows]);

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 overflow-y-auto modern-scrollbar">
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
                {(['tables', 'sql'] as const).map((m) => (
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
                    <div className={m === 'sql' ? 'i-ph:terminal-window' : 'i-ph:table'} />
                    {m === 'sql' ? 'SQL' : 'Tables'}
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
            {rows.length > 0 && (
              <button
                type="button"
                onClick={exportCsv}
                data-testid="data-export-csv"
                className="ml-auto text-[10px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer flex items-center gap-1"
                title="Export the current view to CSV"
              >
                <div className="i-ph:download-simple" /> CSV
              </button>
            )}
          </div>

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

          {!browseLoading && !browseError && visibleRows.length > 0 && (
            <div className="flex-1 overflow-auto modern-scrollbar">
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-bolt-elements-background-depth-2 z-10">
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c}
                        className="text-left font-medium text-bolt-elements-textTertiary px-3 py-1.5 border-b border-bolt-elements-borderColor/50 whitespace-nowrap"
                      >
                        {columnLabel(c)}
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
                        {columns.map((c) => (
                          <td
                            key={c}
                            className="px-3 py-1.5 text-bolt-elements-textSecondary align-top max-w-[220px] truncate"
                            title={formatCellValue(r[c])}
                          >
                            {formatCellValue(r[c])}
                          </td>
                        ))}
                      </tr>
                      {/* Row detail drill-down — every column, pretty-JSON for objects. */}
                      {detailIdx === i && (
                        <tr data-testid="data-row-detail">
                          <td colSpan={columns.length} className="bg-bolt-elements-background-depth-1 px-3 py-2">
                            <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1">
                              {detailEntries(r, columns).map(([label, val]) => (
                                <React.Fragment key={label}>
                                  <dt className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary pt-0.5">
                                    {label}
                                  </dt>
                                  <dd className="text-[11px] text-bolt-elements-textPrimary font-mono whitespace-pre-wrap break-words">
                                    {val}
                                  </dd>
                                </React.Fragment>
                              ))}
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
      {status === 'ready' && mode === 'sql' && (
        <div className="flex-1 flex flex-col min-h-0" data-testid="data-sql-console">
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
                    setSql(s.query);
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
                onClick={() => setSql(NEW_TABLE_TEMPLATE)}
                data-testid="data-sql-new-table"
                title="Drop a CREATE TABLE template into the editor — edit the name + columns, then Run"
                className="text-[10px] rounded-full px-2 py-0.5 border border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer flex items-center gap-1"
              >
                <div className="i-ph:plus" /> New table
              </button>
              <button
                type="button"
                onClick={() => setSql(`INSERT INTO my_table (column_a, column_b)\nVALUES ('value a', 'value b');`)}
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
                      setSql(h);
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
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  runSql(sql);
                }
              }}
              spellCheck={false}
              rows={4}
              data-testid="data-sql-input"
              placeholder="SELECT … · CREATE TABLE … · INSERT/UPDATE/DELETE …  (⌘↵ to run · destructive statements confirm first)"
              className="w-full resize-y rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-3 py-2 font-mono text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
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
              {sqlMeta && !sqlError && (
                <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums" data-testid="data-sql-meta">
                  {sqlMeta.rows.toLocaleString()} {sqlMeta.rows === 1 ? 'row' : 'rows'}
                  {typeof sqlMeta.ms === 'number' ? ` · ${sqlMeta.ms} ms` : ''}
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

          {!sqlError && sqlColumns.length > 0 && (
            <div className="flex-1 overflow-auto modern-scrollbar mt-1">
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-bolt-elements-background-depth-2 z-10">
                  <tr>
                    {sqlColumns.map((c) => (
                      <th
                        key={c}
                        className="text-left font-medium text-bolt-elements-textTertiary px-3 py-1.5 border-b border-bolt-elements-borderColor/50 whitespace-nowrap"
                      >
                        {c}
                      </th>
                    ))}
                    <th className="w-8 border-b border-bolt-elements-borderColor/50" />
                  </tr>
                </thead>
                <tbody>
                  {sqlRows.map((r, i) => (
                    <tr
                      key={i}
                      data-testid="data-sql-row"
                      className="border-b border-bolt-elements-borderColor/20 hover:bg-bolt-elements-background-depth-2/50"
                    >
                      {sqlColumns.map((c) => (
                        <td
                          key={c}
                          className="px-3 py-1.5 text-bolt-elements-textSecondary align-top max-w-[280px] truncate font-mono"
                          title={formatCellValue(r[c])}
                        >
                          {formatCellValue(r[c])}
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
                                setSql(q);
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
                                setSql(q);
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
