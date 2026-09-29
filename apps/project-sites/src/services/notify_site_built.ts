/**
 * @module services/notify_site_built
 *
 * @description
 * The golden-path "customer notified" step (§9) for the EMBEDDED-BOLT publish
 * path. The AI-generation workflow already emails the owner on completion via
 * {@link notifySiteBuilt}; the bolt-editor publish route did not — so a user who
 * published their own edits got no "your site is live" email. This resolves the
 * org owner's email and sends that same gorgeous notification.
 *
 * Fail-soft throughout (progressive-degradation): no owner email → skip silently;
 * a send failure is swallowed. Wrap the call in `ctx.waitUntil` so it never
 * blocks the publish response. Deps are injectable for unit testing without D1.
 *
 * @see services/notifications.ts (notifySiteBuilt — the email template)
 */

import type { Env } from '../types/env.js';
import { dbQueryOne } from './db.js';
import { notifySiteBuilt } from './notifications.js';
import { notifyOwnerEvent } from './notify.js';

/** Resolve the org OWNER's email (the `role='owner'` membership). Null if none. */
export async function resolveOwnerEmail(env: Env, orgId: string): Promise<string | null> {
  const row = await dbQueryOne<{ email: string }>(
    env.DB,
    `SELECT u.email FROM users u JOIN memberships m ON u.id = m.user_id
     WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL AND u.deleted_at IS NULL LIMIT 1`,
    [orgId],
  );
  return row?.email ?? null;
}

/** Facts a publish transition has on hand to notify the owner. */
export interface NotifyOwnerSiteBuiltInput {
  orgId: string;
  siteId: string;
  slug: string;
  version: string;
  /** Display name for the email (falls back to the slug when absent). */
  businessName?: string | null;
}

/** Injectable seams (default to the real resolver + email + bell) for testability. */
export interface NotifyOwnerDeps {
  resolveEmail?: typeof resolveOwnerEmail;
  notify?: typeof notifySiteBuilt;
  bell?: typeof notifyOwnerEvent;
}

/**
 * Notify the org owner that their site is live across BOTH channels: the
 * "Your Site Is Live!" email ({@link notifySiteBuilt}) and the in-app bell
 * (canonical `build.complete` psnotify event via {@link notifyOwnerEvent}). Each channel is
 * independent + fail-soft — one failing never blocks the other or the publish.
 *
 * @param env - Worker env (needs `DB`).
 * @param input - The publish facts ({@link NotifyOwnerSiteBuiltInput}).
 * @param deps - Optional injected seams.
 * @returns `{ emailed, belled }` — per-channel success (false on no-owner/failure).
 * @example ctx.waitUntil(notifyOwnerSiteBuilt(env, { orgId, siteId, slug, version, businessName }))
 */
export async function notifyOwnerSiteBuilt(
  env: Env,
  input: NotifyOwnerSiteBuiltInput,
  deps: NotifyOwnerDeps = {},
): Promise<{ emailed: boolean; belled: boolean }> {
  const resolve = deps.resolveEmail ?? resolveOwnerEmail;
  const notify = deps.notify ?? notifySiteBuilt;
  const bell = deps.bell ?? notifyOwnerEvent;
  const previewUrl = `https://${input.slug}.projectsites.dev`;

  // Channel 1 — the rich email (needs the owner's address).
  let emailed = false;
  try {
    const email = await resolve(env, input.orgId);
    if (email) {
      await notify(env, {
        email,
        siteName: input.businessName || input.slug,
        slug: input.slug,
        siteUrl: previewUrl,
        version: input.version,
      });
      emailed = true;
    }
  } catch {
    emailed = false;
  }

  // Channel 2 — the in-app bell (resolves the owner subscriber internally).
  // CANONICAL PsnotifyEventSchema shape (`{ name, subscriberId, payload }`) — the
  // legacy `{ event, tenantId, siteId, previewUrl }` novu-era object FAILED the
  // schema → invalid_event → the "your site is live" bell silently never fired on
  // the bolt-publish path (fire-54). `build.complete` matches the workflow path's
  // terminal-success channel + buckets to `site_lifecycle` in the DO. The live
  // site URL rides as the bell row's `action_url` deep link.
  let belled = false;
  try {
    const res = await bell(env, env.DB, {
      orgId: input.orgId,
      workflowId: 'build.complete',
      actionUrl: previewUrl,
      event: {
        name: 'build.complete',
        subscriberId: input.orgId,
        payload: {
          subject: `${input.businessName || input.slug} is live 🎉`,
          body: `Your site is published at ${input.slug}.projectsites.dev.`,
          siteId: input.siteId,
          action_url: previewUrl,
        },
      },
    });
    belled = res.ok;
  } catch {
    belled = false;
  }

  return { emailed, belled };
}
