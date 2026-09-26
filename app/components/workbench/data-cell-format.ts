/**
 * data-cell-format.ts
 * Pure, zero-dependency type-aware cell classification for the bolt.diy
 * DataPanel grid (SQLite / D1, dark theme).
 *
 * Resolves the #1 SQLite-console confusion: NULL vs empty-string vs 0 vs false
 * are all visually and semantically distinct.
 */

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/** Semantic kind for a single grid cell value. */
export type CellKind = 'null' | 'empty' | 'number' | 'boolean' | 'json' | 'url' | 'email' | 'date' | 'blob' | 'text';

/**
 * Result of classifying a raw SQLite cell value for the dark-theme DataPanel.
 *
 * @example
 * const c = classifyCell(null);
 * // { kind: 'null', display: 'NULL', className: '...', isJson: false }
 */
export interface ClassifiedCell {
  /** Semantic type of the value. */
  kind: CellKind;

  /**
   * Human-readable display string:
   * - null/undefined → `'NULL'`
   * - empty string   → `'""'`
   * - objects/arrays → compact JSON
   * - everything else → `String(value)`
   */
  display: string;

  /**
   * Tailwind / UnoCSS utility classes for the cell text element.
   * Uses bolt-elements-* design tokens plus brand accents where appropriate:
   * - null/empty : muted italic  (`bolt-elements-textTertiary italic opacity-60`)
   * - number     : amber accent  (`text-[#f5c451] tabular-nums`)
   * - boolean    : cyan accent   (`text-[#00E5FF] font-medium`)
   * - json       : muted mono    (`bolt-elements-textTertiary font-mono text-xs`)
   * - text       : default ink   (`bolt-elements-textPrimary`)
   */
  className: string;

  /**
   * `true` when the value IS an object/array or is a string that
   * JSON.parses to a non-primitive (object or array).
   */
  isJson: boolean;

  /**
   * A SAFE, clickable target when the value is a whole-string `http(s)` URL
   * (`href` = the URL) or a single email address (`href` = `mailto:<addr>`).
   * `undefined` for every other kind. Only `http:`/`https:`/`mailto:` are ever
   * produced — a `javascript:` / `data:` / `vbscript:` value never matches, so it
   * can never become a clickable link (no XSS). This is a UI INTERPRETATION of a
   * text value: SQLite stores text, and the grid presents a link affordance.
   */
  href?: string;

  /**
   * The RAW stored value when {@link display} is a reformatted interpretation (currently: a `date` —
   * an ISO-8601 value shown human-readably). Rendered as the cell's tooltip so the exact stored value
   * is always one hover away — the reformatting is honest, never lossy. `undefined` when display IS
   * the raw value.
   */
  title?: string;
}

/*
 * ---------------------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Attempt to JSON-parse a string; return the parsed value on success or
 * `undefined` when the string is not valid JSON or parses to a primitive.
 */
function tryParseJson(s: string): object | unknown[] | undefined {
  if (s.length < 2) {
    return undefined;
  }

  const first = s.charCodeAt(0);

  // Fast-exit: only attempt strings that start with { or [
  if (first !== 123 /* { */ && first !== 91 /* [ */) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(s);

    if (parsed !== null && typeof parsed === 'object') {
      return parsed as object | unknown[];
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/** Compact JSON serialisation (no pretty-print). */
function toCompactJson(value: object | unknown[]): string {
  return JSON.stringify(value);
}

/*
 * ---------------------------------------------------------------------------
 * Class-name constants (dark theme, bolt-elements-* + brand tokens)
 * ---------------------------------------------------------------------------
 */
const CLASS_NULL = 'bolt-elements-textTertiary italic opacity-60 select-none';
const CLASS_EMPTY = 'bolt-elements-textTertiary italic opacity-50 select-none';
const CLASS_NUMBER = 'text-[#f5c451] tabular-nums';
const CLASS_BOOLEAN = 'text-[#00E5FF] font-medium';
const CLASS_JSON = 'bolt-elements-textTertiary font-mono text-xs break-all';
const CLASS_TEXT = 'bolt-elements-textPrimary';

// url / email render as a brand-cyan link affordance (dotted → solid on hover).
const CLASS_LINK = 'text-[#00E5FF] underline decoration-dotted underline-offset-2 hover:decoration-solid break-all';

/**
 * Whole-string `http(s)` URL. SAFE WEB SCHEMES ONLY — `javascript:` / `data:` /
 * `vbscript:` / `file:` never match, so such a value can never be emitted as an
 * `<a href>` (XSS guard). Anchored start+end so prose that merely CONTAINS a URL
 * stays plain text.
 */
const URL_RE = /^https?:\/\/[^\s]+$/i;

/**
 * Whole-string single email address (tight, anchored) → prose that merely
 * contains an `@` is NOT classified as email. Checked AFTER {@link URL_RE} so an
 * `http://user@host.tld/…` userinfo URL is read as a URL, not an email.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// date renders in a soft blue so a reformatted timestamp reads as a date, distinct from plain text.
const CLASS_DATE = 'text-[#8ab4f8]';

/** Whole-string ISO-8601 calendar DATE (`YYYY-MM-DD`) — no time, so no timezone ambiguity. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole-string ISO-8601 DATETIME with an EXPLICIT zone (`Z` or `±HH:MM`) — an unambiguous instant. A
 * zone-LESS datetime (`2024-01-01T12:00:00` / `2024-01-01 12:00:00`) is deliberately NOT matched: we
 * won't GUESS whether it's UTC or local (SQLite stores it as-is) — that would be a dishonest display.
 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Reformat an unambiguous ISO-8601 value for HONEST display (the raw value is kept as the cell tooltip):
 * a bare date → a readable calendar date in UTC (so `2024-01-01` never shifts a day); a zone-marked
 * datetime → a readable local date+time (an absolute instant shown in the viewer's zone). Anything else
 * (incl. a zone-less datetime, or an unparseable value) → `null` (the caller keeps it as plain text).
 * Uses the runtime's locale + zone (the viewer's), so the exact string is environment-dependent — hence
 * the raw is always preserved in the tooltip.
 */
function formatIsoForDisplay(raw: string): string | null {
  if (ISO_DATE_RE.test(raw)) {
    const d = new Date(raw); // parsed as UTC midnight

    if (Number.isNaN(d.getTime())) {
      return null;
    }

    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  if (ISO_DATETIME_RE.test(raw)) {
    const d = new Date(raw);

    if (Number.isNaN(d.getTime())) {
      return null;
    }

    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return null;
}

/**
 * The UTC calendar day (`YYYY-MM-DD`) of an UNAMBIGUOUS ISO-8601 value — a bare date (kept as-is,
 * SQLite stores it UTC-neutral) or a zone-marked datetime (converted to its UTC day). Anything else —
 * a zone-LESS datetime (ambiguous: we won't guess UTC-vs-local), a number, a non-ISO string, null —
 * returns `null`. Deliberately STRICT (regex-gated, not `new Date()` coercion) so it can safely drive
 * calendar date-column AUTO-DETECTION without a numeric id like `20240101` — which `new Date(n)` would
 * happily parse as a 1970 millisecond timestamp — being mistaken for a date column.
 *
 * @param value - a raw SQLite/D1 cell value
 * @returns the UTC `YYYY-MM-DD` day key, or `null` when the value isn't an unambiguous ISO date
 * @example isoDayKey('2024-01-01')                 // '2024-01-01'
 * @example isoDayKey('2024-01-01T23:30:00-05:00')  // '2024-01-02'  (04:30 UTC next day)
 * @example isoDayKey('2024-01-01T12:00:00')        // null          (zone-less → ambiguous)
 * @example isoDayKey(20240101)                     // null          (a number is not a date)
 */
export function isoDayKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (ISO_DATE_RE.test(value)) {
    /*
     * Shape-matched, but the regex doesn't range-check — reject an impossible date (e.g. 2024-13-45)
     * so a column full of junk that merely LOOKS date-shaped isn't auto-picked as a calendar date.
     */
    const d = new Date(value); // a bare ISO date parses as UTC midnight
    return Number.isNaN(d.getTime()) ? null : value; // valid → the string IS its own UTC calendar day
  }

  if (ISO_DATETIME_RE.test(value)) {
    const d = new Date(value); // has an explicit zone → an unambiguous instant

    if (Number.isNaN(d.getTime())) {
      return null;
    }

    return d.toISOString().slice(0, 10); // its UTC calendar day
  }

  return null;
}

// blob renders in a muted violet mono so a binary value reads as "not editable text", distinct from JSON.
const CLASS_BLOB = 'text-[#b39ddb] font-mono text-xs select-none';

/** A BLOB cell as serialized by the worker (a raw `ArrayBuffer` would JSON-encode to a useless `{}`). */
export interface BlobCellInfo {
  /** Byte length of the binary value. */
  bytes: number;

  /** Space-separated hex of the first bytes (a preview, e.g. `'89 50 4e 47'`). May be empty. */
  hex: string;
}

/**
 * Detect the worker's BLOB envelope (`{ __blob: true, bytes, hex }`) — the honest wire form of a D1
 * `ArrayBuffer` cell (which JSON.stringify would otherwise mangle to `{}`, indistinguishable from an
 * empty object). Returns the `{bytes,hex}` info or `null` for any non-blob value. Pure, never throws.
 *
 * @example blobCellInfo({ __blob: true, bytes: 4, hex: '89 50 4e 47' }) // { bytes: 4, hex: '89 50 4e 47' }
 * @example blobCellInfo({ a: 1 })                                        // null
 */
export function blobCellInfo(value: unknown): BlobCellInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const rec = value as Record<string, unknown>;

  if (rec.__blob !== true) {
    return null;
  }

  return {
    bytes: typeof rec.bytes === 'number' && rec.bytes >= 0 ? rec.bytes : 0,
    hex: typeof rec.hex === 'string' ? rec.hex : '',
  };
}

/** Humanize a byte count for a compact cell label: `900 B` · `1.2 KB` · `3.4 MB`. Pure. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '0 B';
  }

  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }

  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/*
 * ---------------------------------------------------------------------------
 * Primary export: classifyCell
 * ---------------------------------------------------------------------------
 */

/**
 * Classify a raw SQLite / D1 cell value into a `ClassifiedCell` descriptor.
 *
 * Classification rules (in priority order):
 * 1. `null` / `undefined`              → kind `'null'`
 * 2. Empty string `''`                  → kind `'empty'`
 * 3. `boolean` or string `'true'`/`'false'` → kind `'boolean'`
 * 4. `number` (finite or special) or   → kind `'number'`
 *    a string that coerces to a finite number via `Number()`
 * 5. Plain `object` / `Array`           → kind `'json'`  (isJson = true)
 * 6. String that JSON.parses to obj/arr → kind `'json'`  (isJson = true)
 * 7. Whole-string http(s) URL           → kind `'url'`   (href = the URL)
 * 8. Whole-string email address         → kind `'email'` (href = `mailto:<addr>`)
 * 9. All other strings                  → kind `'text'`
 *
 * @param value - Raw value as returned by a SQLite / D1 query row.
 * @returns A fully-populated {@link ClassifiedCell}.
 *
 * @example
 * classifyCell(null)                 // kind:'null',  display:'NULL'
 * classifyCell('')                   // kind:'empty', display:'""'
 * classifyCell(0)                    // kind:'number', display:'0'
 * classifyCell('42')                 // kind:'number', display:'42'
 * classifyCell(false)                // kind:'boolean', display:'false'
 * classifyCell({a:1})                // kind:'json', display:'{"a":1}', isJson:true
 * classifyCell('https://a.com/x')    // kind:'url',   href:'https://a.com/x'
 * classifyCell('me@a.com')           // kind:'email', href:'mailto:me@a.com'
 * classifyCell('javascript:alert(1)')// kind:'text'  (unsafe scheme → never a link)
 * classifyCell('hello')              // kind:'text', display:'hello'
 */
export function classifyCell(value: unknown): ClassifiedCell {
  // 1. null / undefined
  if (value === null || value === undefined) {
    return {
      kind: 'null',
      display: 'NULL',
      className: CLASS_NULL,
      isJson: false,
    };
  }

  // 2. Empty string
  if (value === '') {
    return {
      kind: 'empty',
      display: '""',
      className: CLASS_EMPTY,
      isJson: false,
    };
  }

  // 3. Native boolean
  if (typeof value === 'boolean') {
    return {
      kind: 'boolean',
      display: String(value),
      className: CLASS_BOOLEAN,
      isJson: false,
    };
  }

  // 4. Native number
  if (typeof value === 'number') {
    return {
      kind: 'number',
      display: String(value),
      className: CLASS_NUMBER,
      isJson: false,
    };
  }

  /*
   * 5. BLOB envelope (worker-serialized binary) — a read-only "BLOB · N bytes" chip, NEVER editable
   *    text. Checked before the generic object branch (a blob envelope IS an object). Raw = hex tooltip.
   */
  const blob = blobCellInfo(value);

  if (blob) {
    return {
      kind: 'blob',
      display: `BLOB · ${humanBytes(blob.bytes)}`,
      className: CLASS_BLOB,
      isJson: false,
      title: blob.hex ? `${blob.hex}${blob.bytes > 16 ? ' …' : ''}` : undefined,
    };
  }

  // 6. Objects / arrays (non-null, already excluded null above)
  if (typeof value === 'object') {
    const display = toCompactJson(value as object | unknown[]);
    return {
      kind: 'json',
      display,
      className: CLASS_JSON,
      isJson: true,
    };
  }

  // --- From here value is a non-empty string ---
  const str = value as string;

  // 6. String boolean literals
  if (str === 'true' || str === 'false') {
    return {
      kind: 'boolean',
      display: str,
      className: CLASS_BOOLEAN,
      isJson: false,
    };
  }

  /*
   * 7. Numeric string: Number(str) is finite and not whitespace-only
   *    (Number('') is 0 — but '' already handled above; Number(' ') is 0 too — guard with trim)
   */
  const trimmed = str.trim();

  if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) {
    return {
      kind: 'number',
      display: str,
      className: CLASS_NUMBER,
      isJson: false,
    };
  }

  // 8. JSON-parseable string → object or array
  const parsed = tryParseJson(str);

  if (parsed !== undefined) {
    return {
      kind: 'json',
      display: toCompactJson(parsed as object | unknown[]),
      className: CLASS_JSON,
      isJson: true,
    };
  }

  /*
   * 8b. Unambiguous ISO-8601 date / zone-marked datetime → readable display, RAW kept as `title`
   *     (the tooltip) so the reformatting is honest + never lossy. A zone-less datetime stays text
   *     (we don't guess its timezone). See {@link formatIsoForDisplay}.
   */
  const isoDisplay = formatIsoForDisplay(str);

  if (isoDisplay !== null) {
    return { kind: 'date', display: isoDisplay, className: CLASS_DATE, isJson: false, title: str };
  }

  /*
   * 9. http(s) URL (whole string) → external-link affordance. Checked BEFORE
   *    email so a userinfo URL (http://user@host.tld) is a URL, not an email.
   *    Only http/https reach here as an href → javascript:/data: can't be linked.
   */
  if (URL_RE.test(str)) {
    return { kind: 'url', display: str, className: CLASS_LINK, isJson: false, href: str };
  }

  // 10. Single email address (whole string) → mailto affordance.
  if (EMAIL_RE.test(str)) {
    return {
      kind: 'email',
      display: str,
      className: CLASS_LINK,
      isJson: false,
      href: `mailto:${str}`,
    };
  }

  // 11. Plain text
  return {
    kind: 'text',
    display: str,
    className: CLASS_TEXT,
    isJson: false,
  };
}

/*
 * ---------------------------------------------------------------------------
 * SQLite affinity mapping
 * ---------------------------------------------------------------------------
 */

/**
 * SQLite type affinity rules (§3.1 of the SQLite docs).
 * Maps a declared column type to a short badge label + tooltip title.
 *
 * Affinity decision table (first match wins):
 * - contains `INT`             → INTEGER  → badge `INT`
 * - contains `CHAR`, `CLOB`, or `TEXT` → TEXT → badge `TEXT`
 * - contains `BLOB` or empty   → BLOB     → badge `BLOB`
 * - contains `REAL`, `FLOA`, or `DOUB` → REAL → badge `REAL`
 * - anything else              → NUMERIC  → badge `NUM`
 *
 * @param declaredType - The raw `type` field from `PRAGMA table_info(t)`.
 *   May be `null`, `undefined`, or an empty string for un-typed columns.
 * @returns A `{ label, title }` badge descriptor, or `null` when
 *   `declaredType` is null/undefined/empty (no badge rendered).
 *
 * @example
 * columnTypeBadge('INTEGER')        // { label: 'INT',  title: 'INTEGER' }
 * columnTypeBadge('VARCHAR(255)')   // { label: 'TEXT', title: 'VARCHAR(255)' }
 * columnTypeBadge('DOUBLE')         // { label: 'REAL', title: 'DOUBLE' }
 * columnTypeBadge('BLOB')           // { label: 'BLOB', title: 'BLOB' }
 * columnTypeBadge('NUMERIC')        // { label: 'NUM',  title: 'NUMERIC' }
 * columnTypeBadge(null)             // null
 * columnTypeBadge('')               // null
 */
export function columnTypeBadge(declaredType: string | null | undefined): { label: string; title: string } | null {
  if (declaredType === null || declaredType === undefined) {
    return null;
  }

  const t = declaredType.trim();

  if (t === '') {
    return null;
  }

  const upper = t.toUpperCase();

  // SQLite affinity rule 1: INT substring
  if (upper.includes('INT')) {
    return { label: 'INT', title: t };
  }

  // SQLite affinity rule 2: CHAR, CLOB, TEXT
  if (upper.includes('CHAR') || upper.includes('CLOB') || upper.includes('TEXT')) {
    return { label: 'TEXT', title: t };
  }

  // SQLite affinity rule 3: BLOB (or no type — but no-type already returned null above)
  if (upper.includes('BLOB')) {
    return { label: 'BLOB', title: t };
  }

  // SQLite affinity rule 4: REAL, FLOA, DOUB
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) {
    return { label: 'REAL', title: t };
  }

  // Rule 5: everything else → NUMERIC affinity
  return { label: 'NUM', title: t };
}
