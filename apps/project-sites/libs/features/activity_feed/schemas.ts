import { z } from 'zod';

/** Known activity event kinds. */
export const ACTIVITY_KINDS = [
  'build.started', 'build.completed', 'build.failed',
  'site.published', 'site.archived', 'site.deleted',
  'snapshot.created', 'snapshot.deleted',
  'domain.added', 'domain.removed',
  'billing.plan_changed', 'billing.payment_failed',
  'member.invited', 'member.removed',
  'workflow.started', 'workflow.completed',
  'integration.connected', 'integration.disconnected',
  'settings.updated', 'data.query',
  // Neutral generic — the honest fallback for an unmapped audit action (was wrongly
  // `build.completed`, mislabeling every settings/snapshot/AI event as "Build").
  'activity',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** A single activity feed entry. */
export const ActivityEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  summary: z.string(),
  actorName: z.string().nullable(),
  targetType: z.string().nullable(),
  targetName: z.string().nullable(),
  siteSlug: z.string().nullable(),
  timestamp: z.string(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/** Paginated activity feed response. */
export const ActivityFeedResponseSchema = z.object({
  data: z.array(ActivityEntrySchema),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ActivityFeedResponse = z.infer<typeof ActivityFeedResponseSchema>;
