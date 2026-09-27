/**
 * @file Unit tests for the field-type registry.
 *
 * Covers coerce + format for every FieldKind, including:
 * - happy-path round-trips
 * - empty / null edge cases
 * - invalid input handling
 * - boundary conditions (number precision, rating clamp, multiSelect round-trip, etc.)
 */
import { describe, it, expect } from 'vitest';
import { FIELD_TYPES, FieldCoerceError, fieldTypeFor, type FieldKind } from './field-types.js';

/*
 * ---------------------------------------------------------------------------
 * fieldTypeFor helper
 * ---------------------------------------------------------------------------
 */

describe('fieldTypeFor', () => {
  it('returns the correct FieldTypeDef for every kind', () => {
    const kinds: FieldKind[] = [
      'text',
      'longText',
      'number',
      'boolean',
      'date',
      'singleSelect',
      'multiSelect',
      'json',
      'attachment',
      'rating',
    ];

    for (const kind of kinds) {
      expect(fieldTypeFor(kind)).toBe(FIELD_TYPES[kind]);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * text
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.text', () => {
  const def = FIELD_TYPES.text;

  it('coerce: trims and returns string', () => {
    expect(def.coerce('  hello  ')).toBe('hello');
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
    expect(def.coerce('   ')).toBeNull();
  });

  it('format: renders string value', () => {
    expect(def.format('world')).toBe('world');
  });

  it('format: null/undefined → empty string', () => {
    expect(def.format(null)).toBe('');
    expect(def.format(undefined)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * longText
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.longText', () => {
  const def = FIELD_TYPES.longText;

  it('coerce: preserves multi-line content when trimmed result is non-empty', () => {
    expect(def.coerce('line1\nline2')).toBe('line1\nline2');
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * number
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.number', () => {
  const def = FIELD_TYPES.number;

  it('coerce: integer string → number', () => {
    expect(def.coerce('42')).toBe(42);
  });

  it('coerce: float string → number', () => {
    expect(def.coerce('3.14')).toBe(3.14);
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
    expect(def.coerce('   ')).toBeNull();
  });

  it('coerce: non-numeric string → null', () => {
    expect(def.coerce('abc')).toBeNull();
    expect(def.coerce('NaN')).toBeNull();
    expect(def.coerce('Infinity')).toBeNull();
  });

  it('format: number → locale string', () => {
    // toLocaleString output is locale-dependent; just assert it is a non-empty string
    const result = def.format(1234);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * boolean
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.boolean', () => {
  const def = FIELD_TYPES.boolean;

  it('coerce: "true" → 1', () => {
    expect(def.coerce('true')).toBe(1);
  });

  it('coerce: "1" → 1', () => {
    expect(def.coerce('1')).toBe(1);
  });

  it('coerce: "yes" → 1', () => {
    expect(def.coerce('yes')).toBe(1);
  });

  it('coerce: "false" → 0', () => {
    expect(def.coerce('false')).toBe(0);
  });

  it('coerce: "0" → 0', () => {
    expect(def.coerce('0')).toBe(0);
  });

  it('coerce: "no" → 0', () => {
    expect(def.coerce('no')).toBe(0);
  });

  it('coerce: empty string → 0', () => {
    expect(def.coerce('')).toBe(0);
  });

  it('coerce: unrecognised value → 0 (falsy default)', () => {
    expect(def.coerce('maybe')).toBe(0);
  });

  it('format: 1 → "✓"', () => {
    expect(def.format(1)).toBe('✓');
  });

  it('format: 0 → ""', () => {
    expect(def.format(0)).toBe('');
  });

  it('format: true (native boolean) → "✓"', () => {
    expect(def.format(true)).toBe('✓');
  });
});

/*
 * ---------------------------------------------------------------------------
 * date
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.date', () => {
  const def = FIELD_TYPES.date;

  it('coerce: ISO date string → YYYY-MM-DD', () => {
    expect(def.coerce('2026-01-15')).toBe('2026-01-15');
  });

  it('coerce: recognisable date string → ISO YYYY-MM-DD', () => {
    /*
     * Dates like "January 15, 2026" should parse; exact string depends on timezone
     * but we can verify it is a valid YYYY-MM-DD.
     */
    const result = def.coerce('January 15, 2026');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
    expect(def.coerce('   ')).toBeNull();
  });

  it('coerce: invalid date string → null', () => {
    expect(def.coerce('not-a-date')).toBeNull();
    expect(def.coerce('99/99/9999')).toBeNull();
  });

  it('format: stored ISO string → same string', () => {
    expect(def.format('2026-01-15')).toBe('2026-01-15');
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * singleSelect
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.singleSelect', () => {
  const def = FIELD_TYPES.singleSelect;

  it('coerce: trims and returns string', () => {
    expect(def.coerce('  Option A  ')).toBe('Option A');
  });

  it('coerce: empty → null', () => {
    expect(def.coerce('')).toBeNull();
  });

  it('format: value → string', () => {
    expect(def.format('Option A')).toBe('Option A');
  });
});

/*
 * ---------------------------------------------------------------------------
 * multiSelect
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.multiSelect', () => {
  const def = FIELD_TYPES.multiSelect;

  it('coerce: comma-separated list → JSON array string', () => {
    expect(def.coerce('a, b, c')).toBe('["a","b","c"]');
  });

  it('coerce: single value → single-element JSON array', () => {
    expect(def.coerce('alpha')).toBe('["alpha"]');
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
    expect(def.coerce('   ')).toBeNull();
  });

  it('coerce + format round-trip', () => {
    const stored = def.coerce('red, green, blue') as string;
    expect(def.format(stored)).toBe('red, green, blue');
  });

  it('format: JSON array string → comma-joined display', () => {
    expect(def.format('["x","y"]')).toBe('x, y');
  });

  it('format: native Array → comma-joined display', () => {
    expect(def.format(['x', 'y'])).toBe('x, y');
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * json
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.json', () => {
  const def = FIELD_TYPES.json;

  it('coerce: valid JSON string → stores the original text', () => {
    const input = '{"key":"value"}';
    expect(def.coerce(input)).toBe(input);
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
  });

  it('coerce: invalid JSON → throws FieldCoerceError', () => {
    expect(() => def.coerce('{bad json}')).toThrowError(FieldCoerceError);
    expect(() => def.coerce('undefined')).toThrowError(FieldCoerceError);
  });

  it('coerce: valid JSON array → stores the original text', () => {
    const input = '[1,2,3]';
    expect(def.coerce(input)).toBe(input);
  });

  it('format: JSON string → pretty-printed', () => {
    const result = def.format('{"a":1}');
    expect(result).toContain('"a"');
    expect(result).toContain('1');
  });

  it('format: object value → pretty-printed', () => {
    const result = def.format({ a: 1 });
    expect(result).toContain('"a"');
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * attachment
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.attachment', () => {
  const def = FIELD_TYPES.attachment;

  it('coerce: URL string → stored as-is', () => {
    expect(def.coerce('https://r2.example.com/files/report.pdf')).toBe('https://r2.example.com/files/report.pdf');
  });

  it('coerce: empty → null', () => {
    expect(def.coerce('')).toBeNull();
  });

  it('format: URL → last path segment (filename)', () => {
    expect(def.format('https://r2.example.com/files/report.pdf')).toBe('report.pdf');
  });

  it('format: storage key with no slashes → key itself', () => {
    expect(def.format('myfile.csv')).toBe('myfile.csv');
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * rating
 * ---------------------------------------------------------------------------
 */

describe('FIELD_TYPES.rating', () => {
  const def = FIELD_TYPES.rating;

  it('coerce: "3" → 3', () => {
    expect(def.coerce('3')).toBe(3);
  });

  it('coerce: empty string → null', () => {
    expect(def.coerce('')).toBeNull();
  });

  it('coerce: clamps value below 0 to 0', () => {
    expect(def.coerce('-5')).toBe(0);
  });

  it('coerce: clamps value above 5 to 5', () => {
    expect(def.coerce('99')).toBe(5);
  });

  it('coerce: float is rounded before clamping', () => {
    expect(def.coerce('2.7')).toBe(3);
    expect(def.coerce('4.4')).toBe(4);
  });

  it('coerce: non-numeric → null', () => {
    expect(def.coerce('abc')).toBeNull();
  });

  it('format: 0 → five empty stars', () => {
    expect(def.format(0)).toBe('☆☆☆☆☆');
  });

  it('format: 5 → five filled stars', () => {
    expect(def.format(5)).toBe('★★★★★');
  });

  it('format: 3 → three filled + two empty stars', () => {
    expect(def.format(3)).toBe('★★★☆☆');
  });

  it('format: null → empty string', () => {
    expect(def.format(null)).toBe('');
  });
});
