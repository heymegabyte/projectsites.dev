/**
 * @file Unit tests for the SQLite-aware tokenizer that powers the Data console's SQL highlighting.
 * The load-bearing invariant is TOTALITY: concatenating the token texts must reproduce the input
 * exactly (that's what keeps the highlight overlay aligned with the textarea's caret).
 */
import { describe, it, expect } from 'vitest';

import { tokenizeSql, type SqlToken } from './sql-highlight';

const joined = (toks: SqlToken[]): string => toks.map((t) => t.text).join('');
const kinds = (sql: string, kind: SqlToken['kind']): string[] =>
  tokenizeSql(sql)
    .filter((t) => t.kind === kind)
    .map((t) => t.text);

describe('tokenizeSql', () => {
  it('is TOTAL — concatenated token texts reproduce the input exactly', () => {
    for (const sql of [
      '',
      'SELECT 1',
      "SELECT * FROM users WHERE email = 'a@b.com' -- find\nLIMIT 10;",
      "UPDATE t SET n = n + 1 /* bump */ WHERE id = ?1;",
      'weird   \t\n  spacing  ()[],;',
      "unterminated 'string",
    ]) {
      expect(joined(tokenizeSql(sql))).toBe(sql);
    }
  });

  it('highlights keywords case-insensitively', () => {
    expect(kinds('select Id from T', 'keyword')).toEqual(['select', 'from']); // Id/T are identifiers
    expect(kinds('SELECT', 'keyword')).toEqual(['SELECT']);
    expect(kinds('Create Table x', 'keyword')).toEqual(['Create', 'Table']);
  });

  it('treats a non-keyword word as identifier text, not a keyword', () => {
    expect(kinds('users email created_at', 'keyword')).toEqual([]);
  });

  it("parses a single-quoted string with a doubled-quote '' escape as ONE token", () => {
    expect(kinds("WHERE name = 'it''s fine'", 'string')).toEqual(["'it''s fine'"]);
  });

  it('parses double-quoted identifiers as a (string-kind) quoted token', () => {
    expect(kinds('SELECT "weird col" FROM t', 'string')).toEqual(['"weird col"']);
  });

  it('parses line comments to end-of-line and block comments fully', () => {
    expect(kinds('SELECT 1 -- trailing note', 'comment')).toEqual(['-- trailing note']);
    expect(kinds('SELECT /* a\nb */ 1', 'comment')).toEqual(['/* a\nb */']);
  });

  it('highlights numeric literals (int + decimal)', () => {
    expect(kinds('LIMIT 42 OFFSET 3.14', 'number')).toEqual(['42', '3.14']);
  });

  it('runs an unterminated string/comment to end-of-input (no crash, honest in-progress token)', () => {
    expect(kinds("SELECT 'oops", 'string')).toEqual(["'oops"]);
    expect(kinds('SELECT /* oops', 'comment')).toEqual(['/* oops']);
  });

  it('classifies punctuation (parens, comma, semicolon, ?-placeholder) as punct', () => {
    expect(kinds('f(a, b);', 'punct')).toEqual(['(', ',', ')', ';']);
    expect(kinds('id = ?1', 'punct')).toEqual(['=', '?']);
  });
});
