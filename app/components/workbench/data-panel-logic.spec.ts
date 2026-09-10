/**
 * @file Unit tests for the Data-tab pure logic. Relative import (repo Vitest
 * convention — the `~/` alias resolves for app code but not spec direct imports).
 */
import { describe, it, expect } from 'vitest';
import {
  iconForTable,
  formatCellValue,
  summarizeTables,
  newCorrelationId,
  columnLabel,
  toCsv,
  filterRows,
  detailEntries,
} from './data-panel-logic';

describe('iconForTable', () => {
  it('maps known table keys to phosphor icons', () => {
    expect(iconForTable('visitor_events')).toBe('i-ph:chart-line-duotone');
    expect(iconForTable('form_submissions')).toBe('i-ph:envelope-duotone');
    expect(iconForTable('site_data')).toBe('i-ph:database-duotone');
  });
  it('falls back to a generic table icon for unknown keys', () => {
    expect(iconForTable('anything_new')).toBe('i-ph:table-duotone');
  });
});

describe('formatCellValue', () => {
  it('renders null / undefined / empty as an em-dash', () => {
    expect(formatCellValue(null)).toBe('—');
    expect(formatCellValue(undefined)).toBe('—');
    expect(formatCellValue('')).toBe('—');
  });
  it('stringifies primitives', () => {
    expect(formatCellValue('pageview')).toBe('pageview');
    expect(formatCellValue(42)).toBe('42');
    expect(formatCellValue(false)).toBe('false');
  });
  it('compact-JSONs objects and never throws on cycles', () => {
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof formatCellValue(cyclic)).toBe('string'); // no throw
  });
});

describe('summarizeTables', () => {
  it('counts total and populated tables', () => {
    expect(
      summarizeTables([
        { key: 'a', label: 'A', description: '', columns: [], row_count: 0, browsable: true },
        { key: 'b', label: 'B', description: '', columns: [], row_count: 5, browsable: true },
        { key: 'c', label: 'C', description: '', columns: [], row_count: 98, browsable: true },
      ]),
    ).toEqual({ total: 3, populated: 2 });
  });
  it('handles undefined / empty safely', () => {
    expect(summarizeTables(undefined)).toEqual({ total: 0, populated: 0 });
    expect(summarizeTables([])).toEqual({ total: 0, populated: 0 });
  });
});

describe('newCorrelationId', () => {
  it('returns a non-empty unique-ish string', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe('columnLabel', () => {
  it('title-cases snake_case column names', () => {
    expect(columnLabel('event_type')).toBe('Event Type');
    expect(columnLabel('created_at')).toBe('Created At');
    expect(columnLabel('email')).toBe('Email');
  });
});

describe('toCsv', () => {
  it('emits a labelled header + CRLF rows', () => {
    const csv = toCsv(['form_name', 'email'], [{ form_name: 'Contact', email: 'a@x.com' }]);
    expect(csv).toBe('Form Name,Email\r\nContact,a@x.com');
  });
  it('quotes fields containing comma / quote / newline and doubles embedded quotes', () => {
    const csv = toCsv(['v'], [{ v: 'a,b' }, { v: 'she said "hi"' }, { v: 'line1\nline2' }]);
    expect(csv).toBe('V\r\n"a,b"\r\n"she said ""hi"""\r\n"line1\nline2"');
  });
  it('renders null/undefined as empty (not em-dash) and objects as JSON', () => {
    expect(toCsv(['a', 'b'], [{ a: null, b: { x: 1 } }])).toBe('A,B\r\n,"{""x"":1}"');
  });
  it('header-only when there are no rows', () => {
    expect(toCsv(['a'], [])).toBe('A');
  });
});

describe('filterRows', () => {
  const rows = [
    { email: 'A@x.com', path: '/' },
    { email: 'b@y.com', path: '/about' },
  ];
  it('returns a fresh copy of all rows for a blank query', () => {
    const out = filterRows(rows, ['email', 'path'], '  ');
    expect(out).toHaveLength(2);
    expect(out).not.toBe(rows);
  });
  it('matches case-insensitively across ALL columns', () => {
    expect(filterRows(rows, ['email', 'path'], 'a@x')).toEqual([{ email: 'A@x.com', path: '/' }]);
    expect(filterRows(rows, ['email', 'path'], 'about')).toEqual([{ email: 'b@y.com', path: '/about' }]);
  });
  it('returns [] when nothing matches', () => {
    expect(filterRows(rows, ['email'], 'zzz')).toEqual([]);
  });
});

describe('detailEntries', () => {
  it('returns [label, value] pairs in column order with pretty JSON for objects', () => {
    const out = detailEntries({ event_type: 'pageview', meta: { ref: 'x' } }, ['event_type', 'meta']);
    expect(out[0]).toEqual(['Event Type', 'pageview']);
    expect(out[1][0]).toBe('Meta');
    expect(out[1][1]).toBe('{\n  "ref": "x"\n}'); // 2-space pretty
  });
  it('em-dashes null/empty scalars', () => {
    expect(detailEntries({ a: null }, ['a'])).toEqual([['A', '—']]);
  });
});
