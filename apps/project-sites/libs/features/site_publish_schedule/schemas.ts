import { z } from 'zod';

/**
 * Zod boundary for Scheduled Site Publishing (feature: scheduled_publish).
 * One shared source of truth — the handlers validate against these and the inferred types
 * flow through the service. `.strict()` everywhere so an unknown field is a 400, never a
 * silent drop (zod-everywhere).
 */

/** ISO-8601 datetime (with or without offset) — what the client sends + what D1 stores. */
const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());

/** Request body to schedule (or reschedule) a site's go-live. The FUTURE check is enforced in the handler against Date.now() (a Zod schema can't read the clock). */
export const CreatePublishScheduleSchema = z
  .object({
    publish_at: isoDateTime,
    label: z.string().max(200).nullable().optional(),
  })
  .strict();
export type CreatePublishSchedule = z.infer<typeof CreatePublishScheduleSchema>;

/** A stored schedule row (also the shape the pure {@link resolveDueSchedules} operates on). */
export const PublishScheduleSchema = z
  .object({
    id: z.string(),
    org_id: z.string(),
    site_id: z.string(),
    publish_at: z.string(),
    status: z.enum(['pending', 'fired', 'canceled', 'skipped']),
    label: z.string().nullable(),
    created_at: z.string(),
    fired_at: z.string().nullable(),
  })
  .strict();
export type PublishSchedule = z.infer<typeof PublishScheduleSchema>;

export const PublishScheduleResponseSchema = z
  .object({ schedule: PublishScheduleSchema.nullable() })
  .strict();
export type PublishScheduleResponse = z.infer<typeof PublishScheduleResponseSchema>;

export const PublishScheduleListResponseSchema = z
  .object({ schedules: z.array(PublishScheduleSchema), count: z.number().int() })
  .strict();
export type PublishScheduleListResponse = z.infer<typeof PublishScheduleListResponseSchema>;
