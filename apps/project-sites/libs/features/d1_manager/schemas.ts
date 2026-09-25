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

/**
 * A SQLite identifier (table name) for a scoped export — letters/digits/underscore, ≤64 chars.
 * Bounds what we forward into CF's `dump_options.tables`; a hostile value is rejected here (400)
 * and never reaches the REST call. (CF re-validates too — this is defense-in-depth, not the only gate.)
 */
export const D1TableNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A table name is a SQLite identifier.');

/**
 * Body for POST /api/admin/d1/:databaseId/export. All fields optional:
 * - `tables`  — scope the export to specific tables (fewer tables ⇒ shorter DB-unavailability window);
 *               omitted ⇒ full-database export.
 * - `schemaOnly` / `dataOnly` — CF `dump_options.no_data` / `no_schema` (mutually exclusive; both false ⇒ full dump).
 * - `currentBookmark` — resume polling an in-progress export (the `bookmark` from a prior `processing` response).
 */
export const D1ExportRequestSchema = z
  .object({
    tables: z.array(D1TableNameSchema).max(50).optional(),
    schemaOnly: z.boolean().optional(),
    dataOnly: z.boolean().optional(),
    currentBookmark: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((b) => !(b.schemaOnly && b.dataOnly), {
    message: 'schemaOnly and dataOnly are mutually exclusive.',
  });

export type D1ExportRequest = z.infer<typeof D1ExportRequestSchema>;

/**
 * Response for the export endpoint. `status` drives the client:
 * - `complete`   — `signedUrl` (valid ~1h) + `filename` are set; download it.
 * - `processing` — still running; re-POST with `{ currentBookmark: bookmark }` to resume.
 * - `error`      — CF reported an export error (`reason` + `messages`).
 * - `unavailable`— credentials/API failure (honest, never a fabricated URL).
 * `note` always carries the honest caveat that exporting briefly makes the DB unavailable to queries.
 */
export const D1ExportResponseSchema = z.object({
  status: z.enum(['complete', 'processing', 'error', 'unavailable']),
  /** Signed SQL-dump download URL — ONLY when complete (valid ~1 hour). Never fabricated. */
  signedUrl: z.string().optional(),
  filename: z.string().optional(),
  /** Time-travel bookmark: resume token when processing; the export's `at_bookmark` when complete. */
  bookmark: z.string().optional(),
  messages: z.array(z.string()).optional(),
  reason: z.string().optional(),
  note: z.string(),
});

export type D1ExportResponse = z.infer<typeof D1ExportResponseSchema>;
