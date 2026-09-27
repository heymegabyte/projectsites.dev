/**
 * @file Pure logic for the guided Schema Builder (per-site D1 DDL).
 *
 * @remarks
 * The Schema Builder lets an owner shape their OWN dedicated Cloudflare D1 with a visual form instead of
 * hand-written SQL: create a table, add / rename / drop a column, and create an index — each compiled to a
 * SAFE statement by the proven pure generators in {@link module:app/components/workbench/schema-ddl} and run
 * through the SAME per-site exec rail the grid + SQL navigator use (`PS_RES_MUTATE { kind:'d1', action:'exec' }`
 * → the worker's confirm-gated single-statement executor bound to the site's server-resolved D1 id).
 *
 * These helpers are PURE (no React, no bridge, no I/O) so they unit-test in isolation:
 *  - `draftToColumnSpec` / `planCreateTable` — a table-name + typed column drafts → a reviewable CREATE TABLE
 *    (+ any UNIQUE columns compiled to follow-on CREATE UNIQUE INDEX statements, since SQLite has no
 *    ALTER-ADD-UNIQUE and inline column UNIQUE isn't modelled by `ColumnSpec`).
 *  - `planAddColumn` / `planRenameColumn` / `planDropColumn` — a single ALTER statement each.
 *  - `planCreateIndex` — a CREATE [UNIQUE] INDEX statement.
 *  - `isDestructiveDdl` — whether a compiled statement needs the type-to-confirm gate (DROP / destructive).
 *  - `suggestIndexName` — a sensible default index name from table + columns.
 *
 * Every compiled statement is returned as `{ sql, destructive }` — the component previews `sql` before it runs
 * and sends `confirm:true` for a `destructive` one (the worker classifies + gates identically; this flag drives
 * the UI's own confirm dialog so a DROP is never a single accidental click).
 *
 * The generators throw {@link DdlError} on an invalid identifier / empty column list / duplicate name — the
 * `plan*` wrappers surface that as a typed {@link SchemaPlanError} the component renders inline (never a raw
 * throw, never a silent no-op).
 */
import {
  buildAddColumn,
  buildCreateIndex,
  buildCreateTable,
  buildDropColumn,
  buildRenameColumn,
  type ColumnSpec,
  DdlError,
} from './schema-ddl';

// ── Public types ───────────────────────────────────────────────────────────────

/** The four SQLite storage classes a guided column can pick. Mirrors {@link ColumnSpec.type}. */
export type ColumnStorageType = ColumnSpec['type'];

/** The storage-type options a guided column picker renders (value + human label). */
export const COLUMN_TYPE_OPTIONS: ReadonlyArray<{ value: ColumnStorageType; label: string }> = [
  { value: 'TEXT', label: 'Text' },
  { value: 'INTEGER', label: 'Number (integer)' },
  { value: 'REAL', label: 'Decimal' },
  { value: 'BLOB', label: 'Binary (blob)' },
];

/**
 * One column row in the guided "New table" / "Add column" forms — a superset of {@link ColumnSpec} that also
 * carries `unique` (compiled to a follow-on CREATE UNIQUE INDEX, since inline column UNIQUE isn't modelled by
 * `ColumnSpec` and SQLite can't ALTER-ADD a UNIQUE constraint). `defaultValue` follows the `schema-ddl`
 * string-vs-keyword contract (a plain string is auto-quoted; a numeric/keyword/expression literal is passed
 * as-is).
 */
export interface ColumnDraft {
  /** Raw column name (validated by the generator against `SAFE_IDENT_RE`). */
  name: string;

  /** SQLite storage class. */
  type: ColumnStorageType;

  /** Emit `NOT NULL`. */
  notNull?: boolean;

  /** Mark as (part of) the PRIMARY KEY. */
  primaryKey?: boolean;

  /** Add a UNIQUE constraint (compiled to a CREATE UNIQUE INDEX after the table is created). */
  unique?: boolean;

  /** DEFAULT value (raw — see the `schema-ddl` two-class heuristic). Empty/blank → no DEFAULT. */
  defaultValue?: string;
}

/** One compiled DDL statement + whether it needs the destructive-confirm gate. */
export interface PlannedStatement {
  /** The SQL to preview + run (no trailing semicolon; single-statement per the REST `/query` plane). */
  readonly sql: string;

  /** True when the statement is destructive (DROP column) → the UI type-to-confirms + sends `confirm:true`. */
  readonly destructive: boolean;

  /** A short human summary of what the statement does (for the review step / toast). */
  readonly summary: string;
}

/**
 * A guided-plan result: an ORDERED list of statements to run (usually one; a CREATE TABLE with UNIQUE columns
 * yields the CREATE TABLE + one CREATE UNIQUE INDEX per unique column). The component runs them in order,
 * stopping on the first failure.
 */
export interface SchemaPlan {
  readonly statements: readonly PlannedStatement[];
}

/** Typed failure of a plan step — a human message the component renders inline (never a raw throw). */
export class SchemaPlanError extends Error {
  override readonly name = 'SchemaPlanError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * SQLite reserves `REPLACE`/`TRUNCATE`/etc. as leading DDL keywords the worker classifies as destructive; a
 * DROP COLUMN is the only destructive statement the builder can emit (create-table / add-column / rename /
 * create-index are non-destructive). Kept as a helper so the component's confirm gate is one call, and the
 * classification can never drift from what it actually emits.
 */
export function isDestructiveDdl(sql: string): boolean {
  return /^\s*(DROP|ALTER\s+TABLE\s+[^\s]+\s+DROP)\b/i.test(sql);
}

/**
 * Normalize a raw DEFAULT input into what {@link ColumnSpec.defaultValue} expects, or `null` for "no DEFAULT".
 * An empty / whitespace-only string means the user left it blank → no DEFAULT clause. Any other value is
 * passed through verbatim (the generator applies the string-vs-keyword heuristic: `hello` → `'hello'`, `0`/
 * `NULL`/`CURRENT_TIMESTAMP` → as-is).
 */
function normalizeDefault(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  const trimmed = raw.trim();

  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Convert a {@link ColumnDraft} to the {@link ColumnSpec} the DDL generators consume (dropping `unique`, which
 * is handled separately as a follow-on index). Throws {@link SchemaPlanError} for a missing name so the caller
 * surfaces a clean inline error rather than a downstream `DdlError` about an empty identifier.
 */
export function draftToColumnSpec(draft: ColumnDraft): ColumnSpec {
  if (!draft || typeof draft.name !== 'string' || draft.name.trim().length === 0) {
    throw new SchemaPlanError('Every column needs a name.');
  }

  const def = normalizeDefault(draft.defaultValue);

  return {
    name: draft.name.trim(),
    type: draft.type,
    ...(draft.notNull ? { notNull: true } : {}),
    ...(draft.primaryKey ? { primaryKey: true } : {}),
    ...(def !== null ? { defaultValue: def } : {}),
  };
}

/**
 * A sensible default index name from a table + its columns: `idx_<table>_<col1>_<col2>…`, truncated to a safe
 * SQLite identifier length. Deterministic so the same selection always suggests the same name (the user can
 * override). Non-identifier characters in the table/columns are already blocked by the generators, so this only
 * needs to join + cap.
 */
export function suggestIndexName(table: string, columns: readonly string[]): string {
  const base = ['idx', table, ...columns].filter((p) => p && p.trim().length > 0).join('_');

  // SQLite identifiers are effectively unbounded but the safe-ident regex caps at 63 for the per-site DB.
  return base.slice(0, 63);
}

// ── Wrap a DdlError as a SchemaPlanError with a friendly prefix ────────────────

function wrapDdl<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DdlError || err instanceof SchemaPlanError) {
      throw new SchemaPlanError(err.message);
    }

    throw err;
  }
}

// ── Planners ───────────────────────────────────────────────────────────────────

/**
 * Compile a guided "New table" form into an ordered {@link SchemaPlan}: a CREATE TABLE, then one
 * CREATE UNIQUE INDEX per column marked `unique` (SQLite has no inline-column UNIQUE in `ColumnSpec` and can't
 * ALTER-ADD one, so a unique constraint is an index). None of these are destructive.
 *
 * @throws {SchemaPlanError} for a blank table name, no columns, a blank/duplicate column name (surfaced from
 *   the underlying `DdlError`), or no primary key when `requirePk` is true.
 */
export function planCreateTable(
  tableName: string,
  columns: readonly ColumnDraft[],
  opts: { requirePk?: boolean } = {},
): SchemaPlan {
  const name = (tableName ?? '').trim();

  if (name.length === 0) {
    throw new SchemaPlanError('Give the table a name.');
  }

  if (!columns || columns.length === 0) {
    throw new SchemaPlanError('Add at least one column.');
  }

  const specs = columns.map(draftToColumnSpec);

  if (opts.requirePk && !specs.some((s) => s.primaryKey)) {
    throw new SchemaPlanError('Pick a primary-key column so rows can be edited later.');
  }

  const createSql = wrapDdl(() => buildCreateTable({ name, columns: specs }));

  const statements: PlannedStatement[] = [
    {
      sql: createSql,
      destructive: false,
      summary: `Create table "${name}" with ${specs.length} column${specs.length === 1 ? '' : 's'}`,
    },
  ];

  // One CREATE UNIQUE INDEX per unique column (skip PK columns — they're already unique).
  for (const draft of columns) {
    if (draft.unique && !draft.primaryKey) {
      const col = draft.name.trim();
      const indexName = suggestIndexName(name, [col]);
      const sql = wrapDdl(() => buildCreateIndex({ name: indexName, table: name, columns: [col], unique: true }));
      statements.push({ sql, destructive: false, summary: `Add a unique constraint on "${col}"` });
    }
  }

  return { statements };
}

/**
 * Compile an "Add column" form into a single ALTER TABLE … ADD COLUMN statement. If the column is marked
 * `unique`, a follow-on CREATE UNIQUE INDEX is appended. Non-destructive.
 *
 * @throws {SchemaPlanError} for a blank table/column name (surfaced from the underlying `DdlError`).
 */
export function planAddColumn(table: string, draft: ColumnDraft): SchemaPlan {
  const spec = draftToColumnSpec(draft);
  const addSql = wrapDdl(() => buildAddColumn(table, spec));
  const statements: PlannedStatement[] = [
    { sql: addSql, destructive: false, summary: `Add column "${spec.name}" to "${table}"` },
  ];

  if (draft.unique && !draft.primaryKey) {
    const indexName = suggestIndexName(table, [spec.name]);
    const sql = wrapDdl(() => buildCreateIndex({ name: indexName, table, columns: [spec.name], unique: true }));
    statements.push({ sql, destructive: false, summary: `Add a unique constraint on "${spec.name}"` });
  }

  return { statements };
}

/**
 * Compile a "Rename column" form into a single ALTER TABLE … RENAME COLUMN statement. Non-destructive.
 *
 * @throws {SchemaPlanError} for a blank/invalid identifier, or when `from === to`.
 */
export function planRenameColumn(table: string, from: string, to: string): SchemaPlan {
  const f = (from ?? '').trim();
  const t = (to ?? '').trim();

  if (f.length === 0 || t.length === 0) {
    throw new SchemaPlanError('Pick the column to rename and its new name.');
  }

  if (f === t) {
    throw new SchemaPlanError('The new name is the same as the current one.');
  }

  const sql = wrapDdl(() => buildRenameColumn(table, f, t));

  return { statements: [{ sql, destructive: false, summary: `Rename "${f}" to "${t}" in "${table}"` }] };
}

/**
 * Compile a "Drop column" form into a single ALTER TABLE … DROP COLUMN statement. DESTRUCTIVE — the column's
 * data is lost. The component type-to-confirms and sends `confirm:true`.
 *
 * @throws {SchemaPlanError} for a blank/invalid identifier.
 */
export function planDropColumn(table: string, column: string): SchemaPlan {
  const col = (column ?? '').trim();

  if (col.length === 0) {
    throw new SchemaPlanError('Pick the column to drop.');
  }

  const sql = wrapDdl(() => buildDropColumn(table, col));

  return {
    statements: [{ sql, destructive: true, summary: `Drop column "${col}" from "${table}" (its data is lost)` }],
  };
}

/**
 * Compile a "Create index" form into a single CREATE [UNIQUE] INDEX statement. Non-destructive.
 *
 * @throws {SchemaPlanError} for a blank/invalid identifier or an empty column list.
 */
export function planCreateIndex(
  table: string,
  columns: readonly string[],
  opts: { name?: string; unique?: boolean } = {},
): SchemaPlan {
  const cols = (columns ?? []).map((c) => (c ?? '').trim()).filter((c) => c.length > 0);

  if (cols.length === 0) {
    throw new SchemaPlanError('Pick at least one column to index.');
  }

  const name = (opts.name ?? '').trim() || suggestIndexName(table, cols);
  const sql = wrapDdl(() => buildCreateIndex({ name, table, columns: cols, unique: opts.unique }));

  return {
    statements: [
      {
        sql,
        destructive: false,
        summary: `Create ${opts.unique ? 'a unique ' : 'an '}index "${name}" on ${cols.map((c) => `"${c}"`).join(', ')}`,
      },
    ],
  };
}
