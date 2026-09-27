/**
 * @file Site Tables — editable grid over a site's OWN dedicated per-site Cloudflare D1.
 *
 * @remarks
 * This is the editor "Database" tab's per-site Table-view. It reads AND edits the customer's OWN
 * dedicated Cloudflare D1 (blank at first, lazily provisioned) — NEVER the shared platform DB and
 * NEVER another site's. Isolation is enforced SERVER-side: the worker resolves the site's
 * `d1_database_id` from `site_database_allocations` for the OWNED site and executes against that one
 * id. This panel never sees a DB id it could tamper with.
 *
 * The embedded editor has no cross-origin session, so it CANNOT fetch the worker directly — it talks
 * to the parent admin (which holds the bearer + `selectedSite`) over `postMessage`. Three bridge
 * message families carry it:
 *   - `PS_SITEDB_TABLES_REQUEST`  → `GET /api/sites/:siteId/db/tables`                    (list tables)
 *   - `PS_SITEDB_ROWS_REQUEST`    → `GET /api/sites/:siteId/db/tables/:table?limit&offset` (browse rows)
 *   - `PS_RES_MUTATE_REQUEST` `{kind:'d1',action:'exec'}` → `POST /api/sites/:siteId/resources/d1/mutate`
 *     — a SINGLE PARAMETERIZED statement against the site's OWN D1 (the same server-resolved path the
 *     SQL navigator uses). Reads (`pragma_table_xinfo`) run un-gated; the inline-edit `UPDATE … WHERE
 *     pk=?` classifies as mutating and is sent with `confirm:true`. The worker binds `params[]` as
 *     VALUES; the id is resolved server-side. All are DARK behind the `per_site_data` flag (404) —
 *     when off, this panel shows a friendly "not enabled" state, never a scary error.
 *
 * FIRE 2 — TYPED INLINE CELL EDIT + LOCAL UNDO on the OWNED D1 (harvests the mature grid ENGINE from
 * `data-panel-logic.ts` + `data-cell-format.ts` + `<CellEditor>`, re-pointed off the shared-D1
 * super-admin `/sql` path onto the per-site adapter path):
 *   - Click any editable cell → a typed `<CellEditor>` (text / number / boolean / date / datetime /
 *     JSON / NULL) prefilled from the cell's DECLARED column type. Save → OPTIMISTIC local update +
 *     a server-side `UPDATE "t" SET "col"=?1 WHERE <pk>=?…` (`buildUpdateByPk`, param-bound, PK
 *     predicate) → on error, ROLL BACK the optimistic change + surface the real error; on success,
 *     an **Undo** toast re-issues the reverse UPDATE (embarrassingly-easy bar).
 *   - Honest locks: a PRIMARY-KEY column, a GENERATED (computed) column, or a table with NO resolvable
 *     PK is non-editable, each with a clear reason (never a doomed edit) — matching the shared grid UX.
 *
 * Style matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*`
 * icons) — mirrors `./DatabasePanel`'s SqlNavigator + `./Preview`.
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
  type ResMutateResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  buildUpdateByPk,
  coerceCellInput,
  editorKindForColumn,
  generatedFromTableXinfo,
  pkFromTableInfo,
  RowMutationError,
  rowPkKey,
  type BoundValue,
  type CellInputKind,
} from './data-panel-logic';
import { classifyCell } from './data-cell-format';
import { CellEditor } from './CellEditor';

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

/** The last committed edit, for one-click local Undo (re-issues the reverse UPDATE). */
interface UndoEntry {
  table: string;
  column: string;

  /** The row's PK identity (so we re-target the same row even after a refresh). */
  pkKey: string;

  /** The value BEFORE the edit — Undo restores this. */
  previous: unknown;

  /** The value AFTER the edit — for the toast label. */
  next: unknown;
}

/** The result of one per-site `d1.exec` round-trip (rows for a read, rowsWritten for a write). */
interface ExecResult {
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowsWritten?: number;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;
const ROW_HEIGHT = 34; // px — matched to the grid row padding below
const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'Per-site data is not enabled';
const UNDO_WINDOW_MS = 8000;

/** Monotonic per-module counter so every request gets a unique correlationId. */
let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `sitedb_${++correlationCounter}`;
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

/**
 * Derive a small, CONSTRAINED enum option set for a column from the CURRENTLY-LOADED page rows — a
 * zero-round-trip, honest "enum-ish" affordance: when a column's non-null string/number values on the page
 * form a SMALL distinct set (≤ {@link ENUM_MAX_DISTINCT}, ≥2), the cell editor offers a real `<select>`
 * dropdown of those values (with an "Other…" escape) instead of an open text box. This never claims the set
 * is exhaustive — it's derived from the visible page, and "Other…" always allows a value outside it. Returns
 * `[]` (→ plain free text) for high-cardinality columns, all-null columns, or non-text/number values.
 */
const ENUM_MAX_DISTINCT = 8;

function enumOptionsForColumn(rows: readonly Record<string, unknown>[], column: string): string[] {
  const distinct = new Set<string>();

  for (const row of rows) {
    const v = row[column];

    if (v === null || v === undefined) {
      continue;
    }

    // Only simple scalar columns are enum candidates (skip objects/arrays/JSON blobs).
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return [];
    }

    const s = String(v);

    if (s.length > 40) {
      return [];
    } // long values aren't an enum

    distinct.add(s);

    if (distinct.size > ENUM_MAX_DISTINCT) {
      return [];
    } // too many distinct → free text
  }

  return distinct.size >= 2 ? [...distinct].sort((a, b) => a.localeCompare(b)) : [];
}

/** A short, human label for a value in the Undo toast (truncated so long text never overflows). */
function undoValueLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  const s = classifyCell(value).display;

  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface SiteTablesPanelProps {
  /**
   * Optional: switch the Database tab to the Schema builder (the empty-state "New table" launchpad + a
   * "New table" action call this so the owner's click lands in the guided builder, per the
   * embarrassingly-easy bar). When absent, the button falls back to an inline "coming next" note.
   */
  onCreateTable?: () => void;
}

export const SiteTablesPanel = memo(({ onCreateTable }: SiteTablesPanelProps = {}) => {
  const [tables, setTables] = useState<TablesState>({ status: 'loading' });
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [rows, setRows] = useState<RowsState>({ status: 'idle' });
  const [offset, setOffset] = useState(0);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  // Cached total so page-nav shows a stable "of N" without a re-count round-trip.
  const [cachedTotal, setCachedTotal] = useState<number | null>(null);

  // ── Inline-edit engine state (per-site UPDATE by PK) ──────────────────────
  /** The PK column(s) resolved for the open table (empty → read-only, no safe UPDATE target). */
  const [pkCols, setPkCols] = useState<string[]>([]);

  /** GENERATED (computed) columns for the open table — SQLite rejects writing them (read-only). */
  const [generatedCols, setGeneratedCols] = useState<Set<string>>(new Set());

  /** The cell currently being edited (row PK identity + column), or null. */
  const [editing, setEditing] = useState<{ pkKey: string; column: string } | null>(null);
  const [editKind, setEditKind] = useState<CellInputKind>('text');
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  /** The last committed edit, for one-click local Undo; auto-clears after the window. */
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (
        msg.type !== 'PS_SITEDB_TABLES_RESPONSE' &&
        msg.type !== 'PS_SITEDB_ROWS_RESPONSE' &&
        msg.type !== 'PS_RES_MUTATE_RESPONSE'
      ) {
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

      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  /**
   * Run ONE parameterized SQL statement against the site's OWN D1 via the resource-mutate bridge
   * (`kind:'d1', action:'exec'`). `confirm` is `true` for a mutating statement (the worker
   * classifies + requires it) and `false`/omitted for a read (e.g. `pragma_table_xinfo`). Resolves
   * to a normalized `{ ok, rows?, rowsWritten?, error? }`; never throws (transport errors → `ok:false`).
   */
  const execSql = useCallback(
    async (sql: string, params: readonly unknown[], confirm: boolean): Promise<ExecResult> => {
      let reply: ResMutateResponseMessage;

      try {
        reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql, params },
          confirm,
        })) as ResMutateResponseMessage;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'The database could not be reached.' };
      }

      if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
        return { ok: false, error: DISABLED_404 };
      }

      if (reply.error) {
        return { ok: false, error: reply.error };
      }

      const result = reply.result;

      if (!result) {
        return { ok: false, error: 'No response from the database. Retry in a moment.' };
      }

      if (!result.ok) {
        return { ok: false, error: result.error?.message ?? 'The statement could not run.' };
      }

      const data = (result.data ?? {}) as { rows?: Record<string, unknown>[]; rowsWritten?: number };

      return { ok: true, rows: data.rows ?? [], rowsWritten: data.rowsWritten ?? 0 };
    },
    [request],
  );

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

  /**
   * Resolve which columns are GENERATED (computed) for a table via `pragma_table_xinfo` over the
   * per-site exec path (read-only — runs without confirm). Generated columns can't be written, so the
   * grid presents them read-only. Best-effort: a failure just leaves the set empty (edit still gates
   * on PK, so a rejected write surfaces honestly rather than silently).
   */
  const loadGeneratedCols = useCallback(
    async (table: string) => {
      try {
        /*
         * pragma_table_xinfo carries `hidden` (2 = VIRTUAL, 3 = STORED generated). The table name binds
         * as a VALUE to the pragma table-function (D1 supports parameterizing the pragma argument).
         */
        const res = await execSql('SELECT name, hidden FROM pragma_table_xinfo(?1)', [table], false);

        if (res.ok && res.rows) {
          setGeneratedCols(generatedFromTableXinfo(res.rows));
        } else {
          setGeneratedCols(new Set());
        }
      } catch {
        setGeneratedCols(new Set());
      }
    },
    [execSql],
  );

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
        const columns = reply.columns ?? [];
        setCachedTotal(total);

        // Resolve PK from the column pk flags (server sends `pk` per PRAGMA table_info).
        setPkCols(pkFromTableInfo(columns as unknown as Record<string, unknown>[]));
        setRows({
          status: 'ready',
          page: {
            table: reply.table ?? table,
            columns,
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

  const openTable = useCallback(
    (name: string) => {
      setDetailRow(null);
      setOffset(0);
      setCachedTotal(null);
      setGeneratedCols(new Set());
      setEditing(null);
      setSelectedTable(name);
      void loadGeneratedCols(name);
    },
    [loadGeneratedCols],
  );

  const backToList = useCallback(() => {
    setSelectedTable(null);
    setRows({ status: 'idle' });
    setDetailRow(null);
    setOffset(0);
    setEditing(null);
    setPkCols([]);
    setGeneratedCols(new Set());
  }, []);

  const flashComingSoon = useCallback((label: string) => {
    setComingSoon(label);
    setTimeout(() => setComingSoon((cur) => (cur === label ? null : cur)), 3200);
  }, []);

  // ── Edit helpers ──────────────────────────────────────────────────────────

  /** A column is editable only when there's a resolvable PK, it isn't part of the PK, and isn't generated. */
  const editableColumn = useCallback(
    (col: string): { editable: boolean; reason?: string } => {
      if (pkCols.length === 0) {
        return {
          editable: false,
          reason: 'This table has no primary key, so a cell can’t be safely targeted for edit.',
        };
      }

      if (pkCols.includes(col)) {
        return { editable: false, reason: 'Primary-key column — the key can’t be edited here.' };
      }

      if (generatedCols.has(col)) {
        return { editable: false, reason: 'Generated column — its value is computed by the database.' };
      }

      return { editable: true };
    },
    [pkCols, generatedCols],
  );

  /** Open the typed editor for one cell — seed kind + value from the column's DECLARED type. */
  const startEdit = useCallback(
    (row: Record<string, unknown>, col: ColumnInfo) => {
      const gate = editableColumn(col.name);

      if (!gate.editable) {
        return;
      }

      const pkKey = rowPkKey(row, pkCols);

      if (pkKey === null) {
        return;
      }

      setEditError('');

      const { kind, value } = editorKindForColumn(col.type, row[col.name]);
      setEditKind(kind);
      setEditValue(value);
      setEditing({ pkKey, column: col.name });
    },
    [editableColumn, pkCols],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setEditError('');
  }, []);

  const clearUndo = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }

    setUndo(null);
  }, []);

  const armUndo = useCallback((entry: UndoEntry) => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }

    setUndo(entry);
    undoTimerRef.current = setTimeout(() => setUndo(null), UNDO_WINDOW_MS);
  }, []);

  /**
   * Commit the open cell edit: OPTIMISTICALLY update the local grid, send a param-bound
   * `UPDATE … WHERE pk=?` to the site's OWN D1, and on failure ROLL BACK + surface the error. On
   * success, arm a one-click local Undo (the reverse UPDATE).
   */
  const submitEdit = useCallback(
    async (row: Record<string, unknown>, col: ColumnInfo) => {
      if (rows.status !== 'ready') {
        return;
      }

      const table = rows.page.table;

      let value: BoundValue;

      try {
        value = coerceCellInput(editKind, editValue);
      } catch (e) {
        setEditError(e instanceof RowMutationError ? e.message : 'Could not read the value.');
        return;
      }

      let stmt: { sql: string; params: BoundValue[] };

      try {
        stmt = buildUpdateByPk(table, pkCols, row, col.name, value);
      } catch (e) {
        setEditError(e instanceof RowMutationError ? e.message : 'Could not build the statement.');
        return;
      }

      const previous = row[col.name];
      const pkKey = rowPkKey(row, pkCols);

      // Optimistic: patch the row in place immediately (by PK identity) so the UI responds instantly.
      setRows((cur) => {
        if (cur.status !== 'ready') {
          return cur;
        }

        return {
          status: 'ready',
          page: {
            ...cur.page,
            rows: cur.page.rows.map((r) => (rowPkKey(r, pkCols) === pkKey ? { ...r, [col.name]: value } : r)),
          },
        };
      });
      setDetailRow((cur) => (cur && rowPkKey(cur, pkCols) === pkKey ? { ...cur, [col.name]: value } : cur));
      setEditBusy(true);
      setEditError('');

      const res = await execSql(stmt.sql, stmt.params, true);

      setEditBusy(false);

      if (!res.ok) {
        // Roll back the optimistic change + keep the editor open with the real error.
        setRows((cur) => {
          if (cur.status !== 'ready') {
            return cur;
          }

          return {
            status: 'ready',
            page: {
              ...cur.page,
              rows: cur.page.rows.map((r) => (rowPkKey(r, pkCols) === pkKey ? { ...r, [col.name]: previous } : r)),
            },
          };
        });
        setDetailRow((cur) => (cur && rowPkKey(cur, pkCols) === pkKey ? { ...cur, [col.name]: previous } : cur));
        setEditError(res.error || 'The edit could not be saved.');

        return;
      }

      // Committed — close the editor + arm Undo.
      setEditing(null);

      if (pkKey !== null) {
        armUndo({ table, column: col.name, pkKey, previous, next: value });
      }
    },
    [rows, editKind, editValue, pkCols, execSql, armUndo],
  );

  /** Undo the last committed edit: re-issue the reverse UPDATE (previous value) + patch the grid. */
  const doUndo = useCallback(async () => {
    if (!undo) {
      return;
    }

    // Find the current row (by PK identity) to build a correct WHERE predicate.
    const currentRow =
      rows.status === 'ready' ? rows.page.rows.find((r) => rowPkKey(r, pkCols) === undo.pkKey) : undefined;

    if (!currentRow || undo.table !== (rows.status === 'ready' ? rows.page.table : '')) {
      // The row scrolled out / table changed — the reverse target is gone; just dismiss.
      clearUndo();
      return;
    }

    let stmt: { sql: string; params: BoundValue[] };

    try {
      stmt = buildUpdateByPk(undo.table, pkCols, currentRow, undo.column, undo.previous as BoundValue);
    } catch {
      clearUndo();
      return;
    }

    setUndoBusy(true);

    const res = await execSql(stmt.sql, stmt.params, true);
    setUndoBusy(false);

    if (res.ok) {
      const restored = undo.previous;
      const targetKey = undo.pkKey;
      const targetCol = undo.column;
      setRows((cur) => {
        if (cur.status !== 'ready') {
          return cur;
        }

        return {
          status: 'ready',
          page: {
            ...cur.page,
            rows: cur.page.rows.map((r) => (rowPkKey(r, pkCols) === targetKey ? { ...r, [targetCol]: restored } : r)),
          },
        };
      });
      setDetailRow((cur) => (cur && rowPkKey(cur, pkCols) === targetKey ? { ...cur, [targetCol]: restored } : cur));
    }

    /*
     * Whether or not the reverse write succeeded, drop the toast (a failed undo shows nothing new;
     * the grid still holds the applied edit, and the user can edit again).
     */
    clearUndo();
  }, [undo, rows, pkCols, execSql, clearUndo]);

  /**
   * Per-column enum options derived from the loaded page — an editable, non-PK, non-generated column whose
   * page values form a small distinct set gets a `<select>` in its cell editor (see {@link enumOptionsForColumn}).
   * Recomputed only when the page changes, so scrolling/editing is cheap.
   */
  const columnOptions = useMemo<Record<string, string[]>>(() => {
    if (rows.status !== 'ready') {
      return {};
    }

    const out: Record<string, string[]> = {};

    for (const col of rows.page.columns) {
      if (!editableColumn(col.name).editable) {
        continue;
      }

      const opts = enumOptionsForColumn(rows.page.rows, col.name);

      if (opts.length > 0) {
        out[col.name] = opts;
      }
    }

    return out;
  }, [rows, editableColumn]);

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <Header
        onRefresh={selectedTable ? () => void loadRows(selectedTable, offset) : () => void loadTables()}
        editable={selectedTable !== null && pkCols.length > 0}
        subtitle={
          selectedTable
            ? pkCols.length > 0
              ? 'Click a cell to edit · your database'
              : 'Browsing one table (no primary key — read-only)'
            : tables.status === 'ready'
              ? `${tables.tables.length} table${tables.tables.length === 1 ? '' : 's'} · your database`
              : 'Your dedicated database'
        }
      />

      {/* Table list ↔ browse view */}
      {!selectedTable ? (
        <TableListView
          state={tables}
          onOpen={openTable}
          onRetry={() => void loadTables()}
          onComingSoon={flashComingSoon}
          onCreateTable={onCreateTable}
        />
      ) : (
        <BrowseView
          table={selectedTable}
          state={rows}
          offset={offset}
          cachedTotal={cachedTotal}
          editableColumn={editableColumn}
          editing={editing}
          editKind={editKind}
          editValue={editValue}
          editError={editError}
          editBusy={editBusy}
          pkCols={pkCols}
          columnOptions={columnOptions}
          onBack={backToList}
          onPrev={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          onNext={() => setOffset((o) => o + PAGE_SIZE)}
          onRowClick={setDetailRow}
          onStartEdit={startEdit}
          onEditKindChange={setEditKind}
          onEditValueChange={setEditValue}
          onEditSave={submitEdit}
          onEditCancel={cancelEdit}
          onRetry={() => void loadRows(selectedTable, offset)}
        />
      )}

      {/* One-click Undo toast (embarrassingly-easy: every mutation is reversible) */}
      {undo && (
        <div
          className="border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
          data-testid="sitedb-undo"
          role="status"
        >
          <div className="i-ph:check-circle text-emerald-400" />
          <span className="min-w-0 truncate">
            Saved <span className="font-mono text-bolt-elements-textPrimary">{undo.column}</span> ={' '}
            <span className="font-mono text-bolt-elements-textPrimary">{undoValueLabel(undo.next)}</span>
          </span>
          <button
            type="button"
            onClick={() => void doUndo()}
            disabled={undoBusy}
            data-testid="sitedb-undo-button"
            className="ml-auto min-h-[24px] text-[11px] font-semibold px-2.5 py-1 rounded border border-bolt-elements-item-contentAccent/60 bg-bolt-elements-background-depth-3 text-bolt-elements-item-contentAccent enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className={undoBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-counter-clockwise'} />
            <span className="min-w-[4ch] text-center">{undoBusy ? 'Undoing…' : 'Undo'}</span>
          </button>
          <button
            type="button"
            onClick={clearUndo}
            aria-label="Dismiss"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:x text-xs" />
          </button>
        </div>
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
        <RowDrawer
          row={detailRow}
          columns={rows.page.columns}
          editableColumn={editableColumn}
          editing={editing}
          editKind={editKind}
          editValue={editValue}
          editError={editError}
          editBusy={editBusy}
          pkCols={pkCols}
          columnOptions={columnOptions}
          onStartEdit={startEdit}
          onEditKindChange={setEditKind}
          onEditValueChange={setEditValue}
          onEditSave={submitEdit}
          onEditCancel={cancelEdit}
          onClose={() => {
            setDetailRow(null);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
});

SiteTablesPanel.displayName = 'SiteTablesPanel';

// ── Header ─────────────────────────────────────────────────────────────────

const Header = memo(
  ({ subtitle, onRefresh, editable }: { subtitle: string; onRefresh: () => void; editable: boolean }) => (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
      <div className="i-ph:database-duotone text-xl text-bolt-elements-textSecondary" />
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Tables</h2>
        <p className="text-[10px] text-bolt-elements-textTertiary truncate">{subtitle}</p>
      </div>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {editable && (
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent">
            editable
          </span>
        )}
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
  ),
);

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
    onCreateTable,
  }: {
    state: TablesState;
    onOpen: (name: string) => void;
    onRetry: () => void;
    onComingSoon: (label: string) => void;
    onCreateTable?: () => void;
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
              onClick={() => (onCreateTable ? onCreateTable() : onComingSoon('New table'))}
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
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
            Tables ({state.tables.length})
          </span>
          {onCreateTable && (
            <button
              type="button"
              onClick={onCreateTable}
              data-testid="sitedb-new-table-inline"
              title="Build a new table"
              className="ml-auto min-h-[24px] text-[11px] font-medium px-2 py-0.5 rounded border border-bolt-elements-item-contentAccent/50 bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:plus" /> New table
            </button>
          )}
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

/** Shared props for the inline-edit engine, threaded into BrowseView + RowDrawer. */
interface EditProps {
  editableColumn: (col: string) => { editable: boolean; reason?: string };
  editing: { pkKey: string; column: string } | null;
  editKind: CellInputKind;
  editValue: string;
  editError: string;
  editBusy: boolean;
  pkCols: string[];

  /**
   * Per-column CONSTRAINED enum options derived from the loaded page (see {@link enumOptionsForColumn}). When a
   * column maps to a small distinct set, the cell editor renders a `<select>` (+ "Other…") instead of free text.
   */
  columnOptions: Record<string, string[]>;
  onStartEdit: (row: Record<string, unknown>, col: ColumnInfo) => void;
  onEditKindChange: (kind: CellInputKind) => void;
  onEditValueChange: (value: string) => void;
  onEditSave: (row: Record<string, unknown>, col: ColumnInfo) => void;
  onEditCancel: () => void;
}

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
    editableColumn,
    editing,
    editKind,
    editValue,
    editError,
    editBusy,
    pkCols,
    columnOptions,
    onStartEdit,
    onEditKindChange,
    onEditValueChange,
    onEditSave,
    onEditCancel,
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
  } & EditProps) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const page = state.status === 'ready' ? state.page : null;

    const columns = page?.columns ?? [];
    const rows = page?.rows ?? [];
    const total = page?.total ?? cachedTotal ?? 0;

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
                  {columns.map((col) => {
                    const gate = editableColumn(col.name);
                    return (
                      <div
                        key={col.name}
                        role="columnheader"
                        className="shrink-0 w-[180px] px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium truncate border-r border-bolt-elements-borderColor/40 flex items-center gap-1"
                        title={
                          gate.editable ? `${col.name} · ${col.type || 'ANY'}` : `${col.name} · ${gate.reason ?? ''}`
                        }
                      >
                        {col.pk === 1 && (
                          <div className="i-ph:key text-[10px] text-bolt-elements-item-contentAccent shrink-0" />
                        )}
                        <span className="truncate">{col.name}</span>
                        {!col.pk && !gate.editable && (
                          <div
                            className="i-ph:lock-simple text-[9px] text-bolt-elements-textTertiary/70 shrink-0"
                            title={gate.reason}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Virtualized body */}
                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                  {rowVirtualizer.getVirtualItems().map((vItem) => {
                    const row = rows[vItem.index];
                    return (
                      <GridRow
                        key={vItem.key}
                        row={row}
                        columns={columns}
                        top={vItem.start}
                        height={vItem.size}
                        onRowClick={onRowClick}
                        editableColumn={editableColumn}
                        editing={editing}
                        editKind={editKind}
                        editValue={editValue}
                        editError={editError}
                        editBusy={editBusy}
                        pkCols={pkCols}
                        columnOptions={columnOptions}
                        onStartEdit={onStartEdit}
                        onEditKindChange={onEditKindChange}
                        onEditValueChange={onEditValueChange}
                        onEditSave={onEditSave}
                        onEditCancel={onEditCancel}
                      />
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

// ── One grid row (its own component so an open editor doesn't re-render the whole page) ─────────────

const GridRow = memo(
  ({
    row,
    columns,
    top,
    height,
    onRowClick,
    editableColumn,
    editing,
    editKind,
    editValue,
    editError,
    editBusy,
    pkCols,
    columnOptions,
    onStartEdit,
    onEditKindChange,
    onEditValueChange,
    onEditSave,
    onEditCancel,
  }: {
    row: Record<string, unknown>;
    columns: ColumnInfo[];
    top: number;
    height: number;
    onRowClick: (row: Record<string, unknown>) => void;
  } & EditProps) => {
    const thisKey = rowPkKey(row, pkCols);

    return (
      <div
        role="row"
        data-testid="sitedb-grid-row"
        className="absolute left-0 flex w-full items-stretch border-b border-bolt-elements-borderColor/30 hover:bg-bolt-elements-item-backgroundActive transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent"
        style={{ top: 0, height: `${height}px`, transform: `translateY(${top}px)` }}
      >
        {columns.map((col) => {
          const value = row[col.name];
          const classified = classifyCell(value);
          const gate = editableColumn(col.name);
          const isEditingThis =
            editing !== null && thisKey !== null && editing.pkKey === thisKey && editing.column === col.name;

          if (isEditingThis) {
            return (
              <div
                key={col.name}
                role="cell"
                className="shrink-0 w-[280px] px-2 py-1 border-r border-bolt-elements-borderColor/20 bg-bolt-elements-background-depth-2 z-20"
                data-testid="sitedb-cell-editing"
              >
                <CellEditor
                  label={col.name}
                  editKind={editKind}
                  onKindChange={onEditKindChange}
                  editValue={editValue}
                  onValueChange={onEditValueChange}
                  options={columnOptions[col.name]}
                  previewSql={null}
                  editError={editError}
                  editBusy={editBusy}
                  onSave={() => onEditSave(row, col)}
                  onCancel={onEditCancel}
                />
              </div>
            );
          }

          return (
            <div
              key={col.name}
              role="cell"
              tabIndex={0}
              onClick={() => (gate.editable ? onStartEdit(row, col) : onRowClick(row))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();

                  if (gate.editable) {
                    onStartEdit(row, col);
                  } else {
                    onRowClick(row);
                  }
                }
              }}
              title={
                gate.editable
                  ? 'Click to edit'
                  : classified.kind === 'null'
                    ? (gate.reason ?? 'null')
                    : `${classified.title ?? classified.display} · ${gate.reason ?? ''}`
              }
              data-testid="sitedb-grid-cell"
              className={classNames(
                'group relative shrink-0 w-[180px] px-3 py-1.5 text-xs font-mono truncate border-r border-bolt-elements-borderColor/20 flex items-center gap-1',
                classified.className,
                gate.editable ? 'cursor-text hover:bg-bolt-elements-item-backgroundActive' : 'cursor-pointer',
              )}
            >
              <span className="truncate">{classified.kind === 'null' ? '—' : classified.display}</span>
              {gate.editable && (
                <div className="i-ph:pencil-simple text-[10px] text-bolt-elements-textTertiary opacity-0 group-hover:opacity-70 ml-auto shrink-0" />
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

GridRow.displayName = 'SiteTablesPanel.GridRow';

// ── Row detail drawer ──────────────────────────────────────────────────────

const RowDrawer = memo(
  ({
    row,
    columns,
    onClose,
    editableColumn,
    editing,
    editKind,
    editValue,
    editError,
    editBusy,
    pkCols,
    columnOptions,
    onStartEdit,
    onEditKindChange,
    onEditValueChange,
    onEditSave,
    onEditCancel,
  }: {
    row: Record<string, unknown>;
    columns: ColumnInfo[];
    onClose: () => void;
  } & EditProps) => {
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

    const thisKey = rowPkKey(row, pkCols);

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
            {columns.map((col) => {
              const value = row[col.name];
              const classified = classifyCell(value);
              const gate = editableColumn(col.name);
              const isEditingThis =
                editing !== null && thisKey !== null && editing.pkKey === thisKey && editing.column === col.name;

              return (
                <div key={col.name} className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    {col.pk === 1 && <div className="i-ph:key text-[10px] text-bolt-elements-item-contentAccent" />}
                    <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium">
                      {col.name}
                    </span>
                    <span className="text-[9px] text-bolt-elements-textTertiary/70 font-mono">{col.type || 'ANY'}</span>
                    {gate.editable && !isEditingThis && (
                      <button
                        type="button"
                        onClick={() => onStartEdit(row, col)}
                        aria-label={`Edit ${col.name}`}
                        title="Edit this value"
                        data-testid="sitedb-drawer-edit"
                        className="ml-auto min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                      >
                        <div className="i-ph:pencil-simple text-[11px]" />
                      </button>
                    )}
                  </div>
                  {isEditingThis ? (
                    <div data-testid="sitedb-drawer-editing">
                      <CellEditor
                        label={col.name}
                        editKind={editKind}
                        onKindChange={onEditKindChange}
                        editValue={editValue}
                        onValueChange={onEditValueChange}
                        options={columnOptions[col.name]}
                        previewSql={null}
                        editError={editError}
                        editBusy={editBusy}
                        onSave={() => onEditSave(row, col)}
                        onCancel={onEditCancel}
                      />
                    </div>
                  ) : (
                    <div
                      className={classNames(
                        'text-xs font-mono break-words whitespace-pre-wrap rounded bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor px-2.5 py-1.5',
                        classified.className,
                      )}
                      title={classified.title}
                    >
                      {classified.kind === 'null' ? '—' : classified.display}
                    </div>
                  )}
                  {!gate.editable && !col.pk && (
                    <p className="text-[9px] text-bolt-elements-textTertiary/70">{gate.reason}</p>
                  )}
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
