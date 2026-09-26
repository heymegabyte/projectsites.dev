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
  isRowActivationKey,
  isDismissKey,
  addToSqlHistory,
  addSavedQuery,
  removeSavedQuery,
  parseCsv,
  buildCsvImportPlan,
  buildJsonImportPlan,
  buildImportPlan,
  detectImportFormat,
  CsvImportError,
  pkFromTableInfo,
  generatedFromTableXinfo,
  browsePageInfo,
  sortToParams,
  browseSearchParam,
  filtersToParams,
  filterIsActive,
  filterOpIsValueFree,
  normalizeFilterOp,
  FILTER_OPS,
  FILTER_OP_OPTIONS,
  FILTER_VALUE_FREE_OPS,
  normalizeCombinator,
  FILTER_COMBINATORS,
  MAX_FILTER_CONDITIONS,
  blankCondition,
  addCondition,
  removeCondition,
  updateCondition,
  activeConditions,
  filterGroupIsActive,
  type FilterCondition,
  normalizeViewMode,
  kanbanGroupKey,
  groupPageRows,
  buildChartBars,
  numericColumns,
  galleryTitleField,
  galleryBodyFields,
  recordTitle,
  recordNavigation,
  layoutSignature,
  calendarDateField,
  monthFromDayKey,
  addCalendarMonth,
  monthMatrix,
  viewQueryFingerprint,
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
  cycleSortMulti,
  sortsToParam,
  parseSortSpec,
  sortRows,
  clipboardValue,
  rowJson,
  visibleColumns,
  applyPins,
  pinnedLeftOffsets,
  clampColWidth,
  parseColWidths,
  SUMMARY_KINDS,
  normalizeSummaryKind,
  summaryLabel,
  summaryValue,
  parseColSummaries,
  MIN_COL_WIDTH,
  MAX_COL_WIDTH,
  normalizeDensity,
  densityCellClass,
  densitySelectCellClass,
  GRID_DENSITIES,
  orderColumns,
  moveColumn,
  toggleHiddenColumn,
  coerceCellInput,
  inferCellEditor,
  editorKindForColumn,
  toDateInputValue,
  toDatetimeLocalValue,
  isValidJsonText,
  distinctSuggestions,
  distinctCacheKey,
  nullabilityHint,
  describeIntent,
  askIntentToSavedView,
  planCreateTable,
  planCreateIndex,
  suggestIndexName,
  planDropIndex,
  summarizeIndexRow,
  CELL_INPUT_KIND_OPTIONS,
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
  it('renders a worker BLOB envelope as a compact "BLOB · N bytes" label (never a garbled {})', () => {
    expect(formatCellValue({ __blob: true, bytes: 2048, hex: 'de ad' })).toBe('BLOB · 2.0 KB');
    expect(formatCellValue({ __blob: true, bytes: 12, hex: '00' })).toBe('BLOB · 12 B');
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

describe('buildJsonImportPlan (parameterized JSON array-of-objects → table import)', () => {
  it('builds a bound multi-row INSERT, binding primitives directly (numbers stay numbers)', () => {
    const plan = buildJsonImportPlan('[{"a":1,"b":"x"},{"a":2,"b":"y"}]', 't');
    expect(plan.columns).toEqual(['a', 'b']);
    expect(plan.rowCount).toBe(2);
    expect(plan.batches[0]).toEqual({
      statement: 'INSERT INTO "t" ("a", "b") VALUES (?, ?), (?, ?)',
      params: [1, 'x', 2, 'y'],
      rowCount: 2,
    });
  });

  it('unions keys in first-seen order; a missing key binds null (ragged objects)', () => {
    const plan = buildJsonImportPlan('[{"a":1},{"b":2}]', 't');
    expect(plan.columns).toEqual(['a', 'b']);
    expect(plan.batches[0].params).toEqual([1, null, null, 2]);
  });

  it('stringifies a nested object/array value to JSON text; null stays SQL NULL; booleans bind', () => {
    const plan = buildJsonImportPlan('[{"a":{"x":1},"b":[1,2],"c":null,"d":true}]', 't');
    expect(plan.batches[0].params).toEqual(['{"x":1}', '[1,2]', null, true]);
  });

  it('binds an injection-shaped string value as an inert param (never concatenated)', () => {
    const plan = buildJsonImportPlan('[{"name":"\'); DROP TABLE users;--"}]', 't');
    expect(plan.batches[0].statement).toBe('INSERT INTO "t" ("name") VALUES (?)');
    expect(plan.batches[0].params).toEqual(["'); DROP TABLE users;--"]);
  });

  it('chunks rows to stay within the parameter cap', () => {
    const plan = buildJsonImportPlan('[{"a":1},{"a":2},{"a":3}]', 't', 2);
    expect(plan.batches).toHaveLength(2); // 2 params/row cap, 1 col → 2 rows then 1 row
    expect(plan.batches.map((b) => b.rowCount)).toEqual([2, 1]);
  });

  it('rejects invalid JSON, a non-array root, an empty array, and a non-object element', () => {
    expect(() => buildJsonImportPlan('not json', 't')).toThrow(CsvImportError);
    expect(() => buildJsonImportPlan('{"a":1}', 't')).toThrow(CsvImportError);
    expect(() => buildJsonImportPlan('[]', 't')).toThrow(CsvImportError);
    expect(() => buildJsonImportPlan('[1,2]', 't')).toThrow(CsvImportError);
  });

  it('rejects a bad field identifier + a bad table name', () => {
    expect(() => buildJsonImportPlan('[{"bad col":1}]', 't')).toThrow(CsvImportError);
    expect(() => buildJsonImportPlan('[{"a":1}]', '1t')).toThrow(CsvImportError);
  });
});

describe('detectImportFormat + buildImportPlan (auto-dispatch)', () => {
  it('detects a leading [ as JSON, else CSV', () => {
    expect(detectImportFormat('  [{"a":1}]')).toBe('json');
    expect(detectImportFormat('a,b\n1,2')).toBe('csv');
  });

  it('dispatches to the JSON builder for a JSON paste', () => {
    expect(buildImportPlan('[{"a":1}]', 't').batches[0].params).toEqual([1]);
  });

  it('dispatches to the CSV builder for a CSV paste', () => {
    expect(buildImportPlan('a\n1', 't').batches[0].params).toEqual(['1']);
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

describe('cycleSortMulti (header-click builds/cycles a multi-column sort)', () => {
  it('appends a new column ascending; cycles asc→desc in place; desc removes it', () => {
    expect(cycleSortMulti([], 'name')).toEqual([{ col: 'name', dir: 'asc' }]);
    expect(cycleSortMulti([{ col: 'name', dir: 'asc' }], 'name')).toEqual([{ col: 'name', dir: 'desc' }]);
    expect(cycleSortMulti([{ col: 'name', dir: 'desc' }], 'name')).toEqual([]);
  });
  it('builds a priority-ordered multi-sort across successive columns (in place, keeping priority)', () => {
    expect(cycleSortMulti([{ col: 'a', dir: 'asc' }], 'b')).toEqual([
      { col: 'a', dir: 'asc' },
      { col: 'b', dir: 'asc' },
    ]);
    expect(
      cycleSortMulti(
        [
          { col: 'a', dir: 'asc' },
          { col: 'b', dir: 'asc' },
        ],
        'a',
      ),
    ).toEqual([
      { col: 'a', dir: 'desc' },
      { col: 'b', dir: 'asc' },
    ]);

    // removing a middle sort keeps the rest in order
    expect(
      cycleSortMulti(
        [
          { col: 'a', dir: 'desc' },
          { col: 'b', dir: 'asc' },
        ],
        'a',
      ),
    ).toEqual([{ col: 'b', dir: 'asc' }]);
  });
  it('does not mutate the input', () => {
    const input = [{ col: 'a', dir: 'asc' as const }];
    cycleSortMulti(input, 'a');
    expect(input).toEqual([{ col: 'a', dir: 'asc' }]);
  });
});

describe('sortsToParam / parseSortSpec (multi-sort ↔ col:dir,… round-trip)', () => {
  it('serializes an ordered list to the sort param, empty → {}', () => {
    expect(
      sortsToParam([
        { col: 'a', dir: 'asc' },
        { col: 'b', dir: 'desc' },
      ]),
    ).toEqual({ sort: 'a:asc,b:desc' });
    expect(sortsToParam([])).toEqual({});
  });
  it('parses the param back (dir coerced, blanks + dupes dropped) — round-trips', () => {
    expect(parseSortSpec('a:asc,b:desc')).toEqual([
      { col: 'a', dir: 'asc' },
      { col: 'b', dir: 'desc' },
    ]);
    expect(parseSortSpec('a:bogus,,a:desc')).toEqual([{ col: 'a', dir: 'asc' }]); // junk dir→asc; dupe dropped
    expect(parseSortSpec('')).toEqual([]);

    const list = [
      { col: 'x', dir: 'desc' as const },
      { col: 'y', dir: 'asc' as const },
    ];
    expect(parseSortSpec(sortsToParam(list).sort)).toEqual(list);
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

describe('filtersToParams (search + AND/OR condition group → request params)', () => {
  const cond = (col: string | null, op: string, val: string): FilterCondition => ({ col, op, val });

  it('serializes ONE active condition as a filters JSON array (no combinator for a single condition)', () => {
    expect(filtersToParams({ search: 'ada', conditions: [cond('status', 'eq', 'active')], combinator: 'AND' })).toEqual(
      {
        search: 'ada',
        filters: '[{"col":"status","op":"eq","val":"active"}]',
      },
    );
  });

  it('sends search alone when no condition is active', () => {
    expect(filtersToParams({ search: 'x', conditions: [], combinator: 'AND' })).toEqual({ search: 'x' });
    expect(filtersToParams({ search: 'x', conditions: [cond(null, 'eq', 'v')], combinator: 'AND' })).toEqual({
      search: 'x',
    });
  });

  it('joins multiple active conditions and only sends filterCombinator when >1 AND not the default AND', () => {
    // two conditions, OR → combinator sent
    expect(
      filtersToParams({
        search: '',
        conditions: [cond('a', 'gt', '1'), cond('b', 'null', '')],
        combinator: 'OR',
      }),
    ).toEqual({
      filters: '[{"col":"a","op":"gt","val":"1"},{"col":"b","op":"null","val":""}]',
      filterCombinator: 'OR',
    });

    // two conditions, AND (default) → combinator OMITTED
    expect(
      filtersToParams({
        search: '',
        conditions: [cond('a', 'eq', '1'), cond('b', 'eq', '2')],
        combinator: 'AND',
      }),
    ).not.toHaveProperty('filterCombinator');
  });

  it('drops inactive conditions (no column / value-op with blank value) and trims values', () => {
    expect(
      filtersToParams({
        search: '',
        conditions: [cond(null, 'eq', 'x'), cond('age', 'gt', '  '), cond('name', 'contains', '  ada ')],
        combinator: 'AND',
      }),
    ).toEqual({ filters: '[{"col":"name","op":"contains","val":"ada"}]' });
  });

  it('value-free ops (null/notnull) serialize with an empty val even if a value lingers', () => {
    expect(
      filtersToParams({ search: '', conditions: [cond('deleted_at', 'notnull', 'stale')], combinator: 'AND' }),
    ).toEqual({ filters: '[{"col":"deleted_at","op":"notnull","val":""}]' });
  });

  it('normalizes an unknown op to eq in the serialized leaf', () => {
    expect(filtersToParams({ search: '', conditions: [cond('status', 'bogus', 'active')], combinator: 'AND' })).toEqual(
      { filters: '[{"col":"status","op":"eq","val":"active"}]' },
    );
  });

  it('caps the serialized group at MAX_FILTER_CONDITIONS', () => {
    const many = Array.from({ length: MAX_FILTER_CONDITIONS + 5 }, () => cond('status', 'eq', 'x'));
    const parsed = JSON.parse(filtersToParams({ search: '', conditions: many, combinator: 'AND' }).filters!);
    expect(parsed.length).toBe(MAX_FILTER_CONDITIONS);
  });
});

describe('condition-group helpers (pure array editors for the filter builder)', () => {
  const c = (col: string | null, op: string, val: string): FilterCondition => ({ col, op, val });

  it('blankCondition is an empty eq row', () => {
    expect(blankCondition()).toEqual({ col: null, op: 'eq', val: '' });
  });

  it('addCondition appends a blank row, capped at MAX_FILTER_CONDITIONS', () => {
    expect(addCondition([]).length).toBe(1);
    expect(addCondition([c('a', 'eq', '1')])).toEqual([c('a', 'eq', '1'), blankCondition()]);

    const full = Array.from({ length: MAX_FILTER_CONDITIONS }, () => blankCondition());
    expect(addCondition(full).length).toBe(MAX_FILTER_CONDITIONS); // no growth past the cap
  });

  it('removeCondition drops the row at the index (returns a new array)', () => {
    const arr = [c('a', 'eq', '1'), c('b', 'gt', '2'), c('c', 'lt', '3')];
    expect(removeCondition(arr, 1)).toEqual([c('a', 'eq', '1'), c('c', 'lt', '3')]);
    expect(arr.length).toBe(3); // original untouched
  });

  it('updateCondition patches only the target row', () => {
    const arr = [c('a', 'eq', '1'), c('b', 'eq', '2')];
    expect(updateCondition(arr, 0, { op: 'gt', val: '9' })).toEqual([c('a', 'gt', '9'), c('b', 'eq', '2')]);
    expect(updateCondition(arr, 1, { col: 'z' })).toEqual([c('a', 'eq', '1'), c('z', 'eq', '2')]);
  });

  it('activeConditions keeps only the ones that would filter, bounded', () => {
    expect(activeConditions([c(null, 'eq', 'x'), c('a', 'eq', ''), c('b', 'null', ''), c('d', 'gt', '5')])).toEqual([
      c('b', 'null', ''),
      c('d', 'gt', '5'),
    ]);
  });

  it('filterGroupIsActive is true iff at least one condition would filter', () => {
    expect(filterGroupIsActive([])).toBe(false);
    expect(filterGroupIsActive([c('a', 'eq', '')])).toBe(false);
    expect(filterGroupIsActive([c('a', 'eq', ''), c('b', 'notnull', '')])).toBe(true);
  });
});

describe('normalizeCombinator (raw → AND/OR, default AND)', () => {
  it('passes AND/OR (case-insensitive) and defaults everything else to AND', () => {
    for (const k of FILTER_COMBINATORS) {
      expect(normalizeCombinator(k)).toBe(k);
    }
    expect(normalizeCombinator('or')).toBe('OR');
    expect(normalizeCombinator('  And ')).toBe('AND');
    expect(normalizeCombinator('xor')).toBe('AND');
    expect(normalizeCombinator('')).toBe('AND');
    expect(normalizeCombinator(undefined)).toBe('AND');
  });
});

describe('normalizeViewMode (grid | gallery | kanban | chart | calendar, default grid)', () => {
  it('passes gallery + kanban + chart + calendar, defaults everything else to grid', () => {
    expect(normalizeViewMode('gallery')).toBe('gallery');
    expect(normalizeViewMode('kanban')).toBe('kanban');
    expect(normalizeViewMode('chart')).toBe('chart');
    expect(normalizeViewMode('calendar')).toBe('calendar');
    expect(normalizeViewMode('grid')).toBe('grid');
    expect(normalizeViewMode('timeline')).toBe('grid');
    expect(normalizeViewMode('')).toBe('grid');
    expect(normalizeViewMode(undefined)).toBe('grid');
    expect(normalizeViewMode(null)).toBe('grid');
  });
});

describe('calendarDateField (date column driving the calendar view)', () => {
  it('auto-detects the first column with an unambiguous ISO date value on the page', () => {
    const rows = [{ id: 1, created_at: '2024-01-01', name: 'x' }];
    expect(calendarDateField(['id', 'created_at', 'name'], rows)).toBe('created_at');
  });

  it('does NOT pick a numeric id column that merely looks date-ish', () => {
    const rows = [{ id: 20240101, label: 'x' }];
    expect(calendarDateField(['id', 'label'], rows)).toBeNull();
  });

  it('respects a configured field when it is a real column (owner pick wins)', () => {
    const rows = [{ id: 1, created_at: '2024-01-01', name: 'x' }];
    expect(calendarDateField(['id', 'created_at', 'name'], rows, 'name')).toBe('name');
  });

  it('falls back to auto-detect when the configured field is not a column', () => {
    const rows = [{ id: 1, created_at: '2024-01-01' }];
    expect(calendarDateField(['id', 'created_at'], rows, 'nope')).toBe('created_at');
  });

  it('returns null when no column qualifies and none is configured', () => {
    expect(calendarDateField(['id', 'name'], [{ id: 1, name: 'x' }])).toBeNull();
    expect(calendarDateField([], [])).toBeNull();
  });
});

describe('monthFromDayKey (seed the visible month from a data day-key)', () => {
  it('parses a YYYY-MM-DD day key into 0-based { year, month }', () => {
    expect(monthFromDayKey('2024-03-15')).toEqual({ year: 2024, month: 2 });
  });
  it('parses a YYYY-MM month key', () => {
    expect(monthFromDayKey('2024-12')).toEqual({ year: 2024, month: 11 });
  });
  it('returns null for a non-key / out-of-range month / non-string', () => {
    expect(monthFromDayKey('nope')).toBeNull();
    expect(monthFromDayKey('2024-13-01')).toBeNull();
    expect(monthFromDayKey(null)).toBeNull();
    expect(monthFromDayKey(undefined)).toBeNull();
  });
});

describe('addCalendarMonth (prev/next month nav with year rollover, UTC)', () => {
  it('steps back across a year boundary', () => {
    expect(addCalendarMonth(2024, 0, -1)).toEqual({ year: 2023, month: 11 });
  });
  it('steps forward across a year boundary', () => {
    expect(addCalendarMonth(2024, 11, 1)).toEqual({ year: 2025, month: 0 });
  });
  it('handles multi-month jumps', () => {
    expect(addCalendarMonth(2024, 5, 12)).toEqual({ year: 2025, month: 5 });
    expect(addCalendarMonth(2024, 5, -6)).toEqual({ year: 2023, month: 11 });
  });
});

describe('monthMatrix (42-cell Sunday-first UTC month grid)', () => {
  it('always returns exactly 42 cells (6 weeks × 7 days)', () => {
    expect(monthMatrix(2024, 0)).toHaveLength(42);
    expect(monthMatrix(2026, 1)).toHaveLength(42);
  });

  it('starts on the Sunday on/before the 1st and marks spill days', () => {
    const cells = monthMatrix(2024, 0); // Jan 2024 — the 1st is a Monday
    expect(cells[0]).toEqual({ dayKey: '2023-12-31', dayOfMonth: 31, inMonth: false });
    expect(cells[1]).toEqual({ dayKey: '2024-01-01', dayOfMonth: 1, inMonth: true });
  });

  it('contains every day of the requested month exactly once, all inMonth', () => {
    const cells = monthMatrix(2024, 1); // Feb 2024 — leap year, 29 days
    const inMonth = cells.filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[0].dayKey).toBe('2024-02-01');
    expect(inMonth[28].dayKey).toBe('2024-02-29');
  });

  it('day-keys are contiguous and match isoDayKey/bucketRowsByDate day format', () => {
    const cells = monthMatrix(2024, 0);
    expect(cells.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.dayKey))).toBe(true);
  });
});

describe('buildChartBars (whole-query group counts → bar-chart rows)', () => {
  it('computes label/count/value/pct (relative to the max) + total, preserving order [count metric]', () => {
    const { bars, total, max } = buildChartBars([
      { value: 'new', count: 200 },
      { value: 'done', count: 50 },
      { value: null, count: 10 },
    ]);
    expect(total).toBe(260);
    expect(max).toBe(200);
    expect(bars).toEqual([
      { label: 'new', count: 200, value: 200, pct: 100 },
      { label: 'done', count: 50, value: 50, pct: 25 },
      { label: '(empty)', count: 10, value: 10, pct: 5 }, // null → "(empty)"
    ]);
  });

  it('bars by the AGGREGATE when metric="aggregate" (value = agg, count still carried)', () => {
    const { bars, total, max } = buildChartBars(
      [
        { value: 'new', count: 3, aggregate: 900 },
        { value: 'done', count: 10, aggregate: 300 },
      ],
      'aggregate',
    );
    expect(total).toBe(1200); // sum of aggregates, not counts
    expect(max).toBe(900);
    expect(bars[0]).toEqual({ label: 'new', count: 3, value: 900, pct: 100 });
    expect(bars[1]).toEqual({ label: 'done', count: 10, value: 300, pct: 33 });
  });

  it('treats a null aggregate as 0 and clamps a negative agg bar to 0%', () => {
    const { bars } = buildChartBars(
      [
        { value: 'a', count: 1, aggregate: 100 },
        { value: 'b', count: 1, aggregate: null },
        { value: 'c', count: 1, aggregate: -50 },
      ],
      'aggregate',
    );
    expect(bars[1].value).toBe(0);
    expect(bars[2].pct).toBe(0); // negative magnitude never inverts the bar
  });

  it('handles an empty group set (no divide-by-zero)', () => {
    expect(buildChartBars([])).toEqual({ bars: [], total: 0, max: 0 });
  });

  it('coerces non-string group values to a display label', () => {
    expect(buildChartBars([{ value: 5, count: 1 }]).bars[0].label).toBe('5');
  });
});

describe('numericColumns (candidate chart measure columns from the page)', () => {
  it('keeps columns whose non-null page values are all numeric (number or numeric string)', () => {
    const rows = [
      { status: 'new', amount: '12.5', qty: 3 },
      { status: 'done', amount: '40', qty: 1 },
    ];
    expect(numericColumns(['status', 'amount', 'qty'], rows)).toEqual(['amount', 'qty']);
  });

  it('rejects a column with any non-numeric value, and an all-null/empty column', () => {
    const rows = [
      { a: '10', b: 'x', c: null },
      { a: '20', b: '5', c: null },
    ];
    expect(numericColumns(['a', 'b', 'c'], rows)).toEqual(['a']); // b has 'x'; c is all-null
  });

  it('excludes the group-by column (a measure grouped by itself is meaningless)', () => {
    const rows = [{ amount: 5 }, { amount: 9 }];
    expect(numericColumns(['amount'], rows, 'amount')).toEqual([]);
  });

  it('ignores null/empty cells when judging numericness', () => {
    const rows = [{ n: 5 }, { n: null }, { n: '' }, { n: '7' }];
    expect(numericColumns(['n'], rows)).toEqual(['n']);
  });
});

describe('kanbanGroupKey + groupPageRows (bucket page rows for a kanban board)', () => {
  it('kanbanGroupKey maps null/undefined to a sentinel distinct from the literal "null" string', () => {
    expect(kanbanGroupKey('new')).toBe('new');
    expect(kanbanGroupKey(5)).toBe('5');
    expect(kanbanGroupKey(null)).toBe(kanbanGroupKey(undefined)); // null + undefined share the sentinel
    expect(kanbanGroupKey('null')).not.toBe(kanbanGroupKey(null)); // sentinel ≠ the literal "null" string
    expect(kanbanGroupKey('')).not.toBe(kanbanGroupKey(null)); // sentinel ≠ empty string
  });

  it('groupPageRows buckets rows by field value (null grouped under the sentinel)', () => {
    const rows = [
      { id: 1, status: 'new' },
      { id: 2, status: 'new' },
      { id: 3, status: 'done' },
      { id: 4, status: null },
    ];
    const g = groupPageRows(rows, 'status');
    expect(g.get('new')).toHaveLength(2);
    expect(g.get('done')).toHaveLength(1);
    expect(g.get(kanbanGroupKey(null))).toHaveLength(1);
    expect(g.get('new')!.map((r) => r.id)).toEqual([1, 2]); // preserves order
  });
});

describe('galleryTitleField (card title column)', () => {
  it('prefers the first non-id column as a meaningful default title', () => {
    expect(galleryTitleField(['id', 'name', 'email'])).toBe('name');
    expect(galleryTitleField(['event_type', 'path'])).toBe('event_type');
  });

  it('skips *_id columns too when picking the default', () => {
    expect(galleryTitleField(['id', 'site_id', 'status'])).toBe('status');
  });

  it('honors a configured field when it is a real column', () => {
    expect(galleryTitleField(['id', 'name', 'email'], 'email')).toBe('email');
  });

  it('ignores a configured field that is not a column (falls back to the default)', () => {
    expect(galleryTitleField(['id', 'name'], 'bogus')).toBe('name');
  });

  it('falls back to the first column when everything looks like an id, and null when empty', () => {
    expect(galleryTitleField(['id'])).toBe('id');
    expect(galleryTitleField(['user_id', 'org_id'])).toBe('user_id');
    expect(galleryTitleField([])).toBeNull();
  });
});

describe('galleryBodyFields (card body = everything but the title)', () => {
  it('returns the non-title columns in order', () => {
    expect(galleryBodyFields(['id', 'name', 'email'], 'name')).toEqual(['id', 'email']);
  });

  it('returns all columns when the title is null', () => {
    expect(galleryBodyFields(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('recordTitle (record-drawer heading)', () => {
  it('uses the resolved title field value', () => {
    expect(recordTitle({ id: 1, name: 'Ada', email: 'a@x.com' }, ['id', 'name', 'email'])).toBe('Ada');
    expect(recordTitle({ id: 1, name: 'Ada', email: 'a@x.com' }, ['id', 'name', 'email'], 'email')).toBe('a@x.com');
  });

  it('coerces non-string values to a string', () => {
    expect(recordTitle({ id: 1, status: 5 }, ['id', 'status'])).toBe('5');
  });

  it('falls back to (untitled) for null/empty and (record) for no columns', () => {
    expect(recordTitle({ id: 1, name: null }, ['id', 'name'])).toBe('(untitled)');
    expect(recordTitle({ id: 1, name: '' }, ['id', 'name'])).toBe('(untitled)');
    expect(recordTitle({}, [])).toBe('(record)');
  });
});

describe('recordNavigation (drawer prev/next within the current page)', () => {
  const a = { id: 1 };
  const b = { id: 2 };
  const c = { id: 3 };

  it('locates the current row by identity and exposes both neighbors', () => {
    expect(recordNavigation([a, b, c], b)).toEqual({ index: 1, total: 3, prev: a, next: c });
  });

  it('has no prev at the first row, no next at the last row (never crosses the page boundary)', () => {
    expect(recordNavigation([a, b, c], a)).toEqual({ index: 0, total: 3, prev: null, next: b });
    expect(recordNavigation([a, b, c], c)).toEqual({ index: 2, total: 3, prev: b, next: null });
  });

  it('a single-row page has neither neighbor', () => {
    expect(recordNavigation([a], a)).toEqual({ index: 0, total: 1, prev: null, next: null });
  });

  it('returns index -1 with no neighbors when current is null or not on the page', () => {
    expect(recordNavigation([a, b, c], null)).toEqual({ index: -1, total: 3, prev: null, next: null });
    expect(recordNavigation([a, b, c], { id: 99 })).toEqual({ index: -1, total: 3, prev: null, next: null });
    expect(recordNavigation([], null)).toEqual({ index: -1, total: 0, prev: null, next: null });
  });

  it('matches by reference identity, not value equality (duplicate-looking rows are distinct)', () => {
    const d1 = { id: 1 };
    const d2 = { id: 1 }; // same shape, different object
    expect(recordNavigation([d1, d2], d2)).toEqual({ index: 1, total: 2, prev: d1, next: null });
  });
});

describe('viewQueryFingerprint (detect a saved view drifting from the live query)', () => {
  const base = {
    search: '',
    conditions: [] as Array<{ col: string | null; op: string; val: string }>,
    combinator: 'AND',
    sortCol: null as string | null,
    sortDir: null as string | null,
    type: 'grid',
    titleField: null as string | null,
    groupField: null as string | null,
  };

  it('is equal for two queries that fetch + render identically', () => {
    const a = viewQueryFingerprint({
      ...base,
      search: '  ada ',
      conditions: [{ col: 'status', op: 'eq', val: 'new' }],
    });
    const b = viewQueryFingerprint({ ...base, search: 'ada', conditions: [{ col: 'status', op: 'eq', val: 'new' }] });
    expect(a).toBe(b); // search trimmed; same active condition
  });

  it('ignores INACTIVE conditions + a blank value-op (they do not filter)', () => {
    const withNoise = viewQueryFingerprint({
      ...base,
      conditions: [
        { col: 'status', op: 'eq', val: 'new' },
        { col: null, op: 'eq', val: 'x' }, // no column → inactive
        { col: 'age', op: 'gt', val: '   ' }, // value-op, blank → inactive
      ],
    });
    const clean = viewQueryFingerprint({ ...base, conditions: [{ col: 'status', op: 'eq', val: 'new' }] });
    expect(withNoise).toBe(clean);
  });

  it('ignores combinator when <2 active conditions, but distinguishes AND vs OR with 2+', () => {
    const oneAnd = viewQueryFingerprint({ ...base, combinator: 'AND', conditions: [{ col: 'a', op: 'eq', val: '1' }] });
    const oneOr = viewQueryFingerprint({ ...base, combinator: 'OR', conditions: [{ col: 'a', op: 'eq', val: '1' }] });
    expect(oneAnd).toBe(oneOr); // combinator irrelevant with 1 condition

    const twoConds = [
      { col: 'a', op: 'eq', val: '1' },
      { col: 'b', op: 'eq', val: '2' },
    ];
    expect(viewQueryFingerprint({ ...base, combinator: 'AND', conditions: twoConds })).not.toBe(
      viewQueryFingerprint({ ...base, combinator: 'OR', conditions: twoConds }),
    );
  });

  it('detects drift in search / sort / type / gallery-title / kanban-group', () => {
    const ref = viewQueryFingerprint(base);
    expect(viewQueryFingerprint({ ...base, search: 'x' })).not.toBe(ref);
    expect(viewQueryFingerprint({ ...base, sortCol: 'created_at', sortDir: 'desc' })).not.toBe(ref);
    expect(viewQueryFingerprint({ ...base, type: 'gallery' })).not.toBe(ref);

    // gallery title only matters in gallery/kanban (not grid)
    expect(viewQueryFingerprint({ ...base, titleField: 'name' })).toBe(ref); // grid → title ignored
    expect(viewQueryFingerprint({ ...base, type: 'gallery', titleField: 'name' })).not.toBe(
      viewQueryFingerprint({ ...base, type: 'gallery' }),
    );

    // group only matters in kanban/chart
    expect(viewQueryFingerprint({ ...base, type: 'kanban', groupField: 'status' })).not.toBe(
      viewQueryFingerprint({ ...base, type: 'kanban' }),
    );
  });

  it('dateField only matters in the calendar view', () => {
    const ref = viewQueryFingerprint(base);

    // grid → dateField ignored (no false "modified")
    expect(viewQueryFingerprint({ ...base, dateField: 'created_at' })).toBe(ref);

    // calendar → changing the date column IS a drift
    expect(viewQueryFingerprint({ ...base, type: 'calendar', dateField: 'created_at' })).not.toBe(
      viewQueryFingerprint({ ...base, type: 'calendar' }),
    );
  });

  it('detects multi-sort drift (order + direction) — omitted sorts → null (single sortCol/sortDir only)', () => {
    const noSorts = viewQueryFingerprint(base);
    expect(viewQueryFingerprint({ ...base, sorts: undefined })).toBe(noSorts);

    const s1 = viewQueryFingerprint({ ...base, sorts: [{ col: 'a', dir: 'asc' }] });

    // adding a secondary sort, or flipping a direction, or reordering priority all change the fingerprint
    expect(
      viewQueryFingerprint({
        ...base,
        sorts: [
          { col: 'a', dir: 'asc' },
          { col: 'b', dir: 'desc' },
        ],
      }),
    ).not.toBe(s1);
    expect(viewQueryFingerprint({ ...base, sorts: [{ col: 'a', dir: 'desc' }] })).not.toBe(s1);
    expect(
      viewQueryFingerprint({
        ...base,
        sorts: [
          { col: 'b', dir: 'asc' },
          { col: 'a', dir: 'asc' },
        ],
      }),
    ).not.toBe(
      viewQueryFingerprint({
        ...base,
        sorts: [
          { col: 'a', dir: 'asc' },
          { col: 'b', dir: 'asc' },
        ],
      }),
    );
  });

  it('detects column-LAYOUT drift (hidden/order/widths/pins/summaries/density) — the previously-ignored badge gap', () => {
    const noLayout = viewQueryFingerprint(base); // callers that omit layout → unchanged from before (null)
    expect(viewQueryFingerprint({ ...base, layout: undefined })).toBe(noLayout);

    const bare = viewQueryFingerprint({ ...base, layout: { density: 'cozy' } });

    // each layout facet changing flips the fingerprint
    expect(viewQueryFingerprint({ ...base, layout: { density: 'compact' } })).not.toBe(bare);
    expect(viewQueryFingerprint({ ...base, layout: { density: 'cozy', hidden: ['x'] } })).not.toBe(bare);
    expect(viewQueryFingerprint({ ...base, layout: { density: 'cozy', order: ['b', 'a'] } })).not.toBe(bare);
    expect(viewQueryFingerprint({ ...base, layout: { density: 'cozy', pinned: ['id'] } })).not.toBe(bare);
    expect(viewQueryFingerprint({ ...base, layout: { density: 'cozy', widths: { a: 200 } } })).not.toBe(bare);
    expect(viewQueryFingerprint({ ...base, layout: { density: 'cozy', summaries: { a: 'sum' } } })).not.toBe(bare);
  });

  it('layout signature is map-key-order-insensitive but array-order-sensitive (no false / no missed drift)', () => {
    // widths/summaries maps: same entries, different key order → SAME fingerprint (no false "modified")
    const w1 = viewQueryFingerprint({ ...base, layout: { widths: { a: 100, b: 200 } } });
    const w2 = viewQueryFingerprint({ ...base, layout: { widths: { b: 200, a: 100 } } });
    expect(w1).toBe(w2);

    // order array: different order → DIFFERENT fingerprint (a real rearrangement)
    const o1 = viewQueryFingerprint({ ...base, layout: { order: ['a', 'b'] } });
    const o2 = viewQueryFingerprint({ ...base, layout: { order: ['b', 'a'] } });
    expect(o1).not.toBe(o2);

    // a sparse {density:'cozy'} equals an all-empty-normalized layout (the apply-baseline case)
    expect(viewQueryFingerprint({ ...base, layout: { density: 'cozy' } })).toBe(
      viewQueryFingerprint({ ...base, layout: { density: 'cozy', hidden: [], order: [], pinned: [] } }),
    );
  });
});

describe('layoutSignature (canonical column-layout signature)', () => {
  it('null/undefined → null; sparse layout normalizes empties + sorts map keys', () => {
    expect(layoutSignature(null)).toBeNull();
    expect(layoutSignature(undefined)).toBeNull();
    expect(layoutSignature({ density: 'cozy' })).toEqual({
      hidden: [],
      order: [],
      pinned: [],
      widths: [],
      summaries: [],
      density: 'cozy',
    });
    expect(layoutSignature({ widths: { b: 2, a: 1 } })).toEqual({
      hidden: [],
      order: [],
      pinned: [],
      widths: [
        ['a', 1],
        ['b', 2],
      ],
      summaries: [],
      density: 'cozy',
    });
  });
});

describe('normalizeFilterOp (raw op → known FilterOp, default eq)', () => {
  it('passes through every known operator', () => {
    for (const op of FILTER_OPS) {
      expect(normalizeFilterOp(op)).toBe(op);
    }
  });

  it('lowercases + trims and defaults unknown/blank/nullish to eq', () => {
    expect(normalizeFilterOp('  GTE ')).toBe('gte');
    expect(normalizeFilterOp('NotNull')).toBe('notnull');
    expect(normalizeFilterOp('bogus')).toBe('eq');
    expect(normalizeFilterOp('')).toBe('eq');
    expect(normalizeFilterOp(undefined)).toBe('eq');
    expect(normalizeFilterOp(null)).toBe('eq');
  });
});

describe('filterOpIsValueFree (null/notnull need no value)', () => {
  it('is true only for null + notnull', () => {
    expect(filterOpIsValueFree('null')).toBe(true);
    expect(filterOpIsValueFree('notnull')).toBe(true);
    expect(FILTER_VALUE_FREE_OPS.has('null')).toBe(true);

    for (const op of ['eq', 'ne', 'contains', 'startswith', 'endswith', 'gt', 'lt', 'gte', 'lte'] as const) {
      expect(filterOpIsValueFree(op)).toBe(false);
    }
  });
});

describe('filterIsActive (does this filter state actually filter?)', () => {
  it('needs a column', () => {
    expect(filterIsActive('', 'eq', 'x')).toBe(false);
    expect(filterIsActive(null, 'null', '')).toBe(false);
  });

  it('value-free ops are active on a column alone', () => {
    expect(filterIsActive('deleted_at', 'null', '')).toBe(true);
    expect(filterIsActive('deleted_at', 'notnull', '')).toBe(true);
  });

  it('value ops require a non-blank value', () => {
    expect(filterIsActive('status', 'eq', 'active')).toBe(true);
    expect(filterIsActive('status', 'eq', '   ')).toBe(false);
    expect(filterIsActive('age', 'gt', '18')).toBe(true);
    expect(filterIsActive('age', 'gt', '')).toBe(false);
  });
});

describe('FILTER_OP_OPTIONS (operator dropdown source)', () => {
  it('covers exactly the FILTER_OPS set, in order, each with a label', () => {
    expect(FILTER_OP_OPTIONS.map((o) => o.value)).toEqual([...FILTER_OPS]);

    for (const o of FILTER_OP_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
    }
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
  it('does NOT offer copy text for a BLOB (binary is not meaningfully text-copyable)', () => {
    expect(clipboardValue({ __blob: true, bytes: 4, hex: 'de ad be ef' })).toBe('');
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

describe('normalizeDensity + densityCellClass (grid row density)', () => {
  it('accepts compact/cozy/comfortable, defaults unknown → cozy', () => {
    expect(normalizeDensity('compact')).toBe('compact');
    expect(normalizeDensity('comfortable')).toBe('comfortable');
    expect(normalizeDensity('cozy')).toBe('cozy');
    expect(normalizeDensity('dense')).toBe('cozy');
    expect(normalizeDensity('')).toBe('cozy');
    expect(normalizeDensity(undefined)).toBe('cozy');
    expect(normalizeDensity(null)).toBe('cozy');
  });

  it('cozy reproduces the historical px-3 py-1.5; compact tightens; comfortable loosens', () => {
    expect(densityCellClass('cozy')).toBe('px-3 py-1.5');
    expect(densityCellClass('compact')).toBe('px-2 py-0.5');
    expect(densityCellClass('comfortable')).toBe('px-3 py-3');
  });

  it('the select-cell padding tracks the row density', () => {
    expect(densitySelectCellClass('cozy')).toBe('px-2 py-1.5');
    expect(densitySelectCellClass('compact')).toBe('px-2 py-0.5');
    expect(densitySelectCellClass('comfortable')).toBe('px-2 py-3');
  });

  it('every density is a real, distinct option (no accidental collision)', () => {
    expect(GRID_DENSITIES).toEqual(['compact', 'cozy', 'comfortable']);

    const classes = GRID_DENSITIES.map(densityCellClass);
    expect(new Set(classes).size).toBe(3);
  });
});

describe('clampColWidth + parseColWidths (column resize bounds + persisted-width parse)', () => {
  it('clamps to the min/max and rounds; non-finite → min', () => {
    expect(clampColWidth(200)).toBe(200);
    expect(clampColWidth(10)).toBe(MIN_COL_WIDTH);
    expect(clampColWidth(9999)).toBe(MAX_COL_WIDTH);
    expect(clampColWidth(120.7)).toBe(121);
    expect(clampColWidth(Number.NaN)).toBe(MIN_COL_WIDTH);
    expect(clampColWidth(Infinity)).toBe(MIN_COL_WIDTH); // non-finite guard → min
  });

  it('parseColWidths keeps positive finite widths (clamped), drops junk, non-object → {}', () => {
    expect(parseColWidths({ a: 200, b: '5', c: -3, d: 9000, e: 0, f: Number.NaN })).toEqual({
      a: 200,
      d: MAX_COL_WIDTH,
    });
    expect(parseColWidths(null)).toEqual({});
    expect(parseColWidths([1, 2])).toEqual({});
    expect(parseColWidths('x')).toEqual({});
    expect(parseColWidths({})).toEqual({});
  });
});

describe('column summaries (normalize + value + persist parse)', () => {
  const agg = { count: 5, numericCount: 3, sum: 60, avg: 20, min: 10, max: 30, nullCount: 2 };

  it('normalizeSummaryKind accepts the known kinds, else none', () => {
    for (const k of SUMMARY_KINDS) {
      expect(normalizeSummaryKind(k)).toBe(k);
    }
    expect(normalizeSummaryKind('median')).toBe('none');
    expect(normalizeSummaryKind('')).toBe('none');
    expect(normalizeSummaryKind(null)).toBe('none');
  });

  it('summaryLabel capitalizes (none → empty string)', () => {
    expect(summaryLabel('sum')).toBe('Sum');
    expect(summaryLabel('filled')).toBe('Filled');
    expect(summaryLabel('none')).toBe('');
  });

  it('summaryValue maps each kind against the aggregates', () => {
    expect(summaryValue('count', agg)).toBe(5);
    expect(summaryValue('filled', agg)).toBe(3); // count - nullCount
    expect(summaryValue('empty', agg)).toBe(2); // nullCount
    expect(summaryValue('sum', agg)).toBe(60);
    expect(summaryValue('avg', agg)).toBe(20);
    expect(summaryValue('min', agg)).toBe(10);
    expect(summaryValue('max', agg)).toBe(30);
    expect(summaryValue('none', agg)).toBeNull();
  });

  it('summaryValue returns null for numeric stats on a non-numeric column (honest "–", never fake 0)', () => {
    const textAgg = { count: 4, numericCount: 0, sum: null, avg: null, min: null, max: null, nullCount: 1 };
    expect(summaryValue('sum', textAgg)).toBeNull();
    expect(summaryValue('avg', textAgg)).toBeNull();
    expect(summaryValue('filled', textAgg)).toBe(3); // count/filled/empty still work on any column
    expect(summaryValue('count', textAgg)).toBe(4);
  });

  it('parseColSummaries keeps real kinds, drops none/junk, non-object → {}', () => {
    expect(parseColSummaries({ amount: 'sum', x: 'bogus', y: 'none', qty: 'avg' })).toEqual({
      amount: 'sum',
      qty: 'avg',
    });
    expect(parseColSummaries(null)).toEqual({});
    expect(parseColSummaries(['sum'])).toEqual({});
  });
});

describe('orderColumns (persisted column display order, schema-drift robust)', () => {
  it('applies the saved order, appending unordered columns in their original order', () => {
    expect(orderColumns(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });
  it('drops a stale order entry no longer in the table + appends new columns at the end', () => {
    expect(orderColumns(['a', 'b'], ['x', 'b'])).toEqual(['b', 'a']);
    expect(orderColumns(['a', 'b', 'new'], ['b', 'a'])).toEqual(['b', 'a', 'new']);
  });
  it('empty / full order → a permutation of all (never drops or dupes a live column)', () => {
    expect(orderColumns(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
    expect(orderColumns(['a', 'b', 'c'], ['a', 'a', 'b'])).toEqual(['a', 'b', 'c']); // dupe in order ignored
  });
});

describe('moveColumn (reorder one step, clamped, always a full order)', () => {
  it('moves a column left/right', () => {
    expect(moveColumn(['a', 'b', 'c'], [], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveColumn(['a', 'b', 'c'], [], 'b', 1)).toEqual(['a', 'c', 'b']);
  });
  it('clamps at both ends (no wrap)', () => {
    expect(moveColumn(['a', 'b', 'c'], [], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveColumn(['a', 'b', 'c'], [], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
  it('normalizes a partial/stale saved order first, and ignores an unknown column', () => {
    // saved order ['c'] → normalized ['c','a','b']; move 'a' left → ['a','c','b']
    expect(moveColumn(['a', 'b', 'c'], ['c'], 'a', -1)).toEqual(['a', 'c', 'b']);
    expect(moveColumn(['a', 'b', 'c'], [], 'zzz', -1)).toEqual(['a', 'b', 'c']);
  });
});

describe('applyPins (pinned columns to the front, stable)', () => {
  it('moves pinned columns to the front, preserving each partition’s order', () => {
    expect(applyPins(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['a', 'c', 'b', 'd']); // front keeps a-before-c
    expect(applyPins(['a', 'b', 'c'], ['b'])).toEqual(['b', 'a', 'c']);
  });
  it('no pins → unchanged; all pinned → unchanged order; unknown pin ignored', () => {
    expect(applyPins(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
    expect(applyPins(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(applyPins(['a', 'b'], ['zzz'])).toEqual(['a', 'b']);
  });
  it('accepts a Set as well as an array', () => {
    expect(applyPins(['a', 'b', 'c'], new Set(['c']))).toEqual(['c', 'a', 'b']);
  });
});

describe('pinnedLeftOffsets (cumulative sticky-left px for the pinned prefix)', () => {
  it('offsets the pinned prefix cumulatively from leadOffset, using widths else the default', () => {
    // a pinned (w 100) → 32; b pinned (default 160) → 132; c unpinned → omitted
    expect(pinnedLeftOffsets(['a', 'b', 'c'], ['a', 'b'], { a: 100 }, 32, 160)).toEqual({ a: 32, b: 132 });
  });
  it('stops at the first unpinned column (only the leading frozen prefix gets offsets)', () => {
    expect(pinnedLeftOffsets(['a', 'b', 'c'], ['a', 'c'], {}, 0, 150)).toEqual({ a: 0 }); // b unpinned → stop
  });
  it('no pins → {}', () => {
    expect(pinnedLeftOffsets(['a', 'b'], [], {}, 32, 160)).toEqual({});
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

  it('date validates YYYY-MM-DD and binds the string (SQLite has no date type — TEXT)', () => {
    expect(coerceCellInput('date', '2024-01-31')).toBe('2024-01-31');
    expect(coerceCellInput('date', '  2024-01-31  ')).toBe('2024-01-31'); // trimmed
    expect(() => coerceCellInput('date', '')).toThrow(RowMutationError); // blank → prompt NULL
    expect(() => coerceCellInput('date', '01/31/2024')).toThrow(RowMutationError); // wrong shape
    expect(() => coerceCellInput('date', '2024-01-31T12:00')).toThrow(RowMutationError); // has time
  });

  it('datetime validates a zone-less YYYY-MM-DDTHH:MM(:SS) and binds the string (TEXT)', () => {
    expect(coerceCellInput('datetime', '2024-01-31T12:30')).toBe('2024-01-31T12:30');
    expect(coerceCellInput('datetime', '2024-01-31T12:30:45')).toBe('2024-01-31T12:30:45'); // seconds ok
    expect(coerceCellInput('datetime', '2024-01-31 12:30')).toBe('2024-01-31 12:30'); // space ok
    expect(() => coerceCellInput('datetime', '')).toThrow(RowMutationError); // blank → prompt NULL
    expect(() => coerceCellInput('datetime', '2024-01-31')).toThrow(RowMutationError); // date only
  });
});

describe('toDateInputValue / toDatetimeLocalValue (stored value → native input format, lossless)', () => {
  it('toDateInputValue returns a bare YYYY-MM-DD, else "" (never truncates a datetime)', () => {
    expect(toDateInputValue('2024-01-31')).toBe('2024-01-31');
    expect(toDateInputValue('  2024-01-31 ')).toBe('2024-01-31');
    expect(toDateInputValue('2024-01-31T12:00:00Z')).toBe(''); // has a time → no silent truncation
    expect(toDateInputValue('2024-13-45')).toBe(''); // shape ok but impossible date
    expect(toDateInputValue('not a date')).toBe('');
  });

  it('toDatetimeLocalValue normalizes a zone-LESS datetime to T-separated; rejects zone-marked', () => {
    expect(toDatetimeLocalValue('2024-01-31 12:30:00')).toBe('2024-01-31T12:30:00');
    expect(toDatetimeLocalValue('2024-01-31T12:30')).toBe('2024-01-31T12:30');
    expect(toDatetimeLocalValue('2024-01-31T12:30:00Z')).toBe(''); // zone-marked → don't drop the zone
    expect(toDatetimeLocalValue('2024-01-31T12:30:00-05:00')).toBe(''); // offset → text fallback
    expect(toDatetimeLocalValue('2024-01-31')).toBe(''); // date only
  });
});

describe('isValidJsonText (live JSON-editor validity; mirrors coerceCellInput json accept-set)', () => {
  it('accepts any valid JSON (object/array/string/number/bool/null)', () => {
    expect(isValidJsonText('{"a":1}')).toBe(true);
    expect(isValidJsonText('[1,2,3]')).toBe(true);
    expect(isValidJsonText('  "hi"  ')).toBe(true); // trims first
    expect(isValidJsonText('42')).toBe(true);
    expect(isValidJsonText('true')).toBe(true);
    expect(isValidJsonText('null')).toBe(true);
  });

  it('rejects malformed JSON and blank (blank = "not filled yet", hint stays hidden)', () => {
    expect(isValidJsonText('{a:1}')).toBe(false);
    expect(isValidJsonText('{"a":}')).toBe(false);
    expect(isValidJsonText('')).toBe(false);
    expect(isValidJsonText('   ')).toBe(false);
  });

  it('agrees with coerceCellInput: a string is valid here iff json-coerce does not throw', () => {
    for (const s of ['{"x":1}', '[1]', '"s"', '7', 'bad', '{']) {
      const coerceOk = (() => {
        try {
          coerceCellInput('json', s);

          return true;
        } catch {
          return false;
        }
      })();
      expect(isValidJsonText(s)).toBe(coerceOk);
    }
  });
});

describe('distinctSuggestions (value-datalist suggestions; high-cardinality → none)', () => {
  it('returns a copy of a small distinct set (select-like column)', () => {
    const values = ['open', 'closed', 'pending'];
    const out = distinctSuggestions(values, false);
    expect(out).toEqual(['open', 'closed', 'pending']);
    expect(out).not.toBe(values); // a copy, not the same ref
  });

  it('returns none when truncated (high-cardinality = free-text column, not a select)', () => {
    expect(distinctSuggestions(['a', 'b', 'c'], true)).toEqual([]);
  });

  it('returns none for an empty/absent set', () => {
    expect(distinctSuggestions([], false)).toEqual([]);
    expect(distinctSuggestions(undefined, false)).toEqual([]);
  });
});

describe('nullabilityHint (resolves the NULL vs empty-string "" ambiguity of a blank text field)', () => {
  it('null kind → a NULL hint', () => {
    expect(nullabilityHint('null', '')).toBe('Saves as NULL (no value).');
    expect(nullabilityHint('null', 'ignored')).toBe('Saves as NULL (no value).');
  });

  it('blank text kind → an empty-string hint that points at NULL', () => {
    expect(nullabilityHint('text', '')).toBe('Saves as an empty string (""). Use NULL for no value.');
  });

  it('no hint when the value is unambiguous (non-blank text, or a non-text/null kind)', () => {
    expect(nullabilityHint('text', 'hello')).toBe('');
    expect(nullabilityHint('number', '')).toBe('');
    expect(nullabilityHint('boolean', '')).toBe('');
    expect(nullabilityHint('date', '')).toBe('');
    expect(nullabilityHint('json', '')).toBe('');
  });
});

describe('describeIntent (human summary of the AI query intent — falsifiable, display-only)', () => {
  it('summarizes an aggregate + groupBy', () => {
    expect(describeIntent({ select: [{ agg: 'count' }], groupBy: 'status' })).toBe('count · grouped by status');
  });

  it('summarizes an aggregate over a column', () => {
    expect(describeIntent({ select: [{ agg: 'sum', col: 'amount' }] })).toBe('sum(amount)');
  });

  it('summarizes a projection with a filter group', () => {
    expect(
      describeIntent({
        select: [{ col: 'status' }, { col: 'created_at' }],
        filters: [{ col: 'status', op: 'eq', val: 'open' }],
      }),
    ).toBe('status, created_at · where status eq open');
  });

  it('joins multiple filters by the combinator + appends sort + limit', () => {
    expect(
      describeIntent({
        select: [{ col: 'status' }],
        filters: [
          { col: 'status', op: 'eq', val: 'open' },
          { col: 'created_at', op: 'gt', val: '2026' },
        ],
        combinator: 'OR',
        orderBy: [{ col: 'created_at', dir: 'desc' }],
        limit: 25,
      }),
    ).toBe('status · where status eq open OR created_at gt 2026 · sorted by created_at desc · limit 25');
  });

  it('falls back to "rows" for an empty/odd select', () => {
    expect(describeIntent({ select: [] })).toBe('rows');
    expect(describeIntent({})).toBe('rows');
  });
});

describe('askIntentToSavedView (Ask answer → reusable saved-view payload; reuses the grid-views store)', () => {
  it('aggregate + groupBy → a CHART view grouped by that column', () => {
    expect(askIntentToSavedView({ select: [{ agg: 'count' }], groupBy: 'status' }, 'count by status')).toEqual({
      name: 'count by status',
      viewType: 'chart',
      filters: '[]',
      combinator: 'AND',
      sortCol: null,
      sortDir: null,
      viewConfig: { groupField: 'status' },
    });
  });

  it('projection + filter → a GRID view carrying the filters (as a JSON string) + combinator', () => {
    const out = askIntentToSavedView(
      {
        select: [{ col: 'status' }],
        filters: [{ col: 'status', op: 'eq', val: 'open' }],
        combinator: 'OR',
      },
      'open ones',
    );
    expect(out.viewType).toBe('grid');
    expect(out.combinator).toBe('OR');
    expect(JSON.parse(out.filters)).toEqual([{ col: 'status', op: 'eq', val: 'open' }]);
  });

  it('carries the sort — primary in sortCol/Dir, the full multi-sort in config.sorts', () => {
    const out = askIntentToSavedView(
      {
        select: [{ col: 'status' }],
        orderBy: [
          { col: 'created_at', dir: 'desc' },
          { col: 'status', dir: 'asc' },
        ],
      },
      'newest',
    );
    expect(out.sortCol).toBe('created_at');
    expect(out.sortDir).toBe('desc');
    expect(out.viewConfig.sorts).toBe('created_at:desc,status:asc');
  });

  it('defaults the name + AND combinator; blank question → "Saved question"', () => {
    const out = askIntentToSavedView({ select: [{ col: 'status' }] }, '   ');
    expect(out.name).toBe('Saved question');
    expect(out.combinator).toBe('AND');
    expect(out.filters).toBe('[]');
    expect(out.sortCol).toBeNull();
  });
});

describe('distinctCacheKey (per-(table,col) memo key; no cross-table/column collisions)', () => {
  it('is stable + unique per (table, column)', () => {
    expect(distinctCacheKey('form_submissions', 'status')).toBe('form_submissions\nstatus');
    expect(distinctCacheKey('a', 'b')).toBe(distinctCacheKey('a', 'b')); // stable
  });

  it('does not collide when the same column name lives in two tables', () => {
    expect(distinctCacheKey('orders', 'status')).not.toBe(distinctCacheKey('leads', 'status'));
  });

  it('separator makes ("ab","c") distinct from ("a","bc")', () => {
    expect(distinctCacheKey('ab', 'c')).not.toBe(distinctCacheKey('a', 'bc'));
  });
});

describe('CELL_INPUT_KIND_OPTIONS (single source for both type <select>s)', () => {
  it('lists every editable kind (text/number/boolean/date/datetime/null/json) without "default"', () => {
    const values = CELL_INPUT_KIND_OPTIONS.map((o) => o.value);
    expect(values).toEqual(['text', 'number', 'boolean', 'date', 'datetime', 'null', 'json']);

    // 'default' (omit → column default) is an Add-row-only concern, never in the shared list.
    expect(values).not.toContain('default');
  });

  it('every kind option round-trips through coerceCellInput or is a UI-only kind', () => {
    // Each shared kind is a real CellInputKind that coerceCellInput handles.
    expect(() => coerceCellInput('null', '')).not.toThrow();
    expect(() => coerceCellInput('text', 'x')).not.toThrow();
  });
});

describe('editorKindForColumn (declared-type-first editor prefill; honest lossless fallbacks)', () => {
  it('opens the typed affordance for a NULL cell of a known typed column (NULL stays selectable)', () => {
    expect(editorKindForColumn('DATE', null)).toEqual({ kind: 'date', value: '' });
    expect(editorKindForColumn('DATETIME', null)).toEqual({ kind: 'datetime', value: '' });
    expect(editorKindForColumn('INTEGER', null)).toEqual({ kind: 'number', value: '' });
    expect(editorKindForColumn('BOOLEAN', undefined)).toEqual({ kind: 'boolean', value: '' });
  });

  it('keeps the honest NULL editor for a NULL cell of a TEXT/unknown column', () => {
    expect(editorKindForColumn('TEXT', null)).toEqual({ kind: 'null', value: '' });
    expect(editorKindForColumn(undefined, null)).toEqual({ kind: 'null', value: '' });
    expect(editorKindForColumn('VARCHAR(255)', null)).toEqual({ kind: 'null', value: '' });
  });

  it('maps SQLite affinity: INT/REAL/NUMERIC families → number', () => {
    expect(editorKindForColumn('INTEGER', 42)).toEqual({ kind: 'number', value: '42' });
    expect(editorKindForColumn('BIGINT', '7')).toEqual({ kind: 'number', value: '7' });
    expect(editorKindForColumn('REAL', 3.5)).toEqual({ kind: 'number', value: '3.5' });
    expect(editorKindForColumn('DECIMAL(10,2)', '9.99')).toEqual({ kind: 'number', value: '9.99' });
  });

  it('DATETIME/TIMESTAMP win over the DATE substring; a bare DATE → date', () => {
    expect(editorKindForColumn('DATETIME', '2024-01-01 09:00:00')).toEqual({
      kind: 'datetime',
      value: '2024-01-01T09:00:00',
    });
    expect(editorKindForColumn('TIMESTAMP', '2024-01-01 09:00')).toEqual({
      kind: 'datetime',
      value: '2024-01-01T09:00',
    });
    expect(editorKindForColumn('DATE', '2024-01-01')).toEqual({ kind: 'date', value: '2024-01-01' });
  });

  it('falls back to a plain text editor rather than LOSING data (zone-marked datetime, non-numeric)', () => {
    // A zone-marked datetime in a DATETIME column can't be represented in datetime-local → text (no zone drop).
    expect(editorKindForColumn('DATETIME', '2024-01-01T09:00:00Z')).toEqual({
      kind: 'text',
      value: '2024-01-01T09:00:00Z',
    });

    // A non-numeric value in a numeric column → value-inferred (never a broken number input).
    expect(editorKindForColumn('INTEGER', 'N/A')).toEqual({ kind: 'text', value: 'N/A' });

    // A DATE column holding a full datetime → text (don't truncate the time on the next save).
    expect(editorKindForColumn('DATE', '2024-01-01 09:00:00')).toEqual({
      kind: 'text',
      value: '2024-01-01 09:00:00',
    });
  });

  it('BOOLEAN maps 1/0/true/false; JSON maps parseable text; both fall back honestly', () => {
    expect(editorKindForColumn('BOOLEAN', 1)).toEqual({ kind: 'boolean', value: 'true' });
    expect(editorKindForColumn('BOOL', '0')).toEqual({ kind: 'boolean', value: 'false' });
    expect(editorKindForColumn('JSON', '{"a":1}')).toEqual({ kind: 'json', value: '{"a":1}' });
    expect(editorKindForColumn('JSON', 'not json')).toEqual({ kind: 'text', value: 'not json' }); // unparseable → text
  });

  it('a TEXT/unknown column with a value behaves exactly like inferCellEditor', () => {
    expect(editorKindForColumn('TEXT', 'hello')).toEqual(inferCellEditor('hello'));
    expect(editorKindForColumn(undefined, 'hello')).toEqual(inferCellEditor('hello'));
    expect(editorKindForColumn('CLOB', 12)).toEqual(inferCellEditor(12));
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

describe('planCreateTable (guided New-table form → reviewable CREATE TABLE DDL)', () => {
  it('builds a single-column table', () => {
    const r = planCreateTable('widgets', [{ name: 'label', type: 'TEXT' }]);
    expect(r.error).toBeNull();
    expect(r.ddl).toBe('CREATE TABLE "widgets" (\n  "label" TEXT\n)');
  });

  it('emits an inline PRIMARY KEY + NOT NULL + typed columns', () => {
    const r = planCreateTable('users', [
      { name: 'id', type: 'INTEGER', pk: true },
      { name: 'email', type: 'TEXT', notNull: true },
      { name: 'score', type: 'REAL', defaultValue: '0' },
    ]);
    expect(r.error).toBeNull();
    expect(r.warning).toBeNull(); // a PK was chosen
    expect(r.ddl).toBe(
      'CREATE TABLE "users" (\n  "id" INTEGER PRIMARY KEY,\n  "email" TEXT NOT NULL,\n  "score" REAL DEFAULT 0\n)',
    );
  });

  it('emits a composite PRIMARY KEY when more than one column is a PK', () => {
    const r = planCreateTable('memberships', [
      { name: 'user_id', type: 'INTEGER', pk: true },
      { name: 'org_id', type: 'INTEGER', pk: true },
    ]);
    expect(r.ddl).toContain('PRIMARY KEY ("user_id", "org_id")');
    expect(r.ddl).not.toContain('INTEGER PRIMARY KEY'); // composite is table-level, not inline
  });

  it('warns (non-fatal) when no primary key is selected', () => {
    const r = planCreateTable('logs', [{ name: 'message', type: 'TEXT' }]);
    expect(r.error).toBeNull();
    expect(r.ddl).not.toBeNull();
    expect(r.warning).toMatch(/no primary key/i);
  });

  it('drops blank placeholder column rows before compiling', () => {
    const r = planCreateTable('t', [
      { name: 'a', type: 'TEXT' },
      { name: '   ', type: 'INTEGER' },
      { name: '', type: 'REAL' },
    ]);
    expect(r.error).toBeNull();
    expect(r.ddl).toBe('CREATE TABLE "t" (\n  "a" TEXT\n)');
  });

  it('rejects an empty table name', () => {
    expect(planCreateTable('   ', [{ name: 'a', type: 'TEXT' }])).toEqual({
      ddl: null,
      error: 'Enter a table name.',
      warning: null,
    });
  });

  it('rejects when every column row is blank', () => {
    const r = planCreateTable('t', [{ name: '', type: 'TEXT' }]);
    expect(r.ddl).toBeNull();
    expect(r.error).toMatch(/at least one named column/i);
  });

  it('surfaces the DDL builder error for a duplicate column name (never throws)', () => {
    const r = planCreateTable('t', [
      { name: 'a', type: 'TEXT' },
      { name: 'A', type: 'INTEGER' }, // case-insensitive dup
    ]);
    expect(r.ddl).toBeNull();
    expect(r.error).toMatch(/duplicate column/i);
  });

  it('surfaces the DDL builder error for an illegal identifier (injection-shaped name)', () => {
    const r = planCreateTable('t', [{ name: 'a"); DROP TABLE users;--', type: 'TEXT' }]);
    expect(r.ddl).toBeNull();
    expect(r.error).toMatch(/not allowed in a SQLite identifier/i);
  });

  it('quotes an identifier that needs escaping rather than rejecting the whole build', () => {
    // A leading-underscore name is legal; the builder quotes it. (Injection chars are rejected above.)
    const r = planCreateTable('_private', [{ name: '_id', type: 'INTEGER', pk: true }]);
    expect(r.error).toBeNull();
    expect(r.ddl).toBe('CREATE TABLE "_private" (\n  "_id" INTEGER PRIMARY KEY\n)');
  });
});

describe('suggestIndexName (conventional default index name)', () => {
  it('builds idx_<table>_<cols>', () => {
    expect(suggestIndexName('orders', ['user_id', 'created_at'])).toBe('idx_orders_user_id_created_at');
  });

  it('sanitises non-identifier characters to underscores', () => {
    expect(suggestIndexName('my table', ['a-b'])).toBe('idx_my_table_a_b');
  });

  it('always starts with a letter/underscore (legal bare identifier)', () => {
    expect(suggestIndexName('123', ['9'])).toMatch(/^[A-Za-z_]/);
  });

  it('caps the length', () => {
    expect(suggestIndexName('t', ['x'.repeat(200)]).length).toBeLessThanOrEqual(60);
  });
});

describe('planCreateIndex (guided Add-index form → reviewable CREATE INDEX DDL)', () => {
  it('builds a single-column index (name auto-derived when blank)', () => {
    const r = planCreateIndex('users', '', ['email'], false);
    expect(r.error).toBeNull();
    expect(r.ddl).toBe('CREATE INDEX "idx_users_email" ON "users" ("email")');
  });

  it('honours an explicit index name', () => {
    const r = planCreateIndex('users', 'ix_email', ['email'], false);
    expect(r.ddl).toBe('CREATE INDEX "ix_email" ON "users" ("email")');
  });

  it('builds a composite UNIQUE index', () => {
    const r = planCreateIndex('memberships', 'uq_user_org', ['user_id', 'org_id'], true);
    expect(r.ddl).toBe('CREATE UNIQUE INDEX "uq_user_org" ON "memberships" ("user_id", "org_id")');
  });

  it('drops blank column entries before compiling', () => {
    const r = planCreateIndex('t', 'ix', ['a', '  ', ''], false);
    expect(r.ddl).toBe('CREATE INDEX "ix" ON "t" ("a")');
  });

  it('rejects when no table is selected', () => {
    expect(planCreateIndex('', 'ix', ['a'], false)).toEqual({ ddl: null, error: 'No table selected.' });
  });

  it('rejects when no columns are selected', () => {
    const r = planCreateIndex('t', 'ix', ['   '], false);
    expect(r.ddl).toBeNull();
    expect(r.error).toMatch(/at least one column/i);
  });

  it('surfaces the DDL builder error for an injection-shaped column name (never throws)', () => {
    const r = planCreateIndex('t', 'ix', ['a"); DROP TABLE users;--'], false);
    expect(r.ddl).toBeNull();
    expect(r.error).toMatch(/not allowed in a SQLite identifier/i);
  });
});

describe('summarizeIndexRow (sqlite_master index row → display summary)', () => {
  it('marks a user CREATE INDEX droppable, parses columns', () => {
    expect(
      summarizeIndexRow({ name: 'idx_o_uc', sql: 'CREATE INDEX "idx_o_uc" ON "orders" ("user_id", "created_at")' }),
    ).toEqual({
      name: 'idx_o_uc',
      unique: false,
      droppable: true,
      columns: 'user_id, created_at',
    });
  });

  it('detects UNIQUE', () => {
    const s = summarizeIndexRow({ name: 'uq', sql: 'CREATE UNIQUE INDEX "uq" ON "t" ("email")' });
    expect(s.unique).toBe(true);
    expect(s.droppable).toBe(true);
    expect(s.columns).toBe('email');
  });

  it('a constraint-backing auto-index (null sql) is NOT droppable', () => {
    expect(summarizeIndexRow({ name: 'sqlite_autoindex_t_1', sql: null })).toEqual({
      name: 'sqlite_autoindex_t_1',
      unique: false,
      droppable: false,
      columns: null,
    });
  });

  it('is defensive about odd shapes', () => {
    const s = summarizeIndexRow({ name: 123, sql: undefined });
    expect(s.name).toBe('123');
    expect(s.droppable).toBe(false);
    expect(s.columns).toBeNull();
  });
});

describe('planDropIndex (existing index → DROP INDEX DDL)', () => {
  it('builds a DROP INDEX by name', () => {
    expect(planDropIndex('idx_users_email')).toEqual({ ddl: 'DROP INDEX "idx_users_email"', error: null });
  });

  it('quotes/escapes a real object name rather than rejecting it', () => {
    expect(planDropIndex('weird"name').ddl).toBe('DROP INDEX "weird""name"');
  });

  it('surfaces a human error for a blank name (never throws)', () => {
    const r = planDropIndex('   ');
    expect(r.ddl).toBeNull();
    expect(r.error).toMatch(/must not be empty/i);
  });
});
