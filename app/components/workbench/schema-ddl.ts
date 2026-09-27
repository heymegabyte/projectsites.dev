/**
 * @file Pure DDL generators for the D1 schema builder.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library. Every function is pure so
 * it can be tested with Vitest without mocking. All identifiers emitted are double-quote
 * escaped (SQLite standard) following the same convention as `d1-browser-logic.ts`:
 * double-quote wraps the identifier, any embedded `"` is doubled to `""`.
 *
 * DEFAULT value handling (two classes, documented once here):
 *
 * - **String literals** (`"hello"`, `"it''s"`) — the caller MUST pass the raw string
 *   value WITHOUT surrounding quotes; `buildAddColumn`/`buildCreateTable` wrap it in
 *   single quotes and escape any embedded `'` by doubling it (`'` → `''`).  This keeps
 *   the API simple and safe — the consumer never constructs raw SQL fragments.
 *
 * - **Numeric / keyword / expression defaults** (`0`, `3.14`, `NULL`, `(datetime('now'))`) —
 *   the caller MUST pass the value already formatted as a SQL literal (i.e. the string
 *   you would type directly into a CREATE TABLE statement).  We detect this path by
 *   checking whether the value starts with a digit, `-`, `+`, `(`, or is a known SQL
 *   keyword (`NULL`, `TRUE`, `FALSE`, `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME`).
 *   Everything else is treated as a string literal.
 *
 * This heuristic is intentionally simple and documented so callers understand the contract.
 * The alternative — always treating defaultValue as a raw SQL fragment — would open SQL
 * injection via the schema builder UI; always wrapping in quotes would break numeric
 * and keyword defaults.  Two-class detection is the safest minimal approach.
 *
 * Sibling of the other pure workbench logic modules (d1-browser-logic, kv-browser-logic …).
 */

// ── DdlError ──────────────────────────────────────────────────────────────────

/**
 * Thrown by any DDL generator when its arguments are invalid — e.g. an empty identifier,
 * a table with no columns, or duplicate column names. Callers should catch this and surface
 * it to the user rather than let it propagate as an unhandled rejection.
 */
export class DdlError extends Error {
  override readonly name = 'DdlError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Identifier helpers ────────────────────────────────────────────────────────

/**
 * Regex that every bare (unquoted) SQLite identifier must satisfy — one leading
 * letter/underscore, then letters/digits/underscores/`$`.  Derived directly from the same
 * `IDENT_RE` pattern used in `d1-browser-logic.ts` to stay consistent across the module.
 */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Double-quote a SQLite identifier, doubling any embedded `"` per the SQL standard.
 * The same encoding used throughout `d1-browser-logic.ts` (`unquoteIdent` is its inverse).
 *
 * @param name - The raw identifier string (e.g. `"my table"` or `order`).
 * @returns The double-quoted identifier ready for embedding in SQL, e.g. `"my table"` or `"order"`.
 * @throws {DdlError} When `name` is empty or contains only whitespace.
 *
 * @example quoteIdent('users')           // → '"users"'
 * @example quoteIdent('has "quotes"')    // → '"has ""quotes"""'
 * @example quoteIdent('')                // throws DdlError
 */
export function quoteIdent(name: string): string {
  if (!name || !name.trim()) {
    throw new DdlError('Identifier must not be empty or blank');
  }

  // Escape embedded double-quotes by doubling them, then wrap in double-quotes.
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Validate that an identifier is safe to use as a SQLite identifier.  Throws when the
 * value is empty/blank or contains characters outside the safe character set.  Called by
 * every generator before quoting so errors are caught early.
 *
 * @param name - The raw identifier to check.
 * @param role - Human label for error messages (e.g. "table name", "column name").
 * @throws {DdlError} When the name is invalid.
 */
function assertSafeIdent(name: string, role: string): void {
  if (!name || !name.trim()) {
    throw new DdlError(`${role} must not be empty or blank`);
  }

  if (!SAFE_IDENT_RE.test(name)) {
    throw new DdlError(
      `${role} "${name}" contains characters not allowed in a SQLite identifier (use letters, digits, underscores, $; must start with a letter or underscore)`,
    );
  }
}

// ── DEFAULT value formatting ──────────────────────────────────────────────────

/** SQL keywords that are valid bare DEFAULT values (passed through unquoted). */
const KEYWORD_DEFAULTS = new Set(['NULL', 'TRUE', 'FALSE', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME']);

/**
 * Format a `defaultValue` string from a `ColumnSpec` into the SQL fragment that follows
 * `DEFAULT`.  See module JSDoc for the two-class heuristic (string literal vs. numeric /
 * keyword / expression).
 *
 * Returns `null` when `defaultValue` is `null` or `undefined` (no DEFAULT clause).
 */
function formatDefault(defaultValue: string | null | undefined): string | null {
  if (defaultValue === null || defaultValue === undefined) {
    return null;
  }

  const trimmed = defaultValue.trim();

  if (!trimmed) {
    // Empty string → treat as the empty-string literal '' in SQL.
    return `''`;
  }

  // Numeric / signed numeric: starts with a digit or a sign followed by a digit.
  if (/^[+\-]?\d/.test(trimmed)) {
    return trimmed;
  }

  // Expression: already wrapped in parens (e.g. (datetime('now'))).
  if (trimmed.startsWith('(')) {
    return trimmed;
  }

  // Known SQL keyword.
  if (KEYWORD_DEFAULTS.has(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }

  // Treat as a string literal: escape internal single-quotes by doubling.
  return `'${trimmed.replace(/'/g, "''")}'`;
}

// ── ColumnSpec ────────────────────────────────────────────────────────────────

/**
 * Specification for a single column used by the DDL generators.
 *
 * @remarks
 * For `defaultValue`, supply the RAW value as described in the module JSDoc:
 * - A plain string → wrap in quotes automatically (`hello` → `'hello'`).
 * - A numeric or SQL keyword literal → pass as-is (`0`, `NULL`, `CURRENT_TIMESTAMP`).
 * - An expression → pass with outer parens (`(datetime('now'))`).
 */
export interface ColumnSpec {
  /** Raw column name — must match `SAFE_IDENT_RE`. */
  readonly name: string;

  /** SQLite storage class. */
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

  /** Emit `NOT NULL` when `true`. Primary-key columns always carry NOT NULL implicitly. */
  readonly notNull?: boolean;

  /**
   * Mark this column as part of the primary key.  When exactly one column has
   * `primaryKey: true`, the constraint is emitted inline (`INTEGER PRIMARY KEY`).
   * When multiple columns have it, a table-level `PRIMARY KEY (a, b)` clause is appended.
   */
  readonly primaryKey?: boolean;

  /**
   * Default value.  Null/undefined → no DEFAULT clause.  See module JSDoc for the
   * two-class string-vs-keyword heuristic.
   */
  readonly defaultValue?: string | null;
}

// ── buildCreateTable ──────────────────────────────────────────────────────────

/**
 * Generate a `CREATE TABLE` statement from a table spec.
 *
 * @param spec - Table name plus an ordered list of column specifications.
 * @returns A `CREATE TABLE "name" (\n  ...\n)` SQL string (no trailing semicolon).
 * @throws {DdlError} When the table name is invalid, no columns are provided, any column
 *   name is invalid, or column names are not unique (case-insensitive).
 *
 * @example
 * buildCreateTable({
 *   name: 'users',
 *   columns: [
 *     { name: 'id', type: 'INTEGER', primaryKey: true },
 *     { name: 'email', type: 'TEXT', notNull: true },
 *     { name: 'score', type: 'REAL', defaultValue: '0' },
 *   ],
 * })
 * // →
 * // CREATE TABLE "users" (
 * //   "id" INTEGER PRIMARY KEY,
 * //   "email" TEXT NOT NULL,
 * //   "score" REAL DEFAULT 0
 * // )
 */
export function buildCreateTable(spec: { name: string; columns: ColumnSpec[] }): string {
  assertSafeIdent(spec.name, 'table name');

  if (!spec.columns || spec.columns.length === 0) {
    throw new DdlError(`Table "${spec.name}" must have at least one column`);
  }

  // Validate all column names up-front before emitting any SQL.
  for (const col of spec.columns) {
    assertSafeIdent(col.name, 'column name');
  }

  // Duplicate column name check (case-insensitive, matching SQLite's own behaviour).
  const seen = new Set<string>();

  for (const col of spec.columns) {
    const lower = col.name.toLowerCase();

    if (seen.has(lower)) {
      throw new DdlError(`Duplicate column name "${col.name}" in table "${spec.name}"`);
    }

    seen.add(lower);
  }

  const pkColumns = spec.columns.filter((c) => c.primaryKey);
  const compositePk = pkColumns.length > 1;
  const lines: string[] = [];

  for (const col of spec.columns) {
    const parts: string[] = [quoteIdent(col.name), col.type];

    // Inline PRIMARY KEY only when there is exactly one PK column.
    if (col.primaryKey && !compositePk) {
      parts.push('PRIMARY KEY');
    } else if (col.notNull) {
      // NOT NULL is implied by PRIMARY KEY; avoid doubling.
      parts.push('NOT NULL');
    }

    const dflt = formatDefault(col.defaultValue);

    if (dflt !== null) {
      parts.push(`DEFAULT ${dflt}`);
    }

    lines.push(`  ${parts.join(' ')}`);
  }

  // Append composite PRIMARY KEY constraint when more than one PK column.
  if (compositePk) {
    const pkList = pkColumns.map((c) => quoteIdent(c.name)).join(', ');
    lines.push(`  PRIMARY KEY (${pkList})`);
  }

  return `CREATE TABLE ${quoteIdent(spec.name)} (\n${lines.join(',\n')}\n)`;
}

// ── buildAddColumn ────────────────────────────────────────────────────────────

/**
 * Generate an `ALTER TABLE … ADD COLUMN` statement.
 *
 * @param table - The target table name.
 * @param col - The column specification to add.
 * @returns `ALTER TABLE "table" ADD COLUMN "col" TYPE [NOT NULL] [DEFAULT ...]`
 * @throws {DdlError} When either identifier is invalid.
 *
 * @example
 * buildAddColumn('users', { name: 'bio', type: 'TEXT', defaultValue: null })
 * // → 'ALTER TABLE "users" ADD COLUMN "bio" TEXT'
 *
 * @example
 * buildAddColumn('products', { name: 'stock', type: 'INTEGER', notNull: true, defaultValue: '0' })
 * // → 'ALTER TABLE "products" ADD COLUMN "stock" INTEGER NOT NULL DEFAULT 0'
 */
export function buildAddColumn(table: string, col: ColumnSpec): string {
  assertSafeIdent(table, 'table name');
  assertSafeIdent(col.name, 'column name');

  const parts: string[] = [`ALTER TABLE ${quoteIdent(table)} ADD COLUMN`, quoteIdent(col.name), col.type];

  if (col.notNull) {
    parts.push('NOT NULL');
  }

  const dflt = formatDefault(col.defaultValue);

  if (dflt !== null) {
    parts.push(`DEFAULT ${dflt}`);
  }

  return parts.join(' ');
}

// ── buildRenameColumn ─────────────────────────────────────────────────────────

/**
 * Generate an `ALTER TABLE … RENAME COLUMN` statement (SQLite 3.25+).
 *
 * @param table - The target table name.
 * @param from - The current column name.
 * @param to - The new column name.
 * @returns `ALTER TABLE "table" RENAME COLUMN "from" TO "to"`
 * @throws {DdlError} When any identifier is invalid.
 *
 * @example
 * buildRenameColumn('orders', 'qty', 'quantity')
 * // → 'ALTER TABLE "orders" RENAME COLUMN "qty" TO "quantity"'
 */
export function buildRenameColumn(table: string, from: string, to: string): string {
  assertSafeIdent(table, 'table name');
  assertSafeIdent(from, 'source column name');
  assertSafeIdent(to, 'target column name');

  return `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`;
}

// ── buildDropColumn ───────────────────────────────────────────────────────────

/**
 * Generate an `ALTER TABLE … DROP COLUMN` statement (SQLite 3.35+).
 *
 * @param table - The target table name.
 * @param col - The column name to drop.
 * @returns `ALTER TABLE "table" DROP COLUMN "col"`
 * @throws {DdlError} When either identifier is invalid.
 *
 * @example
 * buildDropColumn('sessions', 'legacy_token')
 * // → 'ALTER TABLE "sessions" DROP COLUMN "legacy_token"'
 */
export function buildDropColumn(table: string, col: string): string {
  assertSafeIdent(table, 'table name');
  assertSafeIdent(col, 'column name');

  return `ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(col)}`;
}

// ── buildCreateIndex ──────────────────────────────────────────────────────────

/**
 * Generate a `CREATE [UNIQUE] INDEX` statement.
 *
 * @param spec - Index specification including name, target table, columns, and uniqueness.
 * @returns `CREATE [UNIQUE] INDEX "name" ON "table" ("col1", "col2", ...)`
 * @throws {DdlError} When any identifier is invalid or the column list is empty.
 *
 * @example
 * buildCreateIndex({ name: 'idx_users_email', table: 'users', columns: ['email'], unique: true })
 * // → 'CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")'
 *
 * @example
 * buildCreateIndex({ name: 'idx_orders_user_created', table: 'orders', columns: ['user_id', 'created_at'] })
 * // → 'CREATE INDEX "idx_orders_user_created" ON "orders" ("user_id", "created_at")'
 */
export function buildCreateIndex(spec: { name: string; table: string; columns: string[]; unique?: boolean }): string {
  assertSafeIdent(spec.name, 'index name');
  assertSafeIdent(spec.table, 'table name');

  if (!spec.columns || spec.columns.length === 0) {
    throw new DdlError(`Index "${spec.name}" must index at least one column`);
  }

  for (const col of spec.columns) {
    assertSafeIdent(col, 'index column name');
  }

  const uniqueClause = spec.unique ? 'UNIQUE ' : '';
  const colList = spec.columns.map((c) => quoteIdent(c)).join(', ');

  return `CREATE ${uniqueClause}INDEX ${quoteIdent(spec.name)} ON ${quoteIdent(spec.table)} (${colList})`;
}

// ── buildDropIndex ────────────────────────────────────────────────────────────

/**
 * Generate a `DROP INDEX` statement for an EXISTING index (by its real name).
 *
 * @remarks
 * Unlike the builders above (which validate user-typed identifiers with `assertSafeIdent`),
 * a drop targets a name that already exists in `sqlite_master`, so it only needs correct
 * quoting — `quoteIdent` escapes any embedded `"` and throws {@link DdlError} on a blank name.
 * This never drops a table or column — only the named index.
 *
 * @param name - The index name to drop.
 * @returns `DROP INDEX "name"`
 * @throws {DdlError} When `name` is empty or blank.
 *
 * @example buildDropIndex('idx_users_email')  // → 'DROP INDEX "idx_users_email"'
 */
export function buildDropIndex(name: string): string {
  return `DROP INDEX ${quoteIdent(name)}`;
}
