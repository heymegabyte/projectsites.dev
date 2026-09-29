/**
 * data-search-logic.spec.ts
 *
 * Unit tests for the pure logic behind the ⌘K global data-search palette — flattening a raw cross-table
 * search reply (from the EXISTING `POST /db/search` endpoint) into one keyboard-navigable list, counting
 * matches for the honest empty/summary states, wrap-around ↑/↓ index math, and the min-length search gate.
 */
import { describe, expect, it } from 'vitest';
import {
  flattenSearchResults,
  isSearchable,
  nextResultIndex,
  totalMatchCount,
  type DataSearchReply,
} from './data-search-logic';

const REPLY: DataSearchReply = {
  ok: true,
  enabled: true,
  nameMatches: ['customers', 'customer_notes'],
  contentMatches: [
    { table: 'orders', column: 'note', rowid: 42, snippet: 'urgent ACME order' },
    { table: 'customers', column: 'name', rowid: 7, snippet: 'ACME Corp' },
  ],
  truncated: false,
};

describe('flattenSearchResults', () => {
  it('lists table-name matches first, then in-content matches, in a stable order', () => {
    const out = flattenSearchResults(REPLY);

    expect(out.map((r) => r.kind)).toEqual(['table', 'table', 'content', 'content']);
    expect(out[0]).toMatchObject({ kind: 'table', table: 'customers' });
    expect(out[1]).toMatchObject({ kind: 'table', table: 'customer_notes' });
    expect(out[2]).toMatchObject({ kind: 'content', table: 'orders', column: 'note', rowid: 42 });
    expect(out[3]).toMatchObject({ kind: 'content', table: 'customers', column: 'name', rowid: 7 });
  });

  it('gives every result a unique, stable key', () => {
    const keys = flattenSearchResults(REPLY).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('de-dupes repeated table-name matches and drops blanks', () => {
    const out = flattenSearchResults({ nameMatches: ['t', 't', '  ', 't'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'table', table: 't' });
  });

  it('returns an empty list for null / empty replies', () => {
    expect(flattenSearchResults(null)).toEqual([]);
    expect(flattenSearchResults(undefined)).toEqual([]);
    expect(flattenSearchResults({})).toEqual([]);
    expect(flattenSearchResults({ nameMatches: [], contentMatches: [] })).toEqual([]);
  });

  it('keeps a content match whose table also matched by name (opens same table, carries the row)', () => {
    const out = flattenSearchResults(REPLY);
    const contentForCustomers = out.filter((r) => r.kind === 'content' && r.table === 'customers');
    expect(contentForCustomers).toHaveLength(1);
    expect(contentForCustomers[0].rowid).toBe(7);
  });
});

describe('totalMatchCount', () => {
  it('sums name + content matches', () => {
    expect(totalMatchCount(REPLY)).toBe(4);
    expect(totalMatchCount({ nameMatches: [], contentMatches: [] })).toBe(0);
    expect(totalMatchCount(null)).toBe(0);
  });
});

describe('nextResultIndex', () => {
  it('moves down with wrap', () => {
    expect(nextResultIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextResultIndex('ArrowDown', 2, 3)).toBe(0);
  });

  it('moves up with wrap', () => {
    expect(nextResultIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextResultIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('is a no-op for non-arrow keys or an empty list', () => {
    expect(nextResultIndex('Enter', 1, 3)).toBe(1);
    expect(nextResultIndex('ArrowDown', 0, 0)).toBe(0);
  });
});

describe('isSearchable', () => {
  it('requires the trimmed query to meet the minimum length', () => {
    expect(isSearchable('a')).toBe(false);
    expect(isSearchable('  a  ')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
    expect(isSearchable('  acme  ')).toBe(true);
    expect(isSearchable('')).toBe(false);
  });

  it('honors a custom minimum', () => {
    expect(isSearchable('abc', 4)).toBe(false);
    expect(isSearchable('abcd', 4)).toBe(true);
  });
});
