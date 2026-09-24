/**
 * Shared CSV + text-download helpers for admin data grids.
 *
 * `toCsv` is pure and RFC-4180-safe (a field containing a comma, quote, CR, or LF
 * is wrapped in quotes with inner quotes doubled); `downloadText` is the thin,
 * impure Blob → object-URL → anchor-click side-effect. Extracted so the owner Data
 * grid (and, over time, the per-component `toCsv()`/`exportCsv()` copies in
 * events-table / audit / forms / analytics) share one tested implementation.
 */

/**
 * Escape one CSV field per RFC 4180. `null`/`undefined` → empty; objects → compact
 * JSON; a field with `,` `"` CR or LF is quoted and its inner quotes doubled.
 *
 * @example csvEscape('a,"b"') // => '"a,""b"""'
 * @example csvEscape(null)    // => ''
 */
export function csvEscape(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize rows to a CSV document with a header row of `columns`. Only the given
 * columns are emitted (in order); every cell is {@link csvEscape}d. Ends in a
 * trailing newline; empty `rows` yields the header line alone.
 *
 * @example toCsv([{ a: 1, b: null }], ['a', 'b']) // => 'a,b\n1,\n'
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): string {
  const header = columns.map(csvEscape).join(',');
  const body = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...body].join('\n') + '\n';
}

/**
 * Trigger a client-side file download of `text`. Impure — creates a Blob, an
 * object URL, and a transient anchor, clicks it, then revokes the URL. No-op on
 * empty text so an export button never downloads a blank file.
 *
 * @remarks Impure — touches `document`/`URL`. Guard callers on having data first.
 */
export function downloadText(
  filename: string,
  text: string,
  mime = 'text/plain;charset=utf-8',
): void {
  if (!text) return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
