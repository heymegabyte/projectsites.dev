/**
 * @file `GET /api/sites/:siteId/cloudflare-rum` — Cloudflare Web Analytics RUM for a site's OWNED
 * host: CF-measured Core Web Vitals + Navigation Timing (incl. TTFB), an independent second source
 * to the first-party `app.js` beacon. RUM is the ONE CF dataset that attributes per
 * `*.projectsites.dev` subdomain (the `httpRequestsAdaptiveGroups` path is empty for them).
 *
 * Tenant safety: the site is resolved by id-or-slug AND `org_id = caller` (a non-owned site 404s,
 * never leaks), then its host is resolved SERVER-SIDE from ownership records (`hostnames` primary,
 * else `{slug}.projectsites.dev`) — a client-supplied host is NEVER trusted for the CF query.
 * Fails SOFT: CF error / missing creds → `{ available: false }` (200), never a 500 or a fake 0.
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { dbQueryOne } from '../services/db.js';
import { getCloudflareRumSummary } from '../services/cloudflare_rum.js';

const cloudflareRum = new Hono<{ Bindings: Env; Variables: Variables }>();

/** RUM retention is ~30d; bound the window to keep query cost + honesty in check. */
function clampDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return 7;
  }
  return Math.min(30, Math.max(1, Math.floor(n)));
}

cloudflareRum.get('/api/sites/:siteId/cloudflare-rum', async (c) => {
  const siteRef = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  // Owner-scoped resolution: id-or-slug AND the caller's org — a non-owned site 404s (non-leak).
  const site = await dbQueryOne<{ id: string; slug: string }>(
    c.env.DB,
    'SELECT id, slug FROM sites WHERE (id = ?1 OR slug = ?1) AND org_id = ?2 AND deleted_at IS NULL LIMIT 1',
    [siteRef, orgId],
  );
  if (!site) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  }

  // Resolve the OWNED host server-side: a verified primary custom hostname if present, else the
  // canonical slug subdomain. The client never chooses which host's RUM is read.
  const primary = await dbQueryOne<{ hostname: string }>(
    c.env.DB,
    `SELECT hostname FROM hostnames
      WHERE site_id = ?1 AND deleted_at IS NULL
      ORDER BY COALESCE(is_primary, 0) DESC, created_at ASC
      LIMIT 1`,
    [site.id],
  );
  const host = (primary?.hostname || `${site.slug}.projectsites.dev`).toLowerCase();

  const days = clampDays(c.req.query('days'));
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceISO = since.toISOString();
  const untilISO = until.toISOString();

  const summary = await getCloudflareRumSummary(c.env, host, sinceISO, untilISO);

  // Fail soft + honest: no data / no creds → available:false (never a 500, never a fabricated 0).
  if (!summary) {
    return c.json({
      available: false,
      host,
      window: { since: sinceISO, until: untilISO },
      reason: 'Cloudflare RUM returned no data for this host, or analytics credentials are unavailable.',
    });
  }

  return c.json({ available: true, days, ...summary });
});

export { cloudflareRum };
