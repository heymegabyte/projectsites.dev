/**
 * @file Pure logic for getting DATA INTO a site's OWN per-site Cloudflare D1 (FIRE 6).
 *
 * @remarks
 * Three surfaces in the Database tab feed rows into the site's OWN D1 — CSV/JSON **import**, AI **table-seeding**,
 * and the public **form builder** — and they ALL write through the ONE proven per-site exec rail the grid + SQL
 * navigator + schema builder already use: `PS_RES_MUTATE { kind:'d1', action:'exec', input:{ sql, params }, confirm:true }`
 * → the worker's confirm-gated, single-statement, PARAMETERIZED executor bound to the site's SERVER-RESOLVED D1 id
 * (`libs/features/data_resource_registry/adapters/d1.ts`). The caller NEVER supplies a CF id (SECURITY-INVARIANTS
 * INV-1/INV-9); this module never touches the shared platform DB or another site's D1.
 *
 * SAFETY (the load-bearing reason this is its own tested module):
 *  - **Values are BOUND, never concatenated.** Every cell rides as a positional `?` param — a hostile
 *    `'); DROP TABLE users; --` value is an inert string param, never injected SQL (the exact deviation the old
 *    retired `csvToInserts` had — it single-quote-ESCAPED values INTO the string). Only bound VALUES are
 *    interpolated; identifiers (table + column names) are validated with {@link isSafeIdent} and double-quoted via
 *    the proven `schema-ddl` `quoteIdent`, never parameterized (D1 REST can't parameterize an identifier).
 *  - **Single-statement + param-capped chunking.** The D1 REST `/query` plane is single-statement and has a bound-
 *    param ceiling, so a multi-row insert is emitted as ONE `INSERT INTO "t" (cols) VALUES (?,?),(?,?)…` per chunk,
 *    with each chunk sized so `rows * columns <= {@link MAX_BOUND_PARAMS}`. Big files ⇒ many chunks, each a legal
 *    single statement.
 *  - **Empty cell → bound `null`** (not `''`) so an empty CSV field is a real SQL NULL.
 *
 * These helpers are PURE (no React, no bridge, no fetch) so they unit-test in isolation: CSV/JSON parsing, header
 * inference, per-column type detection, value coercion, the chunked parameterized INSERT plan, the AI-seed prompt
 * construction + robust row extraction, and the form-builder's create-table plan. The panels
 * ({@link module:app/components/workbench/ImportPanel}, `AiSeedPanel`, `FormBuilder`) own only the UI + the bridge
 * round-trip.
 */
import { buildCreateTable, DdlError, quoteIdent, type ColumnSpec } from './schema-ddl';

// ── Identifier safety (mirrors the worker's `site_data_db.ts` isSafeIdent contract EXACTLY) ───────────

/**
 * A SQLite identifier we will double-quote into DDL/DML. Mirrors the worker's `SAFE_IDENT_RE`
 * (`schema-ddl.ts` + `site_data_db.ts`) so the client rejects a hostile table/column name BEFORE it ever
 * reaches the exec rail (defense-in-depth — the worker validates again). Deliberately conservative: starts
 * with a letter/underscore, then letters/digits/underscore/`$`, ≤64 chars.
 */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** True when `name` is a non-empty, ≤64-char SQLite identifier safe to double-quote into SQL. */
export function isSafeIdent(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && SAFE_IDENT_RE.test(name);
}

/**
 * Coerce an arbitrary source header ("First Name", "e-mail!", "2024 total", "") into a safe SQLite column
 * identifier: lower-case, non-alnum → `_`, collapse repeats, trim underscores, prefix `col_` when it would
 * start with a digit or be empty. Deterministic + idempotent so a preview and the real import agree.
 *
 * @param header - the raw source column header (or a synthetic name for a headerless file)
 * @returns a safe identifier (never empty; falls back to `column` then de-duplicated by the caller)
 */
export function slugifyColumnName(header: string): string {
  const base = String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_$]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (base.length === 0) {
    return 'column';
  }

  // A leading digit is illegal for an identifier — prefix it.
  const prefixed = /^[0-9]/.test(base) ? `col_${base}` : base;

  return prefixed.slice(0, 64);
}

/**
 * De-duplicate a list of proposed column names (case-insensitive), appending `_2`, `_3`, … to collisions so
 * a CREATE TABLE never fails on "duplicate column" and an import always maps 1:1. Preserves order.
 *
 * @param names - proposed identifiers (already slugified)
 * @returns the same length, every entry unique (case-insensitive)
 */
export function dedupeColumnNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];

  for (const raw of names) {
    const key = raw.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    out.push(count === 0 ? raw : `${raw}_${count + 1}`.slice(0, 64));
  }

  return out;
}

// ── CSV parsing (RFC 4180 — quoted fields, embedded commas/newlines/quotes, CRLF) ────────────────────

/** A parsed delimited file: the header row (may be synthetic) + the data rows (each a string cell array). */
export interface ParsedGrid {
  /** Column headers (from the first row, or synthetic `column_1…` when `hasHeader` is false). */
  readonly headers: string[];

  /** Data rows — each an array of raw string cells, right-padded / left-trimmed to `headers.length`. */
  readonly rows: string[][];
}

/**
 * Parse CSV text into a {@link ParsedGrid}. A proper state-machine parser (NOT `split(',')`): handles
 * double-quoted fields, commas + newlines INSIDE quotes, escaped quotes (`""`), and both `\n` and `\r\n`
 * line endings. A ragged row is normalized to the header width (missing cells → `''`, extra cells dropped).
 *
 * @param text - the raw CSV text
 * @param opts.hasHeader - when true (default) the first row is headers; when false, synthetic `column_N` headers
 * @param opts.delimiter - field delimiter (default `,`; pass `\t` for TSV)
 * @returns the parsed grid (empty `rows` for header-only or empty input)
 */
export function parseCsv(text: string, opts: { hasHeader?: boolean; delimiter?: string } = {}): ParsedGrid {
  const hasHeader = opts.hasHeader ?? true;
  const delimiter = opts.delimiter ?? ',';
  const records = parseCsvRecords(text, delimiter);

  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  let headers: string[];
  let dataRows: string[][];

  if (hasHeader) {
    headers = records[0].map((h, i) => (h.trim().length > 0 ? h.trim() : `column_${i + 1}`));
    dataRows = records.slice(1);
  } else {
    const width = records.reduce((max, r) => Math.max(max, r.length), 0);
    headers = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
    dataRows = records;
  }

  const width = headers.length;
  const rows = dataRows.map((r) => normalizeRowWidth(r, width));

  return { headers, rows };
}

/** Normalize one row to exactly `width` cells (pad short with `''`, drop overflow). */
function normalizeRowWidth(row: string[], width: number): string[] {
  if (row.length === width) {
    return row;
  }

  if (row.length < width) {
    return [...row, ...Array<string>(width - row.length).fill('')];
  }

  return row.slice(0, width);
}

/**
 * The low-level RFC-4180 record splitter: text → array of raw cell arrays. Skips a final trailing blank line.
 * A row that is a SINGLE empty cell (a blank line) is dropped so a trailing newline doesn't create a phantom row.
 */
function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };

  const pushRow = (): void => {
    pushField();

    // Drop a row that is a single empty field (a blank line).
    if (!(row.length === 1 && row[0] === '')) {
      records.push(row);
    }

    row = [];
  };

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }

        inQuotes = false;
        i += 1;
        continue;
      }

      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }

    if (ch === '\r') {
      // \r\n or lone \r → row break.
      pushRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // Flush the last field/row if the file didn't end on a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return records;
}

// ── JSON parsing (array of flat objects, or a single object) → a grid ────────────────────────────────

/**
 * Parse JSON text expected to be an ARRAY of flat objects (the common export shape) into a {@link ParsedGrid}.
 * The header set is the UNION of every object's keys (in first-seen order); a missing key in a given row → `''`.
 * A single top-level object is treated as a one-row array. Nested objects/arrays in a cell are JSON-stringified
 * (so the value round-trips as text). Throws a typed {@link IngestError} on invalid JSON or a non-object shape.
 *
 * @param text - the raw JSON text
 * @returns the parsed grid
 * @throws {IngestError} `invalid_json` / `not_a_record_array`
 */
export function parseJsonRows(text: string): ParsedGrid {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new IngestError('invalid_json', err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON.');
  }

  const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];

  if (arr.length === 0) {
    if (Array.isArray(parsed)) {
      return { headers: [], rows: [] };
    }

    throw new IngestError('not_a_record_array', 'Expected a JSON array of objects (or a single object).');
  }

  const headerOrder: string[] = [];
  const headerSet = new Set<string>();

  for (const item of arr) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new IngestError('not_a_record_array', 'Every item must be a flat object (no arrays or primitives).');
    }

    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!headerSet.has(key)) {
        headerSet.add(key);
        headerOrder.push(key);
      }
    }
  }

  const rows = arr.map((item) => {
    const rec = item as Record<string, unknown>;
    return headerOrder.map((key) => cellToString(rec[key]));
  });

  return { headers: headerOrder, rows };
}

/** Render a JSON value as a grid cell string: primitives as-is, null/undefined → '', object/array → JSON. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Per-column type detection + value coercion ───────────────────────────────────────────────────────

/** A detected SQLite storage class for an import column. Mirrors {@link ColumnSpec.type} minus BLOB. */
export type DetectedType = 'INTEGER' | 'REAL' | 'TEXT';

/** A strict integer literal (optional sign, digits only) — SQLite INTEGER. */
const INTEGER_RE = /^[+-]?\d+$/;

/** A decimal / scientific-notation number literal — SQLite REAL. Rejects `Infinity`/`NaN`/bare `.`. */
const REAL_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i;

/**
 * Detect the SQLite storage class for a column from its sampled cell values (ignoring blanks). INTEGER only if
 * EVERY non-blank value is a strict integer; REAL if every value is numeric (int or decimal) but not all integer;
 * TEXT otherwise (the safe default — any value fits TEXT). An all-blank column → TEXT.
 *
 * @param values - the column's raw string cells (across the sampled rows)
 * @returns the detected storage class
 */
export function detectColumnType(values: readonly string[]): DetectedType {
  let sawValue = false;
  let allInteger = true;
  let allNumeric = true;

  for (const raw of values) {
    const v = (raw ?? '').trim();

    if (v.length === 0) {
      continue; // blanks don't constrain the type
    }

    sawValue = true;

    if (!INTEGER_RE.test(v)) {
      allInteger = false;
    }

    if (!REAL_RE.test(v)) {
      allNumeric = false;
    }

    if (!allNumeric) {
      break; // TEXT is the floor — no point scanning further
    }
  }

  if (!sawValue) {
    return 'TEXT';
  }

  if (allInteger) {
    return 'INTEGER';
  }

  if (allNumeric) {
    return 'REAL';
  }

  return 'TEXT';
}

/**
 * Coerce ONE raw string cell into the bound parameter VALUE for its column type. An empty/blank cell → `null`
 * (a real SQL NULL, never `''`). For INTEGER/REAL a well-formed numeric string → a JS number; a malformed one
 * falls back to the raw string (bound as text — the column is TEXT-affinity-tolerant and the user sees the
 * literal). TEXT → the raw string. The result is always a legal D1 bound param (`string | number | null`).
 *
 * @param raw - the raw cell string
 * @param type - the target column's detected/chosen storage class
 * @returns the bound parameter value
 */
export function coerceValue(raw: string, type: DetectedType): string | number | null {
  const v = (raw ?? '').trim();

  if (v.length === 0) {
    return null;
  }

  if (type === 'INTEGER' && INTEGER_RE.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v; // out-of-safe-range → keep the exact string
  }

  if (type === 'REAL' && REAL_RE.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }

  return type === 'TEXT' ? raw : v;
}

// ── Column mapping (source column → target column, with per-column type + include toggle) ─────────────

/** One column's mapping from the source grid into the target table. */
export interface ColumnMapping {
  /** Index into {@link ParsedGrid.headers} this mapping reads from. */
  readonly sourceIndex: number;

  /** The source header text (for display). */
  readonly sourceHeader: string;

  /** The target D1 column identifier (safe ident). */
  readonly targetColumn: string;

  /** The chosen storage class for this column. */
  readonly type: DetectedType;

  /** When false, this column is skipped (not created / not inserted). */
  readonly include: boolean;
}

/**
 * Build a default column mapping for a parsed grid: each source header → a slugified, de-duplicated target
 * column, with a type detected from the (sampled) rows, all included. The panel lets the owner tweak the
 * target name, type, and include flag before importing.
 *
 * @param grid - the parsed source grid
 * @param sampleRows - how many rows to sample for type detection (default 200 — enough to be confident, cheap)
 * @returns one {@link ColumnMapping} per source header
 */
export function inferMappings(grid: ParsedGrid, sampleRows = 200): ColumnMapping[] {
  const targets = dedupeColumnNames(grid.headers.map((h) => slugifyColumnName(h)));
  const sample = grid.rows.slice(0, Math.max(1, sampleRows));

  return grid.headers.map((header, sourceIndex) => {
    const columnValues = sample.map((r) => r[sourceIndex] ?? '');
    return {
      sourceIndex,
      sourceHeader: header,
      targetColumn: targets[sourceIndex],
      type: detectColumnType(columnValues),
      include: true,
    };
  });
}

// ── The chunked, parameterized INSERT plan (the safety keystone) ─────────────────────────────────────

/** The bound-param ceiling per statement. D1's REST `/query` plane caps bound params; stay comfortably under. */
export const MAX_BOUND_PARAMS = 100;

/** One executable batch: a single parameterized `INSERT … VALUES (?,?),(?,?)…` + its flat bound-value list. */
export interface InsertBatch {
  /** The single SQL statement (no trailing `;`): `INSERT INTO "t" ("a","b") VALUES (?,?),(?,?)…`. */
  readonly sql: string;

  /** The flat bound values, row-major, matching the `?` placeholders exactly. */
  readonly params: (string | number | null)[];

  /** How many rows this batch inserts (for honest progress reporting). */
  readonly rowCount: number;
}

/** A complete import plan: the target table, the included columns, and the chunked batches. */
export interface InsertPlan {
  /** The target table identifier (already validated safe). */
  readonly table: string;

  /** The included target column identifiers, in order. */
  readonly columns: string[];

  /** Chunked parameterized INSERT batches — run each through the per-site exec rail with `confirm:true`. */
  readonly batches: InsertBatch[];

  /** Total rows the plan will insert across all batches. */
  readonly totalRows: number;
}

/** Typed error for the ingest planners — surfaced inline by the panels (never a raw throw). */
export class IngestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/**
 * Compile a parameterized, param-capped, chunked INSERT plan for a parsed grid + column mapping.
 *
 * Every value is BOUND (`?`), never concatenated — the whole point of this module (see file docs). Identifiers
 * (table + each included column) are validated with {@link isSafeIdent} and double-quoted via `quoteIdent`;
 * an unsafe identifier throws {@link IngestError} rather than being quoted into SQL. Rows are chunked so each
 * statement's bound-param count (`rows * columns`) stays `<= {@link MAX_BOUND_PARAMS}`, and each chunk is a
 * single legal `INSERT … VALUES (…),(…)` (the D1 REST plane is single-statement).
 *
 * @param table - the target table identifier (must be safe + already exist, or be created first by the caller)
 * @param mappings - the column mappings (only `include:true` columns are written)
 * @param rows - the source data rows (each an array of raw string cells, aligned to `ParsedGrid.headers`)
 * @returns the chunked insert plan
 * @throws {IngestError} `invalid_table` / `no_columns` / `no_rows`
 */
export function buildInsertPlan(
  table: string,
  mappings: readonly ColumnMapping[],
  rows: readonly string[][],
): InsertPlan {
  if (!isSafeIdent(table)) {
    throw new IngestError('invalid_table', `"${table}" is not a valid table name.`);
  }

  const included = mappings.filter((m) => m.include);

  if (included.length === 0) {
    throw new IngestError('no_columns', 'Select at least one column to import.');
  }

  for (const m of included) {
    if (!isSafeIdent(m.targetColumn)) {
      throw new IngestError('invalid_column', `"${m.targetColumn}" is not a valid column name.`);
    }
  }

  if (rows.length === 0) {
    throw new IngestError('no_rows', 'There are no data rows to import.');
  }

  const columns = included.map((m) => m.targetColumn);
  const quotedTable = quoteIdent(table);
  const quotedCols = columns.map((c) => quoteIdent(c)).join(', ');
  const colCount = included.length;

  // Rows per chunk so rows*cols <= cap (at least 1 row even if a very wide table exceeds the cap alone).
  const rowsPerChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / colCount));
  const placeholderTuple = `(${Array<string>(colCount).fill('?').join(', ')})`;

  const batches: InsertBatch[] = [];

  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const params: (string | number | null)[] = [];

    for (const row of chunk) {
      for (const m of included) {
        params.push(coerceValue(row[m.sourceIndex] ?? '', m.type));
      }
    }

    const tuples = chunk.map(() => placeholderTuple).join(', ');
    const sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES ${tuples}`;

    batches.push({ sql, params, rowCount: chunk.length });
  }

  return { table, columns, batches, totalRows: rows.length };
}

/**
 * Compile the `CREATE TABLE` statement for an import that targets a NEW table (from the column mapping). Reuses
 * the proven `schema-ddl` `buildCreateTable` — every column is `NOT NULL`-optional, no PK by default (the owner
 * can add one in the Schema builder). An auto-increment `id INTEGER PRIMARY KEY` is prepended when
 * `withRowId` is true so the table has a stable key out of the box (the embarrassingly-easy default).
 *
 * @param table - the new table's identifier (validated by `buildCreateTable`)
 * @param mappings - the column mappings (only `include:true` columns become columns)
 * @param opts.withRowId - prepend `id INTEGER PRIMARY KEY` (default true)
 * @returns the CREATE TABLE SQL (no trailing `;`)
 * @throws {IngestError} on an invalid identifier / no columns (wrapping the underlying `DdlError`)
 */
export function buildCreateTableForImport(
  table: string,
  mappings: readonly ColumnMapping[],
  opts: { withRowId?: boolean } = {},
): string {
  const withRowId = opts.withRowId ?? true;
  const included = mappings.filter((m) => m.include);

  if (included.length === 0) {
    throw new IngestError('no_columns', 'Select at least one column to create the table.');
  }

  const columns: ColumnSpec[] = [];

  if (withRowId) {
    columns.push({ name: 'id', type: 'INTEGER', primaryKey: true });
  }

  for (const m of included) {
    // A source column that slugified to `id` collides with the synthetic PK — skip the synthetic one instead.
    if (withRowId && m.targetColumn.toLowerCase() === 'id') {
      // Drop the auto id; use the source id column as-is (still typed INTEGER/REAL/TEXT).
      const idx = columns.findIndex((c) => c.name === 'id');

      if (idx >= 0) {
        columns.splice(idx, 1);
      }
    }

    columns.push({ name: m.targetColumn, type: m.type });
  }

  try {
    return buildCreateTable({ name: table, columns });
  } catch (err) {
    if (err instanceof DdlError) {
      throw new IngestError('invalid_schema', err.message);
    }

    throw err;
  }
}

// ── AI table-seeding (schema → prompt → model JSON → validated rows → INSERT plan) ────────────────────

/** The number of rows to request per AI-seed call, clamped to a sane band (cheap + previewable). */
export const AI_SEED_MIN_ROWS = 1;
export const AI_SEED_MAX_ROWS = 50;
export const AI_SEED_DEFAULT_ROWS = 10;

/** Clamp a requested AI-seed row count into `[AI_SEED_MIN_ROWS, AI_SEED_MAX_ROWS]`. */
export function clampSeedRowCount(n: number): number {
  if (!Number.isFinite(n)) {
    return AI_SEED_DEFAULT_ROWS;
  }

  return Math.min(AI_SEED_MAX_ROWS, Math.max(AI_SEED_MIN_ROWS, Math.floor(n)));
}

/** One target column the AI seeds (name + storage class the model must respect). */
export interface SeedColumn {
  readonly name: string;
  readonly type: DetectedType | 'BLOB';
}

/**
 * Build the system prompt that grounds the model to emit ONLY a JSON array of realistic row objects matching a
 * table's columns + types. Constrained hard: exact column keys, no extra keys, types honored (INTEGER → whole
 * number, REAL → decimal, TEXT → string), a synthetic PK / `id` / `created_at` / `updated_at` column left out
 * (the DB fills those), and JSON-only output (no prose, no fences) so {@link extractSeedRows} can parse it.
 *
 * @param table - the target table name (for context only — never interpolated into SQL)
 * @param columns - the columns to seed (already filtered to the insertable set)
 * @param rowCount - how many rows to request (clamp first)
 * @param hint - an optional owner hint ("customers for a coffee shop") to steer realism
 * @returns the system prompt string
 */
export function buildSeedSystemPrompt(
  table: string,
  columns: readonly SeedColumn[],
  rowCount: number,
  hint?: string,
): string {
  const colLines = columns.map((c) => `  - "${c.name}" (${c.type})`).join('\n');
  const hintLine = hint && hint.trim().length > 0 ? `\nContext for realism: ${hint.trim()}` : '';

  return [
    'You generate realistic SAMPLE DATA for a database table in a website builder.',
    `Produce exactly ${rowCount} row(s) for the table "${table}".${hintLine}`,
    '',
    'COLUMNS you must fill (use these EXACT keys, and ONLY these keys):',
    colLines,
    '',
    'RULES:',
    '- Return ONLY a JSON array of objects. No prose, no markdown, no code fences, no trailing text.',
    '- Each object has EXACTLY the keys listed above — no extra keys, no missing keys.',
    '- Respect the type: INTEGER → a whole number, REAL → a decimal number, TEXT → a string. BLOB → a short string.',
    '- Make the data realistic and varied (real-looking names, emails, prices, dates as ISO strings, etc.).',
    '- Do NOT include an id / primary-key / created_at / updated_at value even if such a column is listed — leave it out; the database fills it.',
    `- Output must be a single JSON array of length ${rowCount}.`,
  ].join('\n');
}

/**
 * Extract + validate rows from the model's reply. Robust to a bare JSON array, a ```json fenced block, or an
 * array embedded in prose. Every returned object is filtered to the allowed column set (extra keys dropped,
 * missing keys → `''`) and rendered to the string-cell shape {@link buildInsertPlan} consumes, so a slightly
 * misbehaving model can never inject an unknown column or a non-scalar value. Returns `[]` when nothing
 * array-like is found (the caller surfaces an honest "the assistant didn't return data").
 *
 * @param raw - the model's raw text reply
 * @param columns - the insertable columns (defines the allowed keys + output order)
 * @returns rows as `string[][]` aligned to `columns` (ready for {@link buildInsertPlan})
 */
export function extractSeedRows(raw: string, columns: readonly SeedColumn[]): string[][] {
  const json = extractJsonArray(raw);

  if (!json) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const keys = columns.map((c) => c.name);

  return parsed
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((rec) => keys.map((k) => cellToString(rec[k])));
}

/** Pull a JSON array substring from a model reply: a ```json fence, a generic fence, or a bare `[ … ]`. */
function extractJsonArray(raw: string): string | null {
  if (!raw) {
    return null;
  }

  const text = raw.trim();

  const jsonFence = /```json\s*([\s\S]*?)```/i.exec(text);

  if (jsonFence && jsonFence[1].trim().startsWith('[')) {
    return jsonFence[1].trim();
  }

  const anyFence = /```\s*([\s\S]*?)```/.exec(text);

  if (anyFence && anyFence[1].trim().startsWith('[')) {
    return anyFence[1].trim();
  }

  // Bare array — from the first '[' to the last ']'.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');

  if (first >= 0 && last > first) {
    return text.slice(first, last + 1);
  }

  return null;
}

/**
 * Map the AI-seed columns to the {@link ColumnMapping} shape {@link buildInsertPlan} expects. A seed column's
 * BLOB type is written as TEXT (a JS string binds fine as TEXT-affinity; we never fabricate binary). The
 * sourceIndex is the column's position in the seed row array (which {@link extractSeedRows} produced in order).
 */
export function seedColumnsToMappings(columns: readonly SeedColumn[]): ColumnMapping[] {
  return columns.map((c, i) => ({
    sourceIndex: i,
    sourceHeader: c.name,
    targetColumn: c.name,
    type: c.type === 'BLOB' ? 'TEXT' : c.type,
    include: true,
  }));
}

// ── Form builder (owner-defined fields → a per-site table + a stored form definition) ─────────────────

/** One field an owner defines in the form builder. */
export interface FormFieldDraft {
  /** The visible field label ("Your name", "Email address"). */
  readonly label: string;

  /** The D1 column identifier the submission writes to (slugified from the label; editable). */
  readonly column: string;

  /** The input kind — drives the storage class + the (future) rendered input type. */
  readonly kind: FormFieldKind;

  /** Whether the field is required (rendered + validated client-side in the future public form). */
  readonly required: boolean;
}

/** The input kinds a form field can be. Each maps to a SQLite storage class + a future HTML input type. */
export type FormFieldKind = 'text' | 'email' | 'number' | 'tel' | 'textarea' | 'date' | 'checkbox';

/** The storage class each form-field kind persists as. */
export function storageForFieldKind(kind: FormFieldKind): DetectedType {
  return kind === 'number' ? 'REAL' : kind === 'checkbox' ? 'INTEGER' : 'TEXT';
}

/** A compiled form: the CREATE TABLE for its backing table + the JSON definition to persist for public render. */
export interface FormPlan {
  /** The backing table identifier (safe ident). */
  readonly table: string;

  /** The CREATE TABLE statement (id PK + a `submitted_at` timestamp + one column per field). */
  readonly createTableSql: string;

  /** The form definition (title + fields) to store — the future public renderer reads this. */
  readonly definition: FormDefinition;
}

/** The stored, versioned form definition (persisted in the site's OWN D1 for the public render pipeline). */
export interface FormDefinition {
  readonly version: 1;
  readonly title: string;
  readonly table: string;
  readonly fields: ReadonlyArray<{
    readonly label: string;
    readonly column: string;
    readonly kind: FormFieldKind;
    readonly required: boolean;
  }>;
}

/**
 * Compile an owner's form definition into a {@link FormPlan}: a backing table (`id` PK + `submitted_at` +
 * one typed column per field) and a stored JSON definition the future public renderer + submit handler use.
 * Field columns are slugified + de-duplicated so a CREATE never collides; the table + every column is validated
 * safe. Ships the builder + the per-site write path; the public HTML render + submit endpoint are a documented
 * follow-up (the definition is the contract they'll read).
 *
 * @param title - the form's display title
 * @param table - the backing table identifier
 * @param fields - the owner-defined fields (at least one required)
 * @returns the compiled form plan
 * @throws {IngestError} `invalid_table` / `no_fields` / `invalid_schema`
 */
export function buildFormPlan(title: string, table: string, fields: readonly FormFieldDraft[]): FormPlan {
  if (!isSafeIdent(table)) {
    throw new IngestError('invalid_table', `"${table}" is not a valid table name.`);
  }

  if (fields.length === 0) {
    throw new IngestError('no_fields', 'Add at least one field to your form.');
  }

  // Slugify + de-dupe the field columns (never trust the raw label-derived name to be unique/safe).
  const cols = dedupeColumnNames(fields.map((f) => (isSafeIdent(f.column) ? f.column : slugifyColumnName(f.label))));

  const columns: ColumnSpec[] = [
    { name: 'id', type: 'INTEGER', primaryKey: true },
    { name: 'submitted_at', type: 'TEXT' },
  ];

  const normalizedFields = fields.map((f, i) => {
    const column = cols[i];

    if (!isSafeIdent(column)) {
      throw new IngestError('invalid_schema', `Field "${f.label}" has no valid column name.`);
    }

    columns.push({ name: column, type: storageForFieldKind(f.kind), notNull: f.required });

    return { label: f.label, column, kind: f.kind, required: f.required };
  });

  let createTableSql: string;

  try {
    createTableSql = buildCreateTable({ name: table, columns });
  } catch (err) {
    if (err instanceof DdlError) {
      throw new IngestError('invalid_schema', err.message);
    }

    throw err;
  }

  return {
    table,
    createTableSql,
    definition: { version: 1, title, table, fields: normalizedFields },
  };
}
