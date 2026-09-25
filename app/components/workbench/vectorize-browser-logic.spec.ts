/**
 * @file Unit tests for the pure Vectorize Browser helpers — metric labelling, honest vector-count
 * formatting (null → "—", never a fabricated 0), and dimension formatting.
 */
import { describe, it, expect } from 'vitest';

import { formatDimensions, formatMetric, formatVectorCount } from './vectorize-browser-logic';

describe('formatMetric', () => {
  it('labels the known metrics', () => {
    expect(formatMetric('cosine')).toBe('Cosine');
    expect(formatMetric('EUCLIDEAN')).toBe('Euclidean');
    expect(formatMetric('dot-product')).toBe('Dot product');
    expect(formatMetric('dot_product')).toBe('Dot product');
  });
  it('passes through unknown metrics + "—" for null/empty', () => {
    expect(formatMetric('manhattan')).toBe('manhattan');
    expect(formatMetric(null)).toBe('—');
    expect(formatMetric('   ')).toBe('—');
  });
});

describe('formatVectorCount', () => {
  it('thousands-separates real counts (incl. 0)', () => {
    expect(formatVectorCount(0)).toBe('0');
    expect(formatVectorCount(1024)).toBe('1,024');
    expect(formatVectorCount(2_500_000)).toBe('2,500,000');
  });
  it('renders unknown (null / non-finite) as "—", never a fabricated 0', () => {
    expect(formatVectorCount(null)).toBe('—');
    expect(formatVectorCount(Number.NaN)).toBe('—');
  });
});

describe('formatDimensions', () => {
  it('appends -dim, or "—" when null', () => {
    expect(formatDimensions(768)).toBe('768-dim');
    expect(formatDimensions(1536)).toBe('1536-dim');
    expect(formatDimensions(null)).toBe('—');
  });
});
