/**
 * data-cell-format.ts
 * Pure, zero-dependency type-aware cell classification for the bolt.diy
 * DataPanel grid (SQLite / D1, dark theme).
 *
 * Resolves the #1 SQLite-console confusion: NULL vs empty-string vs 0 vs false
 * are all visually and semantically distinct.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Semantic kind for a single grid cell value. */
export type CellKind =
  | 'null'
  | 'empty'
  | 'number'
  | 'boolean'
  | 'json'
  | 'text';

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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to JSON-parse a string; return the parsed value on success or
 * `undefined` when the string is not valid JSON or parses to a primitive.
 */
function tryParseJson(s: string): object | unknown[] | undefined {
  if (s.length < 2) return undefined;
  const first = s.charCodeAt(0);
  // Fast-exit: only attempt strings that start with { or [
  if (first !== 123 /* { */ && first !== 91 /* [ */) return undefined;
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

// ---------------------------------------------------------------------------
// Class-name constants (dark theme, bolt-elements-* + brand tokens)
// ---------------------------------------------------------------------------
const CLASS_NULL = 'bolt-elements-textTertiary italic opacity-60 select-none';
const CLASS_EMPTY = 'bolt-elements-textTertiary italic opacity-50 select-none';
const CLASS_NUMBER = 'text-[#f5c451] tabular-nums';
const CLASS_BOOLEAN = 'text-[#00E5FF] font-medium';
const CLASS_JSON = 'bolt-elements-textTertiary font-mono text-xs break-all';
const CLASS_TEXT = 'bolt-elements-textPrimary';

// ---------------------------------------------------------------------------
// Primary export: classifyCell
// ---------------------------------------------------------------------------

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
 * 7. All other strings                  → kind `'text'`
 *
 * @param value - Raw value as returned by a SQLite / D1 query row.
 * @returns A fully-populated {@link ClassifiedCell}.
 *
 * @example
 * classifyCell(null)       // kind:'null',  display:'NULL'
 * classifyCell('')         // kind:'empty', display:'""'
 * classifyCell(0)          // kind:'number', display:'0'
 * classifyCell('42')       // kind:'number', display:'42'
 * classifyCell(false)      // kind:'boolean', display:'false'
 * classifyCell('true')     // kind:'boolean', display:'true'
 * classifyCell({a:1})      // kind:'json', display:'{"a":1}', isJson:true
 * classifyCell('[1,2]')    // kind:'json', display:'[1,2]',   isJson:true
 * classifyCell('hello')    // kind:'text', display:'hello'
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

  // 5. Objects / arrays (non-null, already excluded null above)
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

  // 7. Numeric string: Number(str) is finite and not whitespace-only
  //    (Number('') is 0 — but '' already handled above; Number(' ') is 0 too — guard with trim)
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

  // 9. Plain text
  return {
    kind: 'text',
    display: str,
    className: CLASS_TEXT,
    isJson: false,
  };
}

// ---------------------------------------------------------------------------
// SQLite affinity mapping
// ---------------------------------------------------------------------------

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
export function columnTypeBadge(
  declaredType: string | null | undefined,
): { label: string; title: string } | null {
  if (declaredType === null || declaredType === undefined) return null;
  const t = declaredType.trim();
  if (t === '') return null;

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
