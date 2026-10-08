/**
 * claimyour.site (#1) — completion glue from the build-status callback.
 *
 * @remarks
 * The container/workflow reports terminal build status to
 * `POST /api/internal/build-status` keyed by `jobId` (== the claim build's
 * `siteId`). This resolves that siteId back to its claim session
 * ({@link getSessionBySiteId}) and, when found, drives the terminal session
 * event + owner email via {@link handleClaimBuildResult} — flipping
 * `building → completed | failed`. A non-terminal status, or a siteId with no
 * claim session (a normal non-claim build), is a no-op. Never throws.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';
import { dbQueryOne } from './db.js';
import { getSessionBySiteId, applyClaimEvent } from './claim_session_store.js';
import { getLead } from './lead_store.js';
import { handleClaimBuildResult } from './claim_build_completion.js';
import { sendClaimBuildEmail } from './claim_build_emails.js';
import { sendEmail } from './notifications.js';
import { tryEmitEvent } from './emit_event.js';
import { PLATFORM_CLAIMS_ORG_ID } from './claim_org.js';

/** Container/workflow statuses that mean the build finished successfully. */
const TERMINAL_OK = new Set(['complete', 'completed', 'published', 'success']);
/** Container/workflow statuses that mean the build failed terminally. */
const TERMINAL_FAIL = new Set(['error', 'failed', 'failure']);

/** Build the public preview URL for a finished claim site (`https://{slug}…`). */
async function resolveSiteUrl(env: Env, siteId: string): Promise<string | undefined> {
  const row = await dbQueryOne<{ slug: string }>(
    env.DB,
    'SELECT slug FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  ).catch(() => null);
  return row?.slug ? `https://${row.slug}.projectsites.dev` : undefined;
}

/** Injectable seams (default to the real lookup + completion) for testability. */
export interface ClaimCallbackDeps {
  getSession?: typeof getSessionBySiteId;
  complete?: typeof handleClaimBuildResult;
}

/**
 * If `siteId` belongs to a claim build that just reached a terminal status,
 * flip its session (building → completed | failed) and email the owner.
 *
 * @param env    - Worker env.
 * @param siteId - The finished build's site id (the callback's `jobId`).
 * @param status - The reported build status.
 * @param deps   - Optional injected seams (default to real).
 * @returns `{ handled }` — `false` for a non-terminal status OR a non-claim site.
 */
export async function maybeCompleteClaimBuild(
  env: Env,
  siteId: string,
  status: string,
  deps: ClaimCallbackDeps = {},
): Promise<{ handled: boolean; outcome?: 'completed' | 'failed' }> {
  const ok = TERMINAL_OK.has(status);
  const failed = TERMINAL_FAIL.has(status);
  if (!ok && !failed) return { handled: false }; // not a terminal status — ignore

  const getSession = deps.getSession ?? getSessionBySiteId;
  const session = await getSession(env.DB, siteId).catch(() => null);
  if (!session) return { handled: false }; // not a claim-originated build

  const previewUrl = ok ? await resolveSiteUrl(env, siteId) : undefined;
  const complete = deps.complete ?? handleClaimBuildResult;

  const res = await complete(
    {
      applyEvent: (s, l, e) => applyClaimEvent(env.DB, s, l, e),
      getLead: (id) => getLead(env.DB, id),
      sendEmail: (kind, to, ctx) =>
        sendClaimBuildEmail(kind, to, ctx, {
          send: (m) =>
            sendEmail(env, {
              to: m.to,
              subject: m.subject,
              html: m.html,
              category: 'claim_build',
            }),
        }),
    },
    {
      sessionId: session.sessionId,
      leadId: session.leadId,
      ok,
      ...(previewUrl ? { previewUrl } : {}),
    },
  );

  // Emit the terminal golden-path event onto the durable bus (drained to Hatchet
  // orchestration). Idempotent per siteId so a callback replay never double-emits;
  // fire-and-forget (tryEmitEvent never throws).
  await tryEmitEvent(
    env,
    {
      type: ok ? 'site.published' : 'site.publish.failed',
      producer: 'worker',
      tenantId: PLATFORM_CLAIMS_ORG_ID,
      traceId: siteId,
      siteId,
      data: {
        leadId: session.leadId,
        sessionId: session.sessionId,
        ...(previewUrl ? { previewUrl } : {}),
      },
    },
    { scope: [siteId] },
  );

  return { handled: true, outcome: res.status };
}
