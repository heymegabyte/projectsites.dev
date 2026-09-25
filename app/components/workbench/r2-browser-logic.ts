/**
 * @file Pure helper functions for the R2 Browser Data panel tab.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library. All functions are pure (same input →
 * same output, no side-effects) so they can be tested with `node --experimental-strip-types` or any
 * Vitest runner without module mocking. Sibling of {@link ./kv-browser-logic}.
 */

// ── formatBytes ───────────────────────────────────────────────────────────────

/**
 * Format a byte count as a human-readable size (base-1024, one decimal).
 *
 * @param bytes - The object size in bytes. Non-finite or negative → `"0 B"`.
 * @returns e.g. `"0 B"`, `"512 B"`, `"1.2 KB"`, `"3.4 MB"`, `"1.1 GB"`, `"2.3 TB"`.
 *
 * @example formatBytes(0)        // → "0 B"
 * @example formatBytes(1536)     // → "1.5 KB"
 * @example formatBytes(5_242_880) // → "5.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Bytes render as whole numbers; larger units get one decimal.
  const formatted = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

// ── formatUploaded ──────────────────────────────────────────────────────────

/**
 * Convert an ISO-8601 upload timestamp to a short relative-time string.
 *
 * @param iso - The object's `uploaded` ISO string, or `null` when unavailable.
 * @param now - The current unix timestamp in **milliseconds** (injectable for tests).
 * @returns `"—"` (null/unparseable), `"just now"`, `"5m ago"`, `"3h ago"`, or `"2d ago"`.
 *
 * @example formatUploaded(null, 1_700_000_000_000)                       // → "—"
 * @example formatUploaded('2023-11-14T22:00:00Z', 1_700_000_000_000)     // → "just now"
 */
export function formatUploaded(iso: string | null, now: number): string {
  if (iso === null) {
    return '—';
  }

  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return '—';
  }

  const diffSeconds = Math.floor((now - t) / 1000);

  if (diffSeconds < 60) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ── isPreviewableContentType ──────────────────────────────────────────────────

/**
 * Whether an object's content-type is one a browser could safely preview (drives a future preview
 * hint; the current inspector is metadata-only).
 *
 * @param contentType - The object's `contentType`, or `null` when unknown.
 * @returns `true` for `image/*`, `text/*`, and `application/json`; else `false`.
 *
 * @example isPreviewableContentType('image/png')       // → true
 * @example isPreviewableContentType('application/pdf')  // → false
 * @example isPreviewableContentType(null)               // → false
 */
export function isPreviewableContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  const ct = contentType.toLowerCase();
  return ct.startsWith('image/') || ct.startsWith('text/') || ct === 'application/json';
}
