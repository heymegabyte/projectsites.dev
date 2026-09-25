/**
 * Pure logic for D1 "Data insights" — the overview takeaways strip. Builds ONE bounded query that
 * counts the rows of every table in a single round-trip (each `(SELECT COUNT(*) FROM "t")` is a
 * scalar subquery), and shapes the result. No I/O — unit-tested. Identifiers come from the
 * SERVER-fetched catalog (never client input) and are quoted via {@link quoteIdent}.
 */
import { quoteIdent } from './profile.js';

/** Max tables counted in one insights query (bounds width + cost); the rest are disclosed as capped. */
export const INSIGHTS_TABLE_CAP = 40;

/** One table's row count. */
export interface TableRowCount {
  name: string;
  rows: number;
}

/**
 * Build the ONE-round-trip row-count query for up to {@link INSIGHTS_TABLE_CAP} tables. Each column
 * `c{i}` is `(SELECT COUNT(*) FROM "<table>")`. Returns `sql:null` when there are no tables (the
 * caller then reports structure-only insights).
 *
 * @example buildRowCountQuery(['users','orders']).sql
 *   // → 'SELECT (SELECT COUNT(*) FROM "users") AS "c0", (SELECT COUNT(*) FROM "orders") AS "c1"'
 */
export function buildRowCountQuery(tableNames: readonly string[]): {
  sql: string | null;
  used: string[];
} {
  const used = tableNames.slice(0, INSIGHTS_TABLE_CAP);
  if (used.length === 0) return { sql: null, used: [] };
  const parts = used.map((name, i) => `(SELECT COUNT(*) FROM ${quoteIdent(name)}) AS "c${i}"`);
  return { sql: `SELECT ${parts.join(', ')}`, used };
}

/**
 * Shape the single row-count result row into `{ name, rows }[]` aligned to `used`. Missing / non-finite
 * counts become 0 (a real count of 0 is legitimate — an empty table). Pure.
 */
export function parseRowCounts(
  row: Record<string, unknown> | undefined,
  used: readonly string[],
): TableRowCount[] {
  return used.map((name, i) => {
    const n = Number(row?.[`c${i}`]);
    return { name, rows: Number.isFinite(n) && n >= 0 ? n : 0 };
  });
}
