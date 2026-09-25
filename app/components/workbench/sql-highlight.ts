/**
 * @module components/workbench/sql-highlight
 *
 * A dependency-free, SQLite-aware SQL tokenizer for the Data console's editor. Powers a
 * highlighted-textarea overlay (see {@link ./SqlEditor}) — NOT CodeMirror — so the SQL console
 * gets real syntax highlighting without pulling `@codemirror/lang-sql` into the bolt.diy bundle
 * (bolt.diy ships the CodeMirror suite but not lang-sql; a highlighted overlay keeps the existing
 * textarea's caret/selection/undo/history semantics intact).
 *
 * PURE: `tokenizeSql` is a total function (string → tokens); every character of the input appears
 * in exactly one token, in order, so `tokens.map(t => t.text).join('') === input` always holds.
 * That invariant is what lets the overlay `<pre>` align glyph-for-glyph with the `<textarea>`.
 */

/** Token classes the overlay maps to colour spans. `text` = identifiers / whitespace / operators. */
export type SqlTokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'punct' | 'text';

/** One contiguous run of SQL of a single {@link SqlTokenKind}. */
export interface SqlToken {
  readonly text: string;
  readonly kind: SqlTokenKind;
}

/**
 * SQLite / D1 keyword set (upper-cased; matched case-insensitively). Covers DDL + DML + the
 * clauses, types, and functions an owner/dev actually types in the console. Not exhaustive of
 * every SQLite keyword — highlighting a non-keyword as an identifier is harmless (never wrong data).
 */
const SQL_KEYWORDS: ReadonlySet<string> = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'AUTOINCREMENT', 'BEGIN', 'BETWEEN', 'BY', 'CASE',
  'CAST', 'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT_DATE',
  'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP',
  'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXISTS', 'EXPLAIN', 'FOREIGN', 'FROM', 'FULL', 'GLOB', 'GROUP',
  'HAVING', 'IF', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT',
  'LIKE', 'LIMIT', 'NOT', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PLAN', 'PRAGMA', 'PRIMARY',
  'QUERY', 'REFERENCES', 'RENAME', 'REPLACE', 'RETURNING', 'RIGHT', 'ROLLBACK', 'SELECT', 'SET',
  'TABLE', 'THEN', 'TRANSACTION', 'TRIGGER', 'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'VIEW',
  'WHEN', 'WHERE', 'WITH', 'WITHOUT', 'ROWID',
  // types
  'INTEGER', 'INT', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'VARCHAR',
  // common aggregate / scalar functions
  'ABS', 'AVG', 'COALESCE', 'COUNT', 'GROUP_CONCAT', 'IFNULL', 'JSON_EXTRACT', 'LENGTH', 'LOWER',
  'MAX', 'MIN', 'NULLIF', 'ROUND', 'SUM', 'TOTAL', 'TRIM', 'UPPER',
]);

const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/**
 * Tokenize a SQL string into typed spans for highlighting. Handles: `--` line comments,
 * `/* *​/` block comments, single-quoted strings (with `''` escape), double-quoted quoted
 * identifiers, numeric literals, keywords (case-insensitive), and everything else as `text`.
 * Unterminated strings/comments run to end-of-input (highlighted as their kind — matches how an
 * editor shows an in-progress token). Total: concatenating token texts reproduces the input.
 *
 * @example tokenizeSql("SELECT id FROM t -- x")
 *   // → [{keyword SELECT}, {text ' '}, {text 'id'}, {text ' '}, {keyword FROM}, {text ' t '}, {comment '-- x'}]
 */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  let plain = ''; // accumulator for consecutive `text` chars (whitespace, operators, identifiers)
  const flush = (): void => {
    if (plain) {
      tokens.push({ text: plain, kind: 'text' });
      plain = '';
    }
  };
  const push = (text: string, kind: SqlTokenKind): void => {
    flush();
    tokens.push({ text, kind });
  };

  while (i < n) {
    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // line comment: -- … EOL
    if (c === '-' && next === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n') j++;
      push(sql.slice(i, j), 'comment');
      i = j;
      continue;
    }
    // block comment: /* … */
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      j = j < n ? j + 2 : n; // include the closing */ when present
      push(sql.slice(i, j), 'comment');
      i = j;
      continue;
    }
    // single-quoted string literal (SQLite escapes a quote by doubling it: '')
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      push(sql.slice(i, j), 'string');
      i = j;
      continue;
    }
    // double-quoted quoted identifier (highlight distinctly from bare identifiers)
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      push(sql.slice(i, j), 'string');
      i = j;
      continue;
    }
    // number (integer or decimal; leading digit only — `.5` stays punct+number, close enough)
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isDigit(sql[j]) || sql[j] === '.')) j++;
      push(sql.slice(i, j), 'number');
      i = j;
      continue;
    }
    // word → keyword or identifier
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      const word = sql.slice(i, j);
      if (SQL_KEYWORDS.has(word.toUpperCase())) {
        push(word, 'keyword');
      } else {
        plain += word; // identifier → text
      }
      i = j;
      continue;
    }
    // punctuation (operators, parens, commas, semicolons, ?N placeholders' ?)
    if (/[()[\],;.*=<>!+\-/%|&?:]/.test(c)) {
      push(c, 'punct');
      i++;
      continue;
    }
    // whitespace / anything else → accumulate as text
    plain += c;
    i++;
  }
  flush();
  return tokens;
}
