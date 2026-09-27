/**
 * @module libs/features/queues_inspector/schemas
 * @description Zod schemas for the read-only Queues Inspector.
 */

import { z } from 'zod';

/**
 * Validates a `:id` path param (a Cloudflare Queue ID) as a bounded hex/slug — the only
 * shape the API accepts — so a hostile value can never be injected into the REST path.
 * NOT an authorization boundary (the super-admin gate is); an unknown-but-valid id simply
 * 404s from the CF API, surfaced honestly as `found:false`.
 */
export const QueueIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/i, 'A Queue ID is a hex/slug identifier.');

export type QueueId = z.infer<typeof QueueIdSchema>;
