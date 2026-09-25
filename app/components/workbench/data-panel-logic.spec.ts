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
  addSavedQuery,
  removeSavedQuery,
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
  sqlConsoleTarget,
  MAX_QUERY_TABS,
  nextQueryTabTitle,
  addQueryTab,
  closeQueryTab,
  updateQueryTabSql,
  nextSort,
  sortRows,
  clipboardValue,
  rowJson,
  visibleColumns,
  toggleHiddenColumn,
  coerceCellInput,
  buildInsertStatement,
  buildDeleteByPk,
  RowMutationError,
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
    const h = explainPlanHint([{ detail: 'SEARCH t USING INDEX ix' }, { detail: 'USE TEMP B-TREE FOR ORDER BY' }]);
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

describe('addSavedQuery / removeSavedQuery', () => {
  it('saves a named query at the top of the list', () => {
    expect(addSavedQuery([], 'actives', 'SELECT 1')).toEqual([{ name: 'actives', query: 'SELECT 1' }]);
  });
  it('overwrites by name (dedup) and moves the entry to the top', () => {
    const start = [
      { name: 'a', query: 'X' },
      { name: 'b', query: 'Y' },
    ];
    expect(addSavedQuery(start, 'b', 'Z')).toEqual([
      { name: 'b', query: 'Z' }, // updated query, jumped to top
      { name: 'a', query: 'X' },
    ]);
  });
  it('trims the name + query and no-ops on a blank name or blank query', () => {
    expect(addSavedQuery([], '  spaced  ', '  SELECT 2  ')).toEqual([{ name: 'spaced', query: 'SELECT 2' }]);
    expect(addSavedQuery([{ name: 'a', query: 'X' }], '   ', 'Y')).toEqual([{ name: 'a', query: 'X' }]);
    expect(addSavedQuery([{ name: 'a', query: 'X' }], 'b', '   ')).toEqual([{ name: 'a', query: 'X' }]);
  });
  it('caps the retained entries (newest kept)', () => {
    let list = addSavedQuery([], 'q0', 'v0', 2);
    list = addSavedQuery(list, 'q1', 'v1', 2);
    list = addSavedQuery(list, 'q2', 'v2', 2);
    expect(list.map((s) => s.name)).toEqual(['q2', 'q1']); // q0 dropped past the cap of 2
  });
  it('removes a saved query by exact name; a missing name is a no-op', () => {
    const start = [
      { name: 'a', query: 'X' },
      { name: 'b', query: 'Y' },
    ];
    expect(removeSavedQuery(start, 'a')).toEqual([{ name: 'b', query: 'Y' }]);
    expect(removeSavedQuery(start, 'zzz')).toEqual(start);
  });
});

describe('sqlConsoleTarget', () => {
  it('names the production environment + the SHARED multi-tenant D1 (honest write target)', () => {
    const t = sqlConsoleTarget();
    expect(t.environment).toBe('Production');
    expect(t.database.toLowerCase()).toContain('shared');
    expect(t.scope.toLowerCase()).toContain('affects all tenants');
  });
  it('spells out the guardrails that still apply (protected tables + destructive confirm)', () => {
    const scope = sqlConsoleTarget().scope.toLowerCase();
    expect(scope).toContain('protected');
    expect(scope).toContain('confirm');
  });
  it('returns a fresh object each call (no shared singleton to mutate)', () => {
    expect(sqlConsoleTarget()).not.toBe(sqlConsoleTarget());
    expect(sqlConsoleTarget()).toEqual(sqlConsoleTarget());
  });
});

describe('query tabs (multi-buffer SQL console)', () => {
  const tab = (id: string, title: string, sql = '') => ({ id, title, sql });

  it('nextQueryTabTitle picks the smallest unused "Query N"', () => {
    expect(nextQueryTabTitle([])).toBe('Query 1');
    expect(nextQueryTabTitle([tab('a', 'Query 1')])).toBe('Query 2');

    // gap reuse: 1 and 3 used → 2 is next
    expect(nextQueryTabTitle([tab('a', 'Query 1'), tab('c', 'Query 3')])).toBe('Query 2');

    // custom titles are ignored by the numbering
    expect(nextQueryTabTitle([tab('a', 'My report')])).toBe('Query 1');
  });

  it('addQueryTab appends with the next title and makes it active', () => {
    const r = addQueryTab([tab('a', 'Query 1', 'SELECT 1')], 'b', 'SELECT 2');
    expect(r.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(r.tabs[1]).toEqual({ id: 'b', title: 'Query 2', sql: 'SELECT 2' });
    expect(r.activeId).toBe('b');
  });

  it('addQueryTab refuses past MAX_QUERY_TABS (list unchanged, last stays active)', () => {
    const full = Array.from({ length: MAX_QUERY_TABS }, (_, i) => tab(`t${i}`, `Query ${i + 1}`));
    const r = addQueryTab(full, 'overflow');
    expect(r.tabs).toHaveLength(MAX_QUERY_TABS); // unchanged
    expect(r.tabs.some((t) => t.id === 'overflow')).toBe(false);
    expect(r.activeId).toBe(`t${MAX_QUERY_TABS - 1}`);
  });

  it('closeQueryTab activates the neighbor (same index, clamped)', () => {
    const tabs = [tab('a', 'Query 1'), tab('b', 'Query 2'), tab('c', 'Query 3')];
    const mid = closeQueryTab(tabs, 'b', 'fresh');
    expect(mid.tabs.map((t) => t.id)).toEqual(['a', 'c']);
    expect(mid.activeId).toBe('c'); // index 1 → clamped stays at the new index-1 (c)

    const last = closeQueryTab(tabs, 'c', 'fresh');
    expect(last.activeId).toBe('b'); // closing the last → previous neighbor
  });

  it('closeQueryTab never returns an empty list — the last close yields one fresh tab', () => {
    const r = closeQueryTab([tab('only', 'Query 1', 'SELECT 1')], 'only', 'fresh');
    expect(r.tabs).toEqual([{ id: 'fresh', title: 'Query 1', sql: '' }]);
    expect(r.activeId).toBe('fresh');
  });

  it('updateQueryTabSql immutably sets only the target tab (absent id = no-op copy)', () => {
    const tabs = [tab('a', 'Query 1', 'X'), tab('b', 'Query 2', 'Y')];
    const out = updateQueryTabSql(tabs, 'b', 'Y2');
    expect(out).not.toBe(tabs);
    expect(out.map((t) => t.sql)).toEqual(['X', 'Y2']);
    expect(updateQueryTabSql(tabs, 'zzz', 'Z').map((t) => t.sql)).toEqual(['X', 'Y']);
  });
});

describe('nextSort (3-state column-header toggle)', () => {
  it('cycles unsorted → asc → desc → unsorted for the same column', () => {
    expect(nextSort(null, 'name')).toEqual({ col: 'name', dir: 'asc' });
    expect(nextSort({ col: 'name', dir: 'asc' }, 'name')).toEqual({ col: 'name', dir: 'desc' });
    expect(nextSort({ col: 'name', dir: 'desc' }, 'name')).toBeNull();
  });
  it('starts a different column fresh at asc', () => {
    expect(nextSort({ col: 'name', dir: 'desc' }, 'age')).toEqual({ col: 'age', dir: 'asc' });
  });
});

describe('sortRows (type-aware, stable, empties-last)', () => {
  it('null sort → a copy in original order (never mutates)', () => {
    const rows = [{ n: 2 }, { n: 1 }];
    const out = sortRows(rows, null);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
  it('sorts NUMERICALLY when both cells are numeric strings (10 after 2, not before)', () => {
    const rows = [{ n: '10' }, { n: '2' }, { n: '1' }];
    expect(sortRows(rows, { col: 'n', dir: 'asc' }).map((r) => r.n)).toEqual(['1', '2', '10']);
    expect(sortRows(rows, { col: 'n', dir: 'desc' }).map((r) => r.n)).toEqual(['10', '2', '1']);
  });
  it('sorts strings case-insensitively', () => {
    const rows = [{ s: 'Banana' }, { s: 'apple' }, { s: 'Cherry' }];
    expect(sortRows(rows, { col: 's', dir: 'asc' }).map((r) => r.s)).toEqual(['apple', 'Banana', 'Cherry']);
  });
  it('always sorts null / undefined / empty LAST, regardless of direction', () => {
    const rows = [{ v: 'x' }, { v: null }, { v: 'a' }, { v: '' }];
    expect(sortRows(rows, { col: 'v', dir: 'asc' }).map((r) => r.v)).toEqual(['a', 'x', null, '']);

    // desc reverses the real values but keeps empties last
    expect(sortRows(rows, { col: 'v', dir: 'desc' }).map((r) => r.v)).toEqual(['x', 'a', null, '']);
  });
  it('is stable — equal keys keep their original relative order', () => {
    const rows = [
      { k: 1, id: 'a' },
      { k: 1, id: 'b' },
      { k: 1, id: 'c' },
    ];
    expect(sortRows(rows, { col: 'k', dir: 'asc' }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('compares objects by their compact JSON (never throws / "[object Object]")', () => {
    const rows = [{ o: { z: 1 } }, { o: { a: 1 } }];

    // formatCellValue → '{"z":1}' vs '{"a":1}' → 'a' before 'z'
    expect(sortRows(rows, { col: 'o', dir: 'asc' }).map((r) => JSON.stringify(r.o))).toEqual(['{"a":1}', '{"z":1}']);
  });
});

describe('clipboardValue (raw cell copy text, never the display em-dash)', () => {
  it('copies scalars as their plain string', () => {
    expect(clipboardValue('a@x.com')).toBe('a@x.com');
    expect(clipboardValue(42)).toBe('42');
    expect(clipboardValue(false)).toBe('false');
    expect(clipboardValue(0)).toBe('0');
  });
  it('copies objects as compact JSON', () => {
    expect(clipboardValue({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
  it('copies null / undefined / empty as an EMPTY string (never "—")', () => {
    expect(clipboardValue(null)).toBe('');
    expect(clipboardValue(undefined)).toBe('');
    expect(clipboardValue('')).toBe('');
  });
  it('never throws on a cyclic object', () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(typeof clipboardValue(c)).toBe('string');
  });
});

describe('rowJson (whole-row pretty JSON for "Copy row")', () => {
  it('pretty-prints the row with 2-space indent', () => {
    expect(rowJson({ email: 'a@x.com', n: 2 })).toBe('{\n  "email": "a@x.com",\n  "n": 2\n}');
  });
  it('never throws on a cyclic row (falls back to a shallow string map)', () => {
    const r: Record<string, unknown> = { a: 1 };
    r.self = r;
    expect(typeof rowJson(r)).toBe('string');
    expect(rowJson(r)).toContain('"a"');
  });
});

describe('visibleColumns (grid column selection — view-only)', () => {
  it('returns all columns minus the hidden set, ORDER preserved', () => {
    expect(visibleColumns(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    expect(visibleColumns(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });
  it('ignores a stale hidden entry no longer in the table', () => {
    expect(visibleColumns(['a', 'b'], ['zzz'])).toEqual(['a', 'b']);
  });
});

describe('toggleHiddenColumn (3-state safe toggle, last-column guard)', () => {
  it('hides a column (immutable, ordered by `all`)', () => {
    const out = toggleHiddenColumn([], 'b', ['a', 'b', 'c']);
    expect(out).toEqual(['b']);
  });
  it('shows a previously hidden column', () => {
    expect(toggleHiddenColumn(['b'], 'b', ['a', 'b', 'c'])).toEqual([]);
  });
  it('REFUSES to hide the last visible column (never a dead-end empty grid)', () => {
    // a,b table with a already hidden → hiding b would leave 0 visible → refused (unchanged)
    expect(toggleHiddenColumn(['a'], 'b', ['a', 'b'])).toEqual(['a']);
  });
  it('always allows SHOWING even at the guard boundary', () => {
    // one visible (b), a hidden → showing a is fine
    expect(toggleHiddenColumn(['a'], 'a', ['a', 'b'])).toEqual([]);
  });
  it('keeps the hidden set ordered by `all` for stable persistence', () => {
    // hide c then a → stored in all-order [a, c], not insertion order [c, a]
    const afterC = toggleHiddenColumn([], 'c', ['a', 'b', 'c']);
    expect(toggleHiddenColumn(afterC, 'a', ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
});

describe('coerceCellInput (typed row-editor value coercion)', () => {
  it('null ignores the raw text and returns null', () => {
    expect(coerceCellInput('null', 'anything at all')).toBeNull();
    expect(coerceCellInput('null', '')).toBeNull();
  });

  it('text binds the raw string verbatim', () => {
    expect(coerceCellInput('text', "O'Brien")).toBe("O'Brien"); // no escaping — it's bound, not concatenated
    expect(coerceCellInput('text', '')).toBe('');
  });

  it('number parses finite numbers, rejects blank + NaN', () => {
    expect(coerceCellInput('number', '42')).toBe(42);
    expect(coerceCellInput('number', '-3.5')).toBe(-3.5);
    expect(() => coerceCellInput('number', '')).toThrow(RowMutationError);
    expect(() => coerceCellInput('number', 'abc')).toThrow(RowMutationError);
  });

  it('boolean accepts true/false/1/0/yes/no, rejects garbage', () => {
    expect(coerceCellInput('boolean', 'true')).toBe(true);
    expect(coerceCellInput('boolean', '1')).toBe(true);
    expect(coerceCellInput('boolean', 'yes')).toBe(true);
    expect(coerceCellInput('boolean', 'false')).toBe(false);
    expect(coerceCellInput('boolean', '0')).toBe(false);
    expect(coerceCellInput('boolean', '')).toBe(false);
    expect(() => coerceCellInput('boolean', 'maybe')).toThrow(RowMutationError);
  });

  it('json validates parse-ability and binds the original text (SQLite stores JSON as TEXT)', () => {
    expect(coerceCellInput('json', '{"a":1}')).toBe('{"a":1}');
    expect(coerceCellInput('json', '[1,2,3]')).toBe('[1,2,3]');
    expect(() => coerceCellInput('json', '{a:1}')).toThrow(RowMutationError);
    expect(() => coerceCellInput('json', '')).toThrow(RowMutationError);
  });
});

describe('buildInsertStatement (parameterized INSERT — never concatenates values)', () => {
  it('builds quoted identifiers + ?N placeholders + aligned params', () => {
    const stmt = buildInsertStatement('todos', ['title', 'done'], ['Buy milk', 0]);
    expect(stmt.sql).toBe('INSERT INTO "todos" ("title", "done") VALUES (?1, ?2)');
    expect(stmt.params).toEqual(['Buy milk', 0]);
  });

  it('binds a value with quotes as a PARAM, never interpolated into the SQL', () => {
    const stmt = buildInsertStatement('t', ['name'], ["Robert'); DROP TABLE students;--"]);
    expect(stmt.sql).toBe('INSERT INTO "t" ("name") VALUES (?1)'); // injection lives only in params
    expect(stmt.params).toEqual(["Robert'); DROP TABLE students;--"]);
  });

  it('preserves null / boolean / number param types for the worker to bind', () => {
    const stmt = buildInsertStatement('t', ['a', 'b', 'c'], [null, true, 7]);
    expect(stmt.params).toEqual([null, true, 7]);
  });

  it('rejects an invalid table identifier', () => {
    expect(() => buildInsertStatement('bad name', ['a'], ['x'])).toThrow(RowMutationError);
    expect(() => buildInsertStatement('"; DROP', ['a'], ['x'])).toThrow(RowMutationError);
  });

  it('rejects an invalid column identifier', () => {
    expect(() => buildInsertStatement('t', ['ok', 'bad col'], ['x', 'y'])).toThrow(RowMutationError);
  });

  it('rejects an empty column set (nothing to insert)', () => {
    expect(() => buildInsertStatement('t', [], [])).toThrow(RowMutationError);
  });

  it('rejects a column/value count mismatch', () => {
    expect(() => buildInsertStatement('t', ['a', 'b'], ['x'])).toThrow(RowMutationError);
  });
});

describe('buildDeleteByPk (single-row parameterized DELETE — never whole-table)', () => {
  it('builds a quoted PK predicate with the value bound as a param', () => {
    const stmt = buildDeleteByPk('todos', ['id'], { id: 42, title: 'x' });
    expect(stmt.sql).toBe('DELETE FROM "todos" WHERE "id" = ?1');
    expect(stmt.params).toEqual([42]);
  });

  it('supports composite keys (each PK column ANDed, in order)', () => {
    const stmt = buildDeleteByPk('m2m', ['a_id', 'b_id'], { a_id: 'x', b_id: 7, extra: 'ignored' });
    expect(stmt.sql).toBe('DELETE FROM "m2m" WHERE "a_id" = ?1 AND "b_id" = ?2');
    expect(stmt.params).toEqual(['x', 7]);
  });

  it('binds the PK value (never interpolates) — an injection-shaped key rides as a param', () => {
    const stmt = buildDeleteByPk('t', ['id'], { id: "1 OR 1=1; DROP TABLE t;--" });
    expect(stmt.sql).toBe('DELETE FROM "t" WHERE "id" = ?1');
    expect(stmt.params).toEqual(["1 OR 1=1; DROP TABLE t;--"]);
  });

  it('refuses when the table has NO primary key (never a whole-table delete)', () => {
    expect(() => buildDeleteByPk('t', [], { a: 1 })).toThrow(RowMutationError);
  });

  it('refuses when a PK value is missing/null (row not safely targetable)', () => {
    expect(() => buildDeleteByPk('t', ['id'], { title: 'no id here' })).toThrow(RowMutationError);
    expect(() => buildDeleteByPk('t', ['id'], { id: null })).toThrow(RowMutationError);
  });

  it('refuses a non-string/number PK value (not a stable key)', () => {
    expect(() => buildDeleteByPk('t', ['id'], { id: { nested: 1 } })).toThrow(RowMutationError);
    expect(() => buildDeleteByPk('t', ['id'], { id: true })).toThrow(RowMutationError);
  });

  it('rejects invalid table / PK-column identifiers', () => {
    expect(() => buildDeleteByPk('bad name', ['id'], { id: 1 })).toThrow(RowMutationError);
    expect(() => buildDeleteByPk('t', ['bad col'], { 'bad col': 1 })).toThrow(RowMutationError);
  });
});
