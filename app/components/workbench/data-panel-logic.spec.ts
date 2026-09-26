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
  buildCsvImportPlan,
  CsvImportError,
  pkFromTableInfo,
  generatedFromTableXinfo,
  browsePageInfo,
  sortToParams,
  browseSearchParam,
  filtersToParams,
  clampPageSize,
  PAGE_SIZE_OPTIONS,
  insertableColumns,
  stripSqlCommentsAndStrings,
  classifySqlStatement,
  classifySql,
  explainQuery,
  explainPlanHint,
  isExpensiveScan,
  EXPENSIVE_SCAN_ROWS,
  analyzeRowLimit,
  DEFAULT_ROW_LIMIT,
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
  inferCellEditor,
  buildInsertStatement,
  buildDeleteByPk,
  buildBulkDeleteByPk,
  rowPkKey,
  MAX_BULK_DELETE,
  friendlyModelLabel,
  canAskAi,
  MAX_AI_QUESTION_LEN,
  detectChartable,
  buildChartSeries,
  MAX_CHART_ROWS,
  buildUpdateByPk,
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

describe('buildCsvImportPlan (parameterized + chunked CSV → table import)', () => {
  it('builds ONE parameterized multi-row INSERT — values BOUND as ?, never inlined', () => {
    const plan = buildCsvImportPlan('a,b\n1,2\n3,4', 't');
    expect(plan.columns).toEqual(['a', 'b']);
    expect(plan.rowCount).toBe(2);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].statement).toBe('INSERT INTO "t" ("a", "b") VALUES (?, ?), (?, ?)');
    expect(plan.batches[0].params).toEqual(['1', '2', '3', '4']);
    expect(plan.batches[0].rowCount).toBe(2);
  });

  it('maps an empty cell to a bound null (never the string "" or a literal NULL)', () => {
    const plan = buildCsvImportPlan('a,b\n1,', 't');
    expect(plan.batches[0].params).toEqual(['1', null]);
    expect(plan.batches[0].statement).not.toContain('NULL');
  });

  it('a hostile value rides as an inert PARAM — the statement carries no injected SQL', () => {
    const plan = buildCsvImportPlan("name\n');DROP TABLE users;--", 't');
    expect(plan.batches[0].params).toEqual(["');DROP TABLE users;--"]);
    expect(plan.batches[0].statement).toBe('INSERT INTO "t" ("name") VALUES (?)');
    expect(plan.batches[0].statement.toUpperCase()).not.toContain('DROP');
  });

  it('CHUNKS rows so each batch stays within the param cap', () => {
    // maxParams=4, 2 cols → 2 rows/batch; 3 data rows → batches of [2, 1].
    const plan = buildCsvImportPlan('a,b\n1,2\n3,4\n5,6', 't', 4);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0].rowCount).toBe(2);
    expect(plan.batches[0].params).toEqual(['1', '2', '3', '4']);
    expect(plan.batches[1].rowCount).toBe(1);
    expect(plan.batches[1].params).toEqual(['5', '6']);
    expect(plan.batches[0].statement).toBe('INSERT INTO "t" ("a", "b") VALUES (?, ?), (?, ?)');
    expect(plan.batches[1].statement).toBe('INSERT INTO "t" ("a", "b") VALUES (?, ?)');
  });

  it('previews the first rows for the UI', () => {
    const plan = buildCsvImportPlan('a\n1\n2\n3\n4\n5\n6\n7', 't');
    expect(plan.rowCount).toBe(7);
    expect(plan.preview).toEqual([['1'], ['2'], ['3'], ['4'], ['5']]); // CSV_IMPORT_PREVIEW_ROWS = 5
  });

  it('rejects an invalid table name', () => {
    expect(() => buildCsvImportPlan('a\n1', 'bad name')).toThrow(CsvImportError);
    expect(() => buildCsvImportPlan('a\n1', '1t')).toThrow(CsvImportError);
  });
  it('rejects an invalid header identifier', () => {
    expect(() => buildCsvImportPlan('bad col\n1', 't')).toThrow(CsvImportError);
  });
  it('rejects fewer than two rows (header + ≥1 data row required)', () => {
    expect(() => buildCsvImportPlan('a,b', 't')).toThrow(CsvImportError);
    expect(() => buildCsvImportPlan('', 't')).toThrow(CsvImportError);
  });
  it('rejects a row whose column count mismatches the header', () => {
    expect(() => buildCsvImportPlan('a,b\n1', 't')).toThrow(CsvImportError);
  });
  it('rejects a table too wide to import within one parameterized write', () => {
    expect(() => buildCsvImportPlan('a,b,c\n1,2,3', 't', 2)).toThrow(CsvImportError);
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

describe('generatedFromTableXinfo', () => {
  it('flags VIRTUAL (hidden 2) and STORED (hidden 3) generated columns', () => {
    const gen = generatedFromTableXinfo([
      { name: 'a', hidden: 0 },
      { name: 'v', hidden: 2 },
      { name: 's', hidden: 3 },
    ]);
    expect([...gen].sort()).toEqual(['s', 'v']);
  });

  it('does NOT flag ordinary (hidden 0) or internal-hidden (hidden 1) columns', () => {
    const gen = generatedFromTableXinfo([
      { name: 'a', hidden: 0 },
      { name: 'rowid_alias', hidden: 1 },
    ]);
    expect(gen.size).toBe(0);
  });

  it('accepts the aliased "column" key and coerces a string hidden value', () => {
    const gen = generatedFromTableXinfo([{ column: 'total', hidden: '2' }]);
    expect(gen.has('total')).toBe(true);
  });

  it('treats a row with no `hidden` field as ordinary (empty set), never throws on []', () => {
    expect(generatedFromTableXinfo([{ name: 'a', pk: 1 }]).size).toBe(0);
    expect(generatedFromTableXinfo([]).size).toBe(0);
  });
});

describe('browsePageInfo (server-side pagination display + prev/next)', () => {
  it('first full page: 1-based range, no prev, has next', () => {
    expect(browsePageInfo(0, 25, 1234)).toEqual({
      from: 1,
      to: 25,
      hasPrev: false,
      hasNext: true,
      label: '1–25 of 1,234',
    });
  });

  it('a middle page has both prev and next', () => {
    expect(browsePageInfo(25, 25, 1234)).toEqual({
      from: 26,
      to: 50,
      hasPrev: true,
      hasNext: true,
      label: '26–50 of 1,234',
    });
  });

  it('the last (partial) page has prev but NOT next', () => {
    expect(browsePageInfo(1225, 9, 1234)).toEqual({
      from: 1226,
      to: 1234,
      hasPrev: true,
      hasNext: false,
      label: '1,226–1,234 of 1,234',
    });
  });

  it('hasNext is false exactly at the boundary (offset + shown === total)', () => {
    expect(browsePageInfo(75, 25, 100).hasNext).toBe(false);
    expect(browsePageInfo(50, 25, 100).hasNext).toBe(true);
  });

  it('an empty table → "No rows", no prev/next, zero range', () => {
    expect(browsePageInfo(0, 0, 0)).toEqual({
      from: 0,
      to: 0,
      hasPrev: false,
      hasNext: false,
      label: 'No rows',
    });
  });

  it('an empty PAGE with a non-zero total is labelled honestly ("0 of N")', () => {
    expect(browsePageInfo(0, 0, 5).label).toBe('0 of 5');
  });

  it('clamps a negative / NaN offset to 0 and never yields a negative range', () => {
    expect(browsePageInfo(-5, 25, 100).from).toBe(1);
    expect(browsePageInfo(-5, 25, 100).hasPrev).toBe(false);

    const nan = browsePageInfo(Number.NaN, Number.NaN, Number.NaN);
    expect(nan).toEqual({ from: 0, to: 0, hasPrev: false, hasNext: false, label: 'No rows' });
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

describe('analyzeRowLimit', () => {
  it('flags a bare SELECT with no LIMIT and appends the default cap', () => {
    const a = analyzeRowLimit('SELECT * FROM users');
    expect(a.needsLimit).toBe(true);
    expect(a.limit).toBe(DEFAULT_ROW_LIMIT);
    expect(a.limitedSql).toBe(`SELECT * FROM users LIMIT ${DEFAULT_ROW_LIMIT}`);
  });

  it('leaves an already-LIMITed query alone (never a double LIMIT), case-insensitive', () => {
    const a = analyzeRowLimit('select a from t limit 10');
    expect(a.needsLimit).toBe(false);
    expect(a.limitedSql).toBe('select a from t limit 10');
  });

  it('bounds a WITH…SELECT (CTE) — it returns rows too', () => {
    const a = analyzeRowLimit('WITH c AS (SELECT 1 AS n) SELECT * FROM c');
    expect(a.needsLimit).toBe(true);
    expect(a.limitedSql).toBe('WITH c AS (SELECT 1 AS n) SELECT * FROM c LIMIT 500');
  });

  it('leaves EXPLAIN / PRAGMA / VALUES / writes alone (not a bare row-returning SELECT)', () => {
    expect(analyzeRowLimit('EXPLAIN QUERY PLAN SELECT * FROM t').needsLimit).toBe(false);
    expect(analyzeRowLimit('PRAGMA table_info(t)').needsLimit).toBe(false);
    expect(analyzeRowLimit('VALUES (1),(2)').needsLimit).toBe(false);
    expect(analyzeRowLimit('DELETE FROM t').needsLimit).toBe(false);
  });

  it('honors a custom limit', () => {
    expect(analyzeRowLimit('SELECT * FROM t', 100).limitedSql).toBe('SELECT * FROM t LIMIT 100');
  });

  it('does NOT false-match a LIMIT inside a string literal (detects on a stripped copy)', () => {
    // The word LIMIT lives only inside a quoted value → the query is genuinely unbounded.
    const a = analyzeRowLimit("SELECT * FROM t WHERE note = 'has the word LIMIT in it'");
    expect(a.needsLimit).toBe(true);
    expect(a.limitedSql.endsWith(`LIMIT ${DEFAULT_ROW_LIMIT}`)).toBe(true);
  });

  it('only bounds the FIRST statement of a multi-statement buffer (the console runs one)', () => {
    const a = analyzeRowLimit('SELECT * FROM a; SELECT * FROM b');
    expect(a.needsLimit).toBe(true);
    expect(a.limitedSql).toBe('SELECT * FROM a LIMIT 500');
  });

  it('conservatively suppresses the offer when ANY LIMIT is present (subquery) — never risks a double LIMIT', () => {
    expect(analyzeRowLimit('SELECT * FROM (SELECT x FROM t LIMIT 5)').needsLimit).toBe(false);
  });

  it('is a no-op on a blank / whitespace / semicolon-only buffer', () => {
    expect(analyzeRowLimit('').needsLimit).toBe(false);
    expect(analyzeRowLimit('   ;; ').needsLimit).toBe(false);
    expect(analyzeRowLimit('   ').limitedSql).toBe('   ');
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

describe('sortToParams (GridSort → server-sort request params)', () => {
  it('maps an active sort to orderBy + dir (both directions)', () => {
    expect(sortToParams({ col: 'created_at', dir: 'desc' })).toEqual({
      orderBy: 'created_at',
      dir: 'desc',
    });
    expect(sortToParams({ col: 'email', dir: 'asc' })).toEqual({ orderBy: 'email', dir: 'asc' });
  });

  it('maps a null sort to {} (the table default server order — no orderBy sent)', () => {
    expect(sortToParams(null)).toEqual({});
  });
});

describe('browseSearchParam (search box → server-search request param)', () => {
  it('trims a non-empty needle into { search }', () => {
    expect(browseSearchParam('ada')).toEqual({ search: 'ada' });
    expect(browseSearchParam('  ada lovelace  ')).toEqual({ search: 'ada lovelace' });
  });

  it('omits search for blank / whitespace / null / undefined (no filter)', () => {
    expect(browseSearchParam('')).toEqual({});
    expect(browseSearchParam('   ')).toEqual({});
    expect(browseSearchParam(null)).toEqual({});
    expect(browseSearchParam(undefined)).toEqual({});
  });
});

describe('filtersToParams (search + exact-column filter → request params)', () => {
  it('sends search + filterCol + filterVal together when all present', () => {
    expect(filtersToParams({ search: 'ada', filterCol: 'status', filterVal: 'active' })).toEqual({
      search: 'ada',
      filterCol: 'status',
      filterVal: 'active',
    });
  });

  it('sends only what is set (search alone / filter alone)', () => {
    expect(filtersToParams({ search: 'x', filterCol: null, filterVal: '' })).toEqual({ search: 'x' });
    expect(filtersToParams({ search: '', filterCol: 'status', filterVal: 'active' })).toEqual({
      filterCol: 'status',
      filterVal: 'active',
    });
  });

  it('omits the column filter when the value is blank (matches the worker) or no column chosen', () => {
    // column chosen but blank value → no filter (the worker ignores a blank value)
    expect(filtersToParams({ search: '', filterCol: 'status', filterVal: '   ' })).toEqual({});

    // value but no column → no filter
    expect(filtersToParams({ search: '', filterCol: null, filterVal: 'active' })).toEqual({});
  });

  it('trims search + filter value', () => {
    expect(filtersToParams({ search: '  a ', filterCol: 'c', filterVal: '  v ' })).toEqual({
      search: 'a',
      filterCol: 'c',
      filterVal: 'v',
    });
  });
});

describe('clampPageSize (rows-per-page selector guard)', () => {
  it('passes an offered page size through', () => {
    for (const n of PAGE_SIZE_OPTIONS) {
      expect(clampPageSize(n)).toBe(n);
    }
  });

  it('falls back to the default (25) for any non-offered / NaN value', () => {
    expect(clampPageSize(10)).toBe(25);
    expect(clampPageSize(0)).toBe(25);
    expect(clampPageSize(999)).toBe(25);
    expect(clampPageSize(Number.NaN)).toBe(25);
  });
});

describe('insertableColumns (Add-row INSERT column set)', () => {
  it('keeps opted-in columns (kind ≠ default), in table order', () => {
    expect(insertableColumns(['id', 'name', 'note'], { name: 'text', note: 'text' }, new Set())).toEqual([
      'name',
      'note',
    ]);
  });

  it("omits columns left at 'default' (use the column default) and unset columns", () => {
    expect(insertableColumns(['id', 'name'], { id: 'default', name: 'text' }, new Set())).toEqual(['name']);
    expect(insertableColumns(['id', 'name'], {}, new Set())).toEqual([]);
  });

  it('ALWAYS omits generated columns even if a stale kind is set (SQLite rejects inserting one)', () => {
    expect(insertableColumns(['id', 'name', 'total'], { name: 'text', total: 'number' }, new Set(['total']))).toEqual([
      'name',
    ]);
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
    const stmt = buildDeleteByPk('t', ['id'], { id: '1 OR 1=1; DROP TABLE t;--' });
    expect(stmt.sql).toBe('DELETE FROM "t" WHERE "id" = ?1');
    expect(stmt.params).toEqual(['1 OR 1=1; DROP TABLE t;--']);
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

describe('buildUpdateByPk (single-row, single-column parameterized UPDATE)', () => {
  it('binds the new value as ?1 and the PK predicate from ?2', () => {
    const stmt = buildUpdateByPk('todos', ['id'], { id: 42, title: 'old' }, 'title', 'Buy oat milk');
    expect(stmt.sql).toBe('UPDATE "todos" SET "title" = ?1 WHERE "id" = ?2');
    expect(stmt.params).toEqual(['Buy oat milk', 42]);
  });

  it('supports composite keys (SET ?1, then each PK ANDed from ?2)', () => {
    const stmt = buildUpdateByPk('m2m', ['a_id', 'b_id'], { a_id: 'x', b_id: 7 }, 'role', 'admin');
    expect(stmt.sql).toBe('UPDATE "m2m" SET "role" = ?1 WHERE "a_id" = ?2 AND "b_id" = ?3');
    expect(stmt.params).toEqual(['admin', 'x', 7]);
  });

  it('binds the value (never interpolates) — an injection-shaped value rides as ?1', () => {
    const stmt = buildUpdateByPk('t', ['id'], { id: 1 }, 'note', "'); DROP TABLE t;--");
    expect(stmt.sql).toBe('UPDATE "t" SET "note" = ?1 WHERE "id" = ?2');
    expect(stmt.params).toEqual(["'); DROP TABLE t;--", 1]);
  });

  it('preserves null / boolean / number typed values', () => {
    expect(buildUpdateByPk('t', ['id'], { id: 1 }, 'x', null).params).toEqual([null, 1]);
    expect(buildUpdateByPk('t', ['id'], { id: 1 }, 'x', true).params).toEqual([true, 1]);
    expect(buildUpdateByPk('t', ['id'], { id: 1 }, 'x', 0).params).toEqual([0, 1]);
  });

  it('refuses to edit a PRIMARY-KEY column (the key is the predicate, not editable)', () => {
    expect(() => buildUpdateByPk('t', ['id'], { id: 1 }, 'id', 2)).toThrow(RowMutationError);
  });

  it('refuses when there is no primary key (never an unscoped UPDATE)', () => {
    expect(() => buildUpdateByPk('t', [], { a: 1 }, 'a', 'x')).toThrow(RowMutationError);
  });

  it('refuses a missing/non-scalar PK value (row not safely targetable)', () => {
    expect(() => buildUpdateByPk('t', ['id'], { title: 'no id' }, 'title', 'x')).toThrow(RowMutationError);
    expect(() => buildUpdateByPk('t', ['id'], { id: { n: 1 } }, 'title', 'x')).toThrow(RowMutationError);
  });

  it('rejects invalid table / set-column identifiers', () => {
    expect(() => buildUpdateByPk('bad name', ['id'], { id: 1 }, 'x', 1)).toThrow(RowMutationError);
    expect(() => buildUpdateByPk('t', ['id'], { id: 1 }, 'bad col', 1)).toThrow(RowMutationError);
  });
});

describe('inferCellEditor (prefill an editor from an existing value — inverse of coerceCellInput)', () => {
  it('maps each value type to its editor kind + prefill string', () => {
    expect(inferCellEditor('hello')).toEqual({ kind: 'text', value: 'hello' });
    expect(inferCellEditor(42)).toEqual({ kind: 'number', value: '42' });
    expect(inferCellEditor(0)).toEqual({ kind: 'number', value: '0' });
    expect(inferCellEditor(true)).toEqual({ kind: 'boolean', value: 'true' });
    expect(inferCellEditor(false)).toEqual({ kind: 'boolean', value: 'false' });
    expect(inferCellEditor(null)).toEqual({ kind: 'null', value: '' });
    expect(inferCellEditor(undefined)).toEqual({ kind: 'null', value: '' });
    expect(inferCellEditor({ a: 1 })).toEqual({ kind: 'json', value: '{"a":1}' });
    expect(inferCellEditor([1, 2])).toEqual({ kind: 'json', value: '[1,2]' });
  });

  it('round-trips through coerceCellInput (infer → coerce restores the value)', () => {
    for (const v of ['hi', 42, true, null] as const) {
      const ed = inferCellEditor(v);
      expect(coerceCellInput(ed.kind, ed.value)).toEqual(v);
    }

    // JSON round-trips as its text form (SQLite stores JSON as TEXT).
    const j = inferCellEditor({ a: 1 });
    expect(coerceCellInput(j.kind, j.value)).toBe('{"a":1}');
  });
});

describe('rowPkKey (stable per-row selection key)', () => {
  it('serializes PK value(s) in order; null when the row lacks a usable PK', () => {
    expect(rowPkKey({ id: 42, x: 'y' }, ['id'])).toBe('[42]');
    expect(rowPkKey({ a: 'x', b: 7 }, ['a', 'b'])).toBe('["x",7]');
    expect(rowPkKey({ x: 1 }, [])).toBeNull(); // no PK cols
    expect(rowPkKey({ id: null }, ['id'])).toBeNull(); // null PK value
    expect(rowPkKey({ id: { n: 1 } }, ['id'])).toBeNull(); // non-scalar PK
  });
});

describe('buildBulkDeleteByPk (batched parameterized DELETE — capped, never whole-table)', () => {
  it('single-column PK → WHERE "id" IN (?1, ?2, …) with bound params', () => {
    const stmt = buildBulkDeleteByPk('todos', ['id'], [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(stmt.sql).toBe('DELETE FROM "todos" WHERE "id" IN (?1, ?2, ?3)');
    expect(stmt.params).toEqual([1, 2, 3]);
  });

  it('composite PK → OR of (col=? AND col=?) groups, param indices threaded across rows', () => {
    const stmt = buildBulkDeleteByPk(
      'm2m',
      ['a_id', 'b_id'],
      [
        { a_id: 'x', b_id: 1 },
        { a_id: 'y', b_id: 2 },
      ],
    );
    expect(stmt.sql).toBe('DELETE FROM "m2m" WHERE ("a_id" = ?1 AND "b_id" = ?2) OR ("a_id" = ?3 AND "b_id" = ?4)');
    expect(stmt.params).toEqual(['x', 1, 'y', 2]);
  });

  it('binds values (never interpolates) — an injection-shaped id rides as a param', () => {
    const stmt = buildBulkDeleteByPk('t', ['id'], [{ id: '1); DROP TABLE t;--' }]);
    expect(stmt.sql).toBe('DELETE FROM "t" WHERE "id" IN (?1)');
    expect(stmt.params).toEqual(['1); DROP TABLE t;--']);
  });

  it('enforces the cap (MAX_BULK_DELETE) — never an unbounded wipe', () => {
    const rows = Array.from({ length: MAX_BULK_DELETE + 1 }, (_, i) => ({ id: i }));
    expect(() => buildBulkDeleteByPk('t', ['id'], rows)).toThrow(RowMutationError);

    // exactly at the cap is allowed
    expect(() => buildBulkDeleteByPk('t', ['id'], rows.slice(0, MAX_BULK_DELETE))).not.toThrow();
  });

  it('refuses empty selection / no primary key / missing-PK / non-scalar-PK / bad idents', () => {
    expect(() => buildBulkDeleteByPk('t', ['id'], [])).toThrow(RowMutationError);
    expect(() => buildBulkDeleteByPk('t', [], [{ id: 1 }])).toThrow(RowMutationError);
    expect(() => buildBulkDeleteByPk('t', ['id'], [{ x: 1 }])).toThrow(RowMutationError);
    expect(() => buildBulkDeleteByPk('t', ['id'], [{ id: true }])).toThrow(RowMutationError);
    expect(() => buildBulkDeleteByPk('bad name', ['id'], [{ id: 1 }])).toThrow(RowMutationError);
    expect(() => buildBulkDeleteByPk('t', ['bad col'], [{ 'bad col': 1 }])).toThrow(RowMutationError);
  });
});

describe('friendlyModelLabel (AI SQL assistant)', () => {
  it('reduces the CF Llama slug to a short human label', () => {
    expect(friendlyModelLabel('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe('Llama 3.3 70B');
  });

  it('uppercases a trailing size unit and keeps version tokens', () => {
    expect(friendlyModelLabel('@cf/meta/llama-3.1-8b-instruct')).toBe('Llama 3.1 8B');
  });

  it('degrades to the last path segment for unknown shapes; blank → "AI"', () => {
    expect(friendlyModelLabel('some/custom/model-x')).toBe('Model X');
    expect(friendlyModelLabel('')).toBe('AI');
    expect(friendlyModelLabel('   ')).toBe('AI');
  });

  it('never throws on odd input (all-dropped tokens fall back to the segment)', () => {
    expect(friendlyModelLabel('@cf/meta/instruct-fp8-fast')).toBe('instruct-fp8-fast');
  });
});

describe('canAskAi (AI question guard)', () => {
  it('blank / whitespace → not ok, no reason (button just disabled)', () => {
    expect(canAskAi('')).toEqual({ ok: false });
    expect(canAskAi('   ')).toEqual({ ok: false });
  });

  it('a normal question → ok', () => {
    expect(canAskAi('list the 10 newest form submissions')).toEqual({ ok: true });
  });

  it('over the length cap → not ok WITH a human reason', () => {
    const tooLong = 'a'.repeat(MAX_AI_QUESTION_LEN + 1);
    const res = canAskAi(tooLong);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(String(MAX_AI_QUESTION_LEN));
  });

  it('exactly at the cap → ok', () => {
    expect(canAskAi('a'.repeat(MAX_AI_QUESTION_LEN))).toEqual({ ok: true });
  });
});

describe('detectChartable (query-result mini-charts)', () => {
  it('detects a label + numeric column (the GROUP BY case)', () => {
    const rows = [
      { country: 'US', n: 5 },
      { country: 'DE', n: 3 },
    ];
    expect(detectChartable(['country', 'n'], rows)).toEqual({ labelCol: 'country', valueCols: ['n'] });
  });

  it('picks the first non-numeric column as the label and plots the rest', () => {
    const rows = [{ name: 'a', hits: 10, misses: 2 }];
    expect(detectChartable(['name', 'hits', 'misses'], rows)).toEqual({
      labelCol: 'name',
      valueCols: ['hits', 'misses'],
    });
  });

  it('uses the first column as a numeric axis label when ALL columns are numeric (e.g. year)', () => {
    const rows = [
      { year: 2024, revenue: 100 },
      { year: 2025, revenue: 140 },
    ];
    expect(detectChartable(['year', 'revenue'], rows)).toEqual({
      labelCol: 'year',
      valueCols: ['revenue'],
    });
  });

  it('is NOT chartable: single column, no numeric value, or a raw dump over the row cap', () => {
    expect(detectChartable(['id'], [{ id: 1 }])).toBeNull(); // <2 columns
    expect(detectChartable(['a', 'b'], [{ a: 'x', b: 'y' }])).toBeNull(); // no numeric
    expect(detectChartable(['n'], [{ n: 1 }])).toBeNull(); // single numeric → nothing to label

    const big = Array.from({ length: MAX_CHART_ROWS + 1 }, (_, i) => ({ k: `k${i}`, v: i }));
    expect(detectChartable(['k', 'v'], big)).toBeNull(); // too many rows = a dump, not a summary
  });

  it('treats numeric-looking strings as numeric (D1 sometimes returns counts as strings)', () => {
    expect(detectChartable(['label', 'n'], [{ label: 'x', n: '7' }])).toEqual({
      labelCol: 'label',
      valueCols: ['n'],
    });
  });
});

describe('buildChartSeries', () => {
  it('maps rows to {label,value}, coercing values and stringifying labels', () => {
    const rows = [
      { country: 'US', n: 5 },
      { country: 'DE', n: '3' },
    ];
    expect(buildChartSeries(rows, 'country', 'n')).toEqual([
      { label: 'US', value: 5 },
      { label: 'DE', value: 3 },
    ]);
  });
  it('renders a null/blank label as ∅ and drops non-finite values (never a fabricated 0)', () => {
    const rows = [
      { c: null, n: 2 },
      { c: 'x', n: 'not-a-number' },
    ];
    expect(buildChartSeries(rows, 'c', 'n')).toEqual([{ label: '∅', value: 2 }]);
  });
});
