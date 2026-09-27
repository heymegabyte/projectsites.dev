/**
 * data-copy-as.ts
 *
 * Pure, zero-dependency helpers that turn SQLite/D1 row data into clipboard-ready
 * strings: INSERT, UPDATE, JSON, and GitHub Markdown table.
 *
 * Designed for the bolt.diy Data panel "Copy as…" context-menu.
 * Every function is side-effect-free (pure).
 */

/** A single database row — column name → raw JS value. */
export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// sqlLiteral
// ---------------------------------------------------------------------------

/**
 * Converts a JavaScript value into a safe SQL literal string.
 *
 * Rules
 * - `null` / `undefined` → `NULL`
 * - `number` / `bigint`  → bare numeric literal
 * - `boolean`            → `1` or `0`
 * - `string`             → single-quoted with internal `'` doubled (`''`)
 * - everything else      → JSON-serialised, then single-quoted
 *
 * The result is safe to interpolate into clipboard SQL because every string
 * character that could escape a single-quoted context is neutralised.
 *
 * @param value - Any JS value from a database row.
 * @returns A SQL literal string (e.g. `'O''Brien'`, `42`, `NULL`).
 * @example
 * sqlLiteral(null)            // → "NULL"
 * sqlLiteral(42)              // → "42"
 * sqlLiteral(true)            // → "1"
 * sqlLiteral("O'Brien")       // → "'O''Brien'"
 * sqlLiteral({ a: 1 })        // → "'{\"a\":1}'"
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") {
    // Double every single-quote so x'); DROP becomes 'x''); DROP' — still valid SQL
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  // Objects, arrays, etc. → JSON string, then quoted
  const json = JSON.stringify(value);
  const escaped = json.replace(/'/g, "''");
  return `'${escaped}'`;
}

// ---------------------------------------------------------------------------
// quoteIdent
// ---------------------------------------------------------------------------

/**
 * Wraps a SQL identifier in ANSI double-quotes, doubling any embedded `"`.
 *
 * @param name - A table or column name.
 * @returns A properly quoted identifier, e.g. `"my table"`.
 * @throws {RangeError} If `name` is empty.
 * @example
 * quoteIdent("users")         // → '"users"'
 * quoteIdent('say "hi"')      // → '"say ""hi"""'
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw new RangeError("quoteIdent: identifier must not be empty");
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// rowToInsert
// ---------------------------------------------------------------------------

/**
 * Generates an `INSERT INTO` statement for a single row.
 *
 * Column order follows `Object.keys(row)` — deterministic for the same row shape.
 *
 * @param table - Destination table name.
 * @param row   - A single data row.
 * @returns A complete `INSERT INTO "table" ("c1","c2") VALUES (v1,v2);` string.
 * @example
 * rowToInsert("users", { id: 1, name: "Alice" })
 * // → 'INSERT INTO "users" ("id","name") VALUES (1,\'Alice\');'
 */
export function rowToInsert(table: string, row: Row): string {
  const cols = Object.keys(row);
  const quotedCols = cols.map(quoteIdent).join(",");
  const values = cols.map((c) => sqlLiteral(row[c])).join(",");
  return `INSERT INTO ${quoteIdent(table)} (${quotedCols}) VALUES (${values});`;
}

// ---------------------------------------------------------------------------
// rowToUpdateByPk
// ---------------------------------------------------------------------------

/**
 * Generates an `UPDATE … SET … WHERE …` statement for a single row, keyed by
 * one or more primary-key columns.
 *
 * - All columns **not** in `pkCols` go into the `SET` clause.
 * - All columns **in** `pkCols` go into the `WHERE` clause joined by `AND`.
 * - If the row has **only** PK columns (nothing to SET), a `SET` clause is still
 *   emitted with the first PK column as a no-op (`"pk" = <same value>`).
 *
 * @param table  - Target table name.
 * @param row    - A single data row that must contain every PK column.
 * @param pkCols - One or more column names that form the primary key.
 * @returns A complete `UPDATE` statement.
 * @throws {RangeError} If any column listed in `pkCols` is absent from `row`.
 * @example
 * rowToUpdateByPk("users", { id: 1, name: "Bob" }, ["id"])
 * // → 'UPDATE "users" SET "name"=\'Bob\' WHERE "id"=1;'
 */
export function rowToUpdateByPk(
  table: string,
  row: Row,
  pkCols: readonly string[]
): string {
  // Validate that every PK column exists in the row
  for (const pk of pkCols) {
    if (!(pk in row)) {
      throw new RangeError(
        `rowToUpdateByPk: primary-key column "${pk}" is not present in row`
      );
    }
  }

  const pkSet = new Set(pkCols);
  const setCols = Object.keys(row).filter((c) => !pkSet.has(c));

  // If there are no non-PK columns, produce a no-op SET using the first PK col
  const effectiveSet = setCols.length > 0 ? setCols : [pkCols[0]];

  const setPairs = effectiveSet
    .map((c) => `${quoteIdent(c)}=${sqlLiteral(row[c])}`)
    .join(",");

  const wherePairs = pkCols
    .map((c) => `${quoteIdent(c)}=${sqlLiteral(row[c])}`)
    .join(" AND ");

  return `UPDATE ${quoteIdent(table)} SET ${setPairs} WHERE ${wherePairs};`;
}

// ---------------------------------------------------------------------------
// rowToJson
// ---------------------------------------------------------------------------

/**
 * Serialises a row to a pretty-printed JSON string (2-space indent).
 *
 * Suitable for pasting into AI prompts or config files.
 *
 * @param row - A single data row.
 * @returns A 2-space-indented JSON string.
 * @example
 * rowToJson({ id: 1, name: "Alice" })
 * // → '{\n  "id": 1,\n  "name": "Alice"\n}'
 */
export function rowToJson(row: Row): string {
  return JSON.stringify(row, null, 2);
}

// ---------------------------------------------------------------------------
// rowsToMarkdown
// ---------------------------------------------------------------------------

/**
 * Renders an array of rows as a GitHub-flavoured Markdown table.
 *
 * - Pipe characters (`|`) inside cell values are escaped as `\|`.
 * - Newlines inside cell values are replaced with a space.
 * - `null` / `undefined` values are rendered as an empty cell.
 * - Column order follows `cols`.
 *
 * @param cols - Ordered list of column headers.
 * @param rows - Data rows; columns not in `cols` are ignored.
 * @returns A GFM Markdown table string.
 * @example
 * rowsToMarkdown(["id","name"], [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }])
 * // → '| id | name |\n| --- | --- |\n| 1 | Alice |\n| 2 | Bob |'
 */
export function rowsToMarkdown(
  cols: readonly string[],
  rows: readonly Row[]
): string {
  /** Escape a cell value for safe embedding in a Markdown table cell. */
  const escapeCell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  };

  const header = `| ${cols.map(escapeCell).join(" | ")} |`;
  const separator = `| ${cols.map(() => "---").join(" | ")} |`;
  const dataLines = rows.map(
    (row) => `| ${cols.map((c) => escapeCell(row[c])).join(" | ")} |`
  );

  return [header, separator, ...dataLines].join("\n");
}
