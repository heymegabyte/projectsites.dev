/**
 * @module libs/features/site_data_api/site_data_column_types
 *
 * @description
 * The per-site D1 "Data" tables' **column-type vocabulary + strict-ISO date detection** (fire-84).
 *
 * The base executor (`src/services/site_data_db.ts`) clamps column types to the raw SQLite affinities
 * (`TEXT`/`INTEGER`/`REAL`/`NUMERIC`/`BLOB`) — a `date` type collapses to `TEXT`, losing the owner's
 * intent. This module adds `DATE` as a FIRST-CLASS, selectable column type for the owner-facing grid
 * (it carries SQLite NUMERIC affinity under the hood, values stored as ISO text) AND supplies the
 * **strict-ISO autodetect** the calendar / timeline / date-filter surfaces need.
 *
 * ⚠️ KNOWN BUG CLASS — detection is STRICT, never `new Date(x)` coercion. A numeric id / count / year
 * like `20240101` makes `new Date(20240101).getTime()` finite (~1970-08-22), so naive coercion
 * false-classifies an integer column as a date and fills a calendar with garbage 1970 days. Detection
 * here gates on a leading `^\d{4}-\d{2}-\d{2}` regex + a validity range-check — the same discipline the
 * editor's shipped `isoDayKey` uses (strict DETECT vs permissive bucket/display). Keep it strict.
 *
 * Isolation: this is pure classification + type-vocabulary logic — it never opens a DB. The per-site
 * executor (`resolveSiteDataDb` + `FORBIDDEN_DB_IDS` denylist) still owns which D1 a column lands in;
 * the ALTER/UPDATE SQL is built by the EXISTING `buildAddColumnSql` / `buildUpdateRowSql` (reused),
 * which this module just feeds a clamped `DATE` type into.
 *
 * @packageDocumentation
 */
import { isSafeIdent, quoteIdent } from '../../../src/services/site_data_db.js';

/**
 * A detected/selectable semantic column type for the per-site data grid. Lowercase = the DETECTION
 * vocabulary (what {@link detectColumnType} returns); the UPPER-CASE {@link SITE_COLUMN_TYPES} is the
 * SQLite-affinity form fed to the ALTER/CREATE builders.
 */
export type SiteColumnType = 'text' | 'integer' | 'real' | 'date';

/**
 * Whole-string ISO-8601 calendar DATE (`YYYY-MM-DD`) — no time component, so no timezone ambiguity.
 * Mirrors `app/components/workbench/data-cell-format.ts` `ISO_DATE_RE`.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole-string ISO-8601 DATETIME whose DATE part leads (`YYYY-MM-DD` + a time). We accept any time
 * suffix here (zoned or zone-less) for the purpose of "is this column a date column?" — a column of
 * timestamps IS a date column. (The editor's `isoDayKey` is stricter about zone for day-BUCKETING;
 * TYPE-detection only needs the leading calendar date to be real.)
 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * STRICT ISO-date test. Returns `true` ONLY for a string whose leading token is a real
 * `YYYY-MM-DD` calendar date (bare, or followed by a time) — range-checked so `2024-13-45` is rejected.
 * NEVER uses `new Date(x)` finiteness as the gate, so a number / numeric-id string / bare year
 * (`20240101`, `"20240101"`, `"2020"`, `"5"`, `5`) is NEVER mistaken for a date.
 *
 * @example isStrictIsoDate('2024-01-01')                // true
 * @example isStrictIsoDate('2024-01-01T23:30:00-05:00') // true
 * @example isStrictIsoDate(20240101)                    // false (a number is not a date)
 * @example isStrictIsoDate('2020')                      // false (a bare year is not a date)
 * @example isStrictIsoDate('2024-13-45')                // false (impossible month/day)
 */
export function isStrictIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!ISO_DATE_RE.test(value) && !ISO_DATETIME_RE.test(value)) return false;
  // Shape matched — range-check the calendar date so junk that merely LOOKS date-shaped is rejected.
  // Parse ONLY the leading YYYY-MM-DD (UTC midnight) and confirm the parts round-trip (no overflow
  // like month 13 silently rolling into the next year).
  const [y, m, d] = value.slice(0, 10).split('-').map((n) => Number.parseInt(n, 10));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

/** True when `v` is (or stringifies to) a finite number — the numeric-column signal. */
function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 && Number.isFinite(Number(t));
  }
  return false;
}

/** True when a numeric value is an integer (no fractional part). */
function isIntegerValue(v: unknown): boolean {
  return isNumericValue(v) && Number.isInteger(Number(v));
}

/**
 * Auto-detect the semantic type of a column from a sample of its values (one browse page is plenty).
 *
 * Decision order (first match over the NON-NULL samples wins):
 *  1. **`date`** — EVERY non-null sample passes {@link isStrictIsoDate}. Strict regex, never coercion —
 *     so a numeric-id column (`20240101`) or a bare-year column (`"2020"`) can NEVER be picked as a date.
 *  2. **`integer`** — every non-null sample is a whole number.
 *  3. **`real`** — every non-null sample is numeric (at least one fractional).
 *  4. **`text`** — anything else, and the empty/all-null case (safest default).
 *
 * `null`/`undefined` samples are ignored (a sparse column is still typed by its present values).
 *
 * @param values - a column's sampled cell values (e.g. one browse page)
 * @returns the detected {@link SiteColumnType}
 * @example detectColumnType(['2024-01-01', '2024-02-15']) // 'date'
 * @example detectColumnType([20240101, 20240102])          // 'integer' (NOT 'date' — the bug class)
 * @example detectColumnType([1.5, 2])                       // 'real'
 */
export function detectColumnType(values: readonly unknown[]): SiteColumnType {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return 'text';
  if (present.every(isStrictIsoDate)) return 'date';
  if (present.every(isNumericValue)) {
    return present.every(isIntegerValue) ? 'integer' : 'real';
  }
  return 'text';
}

/**
 * The SQLite column type a detected/selected `DATE` is stored as. SQLite has no native DATE type —
 * `DATE` carries NUMERIC affinity, and we store the value as ISO-8601 TEXT. Declaring the column
 * `DATE` preserves the owner's INTENT (and drives the date cell-editor) while staying valid SQLite.
 */
export const DATE_SQLITE_TYPE = 'DATE' as const;

/**
 * The base SQLite affinities the per-site executor already accepts (mirrors the base
 * `ALLOWED_COL_TYPES` in `site_data_db.ts`), PLUS `DATE` as a first-class owner-selectable type.
 */
export const SITE_COLUMN_TYPES: readonly string[] = [
  'TEXT',
  'INTEGER',
  'REAL',
  'NUMERIC',
  'BLOB',
  DATE_SQLITE_TYPE,
];

/**
 * Clamp an arbitrary column-type string to the per-site vocabulary ({@link SITE_COLUMN_TYPES}),
 * defaulting unknown → `TEXT`. Unlike the base `clampColumnType` (which has no `DATE` and collapses it
 * to `TEXT`), this KEEPS a `date`/`DATE` request as `DATE` so the grid can offer a proper date column +
 * cell-editor. Feed the result straight to {@link buildAddColumnSql}/{@link buildCreateTableSql}.
 *
 * @example clampSiteColumnType('date')    // 'DATE'
 * @example clampSiteColumnType('integer') // 'INTEGER'
 * @example clampSiteColumnType('wat')     // 'TEXT'
 */
export function clampSiteColumnType(type: unknown): string {
  const up = String(type ?? '').toUpperCase();
  return SITE_COLUMN_TYPES.includes(up) ? up : 'TEXT';
}

/**
 * Build a safe `ALTER TABLE … ADD COLUMN "<col>" DATE` for the grid's "add a date column" action.
 *
 * The base `buildAddColumnSql` re-clamps the type through `clampColumnType`, whose vocabulary has no
 * `DATE` — so it silently rewrites a date column to `TEXT`, erasing the owner's intent + the signal
 * the date cell-editor keys off. This builder preserves `DATE` while REUSING the service's
 * {@link isSafeIdent} allowlist + {@link quoteIdent} escaping (identifier safety is NOT reimplemented).
 * The column is ALWAYS nullable (SQLite can't ADD a NOT NULL column to a populated table without a
 * DEFAULT — the owner backfills later). Returns `null` on a hostile identifier (caller → clean 400).
 *
 * @example buildAddDateColumnSql('events', 'starts_on') // ALTER TABLE "events" ADD COLUMN "starts_on" DATE
 * @example buildAddDateColumnSql('t', '1bad')           // null (leading digit)
 */
export function buildAddDateColumnSql(table: string, column: string): string | null {
  if (!isSafeIdent(table) || !isSafeIdent(column)) return null;
  return `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${DATE_SQLITE_TYPE}`;
}
