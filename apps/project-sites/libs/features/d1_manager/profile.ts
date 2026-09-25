/**
 * Pure logic for D1 "Profile table" — the standout pro-SQLite-manager feature (DB Browser /
 * Beekeeper / SQLiteStudio). Parses columns from a CREATE TABLE statement, builds ONE bounded
 * single-scan aggregate query (row count + per-column non-null / distinct / min / max, + avg for
 * numeric columns), and shapes the result into per-column stats. No I/O — unit-tested in isolation.
 *
 * Identifiers come from the SERVER-fetched DDL (never client input) and are quoted defensively
 * ({@link quoteIdent}); values are never interpolated. The scan is bounded to {@link PROFILE_COLUMN_CAP}
 * columns (query width + cost) and its `rows_read` is surfaced so the operator sees the scan cost.
 */

/** Max columns profiled in one scan — bounds the query width + the scan cost. */
export const PROFILE_COLUMN_CAP = 40;

export interface ProfileColumn {
  name: string;
  type: string;
}

export interface ColumnProfile {
  name: string;
  type: string;
  nonNull: number;
  nullCount: number;
  distinct: number;
  min: string | null;
  max: string | null;
  /** Mean — only for numeric-typed columns (null otherwise; SQLite's AVG of text is meaningless). */
  avg: number | null;
}

export interface TableProfile {
  rowCount: number;
  columns: ColumnProfile[];
  /** Rows the profiling scan READ (the D1-billed cost), or null when the runtime omits it. */
  rowsRead: number | null;
  /** True when the table has more columns than {@link PROFILE_COLUMN_CAP} (the rest are not profiled). */
  capped: boolean;
}

/** Split a DDL column list on TOP-LEVEL commas (ignores commas inside quotes / parens). */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let closeQuote = '';
  for (const ch of body) {
    if (closeQuote) {
      cur += ch;
      if (ch === closeQuote) closeQuote = '';
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'") {
      closeQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') {
      closeQuote = ']';
      cur += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Strip surrounding quotes / backticks / brackets from an identifier + unescape doubled quotes. */
function unquoteIdent(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const first = s[0];
  if (first === '"' || first === '`') return s.slice(1, -1).split(first + first).join(first);
  if (first === '[') return s.slice(1, -1);
  return s;
}

/**
 * Extract `{ name, type }` per column from a CREATE TABLE statement. Table-level constraints
 * (PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK / CONSTRAINT) are skipped. Views / virtual tables and
 * unparseable input → `[]` (the caller then profiles the row count only). Bounded, pure.
 *
 * @param ddl - the CREATE statement from `sqlite_master` (server-fetched)
 * @returns columns in declaration order
 * @example parseProfileColumns('CREATE TABLE t (id INTEGER PRIMARY KEY, "n" TEXT)')
 *   // → [{name:'id',type:'INTEGER'}, {name:'n',type:'TEXT'}]
 */
export function parseProfileColumns(ddl: string | null): ProfileColumn[] {
  if (!ddl || !/^\s*CREATE\s+TABLE\b/i.test(ddl)) return [];
  const open = ddl.indexOf('(');
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < ddl.length; i += 1) {
    if (ddl[i] === '(') depth += 1;
    else if (ddl[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const cols: ProfileColumn[] = [];
  for (const part of splitTopLevelCommas(ddl.slice(open + 1, end))) {
    const item = part.trim();
    if (!item) continue;
    if (/^(CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\s*\(|CHECK\s*\()/i.test(item)) continue;
    const m = /^\s*("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][\w$]*)\s*([A-Za-z][\w]*)?/.exec(item);
    if (!m) continue;
    const name = unquoteIdent(m[1]);
    if (!name) continue;
    cols.push({ name, type: (m[2] ?? '').toUpperCase() });
  }
  return cols;
}

/** SQLite-quote an identifier: wrap in `"..."` and double any internal `"` (defense in depth). */
export function quoteIdent(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

/** True when a declared type is numeric-ish — drives whether AVG is computed + shown. */
export function isNumericType(type: string): boolean {
  return /INT|REAL|NUMERIC|DECIMAL|FLOAT|DOUBLE/i.test(type);
}

/**
 * Build the ONE-scan aggregate query for a table profile: `COUNT(*)` + per-column non-null / distinct
 * / min / max (+ avg for numeric columns). Columns are capped at {@link PROFILE_COLUMN_CAP}. Returns
 * the SQL and the columns actually used (aligned to the result aliases `n{i}`/`d{i}`/`mn{i}`/…).
 *
 * @example buildProfileQuery('t', [{name:'id',type:'INTEGER'}]).sql
 *   // → 'SELECT COUNT(*) AS "c", COUNT("id") AS "n0", COUNT(DISTINCT "id") AS "d0", MIN("id") AS "mn0", MAX("id") AS "mx0", AVG("id") AS "av0" FROM "t"'
 */
export function buildProfileQuery(
  table: string,
  columns: ProfileColumn[],
): { sql: string; used: ProfileColumn[] } {
  const used = columns.slice(0, PROFILE_COLUMN_CAP);
  const parts = ['COUNT(*) AS "c"'];
  used.forEach((col, i) => {
    const q = quoteIdent(col.name);
    parts.push(
      `COUNT(${q}) AS "n${i}"`,
      `COUNT(DISTINCT ${q}) AS "d${i}"`,
      `MIN(${q}) AS "mn${i}"`,
      `MAX(${q}) AS "mx${i}"`,
    );
    if (isNumericType(col.type)) parts.push(`AVG(${q}) AS "av${i}"`);
  });
  return { sql: `SELECT ${parts.join(', ')} FROM ${quoteIdent(table)}`, used };
}

/** Coerce a min/max scalar to a bounded display string (objects → JSON, capped 120 chars). */
function toDisplay(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 120);
    } catch {
      return String(v).slice(0, 120);
    }
  }
  return String(v).slice(0, 120);
}

/**
 * Shape one aggregate result row + the used columns into a {@link TableProfile}. `nullCount` is
 * derived as `rowCount - nonNull` (never negative). `avg` is surfaced only when the aggregate came
 * back numeric. Pure — no throws.
 *
 * @param row - the single aggregate row (keys `c`, `n{i}`, `d{i}`, `mn{i}`, `mx{i}`, `av{i}`)
 * @param used - the columns from {@link buildProfileQuery} (index-aligned to the aliases)
 * @param rowsRead - the scan cost from the D1 `meta`, or null
 * @param capped - whether the column list was truncated
 */
export function parseProfileResult(
  row: Record<string, unknown> | undefined,
  used: ProfileColumn[],
  rowsRead: number | null,
  capped: boolean,
): TableProfile {
  const rowCount = Number(row?.['c'] ?? 0) || 0;
  const columns: ColumnProfile[] = used.map((col, i) => {
    const nonNull = Number(row?.[`n${i}`] ?? 0) || 0;
    const distinct = Number(row?.[`d${i}`] ?? 0) || 0;
    const avgRaw = row?.[`av${i}`];
    const avgNum = typeof avgRaw === 'number' ? avgRaw : Number(avgRaw);
    return {
      name: col.name,
      type: col.type,
      nonNull,
      nullCount: Math.max(0, rowCount - nonNull),
      distinct,
      min: toDisplay(row?.[`mn${i}`]),
      max: toDisplay(row?.[`mx${i}`]),
      avg: avgRaw != null && Number.isFinite(avgNum) ? avgNum : null,
    };
  });
  return { rowCount, columns, rowsRead, capped };
}
