/**
 * @module libs/features/r2_bucket_manager/schemas
 * @description Zod I/O schemas for the R2 Bucket Manager API (the authoritative site-scoped bucket
 * catalog surface). Every request body/query crossing the worker boundary is validated here (per
 * `zod-everywhere`); types are inferred via `z.infer`, never hand-duplicated.
 *
 * Slice 1 ships the flag key + the list-query + create-name schemas; mutation-body schemas (reset /
 * rotate / delete) land with their slices. The create-name schema mirrors `r2_buckets/schemas.ts`
 * `BucketDisplayNameSchema` so the two surfaces validate names identically.
 */
import { z } from 'zod';

/** The flag gating the entire R2 Bucket Manager surface (default-off / DARK). */
export const R2_BUCKET_MANAGER_FLAG = 'r2_bucket_manager' as const;

/**
 * A tenant-facing bucket display name — what the owner types for a NEW bucket. Sanitized +
 * site-prefixed server-side into the real R2 bucket name; validated here so a hostile/oversized name
 * never reaches provisioning. Kept in lockstep with `site_r2_manager.isValidNewBucketName`.
 */
export const NewBucketNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'Use letters, numbers, spaces, dashes or underscores');

/** Query for `GET …/r2/manager/buckets` — cursor pagination over the site's own custom buckets. */
export const ListManagerBucketsQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListManagerBucketsQuery = z.infer<typeof ListManagerBucketsQuerySchema>;

/** Body for `POST …/r2/manager/buckets` — create a custom bucket (later slice). */
export const CreateManagerBucketBodySchema = z
  .object({
    name: NewBucketNameSchema,
    /** Optional data-residency hint (eu | fedramp). */
    jurisdiction: z.enum(['eu', 'fedramp']).optional(),
  })
  .strict();
export type CreateManagerBucketBody = z.infer<typeof CreateManagerBucketBodySchema>;

/** One bucket in the authoritative list response (mirrors `SiteR2ManagerBucket`, secret-free). */
export const ManagerBucketViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  bucketName: z.string(),
  isSystem: z.boolean(),
  mutable: z.boolean(),
  kind: z.enum(['system', 'custom']),
  jurisdiction: z.string().nullable(),
  provisionState: z.enum(['provisioning', 'active', 'deleting', 'retired']),
});
export type ManagerBucketView = z.infer<typeof ManagerBucketViewSchema>;
