import { describe, it, expect } from 'vitest';
import {
  groupRowsByColumn,
  bucketRowsByDate,
  galleryPages,
  type Row,
  type Group,
  type DateBucket,
} from './view-models';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** Build a minimal row with a single key/value pair. */
function row(key: string, value: unknown): Row {
  return { [key]: value };
}

/*
 * ---------------------------------------------------------------------------
 * groupRowsByColumn — Kanban lanes
 * ---------------------------------------------------------------------------
 */

describe('groupRowsByColumn', () => {
  it('empty rows returns empty array', () => {
    const result = groupRowsByColumn([], 'status');
    expect(result).toEqual([]);
  });

  it('groups into multiple lanes correctly', () => {
    const rows: Row[] = [
      row('status', 'done'),
      row('status', 'todo'),
      row('status', 'done'),
      row('status', 'todo'),
      row('status', 'in_progress'),
    ];
    const groups = groupRowsByColumn(rows, 'status');

    expect(groups).toHaveLength(3);
    expect(groups[0].key).toBe('done');
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].key).toBe('todo');
    expect(groups[1].rows).toHaveLength(2);
    expect(groups[2].key).toBe('in_progress');
    expect(groups[2].rows).toHaveLength(1);
  });

  it('preserves first-appearance order of keys (not alphabetical)', () => {
    const rows: Row[] = [
      row('priority', 'high'),
      row('priority', 'low'),
      row('priority', 'medium'),
      row('priority', 'high'),
    ];
    const groups = groupRowsByColumn(rows, 'priority');

    expect(groups.map((g: Group) => g.key)).toEqual(['high', 'low', 'medium']);
  });

  it('null value goes into Uncategorized lane', () => {
    const rows: Row[] = [row('tag', null), row('tag', 'feature'), row('tag', null)];
    const groups = groupRowsByColumn(rows, 'tag');

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('Uncategorized');
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].key).toBe('feature');
  });

  it('undefined value goes into Uncategorized lane', () => {
    const rows: Row[] = [
      { other: 'x' }, // col 'tag' is undefined
      row('tag', 'bug'),
    ];
    const groups = groupRowsByColumn(rows, 'tag');

    expect(groups[0].key).toBe('Uncategorized');
    expect(groups[1].key).toBe('bug');
  });

  it('empty-string value goes into Uncategorized lane', () => {
    const rows: Row[] = [row('tag', ''), row('tag', 'release')];
    const groups = groupRowsByColumn(rows, 'tag');

    expect(groups[0].key).toBe('Uncategorized');
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[1].key).toBe('release');
  });

  it('Uncategorized is placed where its first row appears, not at end', () => {
    const rows: Row[] = [
      row('status', null), // Uncategorized first
      row('status', 'done'),
    ];
    const groups = groupRowsByColumn(rows, 'status');

    expect(groups[0].key).toBe('Uncategorized');
    expect(groups[1].key).toBe('done');
  });

  it('numeric column values are coerced to string keys', () => {
    const rows: Row[] = [row('score', 1), row('score', 2), row('score', 1)];
    const groups = groupRowsByColumn(rows, 'score');

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('1');
    expect(groups[1].key).toBe('2');
  });
});

/*
 * ---------------------------------------------------------------------------
 * bucketRowsByDate — Calendar
 * ---------------------------------------------------------------------------
 */

describe('bucketRowsByDate', () => {
  it('buckets by day with YYYY-MM-DD keys', () => {
    const rows: Row[] = [
      row('created', '2026-03-15T10:00:00Z'),
      row('created', '2026-03-16T22:00:00Z'),
      row('created', '2026-03-15T23:59:59Z'),
    ];
    const buckets = bucketRowsByDate(rows, 'created', 'day');

    expect(buckets).toHaveLength(2);
    expect(buckets[0].bucket).toBe('2026-03-15');
    expect(buckets[0].rows).toHaveLength(2);
    expect(buckets[1].bucket).toBe('2026-03-16');
    expect(buckets[1].rows).toHaveLength(1);
  });

  it('buckets by month with YYYY-MM keys', () => {
    const rows: Row[] = [
      row('created', '2026-01-05T00:00:00Z'),
      row('created', '2026-01-31T00:00:00Z'),
      row('created', '2026-03-01T00:00:00Z'),
    ];
    const buckets = bucketRowsByDate(rows, 'created', 'month');

    expect(buckets).toHaveLength(2);
    expect(buckets[0].bucket).toBe('2026-01');
    expect(buckets[1].bucket).toBe('2026-03');
  });

  it('buckets by ISO week with YYYY-Www keys (zero-padded)', () => {
    // 2026-01-01 is a Thursday — ISO week 1 of 2026
    const rows: Row[] = [
      row('dt', '2026-01-01T00:00:00Z'), // week 1
      row('dt', '2026-01-05T00:00:00Z'), // week 2 (Mon Jan 5)
      row('dt', '2026-01-04T23:59:59Z'), // week 1 (Sun still in week 1)
    ];
    const buckets = bucketRowsByDate(rows, 'dt', 'week');

    expect(buckets).toHaveLength(2);

    // Both must be zero-padded
    expect(buckets[0].bucket).toMatch(/^\d{4}-W\d{2}$/);
    expect(buckets[0].rows).toHaveLength(2); // Jan 1 + Jan 4
    expect(buckets[1].rows).toHaveLength(1); // Jan 5
  });

  it('skips rows with invalid date values — no fabricated bucket', () => {
    const rows: Row[] = [
      row('dt', 'not-a-date'),
      row('dt', '2026-06-01T00:00:00Z'),
      row('dt', ''),
      row('dt', null),
      row('dt', undefined),
    ];
    const buckets = bucketRowsByDate(rows, 'dt', 'day');

    expect(buckets).toHaveLength(1);
    expect(buckets[0].bucket).toBe('2026-06-01');
    expect(buckets[0].rows).toHaveLength(1);
  });

  it('returns buckets sorted ascending by key', () => {
    const rows: Row[] = [
      row('dt', '2026-12-01T00:00:00Z'),
      row('dt', '2026-01-01T00:00:00Z'),
      row('dt', '2026-06-15T00:00:00Z'),
    ];
    const buckets = bucketRowsByDate(rows, 'dt', 'month');

    const keys = buckets.map((b: DateBucket) => b.bucket);
    expect(keys).toEqual(['2026-01', '2026-06', '2026-12']);
  });

  it('uses UTC — a UTC midnight date does not shift to the previous day', () => {
    // 2026-03-01T00:00:00Z should land in the 2026-03-01 bucket, not 2026-02-28
    const rows: Row[] = [row('ts', '2026-03-01T00:00:00Z')];
    const [bucket] = bucketRowsByDate(rows, 'ts', 'day');

    expect(bucket.bucket).toBe('2026-03-01');
  });

  it('empty rows returns empty array', () => {
    expect(bucketRowsByDate([], 'dt', 'day')).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * galleryPages — Gallery
 * ---------------------------------------------------------------------------
 */

describe('galleryPages', () => {
  it('empty rows returns empty array', () => {
    expect(galleryPages([], 4)).toEqual([]);
  });

  it('chunks evenly into full pages', () => {
    const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    const pages = galleryPages(rows, 2);

    expect(pages).toHaveLength(3);
    expect(pages[0]).toHaveLength(2);
    expect(pages[1]).toHaveLength(2);
    expect(pages[2]).toHaveLength(2);
  });

  it('last page contains the remainder rows', () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const pages = galleryPages(rows, 3);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(3);
    expect(pages[1]).toHaveLength(2);
  });

  it('pageSize of 0 returns single page with all rows', () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({ id: i }));
    const pages = galleryPages(rows, 0);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(7);
  });

  it('negative pageSize returns single page with all rows', () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const pages = galleryPages(rows, -5);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(3);
  });

  it('pageSize larger than row count returns a single page', () => {
    const rows: Row[] = [{ a: 1 }, { a: 2 }];
    const pages = galleryPages(rows, 100);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(2);
  });

  it('does not mutate the input rows array', () => {
    const rows: Row[] = [{ id: 0 }, { id: 1 }, { id: 2 }];
    const original = rows.slice();
    galleryPages(rows, 2);
    expect(rows).toEqual(original);
  });
});
