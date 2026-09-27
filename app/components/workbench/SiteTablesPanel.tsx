/**
 * @file Site Tables — read-only browser for a site's OWN dedicated per-site Cloudflare D1.
 *
 * @remarks
 * This is the editor "Data" tab's per-site Tables surface. It reads the customer's OWN
 * dedicated Cloudflare D1 (blank at first, lazily provisioned) — NEVER the shared platform DB
 * and NEVER another site's. Isolation is enforced SERVER-side: the worker resolves the site's
 * `d1_database_id` from `site_database_allocations` for the OWNED site and executes against that
 * one id. This panel never sees a DB id it could tamper with.
 *
 * The embedded editor has no cross-origin session, so it CANNOT fetch the worker directly — it
 * talks to the parent admin (which holds the bearer + `selectedSite`) over `postMessage`. The
 * four `PS_SITEDB_*` bridge messages carry the two GET endpoints:
 *   - `GET /api/sites/:siteId/db/tables`                    → { databaseId, provisioned, tables }
 *   - `GET /api/sites/:siteId/db/tables/:table?limit&offset` → { table, columns, rows, total }
 * Both are DARK behind the `per_site_data` flag (404 "Per-site data is not enabled") — when off,
 * this panel shows a friendly "not enabled yet" state, never a scary error.
 *
 * READ-ONLY by design: browse tables, page through rows, inspect a row, export the current page.
 * The empty-database launchpad ("New table" / "Ask AI") is the seam for the NEXT slice — the
 * buttons surface an inline "Coming soon" note rather than dead-air a click.
 *
 * Style matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor
 * `i-ph:*` icons) — mirrors `./FunctionsPanel` + `./Preview`.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type SiteDbTablesResponseMessage,
  type SiteDbRowsResponseMessage,
} from '~/lib/embed/embedded-mode';
import { fieldTypeFor, type FieldKind } from './field-types';

// ── Types ────────────────────────────────────────────────────────────────────

/** One column descriptor from `PRAGMA table_info` (notnull / pk are 0/1 SQLite ints). */
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** A browsed page: the schema + the rows + the pagination window echoed by the worker. */
interface TablePage {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  total: number;
}

type TablesState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; databaseId: string; provisioned: boolean; tables: { name: string }[] };

type RowsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; page: TablePage };

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;
const ROW_HEIGHT = 34; // px — matched to the grid row padding below
const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'Per-site data is not enabled';

/** Monotonic per-module counter so every request gets a unique correlationId. */
let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `sitedb_${++correlationCounter}`;
}

/**
 * Map a raw SQLite declared type to a field-type kind for display formatting. Best-effort —
 * SQLite is dynamically typed, so this reads the DECLARED column affinity to pick a formatter,
 * and falls back to `text` (which stringifies) for anything unrecognized.
 */
function kindForColumn(col: ColumnInfo): FieldKind {
  const t = (col.type || '').toUpperCase();

  if (t.includes('INT')) {
    return 'number';
  }

  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) {
    return 'number';
  }

  if (t.includes('BOOL')) {
    return 'boolean';
  }

  if (t.includes('DATE') || t.includes('TIME')) {
    return 'date';
  }

  if (t.includes('JSON')) {
    return 'json';
  }

  return 'text';
}

/** Format a cell for display: null → em-dash sentinel; otherwise the field-type formatter. */
function formatCell(value: unknown, kind: FieldKind): string {
  if (value === null || value === undefined) {
    return '';
  }

  try {
    const formatted = fieldTypeFor(kind).format(value);
    return formatted === '' ? String(value) : formatted;
  } catch {
    return String(value);
  }
}

/** Escape one field for RFC-4180 CSV (quote when it contains a comma, quote, or newline). */
function csvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const s = String(value);

  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

/** Build a CSV string from the current page + trigger a client-side download. */
function exportPageCsv(page: TablePage): void {
  const header = page.columns.map((c) => csvField(c.name)).join(',');
  const body = page.rows.map((row) => page.columns.map((c) => csvField(row[c.name])).join(',')).join('\n');
  const csv = `${header}\n${body}\n`;

  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${page.table}-${page.offset + 1}-${page.offset + page.rows.length}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // download unavailable (sandboxed) — fail soft; the grid still shows the data
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export const SiteTablesPanel = memo(() => {
  const [tables, setTables] = useState<TablesState>({ status: 'loading' });
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [rows, setRows] = useState<RowsState>({ status: 'idle' });
  const [offset, setOffset] = useState(0);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  // Cached total so page-nav shows a stable "of N" without a re-count round-trip.
  const [cachedTotal, setCachedTotal] = useState<number | null>(null);

  /*
   * The repo has a known empty-deps stale-ref bug: a single `onParentMessage` listener
   * registered once in a `useEffect([])` closes over the FIRST render's state. We register
   * ONE listener and read the LATEST pending map through a ref inside the handler, so replies
   * always resolve against the live pending set regardless of how many renders have happened.
   */
  const pendingRef = useRef<Map<string, Pending>>(new Map());

  /**
   * Send a bridge message + await the reply matched by correlationId. Rejects on timeout so a
   * dropped parent never hangs the UI. Resolves with the raw `ParentToChildMessage`.
   */
  const request = useCallback((message: Parameters<typeof postToParent>[0]): Promise<ParentToChildMessage> => {
    return new Promise<ParentToChildMessage>((resolve, reject) => {
      const correlationId = (message as { correlationId: string }).correlationId;
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('The request timed out. Check the admin connection and retry.'));
      }, REQUEST_TIMEOUT_MS);

      pendingRef.current.set(correlationId, { resolve, reject, timer });
      postToParent(message);
    });
  }, []);

  // Register exactly ONE parent-message listener; resolve by correlationId via the live ref.
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_SITEDB_TABLES_RESPONSE' && msg.type !== 'PS_SITEDB_ROWS_RESPONSE') {
        return;
      }

      const correlationId = msg.correlationId;

      if (!correlationId) {
        return;
      }

      const pending = pendingRef.current.get(correlationId);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      pendingRef.current.delete(correlationId);
      pending.resolve(msg);
    });

    return () => {
      unsubscribe();

      // Reject anything still in flight on unmount so no promise dangles.
      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cancelled'));
      }

      pendingRef.current.clear();
    };
  }, []);

  /** Load (or reload) the table list. */
  const loadTables = useCallback(async () => {
    setTables({ status: 'loading' });

    if (!isEmbedded) {
      setTables({ status: 'error', message: 'Open this from the ProjectSites admin to browse your data.' });
      return;
    }

    try {
      const reply = (await request({
        type: 'PS_SITEDB_TABLES_REQUEST',
        correlationId: nextCorrelationId(),
      })) as SiteDbTablesResponseMessage;

      if (!reply.ok) {
        // Dark-flag 404 → friendly disabled state, not an error card.
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setTables({ status: 'disabled' });
          return;
        }

        setTables({ status: 'error', message: reply.error || 'Could not load your tables.' });
        return;
      }

      setTables({
        status: 'ready',
        databaseId: reply.databaseId ?? '',
        provisioned: reply.provisioned ?? false,
        tables: reply.tables ?? [],
      });
    } catch (err) {
      setTables({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your tables.' });
    }
  }, [request]);

  /** Load one page of rows for the given table + offset. */
  const loadRows = useCallback(
    async (table: string, pageOffset: number) => {
      setRows({ status: 'loading' });

      try {
        const reply = (await request({
          type: 'PS_SITEDB_ROWS_REQUEST',
          correlationId: nextCorrelationId(),
          table,
          limit: PAGE_SIZE,
          offset: pageOffset,
        })) as SiteDbRowsResponseMessage;

        if (!reply.ok) {
          setRows({ status: 'error', message: reply.error || `Could not load "${table}".` });
          return;
        }

        const total = reply.total ?? reply.rows?.length ?? 0;
        setCachedTotal(total);
        setRows({
          status: 'ready',
          page: {
            table: reply.table ?? table,
            columns: reply.columns ?? [],
            rows: reply.rows ?? [],
            limit: reply.limit ?? PAGE_SIZE,
            offset: reply.offset ?? pageOffset,
            total,
          },
        });
      } catch (err) {
        setRows({ status: 'error', message: err instanceof Error ? err.message : `Could not load "${table}".` });
      }
    },
    [request],
  );

  // On mount: load the table list.
  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // On table select / page change: load rows.
  useEffect(() => {
    if (selectedTable) {
      void loadRows(selectedTable, offset);
    }
  }, [selectedTable, offset, loadRows]);

  const openTable = useCallback((name: string) => {
    setDetailRow(null);
    setOffset(0);
    setCachedTotal(null);
    setSelectedTable(name);
  }, []);

  const backToList = useCallback(() => {
    setSelectedTable(null);
    setRows({ status: 'idle' });
    setDetailRow(null);
    setOffset(0);
  }, []);

  const flashComingSoon = useCallback((label: string) => {
    setComingSoon(label);
    setTimeout(() => setComingSoon((cur) => (cur === label ? null : cur)), 3200);
  }, []);

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <Header
        onRefresh={selectedTable ? () => void loadRows(selectedTable, offset) : () => void loadTables()}
        subtitle={
          selectedTable
            ? 'Browsing one table'
            : tables.status === 'ready'
              ? `${tables.tables.length} table${tables.tables.length === 1 ? '' : 's'} · your database`
              : 'Your dedicated database'
        }
      />

      {/* Table list ↔ browse view */}
      {!selectedTable ? (
        <TableListView state={tables} onOpen={openTable} onRetry={() => void loadTables()} onComingSoon={flashComingSoon} />
      ) : (
        <BrowseView
          table={selectedTable}
          state={rows}
          offset={offset}
          cachedTotal={cachedTotal}
          onBack={backToList}
          onPrev={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          onNext={() => setOffset((o) => o + PAGE_SIZE)}
          onRowClick={setDetailRow}
          onRetry={() => void loadRows(selectedTable, offset)}
        />
      )}

      {/* Coming-soon inline note (never a dead click) */}
      {comingSoon && (
        <div
          className="border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
          data-testid="sitedb-coming-soon"
          role="status"
        >
          <div className="i-ph:sparkle text-bolt-elements-item-contentAccent" />
          <span>
            <span className="text-bolt-elements-textPrimary font-medium">{comingSoon}</span> is coming next — table
            creation and AI edits land in the following update.
          </span>
        </div>
      )}

      {/* Row detail drawer */}
      {detailRow && rows.status === 'ready' && (
        <RowDrawer row={detailRow} columns={rows.page.columns} onClose={() => setDetailRow(null)} />
      )}
    </div>
  );
});

SiteTablesPanel.displayName = 'SiteTablesPanel';

// ── Header ─────────────────────────────────────────────────────────────────

const Header = memo(({ subtitle, onRefresh }: { subtitle: string; onRefresh: () => void }) => (
  <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
    <div className="i-ph:database-duotone text-xl text-bolt-elements-textSecondary" />
    <div className="min-w-0">
      <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Tables</h2>
      <p className="text-[10px] text-bolt-elements-textTertiary truncate">{subtitle}</p>
    </div>
    <div className="ml-auto flex items-center gap-2 shrink-0">
      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary">
        read-only
      </span>
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
        className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
      >
        <div className="i-ph:arrows-clockwise text-sm" />
      </button>
    </div>
  </div>
));

Header.displayName = 'SiteTablesPanel.Header';

// ── Shared: spinner + error ────────────────────────────────────────────────

const Spinner = memo(({ label }: { label: string }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center" data-testid="sitedb-loading">
    <div className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin" />
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'SiteTablesPanel.Spinner';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="sitedb-error">
    <div className="i-ph:warning-circle text-3xl text-red-400" />
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px]">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
    >
      <div className="i-ph:arrow-clockwise" /> Retry
    </button>
  </div>
));

ErrorCard.displayName = 'SiteTablesPanel.ErrorCard';

// ── Table list view ────────────────────────────────────────────────────────

const TableListView = memo(
  ({
    state,
    onOpen,
    onRetry,
    onComingSoon,
  }: {
    state: TablesState;
    onOpen: (name: string) => void;
    onRetry: () => void;
    onComingSoon: (label: string) => void;
  }) => {
    if (state.status === 'loading') {
      return <Spinner label="Loading your tables…" />;
    }

    if (state.status === 'disabled') {
      return (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
          data-testid="sitedb-disabled"
        >
          <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
          <p className="text-sm font-medium text-bolt-elements-textSecondary">Per-site data isn't enabled yet</p>
          <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
            Your site's own database is on the way. Once it's turned on, your tables show up here — nothing to set up.
          </p>
        </div>
      );
    }

    if (state.status === 'error') {
      return <ErrorCard message={state.message} onRetry={onRetry} />;
    }

    // ready → empty launchpad OR the table list
    if (state.tables.length === 0) {
      return (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center"
          data-testid="sitedb-empty"
        >
          <div className="i-ph:table text-4xl text-bolt-elements-textTertiary" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">Your database is empty</p>
            <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px]">
              Create your first table to start storing data — or let AI build one from a plain-English description.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onComingSoon('New table')}
              data-testid="sitedb-new-table"
              className="min-h-[24px] text-[12px] font-semibold px-3.5 py-2 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:plus-bold" /> New table
            </button>
            <button
              type="button"
              onClick={() => onComingSoon('Ask AI')}
              data-testid="sitedb-ask-ai"
              className="min-h-[24px] text-[12px] font-semibold px-3.5 py-2 rounded-lg border border-bolt-elements-item-contentAccent/60 bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:sparkle" /> Ask AI
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-auto modern-scrollbar" data-testid="sitedb-table-list">
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
          Tables ({state.tables.length})
        </div>
        {state.tables.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => onOpen(t.name)}
            data-testid="sitedb-table-row"
            className="w-full min-h-[24px] flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-bolt-elements-item-backgroundActive transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:table text-sm text-bolt-elements-textTertiary shrink-0" />
            <span className="text-bolt-elements-textPrimary font-mono flex-1 truncate">{t.name}</span>
            <div className="i-ph:caret-right text-bolt-elements-textTertiary shrink-0" />
          </button>
        ))}
      </div>
    );
  },
);

TableListView.displayName = 'SiteTablesPanel.TableListView';

// ── Browse view (virtualized grid) ──────────────────────────────────────────

const BrowseView = memo(
  ({
    table,
    state,
    offset,
    cachedTotal,
    onBack,
    onPrev,
    onNext,
    onRowClick,
    onRetry,
  }: {
    table: string;
    state: RowsState;
    offset: number;
    cachedTotal: number | null;
    onBack: () => void;
    onPrev: () => void;
    onNext: () => void;
    onRowClick: (row: Record<string, unknown>) => void;
    onRetry: () => void;
  }) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const page = state.status === 'ready' ? state.page : null;

    const columns = page?.columns ?? [];
    const rows = page?.rows ?? [];
    const total = page?.total ?? cachedTotal ?? 0;

    // Pre-compute display kinds once per column set.
    const kinds = useMemo(() => columns.map(kindForColumn), [columns]);

    const rowVirtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 12,
    });

    // Reset scroll to the top whenever a new page loads.
    useEffect(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    }, [offset, table]);

    const hasPrev = offset > 0;
    const hasNext = offset + rows.length < total;

    return (
      <div className="flex-1 flex flex-col min-h-0" data-testid="sitedb-browse">
        {/* Breadcrumb + actions */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to tables"
            title="Back to tables"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:arrow-left text-sm" />
          </button>
          <div className="i-ph:table text-sm text-bolt-elements-textTertiary shrink-0" />
          <span className="text-xs font-mono text-bolt-elements-textPrimary truncate flex-1">{table}</span>
          {page && rows.length > 0 && (
            <button
              type="button"
              onClick={() => exportPageCsv(page)}
              data-testid="sitedb-export-csv"
              title="Export the current page as CSV"
              className="min-h-[24px] text-[10px] font-medium px-2 py-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:download-simple" /> Export CSV
            </button>
          )}
        </div>

        {state.status === 'loading' && <Spinner label={`Loading "${table}"…`} />}
        {state.status === 'error' && <ErrorCard message={state.message} onRetry={onRetry} />}

        {page && state.status === 'ready' && (
          <>
            {rows.length === 0 ? (
              <div
                className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"
                data-testid="sitedb-table-empty"
              >
                <div className="i-ph:tray text-3xl text-bolt-elements-textTertiary" />
                <p className="text-xs text-bolt-elements-textSecondary">
                  <span className="font-mono text-bolt-elements-textPrimary">{table}</span> has no rows yet
                </p>
              </div>
            ) : (
              <div ref={scrollRef} className="flex-1 overflow-auto modern-scrollbar min-h-0" data-testid="sitedb-grid">
                {/* Sticky column header */}
                <div
                  className="sticky top-0 z-10 flex bg-bolt-elements-background-depth-2 border-b border-bolt-elements-borderColor"
                  role="row"
                >
                  {columns.map((col) => (
                    <div
                      key={col.name}
                      role="columnheader"
                      className="shrink-0 w-[180px] px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium truncate border-r border-bolt-elements-borderColor/40 flex items-center gap-1"
                      title={`${col.name} · ${col.type || 'ANY'}`}
                    >
                      {col.pk === 1 && <div className="i-ph:key text-[10px] text-bolt-elements-item-contentAccent shrink-0" />}
                      <span className="truncate">{col.name}</span>
                    </div>
                  ))}
                </div>

                {/* Virtualized body */}
                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                  {rowVirtualizer.getVirtualItems().map((vItem) => {
                    const row = rows[vItem.index];
                    return (
                      <div
                        key={vItem.key}
                        role="row"
                        onClick={() => onRowClick(row)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }}
                        tabIndex={0}
                        data-testid="sitedb-grid-row"
                        className="absolute left-0 flex w-full items-stretch border-b border-bolt-elements-borderColor/30 hover:bg-bolt-elements-item-backgroundActive transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent"
                        style={{ top: 0, height: `${vItem.size}px`, transform: `translateY(${vItem.start}px)` }}
                      >
                        {columns.map((col, ci) => {
                          const value = row[col.name];
                          const isNull = value === null || value === undefined;
                          return (
                            <div
                              key={col.name}
                              role="cell"
                              className={classNames(
                                'shrink-0 w-[180px] px-3 py-1.5 text-xs font-mono truncate border-r border-bolt-elements-borderColor/20 flex items-center',
                                isNull ? 'text-bolt-elements-textTertiary italic' : 'text-bolt-elements-textSecondary',
                              )}
                              title={isNull ? 'null' : formatCell(value, kinds[ci])}
                            >
                              {isNull ? '—' : formatCell(value, kinds[ci])}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Pagination footer */}
            {rows.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 border-t border-bolt-elements-borderColor text-[11px] text-bolt-elements-textTertiary shrink-0">
                <span data-testid="sitedb-page-info">
                  Showing {offset + 1} to {offset + rows.length} of {total}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={onPrev}
                    disabled={!hasPrev}
                    aria-label="Previous page"
                    className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary enabled:hover:bg-bolt-elements-background-depth-3 enabled:hover:text-bolt-elements-textPrimary disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                  >
                    <div className="i-ph:caret-left text-sm" />
                  </button>
                  <button
                    type="button"
                    onClick={onNext}
                    disabled={!hasNext}
                    aria-label="Next page"
                    className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary enabled:hover:bg-bolt-elements-background-depth-3 enabled:hover:text-bolt-elements-textPrimary disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                  >
                    <div className="i-ph:caret-right text-sm" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  },
);

BrowseView.displayName = 'SiteTablesPanel.BrowseView';

// ── Row detail drawer ──────────────────────────────────────────────────────

const RowDrawer = memo(
  ({
    row,
    columns,
    onClose,
  }: {
    row: Record<string, unknown>;
    columns: ColumnInfo[];
    onClose: () => void;
  }) => {
    // Esc closes the drawer; restore is inherent (grid row keeps DOM focus target).
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };

      window.addEventListener('keydown', onKey);

      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const kinds = useMemo(() => columns.map(kindForColumn), [columns]);

    return (
      <div className="absolute inset-0 z-20 flex justify-end" role="dialog" aria-modal="true" aria-label="Row detail">
        <button
          type="button"
          aria-label="Close row detail"
          onClick={onClose}
          className="absolute inset-0 bg-black/40 cursor-default"
        />
        <div
          className="animated fadeInRight relative w-[min(420px,80%)] h-full bg-bolt-elements-background-depth-2 border-l border-bolt-elements-borderColor shadow-2xl flex flex-col"
          data-testid="sitedb-row-drawer"
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
            <div className="i-ph:rows text-bolt-elements-textSecondary" />
            <h3 className="text-sm font-semibold text-bolt-elements-textPrimary flex-1">Row detail</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:x text-sm" />
            </button>
          </div>
          <div className="flex-1 overflow-auto modern-scrollbar p-4 space-y-3">
            {columns.map((col, ci) => {
              const value = row[col.name];
              const isNull = value === null || value === undefined;
              return (
                <div key={col.name} className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    {col.pk === 1 && <div className="i-ph:key text-[10px] text-bolt-elements-item-contentAccent" />}
                    <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium">
                      {col.name}
                    </span>
                    <span className="text-[9px] text-bolt-elements-textTertiary/70 font-mono">{col.type || 'ANY'}</span>
                  </div>
                  <div
                    className={classNames(
                      'text-xs font-mono break-words whitespace-pre-wrap rounded bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor px-2.5 py-1.5',
                      isNull ? 'text-bolt-elements-textTertiary italic' : 'text-bolt-elements-textSecondary',
                    )}
                  >
                    {isNull ? '—' : formatCell(value, kinds[ci])}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
);

RowDrawer.displayName = 'SiteTablesPanel.RowDrawer';
