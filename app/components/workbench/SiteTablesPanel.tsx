/**
 * @file Site Tables — a compact, gorgeous Notion/Airtable/NocoDB-grade editable grid over a site's
 * OWN dedicated per-site Cloudflare D1.
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
 *     SQL navigator uses). Reads (`pragma_table_xinfo`) run un-gated; a write (`UPDATE`/`INSERT`/
 *     `DELETE`/DDL) classifies as mutating and is sent with `confirm:true`. The worker binds `params[]`
 *     as VALUES; the id is resolved server-side. All are DARK behind the `per_site_data` flag (404) —
 *     when off, this panel shows a friendly "not enabled" state, never a scary error.
 *
 * THE GRID ENGINE. Rather than reimplement sort/filter/search/pagination, this panel WIRES the mature,
 * unit-tested engine from `./data-panel-logic` (`cycleSortMulti` · `sortRows` · `FilterCondition` +
 * `FILTER_OPS` + `filtersToParams`-shape client filter · `filterRows` · `PAGE_SIZE_OPTIONS` +
 * `clampPageSize` · `toCsv`/`toTsv`/`toJsonRows` whole-table export · `visibleColumns`/`orderColumns`/
 * `moveColumn` · `normalizeDensity`/`densityCellClass` · `normalizeViewMode` + gallery helpers) and the
 * typed field system from `./field-types` (boolean checkbox, rating stars, select chips). Filtering /
 * sorting / paging happen CLIENT-side over the loaded page (the browse endpoint returns up to the whole
 * table for small per-site DBs); everything remains honest — hidden columns still export, the row count
 * reflects the filtered set with the true total one hover away.
 *
 * Row CRUD and AI-native standouts route through the per-site exec bridge; table + column DDL uses the
 * dedicated REST endpoints:
 *   - add-row → parameterized `INSERT`; delete-row / bulk-delete → `DELETE … WHERE pk=?` per row (exec bridge).
 *   - add / rename / drop column → the dedicated `POST|PATCH|DELETE /db/tables/:table/columns[/:column]`
 *     bridge ({@link requestDbAddColumn}/{@link requestDbRenameColumn}/{@link requestDbDropColumn}) — NOT the
 *     exec-SQL path; mirrors the create/drop-TABLE flow via {@link SiteTablesPanelProps.onCreateTable}.
 *   - AI generate-column / natural-language filter / fill-cells → `/api/llmcall` (ProjectSites AI when
 *     `PS_BOLT_AI`), grounded on the real schema, applied through the bridge — AI is enhancement, never
 *     blocking, and every generated write is param-bound + undoable.
 *
 * Style matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*`
 * icons, black `#060610` + cyan `#00E5FF`) — mirrors `./DatabasePanel`'s SqlNavigator + `./Preview`.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { classNames } from '~/utils/classNames';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';
import {
  isEmbedded,
  postToParent,
  postToastToParent,
  onParentMessage,
  requestDbLoadSample,
  requestDbAiSeed,
  requestDbSearch,
  requestDbCreateTable,
  requestDbDropTable,
  requestDbAddColumn,
  requestDbRenameColumn,
  requestDbDropColumn,
  requestDbUpdateRow,
  type ParentToChildMessage,
  type SiteDbTablesResponseMessage,
  type SiteDbRowsResponseMessage,
  type SiteDbColumnSpec,
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
  // ── Revision 1 — rowid inline edit (kills "no-PK = read-only") ──
  ROWID_KEY,
  rowStableKey,
  rowRowid,
  isRowEditableColumn,
  // ── Revision 3 — bulk edit + fill-down (Airtable-style multi-cell) ──
  extendCellSelection,
  fillDownWrites,
  type CellWriteIntent,
  // ── grid engine ──
  cycleSortMulti,
  sortRows,
  filterRows,
  computeTableInsights,
  type TableInsights,
  toCsv,
  toTsv,
  toJsonRows,
  PAGE_SIZE_OPTIONS,
  clampPageSize,
  visibleColumns,
  orderColumns,
  moveColumn,
  normalizeDensity,
  densityCellClass,
  normalizeViewMode,
  galleryTitleField,
  galleryBodyFields,
  groupPageRows,
  kanbanGroupKey,
  defaultKanbanGroupField,
  KANBAN_MAX_GROUPS,
  calendarDateField,
  bucketRowsByDate,
  monthMatrix,
  monthFromDayKey,
  addCalendarMonth,
  type CalendarCell,
  FILTER_OP_OPTIONS,
  filterOpIsValueFree,
  normalizeFilterOp,
  filterIsActive,
  blankCondition,
  addCondition,
  removeCondition,
  updateCondition,
  MAX_FILTER_CONDITIONS,
  type GridSort,
  type GridDensity,
  type ViewMode,
  type FilterCondition,
  type FilterOp,
  type BoundValue,
  type CellInputKind,
} from './data-panel-logic';
import { FIELD_TYPES, fieldTypeFor, type FieldKind } from './field-types';
import { classifyCell } from './data-cell-format';
import { quoteIdent } from './schema-ddl';
import { formatSchemaForPrompt, extractSqlFromModel } from './sql-ask-logic';
import { CellEditor } from './CellEditor';
import { ErdView } from './ErdView';
import type { ErdSchemaTable } from './data-panel-logic';

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

/** The last committed mutation, for one-click local Undo (re-issues the reverse statement). */
type UndoEntry =
  | {
      kind: 'cell';
      table: string;
      column: string;
      /** The row's PK identity (so we re-target the same row even after a refresh). */
      pkKey: string;
      previous: unknown;
      next: unknown;
    }
  | {
      /** A row was inserted — undo DELETEs it by the returned/predicted PK. */
      kind: 'insert';
      table: string;
      pkCols: string[];
      pkValues: Record<string, BoundValue>;
      label: string;
    }
  | {
      /** One or more rows were deleted — undo re-INSERTs them verbatim. */
      kind: 'delete';
      table: string;
      rows: Record<string, unknown>[];
      label: string;
    }
  | {
      /**
       * A fill-down / bulk edit wrote ONE column across many rows — undo restores each row's PREVIOUS
       * value in a single click (one Undo for the whole batch). Each entry pins the row's stable key so
       * the reverse write re-targets the same row even after a refresh.
       */
      kind: 'cellBatch';
      table: string;
      column: string;
      cells: { pkKey: string; previous: unknown }[];
      label: string;
    };

/** The result of one per-site `d1.exec` round-trip (rows for a read, rowsWritten for a write). */
interface ExecResult {
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowsWritten?: number;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Browse window: pull a generous page so client-side filter/sort/paginate sees the (small) table. */
const FETCH_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'Per-site data is not enabled';
const UNDO_WINDOW_MS = 8000;
const DEFAULT_PAGE_SIZE = 50;

/** Per-density row heights (px) for the virtualizer — tuned to `densityCellClass`. */
const ROW_HEIGHT_FOR: Record<GridDensity, number> = { compact: 28, cozy: 34, comfortable: 46 };

/** Default rendered column width (px). */
const COL_WIDTH = 180;

/** SQLite storage class → the Airtable field kind we render/edit it as (a best-effort default). */
const FIELD_KIND_OPTIONS: ReadonlyArray<{ value: FieldKind; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'singleSelect', label: 'Single select' },
  { value: 'multiSelect', label: 'Multi select' },
  { value: 'rating', label: 'Rating' },
  { value: 'json', label: 'JSON' },
];

/** Monotonic per-module counter so every request gets a unique correlationId. */
let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `sitedb_${++correlationCounter}`;
}

/**
 * Infer the rich Airtable field kind for a column from its DECLARED SQLite type + a sample value — a
 * zero-round-trip heuristic that drives the typed cell RENDERER (checkbox / stars / chips) and the
 * "type" the inline editor seeds. Honest + conservative: only maps to a rich kind when the signal is
 * unambiguous (BOOLEAN/BOOL → boolean, RATING/STARS → rating, a JSON-array string → multiSelect,
 * REAL/INT/NUM → number, DATE → date), else plain text. Pure.
 */
function fieldKindForColumn(col: ColumnInfo, sample: unknown): FieldKind {
  const t = (col.type || '').toUpperCase();

  if (/BOOL/.test(t)) {
    return 'boolean';
  }

  if (/RATING|STARS/.test(t)) {
    return 'rating';
  }

  if (/DATE|TIME/.test(t)) {
    return 'date';
  }

  if (/INT|REAL|FLOA|DOUB|NUM|DEC/.test(t)) {
    return 'number';
  }

  // A stored JSON array (multi-select storage) renders as chips.
  if (typeof sample === 'string') {
    const s = sample.trim();

    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        if (Array.isArray(JSON.parse(s))) {
          return 'multiSelect';
        }
      } catch {
        /* not JSON — fall through */
      }
    }
  }

  return 'text';
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

/**
 * Client-side substring + column-condition filter over the loaded rows, then a multi-column stable
 * sort. Mirrors the worker's filter/sort semantics via the shared engine helpers so what the grid
 * shows always matches what a server-side query would return. Pure.
 */
function applyGridQuery(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  search: string,
  conditions: readonly FilterCondition[],
  combinator: 'AND' | 'OR',
  sorts: readonly GridSort[],
): Record<string, unknown>[] {
  // 1. whole-row substring search (engine helper).
  let out = filterRows(rows, columns, search);

  // 2. column conditions (each active condition applies one comparison).
  const active = conditions.filter((c) => filterIsActive(c.col, c.op, c.val));

  if (active.length > 0) {
    out = out.filter((row) => {
      const results = active.map((c) => matchCondition(row[c.col as string], normalizeFilterOp(c.op), c.val));
      return combinator === 'OR' ? results.some(Boolean) : results.every(Boolean);
    });
  }

  // 3. multi-column sort — apply from LAST priority to FIRST so the first sort wins (stable).
  for (let i = sorts.length - 1; i >= 0; i--) {
    out = sortRows(out, sorts[i]);
  }

  return out;
}

/** Evaluate one filter condition against a raw cell value (client mirror of the worker's ops). */
function matchCondition(value: unknown, op: FilterOp, rawVal: string): boolean {
  if (op === 'null') {
    return value === null || value === undefined || value === '';
  }

  if (op === 'notnull') {
    return !(value === null || value === undefined || value === '');
  }

  const cell = value === null || value === undefined ? '' : String(value);
  const needle = rawVal ?? '';

  switch (op) {
    case 'eq':
      return cell === needle;
    case 'ne':
      return cell !== needle;
    case 'contains':
      return cell.toLowerCase().includes(needle.toLowerCase());
    case 'startswith':
      return cell.toLowerCase().startsWith(needle.toLowerCase());
    case 'endswith':
      return cell.toLowerCase().endsWith(needle.toLowerCase());
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const a = Number(cell);
      const b = Number(needle);
      const numeric = Number.isFinite(a) && Number.isFinite(b);
      const cmp = numeric ? a - b : cell.localeCompare(needle);
      return op === 'gt' ? cmp > 0 : op === 'lt' ? cmp < 0 : op === 'gte' ? cmp >= 0 : cmp <= 0;
    }
    default:
      return true;
  }
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
   * Optional: open the guided Schema builder (the empty-state "＋ New table" launchpad + the "New table"
   * action call this so the owner's click lands in the guided builder, per the embarrassingly-easy bar).
   * When absent, the button falls back to an inline "coming next" note.
   */
  onCreateTable?: () => void;

  /**
   * Optional: open the AI-seed panel (the "✨ Seed with AI" empty-state button falls back to this when
   * present). When absent, the empty-state button runs the inline {@link requestDbAiSeed} bridge directly.
   */
  onSeedWithAi?: () => void;

  /** Optional: open the CSV/JSON Import panel (the "⬆ Import CSV" empty-state + toolbar button). */
  onImportCsv?: () => void;

  /** Optional: jump to the SQL view with the NEW TABLE template (an alternate create flow for power users). */
  onNewTableSql?: () => void;

  /** Optional: open the History (Time-travel) panel — wired into the Tables "Actions" dropdown. */
  onHistory?: () => void;

  /**
   * Optional: an external request to OPEN a specific table (fired by the ⌘K global data-search palette when
   * a result is activated). The `nonce` changes on every request so repeatedly opening the SAME table still
   * re-triggers selection; `rowid` is reserved for a future scroll-to-row (the matched content row).
   */
  openTableRequest?: { table: string; rowid?: number; nonce: number } | null;
}

export const SiteTablesPanel = memo(
  ({ onCreateTable, onSeedWithAi, onImportCsv, onNewTableSql, onHistory, openTableRequest }: SiteTablesPanelProps = {}) => {
    const [tables, setTables] = useState<TablesState>({ status: 'loading' });
    const [selectedTable, setSelectedTable] = useState<string | null>(null);
    const [rows, setRows] = useState<RowsState>({ status: 'idle' });
    const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
    const [comingSoon, setComingSoon] = useState<string | null>(null);

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

    /** The last committed mutation, for one-click local Undo; auto-clears after the window. */
    const [undo, setUndo] = useState<UndoEntry | null>(null);
    const [undoBusy, setUndoBusy] = useState(false);
    const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Grid engine view state (per open table) ───────────────────────────────
    const [sorts, setSorts] = useState<GridSort[]>([]);
    const [search, setSearch] = useState('');
    const [conditions, setConditions] = useState<FilterCondition[]>([]);
    const [combinator, setCombinator] = useState<'AND' | 'OR'>('AND');
    const [filterBarOpen, setFilterBarOpen] = useState(false);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [pageIndex, setPageIndex] = useState(0);
    const [hiddenCols, setHiddenCols] = useState<string[]>([]);
    const [colOrder, setColOrder] = useState<string[]>([]);
    const [colMenuOpen, setColMenuOpen] = useState(false);
    const [density, setDensity] = useState<GridDensity>('cozy');
    const [viewMode, setViewMode] = useState<ViewMode>('grid');

    /**
     * Rev 10 — the kanban GROUP-BY column (null → auto-pick the first low-cardinality text/enum column via
     * {@link defaultKanbanGroupField}). Persisted per-table alongside {@link viewMode}. Only meaningful in
     * the `kanban` view; ignored by grid/gallery.
     */
    const [groupField, setGroupField] = useState<string | null>(null);

    /**
     * The date column driving the CALENDAR view (null → auto-detect the first strict-ISO date column via
     * {@link calendarDateField}). Persisted per-table alongside {@link viewMode}. Only meaningful in the
     * `calendar` view; ignored by grid/gallery/kanban.
     */
    const [dateField, setDateField] = useState<string | null>(null);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set());
    const [bulkBusy, setBulkBusy] = useState(false);
    const [addingRow, setAddingRow] = useState(false);

    /**
     * Revision 3 — the ACTIVE multi-cell selection (one column, a set of row stable-keys). Powers
     * Airtable-style shift-click / shift-arrow range select down a column, fill-down (Cmd/Ctrl+D), and
     * bulk edit (editing once with a selection applies to all). Null when nothing is range-selected.
     * `anchorKey` is the cell a shift-extension measures from.
     */
    const [cellSel, setCellSel] = useState<{ column: string; anchorKey: string | null; keys: Set<string> } | null>(
      null,
    );
    const [fillBusy, setFillBusy] = useState(false);

    /**
     * Live refs read inside the selection handlers (which are declared BEFORE `pageRows`/`cellSel` are in
     * scope for their deps): the current page's rows in DISPLAY order + the active cell selection. Same
     * live-ref pattern the bridge listener uses ({@link pendingRef}) so a handler always sees fresh state.
     */
    const pageRowsRef = useRef<Record<string, unknown>[]>([]);
    const cellSelRef = useRef<typeof cellSel>(null);
    cellSelRef.current = cellSel;

    /** Late-bound ref to the batch-write applier (defined below) so {@link submitEdit} can bulk-apply. */
    const applyCellWritesRef = useRef<
      | ((
          table: string,
          column: string,
          intents: readonly CellWriteIntent[],
        ) => Promise<{ pkKey: string; previous: unknown }[]>)
      | null
    >(null);

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

    /** Load one page of rows for the given table. Pulls a generous window for client-side query. */
    const loadRows = useCallback(
      async (table: string) => {
        setRows({ status: 'loading' });

        try {
          const reply = (await request({
            type: 'PS_SITEDB_ROWS_REQUEST',
            correlationId: nextCorrelationId(),
            table,
            limit: FETCH_LIMIT,
            offset: 0,
          })) as SiteDbRowsResponseMessage;

          if (!reply.ok) {
            setRows({ status: 'error', message: reply.error || `Could not load "${table}".` });
            return;
          }

          const total = reply.total ?? reply.rows?.length ?? 0;
          const columns = reply.columns ?? [];

          // Resolve PK from the column pk flags (server sends `pk` per PRAGMA table_info).
          setPkCols(pkFromTableInfo(columns as unknown as Record<string, unknown>[]));
          setRows({
            status: 'ready',
            page: {
              table: reply.table ?? table,
              columns,
              rows: reply.rows ?? [],
              limit: reply.limit ?? FETCH_LIMIT,
              offset: reply.offset ?? 0,
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

    // On table select: load rows.
    useEffect(() => {
      if (selectedTable) {
        void loadRows(selectedTable);
      }
    }, [selectedTable, loadRows]);

    /*
     * External open request (⌘K global data-search): select the requested table so the grid opens it (the
     * effect above then loads its rows). Guarded to a REAL table from THIS site's loaded list so a stale
     * result can never select a nonexistent table; if the list hasn't loaded yet, select optimistically (the
     * name came from the site's OWN search endpoint). Keyed on `nonce` so re-opening the same table re-fires.
     */
    useEffect(() => {
      if (!openTableRequest) {
        return;
      }

      const known = tables.status === 'ready' ? tables.tables.map((t) => t.name) : [];

      if (known.length === 0 || known.includes(openTableRequest.table)) {
        setSelectedTable(openTableRequest.table);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openTableRequest?.nonce]);

    /** Reset all per-table grid view state to defaults (fresh table = fresh query). */
    const resetGridView = useCallback(() => {
      setSorts([]);
      setSearch('');
      setConditions([]);
      setCombinator('AND');
      setFilterBarOpen(false);
      setPageIndex(0);
      setHiddenCols([]);
      setColOrder([]);
      setColMenuOpen(false);
      setViewMode('grid');
      setGroupField(null);
      setDateField(null);
      setSelectedRowKeys(new Set());
      setAddingRow(false);
      setCellSel(null);
    }, []);

    const openTable = useCallback(
      (name: string) => {
        setDetailRow(null);
        setGeneratedCols(new Set());
        setEditing(null);
        resetGridView();
        setSelectedTable(name);
        void loadGeneratedCols(name);
      },
      [loadGeneratedCols, resetGridView],
    );

    const backToList = useCallback(() => {
      setSelectedTable(null);
      setRows({ status: 'idle' });
      setDetailRow(null);
      setEditing(null);
      setPkCols([]);
      setGeneratedCols(new Set());
      resetGridView();
    }, [resetGridView]);

    /** The site's D1 id (for per-table view persistence); '' until the table list resolves. */
    const databaseId = tables.status === 'ready' ? tables.databaseId : '';

    /**
     * localStorage key for a table's persisted view choice — scoped to the site's D1 id + table so one
     * table's Grid/Gallery/Kanban preference never leaks into another table or another site's DB. Pure.
     */
    const viewStorageKey = useCallback(
      (table: string): string => `ps-sitedb-view:${databaseId || '__shared'}:${table}`,
      [databaseId],
    );

    /*
     * Restore the persisted view (mode + kanban group field) whenever a table opens (or its D1 id
     * resolves). Runs AFTER openTable's resetGridView, so it re-applies the saved choice over the reset
     * default. Fail-soft: any parse/storage error just leaves the defaults (grid + auto-group).
     */
    useEffect(() => {
      if (!selectedTable) {
        return;
      }

      try {
        const raw = window.localStorage.getItem(viewStorageKey(selectedTable));

        if (!raw) {
          return;
        }

        const saved = JSON.parse(raw) as { mode?: unknown; group?: unknown; date?: unknown };
        setViewMode(normalizeViewMode(typeof saved.mode === 'string' ? saved.mode : undefined));
        setGroupField(typeof saved.group === 'string' ? saved.group : null);
        setDateField(typeof saved.date === 'string' ? saved.date : null);
      } catch {
        // no stored preference / storage blocked — keep the defaults
      }
    }, [selectedTable, viewStorageKey]);

    /*
     * Persist the view choice per-table whenever mode or group field changes (skipped until a table is
     * open + its D1 id known, so we never write a '__shared' key for a not-yet-loaded site). Fail-soft.
     */
    useEffect(() => {
      if (!selectedTable) {
        return;
      }

      try {
        window.localStorage.setItem(
          viewStorageKey(selectedTable),
          JSON.stringify({ mode: viewMode, group: groupField, date: dateField }),
        );
      } catch {
        // storage unavailable (sandboxed / private mode) — persistence is best-effort
      }
    }, [selectedTable, viewMode, groupField, dateField, viewStorageKey]);

    const flashComingSoon = useCallback((label: string) => {
      setComingSoon(label);
      setTimeout(() => setComingSoon((cur) => (cur === label ? null : cur)), 3200);
    }, []);

    // ── ERD / schema-map view (Rev 8) ────────────────────────────────────────
    /** Whether the ERD / schema-relationships diagram is open (replaces the list/browse pane). */
    const [erdOpen, setErdOpen] = useState(false);
    /** The assembled schema map for the ERD: every table + its columns (idle | loading | ready | error). */
    const [erdSchema, setErdSchema] = useState<
      | { status: 'idle' }
      | { status: 'loading' }
      | { status: 'error'; message: string }
      | { status: 'ready'; tables: ErdSchemaTable[] }
    >({ status: 'idle' });

    /**
     * Gather each table's columns for the ERD by reusing the EXISTING `PS_SITEDB_ROWS_REQUEST` bridge
     * with `limit:0` (schema only, zero rows) — the SAME call {@link loadRows} makes, NOT a new endpoint.
     * Sequential (small per-site DBs) + fail-soft: a table whose columns fail to load is drawn empty.
     */
    const loadErdSchema = useCallback(async () => {
      if (tables.status !== 'ready') {
        return;
      }

      setErdSchema({ status: 'loading' });

      try {
        const assembled: ErdSchemaTable[] = [];

        for (const t of tables.tables) {
          let cols: { name: string; type: string; pk: number }[] = [];

          try {
            const reply = (await request({
              type: 'PS_SITEDB_ROWS_REQUEST',
              correlationId: nextCorrelationId(),
              table: t.name,
              limit: 0,
              offset: 0,
            })) as SiteDbRowsResponseMessage;

            if (reply.ok && reply.columns) {
              cols = reply.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk }));
            }
          } catch {
            // Fail soft — a table whose schema can't be read is drawn as an empty card.
          }

          assembled.push({ name: t.name, columns: cols });
        }

        setErdSchema({ status: 'ready', tables: assembled });
      } catch (err) {
        setErdSchema({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not load the schema map.',
        });
      }
    }, [tables, request]);

    /** Open the ERD (gathers the schema on first open / when it isn't ready yet). */
    const openErd = useCallback(() => {
      setErdOpen(true);

      if (erdSchema.status !== 'ready' && erdSchema.status !== 'loading') {
        void loadErdSchema();
      }
    }, [erdSchema.status, loadErdSchema]);

    // ── Create table (manual builder) + drop table — via the dedicated per-site D1 P1 endpoints ──
    /** Whether the guided "New table" modal is open. */
    const [createTableOpen, setCreateTableOpen] = useState(false);
    /** The table name currently being dropped (shows the confirm + a spinner), or null. */
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const [dropBusy, setDropBusy] = useState(false);

    /**
     * Create a NEW table (manual name + typed columns) via the dedicated `POST /db/tables` bridge
     * ({@link requestDbCreateTable}) — NOT the exec-SQL path. On success, refetch the table list so the new
     * one appears. Returns `{ ok, error? }` so the modal can surface a verbatim server error inline.
     */
    const createTable = useCallback(
      async (name: string, columns: SiteDbColumnSpec[]): Promise<{ ok: boolean; error?: string }> => {
        if (!isEmbedded) {
          return { ok: false, error: 'Open this from the ProjectSites admin to create a table.' };
        }

        let reply: Awaited<ReturnType<typeof requestDbCreateTable>>;

        try {
          reply = await requestDbCreateTable({ name, columns });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'The table could not be created.' };
        }

        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          return { ok: false, error: DISABLED_404 };
        }

        if (!reply.ok) {
          return { ok: false, error: reply.error || 'The table could not be created.' };
        }

        postToastToParent('success', `Created table “${reply.table ?? name}”.`);
        await loadTables();

        return { ok: true };
      },
      [loadTables],
    );

    /**
     * Drop a table via the dedicated `DELETE /db/tables/:table` bridge ({@link requestDbDropTable}). Called
     * after the danger-confirm is accepted. On success, close any open view of it + refetch the list.
     */
    const dropTable = useCallback(
      async (name: string) => {
        setDropBusy(true);

        let reply: Awaited<ReturnType<typeof requestDbDropTable>>;

        try {
          reply = await requestDbDropTable({ table: name });
        } catch (err) {
          setDropBusy(false);
          postToastToParent('error', err instanceof Error ? err.message : `Could not drop “${name}”.`);
          return;
        }

        setDropBusy(false);
        setDropTarget(null);

        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          postToastToParent('error', 'Per-site data is not enabled.');
          return;
        }

        if (!reply.ok) {
          postToastToParent('error', reply.error || `Could not drop “${name}”.`);
          return;
        }

        postToastToParent('success', `Dropped table “${name}”.`);

        // If the dropped table is the one open in the browse view, return to the list.
        setSelectedTable((cur) => (cur === name ? null : cur));
        await loadTables();
      },
      [loadTables],
    );

    // ── Quick-fill actions (Load sample data · Seed with AI) ──────────────────
    /** Which quick-fill action is in flight (disables its button + shows a spinner), or null. */
    const [quickFill, setQuickFill] = useState<null | 'sample' | 'seed'>(null);

    /**
     * "📊 Load sample data" — ask the admin (via the per-site bridge) to seed the site's OWN D1 with a
     * ready-made starter dataset. Toasts the outcome + refreshes the table list so the new tables appear.
     */
    const loadSampleData = useCallback(async () => {
      if (quickFill) {
        return;
      }

      setQuickFill('sample');

      try {
        const reply = await requestDbLoadSample({});

        if (!reply.ok) {
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setTables({ status: 'disabled' });
            return;
          }

          postToastToParent('error', reply.error || 'Could not load the sample data.');

          return;
        }

        const tablesCreated = reply.tablesCreated ?? reply.tables?.length ?? 0;
        const rowsInserted = reply.rowsInserted ?? 0;
        postToastToParent(
          'success',
          tablesCreated > 0
            ? `Loaded ${tablesCreated} sample table${tablesCreated === 1 ? '' : 's'}${rowsInserted > 0 ? ` with ${rowsInserted} rows` : ''}.`
            : 'Sample data loaded.',
        );
        await loadTables();

        // Jump straight into the first created table (embarrassingly-easy: land on real data).
        const first = reply.tables?.[0];

        if (first) {
          openTable(first);
        }
      } catch (err) {
        postToastToParent('error', err instanceof Error ? err.message : 'Could not load the sample data.');
      } finally {
        setQuickFill(null);
      }
    }, [quickFill, loadTables, openTable]);

    /**
     * "✨ Seed with AI" — ask the admin to fill a table with realistic AI-generated rows. From the empty
     * state it prefers the parent's richer AI-seed panel ({@link onSeedWithAi}); the toolbar version (with a
     * table already open) seeds THAT table inline via the bridge. Toasts the outcome + refreshes the rows.
     */
    const seedWithAi = useCallback(
      async (table?: string) => {
        // When a dedicated panel is available and no specific table is targeted, open it (richer flow).
        if (onSeedWithAi && !table) {
          onSeedWithAi();
          return;
        }

        if (quickFill) {
          return;
        }

        setQuickFill('seed');

        try {
          const reply = await requestDbAiSeed({ table });

          if (!reply.ok) {
            if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
              setTables({ status: 'disabled' });
              return;
            }

            postToastToParent('error', reply.error || 'AI could not seed the table.');

            return;
          }

          const inserted = reply.rowsInserted ?? 0;
          const seeded = reply.table ?? table;
          postToastToParent(
            'success',
            seeded
              ? `Added ${inserted} AI-generated row${inserted === 1 ? '' : 's'} to ${seeded}.`
              : `Added ${inserted} AI-generated row${inserted === 1 ? '' : 's'}.`,
          );

          // Refresh: re-load the open table's rows if it was the target, else the table list.
          if (selectedTable && (!seeded || seeded === selectedTable)) {
            await loadRows(selectedTable);
          } else {
            await loadTables();
          }
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'AI could not seed the table.');
        } finally {
          setQuickFill(null);
        }
      },
      [onSeedWithAi, quickFill, selectedTable, loadRows, loadTables],
    );

    // ── Edit helpers ──────────────────────────────────────────────────────────

    /**
     * Whether the open table's browsed rows carry the stable `_rowid` handle (Revision 1). Every row
     * from the browse endpoint (`SELECT rowid AS _rowid, *`) has one for an ordinary table — so this is
     * the fallback identity that keeps a PK-LESS table editable. Derived from the loaded rows (a WITHOUT
     * ROWID / virtual table would omit it, in which case a PK-less table stays honestly read-only).
     */
    const hasRowid = useMemo(
      () => (rows.status === 'ready' && rows.page.rows.length > 0 ? rowRowid(rows.page.rows[0]) !== null : false),
      [rows],
    );

    /**
     * A column is editable when the row is safely targetable (a PK exists, OR a `_rowid` handle exists)
     * and the column isn't the PK, a generated column, or the synthetic `_rowid` handle. Delegates to the
     * pure {@link isRowEditableColumn} gate — killing the old "no primary key ⇒ read-only" limitation.
     */
    const editableColumn = useCallback(
      (col: string): { editable: boolean; reason?: string } =>
        isRowEditableColumn(col, { pkCols, generatedCols, hasRowid }),
      [pkCols, generatedCols, hasRowid],
    );

    /** Open the typed editor for one cell — seed kind + value from the column's DECLARED type. */
    const startEdit = useCallback(
      (row: Record<string, unknown>, col: ColumnInfo) => {
        const gate = editableColumn(col.name);

        if (!gate.editable) {
          return;
        }

        // Stable identity: the PK when present, else the row's `_rowid` — so a PK-less row still opens.
        const stableKey = rowStableKey(row, pkCols);

        if (stableKey === null) {
          return;
        }

        setEditError('');

        const { kind, value } = editorKindForColumn(col.type, row[col.name]);
        setEditKind(kind);
        setEditValue(value);
        setEditing({ pkKey: stableKey, column: col.name });
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
     * Write ONE cell to the site's OWN D1 by the row's stable identity. When the table has a PRIMARY
     * KEY, send a param-bound `UPDATE … WHERE pk=?` over the exec-SQL bridge (unchanged). When it has NO
     * PK, target the row by its stable SQLite `rowid` (`_rowid`) via the dedicated `PATCH …/rows/:rowid`
     * bridge — the Revision 1 path that keeps a PK-less table fully editable. Normalizes both to
     * `{ ok, error? }`; never throws.
     */
    const writeCell = useCallback(
      async (
        table: string,
        row: Record<string, unknown>,
        column: string,
        value: BoundValue,
      ): Promise<{ ok: boolean; error?: string }> => {
        // PK path: the proven param-bound UPDATE-by-PK over the exec-SQL bridge.
        if (pkCols.length > 0) {
          let stmt: { sql: string; params: BoundValue[] };

          try {
            stmt = buildUpdateByPk(table, pkCols, row, column, value);
          } catch (e) {
            return { ok: false, error: e instanceof RowMutationError ? e.message : 'Could not build the statement.' };
          }

          return execSql(stmt.sql, stmt.params, true);
        }

        // No-PK path (Revision 1): target the row by its stable `_rowid` via PATCH …/rows/:rowid.
        const rowid = rowRowid(row);

        if (rowid === null) {
          return { ok: false, error: 'This row has no stable id, so it can’t be edited.' };
        }

        try {
          const reply = await requestDbUpdateRow({ table, rowid, column, value });

          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            return { ok: false, error: DISABLED_404 };
          }

          if (!reply.ok) {
            return { ok: false, error: reply.error || 'The edit could not be saved.' };
          }

          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'The database could not be reached.' };
        }
      },
      [pkCols, execSql],
    );

    /**
     * Commit the open cell edit: OPTIMISTICALLY update the local grid, WRITE via {@link writeCell}
     * (UPDATE-by-PK when a PK exists, else PATCH-by-`_rowid`), and on failure ROLL BACK + surface the
     * error. On success, arm a one-click local Undo (the reverse write).
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

        const previous = row[col.name];
        // Stable identity: PK when present, else the row's `_rowid` — so a PK-less row is targetable.
        const stableKey = rowStableKey(row, pkCols);

        // Optimistic: patch the row in place immediately (by stable identity) so the UI responds instantly.
        setRows((cur) => {
          if (cur.status !== 'ready') {
            return cur;
          }

          return {
            status: 'ready',
            page: {
              ...cur.page,
              rows: cur.page.rows.map((r) => (rowStableKey(r, pkCols) === stableKey ? { ...r, [col.name]: value } : r)),
            },
          };
        });
        setDetailRow((cur) => (cur && rowStableKey(cur, pkCols) === stableKey ? { ...cur, [col.name]: value } : cur));
        setEditBusy(true);
        setEditError('');

        const res = await writeCell(table, row, col.name, value);

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
                rows: cur.page.rows.map((r) =>
                  rowStableKey(r, pkCols) === stableKey ? { ...r, [col.name]: previous } : r,
                ),
              },
            };
          });
          setDetailRow((cur) =>
            cur && rowStableKey(cur, pkCols) === stableKey ? { ...cur, [col.name]: previous } : cur,
          );
          setEditError(res.error || 'The edit could not be saved.');

          return;
        }

        // Committed — close the editor.
        setEditing(null);

        // Bulk edit: if this cell is part of a multi-cell column selection, apply the SAME value to every
        // OTHER selected row (Airtable "edit once → fill the selection"), through the same per-row bridge —
        // and arm ONE batch Undo covering the anchor + all propagated cells.
        const sel = cellSelRef.current;
        const isBulk =
          sel !== null &&
          sel.column === col.name &&
          sel.keys.size > 1 &&
          stableKey !== null &&
          sel.keys.has(stableKey);

        if (isBulk && stableKey !== null) {
          const others = pageRowsRef.current.filter((r) => {
            const k = rowStableKey(r, pkCols);
            return k !== null && k !== stableKey && sel.keys.has(k);
          });
          const apply = applyCellWritesRef.current;
          const wroteCells = apply
            ? await apply(
                table,
                col.name,
                others.map((r) => ({ row: r, value })),
              )
            : [];

          // Fold the anchor cell + every successfully-propagated cell into ONE batch Undo (true previous values).
          armUndo({
            kind: 'cellBatch',
            table,
            column: col.name,
            cells: [{ pkKey: stableKey, previous }, ...wroteCells],
            label: `Edited ${wroteCells.length + 1} cell${wroteCells.length + 1 === 1 ? '' : 's'}`,
          });

          return;
        }

        if (stableKey !== null) {
          armUndo({ kind: 'cell', table, column: col.name, pkKey: stableKey, previous, next: value });
        }
      },
      [rows, editKind, editValue, pkCols, writeCell, armUndo],
    );

    /**
     * Toggle a BOOLEAN cell directly from the grid (checkbox) — a one-click optimistic write, no editor.
     * Same optimistic + rollback + undo contract as {@link submitEdit}, and the same PK-or-`_rowid`
     * write routing via {@link writeCell}. No-op for a non-editable column.
     */
    const toggleBooleanCell = useCallback(
      async (row: Record<string, unknown>, col: ColumnInfo) => {
        if (rows.status !== 'ready' || !editableColumn(col.name).editable) {
          return;
        }

        const cur = row[col.name];
        const isOn = cur === 1 || cur === true || cur === '1' || cur === 'true';
        const next: BoundValue = isOn ? 0 : 1;
        const previous = cur;
        const stableKey = rowStableKey(row, pkCols);
        const table = rows.page.table;

        setRows((s) => {
          if (s.status !== 'ready') {
            return s;
          }

          return {
            status: 'ready',
            page: {
              ...s.page,
              rows: s.page.rows.map((r) => (rowStableKey(r, pkCols) === stableKey ? { ...r, [col.name]: next } : r)),
            },
          };
        });

        const res = await writeCell(table, row, col.name, next);

        if (!res.ok) {
          setRows((s) => {
            if (s.status !== 'ready') {
              return s;
            }

            return {
              status: 'ready',
              page: {
                ...s.page,
                rows: s.page.rows.map((r) =>
                  rowStableKey(r, pkCols) === stableKey ? { ...r, [col.name]: previous } : r,
                ),
              },
            };
          });
          postToastToParent('error', res.error || 'Could not update the checkbox.');

          return;
        }

        if (stableKey !== null) {
          armUndo({ kind: 'cell', table, column: col.name, pkKey: stableKey, previous, next });
        }
      },
      [rows, editableColumn, pkCols, writeCell, armUndo],
    );

    /**
     * Apply a batch of single-column cell writes (fill-down or bulk edit) through the EXISTING per-row
     * {@link writeCell} bridge — one bridge call per row (UPDATE-by-PK when a PK exists, else
     * PATCH-by-`_rowid`). OPTIMISTIC: patches every target row immediately; per-row ROLLBACK restores only
     * the rows whose write failed (successful ones stay). Returns the successfully-written cells (key +
     * previous value) so the CALLER can arm ONE combined `cellBatch` Undo — never double-arms. No-op for an
     * empty plan. `intents` come from {@link fillDownWrites} (or the bulk-edit path).
     */
    const applyCellWrites = useCallback(
      async (
        table: string,
        column: string,
        intents: readonly CellWriteIntent[],
      ): Promise<{ pkKey: string; previous: unknown }[]> => {
        if (intents.length === 0) {
          return [];
        }

        // Capture each target's stable key + previous value BEFORE the optimistic patch (for rollback + undo).
        const targets = intents
          .map((it) => ({ key: rowStableKey(it.row, pkCols), row: it.row, value: it.value as BoundValue }))
          .filter((t): t is { key: string; row: Record<string, unknown>; value: BoundValue } => t.key !== null);

        if (targets.length === 0) {
          return [];
        }

        const prevByKey = new Map<string, unknown>();

        for (const t of targets) {
          prevByKey.set(t.key, t.row[column]);
        }

        const nextByKey = new Map<string, BoundValue>();

        for (const t of targets) {
          nextByKey.set(t.key, t.value);
        }

        // Optimistic: patch all target rows in place at once.
        setRows((cur) =>
          cur.status !== 'ready'
            ? cur
            : {
                status: 'ready',
                page: {
                  ...cur.page,
                  rows: cur.page.rows.map((r) => {
                    const k = rowStableKey(r, pkCols);
                    return k !== null && nextByKey.has(k) ? { ...r, [column]: nextByKey.get(k) } : r;
                  }),
                },
              },
        );
        setFillBusy(true);

        // Write each row; collect the keys that FAILED so we roll back only those.
        const failedKeys = new Set<string>();
        let firstError = '';

        for (const t of targets) {
          const res = await writeCell(table, t.row, column, t.value);

          if (!res.ok) {
            failedKeys.add(t.key);

            if (!firstError) {
              firstError = res.error || 'Some cells could not be saved.';
            }
          }
        }

        setFillBusy(false);

        if (failedKeys.size > 0) {
          // Roll back only the failed rows to their previous value.
          setRows((cur) =>
            cur.status !== 'ready'
              ? cur
              : {
                  status: 'ready',
                  page: {
                    ...cur.page,
                    rows: cur.page.rows.map((r) => {
                      const k = rowStableKey(r, pkCols);
                      return k !== null && failedKeys.has(k) ? { ...r, [column]: prevByKey.get(k) } : r;
                    }),
                  },
                },
          );
          postToastToParent('error', firstError);
        }

        return targets
          .filter((t) => !failedKeys.has(t.key))
          .map((t) => ({ pkKey: t.key, previous: prevByKey.get(t.key) }));
      },
      [pkCols, writeCell],
    );

    applyCellWritesRef.current = applyCellWrites;

    /**
     * Handle a cell click/keyboard-select for the multi-cell selection engine. A modifier-click (meta/ctrl)
     * starts (or toggles) a single-cell selection in that column; a SHIFT-click/arrow extends the selection
     * as a contiguous run from the anchor down (or up) the SAME column via {@link extendCellSelection}. A
     * plain click on a cell in a DIFFERENT column resets the selection. Selection is per-column: clicking a
     * cell in another column while a selection exists starts fresh there. Pure state — no writes.
     */
    const selectCell = useCallback(
      (row: Record<string, unknown>, column: string, mods: { shift: boolean; meta: boolean }) => {
        const key = rowStableKey(row, pkCols);

        if (key === null) {
          return;
        }

        const orderedKeys = pageRowsRef.current
          .map((r) => rowStableKey(r, pkCols))
          .filter((k): k is string => k !== null);

        setCellSel((cur) => {
          // Shift extends within the same column from the existing anchor (or from this cell if none/other col).
          if (mods.shift && cur && cur.column === column) {
            const run = extendCellSelection(orderedKeys, cur.anchorKey, key);
            return { column, anchorKey: cur.anchorKey ?? key, keys: new Set(run) };
          }

          // Meta/ctrl toggles this cell within the same-column selection (add/remove), keeping the anchor.
          if (mods.meta && cur && cur.column === column) {
            const keys = new Set(cur.keys);

            if (keys.has(key)) {
              keys.delete(key);
            } else {
              keys.add(key);
            }

            return keys.size === 0 ? null : { column, anchorKey: key, keys };
          }

          // Fresh single-cell selection anchored here (new column, or a plain modifier-click).
          return { column, anchorKey: key, keys: new Set([key]) };
        });
      },
      [pkCols],
    );

    const clearCellSel = useCallback(() => setCellSel(null), []);

    /**
     * FILL-DOWN the active column selection: copy the TOP selected cell's value to every lower selected
     * cell via {@link fillDownWrites} → {@link applyCellWrites} (N selected → N-1 bridge writes). The
     * source row keeps its value; targets get it optimistically, with per-row rollback + a single Undo.
     * No-op unless ≥2 cells are selected in one column and the column is editable.
     */
    const fillDownSelection = useCallback(async () => {
      const sel = cellSelRef.current;

      if (rows.status !== 'ready' || !sel || sel.keys.size < 2 || fillBusy) {
        return;
      }

      if (!editableColumn(sel.column).editable) {
        postToastToParent('error', 'This column can’t be edited.');
        return;
      }

      const table = rows.page.table;
      const intents = fillDownWrites(pageRowsRef.current, sel.column, sel.keys, (r) => rowStableKey(r, pkCols));
      const wroteCells = await applyCellWrites(table, sel.column, intents);

      if (wroteCells.length > 0) {
        armUndo({
          kind: 'cellBatch',
          table,
          column: sel.column,
          cells: wroteCells,
          label: `Filled ${wroteCells.length} cell${wroteCells.length === 1 ? '' : 's'} down`,
        });
        postToastToParent('success', `Filled ${wroteCells.length} cell${wroteCells.length === 1 ? '' : 's'} down.`);
      }
    }, [rows, fillBusy, editableColumn, pkCols, applyCellWrites, armUndo]);

    /** Undo the last committed mutation (cell / insert / delete) by re-issuing its reverse statement. */
    const doUndo = useCallback(async () => {
      if (!undo || rows.status !== 'ready') {
        return;
      }

      const liveTable = rows.page.table;
      setUndoBusy(true);

      try {
        if (undo.kind === 'cell') {
          // Re-target the same row by its STABLE identity (PK when present, else `_rowid`).
          const currentRow = rows.page.rows.find((r) => rowStableKey(r, pkCols) === undo.pkKey);

          if (!currentRow || undo.table !== liveTable) {
            return;
          }

          const res = await writeCell(undo.table, currentRow, undo.column, undo.previous as BoundValue);

          if (res.ok) {
            const restored = undo.previous;
            const targetKey = undo.pkKey;
            const targetCol = undo.column;
            setRows((cur) =>
              cur.status !== 'ready'
                ? cur
                : {
                    status: 'ready',
                    page: {
                      ...cur.page,
                      rows: cur.page.rows.map((r) =>
                        rowStableKey(r, pkCols) === targetKey ? { ...r, [targetCol]: restored } : r,
                      ),
                    },
                  },
            );
          }
        } else if (undo.kind === 'cellBatch' && undo.table === liveTable && undo.cells.length > 0) {
          // Reverse a fill-down / bulk edit → restore each row's previous value (one write per cell).
          const restoredByKey = new Map(undo.cells.map((c) => [c.pkKey, c.previous]));

          for (const c of undo.cells) {
            const currentRow = rows.page.rows.find((r) => rowStableKey(r, pkCols) === c.pkKey);

            if (currentRow) {
              await writeCell(undo.table, currentRow, undo.column, c.previous as BoundValue);
            }
          }

          const targetCol = undo.column;
          setRows((cur) =>
            cur.status !== 'ready'
              ? cur
              : {
                  status: 'ready',
                  page: {
                    ...cur.page,
                    rows: cur.page.rows.map((r) => {
                      const k = rowStableKey(r, pkCols);
                      return k !== null && restoredByKey.has(k) ? { ...r, [targetCol]: restoredByKey.get(k) } : r;
                    }),
                  },
                },
          );
        } else if (undo.kind === 'insert' && undo.table === liveTable && undo.pkCols.length > 0) {
          // Reverse an insert → DELETE the row by its PK values.
          const preds = undo.pkCols.map((c, i) => `${quoteIdent(c)} = ?${i + 1}`).join(' AND ');
          const params = undo.pkCols.map((c) => undo.pkValues[c]);
          const res = await execSql(`DELETE FROM ${quoteIdent(undo.table)} WHERE ${preds}`, params, true);

          if (res.ok) {
            await loadRows(liveTable);
          }
        } else if (undo.kind === 'delete' && undo.table === liveTable && undo.rows.length > 0) {
          // Reverse a delete → re-INSERT the removed rows verbatim.
          for (const r of undo.rows) {
            const cols = Object.keys(r);
            const placeholders = cols.map((_, i) => `?${i + 1}`).join(', ');
            const colList = cols.map((c) => quoteIdent(c)).join(', ');
            await execSql(
              `INSERT INTO ${quoteIdent(undo.table)} (${colList}) VALUES (${placeholders})`,
              cols.map((c) => r[c] as BoundValue),
              true,
            );
          }

          await loadRows(liveTable);
        }
      } finally {
        setUndoBusy(false);
        clearUndo();
      }
    }, [undo, rows, pkCols, execSql, writeCell, clearUndo, loadRows]);

    // ── Derived grid data (visible columns · filtered/sorted rows · current page) ────────
    const allColumns = rows.status === 'ready' ? rows.page.columns : [];
    const allColumnNames = useMemo(() => allColumns.map((c) => c.name), [allColumns]);

    /** Column display order (persisted order applied, new columns appended) minus hidden. */
    const orderedNames = useMemo(() => orderColumns(allColumnNames, colOrder), [allColumnNames, colOrder]);
    const shownNames = useMemo(() => visibleColumns(orderedNames, hiddenCols), [orderedNames, hiddenCols]);
    const shownColumns = useMemo(
      () => shownNames.map((n) => allColumns.find((c) => c.name === n)).filter((c): c is ColumnInfo => Boolean(c)),
      [shownNames, allColumns],
    );

    /** The full filtered + sorted row set (across the loaded window). */
    const processedRows = useMemo(() => {
      if (rows.status !== 'ready') {
        return [];
      }

      return applyGridQuery(rows.page.rows, allColumnNames, search, conditions, combinator, sorts);
    }, [rows, allColumnNames, search, conditions, combinator, sorts]);

    const filteredCount = processedRows.length;
    const loadedTotal = rows.status === 'ready' ? rows.page.total : 0;
    const pageCount = Math.max(1, Math.ceil(filteredCount / pageSize));
    const safePageIndex = Math.min(pageIndex, pageCount - 1);

    /** The rows on the current page (post-filter/sort). */
    const pageRows = useMemo(
      () => processedRows.slice(safePageIndex * pageSize, safePageIndex * pageSize + pageSize),
      [processedRows, safePageIndex, pageSize],
    );

    // Keep the live page-rows ref current so the cell-selection handlers (declared earlier) see display order.
    pageRowsRef.current = pageRows;

    // Any filter/search/sort/pagesize change resets to page 0 (never strand the user past the end).
    useEffect(() => {
      setPageIndex(0);
    }, [search, conditions, combinator, sorts, pageSize]);

    /** Column-header click → cycle multi-sort (shift optional; every click extends/flips/removes). */
    const onSortColumn = useCallback((col: string) => {
      setSorts((cur) => cycleSortMulti(cur, col));
    }, []);

    /** The sort direction shown on a header (its index in the priority list, or null). */
    const sortFor = useCallback(
      (col: string): { dir: 'asc' | 'desc'; priority: number } | null => {
        const i = sorts.findIndex((s) => s.col === col);
        return i < 0 ? null : { dir: sorts[i].dir, priority: i + 1 };
      },
      [sorts],
    );

    // ── Row selection + bulk delete ───────────────────────────────────────────
    const canMutateRows = pkCols.length > 0;

    const toggleRowSelected = useCallback((key: string) => {
      setSelectedRowKeys((cur) => {
        const next = new Set(cur);

        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }

        return next;
      });
    }, []);

    const toggleSelectAll = useCallback(() => {
      setSelectedRowKeys((cur) => {
        const pageKeys = pageRows.map((r) => rowPkKey(r, pkCols)).filter((k): k is string => k !== null);
        const allSelected = pageKeys.length > 0 && pageKeys.every((k) => cur.has(k));

        if (allSelected) {
          const next = new Set(cur);
          pageKeys.forEach((k) => next.delete(k));

          return next;
        }

        return new Set([...cur, ...pageKeys]);
      });
    }, [pageRows, pkCols]);

    /** Delete one row by its PK (row-menu action). Optimistic-free: reload after the write; undoable. */
    const deleteRow = useCallback(
      async (row: Record<string, unknown>) => {
        if (rows.status !== 'ready' || !canMutateRows) {
          return;
        }

        const table = rows.page.table;
        const preds = pkCols.map((c, i) => `${quoteIdent(c)} = ?${i + 1}`).join(' AND ');
        const params = pkCols.map((c) => row[c] as BoundValue);
        setBulkBusy(true);
        const res = await execSql(`DELETE FROM ${quoteIdent(table)} WHERE ${preds}`, params, true);
        setBulkBusy(false);

        if (!res.ok) {
          postToastToParent('error', res.error || 'Could not delete the row.');
          return;
        }

        armUndo({ kind: 'delete', table, rows: [row], label: '1 row' });
        await loadRows(table);
      },
      [rows, canMutateRows, pkCols, execSql, armUndo, loadRows],
    );

    /** Delete every selected row (one param-bound DELETE per row). Undoable as a batch re-INSERT. */
    const deleteSelected = useCallback(async () => {
      if (rows.status !== 'ready' || !canMutateRows || selectedRowKeys.size === 0) {
        return;
      }

      const table = rows.page.table;
      const toDelete = rows.page.rows.filter((r) => {
        const k = rowPkKey(r, pkCols);
        return k !== null && selectedRowKeys.has(k);
      });

      setBulkBusy(true);

      let failed = 0;

      for (const row of toDelete) {
        const preds = pkCols.map((c, i) => `${quoteIdent(c)} = ?${i + 1}`).join(' AND ');
        const params = pkCols.map((c) => row[c] as BoundValue);
        const res = await execSql(`DELETE FROM ${quoteIdent(table)} WHERE ${preds}`, params, true);

        if (!res.ok) {
          failed++;
        }
      }

      setBulkBusy(false);
      setSelectedRowKeys(new Set());

      if (failed > 0) {
        postToastToParent('error', `${failed} row${failed === 1 ? '' : 's'} could not be deleted.`);
      } else {
        armUndo({ kind: 'delete', table, rows: toDelete, label: `${toDelete.length} rows` });
      }

      await loadRows(table);
    }, [rows, canMutateRows, selectedRowKeys, pkCols, execSql, armUndo, loadRows]);

    // ── Add row (parameterized INSERT of a blank/typed record) ────────────────
    /**
     * Insert a new blank row. Non-PK, non-generated columns are set to NULL (owner fills them by editing);
     * an INTEGER PRIMARY KEY autoincrements (omitted from the INSERT). Reloads + arms undo (delete by PK).
     */
    const addRow = useCallback(async () => {
      if (rows.status !== 'ready' || !canMutateRows || addingRow) {
        return;
      }

      const table = rows.page.table;
      const cols = rows.page.columns;

      // Columns to INSERT: skip an INTEGER PK (autoincrements) + generated columns.
      const insertCols = cols.filter((c) => {
        if (generatedCols.has(c.name)) {
          return false;
        }

        const isIntPk = c.pk === 1 && /INT/i.test(c.type || '');

        return !isIntPk;
      });

      if (insertCols.length === 0) {
        // Every column is an autoincrement PK → a bare DEFAULT VALUES insert.
        setAddingRow(true);
        const res = await execSql(`INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`, [], true);
        setAddingRow(false);

        if (!res.ok) {
          postToastToParent('error', res.error || 'Could not add a row.');
          return;
        }

        await loadRows(table);

        return;
      }

      const colList = insertCols.map((c) => quoteIdent(c.name)).join(', ');
      const placeholders = insertCols.map((_, i) => `?${i + 1}`).join(', ');
      const params: BoundValue[] = insertCols.map((c) => {
        // A NOT NULL column with no default needs a seed value; text→'', number→0, else NULL.
        if (c.notnull === 1) {
          return /INT|REAL|NUM|DEC|FLOA|DOUB/i.test(c.type || '') ? 0 : '';
        }

        return null;
      });

      setAddingRow(true);
      const res = await execSql(
        `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${placeholders})`,
        params,
        true,
      );
      setAddingRow(false);

      if (!res.ok) {
        postToastToParent('error', res.error || 'Could not add a row.');
        return;
      }

      postToastToParent('success', 'Added a new row — click any cell to fill it in.');
      await loadRows(table);
    }, [rows, canMutateRows, addingRow, generatedCols, execSql, loadRows]);

    // ── Add / drop column via DDL through the per-site bridge ──────────────────
    const [addColOpen, setAddColOpen] = useState(false);

    const addColumn = useCallback(
      async (name: string, kind: FieldKind) => {
        if (rows.status !== 'ready') {
          return { ok: false, error: 'No table open.' };
        }

        if (!isEmbedded) {
          return { ok: false, error: 'Open this from the ProjectSites admin to add a column.' };
        }

        // Guard duplicates client-side (the worker would reject too, but this is instant + friendlier).
        const existing = rows.page.columns.map((c) => c.name.toLowerCase());

        if (existing.includes(name.toLowerCase())) {
          return { ok: false, error: `A column named “${name}” already exists.` };
        }

        const table = rows.page.table;

        // Dedicated `POST /db/tables/:table/columns` bridge (adds ONE nullable column) — NOT the exec-SQL
        // path. Mirrors createTable: dark flag → DISABLED_404, verbatim server error surfaced inline.
        let reply: Awaited<ReturnType<typeof requestDbAddColumn>>;

        try {
          reply = await requestDbAddColumn({ table, name, type: FIELD_TYPES[kind].sqliteType });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'The column could not be added.' };
        }

        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          return { ok: false, error: DISABLED_404 };
        }

        if (!reply.ok) {
          return { ok: false, error: reply.error || 'The column could not be added.' };
        }

        postToastToParent('success', `Added column “${reply.column ?? name}”.`);
        await loadGeneratedCols(table);
        await loadRows(table);

        return { ok: true };
      },
      [rows, loadGeneratedCols, loadRows],
    );

    const dropColumn = useCallback(
      async (col: string) => {
        if (rows.status !== 'ready') {
          return;
        }

        if (!isEmbedded) {
          postToastToParent('error', 'Open this from the ProjectSites admin to drop a column.');
          return;
        }

        const table = rows.page.table;

        // Dedicated `DELETE /db/tables/:table/columns/:column` bridge — NOT the exec-SQL path.
        let reply: Awaited<ReturnType<typeof requestDbDropColumn>>;

        try {
          reply = await requestDbDropColumn({ table, column: col });
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : `Could not drop “${col}”.`);
          return;
        }

        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          postToastToParent('error', 'Per-site data is not enabled.');
          return;
        }

        if (!reply.ok) {
          postToastToParent('error', reply.error || `Could not drop “${col}”.`);
          return;
        }

        postToastToParent('success', `Dropped column “${reply.column ?? col}”.`);
        await loadGeneratedCols(table);
        await loadRows(table);
      },
      [rows, loadGeneratedCols, loadRows],
    );

    const renameColumn = useCallback(
      async (from: string, to: string) => {
        if (rows.status !== 'ready') {
          return { ok: false, error: 'No table open.' };
        }

        if (!isEmbedded) {
          return { ok: false, error: 'Open this from the ProjectSites admin to rename a column.' };
        }

        const next = to.trim();

        if (!next) {
          return { ok: false, error: 'Enter a new name.' };
        }

        if (next === from) {
          return { ok: true };
        }

        // Duplicate guard (case-insensitive) — SQLite would error, but this is instant + clearer.
        const existing = rows.page.columns.map((c) => c.name.toLowerCase());

        if (existing.includes(next.toLowerCase())) {
          return { ok: false, error: `A column named “${next}” already exists.` };
        }

        const table = rows.page.table;

        // Dedicated `PATCH /db/tables/:table/columns/:column` bridge — NOT the exec-SQL path.
        let reply: Awaited<ReturnType<typeof requestDbRenameColumn>>;

        try {
          reply = await requestDbRenameColumn({ table, column: from, name: next });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'The column could not be renamed.' };
        }

        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          return { ok: false, error: DISABLED_404 };
        }

        if (!reply.ok) {
          return { ok: false, error: reply.error || 'The column could not be renamed.' };
        }

        postToastToParent('success', `Renamed “${from}” to “${reply.column ?? next}”.`);
        await loadGeneratedCols(table);
        await loadRows(table);

        return { ok: true };
      },
      [rows, loadGeneratedCols, loadRows],
    );

    // ── Whole-table export (CSV / TSV / JSON via the engine helpers) ──────────
    /** Export the WHOLE filtered/sorted set (not just the page) via the shared serializers. */
    const exportData = useCallback(
      (format: 'csv' | 'tsv' | 'json') => {
        if (rows.status !== 'ready') {
          return;
        }

        const cols = allColumnNames;
        const data = processedRows;
        const table = rows.page.table;

        if (format === 'csv') {
          downloadText(toCsv(cols, data), `${table}.csv`, 'text/csv');
        } else if (format === 'tsv') {
          downloadText(toTsv(cols, data), `${table}.tsv`, 'text/tab-separated-values');
        } else {
          downloadText(toJsonRows(cols, data), `${table}.json`, 'application/json');
        }

        postToastToParent('success', `Exported ${data.length} row${data.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
      },
      [rows, allColumnNames, processedRows],
    );

    // ── AI-native: gather schema for grounding ─────────────────────────────────
    const gatherSchemaOutline = useCallback((): string => {
      if (rows.status !== 'ready') {
        return '(no table open)';
      }

      return formatSchemaForPrompt([
        {
          name: rows.page.table,
          columns: rows.page.columns.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk })),
        },
      ]);
    }, [rows]);

    /** One `/api/llmcall` round-trip returning the model text, or throwing a human error. */
    const callAi = useCallback(async (system: string, message: string): Promise<string> => {
      if (!isEmbedded) {
        throw new Error('Open this from the ProjectSites admin to use AI.');
      }

      const res = await fetch('/api/llmcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, message, model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER, streamOutput: false }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `AI is unavailable (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as { text?: string; error?: boolean; message?: string };

      if (data.error || typeof data.text !== 'string') {
        throw new Error(data.message ?? 'AI did not return a result.');
      }

      return data.text;
    }, []);

    const [aiBusy, setAiBusy] = useState<null | 'filter' | 'column' | 'fill'>(null);
    const [aiPanel, setAiPanel] = useState<null | 'filter' | 'column' | 'fill'>(null);
    const [aiError, setAiError] = useState('');

    /**
     * AI natural-language filter: "orders over $100 last week" → a `{conditions,combinator,sorts}` plan
     * applied to the grid. The model is grounded on the real schema + asked for STRICT JSON so it can
     * never touch unknown columns. AI is enhancement — a parse failure surfaces honestly, never blocks.
     */
    const aiFilter = useCallback(
      async (question: string) => {
        const q = question.trim();

        if (!q || aiBusy) {
          return;
        }

        setAiBusy('filter');
        setAiError('');

        const system = [
          'You translate a plain-English request into a JSON filter+sort plan for a database grid.',
          'The available columns are in the schema below — use ONLY those column names.',
          'Return ONLY minified JSON, no prose, of the shape:',
          '{"conditions":[{"col":"<column>","op":"<op>","val":"<value>"}],"combinator":"AND|OR","sorts":[{"col":"<column>","dir":"asc|desc"}]}',
          `Valid ops: ${['eq', 'ne', 'contains', 'startswith', 'endswith', 'gt', 'lt', 'gte', 'lte', 'null', 'notnull'].join(', ')}.`,
          'For null/notnull, use an empty val. If no sort is implied, use an empty sorts array.',
          '',
          'SCHEMA:',
          gatherSchemaOutline(),
        ].join('\n');

        try {
          const text = await callAi(system, q);
          const jsonText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '');
          const plan = JSON.parse(jsonText) as {
            conditions?: Array<{ col?: string; op?: string; val?: string }>;
            combinator?: string;
            sorts?: Array<{ col?: string; dir?: string }>;
          };

          const known = new Set(allColumnNames);
          const nextConditions: FilterCondition[] = (plan.conditions ?? [])
            .filter((c) => c.col && known.has(c.col))
            .slice(0, MAX_FILTER_CONDITIONS)
            .map((c) => ({ col: c.col as string, op: normalizeFilterOp(c.op), val: c.val ?? '' }));

          const nextSorts: GridSort[] = (plan.sorts ?? [])
            .filter((s) => s.col && known.has(s.col))
            .map((s) => ({ col: s.col as string, dir: s.dir === 'desc' ? 'desc' : 'asc' }));

          if (nextConditions.length === 0 && nextSorts.length === 0) {
            setAiError('AI could not map that to the current columns. Try naming a column.');
            return;
          }

          setConditions(nextConditions.length ? nextConditions : [blankCondition()]);
          setCombinator(plan.combinator?.toUpperCase() === 'OR' ? 'OR' : 'AND');
          setSorts(nextSorts);
          setFilterBarOpen(true);
          setAiPanel(null);
          postToastToParent('success', 'AI applied a filter — tweak or clear it anytime.');
        } catch (err) {
          setAiError(err instanceof Error ? err.message : 'AI could not build that filter.');
        } finally {
          setAiBusy(null);
        }
      },
      [aiBusy, allColumnNames, gatherSchemaOutline, callAi],
    );

    /**
     * AI generate-column: describe a column ("estimated delivery date") → the model picks a name + type +
     * a SQLite expression to backfill it. We ADD the typed column, then backfill via a single `UPDATE`
     * using the model's expression (grounded on the schema, reviewed by the runner's confirm gate).
     */
    const aiGenerateColumn = useCallback(
      async (description: string) => {
        const d = description.trim();

        if (!d || aiBusy || rows.status !== 'ready') {
          return;
        }

        setAiBusy('column');
        setAiError('');

        const table = rows.page.table;
        const system = [
          'You design ONE new SQLite column for an existing table and a backfill expression.',
          'Return ONLY minified JSON: {"name":"<snake_case>","type":"TEXT|INTEGER|REAL","expr":"<sqlite expression over existing columns, or a constant>"}',
          'The column name must be a valid SQLite identifier not already in the table.',
          'The expr must reference ONLY existing columns (see schema) or be a literal. Keep it a single scalar expression.',
          '',
          'SCHEMA:',
          gatherSchemaOutline(),
        ].join('\n');

        try {
          const text = await callAi(system, d);
          const jsonText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '');
          const plan = JSON.parse(jsonText) as { name?: string; type?: string; expr?: string };

          if (!plan.name) {
            throw new Error('AI did not return a column name.');
          }

          const kind: FieldKind =
            plan.type === 'INTEGER' ? 'number' : plan.type === 'REAL' ? 'number' : 'text';
          const added = await addColumn(plan.name, kind);

          if (!added.ok) {
            throw new Error(added.error || 'Could not add the column.');
          }

          // Backfill via the model's expression (best-effort; a bad expr surfaces as a toast).
          if (plan.expr && plan.expr.trim()) {
            const res = await execSql(
              `UPDATE ${quoteIdent(table)} SET ${quoteIdent(plan.name)} = (${plan.expr})`,
              [],
              true,
            );

            if (!res.ok) {
              postToastToParent('warning', `Column added, but the AI backfill failed: ${res.error ?? ''}`);
            }
          }

          await loadRows(table);
          setAiPanel(null);
          postToastToParent('success', `AI added column “${plan.name}”.`);
        } catch (err) {
          setAiError(err instanceof Error ? err.message : 'AI could not generate that column.');
        } finally {
          setAiBusy(null);
        }
      },
      [aiBusy, rows, gatherSchemaOutline, callAi, addColumn, execSql, loadRows],
    );

    /**
     * AI fill selected cells: for the chosen column + the currently-selected rows, ask the model to
     * generate a value per row (grounded on the row's other fields), then write each via a param-bound
     * UPDATE. Enhancement-only — no selection or a parse failure surfaces honestly.
     */
    const aiFillColumn = useCallback(
      async (column: string, instruction: string) => {
        if (aiBusy || rows.status !== 'ready' || !column) {
          return;
        }

        const table = rows.page.table;
        const targets = rows.page.rows.filter((r) => {
          const k = rowPkKey(r, pkCols);
          return k !== null && selectedRowKeys.has(k);
        });

        if (targets.length === 0) {
          setAiError('Select one or more rows first (checkbox), then AI-fill.');
          return;
        }

        setAiBusy('fill');
        setAiError('');

        const system = [
          `You fill the "${column}" field for each record. Return ONLY minified JSON: an array of values, one per record, in order.`,
          instruction.trim() ? `Instruction: ${instruction.trim()}` : '',
          'Base each value on the record fields provided. Values must be plain scalars (string or number).',
        ]
          .filter(Boolean)
          .join('\n');

        const message = JSON.stringify(targets.map((r) => ({ ...r })));

        try {
          const text = await callAi(system, message);
          const jsonText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '');
          const values = JSON.parse(jsonText) as unknown[];

          if (!Array.isArray(values) || values.length === 0) {
            throw new Error('AI did not return values.');
          }

          let written = 0;

          for (let i = 0; i < targets.length && i < values.length; i++) {
            const v = values[i];
            const bound: BoundValue =
              v === null || v === undefined
                ? null
                : typeof v === 'number' || typeof v === 'boolean'
                  ? v
                  : String(v);

            let stmt: { sql: string; params: BoundValue[] };

            try {
              stmt = buildUpdateByPk(table, pkCols, targets[i], column, bound);
            } catch {
              continue;
            }

            const res = await execSql(stmt.sql, stmt.params, true);

            if (res.ok) {
              written++;
            }
          }

          await loadRows(table);
          setAiPanel(null);
          setSelectedRowKeys(new Set());
          postToastToParent('success', `AI filled ${written} cell${written === 1 ? '' : 's'} in “${column}”.`);
        } catch (err) {
          setAiError(err instanceof Error ? err.message : 'AI could not fill those cells.');
        } finally {
          setAiBusy(null);
        }
      },
      [aiBusy, rows, pkCols, selectedRowKeys, callAi, execSql, loadRows],
    );

    const rowHeight = ROW_HEIGHT_FOR[density];
    const selectedOnPage = pageRows.filter((r) => {
      const k = rowPkKey(r, pkCols);
      return k !== null && selectedRowKeys.has(k);
    }).length;

    return (
      <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary [color-scheme:dark] accent-[color:var(--ps-accent,#00e5ff)]">
        <Header
          editable={selectedTable !== null && pkCols.length > 0}
          onNewTable={() => setCreateTableOpen(true)}
          onImport={() => (onImportCsv ? onImportCsv() : flashComingSoon('Import'))}
          onHistory={() => (onHistory ? onHistory() : flashComingSoon('History'))}
          onRefresh={selectedTable ? () => void loadRows(selectedTable) : () => void loadTables()}
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

        {/* Persistent schema rail (left) + Table list ↔ browse view (right).
            The rail lists every table from the ALREADY-FETCHED tables response (no new endpoint) and
            stays mounted across list↔browse so switching tables is one click — an Airtable-style browser. */}
        <div className="flex-1 flex min-h-0">
          {tables.status === 'ready' && tables.tables.length > 0 && (
            <SchemaRail
              tables={tables.tables}
              activeTable={selectedTable}
              activeColumnCount={rows.status === 'ready' ? rows.page.columns.length : null}
              activeRowCount={rows.status === 'ready' ? rows.page.total : null}
              onOpen={openTable}
            />
          )}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Schema-map (ERD) toggle — visible whenever the site has ≥1 table; never a dead control. */}
            {tables.status === 'ready' && tables.tables.length > 0 && (
              <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
                <button
                  type="button"
                  data-testid="sitedb-erd-toggle"
                  aria-pressed={erdOpen}
                  onClick={() => (erdOpen ? setErdOpen(false) : openErd())}
                  className={classNames(
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                    erdOpen
                      ? 'border-[color:var(--ps-accent,#00e5ff)] bg-bolt-elements-item-backgroundActive text-bolt-elements-item-contentAccent'
                      : 'border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-textPrimary',
                  )}
                  title={erdOpen ? 'Back to tables' : 'Schema map — see how your tables relate'}
                >
                  <div className={classNames(erdOpen ? 'i-ph:table' : 'i-ph:graph', 'text-sm')} aria-hidden />
                  {erdOpen ? 'Tables' : 'Schema map'}
                </button>
              </div>
            )}
            {erdOpen ? (
              <div data-testid="sitedb-erd-panel" className="flex-1 overflow-auto modern-scrollbar p-3">
                {erdSchema.status === 'loading' ? (
                  <div className="flex items-center gap-2 p-6 text-sm text-bolt-elements-textSecondary">
                    <div className="i-ph:circle-notch animate-spin text-base" aria-hidden />
                    Reading your schema…
                  </div>
                ) : erdSchema.status === 'error' ? (
                  <div className="p-6 text-sm text-bolt-elements-textSecondary">
                    <p>{erdSchema.message}</p>
                    <button
                      type="button"
                      onClick={() => void loadErdSchema()}
                      className="mt-2 rounded-md border border-bolt-elements-borderColor px-2.5 py-1 text-[11px] text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                ) : erdSchema.status === 'ready' && erdSchema.tables.length >= 2 ? (
                  <ErdView tables={erdSchema.tables} onOpenTable={(name) => { setErdOpen(false); openTable(name); }} />
                ) : (
                  <div
                    data-testid="sitedb-erd-empty"
                    className="flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-bolt-elements-textSecondary"
                  >
                    <div className="i-ph:graph text-2xl text-bolt-elements-textTertiary" aria-hidden />
                    <p className="font-medium text-bolt-elements-textPrimary">Add tables to see the schema map</p>
                    <p className="text-[12px] text-bolt-elements-textTertiary">
                      The schema map draws how your tables relate. Create at least two tables (a
                      <code className="mx-1">customer_id</code> column links to a <code>customers</code> table)
                      and it fills in here.
                    </p>
                  </div>
                )}
              </div>
            ) : !selectedTable ? (
          <TableListView
            state={tables}
            onOpen={openTable}
            onRetry={() => void loadTables()}
            onComingSoon={flashComingSoon}
            onCreateTable={() => setCreateTableOpen(true)}
            onNewTableSql={onNewTableSql}
            onDropTable={(name) => setDropTarget(name)}
            onSeedWithAi={() => void seedWithAi()}
            onLoadSample={() => void loadSampleData()}
            onImportCsv={onImportCsv}
            quickFill={quickFill}
          />
        ) : (
          <BrowseView
            table={selectedTable}
            state={rows}
            // engine-derived
            allColumns={allColumns}
            shownColumns={shownColumns}
            shownNames={shownNames}
            orderedNames={orderedNames}
            hiddenCols={hiddenCols}
            pageRows={pageRows}
            filteredCount={filteredCount}
            loadedTotal={loadedTotal}
            pageIndex={safePageIndex}
            pageCount={pageCount}
            pageSize={pageSize}
            density={density}
            rowHeight={rowHeight}
            viewMode={viewMode}
            sorts={sorts}
            sortFor={sortFor}
            search={search}
            conditions={conditions}
            combinator={combinator}
            filterBarOpen={filterBarOpen}
            colMenuOpen={colMenuOpen}
            selectedRowKeys={selectedRowKeys}
            selectedOnPage={selectedOnPage}
            canMutateRows={canMutateRows}
            bulkBusy={bulkBusy}
            addingRow={addingRow}
            addColOpen={addColOpen}
            aiPanel={aiPanel}
            aiBusy={aiBusy}
            aiError={aiError}
            // edit engine
            editableColumn={editableColumn}
            editing={editing}
            editKind={editKind}
            editValue={editValue}
            editError={editError}
            editBusy={editBusy}
            pkCols={pkCols}
            generatedCols={generatedCols}
            // cell selection (fill-down + bulk edit)
            cellSel={cellSel}
            fillBusy={fillBusy}
            // handlers
            onBack={backToList}
            onSetSearch={setSearch}
            onSortColumn={onSortColumn}
            onSetPageSize={(n) => setPageSize(clampPageSize(n))}
            onPrevPage={() => setPageIndex((p) => Math.max(0, p - 1))}
            onNextPage={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
            onToggleFilterBar={() => setFilterBarOpen((o) => !o)}
            onToggleColMenu={() => setColMenuOpen((o) => !o)}
            onToggleHidden={(col) =>
              setHiddenCols((cur) => (cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col]))
            }
            onMoveColumn={(col, dir) => setColOrder((cur) => moveColumn(allColumnNames, cur, col, dir))}
            onSetDensity={setDensity}
            onSetViewMode={setViewMode}
            groupField={groupField}
            onSetGroupField={setGroupField}
            dateField={dateField}
            onSetDateField={setDateField}
            onAddCondition={() => setConditions((c) => addCondition(c))}
            onRemoveCondition={(i) => setConditions((c) => removeCondition(c, i))}
            onUpdateCondition={(i, patch) => setConditions((c) => updateCondition(c, i, patch))}
            onSetCombinator={setCombinator}
            onClearFilters={() => {
              setConditions([]);
              setSearch('');
              setSorts([]);
            }}
            onRowClick={setDetailRow}
            onStartEdit={startEdit}
            onCellSelect={selectCell}
            onFillDown={fillDownSelection}
            onClearCellSel={clearCellSel}
            onToggleBoolean={toggleBooleanCell}
            onEditKindChange={setEditKind}
            onEditValueChange={setEditValue}
            onEditSave={submitEdit}
            onEditCancel={cancelEdit}
            onToggleRowSelected={toggleRowSelected}
            onToggleSelectAll={toggleSelectAll}
            onDeleteRow={deleteRow}
            onDeleteSelected={deleteSelected}
            onClearSelection={() => setSelectedRowKeys(new Set())}
            onAddRow={addRow}
            onOpenAddCol={() => setAddColOpen(true)}
            onCloseAddCol={() => setAddColOpen(false)}
            onAddColumn={addColumn}
            onDropColumn={dropColumn}
            onRenameColumn={renameColumn}
            onExport={exportData}
            onOpenAi={(which) => {
              setAiError('');
              setAiPanel(which);
            }}
            onCloseAi={() => setAiPanel(null)}
            onAiFilter={aiFilter}
            onAiGenerateColumn={aiGenerateColumn}
            onAiFillColumn={aiFillColumn}
            onSeedWithAi={() => void seedWithAi(selectedTable)}
            onRetry={() => void loadRows(selectedTable)}
          />
        )}
          </div>
        </div>

        {/* One-click Undo toast (embarrassingly-easy: every mutation is reversible) */}
        {undo && (
          <div
            className="border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
            data-testid="sitedb-undo"
            role="status"
          >
            <div className="i-ph:check-circle text-emerald-400" />
            <span className="min-w-0 truncate">
              {undo.kind === 'cell' ? (
                <>
                  Saved <span className="font-mono text-bolt-elements-textPrimary">{undo.column}</span> ={' '}
                  <span className="font-mono text-bolt-elements-textPrimary">{undoValueLabel(undo.next)}</span>
                </>
              ) : undo.kind === 'insert' ? (
                <>Added a row</>
              ) : (
                <>
                  Deleted <span className="font-mono text-bolt-elements-textPrimary">{undo.label}</span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => void doUndo()}
              disabled={undoBusy}
              data-testid="sitedb-undo-button"
              className="ml-auto min-h-[24px] text-[11px] font-semibold px-2.5 py-1 rounded border border-[#00e5ff99] bg-bolt-elements-background-depth-3 text-bolt-elements-item-contentAccent enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
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
              <span className="text-bolt-elements-textPrimary font-medium">{comingSoon}</span> is coming next.
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
            canMutateRows={canMutateRows}
            cellSel={null}
            onDeleteRow={deleteRow}
            onStartEdit={startEdit}
            onCellSelect={selectCell}
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

        {/* Create-table modal (guided, no-SQL — name + typed columns → POST /db/tables) */}
        {createTableOpen && (
          <CreateTableModal onCreate={createTable} onClose={() => setCreateTableOpen(false)} />
        )}

        {/* Drop-table danger confirm (DELETE /db/tables/:table) */}
        {dropTarget && (
          <DropTableConfirm
            table={dropTarget}
            busy={dropBusy}
            onConfirm={() => void dropTable(dropTarget)}
            onCancel={() => setDropTarget(null)}
          />
        )}
      </div>
    );
  },
);

SiteTablesPanel.displayName = 'SiteTablesPanel';

// ── Header ─────────────────────────────────────────────────────────────────

const Header = memo(
  ({
    subtitle,
    editable,
    onNewTable,
    onImport,
    onHistory,
    onRefresh,
  }: {
    subtitle: string;
    editable: boolean;
    onNewTable: () => void;
    onImport: () => void;
    onHistory: () => void;
    onRefresh: () => void;
  }) => {
    // Single "Actions" dropdown consolidates the old Seed/refresh buttons + the removed toolbar row
    // (Brian 2026-09-28) — New Table · Import · History · Refresh. Mirrors the DataGrid export menu.
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!open) {
        return;
      }

      const onDown = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      };

      document.addEventListener('mousedown', onDown);

      return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const run = (fn: () => void) => {
      setOpen(false);
      fn();
    };

    const items: ReadonlyArray<{ label: string; icon: string; on: () => void }> = [
      { label: 'New Table', icon: 'i-ph:blueprint-duotone', on: onNewTable },
      { label: 'Import', icon: 'i-ph:upload-simple-duotone', on: onImport },
      { label: 'History', icon: 'i-ph:clock-counter-clockwise-duotone', on: onHistory },
      { label: 'Refresh', icon: 'i-ph:arrows-clockwise', on: onRefresh },
    ];

    return (
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
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={open}
              data-testid="sitedb-actions"
              title="Table actions"
              className="min-h-[24px] text-[11px] font-semibold px-2.5 py-1 rounded-md border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-backgroundAccent/20 transition-colors motion-reduce:transition-none flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:lightning-duotone text-sm shrink-0" aria-hidden />
              Actions
              <div
                className={classNames('i-ph:caret-down text-xs transition-transform', open && 'rotate-180')}
                aria-hidden
              />
            </button>
            {open && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg"
              >
                {items.map((it) => (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    onClick={() => run(it.on)}
                    data-testid={`sitedb-action-${it.label.toLowerCase().replace(/\s+/g, '-')}`}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundAccent/10 hover:text-bolt-elements-textPrimary cursor-pointer focus-visible:outline-none focus-visible:bg-bolt-elements-item-backgroundAccent/10"
                  >
                    <div className={classNames(it.icon, 'text-sm')} aria-hidden /> {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
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

// ── Loading skeleton ────────────────────────────────────────────────────────

const TableListSkeleton = memo(() => (
  <div className="flex-1 overflow-hidden p-3" data-testid="sitedb-skeleton" aria-busy="true" aria-live="polite">
    <div className="flex items-center gap-2 px-1 py-1.5">
      <div className="h-3 w-16 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
    </div>
    <div className="space-y-1.5 mt-1">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-2 rounded-md bg-bolt-elements-background-depth-2/60">
          <div className="i-ph:table text-sm text-bolt-elements-textTertiary/40 shrink-0" aria-hidden />
          <div
            className="h-3 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse"
            style={{ width: `${45 + ((i * 13) % 40)}%` }}
          />
        </div>
      ))}
    </div>
    <span className="sr-only">Loading your tables…</span>
  </div>
));

TableListSkeleton.displayName = 'SiteTablesPanel.TableListSkeleton';

// ── Empty launchpad ──────────────────────────────────────────────────────────

interface LaunchTile {
  key: 'seed' | 'sample' | 'newtable' | 'import';
  icon: string;
  title: string;
  desc: string;
  primary?: boolean;
}

const LAUNCH_TILES: readonly LaunchTile[] = [
  {
    key: 'seed',
    icon: 'i-ph:sparkle-duotone',
    title: 'Use AI to load sample data',
    desc: 'Generate a table full of realistic rows from a short description.',
    primary: true,
  },
  {
    key: 'sample',
    icon: 'i-ph:table-duotone',
    title: 'Load sample data',
    desc: 'Drop in a ready-made starter dataset to explore right away.',
  },
  {
    key: 'newtable',
    icon: 'i-ph:plus-square-duotone',
    title: 'Create Table',
    desc: 'Design a table yourself with a guided, no-SQL schema builder.',
  },
  {
    key: 'import',
    icon: 'i-ph:upload-simple-duotone',
    title: 'Import CSV',
    desc: 'Bring your own data — upload a CSV or JSON file into a table.',
  },
] as const;

const EmptyLaunchpad = memo(
  ({
    onSeedWithAi,
    onLoadSample,
    onCreateTable,
    onImportCsv,
    quickFill,
  }: {
    onSeedWithAi: () => void;
    onLoadSample: () => void;
    onCreateTable: () => void;
    onImportCsv: () => void;
    quickFill: null | 'sample' | 'seed';
  }) => {
    const handlers: Record<LaunchTile['key'], () => void> = {
      seed: onSeedWithAi,
      sample: onLoadSample,
      newtable: onCreateTable,
      import: onImportCsv,
    };

    return (
      <div className="flex-1 overflow-auto modern-scrollbar" data-testid="sitedb-empty">
        <div className="min-h-full flex flex-col items-center justify-center gap-6 p-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <div className="relative flex items-center justify-center h-16 w-16 rounded-2xl border border-[#00e5ff4c] bg-[#00e5ff14]">
              <div className="i-ph:database-duotone text-3xl text-bolt-elements-item-contentAccent" aria-hidden />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -inset-2 rounded-3xl opacity-40 blur-xl"
                style={{
                  background: 'radial-gradient(circle, color-mix(in oklch, #00e5ff 40%, transparent), transparent 70%)',
                }}
              />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-[length:clamp(1rem,3.5vw,1.25rem)] font-semibold text-bolt-elements-textPrimary tracking-tight">
                Your database is a blank canvas
              </h3>
              <p className="text-[12px] text-bolt-elements-textSecondary max-w-[380px] text-pretty">
                Start with real data in one click — let AI generate it, drop in a sample set, design a table, or bring
                your own file.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-[520px]">
            {LAUNCH_TILES.map((tile) => {
              const busy =
                (tile.key === 'seed' && quickFill === 'seed') || (tile.key === 'sample' && quickFill === 'sample');
              const disabled = quickFill !== null;

              return (
                <button
                  key={tile.key}
                  type="button"
                  onClick={handlers[tile.key]}
                  disabled={disabled}
                  data-testid={`sitedb-empty-${tile.key}`}
                  className={classNames(
                    'group relative overflow-hidden rounded-xl border p-4 text-left flex flex-col gap-2 transition-all duration-150 motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent',
                    'enabled:hover:-translate-y-0.5 motion-reduce:enabled:hover:translate-y-0 enabled:hover:shadow-lg enabled:hover:shadow-[#00e5ff0d]',
                    disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                    tile.primary
                      ? 'border-[#00e5ff80] bg-[#00e5ff0f] enabled:hover:border-[#00e5ffb2]'
                      : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 enabled:hover:border-[#00e5ff66] enabled:hover:bg-bolt-elements-background-depth-3',
                  )}
                >
                  {tile.primary && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-0 bottom-0 w-0.5 bg-[#00e5ffb2]"
                    />
                  )}
                  <div className="flex items-center gap-2.5">
                    <div
                      className={classNames(
                        'flex items-center justify-center h-9 w-9 rounded-xl shrink-0',
                        tile.primary
                          ? 'border border-[#00e5ff4c] bg-[#00e5ff1a]'
                          : 'border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1',
                      )}
                      aria-hidden="true"
                    >
                      <div
                        className={classNames(
                          busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : tile.icon,
                          'text-lg',
                          tile.primary ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textSecondary',
                        )}
                      />
                    </div>
                    <span className="text-[13px] font-semibold text-bolt-elements-textPrimary">
                      {busy ? 'Working…' : tile.title}
                    </span>
                  </div>
                  <p className="text-[11px] text-bolt-elements-textTertiary leading-snug text-pretty">{tile.desc}</p>
                </button>
              );
            })}
          </div>

          <p className="text-[10px] text-bolt-elements-textTertiary/80 flex items-center gap-1.5">
            <span className="i-ph:shield-check text-bolt-elements-item-contentAccent/70" aria-hidden />
            This is your site&rsquo;s own private database — nothing is shared with other sites.
          </p>
        </div>
      </div>
    );
  },
);

EmptyLaunchpad.displayName = 'SiteTablesPanel.EmptyLaunchpad';

// ── Advanced search (expanding bar + stylized results) ───────────────────────

/** The internal state machine for the expanding advanced-search bar. */
type SearchPhase =
  | { status: 'idle' }
  | { status: 'searching'; q: string }
  | {
      status: 'results';
      q: string;
      nameMatches: string[];
      contentMatches: { table: string; column: string; rowid: number; snippet: string }[];
      truncated: boolean;
    }
  | { status: 'error'; q: string; message: string };

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN_CHARS = 2;

/**
 * Render one content-match snippet with the matched query emphasized (case-insensitive). Splits the snippet
 * around the FIRST occurrence so the matched run is visually highlighted in cyan; falls back to the raw
 * snippet when the query isn't literally present (e.g. the server matched a normalized/stemmed form). Pure.
 */
function highlightSnippet(snippet: string, query: string): React.ReactNode {
  const q = query.trim();

  if (!q) {
    return snippet;
  }

  const idx = snippet.toLowerCase().indexOf(q.toLowerCase());

  if (idx < 0) {
    return snippet;
  }

  return (
    <>
      {snippet.slice(0, idx)}
      <mark className="bg-[#00e5ff40] text-bolt-elements-item-contentAccent rounded-sm px-0.5">
        {snippet.slice(idx, idx + q.length)}
      </mark>
      {snippet.slice(idx + q.length)}
    </>
  );
}

/**
 * An expanding advanced-search control for the Tables list: a search icon that opens into a text input,
 * debounced (~250ms) cross-table search over the site's OWN D1 via {@link requestDbSearch}. Renders a
 * stylized results panel with TWO distinct groups — table-NAME matches (clickable → open) and in-CONTENT
 * matches (cyan-accented `🔎 table · column` + emphasized snippet → open the owning table). Collapses on
 * blur when empty; Esc collapses + clears. Silently hides itself when per-site data is off (`enabled:false`).
 */
const TableSearch = memo(({ onOpen }: { onOpen: (name: string) => void }) => {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<SearchPhase>({ status: 'idle' });
  /** Set once the bridge reports the feature disabled — hides the whole control, no dead affordance. */
  const [disabled, setDisabled] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic token so a slow reply from a stale query can't clobber a newer one. */
  const runIdRef = useRef(0);

  // Focus the input the moment the bar expands (keyboard-first).
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    }
  }, [expanded]);

  // Clean up any pending debounce on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    },
    [],
  );

  const runSearch = useCallback(async (q: string) => {
    const runId = ++runIdRef.current;
    setPhase({ status: 'searching', q });

    let reply: Awaited<ReturnType<typeof requestDbSearch>>;

    try {
      reply = await requestDbSearch({ q });
    } catch (err) {
      if (runId !== runIdRef.current) {
        return;
      }

      setPhase({ status: 'error', q, message: err instanceof Error ? err.message : 'Search could not run.' });

      return;
    }

    // A newer keystroke superseded this reply — drop it.
    if (runId !== runIdRef.current) {
      return;
    }

    // Feature is dark — hide the whole control silently (never a dead/doomed input).
    if (reply.enabled === false) {
      setDisabled(true);
      return;
    }

    if (!reply.ok) {
      setPhase({ status: 'error', q, message: reply.error || 'Search could not run.' });
      return;
    }

    setPhase({
      status: 'results',
      q,
      nameMatches: reply.nameMatches ?? [],
      contentMatches: reply.contentMatches ?? [],
      truncated: reply.truncated ?? false,
    });
  }, []);

  // Debounced query → search (≥2 chars); clearing/short query resets to the plain list.
  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      const trimmed = value.trim();

      if (trimmed.length < SEARCH_MIN_CHARS) {
        runIdRef.current++; // cancel any in-flight reply
        setPhase({ status: 'idle' });

        return;
      }

      debounceRef.current = setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  const collapse = useCallback(() => {
    setExpanded(false);
    setQuery('');
    runIdRef.current++;
    setPhase({ status: 'idle' });

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        collapse();
      }
    },
    [collapse],
  );

  // Collapse on blur ONLY when the field is empty (so results stay while typing/reading).
  const onBlur = useCallback(() => {
    if (query.trim().length === 0) {
      setExpanded(false);
    }
  }, [query]);

  if (disabled) {
    return null;
  }

  const showPanel = expanded && query.trim().length >= SEARCH_MIN_CHARS;

  return (
    <div className="relative">
      {expanded ? (
        <div className="flex items-center gap-1 rounded border border-[#00e5ff80] bg-bolt-elements-background-depth-2 pl-2 pr-1 transition-[width] duration-150 motion-reduce:transition-none">
          <div className="i-ph:magnifying-glass text-[12px] text-bolt-elements-item-contentAccent shrink-0" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            placeholder="Search tables & data…"
            data-testid="sitedb-search"
            aria-label="Search tables and data"
            className="w-40 sm:w-52 bg-transparent py-0.5 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
          />
          {phase.status === 'searching' && (
            <div className="i-ph:circle-notch animate-spin motion-reduce:animate-none text-[12px] text-bolt-elements-item-contentAccent shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={collapse}
            title="Close search (Esc)"
            aria-label="Close search"
            className="i-ph:x text-[12px] text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent rounded cursor-pointer"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="sitedb-search-open"
          title="Search tables & data"
          aria-label="Search tables and data"
          className="min-h-[24px] text-[11px] font-medium px-2 py-0.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent hover:border-[#00e5ff80] transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
        >
          <div className="i-ph:magnifying-glass" /> <span>Search</span>
        </button>
      )}

      {showPanel && (
        <div
          data-testid="sitedb-search-results"
          className="absolute right-0 top-[calc(100%+6px)] z-20 w-[min(88vw,22rem)] max-h-[60vh] overflow-auto modern-scrollbar rounded-lg border border-[#00e5ff4c] bg-[#060610] shadow-xl shadow-black/40"
          style={{ boxShadow: '0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in oklch, #00e5ff 12%, transparent)' }}
        >
          {phase.status === 'searching' && (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-bolt-elements-textSecondary">
              <div className="i-ph:circle-notch animate-spin motion-reduce:animate-none text-bolt-elements-item-contentAccent" aria-hidden />
              Searching your data…
            </div>
          )}

          {phase.status === 'error' && (
            <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-bolt-elements-textSecondary">
              <div className="i-ph:warning-circle text-red-400 mt-0.5 shrink-0" aria-hidden />
              <span>{phase.message}</span>
            </div>
          )}

          {phase.status === 'results' &&
            (phase.nameMatches.length === 0 && phase.contentMatches.length === 0 ? (
              <div
                className="flex flex-col items-center gap-1.5 px-3 py-6 text-center"
                data-testid="sitedb-search-empty"
              >
                <div className="i-ph:magnifying-glass text-xl text-bolt-elements-textTertiary/60" aria-hidden />
                <p className="text-[11px] text-bolt-elements-textSecondary">
                  No matches for &ldquo;{phase.q}&rdquo;
                </p>
                <p className="text-[10px] text-bolt-elements-textTertiary">Try a table name or a value in a cell.</p>
              </div>
            ) : (
              <>
                {phase.nameMatches.length > 0 && (
                  <div className="py-1">
                    <div className="px-3 pt-1.5 pb-1 text-[9px] uppercase tracking-wider text-bolt-elements-textTertiary flex items-center gap-1">
                      <div className="i-ph:table text-bolt-elements-textTertiary" aria-hidden /> Tables
                    </div>
                    {phase.nameMatches.map((name) => (
                      <button
                        key={`name-${name}`}
                        type="button"
                        onMouseDown={(e) => e.preventDefault() /* keep input focus so blur doesn't collapse */}
                        onClick={() => onOpen(name)}
                        data-testid="sitedb-search-name-row"
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-bolt-elements-item-backgroundActive transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                      >
                        <div className="i-ph:database text-[13px] text-bolt-elements-item-contentAccent shrink-0" aria-hidden />
                        <span className="text-[12px] text-bolt-elements-textPrimary font-mono flex-1 truncate">
                          {name}
                        </span>
                        <div className="i-ph:arrow-right text-[11px] text-bolt-elements-textTertiary shrink-0" aria-hidden />
                      </button>
                    ))}
                  </div>
                )}

                {phase.contentMatches.length > 0 && (
                  <div className="py-1 border-t border-bolt-elements-borderColor/60">
                    <div className="px-3 pt-1.5 pb-1 text-[9px] uppercase tracking-wider text-bolt-elements-item-contentAccent/80 flex items-center gap-1">
                      <div className="i-ph:magnifying-glass text-bolt-elements-item-contentAccent" aria-hidden /> In content
                    </div>
                    {phase.contentMatches.map((m, i) => (
                      <button
                        key={`content-${m.table}-${m.column}-${m.rowid}-${i}`}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onOpen(m.table)}
                        data-testid="sitedb-search-content-row"
                        className="group w-full flex flex-col gap-0.5 px-3 py-1.5 text-left border-l-2 border-[#00e5ff66] hover:border-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-backgroundAccent/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                      >
                        <span className="flex items-center gap-1.5 text-[11px] text-bolt-elements-item-contentAccent font-mono">
                          <span aria-hidden>🔎</span>
                          <span className="truncate">{m.table}</span>
                          <span className="text-bolt-elements-textTertiary">·</span>
                          <span className="text-bolt-elements-textSecondary truncate">{m.column}</span>
                        </span>
                        <span className="text-[10px] font-mono text-bolt-elements-textTertiary leading-snug line-clamp-2 break-words">
                          {highlightSnippet(m.snippet, phase.q)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {phase.truncated && (
                  <div className="px-3 py-1.5 text-[9px] text-bolt-elements-textTertiary/80 border-t border-bolt-elements-borderColor/60 flex items-center gap-1">
                    <div className="i-ph:dots-three-outline text-bolt-elements-textTertiary/70" aria-hidden />
                    Showing the first matches — refine your search to narrow it down.
                  </div>
                )}
              </>
            ))}
        </div>
      )}
    </div>
  );
});

TableSearch.displayName = 'SiteTablesPanel.TableSearch';

// ── Table list view ────────────────────────────────────────────────────────

const TableListView = memo(
  ({
    state,
    onOpen,
    onRetry,
    onComingSoon,
    onCreateTable,
    onNewTableSql,
    onDropTable,
    onSeedWithAi,
    onLoadSample,
    onImportCsv,
    quickFill,
  }: {
    state: TablesState;
    onOpen: (name: string) => void;
    onRetry: () => void;
    onComingSoon: (label: string) => void;
    onCreateTable?: () => void;
    onNewTableSql?: () => void;
    onDropTable: (name: string) => void;
    onSeedWithAi: () => void;
    onLoadSample: () => void;
    onImportCsv?: () => void;
    quickFill: null | 'sample' | 'seed';
  }) => {
    if (state.status === 'loading') {
      return <TableListSkeleton />;
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

    // ready → gorgeous empty launchpad OR the table list
    if (state.tables.length === 0) {
      return (
        <EmptyLaunchpad
          onSeedWithAi={onSeedWithAi}
          onLoadSample={onLoadSample}
          onCreateTable={() =>
            onCreateTable ? onCreateTable() : onNewTableSql ? onNewTableSql() : onComingSoon('New table')
          }
          onImportCsv={() => (onImportCsv ? onImportCsv() : onComingSoon('Import CSV'))}
          quickFill={quickFill}
        />
      );
    }

    return (
      <div className="flex-1 overflow-auto modern-scrollbar" data-testid="sitedb-table-list">
        {/* Toolbar: table count + the expanding advanced search (Use AI / Create Table now live in the header Actions menu). */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor sticky top-0 bg-bolt-elements-background-depth-1 z-10">
          <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
            Tables ({state.tables.length})
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <TableSearch onOpen={onOpen} />
          </div>
        </div>
        {state.tables.map((t) => (
          // Row = open-button + drop-button SIBLINGS in a group (never a button inside a button —
          // that breaks HTML + UnoCSS masked icons per god-tier-engineering).
          <div
            key={t.name}
            data-testid="sitedb-table-row"
            className="group/row w-full min-h-[24px] flex items-center gap-2 pl-3 pr-1.5 text-xs hover:bg-bolt-elements-item-backgroundActive transition-colors"
          >
            <button
              type="button"
              onClick={() => onOpen(t.name)}
              data-testid="sitedb-table-open"
              className="min-h-[24px] flex items-center gap-2 py-2 text-left flex-1 min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:table text-sm text-bolt-elements-textTertiary shrink-0" />
              <span className="text-bolt-elements-textPrimary font-mono flex-1 truncate">{t.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onDropTable(t.name)}
              data-testid="sitedb-table-drop"
              aria-label={`Drop table ${t.name}`}
              title="Drop table"
              className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400 transition-all shrink-0 cursor-pointer"
            >
              <div className="i-ph:trash text-[13px]" />
            </button>
            <div className="i-ph:caret-right text-bolt-elements-textTertiary shrink-0" aria-hidden />
          </div>
        ))}
      </div>
    );
  },
);

TableListView.displayName = 'SiteTablesPanel.TableListView';

// ── Schema / table-browser rail (Rev 2) ──────────────────────────────────────

/**
 * A persistent Airtable/NocoDB-style LEFT RAIL over the site's tables. It lists every table straight
 * from the ALREADY-FETCHED `PS_SITEDB_TABLES_RESPONSE` (no new endpoint, no per-table round-trip) so
 * switching tables is a single click and stays visible across the list↔browse views. Each entry shows
 * a table glyph + the name; the ACTIVE table additionally surfaces its loaded column-count + row-count
 * (from the already-loaded `PS_SITEDB_ROWS_RESPONSE`) and is highlighted (`aria-current`). Real-time by
 * construction — it re-renders whenever the parent refreshes the tables/rows via the existing bridge,
 * so there is NO manual Refresh control here (per the real-time-data mandate). Keyboard-navigable:
 * ↑/↓ move focus between entries, Enter/Space opens the focused table (arrow keys never scroll the page).
 * Brand-locked dark styling via the editor's `bolt-elements-*` tokens (black `#060610` + cyan `#00E5FF`).
 */
const SchemaRail = memo(
  ({
    tables,
    activeTable,
    activeColumnCount,
    activeRowCount,
    onOpen,
  }: {
    tables: { name: string }[];
    activeTable: string | null;
    activeColumnCount: number | null;
    activeRowCount: number | null;
    onOpen: (name: string) => void;
  }) => {
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    /** ↑/↓ move focus between rail entries; Enter/Space opens the focused one. */
    const onKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          const next = (index + dir + tables.length) % tables.length;
          itemRefs.current[next]?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(tables[index].name);
        }
      },
      [tables, onOpen],
    );

    return (
      <nav
        aria-label="Tables"
        data-testid="sitedb-rail"
        className="w-52 shrink-0 flex flex-col min-h-0 border-r border-bolt-elements-borderColor bg-bolt-elements-background-depth-2"
      >
        <div className="px-3 py-2 border-b border-bolt-elements-borderColor sticky top-0 bg-bolt-elements-background-depth-2 z-10">
          <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
            Tables ({tables.length})
          </span>
        </div>
        <div className="flex-1 overflow-auto modern-scrollbar py-1">
          {tables.map((t, i) => {
            const active = t.name === activeTable;
            return (
              <button
                key={t.name}
                ref={(el) => (itemRefs.current[i] = el)}
                type="button"
                data-testid="sitedb-rail-item"
                aria-current={active ? 'true' : undefined}
                onClick={() => onOpen(t.name)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={classNames(
                  'group/rail w-full min-h-[28px] flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                  active
                    ? 'bg-bolt-elements-item-backgroundActive border-l-2 border-[color:var(--ps-accent,#00e5ff)] pl-[10px] text-bolt-elements-item-contentAccent'
                    : 'border-l-2 border-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-textPrimary',
                )}
              >
                <div
                  className={classNames(
                    'i-ph:table text-sm shrink-0',
                    active ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
                  )}
                  aria-hidden
                />
                <span className="font-mono flex-1 truncate">{t.name}</span>
                {active && activeColumnCount !== null && (
                  <span
                    data-testid="sitedb-rail-active-meta"
                    className="shrink-0 text-[10px] font-mono text-bolt-elements-textTertiary tabular-nums"
                    title={`${activeColumnCount} columns · ${activeRowCount ?? 0} rows`}
                  >
                    {activeColumnCount}c
                    {activeRowCount !== null ? ` · ${activeRowCount}r` : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
    );
  },
);

SchemaRail.displayName = 'SiteTablesPanel.SchemaRail';

// ── Shared edit-engine prop bundle ──────────────────────────────────────────

interface EditProps {
  editableColumn: (col: string) => { editable: boolean; reason?: string };
  editing: { pkKey: string; column: string } | null;
  editKind: CellInputKind;
  editValue: string;
  editError: string;
  editBusy: boolean;
  pkCols: string[];
  /** Revision 3 — the active single-column multi-cell selection (fill-down / bulk edit), or null. */
  cellSel: { column: string; anchorKey: string | null; keys: Set<string> } | null;
  onStartEdit: (row: Record<string, unknown>, col: ColumnInfo) => void;
  /** Range/toggle-select one cell (shift = extend run, meta/ctrl = toggle) — powers fill-down + bulk edit. */
  onCellSelect: (row: Record<string, unknown>, column: string, mods: { shift: boolean; meta: boolean }) => void;
  onEditKindChange: (kind: CellInputKind) => void;
  onEditValueChange: (value: string) => void;
  onEditSave: (row: Record<string, unknown>, col: ColumnInfo) => void;
  onEditCancel: () => void;
}

// ── Typed cell render (checkbox / stars / chips / link / text) ───────────────

const RatingStars = memo(({ value }: { value: unknown }) => {
  const n = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));

  return (
    <span className="text-[#f5c451] tracking-tight" aria-label={`${n} of 5`} title={`${n} / 5`}>
      {'★'.repeat(n)}
      <span className="text-bolt-elements-textTertiary/40">{'★'.repeat(5 - n)}</span>
    </span>
  );
});

RatingStars.displayName = 'SiteTablesPanel.RatingStars';

const SelectChips = memo(({ value }: { value: unknown }) => {
  const label = fieldTypeFor('multiSelect').format(value);
  const items = label ? label.split(', ').filter(Boolean) : [];

  if (items.length === 0) {
    return <span className="text-bolt-elements-textTertiary/60">—</span>;
  }

  return (
    <span className="flex flex-wrap gap-1 items-center">
      {items.map((it, i) => (
        <span
          key={`${it}-${i}`}
          className="inline-flex items-center rounded-full px-1.5 py-px text-[10px] bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent border border-[#00e5ff40]"
        >
          {it}
        </span>
      ))}
    </span>
  );
});

SelectChips.displayName = 'SiteTablesPanel.SelectChips';

/** Render a single cell's VALUE by its inferred field kind (checkbox / stars / chips / classified). */
function CellValue({
  value,
  fieldKind,
  editable,
  onToggle,
}: {
  value: unknown;
  fieldKind: FieldKind;
  editable: boolean;
  onToggle?: () => void;
}) {
  if (fieldKind === 'boolean') {
    const on = value === 1 || value === true || value === '1' || value === 'true';

    return (
      <span
        role={editable ? 'checkbox' : undefined}
        aria-checked={editable ? on : undefined}
        aria-label={editable ? 'Toggle value' : undefined}
        tabIndex={editable ? 0 : undefined}
        data-testid="sitedb-cell-checkbox"
        onClick={
          editable
            ? (e) => {
                e.stopPropagation();
                onToggle?.();
              }
            : undefined
        }
        onKeyDown={
          editable
            ? (e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle?.();
                }
              }
            : undefined
        }
        className={classNames(
          'inline-flex items-center justify-center h-4 w-4 rounded border transition-colors',
          on
            ? 'bg-[#00e5ffcc] border-bolt-elements-item-contentAccent text-[#061018]'
            : 'border-bolt-elements-borderColor text-transparent',
          editable ? 'cursor-pointer hover:border-bolt-elements-item-contentAccent' : '',
        )}
      >
        <div className="i-ph:check text-[10px]" />
      </span>
    );
  }

  if (fieldKind === 'rating') {
    return value === null || value === undefined || value === '' ? (
      <span className="text-bolt-elements-textTertiary/60">—</span>
    ) : (
      <RatingStars value={value} />
    );
  }

  if (fieldKind === 'multiSelect') {
    return <SelectChips value={value} />;
  }

  const classified = classifyCell(value);

  if (classified.href) {
    return (
      <a
        href={classified.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="truncate text-bolt-elements-item-contentAccent hover:underline"
        title={classified.title ?? classified.display}
      >
        {classified.display}
      </a>
    );
  }

  return (
    <span className={classNames('truncate', classified.className)} title={classified.title}>
      {classified.kind === 'null' ? '—' : classified.display}
    </span>
  );
}

// ── Browse view ──────────────────────────────────────────────────────────────

interface BrowseViewProps extends EditProps {
  table: string;
  state: RowsState;
  allColumns: ColumnInfo[];
  shownColumns: ColumnInfo[];
  shownNames: string[];
  orderedNames: string[];
  hiddenCols: string[];
  pageRows: Record<string, unknown>[];
  filteredCount: number;
  loadedTotal: number;
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  density: GridDensity;
  rowHeight: number;
  viewMode: ViewMode;
  sorts: GridSort[];
  sortFor: (col: string) => { dir: 'asc' | 'desc'; priority: number } | null;
  search: string;
  conditions: FilterCondition[];
  combinator: 'AND' | 'OR';
  filterBarOpen: boolean;
  colMenuOpen: boolean;
  selectedRowKeys: Set<string>;
  selectedOnPage: number;
  canMutateRows: boolean;
  bulkBusy: boolean;
  /** Revision 3 — a fill-down / bulk batch write is in flight (disables the Fill-down button). */
  fillBusy: boolean;
  addingRow: boolean;
  addColOpen: boolean;
  aiPanel: null | 'filter' | 'column' | 'fill';
  aiBusy: null | 'filter' | 'column' | 'fill';
  aiError: string;
  generatedCols: Set<string>;
  onBack: () => void;
  onSetSearch: (s: string) => void;
  onSortColumn: (col: string) => void;
  onSetPageSize: (n: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onToggleFilterBar: () => void;
  onToggleColMenu: () => void;
  onToggleHidden: (col: string) => void;
  onMoveColumn: (col: string, dir: -1 | 1) => void;
  onSetDensity: (d: GridDensity) => void;
  onSetViewMode: (v: ViewMode) => void;
  /** Rev 10 — the kanban group-by column (null → auto-pick); only used by the kanban view. */
  groupField: string | null;
  onSetGroupField: (col: string | null) => void;
  /** The calendar date column (null → auto-detect the first strict-ISO date column); only used by the calendar view. */
  dateField: string | null;
  onSetDateField: (col: string | null) => void;
  onAddCondition: () => void;
  onRemoveCondition: (i: number) => void;
  onUpdateCondition: (i: number, patch: Partial<FilterCondition>) => void;
  onSetCombinator: (c: 'AND' | 'OR') => void;
  onClearFilters: () => void;
  onRowClick: (row: Record<string, unknown>) => void;
  onToggleBoolean: (row: Record<string, unknown>, col: ColumnInfo) => void;
  onToggleRowSelected: (key: string) => void;
  onToggleSelectAll: () => void;
  onDeleteRow: (row: Record<string, unknown>) => void;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
  /** Revision 3 — fill the active column selection with its top value (Cmd/Ctrl+D). */
  onFillDown: () => void;
  /** Revision 3 — clear the active multi-cell selection. */
  onClearCellSel: () => void;
  onAddRow: () => void;
  onOpenAddCol: () => void;
  onCloseAddCol: () => void;
  onAddColumn: (name: string, kind: FieldKind) => Promise<{ ok: boolean; error?: string }>;
  onDropColumn: (col: string) => void;
  onRenameColumn: (from: string, to: string) => Promise<{ ok: boolean; error?: string }>;
  onExport: (format: 'csv' | 'tsv' | 'json') => void;
  onOpenAi: (which: 'filter' | 'column' | 'fill') => void;
  onCloseAi: () => void;
  onAiFilter: (question: string) => void;
  onAiGenerateColumn: (description: string) => void;
  onAiFillColumn: (column: string, instruction: string) => void;
  onSeedWithAi: () => void;
  onRetry: () => void;
}

const BrowseView = memo((props: BrowseViewProps) => {
  const {
    table,
    state,
    shownColumns,
    pageRows,
    filteredCount,
    loadedTotal,
    pageIndex,
    pageCount,
    pageSize,
    density,
    rowHeight,
    viewMode,
    sortFor,
    search,
    conditions,
    combinator,
    filterBarOpen,
    colMenuOpen,
    selectedRowKeys,
    selectedOnPage,
    canMutateRows,
    bulkBusy,
    fillBusy,
    addingRow,
    addColOpen,
    allColumns,
    shownNames,
    hiddenCols,
    aiPanel,
    aiBusy,
    aiError,
    pkCols,
    generatedCols,
    onBack,
    onSetSearch,
    onSortColumn,
    onSetPageSize,
    onPrevPage,
    onNextPage,
    onToggleFilterBar,
    onToggleColMenu,
    onToggleHidden,
    onMoveColumn,
    onSetDensity,
    onSetViewMode,
    groupField,
    onSetGroupField,
    dateField,
    onSetDateField,
    onAddCondition,
    onRemoveCondition,
    onUpdateCondition,
    onSetCombinator,
    onClearFilters,
    onRowClick,
    onToggleBoolean,
    onToggleRowSelected,
    onToggleSelectAll,
    onDeleteRow,
    onDeleteSelected,
    onClearSelection,
    onFillDown,
    onClearCellSel,
    onAddRow,
    onOpenAddCol,
    onCloseAddCol,
    onAddColumn,
    onDropColumn,
    onRenameColumn,
    onExport,
    onOpenAi,
    onCloseAi,
    onAiFilter,
    onAiGenerateColumn,
    onAiFillColumn,
    onRetry,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeFilters = conditions.filter((c) => filterIsActive(c.col, c.op, c.val)).length;

  /**
   * Insights strip — a per-column profile (type · null% · distinct) computed from the ALREADY-LOADED
   * page rows (no new endpoint). Off by default so it never clutters the grid; toggled by the "Insights"
   * chip. Recomputed only when the visible columns or the loaded page change. Every stat is scoped to the
   * loaded rows and LABELLED as such — never implying whole-table numbers.
   */
  const [showInsights, setShowInsights] = useState(false);
  const insights = useMemo<TableInsights>(
    () => computeTableInsights(pageRows, shownColumns),
    [pageRows, shownColumns],
  );

  /**
   * The kanban group-by column actually used: the owner's pick when it's still a visible column, else the
   * auto-pick (first low-cardinality text/enum column) from the current page. Drives both the group-by
   * <select> value and the board lanes so the picker and the board never disagree.
   */
  const effectiveGroupField =
    groupField && shownNames.includes(groupField) ? groupField : defaultKanbanGroupField(shownNames, pageRows);

  /**
   * The date column driving the calendar: the owner's pick when it's a real column, else auto-detect the
   * first strict-ISO date column on the page (via {@link calendarDateField} → {@link isoDayKey}, so a
   * numeric id is never mistaken for a date). Null when NO column holds an unambiguous date — the Calendar
   * toggle is then disabled-with-reason, never a dead/blank view.
   */
  const effectiveDateField = calendarDateField(shownNames, pageRows, dateField);
  const hasDateColumn = effectiveDateField !== null;

  const rowVirtualizer = useVirtualizer({
    count: pageRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Reset scroll to the top whenever the page/table changes.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [pageIndex, table]);

  const allPageSelected =
    pageRows.length > 0 &&
    pageRows.every((r) => {
      const k = rowPkKey(r, pkCols);
      return k !== null && selectedRowKeys.has(k);
    });

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="sitedb-browse">
      {/* ── Breadcrumb row ── */}
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
        {/* Kanban group-by picker (only in kanban view) — lets the owner regroup by any column. */}
        {viewMode === 'kanban' && shownNames.length > 0 && (
          <label className="flex items-center gap-1 shrink-0 text-[11px] text-bolt-elements-textTertiary">
            <span className="i-ph:columns-plus-left" aria-hidden />
            <span className="sr-only">Group by column</span>
            <select
              value={effectiveGroupField ?? ''}
              onChange={(e) => onSetGroupField(e.target.value || null)}
              data-testid="sitedb-kanban-groupby"
              aria-label="Group kanban by column"
              className="min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none focus:border-[#00e5ff80] focus:ring-1 focus:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              {shownNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* Calendar date-column picker (only in calendar view) — lets the owner pick which date drives the grid. */}
        {viewMode === 'calendar' && hasDateColumn && (
          <label className="flex items-center gap-1 shrink-0 text-[11px] text-bolt-elements-textTertiary">
            <span className="i-ph:calendar-blank" aria-hidden />
            <span className="sr-only">Calendar date column</span>
            <select
              value={effectiveDateField ?? ''}
              onChange={(e) => onSetDateField(e.target.value || null)}
              data-testid="sitedb-calendar-datecol"
              aria-label="Calendar date column"
              className="min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none focus:border-[#00e5ff80] focus:ring-1 focus:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              {shownNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* View toggle: Grid | Gallery | Kanban | Calendar */}
        <div className="flex items-center rounded-md border border-bolt-elements-borderColor overflow-hidden shrink-0" role="group" aria-label="View mode">
          {(['grid', 'gallery', 'kanban', 'calendar'] as const).map((v) => {
            // Calendar needs a strict-ISO date column — disable (with reason) rather than ship a doomed view.
            const disabled = v === 'calendar' && !hasDateColumn;
            const icon =
              v === 'grid'
                ? 'i-ph:table'
                : v === 'gallery'
                  ? 'i-ph:squares-four'
                  : v === 'kanban'
                    ? 'i-ph:kanban'
                    : 'i-ph:calendar-dots';
            const title = disabled
              ? 'Calendar needs a date column (no date column in this table)'
              : v === 'grid'
                ? 'Grid view'
                : v === 'gallery'
                  ? 'Gallery view'
                  : v === 'kanban'
                    ? 'Kanban board'
                    : 'Calendar view';

            return (
              <button
                key={v}
                type="button"
                onClick={() => onSetViewMode(v)}
                disabled={disabled}
                data-testid={`sitedb-view-${v}`}
                aria-pressed={viewMode === v}
                title={title}
                className={classNames(
                  'min-h-[24px] px-2 py-1 text-[11px] flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                  disabled
                    ? 'text-bolt-elements-textTertiary/40 cursor-not-allowed'
                    : 'cursor-pointer',
                  !disabled && viewMode === v
                    ? 'bg-bolt-elements-item-backgroundAccent/20 text-bolt-elements-item-contentAccent'
                    : !disabled
                      ? 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary'
                      : '',
                )}
              >
                <div className={icon} />
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Toolbar row: search · filter · columns · density · AI · export · add ── */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0 bg-bolt-elements-background-depth-1/80 backdrop-blur-sm">
        {/* Search */}
        <div className="relative">
          <div className="i-ph:magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-bolt-elements-textTertiary pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSetSearch(e.target.value)}
            placeholder="Search rows…"
            data-testid="sitedb-search"
            aria-label="Search rows"
            className="min-h-[24px] w-[150px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 pl-6 pr-2 py-1 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-[#00e5ff80] focus:ring-1 focus:ring-bolt-elements-item-contentAccent transition-colors motion-reduce:transition-none"
          />
        </div>

        {/* Filter toggle */}
        <ToolbarButton
          testId="sitedb-filter-toggle"
          icon="i-ph:funnel"
          label="Filter"
          active={filterBarOpen || activeFilters > 0}
          badge={activeFilters > 0 ? String(activeFilters) : undefined}
          onClick={onToggleFilterBar}
        />

        {/* Columns menu */}
        <div className="relative">
          <ToolbarButton
            testId="sitedb-columns-toggle"
            icon="i-ph:columns"
            label="Columns"
            active={colMenuOpen || hiddenCols.length > 0}
            badge={hiddenCols.length > 0 ? `${shownNames.length}/${allColumns.length}` : undefined}
            onClick={onToggleColMenu}
          />
          {colMenuOpen && (
            <ColumnsMenu
              columns={allColumns}
              shownNames={shownNames}
              onToggleHidden={onToggleHidden}
              onMoveColumn={onMoveColumn}
              onClose={onToggleColMenu}
            />
          )}
        </div>

        {/* Density */}
        <div className="flex items-center rounded-md border border-bolt-elements-borderColor overflow-hidden" role="group" aria-label="Row density">
          {(['compact', 'cozy', 'comfortable'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onSetDensity(d)}
              data-testid={`sitedb-density-${d}`}
              aria-pressed={density === d}
              title={`${d[0].toUpperCase()}${d.slice(1)} rows`}
              className={classNames(
                'min-h-[24px] px-1.5 py-1 text-[11px] flex items-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                density === d
                  ? 'bg-bolt-elements-item-backgroundAccent/20 text-bolt-elements-item-contentAccent'
                  : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
              )}
            >
              <div className={d === 'compact' ? 'i-ph:rows' : d === 'cozy' ? 'i-ph:list' : 'i-ph:list-plus'} />
            </button>
          ))}
        </div>

        {/* Insights toggle — reveals a per-column profile computed from the LOADED rows (no round-trip). */}
        <ToolbarButton
          testId="sitedb-insights-toggle"
          icon="i-ph:chart-bar"
          label="Insights"
          active={showInsights}
          onClick={() => setShowInsights((v) => !v)}
        />

        <div className="w-px h-4 bg-bolt-elements-borderColor mx-0.5" aria-hidden />

        {/* AI actions */}
        <ToolbarButton testId="sitedb-ai-filter" icon="i-ph:sparkle" label="AI filter" accent onClick={() => onOpenAi('filter')} />
        <ToolbarButton testId="sitedb-ai-column" icon="i-ph:magic-wand" label="AI column" accent onClick={() => onOpenAi('column')} />
        {selectedRowKeys.size > 0 && (
          <ToolbarButton testId="sitedb-ai-fill" icon="i-ph:pen-nib" label="AI fill" accent onClick={() => onOpenAi('fill')} />
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {/* Export menu */}
          {pageRows.length > 0 && (
            <ExportMenu onExport={onExport} />
          )}
          {/* Add column */}
          {canMutateRows && (
            <ToolbarButton testId="sitedb-add-column" icon="i-ph:plus-circle" label="Column" onClick={onOpenAddCol} />
          )}
          {/* Add row */}
          {canMutateRows && (
            <button
              type="button"
              onClick={onAddRow}
              disabled={addingRow}
              data-testid="sitedb-add-row"
              title="Add a new row"
              className="min-h-[24px] text-[11px] font-semibold px-2 py-1 rounded border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-item-backgroundAccent/20 disabled:opacity-50 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className={addingRow ? 'i-ph:circle-notch animate-spin' : 'i-ph:plus'} />
              <span className="min-w-[6ch] text-center">{addingRow ? 'Adding…' : 'New row'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Insights strip — per-column profile over the LOADED rows (toggled; honest-empty at 0 rows). */}
      {showInsights && <InsightsStrip insights={insights} />}

      {/* Filter bar */}
      {filterBarOpen && (
        <FilterBar
          columns={allColumns}
          conditions={conditions}
          combinator={combinator}
          onAddCondition={onAddCondition}
          onRemoveCondition={onRemoveCondition}
          onUpdateCondition={onUpdateCondition}
          onSetCombinator={onSetCombinator}
          onClear={onClearFilters}
        />
      )}

      {/* Bulk-select action bar */}
      {selectedRowKeys.size > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor bg-bolt-elements-item-backgroundAccent/10 text-[11px] shrink-0"
          data-testid="sitedb-bulk-bar"
          role="status"
        >
          <span className="text-bolt-elements-item-contentAccent font-medium">
            {selectedRowKeys.size} selected
          </span>
          <button
            type="button"
            onClick={onDeleteSelected}
            disabled={bulkBusy}
            data-testid="sitedb-bulk-delete"
            className="min-h-[24px] text-[11px] font-semibold px-2 py-0.5 rounded border border-red-400/50 bg-red-400/10 text-red-300 enabled:hover:bg-red-400/20 disabled:opacity-50 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer"
          >
            <div className={bulkBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:trash'} /> Delete
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className="ml-auto text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* AI panel */}
      {aiPanel && (
        <AiPanel
          mode={aiPanel}
          busy={aiBusy}
          error={aiError}
          columns={allColumns.filter((c) => !generatedCols.has(c.name) && !pkCols.includes(c.name))}
          selectedCount={selectedRowKeys.size}
          onClose={onCloseAi}
          onFilter={onAiFilter}
          onGenerateColumn={onAiGenerateColumn}
          onFillColumn={onAiFillColumn}
        />
      )}

      {/* Add-column dialog */}
      {addColOpen && <AddColumnForm onAdd={onAddColumn} onClose={onCloseAddCol} />}

      {state.status === 'loading' && <Spinner label={`Loading "${table}"…`} />}
      {state.status === 'error' && <ErrorCard message={state.message} onRetry={onRetry} />}

      {state.status === 'ready' && (
        <>
          {filteredCount === 0 ? (
            <div
              className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"
              data-testid="sitedb-table-empty"
            >
              <div className="i-ph:tray text-3xl text-bolt-elements-textTertiary" />
              <p className="text-xs text-bolt-elements-textSecondary">
                {search || activeFilters > 0 ? (
                  <>No rows match your filter.</>
                ) : (
                  <>
                    <span className="font-mono text-bolt-elements-textPrimary">{table}</span> has no rows yet
                  </>
                )}
              </p>
              {search || activeFilters > 0 ? (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="min-h-[24px] text-[11px] text-bolt-elements-item-contentAccent hover:underline cursor-pointer"
                >
                  Clear filters
                </button>
              ) : (
                canMutateRows && (
                  <button
                    type="button"
                    onClick={onAddRow}
                    className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-backgroundAccent/20 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <div className="i-ph:plus" /> Add the first row
                  </button>
                )
              )}
            </div>
          ) : viewMode === 'gallery' ? (
            <GalleryView
              columns={shownColumns}
              rows={pageRows}
              onRowClick={onRowClick}
            />
          ) : viewMode === 'kanban' ? (
            <KanbanView
              columns={shownColumns}
              rows={pageRows}
              groupField={effectiveGroupField}
              onRowClick={onRowClick}
            />
          ) : viewMode === 'calendar' && effectiveDateField ? (
            <CalendarView
              columns={shownColumns}
              rows={pageRows}
              dateField={effectiveDateField}
              onRowClick={onRowClick}
            />
          ) : (
            <div
              ref={scrollRef}
              className="flex-1 overflow-auto modern-scrollbar min-h-0"
              data-testid="sitedb-grid"
              onKeyDown={(e) => {
                // Cmd/Ctrl+D fills the active column selection down (Airtable's fill-down shortcut).
                if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
                  if (props.cellSel && props.cellSel.keys.size > 1) {
                    e.preventDefault();
                    onFillDown();
                  }

                  return;
                }

                // Escape clears an active multi-cell selection.
                if (e.key === 'Escape' && props.cellSel) {
                  onClearCellSel();
                }
              }}
            >
              {/* Sticky header (frozen select + first column) — cyan under-hairline reads as a live typed header */}
              <div
                className="sticky top-0 z-20 flex bg-bolt-elements-background-depth-2 border-b border-bolt-elements-borderColor shadow-[0_1px_0_rgba(0,229,255,0.18)]"
                role="row"
              >
                {canMutateRows && (
                  <div
                    className={classNames(
                      'sticky left-0 z-30 shrink-0 w-[36px] flex items-center justify-center border-r border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2',
                      densityCellClass(density),
                    )}
                    role="columnheader"
                  >
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={onToggleSelectAll}
                      aria-label="Select all rows on this page"
                      data-testid="sitedb-select-all"
                      className="h-3 w-3 accent-[color:var(--ps-accent)] cursor-pointer"
                    />
                  </div>
                )}
                {shownColumns.map((col, idx) => {
                  const gate = props.editableColumn(col.name);
                  const s = sortFor(col.name);
                  const frozen = idx === 0;

                  return (
                    <div
                      key={col.name}
                      role="columnheader"
                      onClick={() => onSortColumn(col.name)}
                      title={
                        gate.editable
                          ? `${col.name} · ${col.type || 'ANY'} · click to sort`
                          : `${col.name} · ${gate.reason ?? ''}`
                      }
                      style={{ width: COL_WIDTH, left: frozen && canMutateRows ? 36 : undefined }}
                      className={classNames(
                        'group/hdr shrink-0 text-[10px] uppercase tracking-wider font-medium truncate border-r border-bolt-elements-borderColor/40 flex items-center gap-1 cursor-pointer select-none transition-colors',
                        densityCellClass(density),
                        s
                          ? 'text-bolt-elements-item-contentAccent bg-bolt-elements-item-backgroundAccent/[0.07]'
                          : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3/40',
                        frozen
                          ? 'sticky z-30 bg-bolt-elements-background-depth-2 shadow-[6px_0_10px_-8px_rgba(0,0,0,0.7)]'
                          : '',
                      )}
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
                      {/* Sort caret: active shows dir (+ priority pill for multi-sort); idle reveals a faint hint on hover. */}
                      {s ? (
                        <span
                          className="ml-auto flex items-center gap-0.5 text-bolt-elements-item-contentAccent shrink-0"
                          data-testid={`sitedb-sort-${col.name}`}
                        >
                          <div className={s.dir === 'asc' ? 'i-ph:caret-up text-[10px]' : 'i-ph:caret-down text-[10px]'} />
                          {props.sorts.length > 1 && (
                            <span className="inline-flex items-center justify-center h-3 min-w-3 px-0.5 rounded-full bg-[color:var(--ps-accent-secondary)]/30 text-[color:var(--ps-accent-secondary)] text-[8px] font-semibold leading-none ring-1 ring-[color:var(--ps-accent-secondary)]/40">
                              {s.priority}
                            </span>
                          )}
                        </span>
                      ) : (
                        <div className="i-ph:arrows-down-up ml-auto text-[9px] text-bolt-elements-textTertiary/0 group-hover/hdr:text-bolt-elements-textTertiary/50 shrink-0 transition-colors" />
                      )}
                      {canMutateRows && (
                        <ColumnHeaderMenu
                          column={col}
                          onRename={onRenameColumn}
                          onDrop={onDropColumn}
                        />
                      )}
                    </div>
                  );
                })}
                {/* Trailing add-column affordance — a discoverable "+" cell at the end of the header row. */}
                {canMutateRows && (
                  <button
                    type="button"
                    onClick={onOpenAddCol}
                    aria-label="Add a column"
                    title="Add a column"
                    data-testid="sitedb-add-column-header"
                    className={classNames(
                      'group/addcol shrink-0 w-[44px] flex items-center justify-center border-r border-bolt-elements-borderColor/40 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-backgroundAccent/[0.07] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent',
                      densityCellClass(density),
                    )}
                  >
                    <div className="i-ph:plus text-[12px]" />
                  </button>
                )}
              </div>

              {/* Virtualized body */}
              <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                {rowVirtualizer.getVirtualItems().map((vItem) => {
                  const row = pageRows[vItem.index];

                  return (
                    <GridRow
                      key={vItem.key}
                      row={row}
                      columns={shownColumns}
                      density={density}
                      top={vItem.start}
                      height={vItem.size}
                      canMutateRows={canMutateRows}
                      selected={(() => {
                        const k = rowPkKey(row, pkCols);
                        return k !== null && selectedRowKeys.has(k);
                      })()}
                      onToggleSelect={() => {
                        const k = rowPkKey(row, pkCols);

                        if (k !== null) {
                          onToggleRowSelected(k);
                        }
                      }}
                      onDeleteRow={() => onDeleteRow(row)}
                      onRowClick={onRowClick}
                      onToggleBoolean={onToggleBoolean}
                      editableColumn={props.editableColumn}
                      editing={props.editing}
                      editKind={props.editKind}
                      editValue={props.editValue}
                      editError={props.editError}
                      editBusy={props.editBusy}
                      pkCols={pkCols}
                      cellSel={props.cellSel}
                      onStartEdit={props.onStartEdit}
                      onCellSelect={props.onCellSelect}
                      onEditKindChange={props.onEditKindChange}
                      onEditValueChange={props.onEditValueChange}
                      onEditSave={props.onEditSave}
                      onEditCancel={props.onEditCancel}
                    />
                  );
                })}
              </div>

              {/* Fill-down bar — floats when a multi-cell column selection is active (Airtable-style). */}
              {props.cellSel && props.cellSel.keys.size > 1 && (
                <div
                  className="sticky bottom-2 z-30 mx-auto mt-2 flex w-fit items-center gap-2 rounded-full border border-[#00e5ff55] bg-bolt-elements-background-depth-2/95 px-2 py-1 shadow-[0_6px_20px_-6px_rgba(0,229,255,0.4)] backdrop-blur"
                  data-testid="sitedb-cell-select-bar"
                  role="status"
                >
                  <span className="pl-1 text-[11px] tabular-nums text-bolt-elements-textSecondary">
                    {props.cellSel.keys.size} cells · <span className="font-mono">{props.cellSel.column}</span>
                  </span>
                  <button
                    type="button"
                    onClick={onFillDown}
                    disabled={fillBusy}
                    data-testid="sitedb-fill-down"
                    title="Copy the top selected value to every selected cell below (⌘/Ctrl+D)"
                    className="inline-flex items-center gap-1 rounded-full border border-[#00e5ff66] bg-bolt-elements-item-backgroundAccent/15 px-2.5 py-1 text-[11px] font-medium text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-item-backgroundAccent/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent"
                  >
                    <div className={fillBusy ? 'i-ph:circle-notch animate-spin text-[12px]' : 'i-ph:arrow-line-down text-[12px]'} />
                    <span className="min-w-[6ch] text-center">{fillBusy ? 'Filling…' : 'Fill down'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={onClearCellSel}
                    aria-label="Clear cell selection"
                    title="Clear selection (Esc)"
                    data-testid="sitedb-cell-select-clear"
                    className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded-full text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent"
                  >
                    <div className="i-ph:x text-[11px]" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Pagination footer with page-size selector ── */}
          {filteredCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 border-t border-bolt-elements-borderColor text-[11px] text-bolt-elements-textTertiary shrink-0 tabular-nums">
              <span data-testid="sitedb-page-info">
                Showing {pageIndex * pageSize + 1} to {Math.min((pageIndex + 1) * pageSize, filteredCount)} of{' '}
                {filteredCount}
                {filteredCount !== loadedTotal && <span className="text-bolt-elements-textTertiary/60"> (filtered from {loadedTotal})</span>}
              </span>

              <label className="ml-3 flex items-center gap-1">
                <span className="sr-only">Rows per page</span>
                <select
                  value={pageSize}
                  onChange={(e) => onSetPageSize(Number(e.target.value))}
                  data-testid="sitedb-page-size"
                  aria-label="Rows per page"
                  className="min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={n} value={n}>
                      {n} / page
                    </option>
                  ))}
                </select>
              </label>

              <div className="ml-auto flex items-center gap-1">
                <span className="text-bolt-elements-textTertiary/70" data-testid="sitedb-page-count">
                  Page {pageIndex + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  onClick={onPrevPage}
                  disabled={pageIndex <= 0}
                  aria-label="Previous page"
                  data-testid="sitedb-prev-page"
                  className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary enabled:hover:bg-bolt-elements-background-depth-3 enabled:hover:text-bolt-elements-textPrimary disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                >
                  <div className="i-ph:caret-left text-sm" />
                </button>
                <button
                  type="button"
                  onClick={onNextPage}
                  disabled={pageIndex >= pageCount - 1}
                  aria-label="Next page"
                  data-testid="sitedb-next-page"
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
});

BrowseView.displayName = 'SiteTablesPanel.BrowseView';

// ── Toolbar button ───────────────────────────────────────────────────────────

const ToolbarButton = memo(
  ({
    testId,
    icon,
    label,
    active,
    accent,
    badge,
    onClick,
  }: {
    testId: string;
    icon: string;
    label: string;
    active?: boolean;
    accent?: boolean;
    badge?: string;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      title={label}
      className={classNames(
        'min-h-[24px] text-[11px] font-medium px-2 py-1 rounded border transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
        active
          ? 'border-[#00e5ff99] bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent'
          : accent
            ? 'border-[#00e5ff66] bg-bolt-elements-item-backgroundAccent/[0.06] text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-backgroundAccent/15'
            : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
      )}
    >
      <div className={classNames(icon, 'text-[13px]')} />
      <span>{label}</span>
      {badge && (
        <span className="ml-0.5 rounded-full bg-[#00e5ff40] px-1 text-[9px] text-bolt-elements-item-contentAccent">
          {badge}
        </span>
      )}
    </button>
  ),
);

ToolbarButton.displayName = 'SiteTablesPanel.ToolbarButton';

// ── Insights strip (per-column profile over the LOADED rows) ───────────────────

/**
 * A compact, read-only profile of the currently-LOADED page rows — one line per column
 * (declared type, null/empty share, distinct count). Every stat is scoped to the loaded rows
 * and LABELLED "in loaded rows" so it never implies whole-table numbers. Honest-empty: 0 loaded
 * rows renders a plain "No rows yet" note instead of a wall of 0%/0. Purely presentational.
 */
const InsightsStrip = memo(({ insights }: { insights: TableInsights }) => {
  const { rowCount, columns } = insights;

  return (
    <div
      className="px-3 py-2 border-b border-bolt-elements-borderColor shrink-0 bg-bolt-elements-background-depth-1/60"
      data-testid="sitedb-insights-strip"
      role="region"
      aria-label="Column insights for loaded rows"
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <div className="i-ph:chart-bar text-[11px] text-bolt-elements-item-contentAccent" aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-wider text-bolt-elements-item-contentAccent">
          Insights
        </span>
        <span className="text-[10px] text-bolt-elements-textTertiary">
          {rowCount.toLocaleString()} {rowCount === 1 ? 'row' : 'rows'} in loaded page
        </span>
      </div>

      {rowCount === 0 ? (
        <p className="text-[11px] text-bolt-elements-textTertiary" data-testid="sitedb-insights-empty">
          No rows yet — insights appear once this table has data on the loaded page.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" data-testid="sitedb-insights-columns">
          {columns.map((c) => (
            <li
              key={c.name}
              className="flex items-center gap-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[10px]"
              title={`${c.name}: ${c.declaredType} · ${c.nullPercent}% empty · ${c.distinctCount} distinct (in loaded rows)`}
            >
              <span className="font-mono text-bolt-elements-textPrimary truncate max-w-[14ch]">{c.name}</span>
              <span className="font-mono text-bolt-elements-textTertiary uppercase">{c.declaredType}</span>
              <span className="text-bolt-elements-textSecondary">
                {c.nullPercent}% <span className="text-bolt-elements-textTertiary">empty</span>
              </span>
              <span className="text-bolt-elements-textSecondary">
                {c.distinctCount.toLocaleString()} <span className="text-bolt-elements-textTertiary">distinct</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

InsightsStrip.displayName = 'SiteTablesPanel.InsightsStrip';

// ── Export menu ──────────────────────────────────────────────────────────────

const ExportMenu = memo(({ onExport }: { onExport: (format: 'csv' | 'tsv' | 'json') => void }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <ToolbarButton testId="sitedb-export" icon="i-ph:download-simple" label="Export" onClick={() => setOpen((o) => !o)} />
      {open && (
        <>
          <button type="button" aria-hidden className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-1 z-40 w-40 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-xl py-1"
            data-testid="sitedb-export-menu"
            role="menu"
          >
            {(['csv', 'tsv', 'json'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="menuitem"
                onClick={() => {
                  onExport(f);
                  setOpen(false);
                }}
                data-testid={`sitedb-export-${f}`}
                className="w-full text-left px-3 py-1.5 text-[11px] text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-textPrimary flex items-center gap-2 cursor-pointer"
              >
                <div className="i-ph:file text-bolt-elements-textTertiary" /> Whole table as {f.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

ExportMenu.displayName = 'SiteTablesPanel.ExportMenu';

// ── Columns show/hide + reorder menu ────────────────────────────────────────

const ColumnsMenu = memo(
  ({
    columns,
    shownNames,
    onToggleHidden,
    onMoveColumn,
    onClose,
  }: {
    columns: ColumnInfo[];
    shownNames: string[];
    onToggleHidden: (col: string) => void;
    onMoveColumn: (col: string, dir: -1 | 1) => void;
    onClose: () => void;
  }) => {
    const shown = new Set(shownNames);

    return (
      <>
        <button type="button" aria-hidden className="fixed inset-0 z-30 cursor-default" onClick={onClose} />
        <div
          className="absolute left-0 top-full mt-1 z-40 w-56 max-h-[320px] overflow-auto modern-scrollbar rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-xl py-1"
          data-testid="sitedb-columns-menu"
          role="menu"
        >
          <p className="px-3 py-1 text-[9px] uppercase tracking-wider text-bolt-elements-textTertiary">Show / hide · reorder</p>
          {columns.map((col, i) => (
            <div
              key={col.name}
              className="flex items-center gap-1.5 px-2 py-1 hover:bg-bolt-elements-item-backgroundActive"
              data-testid="sitedb-column-menu-row"
            >
              <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shown.has(col.name)}
                  onChange={() => onToggleHidden(col.name)}
                  data-testid={`sitedb-col-toggle-${col.name}`}
                  className="h-3 w-3 accent-[color:var(--ps-accent)] cursor-pointer shrink-0"
                />
                <span className="text-[11px] font-mono text-bolt-elements-textPrimary truncate">{col.name}</span>
              </label>
              <button
                type="button"
                onClick={() => onMoveColumn(col.name, -1)}
                disabled={i === 0}
                aria-label={`Move ${col.name} left`}
                data-testid={`sitedb-col-left-${col.name}`}
                className="min-h-[20px] min-w-[20px] flex items-center justify-center rounded text-bolt-elements-textTertiary enabled:hover:text-bolt-elements-item-contentAccent disabled:opacity-30 cursor-pointer"
              >
                <div className="i-ph:arrow-up text-[11px]" />
              </button>
              <button
                type="button"
                onClick={() => onMoveColumn(col.name, 1)}
                disabled={i === columns.length - 1}
                aria-label={`Move ${col.name} right`}
                data-testid={`sitedb-col-right-${col.name}`}
                className="min-h-[20px] min-w-[20px] flex items-center justify-center rounded text-bolt-elements-textTertiary enabled:hover:text-bolt-elements-item-contentAccent disabled:opacity-30 cursor-pointer"
              >
                <div className="i-ph:arrow-down text-[11px]" />
              </button>
            </div>
          ))}
        </div>
      </>
    );
  },
);

ColumnsMenu.displayName = 'SiteTablesPanel.ColumnsMenu';

// ── Filter bar (multi-condition AND/OR group) ───────────────────────────────

const FilterBar = memo(
  ({
    columns,
    conditions,
    combinator,
    onAddCondition,
    onRemoveCondition,
    onUpdateCondition,
    onSetCombinator,
    onClear,
  }: {
    columns: ColumnInfo[];
    conditions: FilterCondition[];
    combinator: 'AND' | 'OR';
    onAddCondition: () => void;
    onRemoveCondition: (i: number) => void;
    onUpdateCondition: (i: number, patch: Partial<FilterCondition>) => void;
    onSetCombinator: (c: 'AND' | 'OR') => void;
    onClear: () => void;
  }) => (
    <div
      className="px-3 py-2 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2/60 shrink-0 space-y-1.5"
      data-testid="sitedb-filter-bar"
    >
      {conditions.length === 0 && (
        <p className="text-[11px] text-bolt-elements-textTertiary">No filters yet — add a condition to narrow the rows.</p>
      )}
      {conditions.map((c, i) => {
        const valueFree = filterOpIsValueFree(c.op);

        return (
          <div key={i} className="flex items-center gap-1.5" data-testid="sitedb-filter-condition">
            {i === 0 ? (
              <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary w-[54px] shrink-0">Where</span>
            ) : (
              <select
                value={combinator}
                onChange={(e) => onSetCombinator(e.target.value as 'AND' | 'OR')}
                aria-label="Combine conditions"
                data-testid="sitedb-filter-combinator"
                className="w-[54px] shrink-0 min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[10px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
              >
                <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" value="AND">And</option>
                <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" value="OR">Or</option>
              </select>
            )}
            <select
              value={c.col ?? ''}
              onChange={(e) => onUpdateCondition(i, { col: e.target.value || null })}
              aria-label="Filter column"
              data-testid="sitedb-filter-col"
              className="min-h-[24px] max-w-[140px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
            >
              <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" value="">column…</option>
              {columns.map((col) => (
                <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={col.name} value={col.name}>
                  {col.name}
                </option>
              ))}
            </select>
            <select
              value={c.op}
              onChange={(e) => onUpdateCondition(i, { op: e.target.value })}
              aria-label="Filter operator"
              data-testid="sitedb-filter-op"
              className="min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
            >
              {FILTER_OP_OPTIONS.map((o) => (
                <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {!valueFree && (
              <input
                type="text"
                value={c.val}
                onChange={(e) => onUpdateCondition(i, { val: e.target.value })}
                placeholder="value"
                aria-label="Filter value"
                data-testid="sitedb-filter-val"
                className="min-h-[24px] w-[120px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent"
              />
            )}
            <button
              type="button"
              onClick={() => onRemoveCondition(i)}
              aria-label="Remove condition"
              data-testid="sitedb-filter-remove"
              className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-red-300 cursor-pointer"
            >
              <div className="i-ph:x text-[11px]" />
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={onAddCondition}
          disabled={conditions.length >= MAX_FILTER_CONDITIONS}
          data-testid="sitedb-filter-add"
          className="min-h-[24px] text-[11px] font-medium px-2 py-0.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-background-depth-3 disabled:opacity-40 transition-colors flex items-center gap-1 cursor-pointer"
        >
          <div className="i-ph:plus" /> Add condition
        </button>
        {conditions.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            data-testid="sitedb-filter-clear"
            className="min-h-[24px] text-[11px] text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  ),
);

FilterBar.displayName = 'SiteTablesPanel.FilterBar';

// ── AI panel (filter / column / fill) ────────────────────────────────────────

const AiPanel = memo(
  ({
    mode,
    busy,
    error,
    columns,
    selectedCount,
    onClose,
    onFilter,
    onGenerateColumn,
    onFillColumn,
  }: {
    mode: 'filter' | 'column' | 'fill';
    busy: null | 'filter' | 'column' | 'fill';
    error: string;
    columns: ColumnInfo[];
    selectedCount: number;
    onClose: () => void;
    onFilter: (q: string) => void;
    onGenerateColumn: (d: string) => void;
    onFillColumn: (col: string, instruction: string) => void;
  }) => {
    const [text, setText] = useState('');
    const [fillCol, setFillCol] = useState(columns[0]?.name ?? '');
    const isBusy = busy === mode;

    const title = mode === 'filter' ? 'AI filter' : mode === 'column' ? 'AI generate column' : 'AI fill selected cells';
    const placeholder =
      mode === 'filter'
        ? 'e.g. orders over $100 in the last week, newest first'
        : mode === 'column'
          ? 'e.g. a "status" column: active if last_seen within 30 days'
          : 'e.g. write a friendly one-line summary from the other fields';

    const submit = () => {
      if (mode === 'filter') {
        onFilter(text);
      } else if (mode === 'column') {
        onGenerateColumn(text);
      } else {
        onFillColumn(fillCol, text);
      }
    };

    return (
      <div
        className="px-3 py-2.5 border-b border-bolt-elements-borderColor bg-bolt-elements-item-backgroundAccent/[0.06] shrink-0 space-y-1.5"
        data-testid="sitedb-ai-panel"
      >
        <div className="flex items-center gap-1.5">
          <div className="i-ph:sparkle-duotone text-bolt-elements-item-contentAccent text-sm" />
          <span className="text-[11px] font-semibold text-bolt-elements-item-contentAccent">{title}</span>
          {mode === 'fill' && (
            <span className="text-[10px] text-bolt-elements-textTertiary">· {selectedCount} row{selectedCount === 1 ? '' : 's'} selected</span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI panel"
            className="ml-auto min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            <div className="i-ph:x text-[11px]" />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {mode === 'fill' && (
            <select
              value={fillCol}
              onChange={(e) => setFillCol(e.target.value)}
              aria-label="Column to fill"
              data-testid="sitedb-ai-fill-col"
              className="min-h-[24px] max-w-[140px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
            >
              {columns.map((c) => (
                <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            aria-label={title}
            data-testid="sitedb-ai-input"
            className="flex-1 min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={isBusy}
            data-testid="sitedb-ai-submit"
            className="min-h-[24px] text-[11px] font-semibold px-2.5 py-1 rounded border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-item-backgroundAccent/25 disabled:opacity-50 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className={isBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:sparkle'} />
            <span className="min-w-[5ch] text-center">{isBusy ? 'Working…' : 'Apply'}</span>
          </button>
        </div>
        {error && (
          <p className="text-[10px] text-red-400" role="alert" data-testid="sitedb-ai-error">
            {error}
          </p>
        )}
      </div>
    );
  },
);

AiPanel.displayName = 'SiteTablesPanel.AiPanel';

// ── Per-column header menu (rename · delete) ────────────────────────────────────

/** SQLite identifier rule mirrored from schema-ddl's `SAFE_IDENT_RE` — used only for instant UI feedback. */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The hover-revealed "⋮" menu on each column header. Rename edits inline; delete is a two-step
 * click-to-confirm (mirrors the row-delete affordance, never `window.confirm`). Delete is disabled
 * for a primary-key column (SQLite can't drop it) with the reason surfaced as a tooltip.
 */
const ColumnHeaderMenu = memo(
  ({
    column,
    onRename,
    onDrop,
  }: {
    column: ColumnInfo;
    onRename: (from: string, to: string) => Promise<{ ok: boolean; error?: string }>;
    onDrop: (col: string) => void;
  }) => {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<'menu' | 'rename' | 'confirmDelete'>('menu');
    const [nextName, setNextName] = useState(column.name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const wrapRef = useRef<HTMLDivElement | null>(null);

    const isPk = column.pk === 1;

    const close = useCallback(() => {
      setOpen(false);
      setMode('menu');
      setError('');
      setNextName(column.name);
    }, [column.name]);

    useEffect(() => {
      if (!open) {
        return;
      }

      const onDoc = (e: MouseEvent) => {
        if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
          close();
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          close();
        }
      };

      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);

      return () => {
        document.removeEventListener('mousedown', onDoc);
        document.removeEventListener('keydown', onKey);
      };
    }, [open, close]);

    const trimmed = nextName.trim();
    const renameValid = trimmed.length > 0 && trimmed !== column.name && SAFE_IDENT_RE.test(trimmed);

    const submitRename = async () => {
      if (!renameValid || busy) {
        return;
      }

      setBusy(true);
      setError('');
      const res = await onRename(column.name, trimmed);
      setBusy(false);

      if (res.ok) {
        close();
      } else {
        setError(res.error || 'Could not rename the column.');
      }
    };

    return (
      <div ref={wrapRef} className="relative ml-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
            setMode('menu');
          }}
          aria-label={`Column options for ${column.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={`sitedb-col-menu-${column.name}`}
          className={classNames(
            'min-h-[20px] min-w-[20px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3/60 cursor-pointer transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent',
            open ? 'opacity-100' : 'opacity-0 group-hover/hdr:opacity-100 focus-visible:opacity-100',
          )}
        >
          <div className="i-ph:dots-three-vertical text-[12px]" />
        </button>

        {open && (
          <div
            role="menu"
            data-testid={`sitedb-col-menu-panel-${column.name}`}
            className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-xl shadow-black/40 p-1 normal-case tracking-normal font-normal"
          >
            {mode === 'menu' && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMode('rename');
                    setNextName(column.name);
                    setError('');
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 cursor-pointer"
                >
                  <div className="i-ph:pencil-simple text-[13px] text-bolt-elements-textTertiary" /> Rename column
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={isPk}
                  title={isPk ? 'The primary-key column can’t be deleted.' : undefined}
                  onClick={() => !isPk && setMode('confirmDelete')}
                  data-testid={`sitedb-col-delete-${column.name}`}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-red-300 enabled:hover:bg-red-400/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <div className="i-ph:trash text-[13px]" /> Delete column
                  {isPk && <div className="i-ph:key ml-auto text-[11px] text-bolt-elements-textTertiary" />}
                </button>
              </>
            )}

            {mode === 'rename' && (
              <div className="p-1 space-y-1.5">
                <input
                  type="text"
                  autoFocus
                  value={nextName}
                  onChange={(e) => setNextName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void submitRename();
                    }
                  }}
                  aria-label={`New name for ${column.name}`}
                  data-testid={`sitedb-col-rename-input-${column.name}`}
                  className="w-full min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[11px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent"
                />
                {trimmed.length > 0 && !SAFE_IDENT_RE.test(trimmed) && (
                  <p className="text-[10px] text-bolt-elements-textTertiary">Letters, numbers, and underscores only.</p>
                )}
                {error && (
                  <p className="text-[10px] text-red-400" role="alert">
                    {error}
                  </p>
                )}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void submitRename()}
                    disabled={!renameValid || busy}
                    data-testid={`sitedb-col-rename-save-${column.name}`}
                    className="min-h-[24px] flex-1 text-[11px] font-semibold px-2 py-1 rounded border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-item-backgroundAccent/25 disabled:opacity-50 transition-colors flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <div className={busy ? 'i-ph:circle-notch animate-spin' : 'i-ph:check'} /> Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('menu');
                      setError('');
                    }}
                    className="min-h-[24px] text-[11px] px-2 py-1 rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {mode === 'confirmDelete' && (
              <div className="p-1 space-y-1.5">
                <p className="text-[11px] text-bolt-elements-textSecondary px-1">
                  Delete <span className="font-mono text-bolt-elements-textPrimary">{column.name}</span> and all its
                  values?
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      onDrop(column.name);
                      close();
                    }}
                    data-testid={`sitedb-col-delete-confirm-${column.name}`}
                    className="min-h-[24px] flex-1 text-[11px] font-semibold px-2 py-1 rounded border border-red-400/50 bg-red-400/10 text-red-300 hover:bg-red-400/20 transition-colors flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <div className="i-ph:trash" /> Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('menu')}
                    className="min-h-[24px] text-[11px] px-2 py-1 rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
);

ColumnHeaderMenu.displayName = 'SiteTablesPanel.ColumnHeaderMenu';

// ── Add-column form ───────────────────────────────────────────────────────────

const AddColumnForm = memo(
  ({
    onAdd,
    onClose,
  }: {
    onAdd: (name: string, kind: FieldKind) => Promise<{ ok: boolean; error?: string }>;
    onClose: () => void;
  }) => {
    const [name, setName] = useState('');
    const [kind, setKind] = useState<FieldKind>('text');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const trimmed = name.trim();
    const identValid = trimmed.length > 0 && SAFE_IDENT_RE.test(trimmed);

    const submit = async () => {
      if (!identValid || busy) {
        return;
      }

      setBusy(true);
      setError('');
      const res = await onAdd(trimmed, kind);
      setBusy(false);

      if (res.ok) {
        onClose();
      } else {
        setError(res.error || 'Could not add the column.');
      }
    };

    return (
      <div
        className="px-3 py-2.5 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2/60 shrink-0 space-y-1.5"
        data-testid="sitedb-add-column-form"
      >
        <div className="flex items-center gap-1.5">
          <div className="i-ph:plus-circle text-bolt-elements-item-contentAccent text-sm" />
          <span className="text-[11px] font-semibold text-bolt-elements-textPrimary">New column</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel"
            className="ml-auto min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            <div className="i-ph:x text-[11px]" />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="column_name"
            aria-label="Column name"
            data-testid="sitedb-add-column-name"
            className="flex-1 min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[11px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as FieldKind)}
            aria-label="Column type"
            data-testid="sitedb-add-column-type"
            className="min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[11px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
          >
            {FIELD_KIND_OPTIONS.map((o) => (
              <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !identValid}
            data-testid="sitedb-add-column-submit"
            className="min-h-[24px] text-[11px] font-semibold px-2.5 py-1 rounded border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-item-backgroundAccent/25 disabled:opacity-50 transition-colors flex items-center gap-1 cursor-pointer"
          >
            <div className={busy ? 'i-ph:circle-notch animate-spin' : 'i-ph:check'} /> Add
          </button>
        </div>
        {trimmed.length > 0 && !identValid && (
          <p className="text-[10px] text-bolt-elements-textTertiary">
            Name must start with a letter or underscore — letters, numbers, and underscores only.
          </p>
        )}
        {error && (
          <p className="text-[10px] text-red-400" role="alert" data-testid="sitedb-add-column-error">
            {error}
          </p>
        )}
      </div>
    );
  },
);

AddColumnForm.displayName = 'SiteTablesPanel.AddColumnForm';

// ── Create-table modal (guided, no-SQL — name + typed columns) ───────────────

/** The three SQLite storage classes the manual builder offers (matches the `POST /db/tables` contract). */
const CREATE_COLUMN_TYPES: ReadonlyArray<SiteDbColumnSpec['type']> = ['TEXT', 'INTEGER', 'REAL'];

/** One editable column row in the create-table builder (local UI state; `type` is a raw SQLite class). */
interface DraftColumn {
  id: number;
  name: string;
  type: SiteDbColumnSpec['type'];
}

let draftColSeq = 0;
const newDraftColumn = (): DraftColumn => ({ id: ++draftColSeq, name: '', type: 'TEXT' });

/**
 * A guided, no-SQL "New table" modal: a table name + an add-as-many typed columns list (each name + a
 * TEXT/INTEGER/REAL dropdown). On submit it calls {@link SiteTablesPanel} → {@link requestDbCreateTable}
 * (the dedicated `POST /db/tables` bridge — NOT raw SQL), refetches the list on success, and surfaces a
 * verbatim server error inline. Esc closes; the first field auto-focuses; identifiers validate live so no
 * doomed submit. Style mirrors the editor's dark `#060610` + cyan `#00E5FF` tokens.
 */
const CreateTableModal = memo(
  ({
    onCreate,
    onClose,
  }: {
    onCreate: (name: string, columns: SiteDbColumnSpec[]) => Promise<{ ok: boolean; error?: string }>;
    onClose: () => void;
  }) => {
    const [tableName, setTableName] = useState('');
    const [columns, setColumns] = useState<DraftColumn[]>(() => [newDraftColumn()]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const nameInputRef = useRef<HTMLInputElement>(null);

    // Focus the table-name field on open (keyboard-first).
    useEffect(() => {
      nameInputRef.current?.focus();
    }, []);

    // Esc closes (unless a submit is in flight).
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !busy) {
          onClose();
        }
      };

      document.addEventListener('keydown', onKey);

      return () => document.removeEventListener('keydown', onKey);
    }, [busy, onClose]);

    const trimmedTable = tableName.trim();
    const tableValid = trimmedTable.length > 0 && SAFE_IDENT_RE.test(trimmedTable);
    const namedColumns = columns.filter((c) => c.name.trim().length > 0);
    const allNamedValid = namedColumns.every((c) => SAFE_IDENT_RE.test(c.name.trim()));
    // Duplicate column names (case-insensitive) would be rejected by the worker — block early.
    const lowerNames = namedColumns.map((c) => c.name.trim().toLowerCase());
    const hasDupes = new Set(lowerNames).size !== lowerNames.length;
    const canSubmit = tableValid && namedColumns.length > 0 && allNamedValid && !hasDupes && !busy;

    const updateColumn = (id: number, patch: Partial<DraftColumn>) =>
      setColumns((cur) => cur.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const addColumn = () => setColumns((cur) => [...cur, newDraftColumn()]);
    const removeColumn = (id: number) => setColumns((cur) => (cur.length > 1 ? cur.filter((c) => c.id !== id) : cur));

    const submit = async () => {
      if (!canSubmit) {
        return;
      }

      setBusy(true);
      setError('');

      const specs: SiteDbColumnSpec[] = namedColumns.map((c) => ({ name: c.name.trim(), type: c.type }));
      const res = await onCreate(trimmedTable, specs);
      setBusy(false);

      if (res.ok) {
        onClose();
      } else {
        setError(res.error || 'The table could not be created.');
      }
    };

    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Create a new table">
        <button type="button" aria-hidden className="absolute inset-0 bg-black/60 cursor-default" onClick={() => !busy && onClose()} />
        <div
          className="relative w-full max-w-[460px] max-h-full overflow-auto modern-scrollbar rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-2xl"
          data-testid="sitedb-create-table"
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-bolt-elements-borderColor">
            <div className="i-ph:blueprint-duotone text-bolt-elements-item-contentAccent text-lg" />
            <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">New table</h3>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              aria-label="Close"
              className="ml-auto min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:x text-sm" />
            </button>
          </div>

          <div className="p-4 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="sitedb-create-table-name" className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                Table name
              </label>
              <input
                id="sitedb-create-table-name"
                ref={nameInputRef}
                type="text"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="e.g. customers"
                aria-label="Table name"
                data-testid="sitedb-create-table-name-input"
                className="w-full min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1.5 text-[13px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent"
              />
              {trimmedTable.length > 0 && !tableValid && (
                <p className="text-[10px] text-bolt-elements-textTertiary">
                  Start with a letter or underscore — letters, numbers, and underscores only.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Columns</span>
              <div className="space-y-2">
                {columns.map((col) => {
                  const colTrim = col.name.trim();
                  const colInvalid = colTrim.length > 0 && !SAFE_IDENT_RE.test(colTrim);

                  return (
                    <div key={col.id} className="flex items-center gap-1.5" data-testid="sitedb-create-table-column">
                      <input
                        type="text"
                        value={col.name}
                        onChange={(e) => updateColumn(col.id, { name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void submit();
                          }
                        }}
                        placeholder="column_name"
                        aria-label="Column name"
                        data-testid="sitedb-create-table-column-name"
                        className={classNames(
                          'flex-1 min-w-0 min-h-[24px] rounded border bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent',
                          colInvalid ? 'border-red-400/60' : 'border-bolt-elements-borderColor',
                        )}
                      />
                      <select
                        value={col.type}
                        onChange={(e) => updateColumn(col.id, { type: e.target.value as SiteDbColumnSpec['type'] })}
                        aria-label="Column type"
                        data-testid="sitedb-create-table-column-type"
                        className="min-h-[24px] rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-0.5 text-[12px] text-bolt-elements-textPrimary focus:outline-none cursor-pointer"
                      >
                        {CREATE_COLUMN_TYPES.map((t) => (
                          <option className="bg-[#0e0e28] text-bolt-elements-textPrimary" key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => removeColumn(col.id)}
                        disabled={columns.length <= 1}
                        aria-label="Remove column"
                        title="Remove column"
                        className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400 transition-colors shrink-0 cursor-pointer"
                      >
                        <div className="i-ph:x text-[12px]" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={addColumn}
                data-testid="sitedb-create-table-add-column"
                className="min-h-[24px] flex items-center gap-1 text-[11px] font-medium text-bolt-elements-item-contentAccent hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent rounded px-1 cursor-pointer"
              >
                <div className="i-ph:plus text-[12px]" /> Add column
              </button>
              {hasDupes && (
                <p className="text-[10px] text-red-400" role="alert">
                  Column names must be unique.
                </p>
              )}
            </div>

            {error && (
              <p className="text-[11px] text-red-400" role="alert" data-testid="sitedb-create-table-error">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-bolt-elements-borderColor">
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="min-h-[24px] text-[12px] px-3 py-1.5 rounded border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              data-testid="sitedb-create-table-submit"
              className="min-h-[24px] text-[12px] font-semibold px-3 py-1.5 rounded border border-[#00e5ff80] bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent enabled:hover:bg-bolt-elements-item-backgroundAccent/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <div className={busy ? 'i-ph:circle-notch animate-spin' : 'i-ph:check'} />
              <span className="min-w-[9ch] text-center">{busy ? 'Creating…' : 'Create table'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  },
);

CreateTableModal.displayName = 'SiteTablesPanel.CreateTableModal';

// ── Drop-table danger confirm ────────────────────────────────────────────────

/**
 * A destructive-action confirm for dropping a table: names the table, warns the data is gone for good, and
 * requires an explicit click. Calls {@link SiteTablesPanel} → {@link requestDbDropTable} (the dedicated
 * `DELETE /db/tables/:table` bridge). Esc / Cancel dismiss; the Cancel button auto-focuses so the safe path
 * is the default. The Drop button reserves its widest label so it never resizes (per buttons-accommodate rule).
 */
const DropTableConfirm = memo(
  ({
    table,
    busy,
    onConfirm,
    onCancel,
  }: {
    table: string;
    busy: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) => {
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
      cancelRef.current?.focus();
    }, []);

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !busy) {
          onCancel();
        }
      };

      document.addEventListener('keydown', onKey);

      return () => document.removeEventListener('keydown', onKey);
    }, [busy, onCancel]);

    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`Drop table ${table}`}>
        <button type="button" aria-hidden className="absolute inset-0 bg-black/60 cursor-default" onClick={() => !busy && onCancel()} />
        <div
          className="relative w-full max-w-[380px] rounded-xl border border-red-500/40 bg-bolt-elements-background-depth-1 shadow-2xl p-4 space-y-3"
          data-testid="sitedb-drop-table-confirm"
        >
          <div className="flex items-center gap-2">
            <div className="i-ph:warning-octagon-duotone text-red-400 text-lg" />
            <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Drop this table?</h3>
          </div>
          <p className="text-[12px] text-bolt-elements-textSecondary text-pretty">
            You&rsquo;re about to permanently drop{' '}
            <span className="font-mono text-bolt-elements-textPrimary">{table}</span> and every row in it. This
            can&rsquo;t be undone.
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              ref={cancelRef}
              onClick={() => !busy && onCancel()}
              className="min-h-[24px] text-[12px] px-3 py-1.5 rounded border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              data-testid="sitedb-drop-table-confirm-button"
              className="min-h-[24px] text-[12px] font-semibold px-3 py-1.5 rounded border border-red-500/50 bg-red-500/15 text-red-400 enabled:hover:bg-red-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400 cursor-pointer"
            >
              <div className={busy ? 'i-ph:circle-notch animate-spin' : 'i-ph:trash'} />
              <span className="min-w-[8ch] text-center">{busy ? 'Dropping…' : 'Drop table'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  },
);

DropTableConfirm.displayName = 'SiteTablesPanel.DropTableConfirm';

// ── One grid row ─────────────────────────────────────────────────────────────

interface GridRowProps extends EditProps {
  row: Record<string, unknown>;
  columns: ColumnInfo[];
  density: GridDensity;
  top: number;
  height: number;
  canMutateRows: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDeleteRow: () => void;
  onRowClick: (row: Record<string, unknown>) => void;
  onToggleBoolean: (row: Record<string, unknown>, col: ColumnInfo) => void;
}

const GridRow = memo((props: GridRowProps) => {
  const {
    row,
    columns,
    density,
    top,
    height,
    canMutateRows,
    selected,
    onToggleSelect,
    onDeleteRow,
    onRowClick,
    onToggleBoolean,
    editableColumn,
    editing,
    editKind,
    editValue,
    editError,
    editBusy,
    pkCols,
    cellSel,
    onStartEdit,
    onCellSelect,
    onEditKindChange,
    onEditValueChange,
    onEditSave,
    onEditCancel,
  } = props;

  const thisKey = rowStableKey(row, pkCols);

  return (
    <div
      role="row"
      data-testid="sitedb-grid-row"
      className={classNames(
        'group/row absolute left-0 flex w-full items-stretch border-b border-bolt-elements-borderColor/30 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
        selected
          ? 'bg-bolt-elements-item-backgroundAccent/10 shadow-[inset_2px_0_0_var(--bolt-elements-item-contentAccent)]'
          : 'hover:bg-bolt-elements-item-backgroundActive',
      )}
      style={{ top: 0, height: `${height}px`, transform: `translateY(${top}px)` }}
    >
      {/* Frozen select checkbox */}
      {canMutateRows && (
        <div
          className={classNames(
            'sticky left-0 z-10 shrink-0 w-[36px] flex items-center justify-center border-r border-bolt-elements-borderColor/20',
            selected ? 'bg-bolt-elements-item-backgroundAccent/10' : 'bg-bolt-elements-background-depth-1 group-hover/row:bg-bolt-elements-item-backgroundActive',
            densityCellClass(density),
          )}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label="Select row"
            data-testid="sitedb-row-select"
            className="h-3 w-3 accent-[color:var(--ps-accent)] cursor-pointer"
          />
        </div>
      )}

      {columns.map((col, idx) => {
        const value = row[col.name];
        const gate = editableColumn(col.name);
        const fieldKind = fieldKindForColumn(col, value);
        const isEditingThis =
          editing !== null && thisKey !== null && editing.pkKey === thisKey && editing.column === col.name;
        const frozen = idx === 0;

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
                previewSql={null}
                editError={editError}
                editBusy={editBusy}
                onSave={() => onEditSave(row, col)}
                onCancel={onEditCancel}
              />
            </div>
          );
        }

        // Is this cell part of the active single-column multi-cell selection (fill-down / bulk edit)?
        const cellSelected =
          cellSel !== null && cellSel.column === col.name && thisKey !== null && cellSel.keys.has(thisKey);

        /*
         * Click routing: a SHIFT or META/CTRL click on an editable cell is a SELECTION gesture (extend /
         * toggle a column range for fill-down + bulk edit) — never opens the editor. A plain click keeps
         * the existing behavior (boolean toggles via its checkbox; other editable cells open the typed
         * editor; a locked cell opens the row detail).
         */
        const clickHandler = (e: React.MouseEvent) => {
          if (gate.editable && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCellSelect(row, col.name, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });

            return;
          }

          if (fieldKind === 'boolean' && gate.editable) {
            return; // handled by the checkbox itself
          }

          if (gate.editable) {
            onStartEdit(row, col);
          } else {
            onRowClick(row);
          }
        };

        return (
          <div
            key={col.name}
            role="cell"
            tabIndex={0}
            aria-selected={cellSelected || undefined}
            onClick={clickHandler}
            onKeyDown={(e) => {
              // Shift+Arrow extends a column cell-selection down/up (keyboard-complete range select).
              if (gate.editable && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                onCellSelect(row, col.name, { shift: true, meta: false });

                return;
              }

              if (e.key === 'Enter' || e.key === ' ') {
                if (fieldKind === 'boolean' && gate.editable) {
                  return;
                }

                e.preventDefault();

                // Meta/Ctrl+Enter/Space toggles this cell into the column selection (keyboard equivalent of meta-click).
                if (gate.editable && (e.metaKey || e.ctrlKey)) {
                  onCellSelect(row, col.name, { shift: false, meta: true });

                  return;
                }

                if (gate.editable) {
                  onStartEdit(row, col);
                } else {
                  onRowClick(row);
                }
              }
            }}
            title={gate.editable ? 'Click to edit · Shift/⌘-click to select a column range' : (gate.reason ?? '')}
            data-testid="sitedb-grid-cell"
            data-cell-selected={cellSelected ? '1' : undefined}
            style={{ width: COL_WIDTH, left: frozen && canMutateRows ? 36 : undefined }}
            className={classNames(
              'group relative shrink-0 text-xs font-mono tabular-nums truncate border-r border-bolt-elements-borderColor/20 flex items-center gap-1',
              densityCellClass(density),
              gate.editable && fieldKind !== 'boolean'
                ? 'cursor-text hover:bg-bolt-elements-item-backgroundAccent/[0.06]'
                : 'cursor-pointer',
              cellSelected
                ? 'bg-bolt-elements-item-backgroundAccent/25 ring-1 ring-inset ring-[color:var(--ps-accent,#00e5ff)]/70'
                : '',
              frozen
                ? 'sticky z-10 bg-bolt-elements-background-depth-1 group-hover/row:bg-bolt-elements-item-backgroundActive shadow-[6px_0_10px_-8px_rgba(0,0,0,0.6)]'
                : '',
            )}
          >
            <CellValue
              value={value}
              fieldKind={fieldKind}
              editable={gate.editable}
              onToggle={() => onToggleBoolean(row, col)}
            />
            {gate.editable && fieldKind !== 'boolean' && !cellSelected && (
              <div className="i-ph:pencil-simple text-[10px] text-bolt-elements-textTertiary opacity-0 group-hover:opacity-70 ml-auto shrink-0" />
            )}
          </div>
        );
      })}

      {/* Hover-reveal row actions (delete) */}
      {canMutateRows && (
        <div className="sticky right-0 z-10 shrink-0 flex items-center px-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteRow();
            }}
            aria-label="Delete row"
            title="Delete row"
            data-testid="sitedb-row-delete"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-red-300 hover:bg-red-400/10 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400"
          >
            <div className="i-ph:trash text-[11px]" />
          </button>
        </div>
      )}
    </div>
  );
});

GridRow.displayName = 'SiteTablesPanel.GridRow';

// ── Gallery view (Airtable-style cards) ──────────────────────────────────────

const GalleryView = memo(
  ({
    columns,
    rows,
    onRowClick,
  }: {
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];
    onRowClick: (row: Record<string, unknown>) => void;
  }) => {
    const names = columns.map((c) => c.name);
    const titleField = galleryTitleField(names);
    const bodyFields = galleryBodyFields(names, titleField).slice(0, 6);

    return (
      <div className="flex-1 overflow-auto modern-scrollbar p-3" data-testid="sitedb-gallery">
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {rows.map((row, i) => {
            const titleVal = titleField ? row[titleField] : null;
            const title = titleVal === null || titleVal === undefined || titleVal === '' ? '(untitled)' : String(titleVal);

            return (
              <button
                key={i}
                type="button"
                onClick={() => onRowClick(row)}
                data-testid="sitedb-gallery-card"
                className="group/card relative overflow-hidden text-left rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 hover:border-[#00e5ff66] hover:bg-bolt-elements-background-depth-3 hover:shadow-lg hover:shadow-[#00e5ff0d] hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer flex flex-col gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-bolt-elements-item-contentAccent/70 to-[color:var(--ps-accent-secondary)]/70 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150 motion-reduce:transition-none"
                />
                <div className="text-[12px] font-semibold text-bolt-elements-textPrimary truncate">{title}</div>
                <div className="space-y-1">
                  {bodyFields.map((field) => {
                    const col = columns.find((c) => c.name === field);

                    if (!col) {
                      return null;
                    }

                    const fieldKind = fieldKindForColumn(col, row[field]);

                    return (
                      <div key={field} className="flex items-start gap-1.5 text-[11px]">
                        <span className="text-bolt-elements-textTertiary shrink-0 w-[70px] truncate">{field}</span>
                        <span className="min-w-0 flex-1 truncate font-mono">
                          <CellValue value={row[field]} fieldKind={fieldKind} editable={false} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);

GalleryView.displayName = 'SiteTablesPanel.GalleryView';

// ── Kanban board view (Rev 10 — Airtable-style grouped lanes) ─────────────────

/**
 * A grouped board over the ALREADY-loaded page rows: one lane per distinct value of `groupField`
 * (bucketed by {@link groupPageRows}), each lane a titled column of the same card the gallery uses.
 * Renders CLIENT-SIDE from the loaded page — NO new fetch. Lanes cap at {@link KANBAN_MAX_GROUPS} with a
 * "＋N more groups" note so a high-cardinality column can't explode the board. Honest empty note when the
 * page has no rows or no usable group column (never a dead/blank surface). Keyboard-reachable cards.
 */
const KanbanView = memo(
  ({
    columns,
    rows,
    groupField,
    onRowClick,
  }: {
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];
    groupField: string | null;
    onRowClick: (row: Record<string, unknown>) => void;
  }) => {
    const names = columns.map((c) => c.name);
    const titleField = galleryTitleField(names, groupField);
    // Card body: a few fields, minus the title AND the group column (shown as the lane header already).
    const bodyFields = galleryBodyFields(names, titleField)
      .filter((f) => f !== groupField)
      .slice(0, 4);

    // Honest empty / no-group states — never a blank board.
    if (rows.length === 0 || !groupField) {
      return (
        <div
          className="flex-1 flex items-center justify-center p-6 text-center"
          data-testid="sitedb-kanban"
        >
          <p className="text-[12px] text-bolt-elements-textTertiary max-w-xs">
            {rows.length === 0
              ? 'No rows to show on this board yet.'
              : 'No column to group by — add a text or status column to use the board.'}
          </p>
        </div>
      );
    }

    const buckets = [...groupPageRows(rows, groupField).entries()];
    const shownBuckets = buckets.slice(0, KANBAN_MAX_GROUPS);
    const overflow = buckets.length - shownBuckets.length;
    const emptyKey = kanbanGroupKey(null);

    return (
      <div className="flex-1 overflow-auto modern-scrollbar p-3" data-testid="sitedb-kanban">
        <div className="flex gap-3 items-start min-h-0">
          {shownBuckets.map(([key, laneRows]) => (
            <section
              key={key}
              data-testid="sitedb-kanban-lane"
              className="shrink-0 w-[240px] rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1/60 flex flex-col max-h-full"
            >
              <header className="flex items-center gap-1.5 px-2.5 py-2 border-b border-bolt-elements-borderColor sticky top-0 bg-bolt-elements-background-depth-1/90 backdrop-blur-sm rounded-t-xl">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full bg-gradient-to-br from-bolt-elements-item-contentAccent to-[color:var(--ps-accent-secondary)] shrink-0"
                />
                <span
                  data-testid="sitedb-kanban-lane-title"
                  className="text-[11px] font-semibold text-bolt-elements-textPrimary truncate flex-1"
                  title={key === emptyKey ? '(empty)' : key}
                >
                  {key === emptyKey ? '(empty)' : key}
                </span>
                <span className="text-[10px] font-mono text-bolt-elements-textTertiary shrink-0 tabular-nums">
                  {laneRows.length}
                </span>
              </header>
              <div className="p-1.5 space-y-1.5 overflow-auto modern-scrollbar">
                {laneRows.map((row, i) => {
                  const titleVal = titleField ? row[titleField] : null;
                  const title =
                    titleVal === null || titleVal === undefined || titleVal === ''
                      ? '(untitled)'
                      : String(titleVal);

                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onRowClick(row)}
                      data-testid="sitedb-kanban-card"
                      className="group/kcard relative w-full overflow-hidden text-left rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2 hover:border-[#00e5ff66] hover:bg-bolt-elements-background-depth-3 hover:shadow-md hover:shadow-[#00e5ff0d] transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer flex flex-col gap-1"
                    >
                      <div className="text-[11.5px] font-semibold text-bolt-elements-textPrimary truncate">
                        {title}
                      </div>
                      {bodyFields.map((field) => {
                        const col = columns.find((c) => c.name === field);

                        if (!col) {
                          return null;
                        }

                        const fieldKind = fieldKindForColumn(col, row[field]);

                        return (
                          <div key={field} className="flex items-start gap-1.5 text-[10.5px]">
                            <span className="text-bolt-elements-textTertiary shrink-0 w-[56px] truncate">{field}</span>
                            <span className="min-w-0 flex-1 truncate font-mono">
                              <CellValue value={row[field]} fieldKind={fieldKind} editable={false} />
                            </span>
                          </div>
                        );
                      })}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {overflow > 0 && (
            <div className="shrink-0 self-center px-2 text-[11px] text-bolt-elements-textTertiary">
              ＋{overflow} more group{overflow === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>
    );
  },
);

KanbanView.displayName = 'SiteTablesPanel.KanbanView';

// ── Calendar view (post-arc — month grid over the loaded page rows, by a strict-ISO date column) ──

/** Sunday-first weekday headers, matching monthMatrix's Sunday-first 42-cell grid. */
const CALENDAR_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Max row chips rendered inside a single day cell before the rest collapse into a "+N" note. */
const CALENDAR_MAX_PER_DAY = 3;

/**
 * A lightweight month calendar over the ALREADY-loaded page rows, bucketed by the UTC calendar day of
 * dateField (via bucketRowsByDate to isoDayKey — strict ISO only, NEVER new Date() coercion). Renders
 * CLIENT-SIDE from the loaded page — NO new fetch. Each in-month day cell lists its rows (a title field
 * when one exists, else the raw date value), keyboard-reachable. Prev/next steps the visible month; the
 * initial month is seeded from the LATEST day present in the data (so a calendar always opens on rows).
 * Rows whose date value isn't an unambiguous ISO date simply don't place (honest — never invented onto a
 * day). Pure presentational; plain React + CSS grid, no calendar dependency.
 */
const CalendarView = memo(
  ({
    columns,
    rows,
    dateField,
    onRowClick,
  }: {
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];
    dateField: string;
    onRowClick: (row: Record<string, unknown>) => void;
  }) => {
    const names = columns.map((c) => c.name);
    // Label each row by a title field that ISN'T the date column (the date is already the cell's day).
    const titleField = galleryTitleField(names.filter((n) => n !== dateField));

    // Bucket the loaded rows by their UTC day — the single source for both cell contents and month seeding.
    const buckets = useMemo(() => bucketRowsByDate(rows, dateField), [rows, dateField]);

    // Seed the visible month from the LATEST day present (so the calendar opens on data), else today (UTC).
    const seedMonth = useMemo(() => {
      const keys = [...buckets.keys()];

      if (keys.length > 0) {
        keys.sort();

        const seeded = monthFromDayKey(keys[keys.length - 1]);

        if (seeded) {
          return seeded;
        }
      }

      const now = new Date();

      return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
    }, [buckets]);

    const [view, setView] = useState(seedMonth);

    // Re-seed when the underlying data's month changes (new table / new page with a different latest day).
    useEffect(() => {
      setView(seedMonth);
    }, [seedMonth]);

    const cells = useMemo(() => monthMatrix(view.year, view.month), [view.year, view.month]);
    const monthLabel = new Date(Date.UTC(view.year, view.month, 1)).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

    // Honest empty — no row on the page carries a usable date (never a blank/doomed grid).
    if (buckets.size === 0) {
      return (
        <div className="flex-1 flex items-center justify-center p-6 text-center" data-testid="sitedb-calendar">
          <p className="text-[12px] text-bolt-elements-textTertiary max-w-xs">
            No rows on this page have a date in{' '}
            <span className="font-mono text-bolt-elements-textSecondary">{dateField}</span> to place on the calendar.
          </p>
        </div>
      );
    }

    const rowLabel = (row: Record<string, unknown>): string => {
      const raw = titleField ? row[titleField] : row[dateField];

      return raw === null || raw === undefined || raw === '' ? '(untitled)' : String(raw);
    };

    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="sitedb-calendar">
        {/* Month nav row */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
          <button
            type="button"
            onClick={() => setView((v) => addCalendarMonth(v.year, v.month, -1))}
            data-testid="sitedb-calendar-prev"
            aria-label="Previous month"
            title="Previous month"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:caret-left text-sm" />
          </button>
          <span
            data-testid="sitedb-calendar-month"
            className="text-[12px] font-semibold text-bolt-elements-textPrimary min-w-[10ch] text-center tabular-nums"
          >
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={() => setView((v) => addCalendarMonth(v.year, v.month, 1))}
            data-testid="sitedb-calendar-next"
            aria-label="Next month"
            title="Next month"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:caret-right text-sm" />
          </button>
          <span className="ml-auto text-[10.5px] font-mono text-bolt-elements-textTertiary">
            by <span className="text-bolt-elements-textSecondary">{dateField}</span>
          </span>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 shrink-0 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-1/60">
          {CALENDAR_WEEKDAYS.map((d) => (
            <div
              key={d}
              className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-bolt-elements-textTertiary text-center"
            >
              {d}
            </div>
          ))}
        </div>

        {/* Month grid */}
        <div className="flex-1 overflow-auto modern-scrollbar p-2">
          <div className="grid grid-cols-7 gap-1" data-testid="sitedb-calendar-grid">
            {cells.map((cell: CalendarCell) => {
              const dayRows = buckets.get(cell.dayKey) ?? [];
              const shown = dayRows.slice(0, CALENDAR_MAX_PER_DAY);
              const overflow = dayRows.length - shown.length;

              return (
                <div
                  key={cell.dayKey}
                  data-testid="sitedb-calendar-day"
                  data-day={cell.dayKey}
                  data-count={dayRows.length}
                  className={classNames(
                    'min-h-[76px] rounded-lg border p-1 flex flex-col gap-0.5 transition-colors',
                    cell.inMonth
                      ? 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2'
                      : 'border-transparent bg-bolt-elements-background-depth-1/40',
                  )}
                >
                  <div
                    className={classNames(
                      'text-[10px] font-mono tabular-nums px-0.5 shrink-0',
                      cell.inMonth ? 'text-bolt-elements-textSecondary' : 'text-bolt-elements-textTertiary/50',
                    )}
                  >
                    {cell.dayOfMonth}
                  </div>
                  <div className="flex flex-col gap-0.5 min-h-0">
                    {shown.map((row, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onRowClick(row)}
                        data-testid="sitedb-calendar-event"
                        title={rowLabel(row)}
                        className="text-left truncate rounded px-1 py-0.5 text-[10.5px] border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundAccent/20 hover:border-[#00e5ff66] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                      >
                        {rowLabel(row)}
                      </button>
                    ))}
                    {overflow > 0 && (
                      <span className="px-1 text-[10px] text-bolt-elements-textTertiary">＋{overflow} more</span>
                    )}
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

CalendarView.displayName = 'SiteTablesPanel.CalendarView';

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
    canMutateRows,
    onDeleteRow,
    onStartEdit,
    onEditKindChange,
    onEditValueChange,
    onEditSave,
    onEditCancel,
  }: {
    row: Record<string, unknown>;
    columns: ColumnInfo[];
    onClose: () => void;
    canMutateRows: boolean;
    onDeleteRow: (row: Record<string, unknown>) => void;
  } & EditProps) => {
    // Esc closes the drawer.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };

      window.addEventListener('keydown', onKey);

      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const thisKey = rowStableKey(row, pkCols);

    return (
      <div className="absolute inset-0 z-20 flex justify-end" role="dialog" aria-modal="true" aria-label="Row detail">
        <button type="button" aria-label="Close row detail" onClick={onClose} className="absolute inset-0 bg-black/40 cursor-default" />
        <div
          className="animated fadeInRight relative w-[min(420px,80%)] h-full bg-bolt-elements-background-depth-2 border-l border-bolt-elements-borderColor shadow-2xl flex flex-col"
          data-testid="sitedb-row-drawer"
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
            <div className="i-ph:rows text-bolt-elements-textSecondary" />
            <h3 className="text-sm font-semibold text-bolt-elements-textPrimary flex-1">Row detail</h3>
            {canMutateRows && (
              <button
                type="button"
                onClick={() => {
                  onDeleteRow(row);
                  onClose();
                }}
                aria-label="Delete row"
                title="Delete this row"
                data-testid="sitedb-drawer-delete"
                className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-red-300 hover:bg-red-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer"
              >
                <div className="i-ph:trash text-sm" />
              </button>
            )}
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
