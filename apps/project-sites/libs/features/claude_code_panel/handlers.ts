/**
 * @module libs/features/claude_code_panel/handlers
 * @description Hono sub-application for the embedded "Claude Code" editor tab's dark-flag
 * resolution endpoint (WLK-39 §75 flagship, S7-prep).
 *
 * @remarks
 * The bolt.diy editor renders the "Claude Code" top tab ONLY when this flag resolves ON. The
 * embedded editor has no cross-origin session, so it cannot read `isFlagOn` itself — it asks the
 * admin (which holds `selectedSite` + the bearer) to resolve the flag via this endpoint over the
 * `PS_CLAUDE_FLAG_REQUEST` bridge. This mirrors the `per_site_data` dark-flag path EXACTLY
 * (`libs/features/site_data_api/site_db_handlers.ts`): a DARK flag returns a 404 whose body message
 * says the feature is "not enabled", which the admin translates to `{ enabled:false }` so the tab
 * stays hidden — never a 403, never a leaked existence.
 *
 * Mount in src/index.ts as:
 *   ```ts
 *   import { claudeCodePanel } from '../libs/features/claude_code_panel/handlers.js';
 *   app.route('/', claudeCodePanel);
 *   ```
 *
 * Routes exposed:
 *   GET /api/sites/:siteId/claude-code/status
 *     Flag: claude_code_panel — 404 "not enabled" if off (never 403 — existence never leaked)
 *     Auth: orgId from c.get('orgId') — 401 if missing
 *     Owner: assertSiteOwned — 404 if cross-org / missing (IDOR guard)
 *     Returns: { data: { enabled: true } } — the tab may render for this tenant
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';

/** The registry key this feature gates on. Keep DARK (default-off) — promotion is a flag override. */
const FLAG_KEY = 'claude_code_panel';

type AppContext = { Bindings: Env; Variables: Variables };

export const claudeCodePanel = new Hono<AppContext>();

/**
 * GET /api/sites/:siteId/claude-code/status — resolve the `claude_code_panel` flag for the owned
 * site. The editor probes this once on mount: a 200 `{ data: { enabled:true } }` reveals the tab, a
 * 404 "not enabled" (the dark-flag path) keeps it hidden. Gate order mirrors `per_site_data`:
 * flag-dark-404 → auth-401 → ownership-404.
 */
claudeCodePanel.get('/api/sites/:siteId/claude-code/status', async (c) => {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  }

  const { siteId } = c.req.param();

  // ── Feature-flag gate (DARK → 404 "not enabled", never 403 — mirrors per_site_data) ──────
  if (!(await isFlagOn(c.env, FLAG_KEY, { orgId, siteId }))) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Claude Code panel is not enabled' } },
      404,
    );
  }

  // ── Ownership check (IDOR guard — 404 on a cross-org / missing site) ─────────────────────
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  }

  // Flag on + owned → the tab may render for this tenant.
  return c.json({ data: { enabled: true } }, 200);
});
