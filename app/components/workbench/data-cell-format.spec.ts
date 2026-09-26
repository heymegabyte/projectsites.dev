/**
 * data-cell-format.spec.ts
 * Vitest unit tests for classifyCell + columnTypeBadge.
 * Covers: null, undefined, '', 0, false, 'false', 42, '42',
 *         {a:1}, '[1,2]', 'plain', declared-type affinity mapping,
 *         mixed-case types, and unknown→null.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyCell,
  columnTypeBadge,
  isoDayKey,
  blobCellInfo,
  humanBytes,
  type CellKind,
  type ClassifiedCell,
} from './data-cell-format.js';

/*
 * ---------------------------------------------------------------------------
 * Helper: assert shape without repeating all fields each time
 * ---------------------------------------------------------------------------
 */
function expectCell(value: unknown, expected: { kind: CellKind; display: string; isJson: boolean }) {
  const cell: ClassifiedCell = classifyCell(value);
  expect(cell.kind).toBe(expected.kind);
  expect(cell.display).toBe(expected.display);
  expect(cell.isJson).toBe(expected.isJson);
  expect(typeof cell.className).toBe('string');
  expect(cell.className.length).toBeGreaterThan(0);
}

/*
 * ---------------------------------------------------------------------------
 * classifyCell — null / undefined
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — null/undefined', () => {
  it('classifies null as null kind with display NULL', () => {
    expectCell(null, { kind: 'null', display: 'NULL', isJson: false });
  });

  it('classifies undefined as null kind with display NULL', () => {
    expectCell(undefined, { kind: 'null', display: 'NULL', isJson: false });
  });

  it('null className contains italic (muted italic style)', () => {
    expect(classifyCell(null).className).toContain('italic');
  });
});

/*
 * ---------------------------------------------------------------------------
 * classifyCell — empty string
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — empty string', () => {
  it('classifies empty string as empty kind with display ""', () => {
    expectCell('', { kind: 'empty', display: '""', isJson: false });
  });

  it('empty className is distinct from null className', () => {
    expect(classifyCell('').className).not.toBe(classifyCell(null).className);
  });

  it('empty className also contains italic (muted italic style)', () => {
    expect(classifyCell('').className).toContain('italic');
  });
});

/*
 * ---------------------------------------------------------------------------
 * classifyCell — numbers
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — numbers', () => {
  it('classifies integer 0 as number', () => {
    expectCell(0, { kind: 'number', display: '0', isJson: false });
  });

  it('classifies positive integer 42 as number', () => {
    expectCell(42, { kind: 'number', display: '42', isJson: false });
  });

  it('classifies negative integer -7 as number', () => {
    expectCell(-7, { kind: 'number', display: '-7', isJson: false });
  });

  it('classifies float 3.14 as number', () => {
    expectCell(3.14, { kind: 'number', display: '3.14', isJson: false });
  });

  it('classifies numeric string "42" as number', () => {
    expectCell('42', { kind: 'number', display: '42', isJson: false });
  });

  it('classifies numeric string "0" as number', () => {
    expectCell('0', { kind: 'number', display: '0', isJson: false });
  });

  it('classifies negative numeric string "-3.14" as number', () => {
    expectCell('-3.14', { kind: 'number', display: '-3.14', isJson: false });
  });

  it('number className contains amber accent hex', () => {
    expect(classifyCell(42).className).toContain('#f5c451');
  });

  it('numeric string className also contains amber accent', () => {
    expect(classifyCell('42').className).toContain('#f5c451');
  });
});

/*
 * ---------------------------------------------------------------------------
 * classifyCell — booleans
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — booleans', () => {
  it('classifies native false as boolean', () => {
    expectCell(false, { kind: 'boolean', display: 'false', isJson: false });
  });

  it('classifies native true as boolean', () => {
    expectCell(true, { kind: 'boolean', display: 'true', isJson: false });
  });

  it('classifies string "false" as boolean', () => {
    expectCell('false', { kind: 'boolean', display: 'false', isJson: false });
  });

  it('classifies string "true" as boolean', () => {
    expectCell('true', { kind: 'boolean', display: 'true', isJson: false });
  });

  it('boolean className contains cyan accent hex #00E5FF', () => {
    expect(classifyCell(false).className).toContain('#00E5FF');
  });

  it('"false" string className contains cyan accent', () => {
    expect(classifyCell('false').className).toContain('#00E5FF');
  });
});

/*
 * ---------------------------------------------------------------------------
 * classifyCell — JSON (objects and JSON-parseable strings)
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — json', () => {
  it('classifies plain object {a:1} as json with isJson true', () => {
    const cell = classifyCell({ a: 1 });
    expect(cell.kind).toBe('json');
    expect(cell.display).toBe('{"a":1}');
    expect(cell.isJson).toBe(true);
  });

  it('classifies array [1,2,3] as json', () => {
    const cell = classifyCell([1, 2, 3]);
    expect(cell.kind).toBe('json');
    expect(cell.display).toBe('[1,2,3]');
    expect(cell.isJson).toBe(true);
  });

  it('classifies empty object {} as json', () => {
    const cell = classifyCell({});
    expect(cell.kind).toBe('json');
    expect(cell.isJson).toBe(true);
  });

  it('classifies JSON string "[1,2]" as json with isJson true', () => {
    const cell = classifyCell('[1,2]');
    expect(cell.kind).toBe('json');
    expect(cell.display).toBe('[1,2]');
    expect(cell.isJson).toBe(true);
  });

  it('classifies JSON string \'{"x":"y"}\' as json', () => {
    const cell = classifyCell('{"x":"y"}');
    expect(cell.kind).toBe('json');
    expect(cell.display).toBe('{"x":"y"}');
    expect(cell.isJson).toBe(true);
  });

  it('json className contains font-mono', () => {
    expect(classifyCell({ a: 1 }).className).toContain('font-mono');
  });

  it('nested object is serialised compactly', () => {
    const cell = classifyCell({ a: { b: 2 } });
    expect(cell.display).toBe('{"a":{"b":2}}');
  });
});

/*
 * ---------------------------------------------------------------------------
 * classifyCell — text (plain strings)
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — text', () => {
  it('classifies plain string "plain" as text', () => {
    expectCell('plain', { kind: 'text', display: 'plain', isJson: false });
  });

  it('classifies string "hello world" as text', () => {
    expectCell('hello world', { kind: 'text', display: 'hello world', isJson: false });
  });

  it('string that looks like number but has whitespace padding is text', () => {
    /*
     * ' 42 ' trims to '42' → actually numeric — this is by design (SQLite stores trimmed)
     * ' 42a' is NOT numeric → text
     */
    expectCell(' 42a', { kind: 'text', display: ' 42a', isJson: false });
  });

  it('invalid JSON string is classified as text', () => {
    expectCell('{not json}', { kind: 'text', display: '{not json}', isJson: false });
  });

  it('text isJson is false', () => {
    expect(classifyCell('hello').isJson).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * classifyCell — visual distinction: null vs empty vs 0 vs false
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — visual distinction invariants', () => {
  it('null and empty have different display strings', () => {
    expect(classifyCell(null).display).not.toBe(classifyCell('').display);
  });

  it('null and 0 have different kinds', () => {
    expect(classifyCell(null).kind).not.toBe(classifyCell(0).kind);
  });

  it('empty string and false have different kinds', () => {
    expect(classifyCell('').kind).not.toBe(classifyCell(false).kind);
  });

  it('all five distinct values produce 5 distinct kinds/displays', () => {
    const values = [null, '', 0, false, 'text'];
    const displays = values.map((v) => classifyCell(v).display);
    const unique = new Set(displays);
    expect(unique.size).toBe(5);
  });
});

/*
 * ---------------------------------------------------------------------------
 * columnTypeBadge — null / undefined / empty → null
 * ---------------------------------------------------------------------------
 */
describe('columnTypeBadge — no-badge cases', () => {
  it('returns null for null declaredType', () => {
    expect(columnTypeBadge(null)).toBeNull();
  });

  it('returns null for undefined declaredType', () => {
    expect(columnTypeBadge(undefined)).toBeNull();
  });

  it('returns null for empty string declaredType', () => {
    expect(columnTypeBadge('')).toBeNull();
  });

  it('returns null for whitespace-only declaredType', () => {
    expect(columnTypeBadge('   ')).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * columnTypeBadge — INTEGER affinity (contains INT)
 * ---------------------------------------------------------------------------
 */
describe('columnTypeBadge — INT affinity', () => {
  it('maps INTEGER → INT label', () => {
    expect(columnTypeBadge('INTEGER')).toEqual({ label: 'INT', title: 'INTEGER' });
  });

  it('maps INT → INT label', () => {
    expect(columnTypeBadge('INT')).toEqual({ label: 'INT', title: 'INT' });
  });

  it('maps BIGINT → INT label', () => {
    expect(columnTypeBadge('BIGINT')).toEqual({ label: 'INT', title: 'BIGINT' });
  });

  it('maps UNSIGNED BIG INT → INT label', () => {
    expect(columnTypeBadge('UNSIGNED BIG INT')).toEqual({
      label: 'INT',
      title: 'UNSIGNED BIG INT',
    });
  });

  it('maps INT2 → INT label (SQLite canonical example)', () => {
    expect(columnTypeBadge('INT2')).toEqual({ label: 'INT', title: 'INT2' });
  });

  it('maps mixed-case integer → INT label', () => {
    expect(columnTypeBadge('integer')).toEqual({ label: 'INT', title: 'integer' });
    expect(columnTypeBadge('Integer')).toEqual({ label: 'INT', title: 'Integer' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * columnTypeBadge — TEXT affinity (CHAR, CLOB, TEXT)
 * ---------------------------------------------------------------------------
 */
describe('columnTypeBadge — TEXT affinity', () => {
  it('maps TEXT → TEXT label', () => {
    expect(columnTypeBadge('TEXT')).toEqual({ label: 'TEXT', title: 'TEXT' });
  });

  it('maps VARCHAR(255) → TEXT label', () => {
    expect(columnTypeBadge('VARCHAR(255)')).toEqual({
      label: 'TEXT',
      title: 'VARCHAR(255)',
    });
  });

  it('maps CHARACTER(20) → TEXT label', () => {
    expect(columnTypeBadge('CHARACTER(20)')).toEqual({
      label: 'TEXT',
      title: 'CHARACTER(20)',
    });
  });

  it('maps NCHAR(55) → TEXT label', () => {
    expect(columnTypeBadge('NCHAR(55)')).toEqual({ label: 'TEXT', title: 'NCHAR(55)' });
  });

  it('maps CLOB → TEXT label', () => {
    expect(columnTypeBadge('CLOB')).toEqual({ label: 'TEXT', title: 'CLOB' });
  });

  it('maps native CHARACTER → TEXT label', () => {
    expect(columnTypeBadge('NATIVE CHARACTER(70)')).toEqual({
      label: 'TEXT',
      title: 'NATIVE CHARACTER(70)',
    });
  });

  it('maps mixed-case text → TEXT label', () => {
    expect(columnTypeBadge('varchar(100)')).toEqual({
      label: 'TEXT',
      title: 'varchar(100)',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * columnTypeBadge — REAL affinity (REAL, FLOA, DOUB)
 * ---------------------------------------------------------------------------
 */
describe('columnTypeBadge — REAL affinity', () => {
  it('maps REAL → REAL label', () => {
    expect(columnTypeBadge('REAL')).toEqual({ label: 'REAL', title: 'REAL' });
  });

  it('maps DOUBLE → REAL label (contains DOUB)', () => {
    expect(columnTypeBadge('DOUBLE')).toEqual({ label: 'REAL', title: 'DOUBLE' });
  });

  it('maps DOUBLE PRECISION → REAL label', () => {
    expect(columnTypeBadge('DOUBLE PRECISION')).toEqual({
      label: 'REAL',
      title: 'DOUBLE PRECISION',
    });
  });

  it('maps FLOAT → REAL label (contains FLOA)', () => {
    expect(columnTypeBadge('FLOAT')).toEqual({ label: 'REAL', title: 'FLOAT' });
  });

  it('maps mixed-case real → REAL label', () => {
    expect(columnTypeBadge('double')).toEqual({ label: 'REAL', title: 'double' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * columnTypeBadge — BLOB affinity
 * ---------------------------------------------------------------------------
 */
describe('columnTypeBadge — BLOB affinity', () => {
  it('maps BLOB → BLOB label', () => {
    expect(columnTypeBadge('BLOB')).toEqual({ label: 'BLOB', title: 'BLOB' });
  });

  it('maps mixed-case blob → BLOB label', () => {
    expect(columnTypeBadge('blob')).toEqual({ label: 'BLOB', title: 'blob' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * columnTypeBadge — NUMERIC affinity (everything else)
 * ---------------------------------------------------------------------------
 */
describe('columnTypeBadge — NUMERIC affinity (everything else)', () => {
  it('maps NUMERIC → NUM label', () => {
    expect(columnTypeBadge('NUMERIC')).toEqual({ label: 'NUM', title: 'NUMERIC' });
  });

  it('maps DECIMAL(10,5) → NUM label', () => {
    expect(columnTypeBadge('DECIMAL(10,5)')).toEqual({
      label: 'NUM',
      title: 'DECIMAL(10,5)',
    });
  });

  it('maps BOOLEAN → NUM label (SQLite numeric affinity)', () => {
    expect(columnTypeBadge('BOOLEAN')).toEqual({ label: 'NUM', title: 'BOOLEAN' });
  });

  it('maps DATE → NUM label (SQLite numeric affinity)', () => {
    expect(columnTypeBadge('DATE')).toEqual({ label: 'NUM', title: 'DATE' });
  });

  it('maps DATETIME → NUM label', () => {
    expect(columnTypeBadge('DATETIME')).toEqual({ label: 'NUM', title: 'DATETIME' });
  });

  it('maps unknown type "MONEY" → NUM label', () => {
    expect(columnTypeBadge('MONEY')).toEqual({ label: 'NUM', title: 'MONEY' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * url / email presentation (clickable-link affordance over a text value)
 * ---------------------------------------------------------------------------
 */
describe('classifyCell — url + email link affordances', () => {
  it('classifies a whole-string https URL as url with href = the URL', () => {
    const c = classifyCell('https://example.com/path?q=1');
    expect(c.kind).toBe('url');
    expect(c.href).toBe('https://example.com/path?q=1');
    expect(c.display).toBe('https://example.com/path?q=1'); // display stays the raw value (honest)
    expect(c.isJson).toBe(false);
  });

  it('classifies a plain http URL as url', () => {
    expect(classifyCell('http://a.co').kind).toBe('url');
  });

  it('classifies a whole-string email as email with a mailto href', () => {
    const c = classifyCell('me@example.com');
    expect(c.kind).toBe('email');
    expect(c.href).toBe('mailto:me@example.com');
    expect(c.display).toBe('me@example.com');
  });

  it('reads a userinfo URL (http://user@host.tld/x) as a URL, NOT an email', () => {
    const c = classifyCell('http://user@host.tld/x');
    expect(c.kind).toBe('url');
    expect(c.href).toBe('http://user@host.tld/x');
  });

  // --- XSS guard: only http(s)/mailto ever become an href ---
  it('does NOT linkify a javascript: scheme (XSS guard → plain text, no href)', () => {
    const c = classifyCell('javascript:alert(1)');
    expect(c.kind).toBe('text');
    expect(c.href).toBeUndefined();
  });

  it('does NOT linkify a data: URL (→ plain text, no href)', () => {
    const c = classifyCell('data:text/html,<script>alert(1)</script>');
    expect(c.kind).toBe('text');
    expect(c.href).toBeUndefined();
  });

  it('does NOT linkify non-web schemes (ftp:, file:) → plain text', () => {
    expect(classifyCell('ftp://a.co/f').kind).toBe('text');
    expect(classifyCell('file:///etc/passwd').kind).toBe('text');
  });

  // --- false-positive guards: only WHOLE-string matches ---
  it('does NOT classify prose that merely contains a URL', () => {
    expect(classifyCell('see https://a.com for more').kind).toBe('text');
  });

  it('does NOT classify prose that merely contains an @', () => {
    expect(classifyCell('ping me @handle sometime').kind).toBe('text');
    expect(classifyCell('a@b').kind).toBe('text'); // no dot after @ → not an email
  });

  // --- regression: url/email must not disturb existing classifications ---
  it('leaves numbers, JSON, booleans, null unaffected (no stray href)', () => {
    expect(classifyCell('42').kind).toBe('number');
    expect(classifyCell('42').href).toBeUndefined();
    expect(classifyCell('{"a":1}').kind).toBe('json');
    expect(classifyCell('true').kind).toBe('boolean');
    expect(classifyCell(null).href).toBeUndefined();
    expect(classifyCell('hello').href).toBeUndefined();
  });
});

describe('classifyCell — ISO date/datetime presentation (honest reformatting)', () => {
  it('reformats an ISO calendar date and KEEPS the raw as `title` (the tooltip)', () => {
    const c = classifyCell('2024-01-01');
    expect(c.kind).toBe('date');
    expect(c.title).toBe('2024-01-01'); // the raw is always one hover away
    expect(c.display).not.toBe('2024-01-01'); // display is reformatted (locale-readable)
    expect(c.display.length).toBeGreaterThan(0);
    expect(c.display).toContain('2024'); // the year survives every locale
  });

  it('reformats a zone-marked ISO datetime (Z and ±offset are unambiguous instants)', () => {
    for (const raw of ['2024-01-01T12:34:56Z', '2024-06-01T08:00:00+02:00']) {
      const c = classifyCell(raw);
      expect(c.kind).toBe('date');
      expect(c.title).toBe(raw);
      expect(c.display).not.toBe(raw);
    }
  });

  it('does NOT reformat a ZONE-LESS datetime — we never guess UTC-vs-local (stays text, no title)', () => {
    expect(classifyCell('2024-01-01T12:34:56').kind).toBe('text'); // no Z / offset
    expect(classifyCell('2024-01-01 12:34:56').kind).toBe('text'); // space form
    expect(classifyCell('2024-01-01T12:34:56').title).toBeUndefined();
  });

  it('a date-SHAPED but invalid value (2024-13-45) stays text (Date validates, not just the regex)', () => {
    expect(classifyCell('2024-13-45').kind).toBe('text');
  });

  it('prose that merely CONTAINS a date stays text (anchored)', () => {
    expect(classifyCell('meeting on 2024-01-01').kind).toBe('text');
  });

  it('non-date values are unaffected (year-only number, plain text, url)', () => {
    expect(classifyCell('2024').kind).toBe('number'); // not a full YYYY-MM-DD
    expect(classifyCell('hello').kind).toBe('text');
    expect(classifyCell('https://a.com').kind).toBe('url');
    expect(classifyCell('2024-01-01').title).toBe('2024-01-01');
    expect(classifyCell('hello').title).toBeUndefined();
  });
});

describe('isoDayKey — strict UTC day-key for calendar date-column detection', () => {
  it('returns a bare ISO date unchanged (UTC-neutral calendar day)', () => {
    expect(isoDayKey('2024-01-01')).toBe('2024-01-01');
    expect(isoDayKey('2026-12-31')).toBe('2026-12-31');
  });

  it('converts a Z-marked datetime to its UTC day', () => {
    expect(isoDayKey('2024-01-01T23:30:00Z')).toBe('2024-01-01');
    expect(isoDayKey('2024-01-01T00:00:00.500Z')).toBe('2024-01-01');
  });

  it('converts an ±offset datetime to the correct UTC day (can cross midnight)', () => {
    // 23:30 at -05:00 = 04:30Z the NEXT day
    expect(isoDayKey('2024-01-01T23:30:00-05:00')).toBe('2024-01-02');

    // 00:30 at +05:00 = 19:30Z the PREVIOUS day
    expect(isoDayKey('2024-01-02T00:30:00+05:00')).toBe('2024-01-01');
  });

  it('returns null for a zone-LESS datetime (ambiguous — never guessed)', () => {
    expect(isoDayKey('2024-01-01T12:00:00')).toBeNull();
    expect(isoDayKey('2024-01-01 12:00:00')).toBeNull();
  });

  it('returns null for a number — a numeric id like 20240101 is NOT a date', () => {
    expect(isoDayKey(20240101)).toBeNull();
    expect(isoDayKey(0)).toBeNull();
    expect(isoDayKey(1_717_000_000_000)).toBeNull();
  });

  it('returns null for non-ISO strings, null, undefined, objects', () => {
    expect(isoDayKey('hello')).toBeNull();
    expect(isoDayKey('2024')).toBeNull();
    expect(isoDayKey('2024-13-45')).toBeNull(); // date-shaped but an impossible date → rejected
    expect(isoDayKey(null)).toBeNull();
    expect(isoDayKey(undefined)).toBeNull();
    expect(isoDayKey({ d: '2024-01-01' })).toBeNull();
  });
});

describe('blobCellInfo + humanBytes (BLOB envelope detection + byte humanizing)', () => {
  it('detects the worker BLOB envelope, rejects everything else', () => {
    expect(blobCellInfo({ __blob: true, bytes: 4, hex: '89 50 4e 47' })).toEqual({
      bytes: 4,
      hex: '89 50 4e 47',
    });
    expect(blobCellInfo({ __blob: true })).toEqual({ bytes: 0, hex: '' }); // shape-hardened defaults
    expect(blobCellInfo({ a: 1 })).toBeNull();
    expect(blobCellInfo('not a blob')).toBeNull();
    expect(blobCellInfo(null)).toBeNull();
    expect(blobCellInfo(42)).toBeNull();
  });

  it('humanizes byte counts (B / KB / MB) and guards junk', () => {
    expect(humanBytes(900)).toBe('900 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(humanBytes(-5)).toBe('0 B');
    expect(humanBytes(NaN)).toBe('0 B');
  });
});

describe('classifyCell — BLOB envelope → read-only chip (never garbled JSON)', () => {
  it('classifies a small BLOB as kind "blob" with a byte label + full hex tooltip (no ellipsis)', () => {
    const cell = classifyCell({ __blob: true, bytes: 4, hex: '89 50 4e 47' });
    expect(cell.kind).toBe('blob');
    expect(cell.display).toBe('BLOB · 4 B');
    expect(cell.isJson).toBe(false);
    expect(cell.title).toBe('89 50 4e 47'); // bytes ≤ 16 → the whole blob is previewed, no ellipsis
  });

  it('humanizes a larger blob + appends an ellipsis when there are more bytes than the preview', () => {
    const cell = classifyCell({ __blob: true, bytes: 1234, hex: '89 50 4e 47' });
    expect(cell.display).toBe('BLOB · 1.2 KB');
    expect(cell.title).toBe('89 50 4e 47 …'); // 1234 bytes > 16 previewed → ellipsis
  });

  it('a real (non-blob) object still classifies as json', () => {
    expect(classifyCell({ a: 1 }).kind).toBe('json');
  });
});
