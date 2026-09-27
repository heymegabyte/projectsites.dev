/**
 * Pure view-model functions for Airtable-style alternate views of per-site data:
 * Kanban (grouped lanes), Calendar (date-bucketed rows), and Gallery (paginated grid).
 *
 * All functions are stateless transforms over already-fetched rows — they never
 * mutate input and carry zero side-effects or external dependencies.
 *
 * @module view-models
 */

/** A single data row from the D1 / KV data browser. */
export type Row = Record<string, unknown>;

/*
 * ---------------------------------------------------------------------------
 * Kanban — groupRowsByColumn
 * ---------------------------------------------------------------------------
 */

/**
 * A single Kanban lane: all rows that share the same column value.
 * The `key` is always a non-empty string; rows with a null/undefined/empty
 * column value are collected under the sentinel key `'Uncategorized'`.
 */
export interface Group {
  /** Column value used as the lane heading, or `'Uncategorized'`. */
  readonly key: string;

  /** Rows belonging to this lane, in their original order. */
  readonly rows: Row[];
}

/**
 * Groups rows by the distinct string values found in `col`, preserving the
 * first-appearance order of each distinct key.
 *
 * - `null`, `undefined`, or `''` → lane keyed `'Uncategorized'`.
 * - The `'Uncategorized'` lane is placed at the position where its first row
 *   appears, not forced to the beginning or end.
 * - An empty `rows` array returns `[]`.
 *
 * @param rows - Source rows (not mutated).
 * @param col  - Column name to group by.
 * @returns Ordered array of {@link Group} objects, one per distinct value.
 *
 * @example
 * groupRowsByColumn([{status:'done'},{status:'todo'},{status:'done'}], 'status')
 * // → [{ key:'done', rows:[…,…] }, { key:'todo', rows:[…] }]
 */
export function groupRowsByColumn(rows: readonly Row[], col: string): Group[] {
  if (rows.length === 0) {
    return [];
  }

  /** Insertion-order map: key → accumulated rows */
  const map = new Map<string, Row[]>();

  for (const row of rows) {
    const raw = row[col];
    const key: string = raw === null || raw === undefined || raw === '' ? 'Uncategorized' : String(raw);

    let bucket = map.get(key);

    if (bucket === undefined) {
      bucket = [];
      map.set(key, bucket);
    }

    bucket.push(row);
  }

  const result: Group[] = [];

  for (const [key, groupRows] of map) {
    result.push({ key, rows: groupRows });
  }

  return result;
}

/*
 * ---------------------------------------------------------------------------
 * Calendar — bucketRowsByDate
 * ---------------------------------------------------------------------------
 */

/**
 * A single calendar bucket: all rows whose date column falls in the same
 * day / ISO-week / month, depending on the requested granularity.
 */
export interface DateBucket {
  /**
   * Bucket key in a sortable UTC string format:
   * - `'day'`   → `'YYYY-MM-DD'`
   * - `'week'`  → `'YYYY-Www'`  (ISO week number, zero-padded to 2 digits)
   * - `'month'` → `'YYYY-MM'`
   */
  readonly bucket: string;

  /** Rows belonging to this bucket, in their original order. */
  readonly rows: Row[];
}

/** Supported calendar granularities. */
export type DateGranularity = 'day' | 'week' | 'month';

/**
 * Pads a number to at least `width` digits with leading zeros.
 * @internal
 */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Returns the ISO 8601 week number (1–53) of the given UTC date.
 *
 * Algorithm: the ISO week that contains Thursday of the date's week is the
 * one that determines the year.  Thursday is UTC day 4 (0=Sun).
 *
 * @internal
 */
function isoWeekNumber(date: Date): { year: number; week: number } {
  // Shift to nearest Thursday (ISO weeks start Monday → Thursday is day 4)
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));

  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  return { year: thursday.getUTCFullYear(), week };
}

/**
 * Derives the bucket key string for a given date and granularity.
 * All arithmetic is performed in UTC to avoid local-timezone drift.
 *
 * @internal
 */
function bucketKey(date: Date, granularity: DateGranularity): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1-based
  const d = date.getUTCDate();

  if (granularity === 'month') {
    return `${pad(y, 4)}-${pad(m, 2)}`;
  }

  if (granularity === 'week') {
    const { year, week } = isoWeekNumber(date);
    return `${pad(year, 4)}-W${pad(week, 2)}`;
  }

  // 'day' (default) — the exhaustive fallback keeps a single trailing return (consistent-return).
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/**
 * Buckets rows by the date value found in `col` at the requested granularity.
 *
 * - Rows whose `col` value is missing, `null`, `undefined`, `''`, or cannot
 *   be parsed by `new Date(…)` into a valid date are **silently skipped** —
 *   no fabricated "unknown" bucket is created for them.
 * - Buckets are returned sorted **ascending** by their key string (which is
 *   designed to be lexicographically equivalent to chronological order).
 * - All date arithmetic uses UTC to prevent timezone-induced bucket drift.
 *
 * @param rows        - Source rows (not mutated).
 * @param col         - Column name containing a date-parseable value.
 * @param granularity - `'day'`, `'week'`, or `'month'`.
 * @returns Sorted array of {@link DateBucket} objects.
 *
 * @example
 * bucketRowsByDate(rows, 'created_at', 'month')
 * // → [{ bucket:'2026-01', rows:[…] }, { bucket:'2026-02', rows:[…] }]
 */
export function bucketRowsByDate(rows: readonly Row[], col: string, granularity: DateGranularity): DateBucket[] {
  const map = new Map<string, Row[]>();

  for (const row of rows) {
    const raw = row[col];

    // Skip absent / null / empty values
    if (raw === null || raw === undefined || raw === '') {
      continue;
    }

    const date = new Date(raw as string | number);

    // Skip unparseable or NaN dates
    if (!Number.isFinite(date.getTime())) {
      continue;
    }

    const key = bucketKey(date, granularity);

    let bucket = map.get(key);

    if (bucket === undefined) {
      bucket = [];
      map.set(key, bucket);
    }

    bucket.push(row);
  }

  // Sort buckets ascending by key (all key formats are lexicographically sortable)
  const result: DateBucket[] = [];

  for (const [bucket, bucketRows] of map) {
    result.push({ bucket, rows: bucketRows });
  }
  result.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  return result;
}

/*
 * ---------------------------------------------------------------------------
 * Gallery — galleryPages
 * ---------------------------------------------------------------------------
 */

/**
 * Splits rows into pages of at most `pageSize` rows each.
 *
 * - `pageSize ≤ 0` → a single page containing all rows (no chunking).
 * - Empty `rows` → `[]` (no pages, not one empty page).
 * - The last page may contain fewer than `pageSize` rows.
 *
 * @param rows     - Source rows (not mutated).
 * @param pageSize - Maximum rows per page; ≤ 0 means "one page with all rows".
 * @returns Array of pages, each page being an array of {@link Row} objects.
 *
 * @example
 * galleryPages([r1, r2, r3, r4, r5], 2)
 * // → [[r1, r2], [r3, r4], [r5]]
 *
 * @example
 * galleryPages([], 10)
 * // → []
 */
export function galleryPages(rows: readonly Row[], pageSize: number): Row[][] {
  if (rows.length === 0) {
    return [];
  }

  // pageSize ≤ 0 → single page with all rows
  if (pageSize <= 0) {
    return [rows.slice()];
  }

  const pages: Row[][] = [];

  for (let i = 0; i < rows.length; i += pageSize) {
    pages.push(rows.slice(i, i + pageSize));
  }

  return pages;
}
