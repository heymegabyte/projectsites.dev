/**
 * Zod contract for the lead-notification payload (flag: lead_notifications).
 *
 * `notifyNewLead` (src/services/notifications.ts) emails the site owner when a public
 * contact form is submitted. This schema is the boundary contract for that payload —
 * the unit test validates that the wiring builds a conforming object before it reaches
 * the SES rail. Per `zod-everywhere`, the notification input is a real boundary.
 */
import { z } from 'zod';

/** Recipient + lead metadata for a new-lead owner notification email. */
export const LeadNotificationSchema = z
  .object({
    /** Resolved owner recipient (ai_site_settings.reply_email ?? org owner). */
    email: z.string().email(),
    /** Business/site display name for the subject + body. */
    siteName: z.string().min(1),
    /** Site slug (for correlation + links). */
    slug: z.string().min(1),
    /** The form the lead came through (e.g. "contact"). */
    formName: z.string().min(1),
    /** The lead's own email, when they provided one (optional). */
    leadEmail: z.string().email().optional(),
    /** Arbitrary submitted fields; values are HTML-escaped before rendering. */
    fields: z.record(z.unknown()),
    /** Absolute URL to the owner's /admin/forms inbox. */
    adminUrl: z.string().url(),
  })
  .strict();

/** Inferred payload type — never hand-maintained alongside the schema. */
export type LeadNotification = z.infer<typeof LeadNotificationSchema>;
