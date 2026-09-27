/**
 * @file Unit tests for the schema-aware SQL completion core (Data console). Pure logic: current-word
 * extraction, ranked candidates over the inspected schema + keywords, and applying a chosen candidate.
 */
import { describe, it, expect } from 'vitest';

import { applyCompletion, currentWord, sqlCompletions } from './sql-complete';

const schema = { tables: ['users', 'usage_events', 'orders'], columns: ['id', 'email', 'user_id'] };

describe('currentWord', () => {
  it('returns the identifier fragment immediately left of the caret', () => {
    expect(currentWord('SELECT id FROM us')).toBe('us');
    expect(currentWord('SELECT * FROM users WHERE ema')).toBe('ema');
  });
  it('is empty when the caret is after whitespace or punctuation (no active word)', () => {
    expect(currentWord('SELECT ')).toBe('');
    expect(currentWord('SELECT * FROM users WHERE (')).toBe('');
    expect(currentWord('')).toBe('');
  });
});

describe('sqlCompletions', () => {
  it('offers only REAL schema tables/columns that prefix-match (never a fabricated identifier)', () => {
    const out = sqlCompletions('SELECT * FROM us', schema);
    // usage_events(tbl), user_id(col), users(tbl) all prefix-match "us"; keywords do not.
    expect(out.map((c) => c.label)).toEqual(['usage_events', 'user_id', 'users']);
    expect(out.some((c) => c.kind === 'keyword')).toBe(false);
  });

  it('completes column names + tags their kind', () => {
    const out = sqlCompletions('SELECT ema', schema);
    expect(out.find((c) => c.label === 'email')).toEqual({ label: 'email', kind: 'column' });
  });

  it('ranks schema identifiers ABOVE bare keywords', () => {
    // 'or' prefix-matches the `orders` table AND the OR/ORDER BY keywords — table should rank first.
    const out = sqlCompletions('WHERE x = 1 or', schema);
    expect(out[0]).toEqual({ label: 'orders', kind: 'table' });
    expect(out.some((c) => c.kind === 'keyword' && c.label.startsWith('OR'))).toBe(true);
  });

  it('returns [] when there is no active word (never dumps the whole list)', () => {
    expect(sqlCompletions('SELECT * FROM ', schema)).toEqual([]);
    expect(sqlCompletions('', schema)).toEqual([]);
  });

  it('excludes a word that is already fully typed (nothing left to complete)', () => {
    expect(sqlCompletions('SELECT * FROM users', schema).some((c) => c.label === 'users')).toBe(false);
  });

  it('caps the candidate list', () => {
    const big = { tables: Array.from({ length: 50 }, (_, i) => `tbl_${i}`), columns: [] };
    expect(sqlCompletions('SELECT * FROM tbl', big).length).toBeLessThanOrEqual(8);
  });
});

describe('applyCompletion', () => {
  it('replaces the current word with the completion + returns the new caret', () => {
    expect(applyCompletion('SELECT * FROM us', 16, 'users')).toEqual({
      text: 'SELECT * FROM users',
      caret: 19,
    });
  });
  it('preserves text after the caret', () => {
    const { text, caret } = applyCompletion('SELECT ema FROM users', 10, 'email');
    expect(text).toBe('SELECT email FROM users');
    expect(text.slice(caret)).toBe(' FROM users');
  });
});
