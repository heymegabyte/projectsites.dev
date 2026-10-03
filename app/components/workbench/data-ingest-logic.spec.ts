/**
 * @file Unit tests for the pure data-ingest logic (CSV/JSON import + AI-seed + form-builder plans).
 *
 * @remarks
 * Pure-function tests (no React, no bridge, no fetch) — the SAFETY proof for FIRE 6. The load-bearing assertions:
 * values are BOUND as `?` params (never concatenated), a hostile value rides as an inert param, empty cells →
 * SQL NULL, identifiers are validated + quoted, and big files chunk under the D1 bound-param cap.
 */
import { describe, it, expect } from 'vitest';

import {
  AI_SEED_MAX_ROWS,
  buildCreateTableForImport,
  buildFormPlan,
  buildInsertPlan,
  buildSeedSystemPrompt,
  clampSeedRowCount,
  coerceValue,
  dedupeColumnNames,
  detectColumnType,
  extractSeedRows,
  inferMappings,
  IngestError,
  isSafeIdent,
  MAX_BOUND_PARAMS,
  parseCsv,
  parseJsonRows,
  seedColumnsToMappings,
  slugifyColumnName,
  storageForFieldKind,
  type ColumnMapping,
  type SeedColumn,
} from './data-ingest-logic';

// ── Identifier safety ────────────────────────────────────────────────────────

describe('isSafeIdent', () => {
  it('accepts well-formed identifiers', () => {
    expect(isSafeIdent('users')).toBe(true);
    expect(isSafeIdent('first_name')).toBe(true);
    expect(isSafeIdent('_hidden')).toBe(true);
    expect(isSafeIdent('col$1')).toBe(true);
  });

  it('rejects hostile / malformed identifiers', () => {
    expect(isSafeIdent('')).toBe(false);
    expect(isSafeIdent('1col')).toBe(false); // leading digit
    expect(isSafeIdent('drop table')).toBe(false); // space
    expect(isSafeIdent('a";DROP--')).toBe(false); // punctuation
    expect(isSafeIdent(null)).toBe(false);
    expect(isSafeIdent('x'.repeat(65))).toBe(false); // too long
  });
});

describe('slugifyColumnName', () => {
  it('lower-cases + underscores non-alnum', () => {
    expect(slugifyColumnName('First Name')).toBe('first_name');
    expect(slugifyColumnName('e-mail!')).toBe('e_mail');
    expect(slugifyColumnName('  Spaced  ')).toBe('spaced');
  });

  it('prefixes a leading digit + falls back for empties', () => {
    expect(slugifyColumnName('2024 total')).toBe('col_2024_total');
    expect(slugifyColumnName('')).toBe('column');
    expect(slugifyColumnName('!!!')).toBe('column');
  });

  it('always yields a safe identifier', () => {
    for (const h of ['First Name', '2024', '', 'a.b.c', '💥', 'DROP; --']) {
      expect(isSafeIdent(slugifyColumnName(h))).toBe(true);
    }
  });
});

describe('dedupeColumnNames', () => {
  it('appends _2, _3 to case-insensitive collisions, preserving order + input casing', () => {
    // Collisions are detected case-insensitively; the suffix is added to the string as received.
    // (Real callers pass slugified lower-case names, so casing is uniform in practice.)
    expect(dedupeColumnNames(['name', 'name', 'Name', 'email'])).toEqual(['name', 'name_2', 'Name_3', 'email']);
  });

  it('de-dupes uniform lower-case names (the real caller path)', () => {
    expect(dedupeColumnNames(['name', 'name', 'name', 'email'])).toEqual(['name', 'name_2', 'name_3', 'email']);
  });
});

// ── CSV parsing ──────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const grid = parseCsv('name,age\nAlice,30\nBob,25');
    expect(grid.headers).toEqual(['name', 'age']);
    expect(grid.rows).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  it('handles quoted fields with embedded commas, newlines, and escaped quotes', () => {
    const csv = 'name,note\n"Smith, John","line1\nline2"\n"She said ""hi""",ok';
    const grid = parseCsv(csv);
    expect(grid.headers).toEqual(['name', 'note']);
    expect(grid.rows[0]).toEqual(['Smith, John', 'line1\nline2']);
    expect(grid.rows[1]).toEqual(['She said "hi"', 'ok']);
  });

  it('handles CRLF line endings + a trailing newline (no phantom row)', () => {
    const grid = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(grid.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('normalizes ragged rows to the header width', () => {
    const grid = parseCsv('a,b,c\n1,2\n1,2,3,4');
    expect(grid.rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3'],
    ]);
  });

  it('supports headerless mode with synthetic column names', () => {
    const grid = parseCsv('1,2,3\n4,5,6', { hasHeader: false });
    expect(grid.headers).toEqual(['column_1', 'column_2', 'column_3']);
    expect(grid.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('supports a tab delimiter (TSV)', () => {
    const grid = parseCsv('a\tb\n1\t2', { delimiter: '\t' });
    expect(grid.headers).toEqual(['a', 'b']);
    expect(grid.rows).toEqual([['1', '2']]);
  });

  it('returns empty for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});

// ── JSON parsing ─────────────────────────────────────────────────────────────

describe('parseJsonRows', () => {
  it('parses an array of flat objects, unioning keys in first-seen order', () => {
    const grid = parseJsonRows('[{"name":"A","age":1},{"age":2,"city":"NYC"}]');
    expect(grid.headers).toEqual(['name', 'age', 'city']);
    expect(grid.rows).toEqual([
      ['A', '1', ''],
      ['', '2', 'NYC'],
    ]);
  });

  it('treats a single object as a one-row array', () => {
    const grid = parseJsonRows('{"x":1,"y":"z"}');
    expect(grid.headers).toEqual(['x', 'y']);
    expect(grid.rows).toEqual([['1', 'z']]);
  });

  it('JSON-stringifies nested values in a cell', () => {
    const grid = parseJsonRows('[{"tags":["a","b"],"meta":{"k":1}}]');
    expect(grid.rows[0]).toEqual(['["a","b"]', '{"k":1}']);
  });

  it('throws typed IngestError on invalid JSON', () => {
    expect(() => parseJsonRows('{not json')).toThrow(IngestError);
    try {
      parseJsonRows('nope');
    } catch (e) {
      expect((e as IngestError).code).toBe('invalid_json');
    }
  });

  it('throws when items are not objects', () => {
    try {
      parseJsonRows('[1,2,3]');
    } catch (e) {
      expect((e as IngestError).code).toBe('not_a_record_array');
    }
  });

  it('returns empty for an empty array', () => {
    expect(parseJsonRows('[]')).toEqual({ headers: [], rows: [] });
  });
});

// ── Type detection + coercion ──────────────────────────────────────────────────

describe('detectColumnType', () => {
  it('detects INTEGER when every non-blank value is a strict integer', () => {
    expect(detectColumnType(['1', '2', '', '-3', '+4'])).toBe('INTEGER');
  });

  it('detects REAL when values are numeric but not all integer', () => {
    expect(detectColumnType(['1', '2.5', '3'])).toBe('REAL');
    expect(detectColumnType(['.5', '1e3'])).toBe('REAL');
  });

  it('falls back to TEXT for any non-numeric value', () => {
    expect(detectColumnType(['1', 'two', '3'])).toBe('TEXT');
    expect(detectColumnType(['2024-01-01'])).toBe('TEXT');
  });

  it('treats an all-blank column as TEXT', () => {
    expect(detectColumnType(['', '  ', ''])).toBe('TEXT');
  });
});

describe('coerceValue', () => {
  it('coerces an empty cell to null (real SQL NULL, not empty string)', () => {
    expect(coerceValue('', 'TEXT')).toBeNull();
    expect(coerceValue('   ', 'INTEGER')).toBeNull();
  });

  it('coerces INTEGER/REAL strings to numbers', () => {
    expect(coerceValue('42', 'INTEGER')).toBe(42);
    expect(coerceValue('3.14', 'REAL')).toBe(3.14);
  });

  it('keeps TEXT verbatim (including surrounding whitespace)', () => {
    expect(coerceValue('  hello ', 'TEXT')).toBe('  hello ');
  });

  it('falls back to the exact string for out-of-safe-range integers', () => {
    const big = '999999999999999999999';
    expect(coerceValue(big, 'INTEGER')).toBe(big);
  });
});

// ── Mapping inference ──────────────────────────────────────────────────────────

describe('inferMappings', () => {
  it('slugifies headers, detects types, includes all by default', () => {
    const grid = parseCsv('First Name,Age\nAlice,30\nBob,25');
    const maps = inferMappings(grid);
    expect(maps).toHaveLength(2);
    expect(maps[0]).toMatchObject({
      sourceHeader: 'First Name',
      targetColumn: 'first_name',
      type: 'TEXT',
      include: true,
    });
    expect(maps[1]).toMatchObject({ targetColumn: 'age', type: 'INTEGER', include: true });
  });

  it('de-dupes collided target columns', () => {
    const grid = parseCsv('Name,name\nA,B');
    const maps = inferMappings(grid);
    expect(maps.map((m) => m.targetColumn)).toEqual(['name', 'name_2']);
  });
});

// ── The INSERT plan (SAFETY KEYSTONE) ────────────────────────────────────────

function map(cols: Array<{ col: string; type: 'INTEGER' | 'REAL' | 'TEXT'; include?: boolean }>): ColumnMapping[] {
  return cols.map((c, i) => ({
    sourceIndex: i,
    sourceHeader: c.col,
    targetColumn: c.col,
    type: c.type,
    include: c.include ?? true,
  }));
}

describe('buildInsertPlan', () => {
  it('emits a single parameterized multi-row INSERT with values BOUND, not concatenated', () => {
    const plan = buildInsertPlan(
      'people',
      map([
        { col: 'name', type: 'TEXT' },
        { col: 'age', type: 'INTEGER' },
      ]),
      [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
    );
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].sql).toBe('INSERT INTO "people" ("name", "age") VALUES (?, ?), (?, ?)');
    expect(plan.batches[0].params).toEqual(['Alice', 30, 'Bob', 25]);
    expect(plan.totalRows).toBe(2);
  });

  it('binds a HOSTILE value as an inert param — never injects SQL', () => {
    const evil = "'); DROP TABLE users; --";
    const plan = buildInsertPlan('t', map([{ col: 'note', type: 'TEXT' }]), [[evil]]);
    // The evil string is a bound param, and appears NOWHERE in the SQL text.
    expect(plan.batches[0].params).toEqual([evil]);
    expect(plan.batches[0].sql).toBe('INSERT INTO "t" ("note") VALUES (?)');
    expect(plan.batches[0].sql).not.toContain('DROP');
  });

  it('binds an empty cell as null', () => {
    const plan = buildInsertPlan(
      't',
      map([
        { col: 'a', type: 'TEXT' },
        { col: 'b', type: 'INTEGER' },
      ]),
      [['', '']],
    );
    expect(plan.batches[0].params).toEqual([null, null]);
  });

  it('skips columns with include:false', () => {
    const plan = buildInsertPlan(
      't',
      map([
        { col: 'keep', type: 'TEXT' },
        { col: 'drop', type: 'TEXT', include: false },
      ]),
      [['x', 'y']],
    );
    expect(plan.columns).toEqual(['keep']);
    expect(plan.batches[0].sql).toBe('INSERT INTO "t" ("keep") VALUES (?)');
    expect(plan.batches[0].params).toEqual(['x']);
  });

  it('chunks rows so bound params stay under the cap', () => {
    // 3 columns → floor(100/3) = 33 rows per chunk. 70 rows → 33 + 33 + 4 = 3 chunks.
    const cols = map([
      { col: 'a', type: 'INTEGER' },
      { col: 'b', type: 'INTEGER' },
      { col: 'c', type: 'INTEGER' },
    ]);
    const rows = Array.from({ length: 70 }, (_, i) => [String(i), String(i), String(i)]);
    const plan = buildInsertPlan('t', cols, rows);
    expect(plan.batches).toHaveLength(3);
    expect(plan.batches[0].rowCount).toBe(33);
    expect(plan.batches[2].rowCount).toBe(4);
    for (const b of plan.batches) {
      expect(b.params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
    }
    expect(plan.totalRows).toBe(70);
  });

  it('rejects an unsafe table name', () => {
    try {
      buildInsertPlan('bad name', map([{ col: 'a', type: 'TEXT' }]), [['x']]);
    } catch (e) {
      expect(e).toBeInstanceOf(IngestError);
      expect((e as IngestError).code).toBe('invalid_table');
    }
  });

  it('rejects when no columns are included', () => {
    try {
      buildInsertPlan('t', map([{ col: 'a', type: 'TEXT', include: false }]), [['x']]);
    } catch (e) {
      expect((e as IngestError).code).toBe('no_columns');
    }
  });

  it('rejects when there are no rows', () => {
    try {
      buildInsertPlan('t', map([{ col: 'a', type: 'TEXT' }]), []);
    } catch (e) {
      expect((e as IngestError).code).toBe('no_rows');
    }
  });
});

describe('buildCreateTableForImport', () => {
  it('prepends an id PK by default + types every column', () => {
    const sql = buildCreateTableForImport(
      'people',
      map([
        { col: 'name', type: 'TEXT' },
        { col: 'age', type: 'INTEGER' },
      ]),
    );
    expect(sql).toContain('CREATE TABLE "people"');
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(sql).toContain('"name" TEXT');
    expect(sql).toContain('"age" INTEGER');
  });

  it('uses a source id column instead of the synthetic one when present', () => {
    const sql = buildCreateTableForImport(
      't',
      map([
        { col: 'id', type: 'INTEGER' },
        { col: 'name', type: 'TEXT' },
      ]),
    );
    // Only ONE id column — the source's, not a duplicate synthetic PK.
    expect(sql.match(/"id"/g)?.length).toBe(1);
  });

  it('can omit the synthetic id', () => {
    const sql = buildCreateTableForImport('t', map([{ col: 'name', type: 'TEXT' }]), { withRowId: false });
    expect(sql).not.toContain('PRIMARY KEY');
  });
});

// ── AI seeding ─────────────────────────────────────────────────────────────────

describe('clampSeedRowCount', () => {
  it('clamps into the sane band', () => {
    expect(clampSeedRowCount(0)).toBe(1);
    expect(clampSeedRowCount(999)).toBe(AI_SEED_MAX_ROWS);
    expect(clampSeedRowCount(10)).toBe(10);
    expect(clampSeedRowCount(NaN)).toBeGreaterThan(0);
  });
});

describe('buildSeedSystemPrompt', () => {
  it('lists exact column keys + types + the JSON-only + row-count constraints', () => {
    const cols: SeedColumn[] = [
      { name: 'name', type: 'TEXT' },
      { name: 'price', type: 'REAL' },
    ];
    const prompt = buildSeedSystemPrompt('products', cols, 5, 'a coffee shop');
    expect(prompt).toContain('"name" (TEXT)');
    expect(prompt).toContain('"price" (REAL)');
    expect(prompt).toContain('exactly 5 row');
    expect(prompt).toContain('a coffee shop');
    expect(prompt).toMatch(/JSON array/i);
  });
});

describe('extractSeedRows', () => {
  const cols: SeedColumn[] = [
    { name: 'name', type: 'TEXT' },
    { name: 'age', type: 'INTEGER' },
  ];

  it('parses a bare JSON array to aligned string rows', () => {
    const rows = extractSeedRows('[{"name":"A","age":1},{"name":"B","age":2}]', cols);
    expect(rows).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('parses a ```json fenced array', () => {
    const rows = extractSeedRows('Here you go:\n```json\n[{"name":"X","age":9}]\n```', cols);
    expect(rows).toEqual([['X', '9']]);
  });

  it('drops extra keys + fills missing keys with empty (never injects an unknown column)', () => {
    const rows = extractSeedRows('[{"name":"A","evil":"x"}]', cols);
    expect(rows).toEqual([['A', '']]); // age missing → '', evil dropped
  });

  it('returns [] when nothing array-like is present', () => {
    expect(extractSeedRows('sorry, I cannot help', cols)).toEqual([]);
    expect(extractSeedRows('{"not":"array"}', cols)).toEqual([]);
  });

  it('feeds cleanly into buildInsertPlan via seedColumnsToMappings', () => {
    const rows = extractSeedRows('[{"name":"A","age":1}]', cols);
    const plan = buildInsertPlan('t', seedColumnsToMappings(cols), rows);
    expect(plan.batches[0].params).toEqual(['A', 1]);
  });
});

describe('seedColumnsToMappings', () => {
  it('maps BLOB seed columns to TEXT storage', () => {
    const maps = seedColumnsToMappings([{ name: 'blob_col', type: 'BLOB' }]);
    expect(maps[0].type).toBe('TEXT');
  });
});

// ── Form builder ────────────────────────────────────────────────────────────────

describe('storageForFieldKind', () => {
  it('maps kinds to storage classes', () => {
    expect(storageForFieldKind('number')).toBe('REAL');
    expect(storageForFieldKind('checkbox')).toBe('INTEGER');
    expect(storageForFieldKind('email')).toBe('TEXT');
    expect(storageForFieldKind('textarea')).toBe('TEXT');
  });
});

describe('buildFormPlan', () => {
  it('builds a backing table (id PK + submitted_at + typed field columns) + a stored definition', () => {
    const plan = buildFormPlan('Contact us', 'contact_submissions', [
      { label: 'Your name', column: 'your_name', kind: 'text', required: true },
      { label: 'Email', column: 'email', kind: 'email', required: true },
      { label: 'How many?', column: 'how_many', kind: 'number', required: false },
    ]);
    expect(plan.createTableSql).toContain('CREATE TABLE "contact_submissions"');
    expect(plan.createTableSql).toContain('"id" INTEGER PRIMARY KEY');
    expect(plan.createTableSql).toContain('"submitted_at" TEXT');
    expect(plan.createTableSql).toContain('"your_name" TEXT NOT NULL');
    expect(plan.createTableSql).toContain('"how_many" REAL');
    expect(plan.definition).toEqual({
      version: 1,
      title: 'Contact us',
      table: 'contact_submissions',
      fields: [
        { label: 'Your name', column: 'your_name', kind: 'text', required: true },
        { label: 'Email', column: 'email', kind: 'email', required: true },
        { label: 'How many?', column: 'how_many', kind: 'number', required: false },
      ],
    });
  });

  it('slugifies + de-dupes field columns derived from labels', () => {
    const plan = buildFormPlan('F', 'f', [
      { label: 'Full Name', column: '', kind: 'text', required: false },
      { label: 'Full Name', column: '', kind: 'text', required: false },
    ]);
    expect(plan.definition.fields.map((f) => f.column)).toEqual(['full_name', 'full_name_2']);
  });

  it('rejects an unsafe table name + an empty field list', () => {
    expect(() => buildFormPlan('F', 'bad name', [{ label: 'a', column: 'a', kind: 'text', required: false }])).toThrow(
      IngestError,
    );
    try {
      buildFormPlan('F', 'f', []);
    } catch (e) {
      expect((e as IngestError).code).toBe('no_fields');
    }
  });
});
