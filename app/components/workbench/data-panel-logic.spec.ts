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
  isRowActivationKey,
  isDismissKey,
  addToSqlHistory,
  parseCsv,
  csvToInserts,
  CsvImportError,
  pkFromTableInfo,
  stripSqlCommentsAndStrings,
  classifySqlStatement,
  classifySql,
  explainQuery,
  explainPlanHint,
  isExpensiveScan,
  EXPENSIVE_SCAN_ROWS,
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

describe('isRowActivationKey', () => {
  it('activates on Enter and both Space spellings (keyboard parity for the click-toggle row — WCAG 2.1.1)', () => {
    expect(isRowActivationKey('Enter')).toBe(true);
    expect(isRowActivationKey(' ')).toBe(true);
    expect(isRowActivationKey('Spacebar')).toBe(true);
  });
  it('ignores navigation / other keys (Tab must move focus, not toggle)', () => {
    expect(isRowActivationKey('Tab')).toBe(false);
    expect(isRowActivationKey('ArrowDown')).toBe(false);
    expect(isRowActivationKey('Escape')).toBe(false);
    expect(isRowActivationKey('a')).toBe(false);
    expect(isRowActivationKey('')).toBe(false);
  });
});

describe('isDismissKey', () => {
  it('dismisses on Escape and the legacy Esc alias (collapse the open detail — disclosure convention)', () => {
    expect(isDismissKey('Escape')).toBe(true);
    expect(isDismissKey('Esc')).toBe(true);
  });
  it('is disjoint from the activation keys — Enter/Space open, never dismiss', () => {
    expect(isDismissKey('Enter')).toBe(false);
    expect(isDismissKey(' ')).toBe(false);
    expect(isDismissKey('Spacebar')).toBe(false);
    expect(isDismissKey('Tab')).toBe(false);
    expect(isDismissKey('')).toBe(false);
  });
});

describe('addToSqlHistory', () => {
  it('prepends a new query, most-recent-first', () => {
    expect(addToSqlHistory(['b'], 'a')).toEqual(['a', 'b']);
  });
  it('de-dupes: a re-run jumps to the top instead of piling up', () => {
    expect(addToSqlHistory(['a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(addToSqlHistory(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });
  it('trims the query + ignores blanks', () => {
    expect(addToSqlHistory(['a'], '  b  ')).toEqual(['b', 'a']);
    expect(addToSqlHistory(['a'], '   ')).toEqual(['a']);
    expect(addToSqlHistory(['a'], '')).toEqual(['a']);
  });
  it('caps at max, most-recent-first', () => {
    expect(addToSqlHistory(['b', 'c'], 'a', 2)).toEqual(['a', 'b']);
  });
  it('never mutates the input list', () => {
    const src = ['a', 'b'];
    addToSqlHistory(src, 'c');
    expect(src).toEqual(['a', 'b']);
  });
});

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles quoted fields with embedded commas + newlines', () => {
    expect(parseCsv('a,b\n"x,y","z\nw"')).toEqual([
      ['a', 'b'],
      ['x,y', 'z\nw'],
    ]);
  });
  it('unescapes doubled quotes', () => {
    expect(parseCsv('name\n"say ""hi"""')).toEqual([['name'], ['say "hi"']]);
  });
  it('ignores a trailing newline (no spurious empty row)', () => {
    expect(parseCsv('a\n1\n')).toEqual([['a'], ['1']]);
  });
  it('keeps a trailing empty field', () => {
    expect(parseCsv('a,b\n1,')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });
});

describe('csvToInserts', () => {
  it('builds a parameter-safe INSERT per data row', () => {
    const r = csvToInserts('a,b\n1,2', 't');
    expect(r.columns).toEqual(['a', 'b']);
    expect(r.rowCount).toBe(1);
    expect(r.inserts).toEqual(['INSERT INTO "t" ("a", "b") VALUES (\'1\', \'2\');']);
  });
  it('maps empty cells to NULL, not empty string', () => {
    expect(csvToInserts('a,b\n1,', 't').inserts[0]).toBe('INSERT INTO "t" ("a", "b") VALUES (\'1\', NULL);');
  });
  it('escapes single quotes in values', () => {
    expect(csvToInserts("name\nO'Brien", 't').inserts[0]).toBe('INSERT INTO "t" ("name") VALUES (\'O\'\'Brien\');');
  });
  it('rejects an invalid table name', () => {
    expect(() => csvToInserts('a\n1', 'bad name')).toThrow(CsvImportError);
    expect(() => csvToInserts('a\n1', '1t')).toThrow(CsvImportError);
  });
  it('rejects an invalid header identifier', () => {
    expect(() => csvToInserts('bad col\n1', 't')).toThrow(CsvImportError);
  });
  it('rejects fewer than two rows', () => {
    expect(() => csvToInserts('a,b', 't')).toThrow(CsvImportError);
    expect(() => csvToInserts('', 't')).toThrow(CsvImportError);
  });
  it('rejects a row whose column count mismatches the header', () => {
    expect(() => csvToInserts('a,b\n1', 't')).toThrow(CsvImportError);
  });
});

describe('pkFromTableInfo', () => {
  it('returns the single PK column', () => {
    expect(
      pkFromTableInfo([
        { name: 'id', pk: 1 },
        { name: 'x', pk: 0 },
      ]),
    ).toEqual(['id']);
  });
  it('orders a composite key by pk index', () => {
    expect(
      pkFromTableInfo([
        { name: 'a', pk: 2 },
        { name: 'b', pk: 1 },
      ]),
    ).toEqual(['b', 'a']);
  });
  it('accepts the aliased "column" key from the Structure starters', () => {
    expect(pkFromTableInfo([{ column: 'id', pk: 1 }])).toEqual(['id']);
  });
  it('returns [] when no PK is declared (caller refuses inline mutation)', () => {
    expect(pkFromTableInfo([{ name: 'x', pk: 0 }])).toEqual([]);
    expect(pkFromTableInfo([])).toEqual([]);
  });
});

describe('stripSqlCommentsAndStrings', () => {
  it('blanks line comments but keeps the newline + following statement', () => {
    const out = stripSqlCommentsAndStrings('SELECT 1 -- drop table x\nSELECT 2');
    expect(out).toContain('SELECT 1');
    expect(out).toContain('SELECT 2');
    expect(out.toUpperCase()).not.toContain('DROP TABLE');
  });
  it('blanks block comments', () => {
    const out = stripSqlCommentsAndStrings('SELECT /* DELETE FROM t */ 1');
    expect(out.toUpperCase()).not.toContain('DELETE FROM');
    expect(out).toContain('SELECT');
  });
  it('blanks single-quoted literals including doubled-quote escapes', () => {
    const out = stripSqlCommentsAndStrings("SELECT 'DROP TABLE ''x'''");
    expect(out.toUpperCase()).not.toContain('DROP TABLE');
    expect(out).toContain('SELECT');
  });
  it('blanks double-quoted + backtick identifiers so a table named like a keyword is safe', () => {
    expect(
      stripSqlCommentsAndStrings('DROP TABLE "drop table"')
        .toUpperCase()
        .match(/DROP\s+TABLE/g),
    ).toHaveLength(1);
    expect(stripSqlCommentsAndStrings('SELECT * FROM `delete from`').toUpperCase()).not.toContain('DELETE FROM');
  });
  it('handles an unterminated string/comment without throwing', () => {
    expect(typeof stripSqlCommentsAndStrings("SELECT 'oops")).toBe('string');
    expect(typeof stripSqlCommentsAndStrings('SELECT /* oops')).toBe('string');
  });
});

describe('classifySqlStatement: kind', () => {
  it('reads: SELECT / PRAGMA / EXPLAIN / VALUES (case-insensitive verb)', () => {
    expect(classifySqlStatement('select * from users').kind).toBe('read');
    expect(classifySqlStatement('PRAGMA table_info(users)').kind).toBe('read');
    expect(classifySqlStatement('EXPLAIN QUERY PLAN SELECT 1').kind).toBe('read');
    expect(classifySqlStatement('SELECT * FROM users').verb).toBe('SELECT');
  });
  it('writes: INSERT / UPDATE / DELETE / REPLACE', () => {
    expect(classifySqlStatement('INSERT INTO t (a) VALUES (1)').kind).toBe('write');
    expect(classifySqlStatement('REPLACE INTO t (a) VALUES (1)').kind).toBe('write');
  });
  it('ddl: CREATE / ALTER / DROP', () => {
    expect(classifySqlStatement('CREATE TABLE t (id INTEGER)').kind).toBe('ddl');
    expect(classifySqlStatement('ALTER TABLE t ADD COLUMN x TEXT').kind).toBe('ddl');
  });
  it('transaction + other + empty', () => {
    expect(classifySqlStatement('BEGIN').kind).toBe('transaction');
    expect(classifySqlStatement('COMMIT').kind).toBe('transaction');
    expect(classifySqlStatement('')).toEqual({ verb: '', kind: 'other', destructive: false, reason: '' });
    expect(classifySqlStatement('   ').kind).toBe('other');
    expect(classifySqlStatement('-- just a note').kind).toBe('other');
  });
});

describe('classifySqlStatement: destructive gate', () => {
  it('flags DROP TABLE / INDEX / VIEW', () => {
    expect(classifySqlStatement('DROP TABLE users').destructive).toBe(true);
    expect(classifySqlStatement('DROP INDEX idx_x').destructive).toBe(true);
    expect(classifySqlStatement('DROP VIEW v').destructive).toBe(true);
  });
  it('flags TRUNCATE and ALTER … DROP COLUMN', () => {
    expect(classifySqlStatement('TRUNCATE TABLE t').destructive).toBe(true);
    expect(classifySqlStatement('ALTER TABLE t DROP COLUMN x').destructive).toBe(true);
  });
  it('flags DELETE / UPDATE with NO where clause (whole-table wipe/rewrite)', () => {
    expect(classifySqlStatement('DELETE FROM t').destructive).toBe(true);
    expect(classifySqlStatement('UPDATE t SET a = 1').destructive).toBe(true);
  });
  it('does NOT flag a scoped DELETE / UPDATE, a CREATE, or a SELECT', () => {
    expect(classifySqlStatement('DELETE FROM t WHERE id = 1').destructive).toBe(false);
    expect(classifySqlStatement('UPDATE t SET a = 1 WHERE id = 2').destructive).toBe(false);
    expect(classifySqlStatement('CREATE TABLE t (id INTEGER)').destructive).toBe(false);
    expect(classifySqlStatement('SELECT * FROM t').destructive).toBe(false);
  });
  it('every destructive statement carries a plain-language reason', () => {
    const d = classifySqlStatement('DELETE FROM t');
    expect(d.reason).toMatch(/WHERE/i);
    expect(d.reason.length).toBeGreaterThan(0);
  });
  it('is NOT fooled by keywords inside string literals or comments (strip-first)', () => {
    expect(classifySqlStatement("SELECT 'DROP TABLE x' AS note").destructive).toBe(false);
    expect(classifySqlStatement('SELECT * FROM t -- DELETE FROM t').destructive).toBe(false);
  });
  it('classifies a CTE by its primary keyword — WITH … DELETE (no WHERE) is a destructive write', () => {
    const read = classifySqlStatement('WITH c AS (SELECT 1) SELECT * FROM c');
    expect(read.kind).toBe('read');
    expect(read.destructive).toBe(false);

    const del = classifySqlStatement('WITH c AS (SELECT id FROM t) DELETE FROM t');
    expect(del.kind).toBe('write');
    expect(del.destructive).toBe(true);
  });
});

describe('classifySql: batch aggregation', () => {
  it('is destructive when ANY statement is; kind is the highest-privilege present', () => {
    const b = classifySql('SELECT 1; DROP TABLE t');
    expect(b.destructive).toBe(true);
    expect(b.kind).toBe('ddl');
    expect(b.statementCount).toBe(2);
    expect(b.reasons).toHaveLength(1);
  });
  it('a pure read batch is not destructive', () => {
    const b = classifySql('SELECT 1; SELECT 2');
    expect(b.destructive).toBe(false);
    expect(b.kind).toBe('read');
    expect(b.statementCount).toBe(2);
  });
  it('does not split on a semicolon inside a string literal', () => {
    expect(classifySql("INSERT INTO t (a) VALUES ('a;b')").statementCount).toBe(1);
  });
  it('dedupes identical destructive reasons across statements', () => {
    const b = classifySql('DROP TABLE a; DROP TABLE b');
    expect(b.statementCount).toBe(2);
    expect(b.destructive).toBe(true);
    expect(b.reasons).toHaveLength(1);
  });
  it('empty / semicolon-only input yields a zeroed, non-destructive result', () => {
    expect(classifySql('')).toEqual({
      statements: [],
      destructive: false,
      kind: 'other',
      reasons: [],
      statementCount: 0,
    });
    expect(classifySql(';;;').statementCount).toBe(0);
  });
});

describe('explainQuery', () => {
  it('wraps the first statement in EXPLAIN QUERY PLAN', () => {
    expect(explainQuery('SELECT * FROM t')).toBe('EXPLAIN QUERY PLAN SELECT * FROM t');
  });
  it('strips a trailing semicolon and only wraps the FIRST statement (EXPLAIN is single-statement)', () => {
    expect(explainQuery('SELECT 1;')).toBe('EXPLAIN QUERY PLAN SELECT 1');
    expect(explainQuery('SELECT 1; SELECT 2')).toBe('EXPLAIN QUERY PLAN SELECT 1');
  });
  it('is idempotent — never double-wraps an already-EXPLAIN query (case-insensitive)', () => {
    expect(explainQuery('EXPLAIN QUERY PLAN SELECT 1')).toBe('EXPLAIN QUERY PLAN SELECT 1');
    expect(explainQuery('explain select 1')).toBe('explain select 1');
  });
  it('returns empty string for a blank/whitespace/semicolon-only buffer', () => {
    expect(explainQuery('')).toBe('');
    expect(explainQuery('   ;;  ')).toBe('');
  });
});

describe('explainPlanHint', () => {
  it('warns on a bare full-table SCAN and counts the scanned tables', () => {
    const h = explainPlanHint([{ detail: 'SCAN users' }, { detail: 'SCAN orders' }]);
    expect(h?.level).toBe('warn');
    expect(h?.message).toContain('2 tables');
  });
  it('reports GOOD when every step uses an index (no bare scan)', () => {
    const h = explainPlanHint([{ detail: 'SEARCH users USING INDEX ix_email (email=?)' }]);
    expect(h?.level).toBe('good');
  });
  it('does not treat "USING COVERING INDEX" as a scan', () => {
    expect(explainPlanHint([{ detail: 'SCAN t USING COVERING INDEX ix' }])?.level).toBe('good');
  });
  it('flags a temp B-tree sort as info when there is no scan', () => {
    const h = explainPlanHint([
      { detail: 'SEARCH t USING INDEX ix' },
      { detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ]);
    expect(h?.level).toBe('info');
  });
  it('returns null when the rows are NOT a query plan (no detail column) — shows only after Explain', () => {
    expect(explainPlanHint([{ id: 1, name: 'x' }])).toBeNull();
    expect(explainPlanHint([])).toBeNull();
  });
});

describe('isExpensiveScan', () => {
  it('flags a query that read MORE than the threshold', () => {
    expect(isExpensiveScan(EXPENSIVE_SCAN_ROWS + 1)).toBe(true);
    expect(isExpensiveScan(1_000_000)).toBe(true);
  });
  it('does not flag at-or-below the threshold', () => {
    expect(isExpensiveScan(EXPENSIVE_SCAN_ROWS)).toBe(false);
    expect(isExpensiveScan(500)).toBe(false);
    expect(isExpensiveScan(0)).toBe(false);
  });
  it('never flags an UNREPORTED value (null/undefined) — no fabricated warning', () => {
    expect(isExpensiveScan(null)).toBe(false);
    expect(isExpensiveScan(undefined)).toBe(false);
  });
});
