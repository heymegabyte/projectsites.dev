import { z } from 'zod';

/**
 * Zod boundary for the Prompt Scheduler (feature: prompt_schedule).
 * One shared source of truth — the handlers validate requests against these and the
 * inferred types flow through the service. `.strict()` everywhere so an unknown field
 * is a 400, never silently dropped (zod-everywhere).
 */

/** ISO-8601 datetime string (what D1 stores + what the client sends). */
const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());

/** Request body to create a schedule. deactivate_at optional (null = open-ended). */
export const CreatePromptScheduleSchema = z
  .object({
    prompt_key: z.string().min(1).max(120),
    variant: z.string().min(1).max(120),
    activate_at: isoDateTime,
    deactivate_at: isoDateTime.nullable().optional(),
    label: z.string().max(200).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => !v.deactivate_at || Date.parse(v.deactivate_at) > Date.parse(v.activate_at),
    { message: 'deactivate_at must be after activate_at', path: ['deactivate_at'] },
  );
export type CreatePromptSchedule = z.infer<typeof CreatePromptScheduleSchema>;

/** A stored schedule row (also the shape the pure resolver operates on). */
export const PromptScheduleSchema = z
  .object({
    id: z.string(),
    org_id: z.string().nullable(),
    prompt_key: z.string(),
    variant: z.string(),
    activate_at: z.string(),
    deactivate_at: z.string().nullable(),
    label: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type PromptSchedule = z.infer<typeof PromptScheduleSchema>;

export const PromptScheduleListResponseSchema = z
  .object({ schedules: z.array(PromptScheduleSchema), count: z.number().int() })
  .strict();
export type PromptScheduleListResponse = z.infer<typeof PromptScheduleListResponseSchema>;

/** GET /active?key= — the variant currently scheduled for a key (or null). */
export const ActiveScheduleResponseSchema = z
  .object({
    prompt_key: z.string(),
    variant: z.string().nullable(),
    schedule_id: z.string().nullable(),
    label: z.string().nullable(),
    resolved_at: z.string(),
  })
  .strict();
export type ActiveScheduleResponse = z.infer<typeof ActiveScheduleResponseSchema>;
