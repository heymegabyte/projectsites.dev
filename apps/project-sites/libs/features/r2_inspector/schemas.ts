/**
 * @module libs/features/r2_inspector/schemas
 * @description Zod schemas for the R2 Object Inspector — validated at every boundary.
 */

import { z } from 'zod';

/** The server-side allowlist of R2 buckets that may be inspected (shared platform infra). */
export const R2_BUCKET_ALLOWLIST = ['SITES_BUCKET'] as const;

export type R2BucketBinding = (typeof R2_BUCKET_ALLOWLIST)[number];

/**
 * Validates a `:bucket` path param against the server allowlist.
 * Unknown values → parse fails → 404 (never trust a client-supplied bucket name).
 */
export const R2BucketSchema = z.enum(R2_BUCKET_ALLOWLIST);

/** Query params for GET /api/admin/r2/:bucket/objects */
export const R2ListQuerySchema = z.object({
  /** Object-key prefix filter — forwarded verbatim to R2 `list()`. */
  prefix: z.string().max(1024).optional(),
  /** Pagination cursor returned by a previous list response. */
  cursor: z.string().optional(),
  /** Max objects per page; the handler clamps to R2's 1000 hard cap via Math.min. */
  limit: z.coerce.number().int().min(1).optional(),
  /**
   * Grouping delimiter (typically `/`) — when set, R2 collapses keys sharing a prefix up to the next
   * delimiter into `delimitedPrefixes` (folder-like navigation), and `objects` holds only the keys at
   * THIS level. A key-prefix grouping, NOT real directories (R2 keys are flat). Bounded length.
   */
  delimiter: z.string().max(16).optional(),
});

/** Query params for GET /api/admin/r2/:bucket/object */
export const R2ObjectQuerySchema = z.object({
  /** The exact object key to HEAD (metadata only — never the body). Required. */
  key: z.string().min(1).max(1024),
});

/** R2's hard cap on objects returned per `list()` page. */
export const R2_LIST_MAX = 1000;
