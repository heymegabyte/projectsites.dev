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
