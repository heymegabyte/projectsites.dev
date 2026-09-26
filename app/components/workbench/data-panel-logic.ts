/**
 * @file Pure logic for the workbench Data tab. No React / no DOM — everything
 * here is unit-tested by `data-panel-logic.spec.ts`. The panel itself
 * (`DataPanel.tsx`) is a thin view over these helpers + the PS_ admin bridge.
 */
import type { DataOverviewTable } from '~/lib/embed/embedded-mode';

/** Phosphor icon per known table key; a sensible default for anything new. */
const TABLE_ICONS: Record<string, string> = {
  visitor_events: 'i-ph:chart-line-duotone',
  form_submissions: 'i-ph:envelope-duotone',
  site_snapshots: 'i-ph:camera-duotone',
  mcp_connections: 'i-ph:plugs-connected-duotone',
  site_data: 'i-ph:database-duotone',
};

/**
 * Icon class for a table key.
 *
 * @param key - the table key (e.g. `visitor_events`)
 * @returns a UnoCSS phosphor icon class
 * @example iconForTable('form_submissions') // 'i-ph:envelope-duotone'
 */
export function iconForTable(key: string): string {
  return TABLE_ICONS[key] ?? 'i-ph:table-duotone';
}

/**
 * Format a raw cell value for display. Null/undefined → em-dash, objects →
 * compact JSON, everything else → its string form. Never throws.
 *
 * @param value - the raw value from a browse row
 * @returns a display-safe string
 * @example formatCellValue(null) // '—' ; formatCellValue({a:1}) // '{"a":1}'
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/**
 * Summarize the overview table list into headline counts.
 *
 * @param tables - the data-overview table list (may be undefined)
 * @returns `{ total, populated }` — total tables and how many have rows
 * @example summarizeTables([{row_count:0},{row_count:5}]) // { total: 2, populated: 1 }
 */
export function summarizeTables(tables: readonly DataOverviewTable[] | undefined | null): {
  total: number;
  populated: number;
} {
  const list = tables ?? [];
  return { total: list.length, populated: list.filter((t) => (t?.row_count ?? 0) > 0).length };
}

/**
 * Generate a correlation id for a PS_DATA_REQUEST round-trip. Uses Web Crypto
 * when available, else a timestamp+counter fallback (id uniqueness only needs to
 * hold within one panel session, not globally).
 *
 * @remarks Impure — reads `crypto`. `seed` makes the fallback deterministic in tests.
 * @param seed - optional deterministic suffix for the non-crypto fallback
 * @returns a unique-enough correlation id string
 * @example newCorrelationId('t1') // 'data-...-t1' when crypto is absent
 */
export function newCorrelationId(seed?: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  return `data-${seed ?? String(Date.now())}`;
}

/** Column header label: snake_case → Title Case. */
export function columnLabel(col: string): string {
  return col
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** CSV-escape one value: objects → JSON, null/undefined → empty, quote when needed. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const s = typeof value === 'object' ? safeJson(value) : String(value);

  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Serialize browse rows to an RFC-4180-ish CSV string (header = column labels,
 * CRLF line breaks, embedded quotes doubled). Empty rows → header line only.
 *
 * @param columns - column keys in display order
 * @param rows - the browse rows
 * @returns a CSV string ready for a Blob download
 * @example toCsv(['form_name'], [{ form_name: 'Contact' }]) // 'Form Name\r\nContact'
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const head = columns.map((c) => csvCell(columnLabel(c))).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');

  return body ? `${head}\r\n${body}` : head;
}

/**
 * Filter browse rows by a case-insensitive substring matched across ALL columns.
 * A blank query returns every row (a fresh copy). Pure — never mutates input.
 *
 * @param rows - the browse rows
 * @param columns - columns to search within
 * @param query - the search text (trimmed + lowercased internally)
 * @returns the matching subset
 * @example filterRows([{ email: 'A@x.com' }], ['email'], 'a@x') // [{ email: 'A@x.com' }]
 */
export function filterRows(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  query: string,
): Record<string, unknown>[] {
  const q = (query ?? '').trim().toLowerCase();

  if (!q) {
    return rows.slice();
  }

  return rows.filter((r) => columns.some((c) => formatCellValue(r[c]).toLowerCase().includes(q)));
}

/**
 * Ordered `[label, displayValue]` pairs for a single row's detail drill-down —
 * pretty (2-space) JSON for objects, `formatCellValue` for scalars.
 *
 * @param row - one browse row
 * @param columns - columns in display order
 * @returns label/value pairs for a definition-list detail view
 * @example detailEntries({ path: '/' }, ['path']) // [['Path', '/']]
 */
export function detailEntries(row: Record<string, unknown>, columns: readonly string[]): Array<[string, string]> {
  return columns.map((c) => {
    const v = row[c];
    const val =
      v !== null && v !== undefined && typeof v === 'object'
        ? (() => {
            try {
              return JSON.stringify(v, null, 2);
            } catch {
              return String(v);
            }
          })()
        : formatCellValue(v);

    return [columnLabel(c), val];
  });
}

/**
 * Whether a KeyboardEvent key should ACTIVATE a clickable row (toggle its detail
 * drill-down). Enter and Space are the ARIA activation keys for a widget with
 * `role`/`aria-expanded`; a browse row is click-toggleable, so it must be
 * keyboard-toggleable too (WCAG 2.2 · 2.1.1 Keyboard, Level A — a click-only row
 * strands keyboard + switch users). Space is normalized as both `' '` and the
 * legacy `'Spacebar'`.
 *
 * @param key - the `KeyboardEvent.key` value
 * @returns true when the key should toggle the row detail
 * @example isRowActivationKey('Enter') // true
 * @example isRowActivationKey(' ') // true
 * @example isRowActivationKey('Tab') // false
 */
export function isRowActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/**
 * Whether a KeyboardEvent key should DISMISS (collapse) an open row detail.
 * Escape is the ARIA "close/cancel" gesture for a disclosure — a keyboard user
 * who opened a row with Enter/Space collapses it with Escape, matching the native
 * dialog/disclosure convention (WCAG 2.2 keyboard operability). The legacy `'Esc'`
 * alias (older browsers) is normalized alongside the modern `'Escape'`.
 *
 * @param key - the `KeyboardEvent.key` value
 * @returns true when the key should collapse the open row detail
 * @example isDismissKey('Escape') // true
 * @example isDismissKey('Esc') // true
 * @example isDismissKey('Enter') // false
 */
export function isDismissKey(key: string): boolean {
  return key === 'Escape' || key === 'Esc';
}

/**
 * Prepend a query to the SQL-console history (a real-editor staple): trimmed,
 * de-duplicated (a re-run of an existing query jumps back to the top instead of
 * piling up), most-recent-first, capped at `max`. A blank query returns the list
 * unchanged. Pure — never mutates input; the localStorage read/write lives in the
 * component (this stays testable + DOM-free).
 *
 * @param history - existing history, most-recent first
 * @param query - the query just run
 * @param max - cap on retained entries (default 25)
 * @returns the new history list
 * @example addToSqlHistory(['b'], 'a') // ['a', 'b']
 * @example addToSqlHistory(['a', 'b'], 'b') // ['b', 'a']  (re-run jumps to top, no dupe)
 * @example addToSqlHistory(['a'], '   ') // ['a']  (blank is a no-op)
 */
export function addToSqlHistory(history: readonly string[], query: string, max = 25): string[] {
  const q = (query ?? '').trim();

  if (!q) {
    return history.slice();
  }

  return [q, ...history.filter((h) => h !== q)].slice(0, Math.max(1, max));
}

/** A user-named, saved SQL query — one-click reusable, distinct from the auto-history. */
export interface SavedQuery {
  name: string;
  query: string;
}

/**
 * Add (or update) a NAMED saved query — the manual, reusable-snippet companion to the
 * auto-history. Dedupes by trimmed name: saving under an existing name OVERWRITES its query
 * and moves it to the top. A blank name OR blank query is a no-op. Newest first, capped.
 * Pure — no DOM/I/O (the panel persists the result to localStorage).
 *
 * @param saved - existing saved queries, most-recent first
 * @param name - the label the user gave this query
 * @param query - the SQL to store
 * @param max - cap on retained entries (default 50)
 * @returns the new saved-query list
 * @example addSavedQuery([], 'actives', 'SELECT 1') // [{name:'actives', query:'SELECT 1'}]
 * @example addSavedQuery([{name:'a',query:'X'}], 'a', 'Y') // [{name:'a', query:'Y'}]  (overwrite + top)
 * @example addSavedQuery([{name:'a',query:'X'}], '  ', 'Y') // [{name:'a', query:'X'}]  (blank name = no-op)
 */
export function addSavedQuery(saved: readonly SavedQuery[], name: string, query: string, max = 50): SavedQuery[] {
  const n = (name ?? '').trim();
  const q = (query ?? '').trim();

  if (!n || !q) {
    return saved.slice();
  }

  return [{ name: n, query: q }, ...saved.filter((s) => s.name !== n)].slice(0, Math.max(1, max));
}

/**
 * Remove a saved query by exact name; a missing name leaves the list unchanged. Pure.
 *
 * @param saved - existing saved queries
 * @param name - the name to remove
 * @returns the new list without that entry
 * @example removeSavedQuery([{name:'a',query:'X'}], 'a') // []
 */
export function removeSavedQuery(saved: readonly SavedQuery[], name: string): SavedQuery[] {
  return saved.filter((s) => s.name !== name);
}

/**
 * Thrown when CSV-import input is malformed (no header + data row, bad identifier, or a row
 *  whose column count mismatches the header). Lets the panel show a precise, safe message.
 */
export class CsvImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvImportError';
  }
}

/** SQLite identifier gate — table + column names must match this before interpolation. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse an RFC-4180-ish CSV string into rows of string cells. Handles quoted fields with
 * embedded commas + newlines and doubled `""` escapes; normalizes CRLF/CR to LF. A trailing
 * newline does NOT yield a spurious empty row. Pure — no DOM, no I/O.
 *
 * @param text - the raw CSV
 * @returns rows, each an array of cell strings
 * @example parseCsv('a,b\n"x,y",2') // [['a','b'], ['x,y','2']]
 * @example parseCsv('name\n"say ""hi"""') // [['name'], ['say "hi"']]
 */
export function parseCsv(text: string): string[][] {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** The max bind params in one exec-write statement (mirrors the worker's `SqlWriteSchema.params` cap). */
export const CSV_IMPORT_MAX_PARAMS = 200;

/** How many data rows the import UI previews before running. */
export const CSV_IMPORT_PREVIEW_ROWS = 5;

/** One parameterized multi-row INSERT batch (≤ {@link CSV_IMPORT_MAX_PARAMS} bound values). */
export interface CsvImportBatch {
  /** `INSERT INTO "t" ("a", "b") VALUES (?, ?), (?, ?)` — value positions are `?`, never inlined. */
  readonly statement: string;

  /** Flat, row-major bound values; an empty cell → `null` (never `''` or a stringified NULL). */
  readonly params: BoundValue[];
  readonly rowCount: number;
}

/** A validated, PARAMETERIZED, chunked CSV→table import plan (the import counterpart to {@link toCsv}). */
export interface CsvImportPlan {
  readonly table: string;
  readonly columns: string[];

  /** Total data rows across every batch. */
  readonly rowCount: number;

  /** Parameterized multi-row INSERTs, each within the exec-write param cap, run sequentially. */
  readonly batches: CsvImportBatch[];

  /** The first {@link CSV_IMPORT_PREVIEW_ROWS} data rows, for the pre-import preview. */
  readonly preview: string[][];
}

/**
 * Build a PARAMETERIZED, chunked INSERT plan from CSV text for `table` — the import counterpart to
 * {@link toCsv}, run through the panel's existing bound `/sql/exec-write` rail. Row 1 is the header
 * (column names, identifier-validated); every later row's cells become BOUND values in a multi-row
 * `INSERT INTO "t" (...) VALUES (?, ?), (?, ?)…`. Values are bound `?`, **NEVER concatenated into
 * SQL** (the epic's "parameterize values, never concatenate" mandate) — an injection payload rides
 * as an inert param. An empty cell → bound `null` (not `''`). Rows are chunked so each batch stays
 * within `maxParams` bind params, so a large CSV imports as several safe statements the caller runs
 * in sequence. Table + column names are gated by `IDENT_RE` (a hostile identifier is rejected here,
 * never quoted-in). Pure — no DOM, no I/O.
 *
 * @throws {CsvImportError} empty/one-row input, a bad table/column identifier, a row whose column
 *   count differs from the header, or a table too wide to import within one parameterized write.
 * @example buildCsvImportPlan('a,b\n1,', 't').batches[0]
 *   // → { statement: 'INSERT INTO "t" ("a", "b") VALUES (?, ?)', params: ['1', null], rowCount: 1 }
 */
export function buildCsvImportPlan(
  csvText: string,
  table: string,
  maxParams: number = CSV_IMPORT_MAX_PARAMS,
): CsvImportPlan {
  const t = String(table ?? '').trim();

  if (!IDENT_RE.test(t)) {
    throw new CsvImportError('Enter a valid table name (letters, digits, underscore; not starting with a digit).');
  }

  const rows = parseCsv(csvText);

  if (rows.length < 2) {
    throw new CsvImportError('CSV needs a header row and at least one data row.');
  }

  const columns = rows[0].map((c) => c.trim());

  if (columns.length === 0 || columns.some((c) => !IDENT_RE.test(c))) {
    throw new CsvImportError('Every header column must be a valid identifier.');
  }

  if (columns.length > maxParams) {
    throw new CsvImportError(
      `Too many columns (${columns.length}) to import within one parameterized write (max ${maxParams}).`,
    );
  }

  const dataRows = rows.slice(1);
  dataRows.forEach((r, idx) => {
    if (r.length !== columns.length) {
      throw new CsvImportError(`Row ${idx + 1} has ${r.length} value(s); the header has ${columns.length}.`);
    }
  });

  const colList = columns.map((c) => `"${c}"`).join(', ');
  const placeholderRow = `(${columns.map(() => '?').join(', ')})`;

  // Chunk rows so cols × rows-per-batch ≤ maxParams (≥1 row per batch even for a wide table).
  const rowsPerBatch = Math.max(1, Math.floor(maxParams / columns.length));

  const batches: CsvImportBatch[] = [];

  for (let i = 0; i < dataRows.length; i += rowsPerBatch) {
    const chunk = dataRows.slice(i, i + rowsPerBatch);
    const params: BoundValue[] = [];

    for (const r of chunk) {
      for (const v of r) {
        params.push(v === '' ? null : v);
      }
    }

    batches.push({
      statement: `INSERT INTO "${t}" (${colList}) VALUES ${chunk.map(() => placeholderRow).join(', ')}`,
      params,
      rowCount: chunk.length,
    });
  }

  return { table: t, columns, rowCount: dataRows.length, batches, preview: dataRows.slice(0, CSV_IMPORT_PREVIEW_ROWS) };
}

/**
 * Extract the primary-key column name(s) from a `pragma_table_info` result — the prerequisite for
 * a SAFE inline row edit/delete (you need the PK to build a precise `WHERE pk = value`, never a
 * whole-table mutation). Accepts either the raw `name` column or the `"column"` alias our
 * Structure starters emit; rows with `pk > 0`, ordered by `pk` (composite-key order). Returns `[]`
 * when the table has NO declared PK — the caller then refuses inline mutation rather than guess a
 * key (never generates an unscoped UPDATE/DELETE). Pure.
 *
 * @param rows - a pragma_table_info result (each row has `pk` + `name`/`column`)
 * @returns ordered PK column names, or [] when none is declared
 * @example pkFromTableInfo([{ name: 'id', pk: 1 }, { name: 'x', pk: 0 }]) // ['id']
 * @example pkFromTableInfo([{ name: 'a', pk: 2 }, { name: 'b', pk: 1 }]) // ['b', 'a']
 * @example pkFromTableInfo([{ name: 'x', pk: 0 }]) // []  (no PK → caller refuses inline mutation)
 */
export function pkFromTableInfo(rows: readonly Record<string, unknown>[]): string[] {
  return (rows ?? [])
    .filter((r) => Number(r?.pk) > 0)
    .map((r) => ({ pk: Number(r.pk), name: String(r.name ?? r.column ?? '').trim() }))
    .filter((r) => r.name.length > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);
}

/**
 * The GENERATED (computed) columns from a `pragma_table_xinfo` result — its `hidden` field is 2 for a
 * VIRTUAL generated column and 3 for a STORED one (0 = ordinary, 1 = an internal hidden column).
 * SQLite REJECTS writing a generated column's value, so the grid uses this to present those columns
 * read-only (never a doomed edit) and omit them from INSERT (add / duplicate). Accepts the raw `name`
 * or the `"column"` alias; a row without a numeric `hidden` is treated as ordinary. Pure.
 *
 * @param rows - a pragma_table_xinfo result (each row has `hidden` + `name`/`column`)
 * @returns the set of generated column names (empty when none, or when `hidden` is absent)
 * @example generatedFromTableXinfo([{ name: 'a', hidden: 0 }, { name: 'total', hidden: 2 }]) // Set {'total'}
 * @example generatedFromTableXinfo([{ name: 'hash', hidden: 3 }]) // Set {'hash'}  (STORED)
 * @example generatedFromTableXinfo([{ name: 'a', hidden: 0 }]) // Set {}
 */
export function generatedFromTableXinfo(rows: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();

  for (const r of rows ?? []) {
    const name = String(r?.name ?? r?.column ?? '').trim();

    if (name.length > 0 && Number(r?.hidden) >= 2) {
      out.add(name);
    }
  }

  return out;
}

/** Default browse page size (rows per request). Matches the worker's `data-overview` default. */
export const BROWSE_PAGE_SIZE = 25;

/** The page sizes offered by the grid's rows-per-page selector (all within the worker's 1–100 clamp). */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/**
 * Clamp a rows-per-page value to an offered {@link PAGE_SIZE_OPTIONS} size — defends the request path
 * against a stale/garbage value (the worker also clamps 1–100, but the grid should only ever request a
 * size it can render as a selected option). Unknown / NaN → {@link BROWSE_PAGE_SIZE}. Pure.
 *
 * @example clampPageSize(50)  // 50
 * @example clampPageSize(999) // 25
 * @example clampPageSize(NaN) // 25
 */
export function clampPageSize(n: number): number {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : BROWSE_PAGE_SIZE;
}

/** Derived display + control state for the paginated browse grid. */
export interface BrowsePageInfo {
  /** 1-based index of the first shown row (0 when the page is empty). */
  from: number;

  /** 1-based index of the last shown row (0 when the page is empty). */
  to: number;

  /** True when there is a previous page (offset > 0). */
  hasPrev: boolean;

  /** True when more rows exist beyond this page (offset + shown < total). */
  hasNext: boolean;

  /** Human range label, e.g. `"26–50 of 1,234"`, `"0 of 1,234"`, or `"No rows"`. */
  label: string;
}

/**
 * Pure pagination math for the browse grid — turns the current `offset`, the number of rows actually
 * loaded on this page, and the table's `total` row count into a 1-based range + prev/next availability
 * + an honest label. `hasNext` is derived from `total` (not a fetched "one extra" row), and the label
 * NEVER implies the page is the whole table (the silent-cap lesson). All inputs are floored/clamped so
 * a hostile/NaN value can't produce a negative or misleading range. Pure.
 *
 * @param offset - 0-based offset of the first row on this page
 * @param loadedCount - number of rows returned for this page (may be < page size on the last page)
 * @param total - the table's total row count (from the overview / browse `total`)
 * @example browsePageInfo(25, 25, 1234) // { from:26, to:50, hasPrev:true, hasNext:true, label:'26–50 of 1,234' }
 * @example browsePageInfo(0, 0, 0)      // { from:0, to:0, hasPrev:false, hasNext:false, label:'No rows' }
 */
export function browsePageInfo(offset: number, loadedCount: number, total: number): BrowsePageInfo {
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const count = Math.max(0, Math.floor(Number(loadedCount) || 0));
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const from = count > 0 ? safeOffset + 1 : 0;
  const to = count > 0 ? safeOffset + count : 0;
  const hasPrev = safeOffset > 0;
  const hasNext = safeOffset + count < safeTotal;
  const label =
    count > 0
      ? `${from.toLocaleString()}–${to.toLocaleString()} of ${safeTotal.toLocaleString()}`
      : safeTotal > 0
        ? `0 of ${safeTotal.toLocaleString()}`
        : 'No rows';

  return { from, to, hasPrev, hasNext, label };
}

/** Statement category for the Data console — drives the run affordance + which result view shows. */
export type SqlKind = 'read' | 'write' | 'ddl' | 'transaction' | 'other';

/** One parsed statement's safety classification. */
export interface SqlStatementInfo {
  /** Leading keyword, uppercased (SELECT, INSERT, DROP, …); '' for an empty/blank statement. */
  verb: string;

  /**
   * Category — read (SELECT/PRAGMA/EXPLAIN/VALUES), write (INSERT/UPDATE/DELETE/REPLACE),
   *  ddl (CREATE/ALTER/DROP/…), transaction (BEGIN/COMMIT/…), or other.
   */
  kind: SqlKind;

  /** True when the statement can irreversibly drop or mass-overwrite data — the panel must confirm first. */
  destructive: boolean;

  /** Plain-language reason when destructive; '' otherwise. */
  reason: string;
}

/** Aggregate classification of a whole console buffer (which may hold several `;`-separated statements). */
export interface SqlBatchInfo {
  /** Per-statement infos, in order. */
  statements: SqlStatementInfo[];

  /** True when ANY statement is destructive — the batch needs a confirm before it runs. */
  destructive: boolean;

  /** Highest-privilege kind across the batch (ddl > write > transaction > read > other). */
  kind: SqlKind;

  /** Deduped destructive reasons, for the confirm dialog. */
  reasons: string[];

  /** Count of non-empty statements. */
  statementCount: number;
}

const KIND_RANK: Record<SqlKind, number> = { other: 0, read: 1, transaction: 2, write: 3, ddl: 4 };
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'REINDEX', 'VACUUM', 'ANALYZE', 'ATTACH', 'DETACH']);
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const READ_VERBS = new Set(['SELECT', 'PRAGMA', 'EXPLAIN', 'VALUES']);
const TXN_VERBS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END']);

/**
 * Blank the CONTENT of every SQL string literal and comment (both line comments and block comments)
 * so keyword detection can never trip on data or commentary — a row literally containing the text
 * "DROP TABLE" must NOT read as destructive, and a "-- delete everything" note must not either.
 * Structure + newlines are preserved; only literal/comment characters become spaces. Pure, never throws.
 *
 * @param sql - raw SQL
 * @returns the SQL with all literal/comment characters replaced by spaces
 * @example stripSqlCommentsAndStrings("DELETE FROM t WHERE id=1 -- wipe") // 'DELETE FROM t WHERE id=1       '
 * @example stripSqlCommentsAndStrings("SELECT 'DROP TABLE x'") // 'SELECT              ' (literal blanked)
 */
export function stripSqlCommentsAndStrings(sql: string): string {
  const s = String(sql ?? '');
  const n = s.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];

    if (c === '-' && c2 === '-') {
      while (i < n && s[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;

      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }

      if (i < n) {
        out += '  ';
        i += 2;
      }

      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += ' ';
      i++;

      while (i < n) {
        if (s[i] === q && s[i + 1] === q) {
          out += '  ';
          i += 2;
          continue;
        }

        if (s[i] === q) {
          out += ' ';
          i++;
          break;
        }

        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * Classify ONE SQL statement for the console's safety gate. Strips literals/comments first, derives
 * the leading verb + {@link SqlKind}, then — the important part — decides whether it is DESTRUCTIVE:
 * a DROP / TRUNCATE / ALTER-DROP, or a DELETE / UPDATE with NO `WHERE` clause (which wipes or rewrites
 * an entire table). The panel pops a typed confirm before running anything destructive. Errs toward
 * flagging (a suspected wipe confirms; a false confirm is cheap, a silent wipe is not). Pure, never throws.
 *
 * @param raw - a single SQL statement (may include comments/strings)
 * @returns its {@link SqlStatementInfo}
 * @example classifySqlStatement('SELECT * FROM users') // { verb:'SELECT', kind:'read', destructive:false, reason:'' }
 * @example classifySqlStatement('DELETE FROM users') // destructive — no WHERE clause wipes the table
 * @example classifySqlStatement('DELETE FROM users WHERE id = 1') // { kind:'write', destructive:false }
 * @example classifySqlStatement('DROP TABLE users') // { kind:'ddl', destructive:true }
 */
export function classifySqlStatement(raw: string): SqlStatementInfo {
  const s = stripSqlCommentsAndStrings(String(raw ?? ''))
    .trim()
    .replace(/\s+/g, ' ');

  if (!s) {
    return { verb: '', kind: 'other', destructive: false, reason: '' };
  }

  const verb = (s.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
  const U = s.toUpperCase();

  // A CTE (WITH …) is classified by the primary DML/read keyword that follows it.
  let effectiveVerb = verb;

  if (verb === 'WITH') {
    /*
     * FIRST-MATCH-ORDER: `String.match` returns the LEFTMOST hit, never the
     * highest-priority one, so a keyword inside a CTE body pre-empts the primary verb
     * (`WITH c AS (SELECT id FROM t) DELETE FROM t` read as a SELECT). Blank every
     * parenthesized body at any depth, then take the first keyword that survives.
     */
    const chars: string[] = [];
    let depth = 0;

    for (const ch of U) {
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
      }

      chars.push(depth === 0 ? ch : ' ');
    }
    effectiveVerb = chars.join('').match(/\b(INSERT|UPDATE|DELETE|REPLACE|SELECT)\b/)?.[1] ?? 'SELECT';
  }

  let kind: SqlKind = 'other';

  if (DDL_VERBS.has(effectiveVerb)) {
    kind = 'ddl';
  } else if (WRITE_VERBS.has(effectiveVerb)) {
    kind = 'write';
  } else if (TXN_VERBS.has(effectiveVerb)) {
    kind = 'transaction';
  } else if (READ_VERBS.has(effectiveVerb)) {
    kind = 'read';
  }

  let reason = '';

  if (/\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER|DATABASE|SCHEMA)\b/.test(U)) {
    reason = 'DROP permanently deletes a database object and all data it holds.';
  } else if (/\bTRUNCATE\b/.test(U)) {
    reason = 'TRUNCATE removes every row in the table.';
  } else if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(COLUMN|CONSTRAINT)\b/.test(U)) {
    reason = 'ALTER … DROP removes a column (and its data) from the table.';
  } else if (effectiveVerb === 'DELETE' && /\bDELETE\s+FROM\b/.test(U) && !/\bWHERE\b/.test(U)) {
    reason = 'DELETE with no WHERE clause removes every row in the table.';
  } else if (effectiveVerb === 'UPDATE' && !/\bWHERE\b/.test(U)) {
    reason = 'UPDATE with no WHERE clause rewrites every row in the table.';
  }

  return { verb, kind, destructive: reason !== '', reason };
}

/**
 * Classify a whole console buffer (one or more `;`-separated statements) for the safety gate. Splits
 * on statement boundaries AFTER blanking literals/comments (so a `;` inside a string is never a
 * boundary), classifies each, and aggregates: the batch is DESTRUCTIVE when ANY statement is, and its
 * `kind` is the highest-privilege statement present. This is what the run handler calls to decide
 * whether to confirm before executing. Pure, never throws.
 *
 * @param sql - the full editor buffer
 * @returns the aggregate {@link SqlBatchInfo}
 * @example classifySql('SELECT 1; DROP TABLE t').destructive // true
 * @example classifySql('SELECT 1; SELECT 2') // { kind:'read', destructive:false, statementCount:2, … }
 */
export function classifySql(sql: string): SqlBatchInfo {
  const stripped = stripSqlCommentsAndStrings(String(sql ?? ''));
  const parts = stripped
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const statements = parts.map((p) => classifySqlStatement(p));
  const destructive = statements.some((s) => s.destructive);
  const reasons = [...new Set(statements.filter((s) => s.destructive).map((s) => s.reason))];
  const kind = statements.reduce<SqlKind>((hi, s) => (KIND_RANK[s.kind] > KIND_RANK[hi] ? s.kind : hi), 'other');

  return { statements, destructive, kind, reasons, statementCount: statements.length };
}

/**
 * Wrap the FIRST statement of the editor buffer in `EXPLAIN QUERY PLAN` — the SQLite
 * query-optimizer view (which indexes it uses, where it full-scans). EXPLAIN never
 * modifies data, so this is a pure read. Idempotent (won't double-wrap an already-EXPLAIN
 * query); trailing `;` stripped so the wrap stays one statement.
 *
 * @param sql - the editor buffer
 * @returns the EXPLAIN-wrapped query, or '' when there's nothing to explain
 * @example explainQuery('SELECT * FROM t') // 'EXPLAIN QUERY PLAN SELECT * FROM t'
 * @example explainQuery('EXPLAIN QUERY PLAN SELECT 1') // 'EXPLAIN QUERY PLAN SELECT 1' (unchanged)
 */
export function explainQuery(sql: string): string {
  // Only the first statement — EXPLAIN takes a single statement, not a batch.
  const first = String(sql ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.length > 0);

  if (!first) {
    return '';
  }

  return /^EXPLAIN\b/i.test(first) ? first : `EXPLAIN QUERY PLAN ${first}`;
}

/** Plain-language index guidance derived from an EXPLAIN QUERY PLAN result. */
export interface ExplainHint {
  level: 'good' | 'warn' | 'info';
  message: string;
}

/**
 * Turn an EXPLAIN QUERY PLAN result into one plain-language index hint (the actionable
 * "your query is/isn't index-optimized" a full SQLite manager shows). Reads each plan
 * row's `detail` string: a bare `SCAN` (no `USING INDEX`) = a full-table scan → warn;
 * `USE TEMP B-TREE` = an un-indexed sort/group → info; otherwise index-covered → good.
 * Returns null when the rows aren't a query plan (no `detail` column) — so it shows ONLY
 * after an Explain, never on a normal SELECT result.
 *
 * @param rows - the result rows from `EXPLAIN QUERY PLAN`
 * @returns an {@link ExplainHint}, or null when the result isn't a plan
 * @example explainPlanHint([{ detail: 'SCAN users' }]) // { level:'warn', … }
 * @example explainPlanHint([{ detail: 'SEARCH users USING INDEX ix_email' }]) // { level:'good', … }
 * @example explainPlanHint([{ id: 1, name: 'x' }]) // null (not a plan)
 */
export function explainPlanHint(rows: readonly Record<string, unknown>[]): ExplainHint | null {
  const details = (rows ?? []).map((r) => (typeof r.detail === 'string' ? r.detail : '')).filter((d) => d.length > 0);

  if (details.length === 0) {
    return null; // not a query plan → no hint
  }

  const scans = details.filter((d) => /\bSCAN\b/i.test(d) && !/USING (COVERING )?INDEX/i.test(d));

  if (scans.length > 0) {
    return {
      level: 'warn',
      message: `Full-table scan on ${scans.length} table${scans.length > 1 ? 's' : ''} — add an index on the column(s) you filter or join by to make this query fast at scale.`,
    };
  }

  if (details.some((d) => /USE TEMP B-TREE/i.test(d))) {
    return {
      level: 'info',
      message: 'Sorting/grouping builds a temporary B-tree — an index on the ORDER BY / GROUP BY column can avoid it.',
    };
  }

  return { level: 'good', message: 'Index-optimized — this query uses an index and avoids full-table scans.' };
}

/**
 * The rows-read threshold above which the SQL console flags an expensive scan (mirrors
 * the admin console's bar). D1 bills + slows on rows READ, so a large scan is the #1
 * cause of a slow query.
 */
export const EXPENSIVE_SCAN_ROWS = 10_000;

/**
 * True when D1 REPORTED reading a large number of rows — a full-table scan D1 bills for
 * and that slows down at scale. Fires only on a real reported value (never null =
 * "not reported", never a small count), so a missing metric never shows a false warning.
 *
 * @param rowsRead - the `rows_read` from the query's D1 meta (null when unreported)
 * @returns true when the query read more than {@link EXPENSIVE_SCAN_ROWS} rows
 * @example isExpensiveScan(12000) // true
 * @example isExpensiveScan(500)   // false
 * @example isExpensiveScan(null)  // false (not reported — never a fabricated warning)
 */
export function isExpensiveScan(rowsRead: number | null | undefined): boolean {
  return typeof rowsRead === 'number' && rowsRead > EXPENSIVE_SCAN_ROWS;
}

/**
 * The default row cap the console offers to append to an UNBOUNDED SELECT. Bounds BOTH the
 * result size streamed to the browser AND the rows D1 scans/bills for on a `SELECT *` against a
 * large table — the "warn/auto-append LIMIT to a bare SELECT" guard. A first screen, not the
 * whole table (mirrors the browse grid's page-size philosophy); the operator can still Run the
 * raw unbounded query.
 */
export const DEFAULT_ROW_LIMIT = 500;

/** Advice on bounding an unbounded row-returning query's result size (see {@link analyzeRowLimit}). */
export interface RowLimitAdvice {
  /** True when the first statement is a bare `SELECT` / `WITH…SELECT` with NO `LIMIT` — unbounded. */
  readonly needsLimit: boolean;

  /** The first statement with `LIMIT <limit>` appended, or the input unchanged when not needed. */
  readonly limitedSql: string;

  /** The limit that would be applied. */
  readonly limit: number;
}

/**
 * Detect an UNBOUNDED row-returning query — a `SELECT` or `WITH…SELECT` with no `LIMIT` — and
 * produce a `LIMIT`-appended variant so the console can bound result size + scan cost BEFORE
 * running it (a `SELECT * FROM big_table` otherwise streams every row to the browser and bills for
 * a full scan). Only the FIRST statement is considered (the console runs one statement, like
 * {@link explainQuery}). Detection runs on a comment/string-stripped copy so a `'…LIMIT…'` string
 * literal can't cause a false match; the `LIMIT` is appended to the REAL statement. Conservative +
 * safe: `EXPLAIN`/`PRAGMA`/`VALUES`/writes are left alone, and ANY existing `LIMIT` (even one in a
 * subquery) suppresses the offer so a valid query is never turned into a double-`LIMIT` syntax
 * error. Pure string logic; SQLite's own parser bounds the value at run time.
 *
 * @param sql - the editor buffer
 * @param limit - the row cap to offer (default {@link DEFAULT_ROW_LIMIT})
 * @example analyzeRowLimit('SELECT * FROM users')         // needsLimit:true  → 'SELECT * FROM users LIMIT 500'
 * @example analyzeRowLimit('select a from t limit 10')    // needsLimit:false (already bounded)
 * @example analyzeRowLimit('EXPLAIN QUERY PLAN SELECT 1') // needsLimit:false (not a bare SELECT)
 * @example analyzeRowLimit('PRAGMA table_info(t)')        // needsLimit:false
 */
export function analyzeRowLimit(sql: string, limit: number = DEFAULT_ROW_LIMIT): RowLimitAdvice {
  const raw = String(sql ?? '');

  // First statement only — mirror explainQuery's split (the console runs one statement).
  const first = raw
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  const unchanged: RowLimitAdvice = { needsLimit: false, limitedSql: raw, limit };

  if (!first) {
    return unchanged;
  }

  // Detect on a comment/string-stripped copy so a string literal can't false-match SELECT/LIMIT.
  const probe = stripSqlCommentsAndStrings(first).trim();

  if (!/^(SELECT|WITH)\b/i.test(probe)) {
    return unchanged;
  } // EXPLAIN/PRAGMA/VALUES/writes excluded

  if (/\bLIMIT\b/i.test(probe)) {
    return unchanged;
  } // already bounded — never risk a double LIMIT

  return { needsLimit: true, limitedSql: `${first} LIMIT ${limit}`, limit };
}

/**
 * The honest write-target descriptor for the D1 SQL console. This is the SSOT behind the
 * console's safety banner so the facts it shows the user can never drift from a code
 * comment. The console (super-admin only) runs against the SHARED, multi-tenant PLATFORM
 * database — a write here affects EVERY tenant's data, which is exactly the fact the
 * prompt requires we surface "prominently before writes".
 */
export interface SqlConsoleTarget {
  /** Deploy environment the console mutates — always the live production D1. */
  environment: string;

  /** Human name of the database, stating plainly that it is shared across all tenants. */
  database: string;

  /** One-line scope warning: whom a write affects + the guardrails that still apply. */
  scope: string;
}

/**
 * Build the write-target descriptor rendered in the SQL console's safety banner. Static
 * facts (the console always targets the shared production D1), returned as a fresh object
 * so callers can't mutate a shared singleton.
 *
 * @returns the {@link SqlConsoleTarget} shown prominently above the console before writes
 * @example
 *   sqlConsoleTarget().database // 'Shared platform database (D1 · all tenants)'
 */
export function sqlConsoleTarget(): SqlConsoleTarget {
  return {
    environment: 'Production',
    database: 'Shared platform database (D1 · all tenants)',
    scope:
      'Runs against the D1 shared by every site — a write affects all tenants. Protected platform tables are blocked and destructive statements confirm first.',
  };
}

/**
 * One SQL editor buffer in the multi-tab console — an independent query you can keep in
 * flight and switch between (each tab preserves its own text). Lets an operator hold a
 * SELECT, an EXPLAIN, and a schema lookup side by side without losing any of them.
 */
export interface QueryTab {
  id: string;
  title: string;
  sql: string;
}

/** Max concurrent query tabs — a soft cap so the strip stays usable + localStorage bounded. */
export const MAX_QUERY_TABS = 8;

/**
 * The title for the next new tab: `"Query N"` with the smallest positive N not already
 * taken by an existing `"Query N"` title (so closing #2 then adding reuses "Query 2").
 *
 * @param tabs - the current tabs
 * @returns the next default tab title
 * @example nextQueryTabTitle([{ id: 'a', title: 'Query 1', sql: '' }]) // 'Query 2'
 */
export function nextQueryTabTitle(tabs: readonly QueryTab[]): string {
  const used = new Set<number>();

  for (const t of tabs) {
    const m = /^Query (\d+)$/.exec(t.title);

    if (m) {
      used.add(Number(m[1]));
    }
  }

  let n = 1;

  while (used.has(n)) {
    n++;
  }

  return `Query ${n}`;
}

/**
 * Append a new tab seeded with `sql`, using the caller-supplied unique `id` (kept pure +
 * testable — the caller owns id generation). At {@link MAX_QUERY_TABS} the list is returned
 * unchanged and the last tab stays active, so the caller can surface "tab limit reached".
 *
 * @param tabs - current tabs
 * @param id - a unique id for the new tab
 * @param sql - initial buffer text (default empty)
 * @param title - optional explicit title (default the next `"Query N"`)
 * @returns `{ tabs, activeId }` — the new list + the id that should become active
 * @example addQueryTab([], 't1').activeId // 't1'
 */
export function addQueryTab(
  tabs: readonly QueryTab[],
  id: string,
  sql = '',
  title?: string,
): { tabs: QueryTab[]; activeId: string } {
  if (tabs.length >= MAX_QUERY_TABS) {
    return { tabs: [...tabs], activeId: tabs[tabs.length - 1]?.id ?? id };
  }

  const tab: QueryTab = { id, title: title ?? nextQueryTabTitle(tabs), sql };

  return { tabs: [...tabs, tab], activeId: id };
}

/**
 * Close the tab with `id`. NEVER returns an empty list — closing the last tab yields a
 * single fresh empty tab (using `freshId`). The newly-active tab is the closed tab's
 * neighbor (same index, clamped) so focus stays where the user was.
 *
 * @param tabs - current tabs
 * @param id - the tab to close
 * @param freshId - id to use if the last tab is closed (a fresh empty tab is created)
 * @returns `{ tabs, activeId }` — the remaining list + the id to activate
 * @example closeQueryTab([{id:'a',title:'Query 1',sql:''}], 'a', 'z').tabs.length // 1 (a fresh tab)
 */
export function closeQueryTab(
  tabs: readonly QueryTab[],
  id: string,
  freshId: string,
): { tabs: QueryTab[]; activeId: string } {
  const idx = tabs.findIndex((t) => t.id === id);

  if (idx === -1) {
    return { tabs: [...tabs], activeId: tabs[0]?.id ?? freshId };
  }

  const remaining = tabs.filter((t) => t.id !== id);

  if (remaining.length === 0) {
    const fresh: QueryTab = { id: freshId, title: 'Query 1', sql: '' };
    return { tabs: [fresh], activeId: freshId };
  }

  const nextIdx = Math.min(idx, remaining.length - 1);

  return { tabs: remaining, activeId: remaining[nextIdx]!.id };
}

/**
 * Immutably set the `sql` of the tab with `id` (a no-op copy when the id is absent). The
 * component calls this on every edit so the active tab always mirrors the live editor.
 *
 * @param tabs - current tabs
 * @param id - the tab to update
 * @param sql - the new buffer text
 * @returns a new tabs array with that tab's `sql` replaced
 */
export function updateQueryTabSql(tabs: readonly QueryTab[], id: string, sql: string): QueryTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, sql } : t));
}

/** A grid column-sort direction. */
export type SortDir = 'asc' | 'desc';

/** The active grid sort — a column key + direction (null = unsorted / original order). */
export interface GridSort {
  col: string;
  dir: SortDir;
}

/**
 * Next sort state for a 3-state column-header toggle: unsorted → asc → desc → unsorted.
 * Clicking a DIFFERENT column starts it at asc. Pure.
 *
 * @param current - the active sort (or null when unsorted)
 * @param col - the clicked column key
 * @returns the next {@link GridSort} or null (cleared)
 * @example nextSort(null, 'name') // { col: 'name', dir: 'asc' }
 * @example nextSort({ col: 'name', dir: 'asc' }, 'name') // { col: 'name', dir: 'desc' }
 * @example nextSort({ col: 'name', dir: 'desc' }, 'name') // null
 */
export function nextSort(current: GridSort | null, col: string): GridSort | null {
  if (!current || current.col !== col) {
    return { col, dir: 'asc' };
  }

  if (current.dir === 'asc') {
    return { col, dir: 'desc' };
  }

  return null;
}

/**
 * Map the grid's {@link GridSort} to the `PS_DATA_REQUEST` server-sort params (`orderBy`/`dir`). A
 * null sort → `{}` (the table's DEFAULT server order). The column is a display request only — the
 * WORKER allowlist-validates it against the table's columns before it can reach SQL — so nothing is
 * sanitised here. Pure.
 *
 * @example sortToParams({ col: 'created_at', dir: 'desc' }) // { orderBy: 'created_at', dir: 'desc' }
 * @example sortToParams(null) // {}
 */
export function sortToParams(sort: GridSort | null): { orderBy?: string; dir?: SortDir } {
  return sort ? { orderBy: sort.col, dir: sort.dir } : {};
}

/**
 * Map a search box value to the `PS_DATA_REQUEST` `search` param — trimmed, and OMITTED when blank so
 * an empty box means "no filter" (the default order + full `total`). The worker runs the actual
 * parameterized OR-of-LIKE over its allowlisted columns, so nothing is escaped here. Pure.
 *
 * @example browseSearchParam('  ada ') // { search: 'ada' }
 * @example browseSearchParam('')       // {}
 */
export function browseSearchParam(search: string | null | undefined): { search?: string } {
  const q = (search ?? '').trim();
  return q ? { search: q } : {};
}

/** The whole-table filter state of the browse grid: a text search + an exact single-column filter. */
export interface BrowseFilters {
  /** Whole-table OR-of-LIKE needle (see {@link browseSearchParam}). */
  search: string;

  /** Exact-match filter column (a table column name), or null when no column filter is active. */
  filterCol: string | null;

  /** Exact-match filter value. Only applied when {@link filterCol} is set AND this is non-empty. */
  filterVal: string;
}

/**
 * Map the browse {@link BrowseFilters} to the `PS_DATA_REQUEST` filter params. `search` is trimmed +
 * omitted when blank; `filterCol`/`filterVal` are sent together ONLY when a column is chosen AND the
 * value is non-empty (matching the worker's `buildColumnFilter`, which ignores a blank value). Both are
 * display requests — the WORKER allowlist-validates `filterCol` + parameterizes every value — so nothing
 * is escaped here. Pure.
 *
 * @example filtersToParams({ search: 'ada', filterCol: 'status', filterVal: 'active' })
 *   // { search: 'ada', filterCol: 'status', filterVal: 'active' }
 * @example filtersToParams({ search: '', filterCol: 'status', filterVal: '' }) // {}  (blank value → no filter)
 */
export function filtersToParams(f: BrowseFilters): {
  search?: string;
  filterCol?: string;
  filterVal?: string;
} {
  const out: { search?: string; filterCol?: string; filterVal?: string } = {
    ...browseSearchParam(f.search),
  };
  const col = (f.filterCol ?? '').trim();
  const val = (f.filterVal ?? '').trim();

  if (col && val) {
    out.filterCol = col;
    out.filterVal = val;
  }

  return out;
}

/** Numeric value of a cell when it's a finite number or a numeric string, else null. */
function cellAsNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }

  return null;
}

/** Whether a cell has "no value" for sort purposes (always sorted LAST, both directions). */
function cellIsEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Stable, type-aware sort of grid rows by one column. Both cells numeric (finite number or
 * numeric string) → NUMERIC compare (so '10' sorts after '2', not before). Otherwise a
 * case-insensitive string compare over {@link formatCellValue} (objects compare by their
 * compact JSON). null / undefined / '' always sort LAST regardless of direction — they're
 * "no value", not "smallest". Stable (original index breaks ties). Pure — returns a NEW
 * array; a null sort returns a copy in original order.
 *
 * @param rows - the grid rows
 * @param sort - the active sort, or null for original order
 * @returns a new, sorted array
 * @example sortRows([{ n: '10' }, { n: '2' }], { col: 'n', dir: 'asc' }) // [{n:'2'},{n:'10'}]
 */
export function sortRows(rows: readonly Record<string, unknown>[], sort: GridSort | null): Record<string, unknown>[] {
  if (!sort) {
    return rows.slice();
  }

  const { col, dir } = sort;
  const factor = dir === 'asc' ? 1 : -1;

  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const va = a.row[col];
      const vb = b.row[col];
      const ea = cellIsEmpty(va);
      const eb = cellIsEmpty(vb);

      if (ea && eb) {
        return a.i - b.i;
      }

      if (ea) {
        return 1;
      } // empties last, regardless of direction

      if (eb) {
        return -1;
      }

      const na = cellAsNumber(va);
      const nb = cellAsNumber(vb);
      let cmp: number;

      if (na !== null && nb !== null) {
        cmp = na - nb;
      } else {
        cmp = formatCellValue(va).toLowerCase().localeCompare(formatCellValue(vb).toLowerCase());
      }

      if (cmp === 0) {
        return a.i - b.i;
      } // stable

      return cmp * factor;
    })
    .map((d) => d.row);
}

/**
 * The RAW text to place on the clipboard for a single cell — NOT the display form. Scalars
 * copy as their plain string (`42`, `pageview`, `false`); objects as compact JSON; and
 * null / undefined / '' copy as an EMPTY string (there's nothing meaningful to copy — never
 * the display em-dash, which would paste a literal "—"). Never throws.
 *
 * @param value - the raw cell value
 * @returns the clipboard text (may be empty)
 * @example clipboardValue('a@x.com') // 'a@x.com'
 * @example clipboardValue({ a: 1 })  // '{"a":1}'
 * @example clipboardValue(null)      // ''
 */
export function clipboardValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/**
 * A whole row serialized as pretty (2-space) JSON for the "Copy row" action — the natural
 * "grab this record" gesture. Never throws (a cyclic row falls back to a shallow string map).
 *
 * @param row - one browse/result row
 * @returns pretty JSON text
 * @example rowJson({ email: 'a@x.com', n: 2 }) // '{\n  "email": "a@x.com",\n  "n": 2\n}'
 */
export function rowJson(row: Record<string, unknown>): string {
  try {
    return JSON.stringify(row, null, 2);
  } catch {
    const shallow: Record<string, string> = {};

    for (const k of Object.keys(row)) {
      shallow[k] = String(row[k]);
    }

    return JSON.stringify(shallow, null, 2);
  }
}

/**
 * Columns to RENDER in the browse grid — all columns minus the hidden set, ORDER PRESERVED.
 * A stale hidden entry (a column no longer in the table, e.g. left over in localStorage after a
 * schema change) is simply ignored. Hiding is VIEW-ONLY: the row-detail drill-down and the CSV/
 * JSON exports still use the full column set, so this never omits data — it's a scan aid for wide
 * tables that would otherwise force horizontal scrolling.
 *
 * @param all - every column the browse response returned, in display order
 * @param hidden - the columns the user chose to hide
 * @returns the visible columns, in `all`'s order
 * @example visibleColumns(['a', 'b', 'c'], ['b']) // ['a', 'c']
 */
export function visibleColumns(all: readonly string[], hidden: readonly string[]): string[] {
  const h = new Set(hidden);
  return all.filter((c) => !h.has(c));
}

/**
 * Toggle a column's visibility. Showing a column is always allowed; HIDING is refused when it
 * would leave zero visible columns (never a dead-end empty grid). Returns the new hidden set,
 * ordered by `all` for stable persistence, immutable (never mutates the input).
 *
 * @param hidden - the current hidden set
 * @param col - the column being toggled
 * @param all - every column in the table (to enforce the last-column guard + ordering)
 * @returns the next hidden set
 * @example toggleHiddenColumn([], 'b', ['a', 'b']) // ['b']
 * @example toggleHiddenColumn(['a'], 'b', ['a', 'b']) // ['a'] — refused; 'b' is the last visible
 */
export function toggleHiddenColumn(hidden: readonly string[], col: string, all: readonly string[]): string[] {
  const set = new Set(hidden);

  if (set.has(col)) {
    set.delete(col); // showing is always safe
  } else {
    const visibleCount = all.filter((c) => !set.has(c)).length;

    if (visibleCount <= 1) {
      return [...hidden];
    } // refuse — would empty the grid

    set.add(col);
  }

  return all.filter((c) => set.has(c));
}

/*
 * Typed row editors → parameterized statements.
 * The grid's "Add row" (and, later, Edit/Delete) build a PARAMETERIZED statement: identifiers are
 * validated + quoted, values are BOUND via ?1..?N — never concatenated into the SQL (the epic's
 * "parameterize values, never concatenate" mandate). The worker's /sql/exec-write path binds these
 * params server-side.
 */

/** Thrown when a typed row-editor input can't be coerced, or a statement can't be built safely. */
export class RowMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowMutationError';
  }
}

/** Which typed editor a cell uses — maps to how the raw text input is coerced before binding. */
export type CellInputKind = 'text' | 'number' | 'boolean' | 'null' | 'json';

/** A value ready to bind as a positional SQL param (SQLite storage classes we support from the UI). */
export type BoundValue = string | number | boolean | null;

/**
 * Infer the typed-editor `{ kind, value }` to PREFILL for an existing cell value — the inverse of
 * {@link coerceCellInput}. Used to seed the Edit + Duplicate editors from a browsed row: null/undefined
 * → `null` editor; number/boolean → their editors; an object → `json` (pretty-printed text); anything
 * else → `text`. Pure.
 *
 * @param value - the raw cell value from a browsed row
 * @returns the editor `kind` + the string to prefill its input with
 * @example inferCellEditor(42)          // { kind: 'number', value: '42' }
 * @example inferCellEditor(null)        // { kind: 'null', value: '' }
 * @example inferCellEditor({ a: 1 })    // { kind: 'json', value: '{"a":1}' }
 */
export function inferCellEditor(value: unknown): { kind: CellInputKind; value: string } {
  if (value === null || value === undefined) {
    return { kind: 'null', value: '' };
  }

  if (typeof value === 'number') {
    return { kind: 'number', value: String(value) };
  }

  if (typeof value === 'boolean') {
    return { kind: 'boolean', value: value ? 'true' : 'false' };
  }

  if (typeof value === 'object') {
    let text: string;

    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }

    return { kind: 'json', value: text };
  }

  return { kind: 'text', value: String(value) };
}

/**
 * Coerce a typed row-editor input into a value ready to BIND (never string-interpolated).
 * `null` ignores the raw text; `number` rejects blank/NaN; `boolean` accepts true/false/1/0/yes/no;
 * `json` validates the text parses and binds the ORIGINAL text (SQLite has no JSON type — JSON is
 * stored as TEXT); `text` binds the raw string verbatim. Impure only in that it throws on bad input.
 *
 * @param kind - the typed editor the cell used
 * @param raw - the raw text the user typed
 * @returns the value to bind (string | number | boolean | null)
 * @throws {RowMutationError} when a number is blank/NaN or JSON is malformed
 * @example coerceCellInput('number', '42')      // 42
 * @example coerceCellInput('boolean', 'yes')    // true
 * @example coerceCellInput('null', 'anything')  // null
 * @example coerceCellInput('json', '{"a":1}')   // '{"a":1}'
 */
export function coerceCellInput(kind: CellInputKind, raw: string): BoundValue {
  switch (kind) {
    case 'null':
      return null;
    case 'number': {
      const t = (raw ?? '').trim();

      if (t === '') {
        throw new RowMutationError('Enter a number, or switch the cell type to NULL.');
      }

      const n = Number(t);

      if (!Number.isFinite(n)) {
        throw new RowMutationError(`"${raw}" is not a valid number.`);
      }

      return n;
    }
    case 'boolean': {
      const t = (raw ?? '').trim().toLowerCase();

      if (t === 'true' || t === '1' || t === 'yes') {
        return true;
      }

      if (t === 'false' || t === '0' || t === 'no' || t === '') {
        return false;
      }

      throw new RowMutationError(`"${raw}" is not a boolean (use true/false).`);
    }
    case 'json': {
      const t = (raw ?? '').trim();

      if (t === '') {
        throw new RowMutationError('Enter JSON, or switch the cell type to NULL.');
      }

      try {
        JSON.parse(t);
      } catch {
        throw new RowMutationError('That is not valid JSON.');
      }

      return t; // store validated JSON as TEXT
    }
    case 'text':
    default:
      return raw ?? '';
  }
}

/** A parameterized statement: `?1..?N` placeholders in `sql`, values in `params` (bind order). */
export interface ParameterizedStatement {
  /** The SQL with quoted identifiers and `?1..?N` placeholders — safe to log/preview. */
  sql: string;

  /** The values to bind, in `?1..?N` order. Never interpolated into `sql`. */
  params: BoundValue[];
}

/**
 * Build a PARAMETERIZED `INSERT` for the grid's "Add row". Every identifier (table + columns) is
 * validated against the SQLite identifier grammar and double-quoted; every value becomes a bound
 * `?N` param — nothing is concatenated. Columns the user leaves at "default" are omitted so column
 * defaults / autoincrement apply. Pure.
 *
 * @param table - the target table name (validated as an identifier)
 * @param columns - the columns to write (each validated; must be non-empty and match `values`)
 * @param values - the already-coerced values to bind, aligned to `columns`
 * @returns `{ sql, params }` — a parameterized INSERT
 * @throws {RowMutationError} when the table/a column is not a valid identifier, or nothing to insert
 * @example buildInsertStatement('todos', ['title', 'done'], ['Buy milk', 0])
 *   // { sql: 'INSERT INTO "todos" ("title", "done") VALUES (?1, ?2)', params: ['Buy milk', 0] }
 */
export function buildInsertStatement(
  table: string,
  columns: readonly string[],
  values: readonly BoundValue[],
): ParameterizedStatement {
  const t = (table ?? '').trim();

  if (!IDENT_RE.test(t)) {
    throw new RowMutationError('Pick a table with a valid name before adding a row.');
  }

  if (columns.length === 0) {
    throw new RowMutationError('Set at least one column value (or leave all at default) to add a row.');
  }

  if (columns.length !== values.length) {
    throw new RowMutationError('Internal: column/value count mismatch.');
  }

  for (const col of columns) {
    if (!IDENT_RE.test((col ?? '').trim())) {
      throw new RowMutationError(`"${col}" is not a valid column name.`);
    }
  }

  const colList = columns.map((c) => `"${c.trim()}"`).join(', ');
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(', ');

  return {
    sql: `INSERT INTO "${t}" (${colList}) VALUES (${placeholders})`,
    params: [...values],
  };
}

/**
 * Build a PARAMETERIZED `DELETE` scoped to ONE row by its primary key. Every identifier (table +
 * PK columns) is validated + double-quoted; every PK value becomes a bound `?N` param — a
 * whole-table `DELETE` is impossible (a non-empty PK predicate is required). Composite keys are
 * supported (each PK column ANDed). Pure.
 *
 * @param table - the target table (validated as an identifier)
 * @param pkColumns - the row's primary-key column(s), in order (from `pkFromTableInfo`)
 * @param row - the row object; each PK column's value is read + bound as the WHERE predicate
 * @returns `{ sql, params }` — a single-row parameterized DELETE
 * @throws {RowMutationError} when the table/a PK column is invalid, there is NO primary key, or a
 *   PK value is null/undefined (the row can't be targeted safely → the caller keeps it read-only)
 * @example buildDeleteByPk('todos', ['id'], { id: 42, title: 'x' })
 *   // { sql: 'DELETE FROM "todos" WHERE "id" = ?1', params: [42] }
 */
/**
 * Build a PK `WHERE` predicate (`"col" = ?N AND …`) with bind params starting at `startIndex`.
 * Shared by DELETE + UPDATE so both target EXACTLY one row by its key. Validates each PK identifier
 * + requires a scalar (string/number) value for every key column. Pure.
 *
 * @param pkColumns - the primary-key column(s), in order
 * @param row - the row supplying each PK value
 * @param startIndex - the `?N` index for the FIRST predicate param (1 for DELETE, 2 for UPDATE after SET)
 * @returns `{ clauses, values }` — the ANDed predicate fragments + their bind values, in order
 * @throws {RowMutationError} when there is NO primary key, or a PK column is invalid / missing / non-scalar
 */
function buildPkPredicate(
  pkColumns: readonly string[],
  row: Record<string, unknown>,
  startIndex: number,
): { clauses: string[]; values: BoundValue[] } {
  if (pkColumns.length === 0) {
    throw new RowMutationError('This table has no primary key, so a row cannot be safely targeted.');
  }

  const values: BoundValue[] = [];
  const clauses = pkColumns.map((col, i) => {
    const c = (col ?? '').trim();

    if (!IDENT_RE.test(c)) {
      throw new RowMutationError(`"${col}" is not a valid primary-key column.`);
    }

    const value = row[c];

    if (value === undefined || value === null) {
      throw new RowMutationError(`This row has no "${c}" value — it cannot be targeted safely.`);
    }

    // Only string / number are safe, stable PK predicates (a boolean/JSON PK is not a real key).
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new RowMutationError(`"${c}" is not a stable key value — this row can't be targeted safely.`);
    }

    values.push(value);

    return `"${c}" = ?${startIndex + i}`;
  });

  return { clauses, values };
}

export function buildDeleteByPk(
  table: string,
  pkColumns: readonly string[],
  row: Record<string, unknown>,
): ParameterizedStatement {
  const t = (table ?? '').trim();

  if (!IDENT_RE.test(t)) {
    throw new RowMutationError('This table has an unsafe name — delete is disabled.');
  }

  const { clauses, values } = buildPkPredicate(pkColumns, row, 1);

  return {
    sql: `DELETE FROM "${t}" WHERE ${clauses.join(' AND ')}`,
    params: values,
  };
}

/** Max rows a single bulk-delete may target — a fat-finger guard + a bound on statement size. */
export const MAX_BULK_DELETE = 100;

/**
 * A stable per-row selection key from its PK value(s) — used to track a bulk selection across
 *  re-sorts/filters. Returns null when the row has no usable PK (→ not selectable). Pure.
 */
export function rowPkKey(row: Record<string, unknown>, pkColumns: readonly string[]): string | null {
  if (pkColumns.length === 0) {
    return null;
  }

  const parts: unknown[] = [];

  for (const col of pkColumns) {
    const v = row[(col ?? '').trim()];

    if (v === undefined || v === null || (typeof v !== 'string' && typeof v !== 'number')) {
      return null; // no stable scalar key → not safely targetable
    }

    parts.push(v);
  }

  return JSON.stringify(parts);
}

/**
 * Build a PARAMETERIZED bulk `DELETE` targeting MANY rows by primary key. Single-column PK →
 * `WHERE "id" IN (?1, ?2, …)`; composite PK → `WHERE ("a"=?1 AND "b"=?2) OR (…) …`. Every identifier
 * is validated + quoted; every PK value is a bound `?N` — nothing is concatenated, and a non-empty
 * PK predicate is required so a whole-table wipe is impossible. Capped at {@link MAX_BULK_DELETE}. Pure.
 *
 * @param table - the target table (validated as an identifier)
 * @param pkColumns - the primary-key column(s), in order (from `pkFromTableInfo`)
 * @param rows - the selected rows (each supplies its PK values)
 * @param cap - max rows per batch (default {@link MAX_BULK_DELETE})
 * @returns `{ sql, params }` — a single parameterized bulk DELETE
 * @throws {RowMutationError} when the table/a PK column is invalid, there is NO primary key, the
 *   selection is empty or exceeds `cap`, or a row lacks a stable scalar PK value
 * @example buildBulkDeleteByPk('todos', ['id'], [{ id: 1 }, { id: 2 }])
 *   // { sql: 'DELETE FROM "todos" WHERE "id" IN (?1, ?2)', params: [1, 2] }
 */
export function buildBulkDeleteByPk(
  table: string,
  pkColumns: readonly string[],
  rows: readonly Record<string, unknown>[],
  cap: number = MAX_BULK_DELETE,
): ParameterizedStatement {
  const t = (table ?? '').trim();

  if (!IDENT_RE.test(t)) {
    throw new RowMutationError('This table has an unsafe name — delete is disabled.');
  }

  if (pkColumns.length === 0) {
    throw new RowMutationError('This table has no primary key, so rows cannot be safely targeted.');
  }

  if (rows.length === 0) {
    throw new RowMutationError('Select at least one row to delete.');
  }

  if (rows.length > cap) {
    throw new RowMutationError(`Select at most ${cap} rows at a time (you selected ${rows.length}).`);
  }

  const params: BoundValue[] = [];

  // Single-column PK → a clean `IN (…)` list.
  if (pkColumns.length === 1) {
    const col = (pkColumns[0] ?? '').trim();

    if (!IDENT_RE.test(col)) {
      throw new RowMutationError(`"${pkColumns[0]}" is not a valid primary-key column.`);
    }

    const placeholders = rows.map((row, i) => {
      const v = row[col];

      if (v === undefined || v === null) {
        throw new RowMutationError(`A selected row has no "${col}" value — it can't be targeted safely.`);
      }

      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new RowMutationError(`"${col}" is not a stable key value on a selected row.`);
      }

      params.push(v);

      return `?${i + 1}`;
    });

    return { sql: `DELETE FROM "${t}" WHERE "${col}" IN (${placeholders.join(', ')})`, params };
  }

  // Composite PK → OR of per-row (col=? AND col=?) groups, param indices threaded across rows.
  const groups = rows.map((row) => {
    const { clauses, values } = buildPkPredicate(pkColumns, row, params.length + 1);
    params.push(...values);

    return `(${clauses.join(' AND ')})`;
  });

  return { sql: `DELETE FROM "${t}" WHERE ${groups.join(' OR ')}`, params };
}

/**
 * Build a PARAMETERIZED single-column `UPDATE` scoped to ONE row by its primary key. The new value
 * is bound as `?1`; the PK predicate follows (`?2…`) so the statement can only ever affect the one
 * keyed row. Identifiers are validated + double-quoted; the value is bound, never concatenated. Pure.
 *
 * A PK column itself is NOT editable here (it's the predicate — changing identity is out of scope);
 * attempting it throws so the caller keeps the key read-only.
 *
 * @param table - the target table (validated as an identifier)
 * @param pkColumns - the row's primary-key column(s), in order (from `pkFromTableInfo`)
 * @param row - the row supplying the PK predicate values
 * @param setColumn - the (non-PK) column to update (validated as an identifier)
 * @param setValue - the already-coerced new value to bind
 * @returns `{ sql, params }` — a single-row, single-column parameterized UPDATE
 * @throws {RowMutationError} when the table/column is invalid, `setColumn` is a PK column, there is
 *   no primary key, or a PK value is missing/non-scalar
 * @example buildUpdateByPk('todos', ['id'], { id: 42 }, 'title', 'Buy oat milk')
 *   // { sql: 'UPDATE "todos" SET "title" = ?1 WHERE "id" = ?2', params: ['Buy oat milk', 42] }
 */
export function buildUpdateByPk(
  table: string,
  pkColumns: readonly string[],
  row: Record<string, unknown>,
  setColumn: string,
  setValue: BoundValue,
): ParameterizedStatement {
  const t = (table ?? '').trim();

  if (!IDENT_RE.test(t)) {
    throw new RowMutationError('This table has an unsafe name — edit is disabled.');
  }

  const setCol = (setColumn ?? '').trim();

  if (!IDENT_RE.test(setCol)) {
    throw new RowMutationError(`"${setColumn}" is not a valid column name.`);
  }

  if (pkColumns.some((c) => (c ?? '').trim() === setCol)) {
    throw new RowMutationError(`"${setCol}" is a primary-key column — the key can't be edited here.`);
  }

  // SET value is ?1; the PK predicate binds from ?2 onward → the statement targets exactly one row.
  const { clauses, values } = buildPkPredicate(pkColumns, row, 2);

  return {
    sql: `UPDATE "${t}" SET "${setCol}" = ?1 WHERE ${clauses.join(' AND ')}`,
    params: [setValue, ...values],
  };
}

// ── AI SQL assistant (natural-language → SQL) ────────────────────────────────

/** Max length of a natural-language question the "Ask AI" box will send. */
export const MAX_AI_QUESTION_LEN = 1000;

/**
 * Turn a Workers-AI model id into a short, human label for display next to
 * AI-generated SQL. Strips the vendor path + runtime-quantization suffixes
 * (`instruct` / `fp8` / `fast` / `awq` / …) and title-cases the rest, keeping
 * a trailing size unit uppercased (`70b` → `70B`). Unknown shapes degrade to
 * the last path segment so it never throws or shows an empty label.
 *
 * @param model - the raw model id (e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
 * @returns a friendly label (e.g. `Llama 3.3 70B`); `'AI'` when the id is blank
 * @example friendlyModelLabel('@cf/meta/llama-3.3-70b-instruct-fp8-fast') // 'Llama 3.3 70B'
 * @example friendlyModelLabel('') // 'AI'
 */
export function friendlyModelLabel(model: string): string {
  const raw = (model ?? '').trim();

  if (!raw) {
    return 'AI';
  }

  const last = raw.split('/').filter(Boolean).pop() ?? raw;
  const DROP = new Set(['instruct', 'fp8', 'fast', 'awq', 'int8', 'lora', 'chat', 'hf']);
  const tokens = last
    .split('-')
    .filter(Boolean)
    .filter((t) => !DROP.has(t.toLowerCase()));

  if (tokens.length === 0) {
    return last;
  }

  return tokens
    .map((t) => {
      // A size token like `70b` / `8m` → uppercase the trailing unit letter.
      if (/^\d+(?:\.\d+)?[a-z]$/i.test(t)) {
        return t.slice(0, -1) + t.slice(-1).toUpperCase();
      }

      // A pure version token (`3.3`) stays as-is; a word gets Title Case.
      return /^[\d.]+$/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join(' ');
}

/**
 * Guard a natural-language question before it is sent to the NL→SQL endpoint.
 * A blank question just disables the control (no reason surfaced, like Run);
 * an over-long one returns a human reason so the button explains itself rather
 * than failing silently (per the "never a doomed/dead control" rule).
 *
 * @param question - the raw text from the Ask-AI box
 * @returns `{ ok, reason? }` — `ok:false` with no reason ⇒ empty; with a reason ⇒ show it
 * @example canAskAi('  ') // { ok: false }
 * @example canAskAi('list the 10 newest form submissions') // { ok: true }
 */
export function canAskAi(question: string): { ok: boolean; reason?: string } {
  const q = (question ?? '').trim();

  if (!q) {
    return { ok: false };
  }

  if (q.length > MAX_AI_QUESTION_LEN) {
    return { ok: false, reason: `Question is too long — keep it under ${MAX_AI_QUESTION_LEN} characters.` };
  }

  return { ok: true };
}

// ── Query-result mini-charts ─────────────────────────────────────────────────

/** A result is chartable only when it is summary-sized (a big raw dump is not a chart). */
export const MAX_CHART_ROWS = 60;

/** A chartable result: one label (category) column + one or more numeric value columns. */
export interface ChartSpec {
  labelCol: string;
  valueCols: string[];
}

/** One `{label, value}` point of a mini-chart series. */
export interface ChartPoint {
  label: string;
  value: number;
}

/** True when EVERY non-null value in `col` is a finite number (and at least one value exists). */
function columnIsNumeric(rows: readonly Record<string, unknown>[], col: string): boolean {
  let sawValue = false;

  for (const r of rows) {
    const v = r[col];

    if (v === null || v === undefined || v === '') {
      continue;
    }

    sawValue = true;

    const ok =
      typeof v === 'number'
        ? Number.isFinite(v)
        : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

    if (!ok) {
      return false;
    }
  }

  return sawValue;
}

/**
 * Decide whether a SQL result can be rendered as a bar chart, and how. A result is chartable when
 * it is summary-sized (1..{@link MAX_CHART_ROWS} rows) and has BOTH a label column (the first
 * non-numeric column, or the first column when all are numeric — e.g. a `year` axis) AND at least
 * one OTHER numeric column to plot. Pure — inspects the already-fetched rows, never re-queries.
 *
 * @returns `{ labelCol, valueCols }` when chartable, else `null` (a raw dump / no numeric / too big)
 * @example detectChartable(['country','n'], [{country:'US',n:5}]) // { labelCol:'country', valueCols:['n'] }
 * @example detectChartable(['id'], [{id:1}]) // null (only one numeric column, nothing to plot)
 */
export function detectChartable(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): ChartSpec | null {
  if (columns.length < 2 || rows.length < 1 || rows.length > MAX_CHART_ROWS) {
    return null;
  }

  const numeric = columns.filter((c) => columnIsNumeric(rows, c));

  if (numeric.length === 0) {
    return null;
  }

  const numericSet = new Set(numeric);
  const labelCol = columns.find((c) => !numericSet.has(c)) ?? columns[0];
  const valueCols = numeric.filter((c) => c !== labelCol);

  if (valueCols.length === 0) {
    return null;
  }

  return { labelCol, valueCols };
}

/**
 * Extract the `{label, value}` series for one value column from the result rows. Null/blank labels
 * render as `∅`; non-finite values are dropped (never a fabricated 0). Pure.
 *
 * @example buildChartSeries([{country:'US',n:5}], 'country', 'n') // [{label:'US', value:5}]
 */
export function buildChartSeries(
  rows: readonly Record<string, unknown>[],
  labelCol: string,
  valueCol: string,
): ChartPoint[] {
  const out: ChartPoint[] = [];

  for (const r of rows) {
    const raw = r[labelCol];
    const label = raw === null || raw === undefined || raw === '' ? '∅' : String(raw);
    const value = Number(r[valueCol]);

    if (Number.isFinite(value)) {
      out.push({ label, value });
    }
  }

  return out;
}
