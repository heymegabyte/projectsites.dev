/**
 * @module routes/site_cost
 * @description Read-only cost-metering endpoints (Pricing Model Wave 1).
 *
 * Two owner-scoped GET endpoints that return the itemized monthly cost breakdown for a site or an
 * installed-app instance (see `services/site_cost.ts` + `docs/PRICING-MODEL.md`):
 *
 *   GET /api/sites/:id/cost            → SiteCostBreakdown for the site's namespaced resources + $50 fee
 *   GET /api/apps/instances/:id/cost   → SiteCostBreakdown for one installed-app instance (no fee)
 *
 * Every handler: auth + `isFlagOn('pricing_engine')` (404 when off, never 403 — don't leak feature
 * existence) + ownership check (`assertSiteOwned` for the site; org-match on the `app_instances` row
 * for the instance). Mounted at `/` BEFORE the `api` catch-all so the `:id/cost` paths resolve here.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';

import type { Env, Variables } from '../types/env.js';

import { requireOrgFlag } from '../lib/feature_guard.js';
import { dbQueryOne } from '../services/db.js';
import { assertSiteOwned } from '../services/site_ownership.js';
import { computeInstanceCost, computeSiteCost } from '../services/site_cost.js';

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found' } } as const;

/** The pricing-engine feature flag gating both cost endpoints (dark by default). */
const PRICING_FLAG = 'pricing_engine';

const siteCost = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * `GET /api/sites/:id/cost` — itemized monthly cost breakdown for one OWNED site.
 * Auth + `pricing_engine` flag + `assertSiteOwned` (all 404 on failure, never 403).
 */
siteCost.get('/api/sites/:id/cost', async (c) => {
  const g = await requireOrgFlag(c, PRICING_FLAG);
  if (g instanceof Response) return g;
  const siteId = c.req.param('id');
  if (!(await assertSiteOwned(c.env, g.orgId, siteId))) return c.json(NOT_FOUND, 404);
  return c.json(await computeSiteCost(c.env, siteId));
});

/**
 * `GET /api/apps/instances/:id/cost` — itemized monthly cost breakdown for one OWNED app instance.
 * Auth + `pricing_engine` flag + org-match on the `app_instances` row (404 on foreign/missing).
 */
siteCost.get('/api/apps/instances/:id/cost', async (c) => {
  const g = await requireOrgFlag(c, PRICING_FLAG);
  if (g instanceof Response) return g;
  const instanceId = c.req.param('id');
  // Ownership: the instance must exist (not soft-deleted) AND belong to the caller's org. 404 otherwise
  // (never leak existence). Mirrors assertSiteOwned's shape for app_instances (no siteId there).
  const row = await dbQueryOne<{ org_id: string }>(
    c.env.DB,
    'SELECT org_id FROM app_instances WHERE id = ? AND deleted_at IS NULL',
    [instanceId],
  );
  if (!row || row.org_id !== g.orgId) return c.json(NOT_FOUND, 404);
  return c.json(await computeInstanceCost(c.env, instanceId));
});

export { siteCost };
