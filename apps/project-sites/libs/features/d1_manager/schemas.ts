/**
 * @module libs/features/d1_manager/schemas
 * @description Zod schemas for the read-only D1 Manager (resource discovery + Overview).
 */

import { z } from 'zod';

/**
 * Validates a `:databaseId` path param as a Cloudflare D1 database UUID — the only shape
 * D1 issues — so a hostile value can never be injected into the REST path. This is NOT an
 * authorization boundary (the super-admin gate is); an unknown-but-valid UUID simply 404s
 * from the CF API, surfaced honestly as `found:false`.
 *
 * @example D1DatabaseIdSchema.parse('ea3e839a-c641-4861-ae30-dfc63bff8032') // ok
 * @example D1DatabaseIdSchema.safeParse('../secrets').success // false → 404
 */
export const D1DatabaseIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'A D1 database id is a UUID.',
  );

export type D1DatabaseId = z.infer<typeof D1DatabaseIdSchema>;

/** One database row returned by the list endpoint. */
export const D1DatabaseRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.string().nullable(),
  version: z.string().nullable(),
});

export type D1DatabaseRow = z.infer<typeof D1DatabaseRowSchema>;

/** Response shape for GET /api/admin/d1/databases */
export const D1ListResponseSchema = z.object({
  databases: z.array(D1DatabaseRowSchema),
  /** False when the CF API / credentials failed — an honest "not available", never a fake empty list. */
  available: z.boolean(),
  reason: z.string().optional(),
});

export type D1ListResponse = z.infer<typeof D1ListResponseSchema>;

/**
 * Response shape for GET /api/admin/d1/:databaseId/overview.
 * `found:false` when the DB doesn't exist (honest); `available:false` on a credential/API failure.
 * Metric fields are `null` (never a fabricated 0) when the CF API omits them.
 */
export const D1OverviewResponseSchema = z.object({
  found: z.boolean(),
  id: z.string(),
  name: z.string().nullable(),
  /** On-disk size in bytes (CF `file_size`), or null when unavailable. */
  fileSize: z.number().nullable(),
  /** Table count (CF `num_tables`), or null when unavailable. */
  numTables: z.number().nullable(),
  version: z.string().nullable(),
  /** Primary region (CF `running_in_region`, e.g. "ENAM"), or null. */
  region: z.string().nullable(),
  /** Read-replication mode (CF `read_replication.mode`, e.g. "auto"/"disabled"), or null. */
  readReplication: z.string().nullable(),
  available: z.boolean().optional(),
  reason: z.string().optional(),
});

export type D1OverviewResponse = z.infer<typeof D1OverviewResponseSchema>;
