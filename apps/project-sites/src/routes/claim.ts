/**
 * claimyour.site — the claim-link funnel route.
 *
 * @remarks
 * `GET /api/claim/:shortlink` is what a claim link points at. It:
 *  1. resolves the shortlink → lead (404 on an unknown link),
 *  2. records the click for attribution ({@link markClaimLinkClicked}),
 *  3. opens (or reuses) the build session — `claim_${shortlink}` is deterministic
 *     so a refresh / re-click reuses the SAME session,
 *  4. on a fresh/failed session, provisions a real site parented to the platform
 *     org ({@link createSite}), records its `siteId` on the session via
 *     `START_BUILD` (the reducer + store make a refresh a no-op → no duplicate
 *     build), and best-effort kicks the SITE_WORKFLOW with the site-shaped params
 *     it consumes ({@link buildClaimSiteParams}),
 *  5. 302-redirects to the prefilled `/create?claim=<shortlink>` funnel.
 *
 * The build SURVIVES the user leaving the page because the session is persisted
 * `building` server-side here. The build-status callback later resolves the
 * finished `siteId` back to this session ({@link getSessionBySiteId}) to flip
 * building→completed + email — see _LOOP_LEDGER fire-v2.51 (remaining wire).
 */
import { Hono } from 'hono';

import type { Env, Variables } from '../types/env.js';

import { sendClaimBuildEmail } from '../services/claim_build_emails.js';
import { canStartBuild } from '../services/claim_build_session.js';
import { toCreateFormPrefill } from '../services/claim_lead_profile.js';
import { markClaimLinkClicked, resolveLeadByShortlink } from '../services/claim_links.js';
import { buildClaimAttribution, claimStartedEventData } from '../services/claim_attribution.js';
import { PLATFORM_CLAIMS_ORG_ID, transferClaimSite } from '../services/claim_org.js';
import {
  applyClaimEvent,
  getSession,
  loadOrCreateSession,
} from '../services/claim_session_store.js';
import { buildClaimSiteParams } from '../services/claim_site_params.js';
import { getLead } from '../services/lead_store.js';
import { sendEmail } from '../services/notifications.js';
import { createSite } from '../services/site_create.js';
import { tryEmitEvent } from '../services/emit_event.js';
import { requireNotAbusive } from '../middleware/abuse.js';

// Re-export so existing importers (+ tests) keep resolving it from this route.
export { PLATFORM_CLAIMS_ORG_ID };

/** Derive a collision-resistant site slug from a business name (+ short rand). */
function deriveClaimSlug(businessName: string): string {
  const base =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'site';
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export const claimRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// §48 app-aware abuse layer. `/adopt` is the ownership-transfer mutation — the one
// claim route that writes (it moves the provisioned site off the platform org onto
// the claiming org). The GET resolve/click route below is deliberately NOT gated: a
// visitor clicking a claim link in their inbox must never 429 into a dead end.
// Fail-OPEN by design until Arcjet lands; CF-native rate_limit.ts remains the floor.
claimRoutes.use('/api/claim/:shortlink/adopt', requireNotAbusive('claim'));

claimRoutes.get('/api/claim/:shortlink', async (c) => {
  const shortlink = c.req.param('shortlink');

  const link = await resolveLeadByShortlink(c.env.DB, shortlink);
  if (!link) {
    // An OWNER clicks this claim link IN THEIR BROWSER (it's the `https://projectsites.dev/api/claim/
    // <token>` URL sent in the claim email) — a raw-JSON `{error:…}` 404 is an embarrassingly-hard
    // dead-end. Redirect to the create funnel with a friendly flag so an expired/invalid link becomes
    // a first-action launchpad (search your business → build), never a scary error blob. The XHR
    // sub-route `/api/claim/:shortlink/profile` keeps its JSON 404 (it's consumed by the SPA).
    return c.redirect('/create?claim_invalid=1', 302);
  }

  // Record the click (attribution) — best-effort, never blocks the funnel.
  try {
    await markClaimLinkClicked(c.env.DB, shortlink);
  } catch {
    /* click metrics are best-effort */
  }

  // Deterministic session id → a refresh / re-click reuses the SAME session.
  const sessionId = `claim_${shortlink}`;
  const session = await loadOrCreateSession(c.env.DB, sessionId, link.leadId);

  if (canStartBuild(session)) {
    // Provision a real site (parented to the platform org) so the SITE_WORKFLOW
    // gets the site-shaped params it actually consumes — then START_BUILD records
    // the siteId on the session (the link the build-status callback resolves back
    // to flip building→completed). Best-effort: any failure leaves the session
    // pending so a re-click retries; the funnel still redirects.
    const lead = await getLead(c.env.DB, link.leadId).catch(() => null);
    if (lead) {
      // Hono's `c.executionCtx` getter THROWS when no ExecutionContext exists
      // (e.g. unit tests) — resolve it safely once so a missing ctx just skips
      // analytics + the background kick instead of failing the whole build.
      let execCtx: ExecutionContext | undefined;
      try {
        execCtx = c.executionCtx;
      } catch {
        execCtx = undefined;
      }
      try {
        const slug = deriveClaimSlug(lead.profile.businessName);
        const site = await createSite(
          c.env,
          {
            businessAddress: lead.profile.address ?? null,
            businessEmail: lead.profile.email ?? null,
            businessName: lead.profile.businessName,
            businessPhone: lead.profile.phone ?? null,
            orgId: PLATFORM_CLAIMS_ORG_ID,
            slug,
          },
          { executionCtx: execCtx, requestId: c.get('requestId') },
        );

        await applyClaimEvent(c.env.DB, sessionId, link.leadId, {
          siteId: site.id,
          type: 'START_BUILD',
        });

        // Normalize click attribution (utm_* + referer) so the golden-path event
        // carries source/medium/campaign — flows through the outbox payload column
        // into Tinybird so the activation funnel can answer "which campaigns convert".
        const attribution = buildClaimAttribution({
          shortlink,
          query: c.req.query(),
          referer: c.req.header('referer'),
          leadId: link.leadId,
        });

        // Emit the golden-path event onto the durable bus (drained every 5 min to
        // Tinybird analytics + Hatchet orchestration). Idempotent per shortlink so
        // a re-click never double-emits; fire-and-forget so it never blocks the 302.
        if (execCtx) {
          execCtx.waitUntil(
            tryEmitEvent(
              c.env,
              {
                type: 'site.claim.started',
                producer: 'worker',
                tenantId: PLATFORM_CLAIMS_ORG_ID,
                traceId: c.get('requestId') ?? site.id,
                siteId: site.id,
                data: { ...claimStartedEventData(attribution, { leadId: link.leadId, slug }) },
              },
              { scope: [shortlink] },
            ),
          );
        }

        const wf = c.env.SITE_WORKFLOW;
        if (wf && typeof wf.create === 'function' && execCtx) {
          execCtx.waitUntil(
            wf
              .create({
                id: site.id,
                params: buildClaimSiteParams(lead.profile, {
                  orgId: PLATFORM_CLAIMS_ORG_ID,
                  siteId: site.id,
                  slug,
                }),
              })
              .catch(() => {
                /* session is already 'building'; the consumer can pick it up */
              }),
          );
        }

        // Tell the owner "we're building it" — the started email completes the
        // claim notification lifecycle (started → finished/failed via the
        // build-status callback). Best-effort + waitUntil'd so it never delays
        // the 302; only sends when the lead has a real recipient address.
        const ownerEmail = lead.profile.email;
        if (ownerEmail && execCtx) {
          execCtx.waitUntil(
            sendClaimBuildEmail(
              'started',
              ownerEmail,
              {
                businessName: lead.profile.businessName,
                createUrl: `https://projectsites.dev/create?claim=${encodeURIComponent(shortlink)}`,
              },
              {
                send: (m) =>
                  sendEmail(c.env, {
                    category: 'claim_build',
                    html: m.html,
                    subject: m.subject,
                    to: m.to,
                  }),
              },
            ).catch(() => {
              /* started email is best-effort; the build proceeds regardless */
            }),
          );
        }
      } catch {
        /* createSite (e.g. slug collision) failed → leave pending; re-click retries */
      }
    }
  }

  // Send the visitor to the prefilled create funnel.
  return c.redirect(`/create?claim=${encodeURIComponent(shortlink)}`, 302);
});

/**
 * `GET /api/claim/:shortlink/profile` — the prefill payload the Angular `/create`
 * page fetches when opened via a claim link. Resolves the shortlink → lead →
 * researched profile, returns the flat form-prefill values + the live build
 * status (so the page can show "building…" while the background build runs).
 */
claimRoutes.get('/api/claim/:shortlink/profile', async (c) => {
  const shortlink = c.req.param('shortlink');
  const link = await resolveLeadByShortlink(c.env.DB, shortlink);
  if (!link) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'This claim link is not valid.' } }, 404);
  }
  const lead = await getLead(c.env.DB, link.leadId);
  if (!lead) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'This lead is no longer available.' } },
      404,
    );
  }
  const sessionId = `claim_${shortlink}`;
  const session = await getSession(c.env.DB, sessionId);
  return c.json({
    data: {
      buildStatus: session?.status ?? 'pending',
      prefill: toCreateFormPrefill(lead.profile),
      previewUrl: session?.previewUrl ?? null,
      sessionId,
    },
  });
});

/**
 * `POST /api/claim/:shortlink/adopt` — the authed visitor claims the build.
 *
 * Re-parents the claim-built site (currently owned by the platform org) to the
 * caller's org ({@link transferClaimSite}, design option A second half). 401 when
 * anonymous; 404 when the shortlink has no started build; 409 when the site was
 * already claimed by another org. Idempotent for the caller's own org.
 */
claimRoutes.post('/api/claim/:shortlink/adopt', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in to claim this site.' } }, 401);
  }

  const shortlink = c.req.param('shortlink');
  const session = await getSession(c.env.DB, `claim_${shortlink}`);
  if (!session?.siteId) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'No site to claim for this link yet.' } },
      404,
    );
  }

  const result = await transferClaimSite(c.env, session.siteId, orgId, userId);
  if (result.transferred) {
    // The claim funnel's conversion moment: the visitor adopted the platform-
    // built site into THEIR org. Emit site.claim.completed onto the durable bus
    // (Tinybird conversion analytics + Hatchet onboarding orchestration).
    // tenantId is the NEW owner org. Idempotent per (shortlink, siteId) — a
    // re-adopt returns transferred:false so this only fires on the real transfer;
    // never throws. Awaited inline so the event lands before we ack the claim.
    await tryEmitEvent(
      c.env,
      {
        type: 'site.claim.completed',
        producer: 'worker',
        tenantId: orgId,
        traceId: c.get('requestId') ?? session.siteId,
        siteId: session.siteId,
        userId,
        data: {
          shortlink,
          ...(session.leadId ? { leadId: session.leadId } : {}),
          ...(result.slug ? { slug: result.slug } : {}),
          fromOrg: PLATFORM_CLAIMS_ORG_ID,
        },
      },
      { scope: [shortlink, session.siteId] },
    );
    return c.json({ data: { claimed: true, siteId: session.siteId, slug: result.slug } }, 200);
  }
  if (result.reason === 'already_yours') {
    return c.json({ data: { claimed: true, siteId: session.siteId } }, 200);
  }
  if (result.reason === 'already_claimed') {
    return c.json(
      { error: { code: 'CONFLICT', message: 'This site has already been claimed.' } },
      409,
    );
  }
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'No site to claim for this link yet.' } },
    404,
  );
});
