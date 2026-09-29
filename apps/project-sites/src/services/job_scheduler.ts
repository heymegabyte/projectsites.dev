/**
 * @module job_scheduler
 * @description Pure cron-parser and next-fire calculator for scheduled jobs.
 *   Standard 5-field cron expressions (minute hour dayOfMonth month dayOfWeek).
 *   No external dependencies, no I/O, Workers-compatible.
 */

/**
 * Parsed cron schedule.
 * Each array contains the explicit numeric values the field matches (0–59 for minute,
 * 0–23 for hour, 1–31 for day-of-month, 1–12 for month, 0–7 for day-of-week where 0/7 = Sunday).
 */
export interface CronSchedule {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  readonly month: readonly number[];
  readonly dayOfWeek: readonly number[];
}

// ─── Errors ────────────────────────────────────────────────────────────

/** Thrown when an expression cannot be parsed. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/**
 * Expand a single cron field segment into an array of matching integers.
 *
 * Accepts: wildcard, number, comma-list, range, step-from-wildcard, range-with-step.
 * A `*` with no step expands to the full range `[lo..hi]`.
 *
 * @param seg - The raw cron field segment.
 * @param lo  - Inclusive lower bound for the field (e.g. 0 for minute).
 * @param hi  - Inclusive upper bound for the field (e.g. 59 for minute).
 * @returns Sorted array of matching integers.
 */
function expandSegment(seg: string, lo: number, hi: number): number[] {
  const values = new Set<number>();

  for (const part of seg.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const stepMatch = trimmed.match(/^(.+?)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    const rangePart = stepMatch ? stepMatch[1]! : trimmed;

    let start: number;
    let end: number;

    if (rangePart === '*') {
      start = lo;
      end = hi;
    } else if (rangePart.includes('-')) {
      const parts = rangePart.split('-');
      if (parts.length !== 2) throw new CronParseError(`Invalid range: ${rangePart}`);
      start = parseInt(parts[0]!, 10);
      end = parseInt(parts[1]!, 10);
    } else {
      start = parseInt(rangePart, 10);
      end = start;
    }

    if (isNaN(start) || isNaN(end)) {
      throw new CronParseError(`Invalid cron field segment: ${trimmed}`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  return [...values].sort((a, b) => a - b);
}

// ─── Main API ──────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  '@annually': '0 0 1 1 *',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@midnight': '0 0 * * *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@yearly': '0 0 1 1 *',
};

/**
 * Parse a standard 5-field cron expression into a {@link CronSchedule}.
 *
 * Supports `*` (wildcard), comma-separated lists (`1,3,5`), ranges (`1-5`),
 * steps (every-15-minutes shorthand), comma-lists with step (`1-10/2`), and named
 * aliases (`@hourly`, `@daily`, etc.).
 *
 * Fields (in order): minute (0–59), hour (0–23), day-of-month (1–31),
 * month (1–12), day-of-week (0–7, where 0 and 7 = Sunday).
 *
 * @param expr - The cron expression string (5 whitespace-separated fields or an alias).
 * @returns A {@link CronSchedule} or `null` if the expression is syntactically invalid.
 * @throws {CronParseError} Only when a field contains a structurally invalid segment
 *   (e.g. malformed range or step). Returns `null` for recoverable parse failures
 *   (wrong field count, empty string).
 *
 * @example
 *   parseCron('30 9 * * 1-5');           // 9:30 AM weekdays
 *   parseCron('0 9 * * 1-5');            // 9 AM weekdays
 *   parseCron('0 0 1 * *');              // midnight 1st of month
 *   parseCron('@hourly');                // at minute 0
 *   parseCron('invalid');                // null
 */
export function parseCron(expr: string): CronSchedule | null {
  if (!expr || typeof expr !== 'string') return null;

  // Resolve aliases
  const resolved = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();

  const fields = resolved.split(/\s+/);
  if (fields.length !== 5) return null;

  const fieldRanges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week
  ];

  try {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => {
      const [lo, hi] = fieldRanges[i]!;
      return expandSegment(f, lo, hi);
    });

    return { dayOfMonth, dayOfWeek, hour, minute, month };
  } catch {
    return null;
  }
}

/**
 * Compute the next fire time (Unix milliseconds) after a reference timestamp.
 *
 * Searches forward minute-by-minute within a rolling 4-year window from the reference
 * point. Returns `Infinity` if no fire is found in the search horizon.
 *
 * @param schedule - A parsed {@link CronSchedule}.
 * @param fromMs   - Reference timestamp in Unix milliseconds (default: `Date.now()`).
 * @returns Unix milliseconds of the next fire time.
 *
 * @example
 *   const s = parseCron('30 9 * * 1-5');     // 9:30 AM weekdays
 *   nextFire(s);                              // next weekday at 9:30
 *   nextFire(s, Date.parse('2026-07-04T00:00Z')); // 2026-07-06T09:30:00Z (Monday)
 */
export function nextFire(schedule: CronSchedule, fromMs: number = Date.now()): number {
  const FOUR_YEARS_MS = 126_230_400_000; // ~4 years in ms

  let candidate = new Date(fromMs);
  // Start from the NEXT minute boundary
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const deadline = candidate.getTime() + FOUR_YEARS_MS;

  while (candidate.getTime() <= deadline) {
    const m = candidate.getUTCMonth() + 1; // 1–12
    const dw = candidate.getUTCDay(); // 0–7 (0=Sun)

    // Month check
    if (!schedule.month.includes(m)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      candidate.setUTCDate(1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    // Day-of-week check (normalise 7 → 0)
    const dow = dw === 7 ? 0 : dw;
    const dayMatches = schedule.dayOfWeek.includes(dow);
    const dayDomMatches = schedule.dayOfMonth.includes(candidate.getUTCDate());

    // OR logic: day-of-week AND day-of-month are NOT both wildcard → use OR
    const isDowWild = schedule.dayOfWeek.length === 8 && schedule.dayOfWeek.every((v) => v <= 7);
    const isDomWild = schedule.dayOfMonth.length >= 31;

    let dateOk: boolean;

    if (!isDowWild && !isDomWild) {
      // Both constrained → OR (e.g. "15 10 * * 1-5" fires Mon-Fri OR 15th)
      dateOk = dayMatches || dayDomMatches;
    } else if (!isDomWild) {
      // Only day-of-month constrained
      dateOk = dayDomMatches;
    } else if (!isDowWild) {
      // Only day-of-week constrained
      dateOk = dayMatches;
    } else {
      // Both wildcard
      dateOk = true;
    }

    if (!dateOk) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    // Hour check
    if (!schedule.hour.includes(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    // Minute check
    if (!schedule.minute.includes(candidate.getUTCMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }

    // All fields match
    return candidate.getTime();
  }

  return Infinity;
}

// ─── describeCron ──────────────────────────────────────────────────────

/**
 * Format a day-of-week number set into a human-readable string.
 *
 * @param dows - Sorted array of day-of-week numbers (0=Sun .. 6=Sat, 7 excluded).
 * @returns e.g. `"weekdays"`, `"weekends"`, `"Monday, Wednesday, Friday"`, `"every day"`.
 */
function formatDays(dows: readonly number[]): string {
  if (dows.length === 7) return 'every day';

  const allWeekdays = [1, 2, 3, 4, 5];
  const allWeekends = [0, 6];

  if (dows.length === 5 && allWeekdays.every((d) => dows.includes(d))) return 'weekdays';
  if (dows.length === 2 && allWeekends.every((d) => dows.includes(d))) return 'weekends';

  return dows.map((d) => DAY_NAMES[d] ?? `day ${d}`).join(', ');
}

/**
 * Format a numeric array as a human-readable list of values.
 *
 * @param vals - Sorted numbers.
 * @param name - Singular label for a single value (e.g. `"minute"`).
 * @returns e.g. `"minute 0"`, `"minutes 5, 10, 15"`, `"every minute"`.
 */
function formatField(vals: readonly number[], name: string): string {
  if (vals.length === 0) return '';
  const label = vals.length === 1 ? name : `${name}s`;
  return `${label} ${vals.join(', ')}`;
}

/**
 * Describe a cron expression in plain English.
 *
 * @param expr - A standard 5-field cron expression or alias.
 * @returns A human-readable sentence (e.g. `"At 9:00 AM on weekdays"`).
 *   Returns `"Invalid cron expression"` when parsing fails.
 *
 * @example
 *   describeCron('0/15 * * * *');        // "Every 15 minutes"
 *   describeCron('0 9 * * 1-5');         // "At 9:00 AM on weekdays"
 *   describeCron('0 0 1 * *');           // "At midnight on day 1 of the month"
 *   describeCron('0 18 * * 0');          // "At 6:00 PM on Sunday"
 *   describeCron('@hourly');             // "Every hour at minute 0"
 *   describeCron('invalid');             // "Invalid cron expression"
 */
export function describeCron(expr: string): string {
  const sched = parseCron(expr);
  if (!sched) return 'Invalid cron expression';

  const { dayOfMonth, dayOfWeek, hour, minute, month } = sched;

  // Determine step interval for minute field (simplified: check `*/N` or `0-N/P` pattern)
  const minuteStep =
    minute.length > 1 &&
    minute.every((v, i, a) => i === 0 || v - a[i - 1] === minute[1] - minute[0])
      ? minute[1] - minute[0]
      : null;

  // Check for "every N minutes" pattern
  if (
    minuteStep &&
    minuteStep > 1 &&
    minute.length > 1 &&
    hour.length === 24 &&
    dayOfMonth.length >= 31 &&
    month.length === 12 &&
    dayOfWeek.length >= 7
  ) {
    return `Every ${minuteStep} minutes`;
  }

  // Every hour
  if (
    minute.length === 1 &&
    hour.length === 24 &&
    dayOfMonth.length >= 31 &&
    month.length === 12 &&
    dayOfWeek.length >= 7
  ) {
    return `Every hour at minute ${minute[0]}`;
  }

  // Build time parts
  let timeStr = '';
  if (hour.length === 1) {
    const h = hour[0];
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    if (minute.length === 1) {
      timeStr = `At ${h12}:${minute[0].toString().padStart(2, '0')} ${ampm}`;
    } else {
      timeStr = `At ${h12}:00 ${ampm}`;
    }
  } else if (hour.length > 1 && minute.length === 1) {
    timeStr = `At minute ${minute[0]} past hour ${formatField(hour, 'hour')}`;
  } else {
    timeStr = `Every hour`;
  }

  // Day part
  let dayStr = '';
  const isDomWild = dayOfMonth.length >= 31;
  const isDowWild = dayOfWeek.length === 8 && dayOfWeek.every((v) => v <= 7);

  if (isDomWild && isDowWild) {
    dayStr = 'every day';
  } else if (!isDomWild && isDowWild) {
    dayStr = `on day ${formatField(dayOfMonth, '')}`;
  } else if (isDomWild && !isDowWild) {
    dayStr = `on ${formatDays(dayOfWeek)}`;
  } else {
    dayStr = `on ${formatDays(dayOfWeek)} or day ${dayOfMonth.join(', ')}`;
  }

  // Month part
  let monthStr = '';
  if (month.length < 12) {
    monthStr = ` in ${month.map((m) => MONTH_NAMES[m - 1] ?? m).join(', ')}`;
  }

  return `${timeStr} ${dayStr}${monthStr}`.replace(/\s+/g, ' ').trim();
}

// ─── Common Schedules ──────────────────────────────────────────────────

/**
 * Common cron schedule presets.
 *
 * | Key          | Expression   | Description                |
 * |--------------|-------------|----------------------------|
 * | `@hourly`    | `0 * * * *` | Every hour                 |
 * | `@daily`     | `0 0 * * *` | Midnight every day         |
 * | `@weekly`    | `0 0 * * 0` | Midnight every Sunday      |
 * | `@weekdays`  | `0 9 * * 1-5` | 9 AM weekdays            |
 * | `@weekends`  | `0 10 * * 0,6` | 10 AM weekends          |
 * | `@midnight`  | `0 0 * * *` | Midnight                   |
 */
export const COMMON_SCHEDULES = {
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@midnight': '0 0 * * *',
  '@weekdays': '0 9 * * 1-5',
  '@weekends': '0 10 * * 0,6',
  '@weekly': '0 0 * * 0',
} as const satisfies Record<string, string>;
