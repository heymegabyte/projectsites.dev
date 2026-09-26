/**
 * @file Pure helper functions for the KV Browser Data panel tab.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library.  All functions
 * are pure (same input → same output, no side-effects) so they can be tested
 * with `node --experimental-strip-types` or any Vitest runner without any
 * module mocking.
 */

// ── formatKvExpiration ───────────────────────────────────────────────────────

/**
 * Convert a KV key's unix-second expiration timestamp to a human-readable
 * relative-time string.
 *
 * @param expiration - Unix timestamp in **seconds** (as Cloudflare KV returns).
 *   Pass `undefined` when the key has no TTL.
 * @param now - The current unix timestamp in seconds (injectable for tests).
 * @returns A short human string: `"no expiry"`, `"expired"`, `"in <1m"`,
 *   `"in 45m"`, `"in 3h"`, or `"in 3d"`.
 *
 * @example
 * formatKvExpiration(undefined, 1_000_000)
 * // → "no expiry"
 *
 * @example
 * formatKvExpiration(1_700_003_600, 1_700_000_000)
 * // → "in 1h"
 *
 * @example
 * formatKvExpiration(1_699_999_000, 1_700_000_000)
 * // → "expired"
 */
export function formatKvExpiration(expiration: number | undefined, now: number): string {
  if (expiration === undefined) {
    return 'no expiry';
  }

  const diffSeconds = expiration - now;

  if (diffSeconds <= 0) {
    return 'expired';
  }

  if (diffSeconds < 60) {
    return 'in <1m';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffMinutes < 60) {
    return `in ${diffMinutes}m`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `in ${diffHours}h`;
  }

  const diffDays = Math.floor(diffHours / 24);

  return `in ${diffDays}d`;
}

// ── parseMaybeJson ───────────────────────────────────────────────────────────

/** Result shape returned by {@link parseMaybeJson}. */
export interface ParsedValue {
  /** The display string — pretty-printed JSON or the raw string. */
  pretty: string;

  /** Whether the input parsed as valid JSON (object or array). */
  isJson: boolean;
}

/**
 * Attempt to parse and pretty-print a KV value that may or may not be JSON.
 *
 * @remarks
 * Only objects and arrays are considered "JSON" for display purposes —
 * bare primitives like `"42"` or `"true"` are returned as-is because they
 * offer no pretty-print benefit and the isJson flag drives the syntax-
 * highlighted `<pre>` in the UI.
 *
 * A `null` value (key exists, value is null) gets a friendly "(null…)"
 * placeholder rather than rendering an empty panel.
 *
 * @param value - The raw KV value string, or `null` when the key's stored
 *   value is explicitly null.
 * @returns A {@link ParsedValue} with a displayable `pretty` string and an
 *   `isJson` flag.
 *
 * @example
 * parseMaybeJson('{"user":"alice","age":30}')
 * // → { pretty: '{\n  "user": "alice",\n  "age": 30\n}', isJson: true }
 *
 * @example
 * parseMaybeJson('plain text')
 * // → { pretty: 'plain text', isJson: false }
 *
 * @example
 * parseMaybeJson(null)
 * // → { pretty: '(null — key exists but has no value)', isJson: false }
 */
export function parseMaybeJson(value: string | null): ParsedValue {
  if (value === null) {
    return { pretty: '(null — key exists but has no value)', isJson: false };
  }

  const trimmed = value.trim();

  // Only attempt parsing for strings that look like objects/arrays.
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (parsed !== null && typeof parsed === 'object') {
        return { pretty: JSON.stringify(parsed, null, 2), isJson: true };
      }
    } catch {
      // fall through to raw
    }
  }

  return { pretty: value, isJson: false };
}

// ── kvKeyMatchesPrefix ───────────────────────────────────────────────────────

/**
 * Return `true` when `key` starts with `prefix` (or `prefix` is empty).
 *
 * @remarks
 * Used to filter the key list in the KV browser's prefix-search box.
 * Comparison is **case-sensitive** because KV keys are case-sensitive.
 *
 * @param key - The KV key name (e.g. `"user:123:session"`).
 * @param prefix - The search prefix entered in the UI (e.g. `"user:"`).
 *   Pass `""` (the default) to match every key.
 * @returns Boolean — whether the key should appear in the filtered list.
 *
 * @example
 * kvKeyMatchesPrefix('user:123:session', 'user:')
 * // → true
 *
 * @example
 * kvKeyMatchesPrefix('session:abc', 'user:')
 * // → false
 */
export function kvKeyMatchesPrefix(key: string, prefix: string): boolean {
  if (prefix === '') {
    return true;
  }

  return key.startsWith(prefix);
}

/** The expiry intent of a KV value edit, resolved from the edit form's controls. */
export type KvExpiryDecision =
  | { kind: 'preserve' }
  | { kind: 'clear' }
  | { kind: 'ttl'; expirationTtl: number }
  | { kind: 'invalid'; message: string };

/**
 * Decide what a value edit should do with the key's expiration, from the edit form's two controls: a
 * "make permanent" checkbox and an optional new-TTL input. Precedence: the checkbox (clear) WINS; else a
 * blank TTL input means "no change" (the server preserves the existing expiration); else the TTL must be
 * a whole number ≥60 (KV's floor) — anything else is `invalid` (blocked with a message, NEVER silently
 * dropped, so the user is never misled about what will be stored). Pure.
 *
 * @example decideKvExpiry({ clearExpiration: true, ttlInput: '3600' }) // { kind: 'clear' }
 * @example decideKvExpiry({ clearExpiration: false, ttlInput: '' })    // { kind: 'preserve' }
 * @example decideKvExpiry({ clearExpiration: false, ttlInput: '3600' })// { kind: 'ttl', expirationTtl: 3600 }
 * @example decideKvExpiry({ clearExpiration: false, ttlInput: '30' })  // { kind: 'invalid', message: … }
 */
export function decideKvExpiry(opts: { clearExpiration: boolean; ttlInput: string }): KvExpiryDecision {
  if (opts.clearExpiration) {
    return { kind: 'clear' };
  }

  const t = (opts.ttlInput ?? '').trim();

  if (t === '') {
    return { kind: 'preserve' };
  }

  const n = Number(t);

  if (!Number.isInteger(n) || n < 60) {
    return { kind: 'invalid', message: 'Expiry must be a whole number of seconds ≥ 60 (KV minimum).' };
  }

  return { kind: 'ttl', expirationTtl: n };
}
