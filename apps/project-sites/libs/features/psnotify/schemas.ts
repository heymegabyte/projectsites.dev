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
 * A stored notification. `id` is a UUIDv7 (time-ordered → list sorts by
 * recency for free); `read_at` is `null` until the owner marks it read.
 * `type` is a short machine tag (e.g. `site.published`); `action_url` is an
 * optional deep link the bell row navigates to.
 */
export const NotificationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).max(64),
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
 * keys (no silent drift), per `mcp-server-hardening` §5.
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

/** `GET /api/notifications` response: the caller's OWN inbox + the unread count. */
export const ListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  unread: z.number().int().nonnegative(),
});
export type ListResponse = z.infer<typeof ListResponseSchema>;

/** `POST /api/notifications/:id/read` response. `updated` is false when the id wasn't in the inbox. */
export const MarkReadResponseSchema = z.object({
  ok: z.literal(true),
  updated: z.boolean(),
});
export type MarkReadResponse = z.infer<typeof MarkReadResponseSchema>;
