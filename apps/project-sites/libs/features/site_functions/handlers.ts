/**
 * @module libs/features/site_functions/handlers
 * @description Hono sub-application for the Functions panel (the FIFTH Resources
 * sub-tab, beside Media / Files / Buckets / Automations).
 *
 * @remarks Mount in src/index.ts as:
 *   ```ts
 *   import { siteFunctions } from '../libs/features/site_functions/handlers.js';
 *   app.route('/', siteFunctions);
 *   ```
 *
 * Route exposed:
 *   GET /api/sites/:siteId/functions
 *     Flag: site_functions — 404 if off (never 403 — existence never leaked)
 *     Auth: orgId from c.get('orgId') — 401 if missing
 *     Owner: assertSiteOwned — 404 if cross-org / missing (IDOR guard)
 *     Returns: { data: SiteFunction[], functionsDeployed, wfpConfigured } — the
 *       site's code-defined Functions (its deployed WfP `functions/` worker + its
 *       declared cron schedules), sourced from authoritative persisted signals.
 *
 * DOCTRINE (ADR-0035): Functions are code-defined (owners author a `functions/`
 * folder in the editor, NOT a dashboard form) — so this is a READ/MANAGE VIEW, not
 * an authoring form. No writes.
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { listSiteFunctions } from './service.js';

const FLAG_KEY = 'site_functions';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteFunctions = new Hono<AppContext>();

/** GET /api/sites/:siteId/functions — list a site's code-defined Functions (read-only). */
siteFunctions.get('/api/sites/:siteId/functions', async (c) => {
  // ── Feature flag gate (first — an off flag is a hard 404, never leaks existence) ──
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
  }

  // ── Ownership check (IDOR guard) ─────────────────────────────────────────
  const { siteId } = c.req.param();
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // ── Read the real signals + respond ──────────────────────────────────────
  const payload = await listSiteFunctions(c.env, siteId);
  return c.json(payload, 200);
});
