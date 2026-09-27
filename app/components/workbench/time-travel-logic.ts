/**
 * @file Pure logic for the D1 Time-Travel restore panel (per-site D1 point-in-time recovery).
 *
 * @remarks
 * Cloudflare D1 Time Travel keeps a rolling window (30 days on Workers Paid) of the database's history. The
 * Time-Travel panel reads the site's OWN D1's LIVE bookmark + as-of-timestamp lookups and can RESTORE the
 * whole database to a chosen point — all through the SAME per-site resource-mutate rail the grid uses
 * (`PS_RES_MUTATE { kind:'d1', action:'time_travel_info' | 'restore' }` → the worker's real CF REST Time-Travel
 * calls bound to the site's server-resolved D1 id). Restore is DESTRUCTIVE (whole-DB revert) and confirm-gated.
 *
 * These helpers are PURE (no React, no bridge, no I/O) so they unit-test in isolation: label formatting, the
 * datetime-local → ISO-8601 conversion the CF `?timestamp=` param needs, timestamp validity + in-window checks,
 * and the human "restores to <time>" copy. Locally-labelled bookmarks (a friendly name the owner gives a saved
 * point) are the panel's only client state — the LIVE bookmark string always comes from the worker, never
 * fabricated.
 */

/** The D1 Time-Travel retention window in days (Workers Paid). Mirrors the worker's `TIME_TRAVEL_RETENTION_DAYS`. */
export const TIME_TRAVEL_RETENTION_DAYS = 30;

/** One owner-saved point-in-time: a friendly label + the LIVE bookmark it was captured at (+ when). */
export interface SavedBookmark {
  /** A short owner-given label ("before the big import"). */
  readonly label: string;

  /** CF's opaque bookmark string captured at save time (feed back to a restore). Never fabricated. */
  readonly bookmark: string;

  /** ISO 8601 instant the label was saved (client clock — for display only). */
  readonly savedAt: string;
}

/**
 * Convert a native `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm` in LOCAL time, no zone) into an
 * ISO 8601 UTC instant (`…Z`) suitable for CF's Time-Travel `?timestamp=` query param. Returns `null` for an
 * empty / unparseable value so the caller can disable the restore button rather than send garbage.
 *
 * @example datetimeLocalToIso('2026-01-02T09:30') // → e.g. '2026-01-02T14:30:00.000Z' (if local is UTC-5)
 * @example datetimeLocalToIso('')                 // → null
 */
export function datetimeLocalToIso(local: string | undefined | null): string | null {
  if (typeof local !== 'string' || local.trim().length === 0) {
    return null;
  }

  const ms = Date.parse(local);

  if (Number.isNaN(ms)) {
    return null;
  }

  return new Date(ms).toISOString();
}

/**
 * True when an ISO 8601 instant is within the Time-Travel window (`[now - retentionDays, now]`). D1 can only
 * restore to a point inside the window; a timestamp older than that (or in the future) is rejected here so the
 * UI can explain WHY rather than let the CF call fail opaquely.
 *
 * @param iso - an ISO 8601 instant
 * @param now - the current time (injectable for deterministic tests; defaults to `Date.now()`)
 */
export function isWithinWindow(iso: string, now: number = Date.now()): boolean {
  const ms = Date.parse(iso);

  if (Number.isNaN(ms)) {
    return false;
  }

  const windowStart = now - TIME_TRAVEL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Allow a tiny future skew (clock drift) but not a real future timestamp.
  return ms >= windowStart && ms <= now + 60_000;
}

/**
 * A short, human label for a CF bookmark string (which is long + opaque) — the first 8 chars + an ellipsis, so
 * the UI can show which point without dumping the whole token. Empty/short bookmarks pass through unchanged.
 *
 * @example shortBookmark('00000085-0000abcd-…-longopaque') // → '00000085…'
 */
export function shortBookmark(bookmark: string | undefined | null): string {
  if (typeof bookmark !== 'string' || bookmark.length === 0) {
    return '—';
  }

  return bookmark.length > 12 ? `${bookmark.slice(0, 8)}…` : bookmark;
}

/**
 * Format an ISO 8601 instant as a friendly local date-time for display ("Jan 2, 2026, 9:30 AM"). Falls back to
 * the raw string when it can't be parsed (never throws, never hides the truth).
 */
export function formatInstant(iso: string | undefined | null): string {
  if (typeof iso !== 'string' || iso.length === 0) {
    return '—';
  }

  const ms = Date.parse(iso);

  if (Number.isNaN(ms)) {
    return iso;
  }

  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The honest human sentence a restore confirm shows — names the exact target so it's never a blind click. */
export function restoreConfirmMessage(target: { label?: string; timestamp?: string; bookmark?: string }): string {
  const when =
    target.timestamp && target.timestamp.length > 0
      ? formatInstant(target.timestamp)
      : target.label && target.label.length > 0
        ? `“${target.label}”`
        : target.bookmark
          ? `bookmark ${shortBookmark(target.bookmark)}`
          : 'the selected point';
  return `This restores your entire database to ${when}. Every table returns to that point and any changes made after it are permanently lost. This itself can be undone (Time Travel keeps ${TIME_TRAVEL_RETENTION_DAYS} days of history).`;
}

/**
 * Compute the earliest restorable instant (window start) as an ISO string — used as the `min` attribute on the
 * datetime picker so the owner can't pick a point outside the recoverable window.
 *
 * @param now - current time (injectable for tests; defaults to `Date.now()`)
 */
export function windowStartIso(now: number = Date.now()): string {
  return new Date(now - TIME_TRAVEL_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Build the `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`, LOCAL) for a given epoch — used to seed
 * the picker's `min` (window start) + default (now) in the owner's local zone. Returns the 16-char local string.
 */
export function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);

  // Shift by the local zone offset so toISOString's UTC slice reads as local wall-clock.
  const local = new Date(ms - d.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}
