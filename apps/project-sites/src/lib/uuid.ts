/**
 * @module lib/uuid
 * @description UUID helpers for D1 record ids.
 *
 * Per the global `uuid-version-discipline` rule, a D1 record primary key is a
 * **UUIDv7** (timestamp-ordered, so lexicographic sort == chronological sort and
 * B-tree inserts cluster on the hot page). Workers has no native UUIDv7, so
 * {@link uuidv7} derives one from `crypto.randomUUID()`: it keeps the version-4
 * randomness but overwrites the version nibble with `7` and the first 48 bits
 * with the current Unix-ms timestamp (big-endian).
 *
 * @remarks Impure — reads the clock and the Web Crypto RNG. Extracted from the
 * private copy in `services/audit_alert.ts` (never import a private symbol);
 * `crypto.randomUUID()` remains the right choice for session tokens / idempotency
 * keys / R2 file names, where max entropy with no embedded timestamp is required.
 *
 * @packageDocumentation
 */

/**
 * Mint a UUIDv7 (timestamp-prefixed, lexicographically sortable) string.
 *
 * @returns A `xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx` string.
 *
 * @example
 * ```ts
 * const id = uuidv7(); // '0192f3a1-...' — sorts by creation time
 * ```
 */
export function uuidv7(): string {
  const hex = crypto.randomUUID().replace(/-/g, '');
  const ts = Date.now().toString(16).padStart(12, '0').slice(0, 12);
  // 48-bit timestamp || random, with the version nibble forced to 7.
  const raw = ts + hex.slice(12, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-7${raw.slice(12, 15)}-${raw.slice(15, 19)}-${raw.slice(19, 31)}`;
}

/**
 * Mint a UUIDv4 (maximum entropy, no embedded timestamp) string.
 *
 * @returns A `xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx` string.
 *
 * @example
 * ```ts
 * const token = uuidv4(); // session token — must not leak creation time
 * ```
 */
export function uuidv4(): string {
  return crypto.randomUUID();
}
