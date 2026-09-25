/**
 * @file Unit tests for the pure Queues Browser helpers — duration formatting (null → "—", never a
 * fabricated 0) and producer/consumer endpoint labelling.
 */
import { describe, it, expect } from 'vitest';

import { endpointLabel, formatDuration } from './queues-browser-logic';

describe('formatDuration', () => {
  it('buckets seconds → s/m/h/d', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(14400)).toBe('4h');
    expect(formatDuration(345600)).toBe('4d');
  });
  it('renders unavailable (null / non-finite) as "—"', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('endpointLabel', () => {
  it('shows the script, with environment when present', () => {
    expect(endpointLabel({ script: 'ingest' })).toBe('ingest');
    expect(endpointLabel({ script: 'ingest', environment: 'prod' })).toBe('ingest (prod)');
  });
  it('falls back to "(unknown)" when no script', () => {
    expect(endpointLabel({})).toBe('(unknown)');
    expect(endpointLabel({ script: '   ' })).toBe('(unknown)');
    expect(endpointLabel({ script: null })).toBe('(unknown)');
  });
});
