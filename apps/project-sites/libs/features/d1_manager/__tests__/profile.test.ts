/**
 * Pure D1 table-profiling logic — column parsing, identifier quoting, the single-scan aggregate
 * query builder, and result shaping. No I/O.
 */
import {
  parseProfileColumns,
  quoteIdent,
  isNumericType,
  buildProfileQuery,
  parseProfileResult,
  PROFILE_COLUMN_CAP,
  type ProfileColumn,
} from '../profile.js';

describe('parseProfileColumns', () => {
  it('extracts { name, type } and skips table-level constraints', () => {
    const ddl =
      'CREATE TABLE "users" (id INTEGER PRIMARY KEY, "email" TEXT NOT NULL, age INT, ' +
      'FOREIGN KEY(org_id) REFERENCES orgs(id), UNIQUE(email))';
    expect(parseProfileColumns(ddl)).toEqual([
      { name: 'id', type: 'INTEGER' },
      { name: 'email', type: 'TEXT' },
      { name: 'age', type: 'INT' },
    ]);
  });
  it('returns [] for a VIEW / virtual table / unparseable DDL', () => {
    expect(parseProfileColumns('CREATE VIEW v AS SELECT 1')).toEqual([]);
    expect(parseProfileColumns(null)).toEqual([]);
    expect(parseProfileColumns('not sql')).toEqual([]);
  });
  it('handles a quoted name containing a comma inside quotes', () => {
    const cols = parseProfileColumns('CREATE TABLE t ("a,b" TEXT, c INT)');
    expect(cols).toEqual([
      { name: 'a,b', type: 'TEXT' },
      { name: 'c', type: 'INT' },
    ]);
  });
});

describe('quoteIdent / isNumericType', () => {
  it('quotes and escapes internal double-quotes', () => {
    expect(quoteIdent('col')).toBe('"col"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
  it('detects numeric declared types', () => {
    expect(isNumericType('INTEGER')).toBe(true);
    expect(isNumericType('REAL')).toBe(true);
    expect(isNumericType('DECIMAL(10,2)')).toBe(true);
    expect(isNumericType('TEXT')).toBe(false);
    expect(isNumericType('')).toBe(false);
  });
});

describe('buildProfileQuery', () => {
  it('emits COUNT(*) + per-column non-null/distinct/min/max, and AVG for numerics only', () => {
    const { sql, used } = buildProfileQuery('t', [
      { name: 'id', type: 'INTEGER' },
      { name: 'name', type: 'TEXT' },
    ]);
    expect(used).toHaveLength(2);
    expect(sql).toContain('COUNT(*) AS "c"');
    expect(sql).toContain('COUNT("id") AS "n0"');
    expect(sql).toContain('COUNT(DISTINCT "id") AS "d0"');
    expect(sql).toContain('AVG("id") AS "av0"'); // numeric → avg
    expect(sql).toContain('MIN("name") AS "mn1"');
    expect(sql).not.toContain('AVG("name")'); // text → no avg
    expect(sql).toContain('FROM "t"');
  });
  it('caps the profiled columns at PROFILE_COLUMN_CAP', () => {
    const many: ProfileColumn[] = Array.from({ length: PROFILE_COLUMN_CAP + 5 }, (_, i) => ({
      name: `c${i}`,
      type: 'INT',
    }));
    const { used } = buildProfileQuery('t', many);
    expect(used).toHaveLength(PROFILE_COLUMN_CAP);
  });
  it('never interpolates a raw identifier — a hostile name is quoted+escaped (can not break out)', () => {
    const { sql } = buildProfileQuery('t', [{ name: 'a") FROM x;--', type: 'TEXT' }]);
    // The inner " is DOUBLED, so the hostile text stays INSIDE one quoted identifier.
    expect(quoteIdent('a") FROM x;--')).toBe('"a"") FROM x;--"');
    // Every " in the output is balanced (even count) and the query's real FROM target is "t".
    expect((sql.match(/"/g) ?? []).length % 2).toBe(0);
    expect(sql.endsWith('FROM "t"')).toBe(true);
  });
});

describe('parseProfileResult', () => {
  const used: ProfileColumn[] = [
    { name: 'id', type: 'INTEGER' },
    { name: 'name', type: 'TEXT' },
  ];
  it('maps the aggregate row to per-column stats, deriving nullCount', () => {
    const row = {
      c: 100,
      n0: 100,
      d0: 100,
      mn0: 1,
      mx0: 100,
      av0: 50.5,
      n1: 90,
      d1: 42,
      mn1: 'aaa',
      mx1: 'zzz',
    };
    const p = parseProfileResult(row, used, 100, false);
    expect(p.rowCount).toBe(100);
    expect(p.columns[0]).toEqual({
      name: 'id',
      type: 'INTEGER',
      nonNull: 100,
      nullCount: 0,
      distinct: 100,
      min: '1',
      max: '100',
      avg: 50.5,
    });
    expect(p.columns[1].nullCount).toBe(10); // 100 - 90
    expect(p.columns[1].avg).toBeNull(); // text col → no avg alias
    expect(p.rowsRead).toBe(100);
  });
  it('is fail-soft on a missing row (0 rows, null stats)', () => {
    const p = parseProfileResult(undefined, used, null, false);
    expect(p.rowCount).toBe(0);
    expect(p.columns[0].nonNull).toBe(0);
    expect(p.columns[0].min).toBeNull();
  });
});
