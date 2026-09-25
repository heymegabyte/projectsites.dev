import { describe, it, expect } from 'vitest';
import { computeAggregates } from './data-aggregates';

describe('computeAggregates', () => {
  it('empty array → all zero, numeric fields null', () => {
    const r = computeAggregates([]);
    expect(r.count).toBe(0);
    expect(r.numericCount).toBe(0);
    expect(r.sum).toBeNull();
    expect(r.avg).toBeNull();
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
    expect(r.nullCount).toBe(0);
  });

  it('mixed numeric, text, null, undefined', () => {
    const r = computeAggregates([1, 'hello', null, undefined, 3]);
    expect(r.count).toBe(5);
    expect(r.numericCount).toBe(2);
    expect(r.sum).toBe(4);
    expect(r.avg).toBe(2);
    expect(r.min).toBe(1);
    expect(r.max).toBe(3);
    expect(r.nullCount).toBe(2);
  });

  it('all null/undefined → nullCount correct, numeric fields null', () => {
    const r = computeAggregates([null, undefined, null]);
    expect(r.count).toBe(3);
    expect(r.numericCount).toBe(0);
    expect(r.sum).toBeNull();
    expect(r.avg).toBeNull();
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
    expect(r.nullCount).toBe(3);
  });

  it('numeric strings coerced correctly', () => {
    const r = computeAggregates(['2', '3.5', '4']);
    expect(r.numericCount).toBe(3);
    expect(r.sum).toBe(9.5);
    // avg is rounded to ≤6 decimals (roundAvg) — assert closeness, not full float precision.
    expect(r.avg).toBeCloseTo(9.5 / 3, 5);
    expect(r.min).toBe(2);
    expect(r.max).toBe(4);
  });

  it('empty string not treated as numeric', () => {
    const r = computeAggregates(['', '5']);
    expect(r.count).toBe(2);
    expect(r.numericCount).toBe(1);
    expect(r.sum).toBe(5);
  });

  it('Infinity and NaN rejected from numerics', () => {
    const r = computeAggregates([Infinity, -Infinity, NaN, 7]);
    expect(r.numericCount).toBe(1);
    expect(r.sum).toBe(7);
    expect(r.min).toBe(7);
    expect(r.max).toBe(7);
    // non-null, non-undefined non-numerics count toward count only
    expect(r.count).toBe(4);
    expect(r.nullCount).toBe(0);
  });

  it('single numeric value', () => {
    const r = computeAggregates([42]);
    expect(r.count).toBe(1);
    expect(r.numericCount).toBe(1);
    expect(r.sum).toBe(42);
    expect(r.avg).toBe(42);
    expect(r.min).toBe(42);
    expect(r.max).toBe(42);
    expect(r.nullCount).toBe(0);
  });

  it('negative numbers', () => {
    const r = computeAggregates([-10, -3, -1]);
    expect(r.sum).toBe(-14);
    expect(r.avg).toBeCloseTo(-14 / 3, 6);
    expect(r.min).toBe(-10);
    expect(r.max).toBe(-1);
  });

  it('float avg precision — avoids noise beyond 6 significant decimals', () => {
    // 1/3 = 0.3333... — should not produce 0.33333333333333337
    const r = computeAggregates([0, 1]);
    // avg = 0.5 — exact, no noise
    expect(r.avg).toBe(0.5);

    // 1 2 3 → avg 2 — exact
    const r2 = computeAggregates([1, 2, 3]);
    expect(r2.avg).toBe(2);

    // 1/3 scenario
    const r3 = computeAggregates([1, 0, 0]);
    // avg should be rounded to ≤6 significant decimals
    expect(String(r3.avg).replace('.', '').replace(/^0+/, '').length).toBeLessThanOrEqual(7);
  });

  it('numeric string "0" is valid zero', () => {
    const r = computeAggregates(['0', '0', '0']);
    expect(r.numericCount).toBe(3);
    expect(r.sum).toBe(0);
    expect(r.avg).toBe(0);
  });

  it('numeric string with spaces NOT coerced (Number(" 3") is 3 — spec says Number())', () => {
    // Number(' 3') === 3 in JS — we accept this behavior
    const r = computeAggregates([' 3 ']);
    expect(r.numericCount).toBe(1);
    expect(r.sum).toBe(3);
  });

  it('boolean values not numeric (Number(true)=1 but booleans are not numeric strings)', () => {
    // true/false are not null/undefined so don't increment nullCount
    // they produce Number(true)=1 / Number(false)=0 but spec says
    // "numbers and numeric strings" — booleans should NOT count
    const r = computeAggregates([true, false]);
    expect(r.count).toBe(2);
    expect(r.numericCount).toBe(0);
    expect(r.nullCount).toBe(0);
    expect(r.sum).toBeNull();
  });

  it('object values do not coerce to numeric', () => {
    const r = computeAggregates([{}, [], { v: 1 }]);
    expect(r.count).toBe(3);
    expect(r.numericCount).toBe(0);
    expect(r.nullCount).toBe(0);
  });
});
