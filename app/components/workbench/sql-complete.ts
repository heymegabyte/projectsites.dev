/**
 * @module components/workbench/sql-complete
 *
 * Dependency-free, schema-aware completion for the Data SQL console — the companion to
 * {@link ./sql-highlight}. Pure logic (no CodeMirror, no DOM): given the text left of the caret and
 * the inspected schema (real table + column identifiers the console already knows), return ranked
 * candidates for the word being typed. The {@link ./SqlEditor} overlay renders + inserts them.
 *
 * Schema-AWARE (not just keywords): table/column names come from the authoritative inspected schema
 * the Data tab already loaded, so completions only ever suggest identifiers that actually exist —
 * never a fabricated column. Case-insensitive prefix match; exact-prefix ranks above contains;
 * tables/columns rank above bare keywords (you type those less often than SQL words); capped small.
 */

/** A completion candidate. `kind` drives the little type badge + colour in the dropdown. */
export type SqlCompletionKind = 'keyword' | 'table' | 'column';
export interface SqlCompletion {
  /** The identifier/keyword shown + inserted (verbatim — schema idents keep their real case). */
  readonly label: string;
  readonly kind: SqlCompletionKind;
}

/** The inspected schema the console feeds completion — real identifiers only. */
export interface SqlSchema {
  readonly tables: readonly string[];
  readonly columns: readonly string[];
}

/** Keywords offered when they prefix-match the current word (lower priority than schema idents). */
const COMPLETION_KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'CREATE INDEX',
  'DROP TABLE', 'ALTER TABLE', 'VALUES', 'SET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'GROUP BY',
  'ORDER BY', 'LIMIT', 'OFFSET', 'HAVING', 'DISTINCT', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL',
  'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN', 'AS', 'ASC', 'DESC', 'COUNT(', 'SUM(', 'AVG(', 'MIN(',
  'MAX(', 'PRAGMA', 'EXPLAIN QUERY PLAN',
];

const MAX_COMPLETIONS = 8;

/**
 * The identifier fragment immediately left of the caret — the word being completed. Returns '' when
 * the caret isn't in/after a word (so the caller shows nothing rather than the whole list).
 *
 * @example currentWord('SELECT id FROM us') // 'us'
 * @example currentWord('SELECT ')           // '' (whitespace before caret → no active word)
 */
export function currentWord(textBeforeCaret: string): string {
  const m = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(textBeforeCaret);
  return m ? m[0] : '';
}

/**
 * Ranked completion candidates for the word left of the caret, drawn from the inspected schema +
 * SQL keywords. Empty when there's no active word or nothing matches (never a fabricated column).
 *
 * Ranking: exact case-insensitive prefix first, then substring; within each, tables + columns before
 * keywords; de-duplicated; capped at {@link MAX_COMPLETIONS}. The word itself (already fully typed)
 * is excluded so the list never offers what you've finished typing.
 *
 * @example sqlCompletions('SELECT * FROM us', { tables: ['users','usage'], columns: [] })
 *   // → [{label:'usage',kind:'table'}, {label:'users',kind:'table'}]  (both prefix-match 'us')
 */
export function sqlCompletions(textBeforeCaret: string, schema: SqlSchema): SqlCompletion[] {
  const word = currentWord(textBeforeCaret);
  if (!word) return [];
  const lower = word.toLowerCase();

  const pool: SqlCompletion[] = [
    ...schema.tables.map((t): SqlCompletion => ({ label: t, kind: 'table' })),
    ...schema.columns.map((c): SqlCompletion => ({ label: c, kind: 'column' })),
    ...COMPLETION_KEYWORDS.map((k): SqlCompletion => ({ label: k, kind: 'keyword' })),
  ];

  // Rank weight: lower is better. Prefix (0) beats substring (2); tables/cols (−1) beat keywords (0).
  const scored: Array<{ c: SqlCompletion; score: number }> = [];
  const seen = new Set<string>();
  for (const c of pool) {
    const label = c.label.toLowerCase();
    if (label === lower) continue; // already fully typed — nothing to complete
    const dedupeKey = `${c.kind}:${label}`;
    if (seen.has(dedupeKey)) continue;
    let score: number;
    if (label.startsWith(lower)) score = 0;
    else if (label.includes(lower)) score = 2;
    else continue; // no match
    if (c.kind === 'keyword') score += 1; // schema idents rank above keywords
    seen.add(dedupeKey);
    scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || a.c.label.localeCompare(b.c.label));
  return scored.slice(0, MAX_COMPLETIONS).map((s) => s.c);
}

/**
 * Apply a chosen completion: replace the current word (left of the caret) with `completion`, keeping
 * everything from the caret onward. Returns the new text + the new caret offset (end of the inserted
 * completion). Pure — the component sets the textarea value + selection from this.
 *
 * @example applyCompletion('SELECT * FROM us', 16, 'users')
 *   // → { text: 'SELECT * FROM users', caret: 19 }
 */
export function applyCompletion(
  fullText: string,
  caret: number,
  completion: string,
): { text: string; caret: number } {
  const before = fullText.slice(0, caret);
  const after = fullText.slice(caret);
  const word = currentWord(before);
  const start = before.length - word.length;
  const text = before.slice(0, start) + completion + after;
  return { text, caret: start + completion.length };
}
