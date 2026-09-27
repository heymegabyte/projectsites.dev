/**
 * Aggregate statistics for a selection of grid cells, mirroring the footer
 * stats bar found in DataGrip / TablePlus.
 *
 * Only plain `number` values and `string` values that parse as a finite number
 * (via `Number()`, rejecting the empty string, `NaN`, and ±`Infinity`) are
 * counted toward numeric aggregates. `null` and `undefined` increment
 * `nullCount`. All other values (booleans, objects, arrays, non-finite
 * numbers passed as raw JS `number` literals, etc.) count only toward `count`.
 */

/**
 * Aggregate statistics computed from a rectangular cell selection.
 *
 * @example
 * const result = computeAggregates([1, '2', null, 'hello']);
 * // result.count        === 4
 * // result.numericCount === 2
 * // result.sum          === 3
 * // result.avg          === 1.5
 * // result.min          === 1
 * // result.max          === 2
 * // result.nullCount    === 1
 */
export interface CellAggregates {
  /** Total cells selected (including null, text, and non-numeric values). */
  count: number;
  /** How many values parsed as a finite number. */
  numericCount: number;
  /** Sum of numeric values; `null` when `numericCount === 0`. */
  sum: number | null;
  /** Mean of numeric values rounded to ≤6 significant decimals; `null` when `numericCount === 0`. */
  avg: number | null;
  /** Minimum numeric value; `null` when `numericCount === 0`. */
  min: number | null;
  /** Maximum numeric value; `null` when `numericCount === 0`. */
  max: number | null;
  /** How many values are `null` or `undefined`. */
  nullCount: number;
}

/**
 * Returns `true` only for plain `number` typed values that are finite.
 * Booleans, objects, strings, etc. are explicitly excluded.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Returns `true` only for non-empty `string` values that parse as a finite
 * number via `Number()`. Whitespace-padded strings like `' 3 '` are accepted
 * (JS `Number(' 3 ')` === 3). The empty string is explicitly rejected because
 * `Number('')` === 0, which would be misleading.
 */
function isNumericString(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n);
}

/**
 * Rounds a number to at most 6 significant decimal places to suppress
 * IEEE 754 floating-point trailing noise (e.g. 0.1 + 0.2 === 0.30000000000000004).
 *
 * `parseFloat(n.toPrecision(7))` gives 7 significant figures total, which
 * yields ≤6 decimal digits for numbers ≥1 and ≤6 significant decimals for
 * numbers <1, covering the common range without introducing rounding bias on
 * already-exact values.
 */
function roundAvg(n: number): number {
  return parseFloat(n.toPrecision(7));
}

/**
 * Computes aggregate statistics for the provided array of cell values.
 *
 * @param values - Readonly array of raw cell values from the grid selection.
 * @returns A {@link CellAggregates} object. For an empty input all counts are
 *   zero and `sum`, `avg`, `min`, `max` are `null`.
 *
 * @example
 * computeAggregates([]);
 * // { count:0, numericCount:0, sum:null, avg:null, min:null, max:null, nullCount:0 }
 *
 * @example
 * computeAggregates([10, '20', null, 'N/A']);
 * // { count:4, numericCount:2, sum:30, avg:15, min:10, max:20, nullCount:1 }
 */
export function computeAggregates(values: readonly unknown[]): CellAggregates {
  let count = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let nullCount = 0;

  for (const v of values) {
    count++;

    if (v === null || v === undefined) {
      nullCount++;
      continue;
    }

    let numeric: number | null = null;

    if (isFiniteNumber(v)) {
      numeric = v;
    } else if (isNumericString(v)) {
      numeric = Number(v);
    }
    // booleans, objects, arrays, non-finite raw numbers → not numeric

    if (numeric !== null) {
      numericCount++;
      sum += numeric;
      if (numeric < min) min = numeric;
      if (numeric > max) max = numeric;
    }
  }

  if (numericCount === 0) {
    return { count, numericCount: 0, sum: null, avg: null, min: null, max: null, nullCount };
  }

  return {
    count,
    numericCount,
    sum,
    avg: roundAvg(sum / numericCount),
    min,
    max,
    nullCount,
  };
}
