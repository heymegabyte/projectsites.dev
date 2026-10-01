/**
 * claim_flow — Hono route handlers.
 *
 * @remarks
 * `POST /api/sites/:siteId/claim/checkout` — the paid-claim ($29/mo) checkout.
 * Guard order (each earlier guard hides the later surface):
 *
 *  1. **Flag** `claim_flow` OFF → 404 dark (never 403 — never leak existence).
 *  2. **Auth** — anonymous → 401 with owner-grade copy.
 *  3. **Ownership** — {@link assertSiteOwned} (the canonical `:siteId` IDOR
 *     guard): foreign/ghost/deleted site → 404.
 *  4. **Already claimed** → 409 (the money path is never double-charged from
 *     a stale tab; the portal manages an existing subscription).
 *
 * The session's `metadata[site_id]`/`metadata[org_id]` make the EXISTING
 * `checkout.session.completed` webhook mark the site claimed — no webhook
 * changes in this module.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';

import type { Env, Variables } from '../../../src/types/env.js';

import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { dbQueryOne } from '../../../src/services/db.js';
import { writeAuditLog } from '../../../src/services/audit.js';
import { claimCheckoutRequestSchema } from './schemas.js';
import { createClaimCheckoutSession } from './service.js';

export const claimFlowRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

claimFlowRoutes.post('/api/sites/:siteId/claim/checkout', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');

  // 1. Flag gate — DARK → 404 (never 403; don't reveal the surface exists).
  if (!(await isFlagOn(c.env, 'claim_flow', { orgId, siteId }))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }

  // 2. Auth.
  if (!orgId || !userId) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Sign in to claim this site.' } },
      401,
    );
  }

  // 3. Canonical multi-tenant ownership guard (IDOR class) — foreign site → 404.
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  }

  // 4. Already claimed → 409; manage the subscription in the billing portal instead.
  const siteRow = await dbQueryOne<{ plan: string }>(
    c.env.DB,
    'SELECT plan FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  if (siteRow?.plan === 'paid') {
    return c.json(
      {
        error: {
          code: 'CONFLICT',
          message: 'This site is already claimed. Manage your plan from Billing.',
        },
      },
      409,
    );
  }

  // Body is optional; when present it must validate (never trust a redirect URL raw).
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = claimCheckoutRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'success_url and cancel_url must be valid URLs when provided.',
        },
      },
      400,
    );
  }

  const userRow = await dbQueryOne<{ email: string }>(
    c.env.DB,
    'SELECT email FROM users WHERE id = ? AND deleted_at IS NULL',
    [userId],
  );

  const successUrl =
    parsed.data.success_url ??
    `https://projectsites.dev/admin/billing?claim=success&site=${encodeURIComponent(siteId)}`;
  const cancelUrl =
    parsed.data.cancel_url ??
    `https://projectsites.dev/admin/billing?claim=cancelled&site=${encodeURIComponent(siteId)}`;

  const result = await createClaimCheckoutSession(c.env.DB, c.env, {
    orgId,
    siteId,
    customerEmail: userRow?.email ?? '',
    successUrl,
    cancelUrl,
  });

  // Best-effort audit — never blocks the money path.
  writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'billing.checkout_created',
    message: `Claim checkout ($29/mo) started for site '${siteId}'`,
    target_type: 'billing',
    target_id: siteId,
    metadata_json: { kind: 'claim', session_id: result.session_id },
    request_id: c.get('requestId'),
  }).catch(() => undefined);

  return c.json({ data: result });
});
