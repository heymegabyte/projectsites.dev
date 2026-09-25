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

/**
 * Build parameter-safe `INSERT` statements from CSV text for `table` — the import counterpart to
 * {@link toCsv}. Row 1 is the header (column names); each later row → one INSERT. Table + column
 * names are identifier-gated (rejects injection via identifiers); values are single-quote-escaped
 * (`'` → `''`); an empty cell becomes `NULL` (not `''`). Non-destructive by nature — only adds rows.
 * Pure — the panel runs the returned statements through its existing write rail.
 *
 * @param csvText - the CSV to import (header + ≥1 data row)
 * @param table - target table name (SQLite identifier)
 * @returns `{ inserts, columns, rowCount }`
 * @throws {CsvImportError} empty/one-row input, bad table/column identifier, or a row whose
 *   column count differs from the header.
 * @example csvToInserts('a,b\n1,', 't').inserts // ['INSERT INTO "t" ("a", "b") VALUES (\'1\', NULL);']
 */
export function csvToInserts(
  csvText: string,
  table: string,
): { inserts: string[]; columns: string[]; rowCount: number } {
  const t = String(table ?? '').trim();

  if (!IDENT_RE.test(t)) {
    throw new CsvImportError('Enter a valid table name (letters, digits, underscore; not starting with a digit).');
  }

  const rows = parseCsv(csvText);

  if (rows.length < 2) {
    throw new CsvImportError('CSV needs a header row and at least one data row.');
  }

  const columns = rows[0].map((c) => c.trim());

  if (columns.some((c) => !IDENT_RE.test(c))) {
    throw new CsvImportError('Every header column must be a valid identifier.');
  }

  const colList = columns.map((c) => `"${c}"`).join(', ');
  const inserts = rows.slice(1).map((r, idx) => {
    if (r.length !== columns.length) {
      throw new CsvImportError(`Row ${idx + 1} has ${r.length} value(s); the header has ${columns.length}.`);
    }

    const vals = r.map((v) => (v === '' ? 'NULL' : `'${v.replace(/'/g, "''")}'`)).join(', ');

    return `INSERT INTO "${t}" (${colList}) VALUES (${vals});`;
  });

  return { inserts, columns, rowCount: inserts.length };
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
