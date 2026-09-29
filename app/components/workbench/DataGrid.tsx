/**
 * @file DataGrid — a compact, read-only Notion/Airtable-grade grid, shared by the editor "Database"
 * tab's surfaces so a rows-of-data result ALWAYS renders in the same gorgeous form.
 *
 * @remarks
 * This is the SHARED presentational grid for read-only row sets. The Table-view
 * ({@link ./SiteTablesPanel}) owns the full EDITABLE per-site grid (inline edit, add/delete, DDL); this
 * one is its read-only sibling for surfaces that display query results — the SQL console's result set
 * ({@link ./SqlNavigator}) chief among them. It deliberately WIRES the same mature, unit-tested engine
 * both use — `filterRows` · `sortRows` · `cycleSortMulti` · `PAGE_SIZE_OPTIONS`/`clampPageSize` from
 * `./data-panel-logic`, and the typed cell renderer `classifyCell` from `./data-cell-format` — so a SQL
 * result looks and behaves EXACTLY like a browsed table: sticky sortable headers, whole-set substring
 * search, client-side pagination, and honest whole-result export (CSV/JSON/Copy export the full filtered
 * set, not just the visible page). No editing — a result set (which may join many tables) has no single
 * safe write target; the Table-view is where rows are edited.
 *
 * Style mirrors `./SiteTablesPanel` + `./SqlNavigator` exactly (UnoCSS `bolt-elements-*` tokens, phosphor
 * `i-ph:*` icons, black `#060610` + cyan `#00E5FF`).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  cycleSortMulti,
  sortRows,
  filterRows,
  PAGE_SIZE_OPTIONS,
  clampPageSize,
  detectChartable,
  type GridSort,
} from './data-panel-logic';
import { classifyCell } from './data-cell-format';
import { ChartView } from './ChartView';

export interface DataGridProps {
  /** Column display order (usually the query's select list, or `Object.keys(rows[0])`). */
  columns: string[];

  /** The row set to render (already fetched; client-side filter/sort/paginate happen here). */
  rows: Record<string, unknown>[];

  /** Root `data-testid` (the table gets `${testId}-table`, the search `${testId}-search`, etc.). */
  testId?: string;

  /** Max grid body height (Tailwind class) so the grid scrolls within its panel. */
  maxHeightClass?: string;

  /** Initial page size (clamped to {@link PAGE_SIZE_OPTIONS}); default 50. */
  initialPageSize?: number;

  /** Optional label for the export filename stem (default `result`). */
  exportName?: string;

  /**
   * Optional drill-in handler. When set, a cell in the openable column (see {@link openableColumn}) renders
   * as a cyan, clickable "open" affordance that calls `onOpenValue(column, value)` INSTEAD of copy — used by
   * the SQL navigator to turn a `sqlite_master` table-name list into a click-to-browse action. Cells in every
   * OTHER column keep their normal click-to-copy behavior. Optional — omitting it leaves the grid unchanged.
   */
  onOpenValue?: (column: string, value: string) => void;

  /**
   * The column whose cells become the clickable "open" affordance when {@link onOpenValue} is set.
   * Defaults to `name` (the `SELECT name FROM sqlite_master …` table-list convention). Ignored when
   * `onOpenValue` is not provided.
   */
  openableColumn?: string;
}

/** A generic client-side download of `text` as `filename` (fail-soft in sandboxed frames). */
function downloadText(text: string, filename: string, mime: string): void {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // download unavailable (sandboxed) — fail soft; the grid still shows the data
  }
}

/** RFC-4180 CSV: quote a field iff it contains a comma, quote, CR, or LF; double internal quotes. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize the full (filtered + sorted) set to CSV — headers + one row per record. */
function toCsvText(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');

  return body ? `${head}\r\n${body}` : head;
}

/** Serialize the full set to tab-separated text (for a clipboard paste into a spreadsheet). */
function toTsvText(columns: string[], rows: Record<string, unknown>[]): string {
  const clean = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]/g, ' '));
  const head = columns.join('\t');
  const body = rows.map((r) => columns.map((c) => clean(r[c])).join('\t')).join('\n');

  return body ? `${head}\n${body}` : head;
}

export const DataGrid = memo(
  ({
    columns,
    rows,
    testId = 'data-grid',
    maxHeightClass = 'max-h-[52vh]',
    initialPageSize = 50,
    exportName = 'result',
    onOpenValue,
    openableColumn = 'name',
  }: DataGridProps) => {
    const [sorts, setSorts] = useState<GridSort[]>([]);
    const [search, setSearch] = useState('');
    const [pageSize, setPageSize] = useState<number>(clampPageSize(initialPageSize));
    const [pageIndex, setPageIndex] = useState(0);
    const [copied, setCopied] = useState(false);
    const [copiedCell, setCopiedCell] = useState<string | null>(null);
    const [exportOpen, setExportOpen] = useState(false);

    /*
     * Rev 5 — Grid | Chart view. Chartability is AUTO-DETECTED from the already-loaded result
     * (`detectChartable`: a label column + ≥1 numeric column, summary-sized) — no new endpoint, no
     * refetch. `view='chart'` renders the inline-SVG {@link ChartView}; when nothing is chartable the
     * Chart affordance yields an honest note (never a dead/broken toggle).
     */
    const [view, setView] = useState<'grid' | 'chart'>('grid');
    const chartSpec = useMemo(() => detectChartable(columns, rows), [columns, rows]);
    const [measure, setMeasure] = useState<string | null>(null);

    // Keep the chosen measure valid as the result (and thus its numeric columns) changes.
    const activeMeasure = chartSpec
      ? measure && chartSpec.valueCols.includes(measure)
        ? measure
        : chartSpec.valueCols[0]
      : null;

    /** Click any result cell to copy its raw value — the SQL console's most-wanted micro-action. */
    const copyCell = useCallback((key: string, value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value);

      try {
        void navigator.clipboard.writeText(text);
        setCopiedCell(key);
        setTimeout(() => setCopiedCell((c) => (c === key ? null : c)), 1100);
      } catch {
        /* clipboard blocked (sandboxed) — no-op; the value is still visible + hover-titled */
      }
    }, []);
    const exportRef = useRef<HTMLDivElement | null>(null);

    // A fresh result set (new columns/rows identity) resets the view so stale sort/search/chart never linger.
    useEffect(() => {
      setSorts([]);
      setSearch('');
      setPageIndex(0);
      setView('grid');
      setMeasure(null);
    }, [columns, rows]);

    // Any search/sort/pagesize change returns to page 0 (never strand the user past the end).
    useEffect(() => {
      setPageIndex(0);
    }, [search, sorts, pageSize]);

    // Close the export menu on an outside click.
    useEffect(() => {
      if (!exportOpen) {
        return;
      }

      const onDown = (e: MouseEvent) => {
        if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
          setExportOpen(false);
        }
      };

      document.addEventListener('mousedown', onDown);

      return () => document.removeEventListener('mousedown', onDown);
    }, [exportOpen]);

    /** The full filtered + multi-column-sorted set (across every row, not just the page). */
    const processed = useMemo(() => {
      let out = filterRows(rows, columns, search);

      // Apply sorts from LAST priority to FIRST so the first sort wins (stable multi-sort).
      for (let i = sorts.length - 1; i >= 0; i--) {
        out = sortRows(out, sorts[i]);
      }

      return out;
    }, [rows, columns, search, sorts]);

    const total = processed.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePageIndex = Math.min(pageIndex, pageCount - 1);
    const pageRows = useMemo(
      () => processed.slice(safePageIndex * pageSize, safePageIndex * pageSize + pageSize),
      [processed, safePageIndex, pageSize],
    );

    const onSortColumn = useCallback((col: string) => setSorts((cur) => cycleSortMulti(cur, col)), []);

    const sortFor = useCallback(
      (col: string): { dir: 'asc' | 'desc'; priority: number } | null => {
        const i = sorts.findIndex((s) => s.col === col);
        return i < 0 ? null : { dir: sorts[i].dir, priority: i + 1 };
      },
      [sorts],
    );

    const exportCsv = useCallback(() => {
      downloadText(toCsvText(columns, processed), `${exportName}.csv`, 'text/csv');
      setExportOpen(false);
    }, [columns, processed, exportName]);

    const exportJson = useCallback(() => {
      downloadText(JSON.stringify(processed, null, 2), `${exportName}.json`, 'application/json');
      setExportOpen(false);
    }, [processed, exportName]);

    const copyTsv = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(toTsvText(columns, processed));
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {
        // clipboard blocked — fall back to a download so the data is never trapped
        downloadText(toCsvText(columns, processed), `${exportName}.csv`, 'text/csv');
      }

      setExportOpen(false);
    }, [columns, processed, exportName]);

    if (columns.length === 0) {
      return null;
    }

    const rangeStart = total === 0 ? 0 : safePageIndex * pageSize + 1;
    const rangeEnd = Math.min(total, (safePageIndex + 1) * pageSize);

    return (
      <div data-testid={testId} className="[color-scheme:dark] accent-[color:var(--ps-accent,#00e5ff)]">
        {/* Toolbar — search · count · export */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <div
              className="i-ph:magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary text-sm"
              aria-hidden
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search results…"
              aria-label="Search results"
              data-testid={`${testId}-search`}
              className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 py-1.5 pl-8 pr-2 text-xs text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:border-bolt-elements-item-contentAccent focus:outline-none"
            />
          </div>

          <span
            className="px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary tabular-nums text-[10px]"
            data-testid={`${testId}-count`}
          >
            {total.toLocaleString()} {total === 1 ? 'row' : 'rows'}
            {search && rows.length !== total ? ` of ${rows.length.toLocaleString()}` : ''}
          </span>

          {/* Grid | Chart view toggle — a SELECT becomes an instant visualization (Rev 5). */}
          <div
            role="group"
            aria-label="Result view"
            data-testid={`${testId}-viewtoggle`}
            className="inline-flex overflow-hidden rounded-md border border-bolt-elements-borderColor"
          >
            {(['grid', 'chart'] as const).map((v) => {
              const isActive = view === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={isActive}
                  data-testid={`${testId}-view-${v}`}
                  title={v === 'grid' ? 'Table view' : 'Chart view — plot a numeric column'}
                  className={classNames(
                    'flex items-center gap-1 px-2 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                    isActive
                      ? 'bg-[#00e5ff26] text-bolt-elements-item-contentAccent'
                      : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundAccent/10',
                  )}
                >
                  <div className={classNames(v === 'grid' ? 'i-ph:table' : 'i-ph:chart-bar', 'text-sm')} aria-hidden />
                  {v === 'grid' ? 'Grid' : 'Chart'}
                </button>
              );
            })}
          </div>

          <div className="relative" ref={exportRef}>
            <button
              type="button"
              onClick={() => setExportOpen((o) => !o)}
              className="flex items-center gap-1 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1.5 text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-[#00e5ff99] transition-colors"
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              data-testid={`${testId}-export`}
            >
              <div className={classNames(copied ? 'i-ph:check' : 'i-ph:download-simple', 'text-sm')} aria-hidden />
              {copied ? 'Copied' : 'Export'}
            </button>
            {exportOpen && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={exportCsv}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundAccent/10 hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:file-csv text-sm" aria-hidden /> CSV
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={exportJson}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundAccent/10 hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:brackets-curly text-sm" aria-hidden /> JSON
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={copyTsv}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundAccent/10 hover:text-bolt-elements-textPrimary"
                >
                  <div className="i-ph:copy text-sm" aria-hidden /> Copy
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Chart view — an inline-SVG bar chart of the already-loaded result (Rev 5). */}
        {view === 'chart' &&
          (chartSpec && activeMeasure ? (
            <ChartView
              spec={chartSpec}
              rows={processed}
              measure={activeMeasure}
              onMeasureChange={setMeasure}
              testId={`${testId}-chart`}
            />
          ) : (
            <div
              data-testid={`${testId}-chart-empty`}
              className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-6 text-center"
              role="status"
            >
              <div className="i-ph:chart-bar text-2xl text-bolt-elements-textTertiary" aria-hidden />
              <p className="text-xs text-bolt-elements-textSecondary">No chartable columns in this result</p>
              <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px]">
                A chart needs a label column plus a numeric column to plot. Try a query that groups by a
                category and returns a count or sum.
              </p>
            </div>
          ))}

        {/* Grid */}
        {view === 'grid' && (
        <div
          className={classNames(
            'overflow-auto modern-scrollbar rounded-md border border-bolt-elements-borderColor shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]',
            maxHeightClass,
          )}
        >
          <table className="min-w-full text-xs font-mono border-collapse tabular-nums" data-testid={`${testId}-table`}>
            <thead>
              <tr className="bg-bolt-elements-background-depth-2">
                {columns.map((name) => {
                  const s = sortFor(name);
                  return (
                    <th
                      key={name}
                      onClick={() => onSortColumn(name)}
                      title={`Sort by ${name}`}
                      className="sticky top-0 z-10 cursor-pointer select-none text-left px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 whitespace-nowrap hover:text-bolt-elements-item-contentAccent after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[#00e5ff40]"
                    >
                      <span className="inline-flex items-center gap-1">
                        {name}
                        {s && (
                          <span className="inline-flex items-center text-bolt-elements-item-contentAccent">
                            <div
                              className={classNames(
                                s.dir === 'asc' ? 'i-ph:arrow-up' : 'i-ph:arrow-down',
                                'text-[10px]',
                              )}
                              aria-hidden
                            />
                            {sorts.length > 1 && <span className="text-[9px]">{s.priority}</span>}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, ri) => (
                <tr
                  key={ri}
                  className="odd:bg-bolt-elements-background-depth-1 even:bg-bolt-elements-background-depth-2/30 hover:bg-bolt-elements-item-backgroundAccent/10 transition-colors motion-reduce:transition-none"
                >
                  {columns.map((name) => {
                    const classified = classifyCell(row[name]);
                    const cellKey = `${ri}:${name}`;
                    const isCopied = copiedCell === cellKey;

                    /*
                     * Openable cell: when a drill-in handler is wired for this column and the value is a real
                     * string, the cell IS the "open" action (cyan, clickable) — it takes precedence over copy.
                     */
                    const rawValue = row[name];
                    const isOpenable =
                      !!onOpenValue &&
                      name === openableColumn &&
                      typeof rawValue === 'string' &&
                      rawValue.trim().length > 0;

                    if (isOpenable) {
                      const value = String(rawValue);
                      return (
                        <td
                          key={name}
                          className="px-3 py-1.5 border-b border-bolt-elements-borderColor/30 whitespace-nowrap max-w-[280px]"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenValue!(name, value)}
                            data-testid={`${testId}-open`}
                            title={`Open ${value} — browse this table`}
                            className="inline-flex max-w-full items-center gap-1 truncate rounded text-left font-medium text-bolt-elements-item-contentAccent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                          >
                            <div className="i-ph:table shrink-0 text-xs" aria-hidden />
                            <span className="truncate">{value}</span>
                          </button>
                        </td>
                      );
                    }

                    return (
                      <td
                        key={name}
                        onClick={() => copyCell(cellKey, row[name])}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            copyCell(cellKey, row[name]);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Copy ${name}`}
                        className={classNames(
                          'px-3 py-1.5 border-b border-bolt-elements-borderColor/30 whitespace-nowrap max-w-[280px] truncate cursor-pointer',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                          isCopied && 'ring-2 ring-inset ring-[#00e5ffb2]',
                          classified.className,
                        )}
                        title={
                          classified.kind === 'null'
                            ? 'null · click to copy'
                            : `${classified.title ?? classified.display} · click to copy`
                        }
                      >
                        {isCopied ? (
                          <span className="inline-flex items-center gap-1 text-bolt-elements-item-contentAccent">
                            <div className="i-ph:check text-xs" aria-hidden /> Copied
                          </span>
                        ) : classified.kind === 'null' ? (
                          <span className="text-bolt-elements-textTertiary/50">—</span>
                        ) : (
                          classified.display
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

        {/* Pager */}
        {view === 'grid' && total > pageSize && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-bolt-elements-textTertiary">
            <span className="tabular-nums">
              {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1">
                <span className="sr-only">Rows per page</span>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(clampPageSize(Number(e.target.value)))}
                  aria-label="Rows per page"
                  data-testid={`${testId}-pagesize`}
                  className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-1.5 py-1 text-[11px] text-bolt-elements-textSecondary focus:border-bolt-elements-item-contentAccent focus:outline-none"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={n} value={n}>
                      {n} / page
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                disabled={safePageIndex === 0}
                aria-label="Previous page"
                className="rounded-md border border-bolt-elements-borderColor px-2 py-1 disabled:opacity-40 enabled:hover:border-[#00e5ff99]"
              >
                <div className="i-ph:caret-left" aria-hidden />
              </button>
              <span className="tabular-nums">
                {safePageIndex + 1} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
                disabled={safePageIndex >= pageCount - 1}
                aria-label="Next page"
                className="rounded-md border border-bolt-elements-borderColor px-2 py-1 disabled:opacity-40 enabled:hover:border-[#00e5ff99]"
              >
                <div className="i-ph:caret-right" aria-hidden />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  },
);

DataGrid.displayName = 'DataGrid';
