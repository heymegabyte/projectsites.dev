/**
 * @file Airtable-style field-type registry for the per-site data platform.
 *
 * Provides a rich, typed field system layered over SQLite column storage. Each
 * `FieldTypeDef` knows how to coerce a raw string input into a `FieldValue` ready
 * to bind in a SQL parameter slot, and how to format a stored value back to a
 * human-readable string.
 *
 * This module is pure (no I/O, no imports) and safe to use in both the Remix app
 * bundle and Vitest unit tests.
 *
 * @module field-types
 */

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * All supported field kinds for the per-site data platform.
 * Mirrors the Airtable field set, constrained to what SQLite can store natively.
 */
export type FieldKind =
  | 'text'
  | 'longText'
  | 'number'
  | 'boolean'
  | 'date'
  | 'singleSelect'
  | 'multiSelect'
  | 'json'
  | 'attachment'
  | 'rating';

/**
 * A value ready to bind as a SQLite positional parameter.
 * Mirrors `BoundValue` from `data-panel-logic.ts` — intentionally kept in sync.
 */
export type FieldValue = string | number | boolean | null;

/**
 * Full descriptor for one field kind: metadata, storage type, coerce, and format.
 *
 * @example
 * const def = FIELD_TYPES['number'];
 * const bound = def.coerce('3.14');   // 3.14
 * const human = def.format(3.14);    // '3.14'
 */
export interface FieldTypeDef {
  /** Discriminator — must equal the key in `FIELD_TYPES`. */
  readonly kind: FieldKind;

  /** Human-readable display name (e.g. "Long text", "Single select"). */
  readonly label: string;

  /** SQLite storage class for DDL generation. */
  readonly sqliteType: 'TEXT' | 'INTEGER' | 'REAL';

  /**
   * Coerce a raw string (from user input or CSV) into a `FieldValue` suitable
   * for SQLite binding. Must return `null` for empty / invalid inputs that should
   * map to SQL NULL. Throws `FieldCoerceError` for structurally invalid input
   * (e.g. malformed JSON).
   *
   * @param raw - raw string value from user input or CSV cell
   * @returns coerced value ready to bind
   * @throws {FieldCoerceError} when `raw` cannot be coerced
   */
  coerce(raw: string): FieldValue;

  /**
   * Format a stored SQLite value for display in the grid or detail pane.
   * Must never throw — returns `''` for null/undefined/unsupported shapes.
   *
   * @param value - raw value as returned from a D1 query result
   * @returns human-readable string (may be empty)
   */
  format(value: unknown): string;
}

/*
 * ---------------------------------------------------------------------------
 * Error class
 * ---------------------------------------------------------------------------
 */

/**
 * Thrown by {@link FieldTypeDef.coerce} when the raw input cannot be converted
 * to the target field kind (e.g. invalid JSON, invalid date).
 *
 * @example
 * try {
 *   FIELD_TYPES['json'].coerce('not json');
 * } catch (e) {
 *   if (e instanceof FieldCoerceError) console.warn(e.message);
 * }
 */
export class FieldCoerceError extends Error {
  /** @param message - human-readable description of why coercion failed */
  constructor(message: string) {
    super(message);
    this.name = 'FieldCoerceError';

    // Ensure correct prototype chain in transpiled environments.
    Object.setPrototypeOf(this, FieldCoerceError.prototype);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------------------------
 */

/** Returns `null` if `s` is blank after trimming, otherwise the trimmed string. */
function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t === '' ? null : t;
}

/** Parses `raw` as an ISO date string (YYYY-MM-DD). Returns `null` on failure. */
function parseIsoDate(raw: string): string | null {
  const t = raw.trim();

  if (t === '') {
    return null;
  }

  // Accept any string that resolves to a valid date; normalise to YYYY-MM-DD.
  const d = new Date(t);

  if (isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString().slice(0, 10);
}

/** Clamps `n` to the inclusive range [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/*
 * ---------------------------------------------------------------------------
 * Field type definitions
 * ---------------------------------------------------------------------------
 */

/**
 * Registry of all supported field kinds.
 *
 * Access via {@link fieldTypeFor} for a type-safe lookup.
 *
 * @example
 * FIELD_TYPES['boolean'].coerce('yes');  // 1
 * FIELD_TYPES['rating'].format(3);       // '★★★☆☆'
 */
export const FIELD_TYPES: Readonly<Record<FieldKind, FieldTypeDef>> = {
  // -------------------------------------------------------------------------
  text: {
    kind: 'text',
    label: 'Text',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      return trimOrNull(raw);
    },
    format(value: unknown): string {
      return value == null ? '' : String(value);
    },
  },

  // -------------------------------------------------------------------------
  longText: {
    kind: 'longText',
    label: 'Long text',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      return trimOrNull(raw);
    },
    format(value: unknown): string {
      return value == null ? '' : String(value);
    },
  },

  // -------------------------------------------------------------------------
  number: {
    kind: 'number',
    label: 'Number',
    sqliteType: 'REAL',
    coerce(raw: string): FieldValue {
      const t = raw.trim();

      if (t === '') {
        return null;
      }

      const n = Number(t);

      if (!Number.isFinite(n)) {
        return null;
      }

      return n;
    },
    format(value: unknown): string {
      if (value == null) {
        return '';
      }

      const n = Number(value);

      if (!Number.isFinite(n)) {
        return '';
      }

      return n.toLocaleString();
    },
  },

  // -------------------------------------------------------------------------
  boolean: {
    kind: 'boolean',
    label: 'Checkbox',
    sqliteType: 'INTEGER',
    coerce(raw: string): FieldValue {
      const t = raw.trim().toLowerCase();

      if (t === 'true' || t === '1' || t === 'yes') {
        return 1;
      }

      // Treat empty, 'false', '0', 'no' all as 0.
      return 0;
    },
    format(value: unknown): string {
      // Stored as INTEGER 1 or 0.
      return value === 1 || value === true ? '✓' : '';
    },
  },

  // -------------------------------------------------------------------------
  date: {
    kind: 'date',
    label: 'Date',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      return parseIsoDate(raw);
    },
    format(value: unknown): string {
      if (value == null) {
        return '';
      }

      return String(value);
    },
  },

  // -------------------------------------------------------------------------
  singleSelect: {
    kind: 'singleSelect',
    label: 'Single select',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      return trimOrNull(raw);
    },
    format(value: unknown): string {
      return value == null ? '' : String(value);
    },
  },

  // -------------------------------------------------------------------------
  multiSelect: {
    kind: 'multiSelect',
    label: 'Multi select',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      if (raw.trim() === '') {
        return null;
      }

      // Accept a comma-separated list; each item is trimmed and empty items are dropped.
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');

      if (items.length === 0) {
        return null;
      }

      return JSON.stringify(items);
    },
    format(value: unknown): string {
      if (value == null) {
        return '';
      }

      if (typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);

          if (Array.isArray(parsed)) {
            return parsed.map(String).join(', ');
          }

          // Stored as bare string (legacy), treat as single-item.
          return value;
        } catch {
          return value;
        }
      }

      if (Array.isArray(value)) {
        return value.map(String).join(', ');
      }

      return String(value);
    },
  },

  // -------------------------------------------------------------------------
  json: {
    kind: 'json',
    label: 'JSON',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      const t = raw.trim();

      if (t === '') {
        return null;
      }

      try {
        JSON.parse(t); // validate only; store the original text (SQLite has no JSON type)
      } catch {
        throw new FieldCoerceError(`The value is not valid JSON: ${raw.length > 60 ? raw.slice(0, 57) + '...' : raw}`);
      }

      return t;
    },
    format(value: unknown): string {
      if (value == null) {
        return '';
      }

      if (typeof value === 'string') {
        // Already stored as text; pretty-print if it parses.
        try {
          return JSON.stringify(JSON.parse(value), null, 2);
        } catch {
          return value;
        }
      }

      // Object / array passed directly.
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    },
  },

  // -------------------------------------------------------------------------
  attachment: {
    kind: 'attachment',
    label: 'Attachment',
    sqliteType: 'TEXT',
    coerce(raw: string): FieldValue {
      // Store URL or storage key as-is; empty → null.
      return trimOrNull(raw);
    },
    format(value: unknown): string {
      if (value == null) {
        return '';
      }

      const s = String(value).trim();

      if (s === '') {
        return '';
      }

      // Return the last path segment as the filename.
      const parts = s.split('/');

      return parts[parts.length - 1] ?? s;
    },
  },

  // -------------------------------------------------------------------------
  rating: {
    kind: 'rating',
    label: 'Rating',
    sqliteType: 'INTEGER',
    coerce(raw: string): FieldValue {
      const t = raw.trim();

      if (t === '') {
        return null;
      }

      const n = Number(t);

      if (!Number.isFinite(n)) {
        return null;
      }

      return clamp(Math.round(n), 0, 5);
    },
    format(value: unknown): string {
      if (value == null) {
        return '';
      }

      const n = clamp(Math.round(Number(value)), 0, 5);

      if (!Number.isFinite(n)) {
        return '';
      }

      return '★'.repeat(n) + '☆'.repeat(5 - n);
    },
  },
} as const;

/*
 * ---------------------------------------------------------------------------
 * Helper
 * ---------------------------------------------------------------------------
 */

/**
 * Type-safe lookup for a field-type definition.
 *
 * @param kind - the field kind to look up
 * @returns the `FieldTypeDef` for the given kind
 * @example
 * const def = fieldTypeFor('rating');
 * def.format(3); // '★★★☆☆'
 */
export function fieldTypeFor(kind: FieldKind): FieldTypeDef {
  return FIELD_TYPES[kind];
}
