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

/**
 * The PARENT prefix for "up" navigation in delimiter-grouped R2 browsing: drop the trailing delimiter,
 * then everything after the (new) last delimiter. A top-level prefix (or empty) → `''` (the root). These
 * are key-prefixes, NOT real directories — R2 keys are flat; the delimiter is a display grouping only. Pure.
 *
 * @example r2ParentPrefix('logs/2026/01/') // 'logs/2026/'
 * @example r2ParentPrefix('logs/')         // ''
 * @example r2ParentPrefix('')              // ''
 */
export function r2ParentPrefix(prefix: string, delimiter = '/'): string {
  const trimmed = prefix.endsWith(delimiter) ? prefix.slice(0, -delimiter.length) : prefix;
  const idx = trimmed.lastIndexOf(delimiter);

  return idx >= 0 ? trimmed.slice(0, idx + delimiter.length) : '';
}

/**
 * The display LABEL for a delimited "folder" prefix — the segment after the current prefix (so
 * `logs/2026/` under `logs/` shows as `2026/`). Falls back to the full prefix when it doesn't start with
 * the current one. Pure — a cosmetic shortening, never changes the value clicked.
 *
 * @example r2PrefixLabel('logs/2026/', 'logs/') // '2026/'
 * @example r2PrefixLabel('images/', '')         // 'images/'
 */
export function r2PrefixLabel(fullPrefix: string, currentPrefix: string): string {
  return fullPrefix.startsWith(currentPrefix) ? fullPrefix.slice(currentPrefix.length) : fullPrefix;
}
