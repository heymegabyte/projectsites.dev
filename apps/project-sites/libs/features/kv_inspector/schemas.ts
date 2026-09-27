/**
 * @module libs/features/kv_inspector/schemas
 * @description Zod schemas for the KV Inspector feature — validated at every boundary.
 */

import { z } from 'zod';

/** The server-side allowlist of KV bindings that may be inspected. */
export const KV_BINDING_ALLOWLIST = ['CACHE_KV', 'PROMPT_STORE'] as const;

export type KvBinding = (typeof KV_BINDING_ALLOWLIST)[number];

/**
 * Validates a `:binding` path param against the server allowlist.
 * Unknown values → parse fails → 404 (never trust client-supplied binding names).
 */
export const KvBindingSchema = z.enum(KV_BINDING_ALLOWLIST);

/** Query params for GET /api/admin/kv/:binding/keys */
export const KvListQuerySchema = z.object({
  /** Key prefix filter — forwarded verbatim to KV.list(). */
  prefix: z.string().optional(),
  /** Pagination cursor returned by a previous list response. */
  cursor: z.string().optional(),
  /**
   * Maximum keys to return per page.
   * Any positive integer accepted; the handler clamps to 1000 via Math.min.
   */
  limit: z.coerce.number().int().min(1).optional(),
});

/** Query params for GET /api/admin/kv/:binding/value */
export const KvValueQuerySchema = z.object({
  /** The exact key name to retrieve. Required. */
  key: z.string().min(1),
});

/** One key entry returned by the list endpoint. */
export const KvKeyEntrySchema = z.object({
  name: z.string(),
  expiration: z.number().optional(),
  metadata: z.unknown().optional(),
});

export type KvKeyEntry = z.infer<typeof KvKeyEntrySchema>;

/** Response shape for GET /api/admin/kv/:binding/keys */
export const KvListResponseSchema = z.object({
  binding: z.string(),
  keys: z.array(KvKeyEntrySchema),
  list_complete: z.boolean(),
  cursor: z.string().optional(),
});

export type KvListResponse = z.infer<typeof KvListResponseSchema>;

/** Response shape for GET /api/admin/kv/:binding/value */
export const KvValueResponseSchema = z.object({
  binding: z.string(),
  key: z.string(),
  /** The raw value string, or null when the key does not exist. */
  value: z.string().nullable(),
  /** KV metadata, or null when absent. */
  metadata: z.unknown().nullable(),
  /** True when the value was truncated to stay within the size cap. */
  truncated: z.boolean(),
  /** Remaining TTL in seconds, or null if the key has no expiration. */
  ttl: z.number().nullable(),
});

export type KvValueResponse = z.infer<typeof KvValueResponseSchema>;

/** Max byte-length for a returned value before truncation. */
export const KV_VALUE_MAX_BYTES = 65_536; // 64 KiB

/**
 * Body for PUT /api/admin/kv/:binding/value — write (create/overwrite) a value. The value is capped
 * at {@link KV_VALUE_MAX_BYTES} (the same size the reader returns un-truncated) so the editor can only
 * round-trip a value it actually showed in full — it can never silently save a truncated value back
 * and drop data. `expirationTtl` is optional (KV's minimum is 60s); omitted ⇒ the key's EXISTING
 * expiration is preserved (a value edit never silently clears a TTL — see `buildKvPutOptions`).
 * `clearExpiration` is the EXPLICIT opt-in to remove the expiration (make the key permanent); it's
 * the only way to drop a TTL now that a bare edit preserves it. `expirationTtl` wins if both are set.
 */
export const KvPutSchema = z.object({
  key: z.string().min(1).max(512),
  value: z.string().max(KV_VALUE_MAX_BYTES),
  expirationTtl: z.number().int().min(60).optional(),
  clearExpiration: z.boolean().optional(),
});

export type KvPut = z.infer<typeof KvPutSchema>;
