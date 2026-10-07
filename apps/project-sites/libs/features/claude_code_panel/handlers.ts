/**
 * @module libs/features/claude_code_panel/handlers
 * @description Hono sub-application for the embedded "Claude Code" editor tab's dark-flag
 * resolution endpoint (WLK-39 §75 flagship, S7-prep).
 *
 * @remarks
 * The bolt.diy editor renders the "Claude Code" top tab ONLY when this flag resolves ON. The
 * embedded editor has no cross-origin session, so it cannot read `isFlagOn` itself — it asks the
 * admin (which holds `selectedSite` + the bearer) to resolve the flag via this endpoint over the
 * `PS_CLAUDE_FLAG_REQUEST` bridge. Unlike the `per_site_data` DATA endpoint
 * (`libs/features/site_data_api/site_db_handlers.ts`), which 404s when dark to hide a whole data
 * surface, this is a RESOLUTION endpoint: for the caller's OWN site it returns `200 { enabled }` with
 * the real boolean (dark → `{ enabled:false }`, promoted → `{ enabled:true }`). The admin reads the
 * boolean and reveals/hides the tab — console-clean, since a dark flag no longer emits a browser 404.
 *
 * Mount in src/index.ts as:
 *   ```ts
 *   import { claudeCodePanel } from '../libs/features/claude_code_panel/handlers.js';
 *   app.route('/', claudeCodePanel);
 *   ```
 *
 * Routes exposed:
 *   GET /api/sites/:siteId/claude-code/status
 *     Auth: orgId from c.get('orgId') — 401 if missing (a per-org flag can't resolve without an org)
 *     Owner: assertSiteOwned FIRST — 404 "Site not found" if cross-org / missing (IDOR guard;
 *            flag-agnostic so flag-off/on is never observable to a non-owner)
 *     Flag: claude_code_panel — owned site → 200 { data: { enabled } } (the real boolean, true OR false)
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
 * site. This is a RESOLUTION endpoint (it reports a single boolean for the caller's OWN site), NOT a
 * data endpoint — so the honest, console-clean answer for an owned site is `200 { data: { enabled } }`
 * with the real value (true OR false), never a 404 for the off case. (Contrast the `per_site_data`
 * DATA endpoint, which correctly 404s when dark to hide the whole data surface.)
 *
 * Gate order: auth-401 → ownership-404 → flag-resolve-200. Ownership MUST precede the flag so the
 * off/on distinction is NEVER observable to a non-owner: a cross-org / missing site always gets the
 * same `404 "Site not found"` regardless of flag state (closes a latent site-scoped-flag info leak —
 * the prior flag-before-ownership order let an authed non-owner tell flag-off `404 "not enabled"`
 * apart from flag-on `404 "Site not found"` on a victim site). The legitimate OWNER — the only caller
 * the editor bridge ever probes with — gets `{ enabled:false }` when dark (no browser console 404)
 * and `{ enabled:true }` when promoted. Unauth → 401 (a per-org flag can't resolve without an org).
 */
claudeCodePanel.get('/api/sites/:siteId/claude-code/status', async (c) => {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  }

  const { siteId } = c.req.param();

  // ── Ownership check FIRST (IDOR guard — 404 on a cross-org / missing site, flag-agnostic) ──
  // Running this before the flag resolve means a non-owner can never distinguish flag-off from
  // flag-on (both → the same 404), so returning the honest boolean below leaks nothing.
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  }

  // ── Flag resolve (owned site) → 200 with the real boolean (dark → { enabled:false }, no 404) ──
  // siteId is passed so an org/tenant/site-scoped override can promote it per-tenant. The embedded
  // editor reveals the Claude Code tab only when this resolves true; false keeps it hidden — the
  // same fail-safe as before, but console-clean (a dark flag no longer emits a browser 404).
  const enabled = await isFlagOn(c.env, FLAG_KEY, { orgId, siteId });
  return c.json({ data: { enabled } }, 200);
});
