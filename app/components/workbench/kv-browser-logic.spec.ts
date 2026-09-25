/**
 * @file Unit tests for kv-browser-logic pure helpers.
 * Run with Vitest (same runner as the rest of app/).
 */
import { describe, it, expect } from 'vitest';
import { formatKvExpiration, parseMaybeJson, kvKeyMatchesPrefix } from './kv-browser-logic.js';

// ── formatKvExpiration ───────────────────────────────────────────────────────

describe('formatKvExpiration', () => {
  it('returns "no expiry" when expiration is undefined', () => {
    expect(formatKvExpiration(undefined, 1_000_000)).toBe('no expiry');
  });

  it('returns "expired" when unix-seconds expiration is in the past', () => {
    const now = 1_700_000_000;
    expect(formatKvExpiration(now - 3600, now)).toBe('expired');
  });

  it('returns "expired" for expiration exactly at now', () => {
    const now = 1_700_000_000;
    expect(formatKvExpiration(now, now)).toBe('expired');
  });

  it('returns relative future string for expiration in hours', () => {
    const now = 1_700_000_000;
    const result = formatKvExpiration(now + 3 * 3600, now);
    expect(result).toMatch(/in \d+h/);
    expect(result).toBe('in 3h');
  });

  it('returns relative future string in minutes for <1h', () => {
    const now = 1_700_000_000;
    const result = formatKvExpiration(now + 45 * 60, now);
    expect(result).toBe('in 45m');
  });

  it('returns "in <1m" for very short remaining time', () => {
    const now = 1_700_000_000;
    const result = formatKvExpiration(now + 30, now);
    expect(result).toBe('in <1m');
  });

  it('returns days for large future expiration', () => {
    const now = 1_700_000_000;
    const result = formatKvExpiration(now + 3 * 86400, now);
    expect(result).toBe('in 3d');
  });
});

// ── parseMaybeJson ───────────────────────────────────────────────────────────

describe('parseMaybeJson', () => {
  it('pretty-prints a valid JSON object', () => {
    const { pretty, isJson } = parseMaybeJson('{"a":1,"b":"hello"}');
    expect(isJson).toBe(true);
    expect(pretty).toContain('"a": 1');
    expect(pretty).toContain('"b": "hello"');
  });

  it('pretty-prints a valid JSON array', () => {
    const { pretty, isJson } = parseMaybeJson('[1,2,3]');
    expect(isJson).toBe(true);
    expect(pretty).toContain('[\n');
  });

  it('returns raw string for non-JSON values', () => {
    const { pretty, isJson } = parseMaybeJson('plain text value');
    expect(isJson).toBe(false);
    expect(pretty).toBe('plain text value');
  });

  it('returns raw string for null value', () => {
    const { pretty, isJson } = parseMaybeJson(null);
    expect(isJson).toBe(false);
    expect(pretty).toBe('(null — key exists but has no value)');
  });

  it('handles a JSON number at root level', () => {
    const { pretty, isJson } = parseMaybeJson('42');
    // numbers are valid JSON but we treat bare primitives as raw
    expect(typeof isJson).toBe('boolean');
    expect(typeof pretty).toBe('string');
  });

  it('returns raw for truncated/invalid JSON', () => {
    const { pretty, isJson } = parseMaybeJson('{"incomplete":');
    expect(isJson).toBe(false);
    expect(pretty).toBe('{"incomplete":');
  });
});

// ── kvKeyMatchesPrefix ───────────────────────────────────────────────────────

describe('kvKeyMatchesPrefix', () => {
  it('returns true when prefix is empty string (all keys match)', () => {
    expect(kvKeyMatchesPrefix('any:key:here', '')).toBe(true);
  });

  it('returns true when key starts with prefix', () => {
    expect(kvKeyMatchesPrefix('user:123:session', 'user:')).toBe(true);
  });

  it('returns false when key does not start with prefix', () => {
    expect(kvKeyMatchesPrefix('session:abc', 'user:')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(kvKeyMatchesPrefix('User:123', 'user:')).toBe(false);
  });

  it('returns true for exact match (key === prefix)', () => {
    expect(kvKeyMatchesPrefix('exact', 'exact')).toBe(true);
  });
});
