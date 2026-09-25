/**
 * @module libs/features/vectorize_inspector/schemas
 * @description Zod schemas for the read-only Vectorize Index Inspector.
 */

import { z } from 'zod';

/**
 * Validates a `:name` path param (a Vectorize index name) as a bounded slug — the only
 * shape Cloudflare accepts — so a hostile value can never be injected into the REST path.
 * This is NOT an authorization boundary (the super-admin gate is); an unknown-but-valid
 * name simply 404s from the CF API, surfaced honestly as `found:false`.
 */
export const VectorizeIndexNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'A Vectorize index name is a slug (letters/digits/hyphens).');

export type VectorizeIndexName = z.infer<typeof VectorizeIndexNameSchema>;
