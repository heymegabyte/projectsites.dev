/**
 * @file Unit tests for the pure D1 Overview helpers — byte/count formatting (null → "—", never a
 * fabricated 0) and database labelling.
 */
import { describe, it, expect } from 'vitest';

import { dbLabel, formatBytes, formatCount } from './d1-browser-logic';

describe('formatBytes', () => {
  it('scales bytes → B/KB/MB/GB (binary)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(33_067_008)).toBe('31.5 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
  });
  it('renders unavailable (null / undefined / non-finite / negative) as "—"', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('formatCount', () => {
  it('formats integers with thousands separators; real 0 stays 0', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(1024)).toBe('1,024');
  });
  it('renders unavailable (null / undefined / non-finite) as "—"', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('dbLabel', () => {
  it('shows the name, falling back to the id when blank', () => {
    expect(dbLabel({ id: 'ea3e', name: 'prod-db' })).toBe('prod-db');
    expect(dbLabel({ id: 'ea3e', name: '   ' })).toBe('ea3e');
    expect(dbLabel({ id: 'ea3e', name: '' })).toBe('ea3e');
  });
});
