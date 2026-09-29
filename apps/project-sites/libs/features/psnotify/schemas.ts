/**
 * @module libs/features/psnotify/schemas
 *
 * Zod contracts for the psnotify Durable Object inbox (first slice). One
 * notification row + the DO method payloads + the authed HTTP response shapes.
 * Types are inferred (`z.infer`) — never hand-duplicated — per `zod-everywhere`.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/** The feature-flag key gating every psnotify inbox surface (dark by default). */
export const FLAG_KEY = 'psnotify' as const;

/**
 * The CANONICAL notification-type registry. Derived from the real `notifyUser`
 * callers (`services/notify.ts` → `triggerPsnotify` → the DO `type`), collapsed
 * into six operator-meaningful categories the bell can icon + filter by. Every
 * stored notification's `type` is one of these — the DO coerces free-form
 * workflow names into the nearest bucket via {@link coerceNotificationType}, so
 * a hard enum can be enforced WITHOUT rejecting live fire-and-forget writes.
 *
 * - `site_lifecycle` — publish / build-complete / reset / deploy of a site.
 * - `domain`         — custom-hostname / DNS / subdomain events.
 * - `billing`        — subscription / payment / plan / entitlement events.
 * - `build_progress` — in-flight generation progress (non-terminal).
 * - `security`       — auth / access / secret / suspicious-activity events.
 * - `system`         — platform + generic notices (the catch-all default).
 */
export const NOTIFICATION_TYPES = [
  'site_lifecycle',
  'domain',
  'billing',
  'build_progress',
  'security',
  'system',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/**
 * Map an arbitrary incoming `type` (a workflow id / event name that live
 * `notifyUser` callers pass, e.g. `site-published`, `ps-notify`, `domain_active`)
 * to a canonical {@link NotificationType}. Unknown → `system`. Pure — the DO
 * calls this on every `add` so the stored `type` is always canonical while
 * fire-and-forget writes never reject. Match order is specific → generic.
 */
export function coerceNotificationType(raw: string): NotificationType {
  const t = raw.toLowerCase();
  if (NOTIFICATION_TYPES.includes(t as NotificationType)) return t as NotificationType;
  if (/(site|publish|build.?complete|deploy|reset|snapshot)/.test(t)) return 'site_lifecycle';
  if (/(build|generat|progress)/.test(t)) return 'build_progress';
  if (/(domain|hostname|dns|subdomain|cname)/.test(t)) return 'domain';
  if (/(bill|payment|subscription|plan|invoice|entitlement|stripe)/.test(t)) return 'billing';
  if (/(security|auth|login|access|secret|breach|suspicious)/.test(t)) return 'security';
  return 'system';
}

/**
 * A stored notification. `id` is a UUIDv7 (time-ordered → list sorts by
 * recency for free); `read_at` is `null` until the owner marks it read.
 * `type` is a canonical {@link NotificationType}; `action_url` is an optional
 * deep link the bell row navigates to.
 */
export const NotificationSchema = z.object({
  id: z.string().min(1),
  type: NotificationTypeSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(2000).default(''),
  action_url: z.string().url().max(2048).nullable().default(null),
  read_at: z.number().int().nonnegative().nullable().default(null),
  created_at: z.number().int().nonnegative(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * Input to `add(notification)` — the caller supplies the content; the DO mints
 * `id` + `created_at` and starts `read_at` null. `.strict()` rejects unknown
 * keys (no silent drift), per `mcp-server-hardening` §5. `type` accepts any
 * short string here (live callers pass raw workflow ids) — the DO canonicalizes
 * it via {@link coerceNotificationType} before storing, so the STORED type is
 * always a {@link NotificationType} while no live write is rejected.
 */
export const AddNotificationInputSchema = z
  .object({
    type: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    body: z.string().max(2000).optional().default(''),
    action_url: z.string().url().max(2048).nullable().optional().default(null),
  })
  .strict();
export type AddNotificationInput = z.infer<typeof AddNotificationInputSchema>;

/** Query for `list({unreadOnly,limit})` — both optional, limit clamped 1..200. */
export const ListQuerySchema = z
  .object({
    unreadOnly: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();
export type ListQuery = z.infer<typeof ListQuerySchema>;

/**
 * The DO's internal `list()` result — the natural inbox shape (rows + unread
 * count). Stays the DO's contract; the HTTP handler maps it to the legacy
 * {@link ListResponse} bell shape at the boundary.
 */
export const InboxListResultSchema = z.object({
  notifications: z.array(NotificationSchema),
  unread: z.number().int().nonnegative(),
});
export type InboxListResult = z.infer<typeof InboxListResultSchema>;

/**
 * `GET /api/notifications` HTTP response — the LEGACY D1 bell contract
 * (`libs/features/notifications` + `notification-bell.component.ts`): `data` is
 * the caller's OWN inbox, `unread_count` the unread total. Aligning to this shape
 * (from the old `{ notifications, unread }`) makes promoting psnotify a clean
 * flag-flip — the bell needs no change.
 */
export const ListResponseSchema = z.object({
  data: z.array(NotificationSchema),
  unread_count: z.number().int().nonnegative(),
});
export type ListResponse = z.infer<typeof ListResponseSchema>;

/** `POST /api/notifications/:id/read` response. `updated` is false when the id wasn't in the inbox. */
export const MarkReadResponseSchema = z.object({
  ok: z.literal(true),
  updated: z.boolean(),
});
export type MarkReadResponse = z.infer<typeof MarkReadResponseSchema>;

/**
 * `POST /api/notifications/read-all` response. `updated` is the COUNT of rows
 * flipped unread→read (0 when the inbox was already fully read), mirroring the
 * DO `markAllRead()` batch return.
 */
export const MarkAllReadResponseSchema = z.object({
  ok: z.literal(true),
  updated: z.number().int().nonnegative(),
});
export type MarkAllReadResponse = z.infer<typeof MarkAllReadResponseSchema>;
