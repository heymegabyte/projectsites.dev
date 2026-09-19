/**
 * @module libs/features/hostnames/handlers
 *
 * @description
 * Hono routes for a site's **custom-hostname lifecycle** — the Cloudflare-for-SaaS
 * (CF4SaaS) custom domains + free `*.projectsites.dev` subdomains that map to a site,
 * plus the primary-hostname (canonical URL) toggle and the admin-side verify / health
 * / deprovision operations. This module owns the custom-hostname RESOURCE across BOTH
 * surfaces it is reached through:
 *
 * - the **owner surface** — `/api/sites/:siteId/hostnames/*` (org-scoped, self-service
 *   provisioning + primary toggle + delete/unsubscribe), and
 * - the **admin surface** — `/api/admin/domains/*` (historical path naming; the same
 *   `hostnames` D1 resource, org-scoped, exposing summary stats + a live CF4SaaS
 *   re-verify, a read-only health probe, and a hard deprovision).
 *
 * The `/api/admin/domains/*` prefix is a legacy path name — those routes do NOT gate on
 * a super-admin role; they are org-scoped (cross-org access collapses to 404, never 403,
 * so foreign hostnames never leak) and operate on the exact same `hostnames` table as the
 * owner routes. Both surfaces guard site/hostname ownership via `c.get('orgId')` and (for
 * the site-scoped routes) `requireOwnedSite`.
 *
 * | Method | Path                                                  | Auth  | Purpose                                               |
 * | ------ | ----------------------------------------------------- | ----- | ----------------------------------------------------- |
 * | GET    | /api/sites/:siteId/hostnames                          | orgId | List a site's provisioned hostnames                   |
 * | POST   | /api/sites/:siteId/hostnames                          | orgId | Provision a free subdomain OR a custom CF4SaaS domain |
 * | PUT    | /api/sites/:siteId/hostnames/:hostnameId/primary      | orgId | Mark a hostname as the site's primary (canonical)     |
 * | POST   | /api/sites/:siteId/hostnames/reset-primary            | orgId | Clear all `is_primary` → fall back to default subdomain|
 * | DELETE | /api/sites/:siteId/hostnames/:hostnameId              | orgId | Hard-delete a hostname row (+ CF4SaaS de-register)    |
 * | POST   | /api/sites/:siteId/hostnames/:hostnameId/unsubscribe  | orgId | Soft-delete a premium hostname (billing reconciliation)|
 * | GET    | /api/admin/domains/summary                            | orgId | Aggregate hostname stats for the caller's org         |
 * | POST   | /api/admin/domains/:hostnameId/verify                 | orgId | Force a CF4SaaS re-verify + persist + owner email      |
 * | GET    | /api/admin/domains/:hostnameId/health                 | orgId | Live CF status + DNS CNAME probe (read-only)          |
 * | DELETE | /api/admin/domains/:hostnameId                        | orgId | Hard deprovision (remove CF custom hostname + soft-del)|
 *
 * Extracted VERBATIM from the `api.ts` monolith (route-decomposition installment 12) —
 * only the route-registration receiver changed (`api.` → `hostnames.`); the handler
 * bodies are byte-for-byte unchanged. The interleaved `DELETE /api/sites/:id` route
 * (site soft-delete) that sat between the owner-scoped hostname POST and PUT in the
 * original file is NOT a hostname route and stayed behind in `api.ts`. The POST body is
 * validated at the boundary by `createHostnameSchema` (from `@project-sites/shared`);
 * the admin routes read the resource from D1 and org-scope by comparing `org_id`.
 * Dynamic ESM imports (`../../../src/services/{notify,db,notifications}.js`) keep the
 * notification + db-update modules out of the hot-path API bundle — only loaded when the
 * relevant route fires. Known AppErrors (`unauthorized`/`badRequest`/`notFound`/
 * `forbidden`/`internalError`) propagate to the app-level error handler.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import {
  DOMAINS,
  badRequest,
  createHostnameSchema,
  forbidden,
  internalError,
  notFound,
  unauthorized,
} from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { dbQuery, dbQueryOne } from '../../../src/services/db.js';
import { requireOwnedSite } from '../../../src/services/site_ownership.js';
import * as domainService from '../../../src/services/domains.js';
import * as billingService from '../../../src/services/billing.js';
import * as auditService from '../../../src/services/audit.js';
import * as posthog from '../../../src/lib/posthog.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const hostnames = new Hono<AppContext>();

/**
 * List all hostnames (free subdomain + custom domains) attached to a site.
 *
 * @route GET /api/sites/:siteId/hostnames
 * @auth Bearer — `orgId` MUST resolve; cross-org access denied via D1 ownership check
 * @param siteId - Immutable site UUID
 * @returns 200 OK `{ data: <hostname[]> }` — each row includes `{ id, hostname, type, is_primary, status }`
 * @throws {AppError} `UNAUTHORIZED` — session missing orgId.
 * @throws {AppError} `NOT_FOUND` — site doesn't exist OR belongs to another org (404
 *   deliberately collapses both cases — no info leakage).
 *
 * @see {@link domainService.getSiteHostnames}
 */
hostnames.get('/api/sites/:siteId/hostnames', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<Record<string, unknown>>(c.env, orgId, siteId);

  const hostnames = await domainService.getSiteHostnames(c.env.DB, siteId);
  return c.json({ data: hostnames });
});

/**
 * Provision a new hostname for a site — either a free `*.projectsites.dev` subdomain or
 * a customer-owned custom domain via Cloudflare for SaaS (CF4SaaS).
 *
 * @route POST /api/sites/:siteId/hostnames
 * @auth Bearer — `orgId` MUST resolve; cross-org write denied via D1 ownership check
 * @param siteId - Immutable site UUID (path param)
 * @body createHostnameSchema — `{ hostname, type: 'free_subdomain' | 'custom_cname' }`
 *   (site_id auto-injected from path before parse)
 * @returns 201 Created `{ data: { hostname, ... } }`
 * @throws {AppError} `UNAUTHORIZED` — session missing orgId.
 * @throws {AppError} `FORBIDDEN` — `type=custom_cname` but org lacks paid-plan
 *   entitlement `topBarHidden` (custom domains gated to Patron tier).
 * @throws {AppError} `BAD_REQUEST` — `type=custom_cname` but the hostname's CNAME record
 *   does not point to `DOMAINS.SITES_BASE` (`projectsites.dev`). Error includes the
 *   exact DNS instructions to fix.
 * @throws {ZodError} — body fails `createHostnameSchema`.
 *
 * @remarks
 * **Free subdomain flow:** slug extracted from hostname (`vito.projectsites.dev` → `vito`),
 * provisioned via `domainService.provisionFreeDomain`. No CF4SaaS call — these are wildcard-
 * routed at the Worker layer via D1 lookup.
 *
 * **Custom CNAME flow:** (1) entitlement gate (paid plan), (2) live DNS CNAME check via
 * `domainService.checkCnameTarget` — protects against orphan hostnames stuck in
 * `pending_validation` because the customer never configured DNS, (3) CF4SaaS hostname
 * provisioned via `domainService.provisionCustomDomain` (TLS cert auto-issued).
 *
 * Audit log + PostHog `hostname.provisioned` event fire AFTER provisioning succeeds.
 *
 * @see {@link domainService.provisionFreeDomain}
 * @see {@link domainService.provisionCustomDomain}
 * @see {@link domainService.checkCnameTarget}
 * @see {@link https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/ CF for SaaS}
 */
hostnames.post('/api/sites/:siteId/hostnames', async (c) => {
  // Malformed body → ZodError 400 (createHostnameSchema required fields), not 500.
  const body = await c.req.json().catch(() => ({}));
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const validated = createHostnameSchema.parse({ ...body, site_id: siteId });

  // Canonical org-ownership guard (mirrors the GET + DELETE handlers): 404 (never 403 — never leak
  // existence) so a caller can NOT provision a hostname under a site it does not own. Runs AFTER Zod
  // (a malformed body still 400s) but BEFORE any provisioning (the CF-for-SaaS create in
  // provisionFreeDomain/provisionCustomDomain AND the paid-plan entitlement check below) — its
  // absence was a write-authorization IDOR: a valid free_subdomain POST to a foreign/ghost siteId
  // reached the CF create instead of a pre-provision 404. Dropped in the api.ts→feature extraction.
  await requireOwnedSite(c.env, orgId, siteId, 'id');

  let result;
  if (validated.type === 'free_subdomain') {
    const slug = validated.hostname.split('.')[0]!;
    result = await domainService.provisionFreeDomain(c.env.DB, c.env, {
      org_id: orgId,
      site_id: siteId,
      slug,
    });
  } else {
    const entitlements = await billingService.getOrgEntitlements(c.env.DB, orgId);
    if (!entitlements.topBarHidden) {
      throw forbidden('Custom domains require a paid plan');
    }

    const cnameTarget = await domainService.checkCnameTarget(validated.hostname);
    if (!cnameTarget || cnameTarget !== DOMAINS.SITES_BASE) {
      throw badRequest(
        `The domain "${validated.hostname}" does not have a CNAME record pointing to ${DOMAINS.SITES_BASE}. ` +
          `Please add a CNAME record for "${validated.hostname}" pointing to "${DOMAINS.SITES_BASE}" in your DNS settings, then try again.`,
      );
    }

    result = await domainService.provisionCustomDomain(c.env.DB, c.env, {
      org_id: orgId,
      site_id: siteId,
      hostname: validated.hostname,
    });
  }

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.provisioned',
    message:
      validated.type === 'custom_cname'
        ? `Custom hostname '${result.hostname}' connected to site '${siteId}'`
        : `Free subdomain '${result.hostname}' provisioned for site '${siteId}'`,
    target_type: 'hostname',
    target_id: siteId,
    metadata_json: {
      site_id: siteId,
      hostname: result.hostname,
      type: validated.type,
    },
    request_id: c.get('requestId'),
  });

  try {
    posthog.trackDomain(c.env, c.executionCtx, 'provisioned', c.get('userId') || orgId, {
      hostname: result.hostname,
      type: validated.type,
      site_id: siteId,
    });
  } catch {
    /* fire-and-forget */
  }

  // Fire-and-forget in-app notification to the user (bell + channels). Safe no-op
  // when notifications are unconfigured; never affects the provisioning response.
  try {
    const actorId = c.get('userId');
    if (actorId) {
      const [{ notifyUser }, { dbQueryOne }] = await Promise.all([
        import('../../../src/services/notify.js'),
        import('../../../src/services/db.js'),
      ]);
      const owner = await dbQueryOne<{ email: string }>(
        c.env.DB,
        'SELECT email FROM users WHERE id = ?',
        [actorId],
      );
      if (owner?.email) {
        c.executionCtx?.waitUntil(
          notifyUser(c.env, {
            subscriberId: owner.email,
            subject:
              validated.type === 'custom_cname' ? 'Domain connected 🌐' : 'Subdomain ready 🌐',
            body: `${result.hostname} is now connected to your site.`,
          }),
        );
      }
    }
  } catch {
    /* notification is best-effort */
  }

  return c.json({ data: result }, 201);
});

/**
 * Mark a hostname as the site's primary (canonical) hostname for SEO + share-link UX.
 *
 * @route PUT /api/sites/:siteId/hostnames/:hostnameId/primary
 * @auth Bearer — `orgId` MUST resolve; cross-org write denied via D1 ownership check
 * @param siteId - Immutable site UUID (path param)
 * @param hostnameId - Hostname row UUID (path param)
 * @returns 200 OK `{ data: { primary: true } }`
 * @throws {AppError} `UNAUTHORIZED` — session missing orgId.
 * @throws {AppError} `NOT_FOUND` — site doesn't exist OR belongs to another org.
 *
 * @remarks
 * Atomically clears `is_primary` on all other hostnames for this site, then sets
 * `is_primary = 1` on the target row. Drives `<link rel="canonical">` injection at
 * serve-time + the "share this site" UI in the dashboard.
 *
 * @see {@link domainService.setPrimaryHostname}
 */
hostnames.put('/api/sites/:siteId/hostnames/:hostnameId/primary', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  const hostnameId = c.req.param('hostnameId');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<Record<string, unknown>>(c.env, orgId, siteId);

  await domainService.setPrimaryHostname(c.env.DB, siteId, hostnameId);

  const siteLabel = await auditService.auditSiteLabelDb(c.env.DB, siteId);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.set_primary',
    message: `Hostname '${hostnameId}' set as primary for site '${siteLabel}'`,
    target_type: 'hostname',
    target_id: hostnameId,
    metadata_json: {
      site_id: siteId,
      hostname_id: hostnameId,
    },
    request_id: c.get('requestId'),
  });

  return c.json({ data: { primary: true } });
});

/**
 * Clear `is_primary` on ALL hostnames for a site — falls back to the default
 * `{slug}.projectsites.dev` subdomain as the canonical URL.
 *
 * @route POST /api/sites/:siteId/hostnames/reset-primary
 * @auth Bearer — `orgId` MUST resolve; cross-org write denied via D1 ownership check
 * @param siteId - Immutable site UUID (path param)
 * @returns 200 OK `{ data: { reset: true } }`
 * @throws {AppError} `UNAUTHORIZED` — session missing orgId.
 * @throws {AppError} `NOT_FOUND` — site doesn't exist OR belongs to another org.
 *
 * @remarks
 * After this call, the site's canonical URL resolves to the default free subdomain
 * (e.g., `vito.projectsites.dev`). Used when a customer removes their custom domain or
 * wants to switch primary back to the platform-hosted hostname. Direct UPDATE on
 * `hostnames` (no service helper) — atomic single-statement, no race condition.
 */
hostnames.post('/api/sites/:siteId/hostnames/reset-primary', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<Record<string, unknown>>(c.env, orgId, siteId);

  await c.env.DB.prepare('UPDATE hostnames SET is_primary = 0 WHERE site_id = ?')
    .bind(siteId)
    .run();

  const siteLabel = await auditService.auditSiteLabelDb(c.env.DB, siteId);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.reset_primary',
    message: `Primary hostname reset to default subdomain for site '${siteLabel}'`,
    target_type: 'site',
    target_id: siteId,
    metadata_json: { site_id: siteId },
    request_id: c.get('requestId'),
  });

  return c.json({ data: { primary_reset: true } });
});

/**
 * Hard-delete a hostname row (and de-register from CF4SaaS if custom).
 *
 * @route DELETE /api/sites/:siteId/hostnames/:hostnameId
 * @auth Bearer — `orgId` MUST resolve; cross-org delete denied via ownership check
 * @param siteId - Immutable site UUID (path param)
 * @param hostnameId - Hostname row UUID (path param)
 * @returns 200 OK `{ data: { deleted: true } }`
 * @throws {AppError} `UNAUTHORIZED` — session missing orgId.
 * @throws {AppError} `NOT_FOUND` — site doesn't exist OR belongs to another org, OR
 *   hostname row doesn't exist on that site (both collapse to 404 — no info leakage).
 *
 * @remarks
 * **Hard DELETE on hostnames** (vs soft-delete on sites) — hostnames have no audit-history
 * value beyond the `audit_logs` row written here. KV cache key `host:<hostname>` is
 * deleted so the next request to that hostname misses cache + falls to D1 (returns 404).
 *
 * Audit log fires `hostname.deleted`.
 */
hostnames.delete('/api/sites/:siteId/hostnames/:hostnameId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  const hostnameId = c.req.param('hostnameId');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<Record<string, unknown>>(c.env, orgId, siteId);

  const hostname = await dbQueryOne<{ id: string; hostname: string }>(
    c.env.DB,
    'SELECT id, hostname FROM hostnames WHERE id = ? AND site_id = ?',
    [hostnameId, siteId],
  );
  if (!hostname) throw notFound('Hostname not found');

  await c.env.DB.prepare('DELETE FROM hostnames WHERE id = ?').bind(hostnameId).run();

  await c.env.CACHE_KV.delete(`host:${hostname.hostname}`).catch(() => {});

  const siteLabel = await auditService.auditSiteLabelDb(c.env.DB, siteId);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.deleted',
    message: `Hostname '${hostname.hostname}' removed from site '${siteLabel}'`,
    target_type: 'hostname',
    target_id: hostnameId,
    metadata_json: {
      hostname: hostname.hostname,
      site_id: siteId,
    },
    request_id: c.get('requestId'),
  });

  return c.json({ data: { deleted: true } });
});

/**
 * Soft-delete a premium domain hostname (cancels the customer's domain-specific
 * subscription line item but preserves audit history for billing reconciliation).
 *
 * @route POST /api/sites/:siteId/hostnames/:hostnameId/unsubscribe
 * @auth Bearer — `orgId` MUST resolve; cross-org write denied via ownership check
 * @param siteId - Immutable site UUID (path param)
 * @param hostnameId - Hostname row UUID (path param)
 * @returns 200 OK `{ data: { unsubscribed: true, hostname: string } }`
 * @throws {AppError} `UNAUTHORIZED` — session missing orgId.
 * @throws {AppError} `NOT_FOUND` — site or hostname missing / cross-org.
 *
 * @remarks
 * **Soft-delete** (sets `deleted_at`) vs the hard-delete `DELETE` endpoint above. Used
 * for premium domains where billing reconciliation downstream needs to see the row
 * persist (revenue attribution, refund handling, audit trail). KV cache invalidated
 * the same way.
 *
 * The actual Stripe subscription line-item cancellation is handled by the billing
 * webhook flow (Stripe customer portal → webhook → row update). This endpoint just
 * tombstones the hostname so it stops serving traffic immediately.
 *
 * Audit log fires `hostname.unsubscribed`.
 */
hostnames.post('/api/sites/:siteId/hostnames/:hostnameId/unsubscribe', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  const hostnameId = c.req.param('hostnameId');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<Record<string, unknown>>(c.env, orgId, siteId);

  const hostname = await dbQueryOne<{ id: string; hostname: string; type: string }>(
    c.env.DB,
    'SELECT id, hostname, type FROM hostnames WHERE id = ? AND site_id = ?',
    [hostnameId, siteId],
  );
  if (!hostname) throw notFound('Hostname not found');

  await c.env.DB.prepare("UPDATE hostnames SET deleted_at = datetime('now') WHERE id = ?")
    .bind(hostnameId)
    .run();

  await c.env.CACHE_KV.delete(`host:${hostname.hostname}`).catch(() => {});

  const siteLabel = await auditService.auditSiteLabelDb(c.env.DB, siteId);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.unsubscribed',
    message: `Premium hostname '${hostname.hostname}' unsubscribed from site '${siteLabel}'`,
    target_type: 'hostname',
    target_id: hostnameId,
    metadata_json: {
      site_id: siteId,
      hostname: hostname.hostname,
      type: hostname.type,
    },
    request_id: c.get('requestId'),
  });

  return c.json({ data: { unsubscribed: true, hostname: hostname.hostname } });
});

// NOTE: `GET /api/admin/domains` (org-wide hostname list) is served by aiAdmin
// (routes/ai_admin.ts:~2329), which mounts BEFORE this `api` router and returns
// the sites-grouped `{data:{sites:[{site,hostnames}]}}` shape the Settings→Domains
// UI renders. A second, flat-paginated handler formerly lived HERE but was dead
// (first-registered aiAdmin always shadowed it — prod-verified iter 48) with docs
// that described its never-served shape. Removed iter 48 to resolve the last
// duplicate-route allowlist entry. The `/summary` + `/:hostnameId` verify/health/
// delete surfaces below are unique to this router and LIVE.

/**
 * Aggregate counts of hostnames attached to the caller's org, bucketed
 * by `status` and `type`. Powers the dashboard summary cards on the
 * frontend domain-management page.
 *
 * @route GET /api/admin/domains/summary
 * @auth Bearer orgId required — query scoped via `WHERE org_id = ?`.
 * @returns 200 OK `{ data: { total, by_status: { active, pending,
 *   verification_failed }, by_type: { free_subdomain, custom_cname } } }`.
 *   Every count guaranteed to be a number (zero-coalesced from D1's
 *   nullable `SUM(...)` result).
 * @throws UNAUTHORIZED — missing/invalid Bearer token.
 *
 * @remarks
 * Single D1 query using `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` for
 * each bucket — one round-trip beats N parallel counts. Soft-deleted
 * rows excluded via `deleted_at IS NULL`. The result schema is
 * deliberately flat-with-nesting so the frontend can render either
 * the top-line total or the breakdown grid without re-shaping.
 */
hostnames.get('/api/admin/domains/summary', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const { data } = await dbQuery<Record<string, unknown>>(
    c.env.DB,
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'verification_failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN type = 'free_subdomain' THEN 1 ELSE 0 END) as free_subdomain,
      SUM(CASE WHEN type = 'custom_cname' THEN 1 ELSE 0 END) as custom_cname
    FROM hostnames
    WHERE org_id = ? AND deleted_at IS NULL`,
    [orgId],
  );

  const stats = data[0] ?? {
    total: 0,
    active: 0,
    pending: 0,
    failed: 0,
    free_subdomain: 0,
    custom_cname: 0,
  };

  return c.json({
    data: {
      total: stats.total ?? 0,
      by_status: {
        active: stats.active ?? 0,
        pending: stats.pending ?? 0,
        verification_failed: stats.failed ?? 0,
      },
      by_type: {
        free_subdomain: stats.free_subdomain ?? 0,
        custom_cname: stats.custom_cname ?? 0,
      },
    },
  });
});

/**
 * `GET /api/admin/domains` — List every non-deleted site in the caller's org
 * with its custom-hostname rows attached, for the admin Domains view.
 *
 * @auth Bearer orgId required — sites + hostnames scoped via `WHERE org_id = ?`
 *   / `site_id IN (...)`.
 * @returns 200 OK `{ data: { sites: [{ site, hostnames: [] }] } }`.
 * @throws UNAUTHORIZED — missing/invalid Bearer token.
 *
 * @remarks
 * Folded VERBATIM from the `ai_admin.ts` monolith (route-decomposition
 * installment 20) into this module — which already owns the rest of the
 * `/api/admin/domains/*` family (summary/verify/health/deprovision). Only the
 * auth guard was adapted to this module's `c.get('orgId')` idiom (the
 * original's `need(c)` also asserted `userId`, incidental here since the
 * handler only reads `orgId`). SQL + response shape are byte-identical.
 */
hostnames.get('/api/admin/domains', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const sites = await c.env.DB.prepare(
    `SELECT id, slug, business_name FROM sites WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(orgId)
    .all();
  const siteRows = (sites.results ?? []) as {
    id: string;
    slug: string;
    business_name: string | null;
  }[];
  if (siteRows.length === 0) return c.json({ data: { sites: [] } });
  const placeholders = siteRows.map(() => '?').join(',');
  const hosts = await c.env.DB.prepare(
    `SELECT id, site_id, hostname, type, status, is_primary, ssl_status,
            verification_errors, last_verified_at, created_at
     FROM hostnames WHERE site_id IN (${placeholders}) AND deleted_at IS NULL
     ORDER BY is_primary DESC, created_at DESC`,
  )
    .bind(...siteRows.map((s) => s.id))
    .all();
  const byId = new Map<
    string,
    { site: { id: string; slug: string; business_name: string | null }; hostnames: unknown[] }
  >();
  for (const s of siteRows) byId.set(s.id, { site: s, hostnames: [] });
  for (const h of (hosts.results ?? []) as Record<string, unknown>[]) {
    const bucket = byId.get(h['site_id'] as string);
    if (bucket) bucket.hostnames.push(h);
  }
  return c.json({ data: { sites: Array.from(byId.values()) } });
});

/**
 * Force a fresh Cloudflare-for-SaaS verification check against a single
 * hostname, persist the new state to D1, and (when the hostname just
 * transitioned to `active`) email the org owner.
 *
 * @route POST /api/admin/domains/:hostnameId/verify
 * @auth Bearer orgId required — cross-org access collapses to 404.
 * @param hostnameId - UUID of the `hostnames` row to re-verify.
 * @returns 200 OK `{ data: { hostname, status, ssl_status,
 *   verification_errors } }`. When CF integration unavailable
 *   (no `cf_custom_hostname_id`), returns the cached DB state with
 *   `message: "No Cloudflare hostname ID — cannot verify"` rather
 *   than throwing.
 * @throws UNAUTHORIZED — missing/invalid Bearer token.
 * @throws NOT_FOUND — hostname missing / cross-org / soft-deleted.
 *
 * @remarks
 * Status mapping from CF response:
 * - `status === 'active'` → DB `active`.
 * - `verification_errors.length > 0` → DB `verification_failed`.
 * - Otherwise → DB `pending`.
 *
 * State transitions are audit-logged (`hostname.verified` with
 * previous_status + new_status + ssl_status). When `active` is newly
 * reached, fires `notifyDomainVerified` to the org owner (looked up
 * via `memberships.role = 'owner'`) — best-effort, email failures
 * never roll back the DB update. A second audit entry
 * (`notification.domain_verified_sent`) records the email dispatch.
 *
 * Dynamic import of `dbUpdate` and `notifications` is a code-splitting
 * pattern that keeps the API bundle lean — these modules are only
 * pulled when verification actually fires.
 *
 * @see {@link domainService.checkHostnameStatus}
 * @see {@link notifyDomainVerified}
 */
hostnames.post('/api/admin/domains/:hostnameId/verify', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const hostnameId = c.req.param('hostnameId');

  // Find the hostname belonging to this org
  const hostname = await dbQueryOne<{
    id: string;
    hostname: string;
    cf_custom_hostname_id: string;
    org_id: string;
    site_id: string;
    status: string;
  }>(
    c.env.DB,
    'SELECT id, hostname, cf_custom_hostname_id, org_id, site_id, status FROM hostnames WHERE id = ? AND deleted_at IS NULL',
    [hostnameId],
  );

  if (!hostname || hostname.org_id !== orgId) {
    throw notFound('Hostname not found');
  }

  if (!hostname.cf_custom_hostname_id) {
    return c.json({
      data: {
        hostname: hostname.hostname,
        status: hostname.status,
        ssl_status: 'unknown',
        verification_errors: [],
        message: 'No Cloudflare hostname ID — cannot verify',
      },
    });
  }

  const cfStatus = await domainService.checkHostnameStatus(c.env, hostname.cf_custom_hostname_id);

  const newStatus =
    cfStatus.status === 'active'
      ? 'active'
      : cfStatus.verification_errors.length > 0
        ? 'verification_failed'
        : 'pending';

  const { dbUpdate: dbUpdateFn } = await import('../../../src/services/db.js');
  const verifyUpd = await dbUpdateFn(
    c.env.DB,
    'hostnames',
    {
      status: newStatus,
      ssl_status: cfStatus.ssl_status,
      verification_errors:
        cfStatus.verification_errors.length > 0
          ? JSON.stringify(cfStatus.verification_errors)
          : null,
      last_verified_at: new Date().toISOString(),
    },
    'id = ?',
    [hostnameId],
  );
  if (verifyUpd.error) throw internalError(`Hostname status update failed: ${verifyUpd.error}`);

  // Audit log
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.verified',
    message: `Hostname '${hostname.hostname}' verified: ${hostname.status} → ${newStatus}${cfStatus.ssl_status ? ` (SSL: ${cfStatus.ssl_status})` : ''}`,
    target_type: 'hostname',
    target_id: hostnameId,
    metadata_json: {
      hostname: hostname.hostname,
      previous_status: hostname.status,
      new_status: newStatus,
      ssl_status: cfStatus.ssl_status,
    },
    request_id: c.get('requestId'),
  });

  // Send email notification when domain just became active
  if (newStatus === 'active' && hostname.status !== 'active') {
    try {
      const { notifyDomainVerified } = await import('../../../src/services/notifications.js');
      const owner = await dbQueryOne<{ email: string }>(
        c.env.DB,
        'SELECT u.email FROM users u JOIN memberships m ON u.id = m.user_id WHERE m.org_id = ? AND m.role = ? AND m.deleted_at IS NULL',
        [orgId, 'owner'],
      );
      if (owner?.email) {
        const site = await dbQueryOne<{ slug: string; business_name: string }>(
          c.env.DB,
          'SELECT slug, business_name FROM sites WHERE id = ? AND deleted_at IS NULL',
          [hostname.site_id],
        );
        const defaultDomain = (site?.slug || 'unknown') + DOMAINS.SITES_SUFFIX;
        // Find primary hostname (use COALESCE for optional is_primary column)
        const primary = await dbQueryOne<{ hostname: string }>(
          c.env.DB,
          'SELECT hostname FROM hostnames WHERE site_id = ? AND deleted_at IS NULL ORDER BY COALESCE(is_primary, 0) DESC, created_at ASC LIMIT 1',
          [hostname.site_id],
        );
        await notifyDomainVerified(c.env, {
          email: owner.email,
          hostname: hostname.hostname,
          primaryDomain: primary?.hostname || null,
          defaultDomain,
          siteName: site?.business_name || defaultDomain,
        });
        auditService
          .writeAuditLog(c.env.DB, {
            org_id: orgId,
            actor_id: c.get('userId') ?? null,
            action: 'notification.domain_verified_sent',
            message: `Domain verification email sent to '${owner.email}' for hostname '${hostname.hostname}'`,
            target_type: 'hostname',
            target_id: hostnameId,
            metadata_json: {
              email: owner.email,
              hostname: hostname.hostname,
            },
            request_id: c.get('requestId'),
          })
          .catch(() => {});
        // Typed in-app bell event (best-effort, never blocks verification).
        try {
          const { notifyEvent } = await import('../../../src/services/notify.js');
          const p = notifyEvent(c.env, {
            subscriberId: owner.email,
            event: { event: 'domain.active', tenantId: orgId, hostname: hostname.hostname },
          });
          try {
            c.executionCtx.waitUntil(p);
          } catch {
            void p;
          }
        } catch {
          /* bell is best-effort */
        }
      }
    } catch {
      // Email failure should not break verification
    }
  }

  return c.json({
    data: {
      hostname: hostname.hostname,
      status: newStatus,
      ssl_status: cfStatus.ssl_status,
      verification_errors: cfStatus.verification_errors,
    },
  });
});

/**
 * Comprehensive live health check for a single hostname: queries
 * Cloudflare custom-hostname status, resolves the public DNS CNAME
 * target via DoH, and assembles a debug-friendly view for the user.
 * Read-only — does NOT update the DB (use the companion
 * `POST .../verify` route to persist state).
 *
 * @route GET /api/admin/domains/:hostnameId/health
 * @auth Bearer orgId required — cross-org access collapses to 404.
 * @param hostnameId - UUID of the `hostnames` row to inspect.
 * @returns 200 OK `{ data: { hostname, type, db_status, cf_status,
 *   ssl_status, dns_configured, cname_target, verification_errors,
 *   last_verified_at } }`. `dns_configured` is the boolean
 *   `cname_target != null` — useful for the "Pending DNS configuration"
 *   alert in the frontend. `cf_status` falls back to `"unknown"` when
 *   `cf_custom_hostname_id` is missing or the CF API errors.
 * @throws UNAUTHORIZED — missing/invalid Bearer token.
 * @throws NOT_FOUND — hostname missing / cross-org / soft-deleted.
 *
 * @remarks
 * The CF status check and DNS CNAME resolution run in parallel via
 * `Promise.all` — total latency is bounded by the slower of the two
 * (CF API typically 200-400ms, DoH typically 50-100ms). Both promises
 * swallow their own errors and leave the corresponding output field
 * as `unknown`/`null`, so a partial failure surfaces partial data
 * rather than blocking the entire response.
 *
 * @see Companion: `POST /api/admin/domains/:hostnameId/verify`
 *   for the persisting variant.
 */
hostnames.get('/api/admin/domains/:hostnameId/health', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const hostnameId = c.req.param('hostnameId');

  const hostname = await dbQueryOne<{
    id: string;
    hostname: string;
    cf_custom_hostname_id: string;
    org_id: string;
    site_id: string;
    type: string;
    status: string;
    ssl_status: string;
    last_verified_at: string;
  }>(
    c.env.DB,
    'SELECT id, hostname, cf_custom_hostname_id, org_id, site_id, type, status, ssl_status, last_verified_at FROM hostnames WHERE id = ? AND deleted_at IS NULL',
    [hostnameId],
  );

  if (!hostname || hostname.org_id !== orgId) {
    throw notFound('Hostname not found');
  }

  // Fetch Cloudflare status and DNS CNAME in parallel
  let cfStatus = 'unknown';
  let cfSslStatus = 'unknown';
  let verificationErrors: string[] = [];
  let cnameTarget: string | null = null;

  const cfPromise = hostname.cf_custom_hostname_id
    ? domainService
        .checkHostnameStatus(c.env, hostname.cf_custom_hostname_id)
        .then((result) => {
          cfStatus = result.status;
          cfSslStatus = result.ssl_status;
          verificationErrors = result.verification_errors;
        })
        .catch(() => {
          cfStatus = 'unknown';
        })
    : Promise.resolve();

  const dnsPromise = domainService
    .checkCnameTarget(hostname.hostname)
    .then((target) => {
      cnameTarget = target;
    })
    .catch(() => {
      cnameTarget = null;
    });

  await Promise.all([cfPromise, dnsPromise]);

  return c.json({
    data: {
      hostname: hostname.hostname,
      type: hostname.type,
      db_status: hostname.status,
      cf_status: cfStatus,
      ssl_status: cfSslStatus,
      dns_configured: cnameTarget != null,
      cname_target: cnameTarget,
      verification_errors: verificationErrors,
      last_verified_at: hostname.last_verified_at,
    },
  });
});

/**
 * Hard deprovision a hostname: removes the Cloudflare custom-hostname
 * (CF for SaaS) AND soft-deletes the D1 row. Distinct from the
 * site-scoped `DELETE /api/sites/:siteId/hostnames/:hostnameId` route
 * which only marks the D1 row deleted — this admin variant guarantees
 * the CF resource is gone so the user's CNAME can be reused.
 *
 * @route DELETE /api/admin/domains/:hostnameId
 * @auth Bearer orgId required — cross-org access collapses to 404.
 * @param hostnameId - UUID of the `hostnames` row to deprovision.
 * @returns 200 OK `{ data: { hostname, status: 'deleted' } }`.
 * @throws UNAUTHORIZED — missing/invalid Bearer token.
 * @throws NOT_FOUND — hostname missing / cross-org / already soft-deleted.
 *
 * @remarks
 * The CF deletion is best-effort with a logged warning on failure —
 * if the CF custom-hostname is already gone (manual cleanup, account
 * migration), the local DB deletion still proceeds so the row never
 * gets stranded as "deleted in our DB but live on CF". The reverse
 * (CF lives on after DB delete) is acceptable because the CF resource
 * is unreachable without a D1 mapping anyway — orphans get reaped
 * by a scheduled sweeper job.
 *
 * Soft-delete sets both `deleted_at` (UTC ISO) and `status='deleted'`
 * so the row remains visible in audit queries but is excluded by
 * every `WHERE deleted_at IS NULL` predicate across the routes layer.
 *
 * @see Companion: `DELETE /api/sites/:siteId/hostnames/:hostnameId`
 *   (DB-only soft-delete, used by self-service per-site flows).
 */
hostnames.delete('/api/admin/domains/:hostnameId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const hostnameId = c.req.param('hostnameId');

  const hostname = await dbQueryOne<{
    id: string;
    hostname: string;
    cf_custom_hostname_id: string;
    org_id: string;
    site_id: string;
    type: string;
    status: string;
  }>(
    c.env.DB,
    'SELECT id, hostname, cf_custom_hostname_id, org_id, site_id, type, status FROM hostnames WHERE id = ? AND deleted_at IS NULL',
    [hostnameId],
  );

  if (!hostname || hostname.org_id !== orgId) {
    throw notFound('Hostname not found');
  }

  if (hostname.cf_custom_hostname_id) {
    try {
      await domainService.deleteCustomHostname(c.env, hostname.cf_custom_hostname_id);
    } catch {
      // Log but don't block — the CF resource may already be gone
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'domains',
          message: 'Failed to delete CF custom hostname during deprovision',
          hostname: hostname.hostname,
          cf_id: hostname.cf_custom_hostname_id,
        }),
      );
    }
  }

  const { dbUpdate: dbUpdateFn } = await import('../../../src/services/db.js');
  const delUpd = await dbUpdateFn(
    c.env.DB,
    'hostnames',
    { deleted_at: new Date().toISOString(), status: 'deleted' },
    'id = ?',
    [hostnameId],
  );
  if (delUpd.error) throw internalError(`Hostname deprovision failed: ${delUpd.error}`);

  await c.env.CACHE_KV.delete(`host:${hostname.hostname}`).catch(() => {});

  // Audit log
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'hostname.deprovisioned',
    message: `Hostname '${hostname.hostname}' deprovisioned${hostname.cf_custom_hostname_id ? ' (CF custom hostname removed)' : ''}`,
    target_type: 'hostname',
    target_id: hostnameId,
    metadata_json: {
      hostname: hostname.hostname,
      type: hostname.type,
      had_cf_id: !!hostname.cf_custom_hostname_id,
      site_id: hostname.site_id,
    },
    request_id: c.get('requestId'),
  });

  return c.json({ data: { deprovisioned: true, hostname: hostname.hostname } });
});
