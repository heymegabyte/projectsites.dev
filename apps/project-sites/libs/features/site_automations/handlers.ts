/**
 * @module libs/features/site_automations/handlers
 * @description Hono sub-application for the Automations panel (RES-AUTO slice 1).
 *
 * @remarks Mount in src/index.ts as:
 *   ```ts
 *   import { siteAutomations } from '../libs/features/site_automations/handlers.js';
 *   app.route('/', siteAutomations);
 *   ```
 *
 * Routes exposed:
 *   GET /api/sites/:siteId/automations
 *     Flag: site_automations — 404 if off (never 403 — existence never leaked)
 *     Auth: orgId from c.get('orgId') — 401 if missing
 *     Owner: assertSiteOwned — 404 if cross-org / missing (IDOR guard)
 *     Returns: { data: Automation[] } — the site's workflow_jobs rows, UI-shaped
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { listSiteAutomations } from './service.js';

const FLAG_KEY = 'site_automations';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteAutomations = new Hono<AppContext>();

/** GET /api/sites/:siteId/automations — list a site's automation/workflow instances. */
siteAutomations.get('/api/sites/:siteId/automations', async (c) => {
  // ── Feature flag gate ────────────────────────────────────────────────────
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

  // ── Read the store + respond ─────────────────────────────────────────────
  const data = await listSiteAutomations(c.env, siteId);
  return c.json({ data }, 200);
});
