/**
 * @file Unit tests for the pure D1 Time-Travel helpers.
 *
 * @remarks
 * Pure-function tests (no React, no bridge, no mocking). `Date.now()` is injected where a helper takes a `now`
 * param so the window math is deterministic; helpers that read the ambient clock (`datetimeLocalToIso`) are
 * exercised on their parse/format contract only.
 */
import { describe, it, expect } from 'vitest';

import {
  datetimeLocalToIso,
  formatInstant,
  isWithinWindow,
  restoreConfirmMessage,
  shortBookmark,
  TIME_TRAVEL_RETENTION_DAYS,
  toDatetimeLocalValue,
  windowStartIso,
} from './time-travel-logic';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');

describe('TIME_TRAVEL_RETENTION_DAYS', () => {
  it('is 30 (Workers Paid window)', () => {
    expect(TIME_TRAVEL_RETENTION_DAYS).toBe(30);
  });
});

describe('datetimeLocalToIso', () => {
  it('returns an ISO 8601 UTC instant for a valid local value', () => {
    const iso = datetimeLocalToIso('2026-01-02T09:30');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('returns null for empty / whitespace', () => {
    expect(datetimeLocalToIso('')).toBeNull();
    expect(datetimeLocalToIso('   ')).toBeNull();
    expect(datetimeLocalToIso(undefined)).toBeNull();
  });

  it('returns null for an unparseable value', () => {
    expect(datetimeLocalToIso('not-a-date')).toBeNull();
  });
});

describe('isWithinWindow', () => {
  it('accepts a timestamp inside the last 30 days', () => {
    expect(isWithinWindow(new Date(NOW - 5 * DAY_MS).toISOString(), NOW)).toBe(true);
  });

  it('accepts (approximately) now', () => {
    expect(isWithinWindow(new Date(NOW).toISOString(), NOW)).toBe(true);
  });

  it('rejects a timestamp older than the window', () => {
    expect(isWithinWindow(new Date(NOW - 31 * DAY_MS).toISOString(), NOW)).toBe(false);
  });

  it('rejects a real future timestamp', () => {
    expect(isWithinWindow(new Date(NOW + 10 * DAY_MS).toISOString(), NOW)).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isWithinWindow('nope', NOW)).toBe(false);
  });
});

describe('windowStartIso', () => {
  it('is exactly 30 days before now', () => {
    expect(windowStartIso(NOW)).toBe(new Date(NOW - 30 * DAY_MS).toISOString());
  });
});

describe('shortBookmark', () => {
  it('truncates a long opaque bookmark', () => {
    expect(shortBookmark('00000085-0000abcd-0000-longopaquestring')).toBe('00000085…');
  });

  it('passes through a short value', () => {
    expect(shortBookmark('abc')).toBe('abc');
  });

  it('shows an em dash for empty', () => {
    expect(shortBookmark('')).toBe('—');
    expect(shortBookmark(undefined)).toBe('—');
  });
});

describe('formatInstant', () => {
  it('formats a valid ISO instant to a human string', () => {
    const out = formatInstant('2026-06-15T12:00:00.000Z');
    expect(out).not.toBe('—');
    expect(out).not.toBe('2026-06-15T12:00:00.000Z'); // it was reformatted, not passed through
  });

  it('returns the raw string when unparseable', () => {
    expect(formatInstant('garbage')).toBe('garbage');
  });

  it('shows an em dash for empty', () => {
    expect(formatInstant('')).toBe('—');
  });
});

describe('toDatetimeLocalValue', () => {
  it('produces a 16-char YYYY-MM-DDTHH:mm string', () => {
    const v = toDatetimeLocalValue(NOW);
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('restoreConfirmMessage', () => {
  it('names a timestamp target and warns about data loss', () => {
    const msg = restoreConfirmMessage({ timestamp: '2026-06-15T12:00:00.000Z' });
    expect(msg).toContain('entire database');
    expect(msg).toContain('permanently lost');
    expect(msg).toContain('30 days');
  });

  it('names a labelled bookmark target', () => {
    const msg = restoreConfirmMessage({ label: 'before import', bookmark: 'abc' });
    expect(msg).toContain('before import');
  });

  it('falls back to a short bookmark when no label', () => {
    const msg = restoreConfirmMessage({ bookmark: '00000085-0000abcd-0000-longopaque' });
    expect(msg).toContain('00000085…');
  });
});
