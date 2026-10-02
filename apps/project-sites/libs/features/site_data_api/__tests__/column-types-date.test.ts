/**
 * TDD-first coverage for the per-site D1 **`date` column type** slice (fire-84, Role 1).
 *
 * Two things this proves, both at the worker/libs layer (never the shared platform DB):
 *
 *  1. STRICT-ISO date AUTODETECT (the known bug class) — `detectColumnType` / `isStrictIsoDate`
 *     classify a column as `date` ONLY when its sampled values match a strict ISO regex
 *     (`^\d{4}-\d{2}-\d{2}`), NEVER via `new Date(x)` coercion. A numeric id like `20240101`,
 *     a bare year `"2020"`, or `"5"` must NOT be mistaken for a date (`new Date(20240101)` is a
 *     finite 1970 ms timestamp — the exact false-positive this encodes against). Mirrors the
 *     editor's shipped `isoDayKey` discipline (strict detect vs permissive bucket/display).
 *
 *  2. A `date` column is a FIRST-CLASS type the per-site D1 accepts + round-trips — `clampSiteColumnType`
 *     keeps `DATE` (vs the base `clampColumnType` which collapses it to TEXT), and the date-cell
 *     save→reload persistence runs through the EXISTING, reused safe SQL builders
 *     (`buildAddColumnSql` for the `date` column, `buildUpdateRowSql` for the cell write) so the
 *     value is BOUND, never interpolated, and the column affinity is real SQLite (`DATE` → NUMERIC).
 *
 * Pure-function + SQL-shape tests (no network, no CF creds) — the route gate (flag-dark-404 / IDOR /
 * per-site isolation) is already proven in `site-db.test.ts`; this file owns the date-type semantics.
 */
import {
  buildAddDateColumnSql,
  clampSiteColumnType,
  detectColumnType,
  isStrictIsoDate,
  SITE_COLUMN_TYPES,
} from '../site_data_column_types';
import { buildUpdateRowSql, type SiteTableColumn } from '../../../../src/services/site_data_db.js';

describe('isStrictIsoDate (strict-ISO gate — NEVER new Date() coercion)', () => {
  it('accepts a bare ISO calendar date', () => {
    expect(isStrictIsoDate('2024-01-01')).toBe(true);
    expect(isStrictIsoDate('1999-12-31')).toBe(true);
  });

  it('accepts a zone-marked ISO datetime (leading YYYY-MM-DD)', () => {
    expect(isStrictIsoDate('2024-01-01T23:30:00-05:00')).toBe(true);
    expect(isStrictIsoDate('2024-06-15T12:00:00Z')).toBe(true);
  });

  it('REJECTS numeric ids / years / small ints that new Date() would false-positive', () => {
    // `new Date(20240101).getTime()` is finite (~1970-08-22) — the classic trap. Strict regex kills it.
    expect(isStrictIsoDate(20240101)).toBe(false);
    expect(isStrictIsoDate('20240101')).toBe(false);
    expect(isStrictIsoDate('2020')).toBe(false);
    expect(isStrictIsoDate('5')).toBe(false);
    expect(isStrictIsoDate(5)).toBe(false);
  });

  it('REJECTS an impossible/junk date that merely LOOKS date-shaped', () => {
    expect(isStrictIsoDate('2024-13-45')).toBe(false); // month 13 / day 45
    expect(isStrictIsoDate('not-a-date')).toBe(false);
    expect(isStrictIsoDate('')).toBe(false);
    expect(isStrictIsoDate(null)).toBe(false);
    expect(isStrictIsoDate(undefined)).toBe(false);
  });
});

describe('detectColumnType (auto-pick the column type from a page of values)', () => {
  it('classifies a column of ISO dates as `date`', () => {
    expect(detectColumnType(['2024-01-01', '2024-02-15', '2023-12-31'])).toBe('date');
  });

  it('does NOT classify a numeric-id column as `date` — the known false-positive class', () => {
    // Values that `new Date(v)` finiteness would wrongly accept as dates.
    expect(detectColumnType([20240101, 20240102, 20240103])).toBe('integer');
    expect(detectColumnType(['1', '2', '3'])).toBe('integer');
    expect(detectColumnType(['2020', '2021', '2022'])).toBe('integer');
  });

  it('classifies numbers as `integer` / `real`, everything else as `text`, nulls ignored', () => {
    expect(detectColumnType([1, 2, 3])).toBe('integer');
    expect(detectColumnType([1.5, 2.25])).toBe('real');
    expect(detectColumnType(['alpha', 'beta'])).toBe('text');
    expect(detectColumnType([null, undefined])).toBe('text'); // no signal → safest default
  });

  it('requires EVERY non-null sample to be ISO before picking `date` (one non-date demotes it)', () => {
    expect(detectColumnType(['2024-01-01', 'pending', '2024-02-01'])).toBe('text');
  });
});

describe('clampSiteColumnType (a `date` column is first-class, unlike the base clamp)', () => {
  it('keeps DATE as a real column type (base clampColumnType collapses it to TEXT)', () => {
    expect(clampSiteColumnType('date')).toBe('DATE');
    expect(clampSiteColumnType('DATE')).toBe('DATE');
  });

  it('still clamps the base SQLite affinities + defaults unknown → TEXT', () => {
    expect(clampSiteColumnType('integer')).toBe('INTEGER');
    expect(clampSiteColumnType('real')).toBe('REAL');
    expect(clampSiteColumnType('text')).toBe('TEXT');
    expect(clampSiteColumnType('wat')).toBe('TEXT');
  });

  it('exposes DATE in the selectable site column-type set', () => {
    expect(SITE_COLUMN_TYPES).toContain('DATE');
    expect(SITE_COLUMN_TYPES).toContain('TEXT');
  });
});

describe('date-cell save → reload persistence (reuses the existing safe SQL builders)', () => {
  it('adds a `date` column with a real DATE affinity via buildAddDateColumnSql (reuses isSafeIdent/quoteIdent)', () => {
    // The `date` column type must survive into the ALTER TABLE — NOT be silently rewritten to TEXT by
    // the base `buildAddColumnSql` (whose clampColumnType has no DATE). This in-scope builder preserves
    // DATE while reusing the service's identifier allowlist + quoting. The "first-class date type" win.
    expect(buildAddDateColumnSql('events', 'starts_on')).toBe(
      'ALTER TABLE "events" ADD COLUMN "starts_on" DATE',
    );
    // Hostile identifier → null (the service's isSafeIdent allowlist, reused not reimplemented).
    expect(buildAddDateColumnSql('events', '1bad')).toBeNull();
    expect(buildAddDateColumnSql('bad; DROP', 'ok')).toBeNull();
  });

  it('saves a date cell as a BOUND param-value UPDATE … WHERE rowid=? (round-trip, never interpolated)', () => {
    const columns: SiteTableColumn[] = [
      { name: 'id', notnull: 0, pk: 1, type: 'INTEGER' },
      { name: 'starts_on', notnull: 0, pk: 0, type: 'DATE' },
    ];
    const built = buildUpdateRowSql('events', columns, { starts_on: '2024-07-04' }, 12);
    expect(built).not.toBeNull();
    // The ISO date is BOUND (params), the row targeted by its stable rowid — the save that a date
    // cell-editor emits + what the browse endpoint reads straight back on reload.
    expect(built!.sql).toBe('UPDATE "events" SET "starts_on" = ? WHERE rowid = ?');
    expect(built!.params).toEqual(['2024-07-04', 12]);
  });

  it('a strict-ISO reload value round-trips through detection as `date` (write-then-read agreement)', () => {
    // What was saved ('2024-07-04') reads back from the browse endpoint; re-detecting the column
    // over the reloaded page still classifies it `date` — the save and the detect agree.
    const reloaded = ['2024-07-04', '2024-08-01'];
    expect(detectColumnType(reloaded)).toBe('date');
    expect(reloaded.every(isStrictIsoDate)).toBe(true);
  });
});
