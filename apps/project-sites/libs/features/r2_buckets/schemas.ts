/**
 * @module libs/features/r2_buckets/schemas
 * @description Zod I/O schemas for the per-site R2 Buckets API. Every request body crossing the
 * worker boundary is validated here (per `zod-everywhere`); types are inferred, never hand-duplicated.
 */
import { z } from 'zod';

/** The flag gating the entire per-site R2 Buckets surface (default-off / DARK). */
export const R2_BUCKETS_FLAG = 'r2_buckets' as const;

/**
 * The flag gating the per-site OWNER-FACING scoped R2 key routes (`/r2/keys*`) AND the object-ops
 * credential path. Distinct from {@link R2_BUCKETS_FLAG}: the owner key IS a live R2 S3 credential the
 * owner wields from their own tooling, so it rides the same flag that governs the scoped-token object-ops
 * capability (`r2_bucket_manager`, enabled/100%/beta) rather than the bucket-CRUD surface flag.
 */
export const R2_OWNER_KEY_FLAG = 'r2_bucket_manager' as const;

/**
 * A tenant-facing bucket display name — what the owner types. Sanitized + site-prefixed server-side
 * into the real R2 bucket name; validated here so a hostile/oversized name never reaches provisioning.
 */
export const BucketDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'Use letters, numbers, spaces, dashes or underscores');

/** Body for `POST /r2/buckets` — create a bucket. */
export const CreateBucketBodySchema = z
  .object({
    name: BucketDisplayNameSchema,
    /** Make a public base URL available (r2.dev). Default private. */
    public: z.boolean().optional(),
    /** Optional data-residency hint (eu | fedramp). */
    jurisdiction: z.enum(['eu', 'fedramp']).optional(),
  })
  .strict();
export type CreateBucketBody = z.infer<typeof CreateBucketBodySchema>;

/**
 * Query for `GET /r2/buckets/:bucket/objects` — prefix + pagination + folder delimiter, PLUS the B11
 * `search` term. When `search` is present the route switches from the paged/folder listing to a
 * BOUNDED server-side whole-bucket scan (substring match across every object, honest truncation flags);
 * an empty/absent `search` keeps the legacy list behavior. `prefix` still narrows the search server-side.
 */
export const ListObjectsQuerySchema = z.object({
  prefix: z.string().max(1024).optional(),
  cursor: z.string().max(4096).optional(),
  delimiter: z.string().max(4).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** B11: whole-bucket search needle. Trimmed; an empty string is treated as "no search". */
  search: z.string().max(256).optional(),
});
export type ListObjectsQuery = z.infer<typeof ListObjectsQuerySchema>;

/** Body for `POST /r2/buckets/:bucket/public` — toggle public access. */
export const SetPublicBodySchema = z.object({ public: z.boolean() }).strict();

/**
 * Body for `POST /r2/buckets/:bucket/environment` (B10) — reassign a bucket's environment (preview ↔
 * production). Bounded to the two valid environments; the route rejects a move that would break the
 * two-default-per-site invariant with a 409 (never a silent corruption). The reply carries
 * `previousEnvironment` so the UI can roll the reassignment back with a single Undo.
 */
export const SetEnvironmentBodySchema = z
  .object({ environment: z.enum(['preview', 'production']) })
  .strict();
export type SetEnvironmentBody = z.infer<typeof SetEnvironmentBodySchema>;

/** Body for a JSON (base64) upload fallback when multipart isn't used. */
export const UploadJsonBodySchema = z
  .object({
    key: z.string().min(1).max(1024),
    contentType: z.string().max(255).optional(),
    /** base64 data URL (`data:<mime>;base64,<...>`) OR bare base64. */
    dataUrl: z.string().min(1),
  })
  .strict();
export type UploadJsonBody = z.infer<typeof UploadJsonBodySchema>;

/**
 * Body for `POST /r2/buckets/:bucket/objects/copy` — copy / move / rename ONE object (or a prefix).
 * `srcKey`/`destKey` are full object keys (a trailing `/` on BOTH makes it a prefix move). `deleteSource:true`
 * turns a copy into a move/rename (copy-then-delete-source). `overwrite:true` opts into clobbering an
 * existing destination (default: refuse with 409).
 *
 * CROSS-bucket: an optional `destBucket` (another of the SAME site's bucket DISPLAY names) targets the copy
 * at a DIFFERENT bucket than the `:bucket` path param — S3 CopyObject copies across buckets in one account.
 * Absent (or equal to the path bucket) ⇒ identical same-bucket behavior. The route ownership-checks BOTH the
 * path bucket AND `destBucket` (a foreign dest → 404 IDOR). A cross-bucket MOVE is copy-to-dest THEN
 * delete-source (no data loss). The `srcKey === destKey` refine is relaxed when `destBucket` differs: the
 * SAME key in ANOTHER bucket is a legitimate copy/move, not a no-op self-copy.
 */
export const CopyObjectBodySchema = z
  .object({
    srcKey: z.string().min(1).max(1024),
    destKey: z.string().min(1).max(1024),
    deleteSource: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    /** Another of the site's bucket display names to copy/move INTO (cross-bucket). Same validation as a create name. */
    destBucket: BucketDisplayNameSchema.optional(),
  })
  .strict()
  .refine((b) => b.srcKey !== b.destKey || (!!b.destBucket && b.destBucket.trim() !== ''), {
    message: 'Source and destination must differ',
    path: ['destKey'],
  });
export type CopyObjectBody = z.infer<typeof CopyObjectBodySchema>;

/** A single object descriptor in a list response (mirrors `SiteR2Object`). */
export const ObjectEntrySchema = z.object({
  key: z.string(),
  size: z.number(),
  uploadedAt: z.string().nullable(),
  etag: z.string().optional(),
  contentType: z.string().nullable().optional(),
});
export type ObjectEntry = z.infer<typeof ObjectEntrySchema>;

/**
 * B7 — the honest accounting the bucket-ZIP route (`GET …/r2/buckets/:bucket/zip`) carries back in its
 * `x-ps-zip-*` response headers (the body is the raw `application/zip`). The export is BOUNDED (object +
 * byte caps built in-Worker-memory), so this contract lets the client surface a truthful "capped at N
 * files / X MB" note instead of implying the archive is complete. `truncated` true ⇒ `included < total`.
 * Header values arrive as strings → coerced here; a consumer that parses the headers validates with this.
 */
export const ZipExportMetaSchema = z.object({
  /** Objects actually written into the zip. */
  included: z.coerce.number().int().min(0),
  /** Objects seen while scanning the bucket (≥ included; diverges once a cap trips). */
  total: z.coerce.number().int().min(0),
  /** Total UNCOMPRESSED bytes written into the zip. */
  bytes: z.coerce.number().int().min(0),
  /** True when an object/byte cap stopped the walk early — the archive is PARTIAL. */
  truncated: z.coerce.boolean(),
});
export type ZipExportMeta = z.infer<typeof ZipExportMetaSchema>;
