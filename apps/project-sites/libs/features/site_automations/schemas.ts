/**
 * @module libs/features/site_automations/schemas
 * @description Zod schemas for the Automations discovery endpoint — the UI-list
 * shape of a site's workflow/automation instances. Single source of truth for
 * this feature's contract (per [[zod-everywhere]]).
 */
import { z } from 'zod';

/** One automation/workflow instance, shaped for the Automations panel list. */
export const Automation = z.object({
  /** The `workflow_jobs.id` (job instance id). */
  id: z.string(),
  /** The job kind (`workflow_jobs.job_name`), e.g. `site-generation`. */
  type: z.string(),
  /** `queued | running | success | failed`. */
  status: z.string(),
  /** ISO timestamp the job was created. */
  created_at: z.string(),
  /** ISO timestamp the job finished, or `null` while still in flight. */
  finished_at: z.string().nullable(),
});
export type Automation = z.infer<typeof Automation>;

/** Response envelope for GET /api/sites/:siteId/automations. */
export const ListAutomationsResponse = z.object({
  data: z.array(Automation),
});
export type ListAutomationsResponse = z.infer<typeof ListAutomationsResponse>;

/**
 * Route params for POST /api/sites/:siteId/automations/:id/retry — the RETRY mutation.
 * Both ids are opaque non-empty strings (site id + the failed `workflow_jobs` instance
 * id); the handler owns ownership + flag gating, this only guards the shape.
 */
export const RetryAutomationParams = z.object({
  siteId: z.string().min(1).max(128),
  id: z.string().min(1).max(128),
});
export type RetryAutomationParams = z.infer<typeof RetryAutomationParams>;

/** Response envelope for the retry mutation. */
export const RetryAutomationResponse = z.object({
  ok: z.literal(true),
  /** The status the site was flipped to by the re-dispatch. */
  status: z.literal('building'),
});
export type RetryAutomationResponse = z.infer<typeof RetryAutomationResponse>;
