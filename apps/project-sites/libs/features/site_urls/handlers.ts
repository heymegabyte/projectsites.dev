/**
 * @module libs/features/site_urls/handlers
 *
 * @description
 * Hono routes for a site's **URL management + multi-URL analytics** — the
 * `site_urls` table (primary + alternate hostnames bound to a site) plus the
 * aggregated Cloudflare-analytics rollup across every bound URL. Every route
 * loads the site + verifies org membership through the shared `loadSiteAndAuth`
 * helper (401 when unauthenticated, 404 when the site is missing, 403 when the
 * caller isn't a member of the site's org). URL binding is org-scoped; the
 * multi-URL analytics envelope is cached in KV for 5 minutes.
 *
 * | Method | Path                                    | Auth  | Purpose                                                     |
 * | ------ | --------------------------------------- | ----- | ---------------------------------------------------------- |
 * | GET    | /api/sites/:id/urls                     | membership | List primary + alternate URLs (auto-heals a missing primary) |
 * | POST   | /api/sites/:id/urls                     | membership | Bind an alternate URL (409 on dup hostname)                |
 * | DELETE | /api/sites/:id/urls/:urlId              | membership | Unbind an alternate URL (409 if primary)                   |
 * | GET    | /api/sites/:id/multi-url-analytics      | membership | Aggregated CF analytics across every bound URL             |
 *
 * Extracted VERBATIM from the `api.ts` monolith (route-decomposition installment
 * 10) — only the route-registration receiver changed (`api.` → `siteUrls.`); the
 * handler bodies are byte-for-byte unchanged. The private `loadSiteAndAuth` helper
 * (used only by these four routes) moved alongside them; it returns the site +
 * request-id on success, or an `{ err }` object carrying a pre-written 4xx JSON
 * envelope. The `/multi-url-analytics` path is deliberately NOT `/analytics` — the
 * `site_analytics` SUMMARY handler (mounted first) owns `/api/sites/:siteId/analytics`
 * and would shadow it. Bodies are read via a raw `as {…}` cast rather than a Zod
 * schema at the boundary (with an inline hostname regex), so there is no `schemas.ts`.
 * `ambient` bindings (`c.env.DB` / `c.env.CACHE_KV`) need no import. Known AppError
 * (`internalError`) propagates to the app-level error handler.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { internalError } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { dbExecute, dbInsert, dbQueryOne } from '../../../src/services/db.js';
import * as domainService from '../../../src/services/domains.js';
import {
  clampCustomDays,
  listSiteUrls,
  loadMultiUrlAnalytics,
  parseRange,
  type MultiUrlAnalytics,
} from '../../../src/services/multi_url_analytics.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteUrls = new Hono<AppContext>();

/**
 * Helper — load a site row + verify the caller has membership in its org.
 * Returns the {site, org_id} pair on success, or `null` after writing a 4xx
 * envelope to `c`. Used by the multi-URL analytics + URL CRUD handlers.
 */
async function loadSiteAndAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  siteId: string,
) {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  const userId = c.get('userId');
  if (!userId) {
    return {
      err: c.json(
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            request_id: requestId,
          },
        },
        401,
      ),
    };
  }
  // NOTE: `primary_hostname` is NOT a column on `sites` — it is resolved from the
  // `hostnames` table via domainService.getPrimaryHostname. Selecting it here made
  // the query error `no such column: primary_hostname`, which dbQueryOne swallows
  // to null → loadSiteAndAuth 404'd "Site not found" for EVERY site → every route
  // that uses it (per-site multi-URL analytics, /urls, …) was dark for all users.
  // Select only real columns; resolve the hostname below.
  const site = await dbQueryOne<{
    id: string;
    slug: string;
    org_id: string;
  }>(c.env.DB, 'SELECT id, slug, org_id FROM sites WHERE id = ? AND deleted_at IS NULL', [siteId]);
  if (!site) {
    return {
      err: c.json(
        { error: { code: 'NOT_FOUND', message: 'Site not found', request_id: requestId } },
        404,
      ),
    };
  }
  const membership = await dbQueryOne(
    c.env.DB,
    'SELECT id FROM memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL',
    [site.org_id, userId],
  );
  if (!membership) {
    return {
      err: c.json(
        { error: { code: 'FORBIDDEN', message: 'Access denied', request_id: requestId } },
        403,
      ),
    };
  }
  // Resolve the primary hostname from the `hostnames` table (custom domain when
  // set, else null → callers fall back to `${slug}.projectsites.dev`). Keeps the
  // returned shape `{ id, slug, org_id, primary_hostname }` that callers expect.
  const primary_hostname = await domainService.getPrimaryHostname(c.env.DB, site.id);
  return { site: { ...site, primary_hostname }, requestId };
}

/**
 * GET /api/sites/:id/urls — List every URL bound to a site (primary + alternates).
 *
 * Returns rows from `site_urls` where `site_id = :id` (excludes soft-deleted).
 * Primary URL is first; alternates follow in insertion order.
 *
 * @auth Required — Bearer session token + org membership.
 */
siteUrls.get('/api/sites/:id/urls', async (c) => {
  const siteId = c.req.param('id');
  const ctx = await loadSiteAndAuth(c, siteId);
  if ('err' in ctx) return ctx.err;
  let urls = await listSiteUrls(c.env, siteId);
  // Auto-heal: every site MUST have at least its primary URL row. Older
  // sites created before migration 0027 may be missing one if they were
  // created in a `deleted_at IS NOT NULL` state at backfill time.
  if (urls.length === 0) {
    const hostname = ctx.site.primary_hostname || `${ctx.site.slug}.projectsites.dev`;
    await dbInsert(c.env.DB, 'site_urls', {
      id: crypto.randomUUID(),
      site_id: siteId,
      hostname,
      is_primary: 1,
    });
    urls = await listSiteUrls(c.env, siteId);
  }
  return c.json({ data: urls });
});

/**
 * POST /api/sites/:id/urls — Bind an alternate URL to a site.
 *
 * Body: `{ hostname: string }` — accepts any valid hostname; uniqueness
 * enforced by the `site_urls(hostname)` UNIQUE constraint. Returns 409 on
 * dup. Does NOT auto-provision the Cloudflare custom hostname — call the
 * existing `/api/sites/:siteId/hostnames` endpoint for that.
 *
 * @auth Required.
 */
siteUrls.post('/api/sites/:id/urls', async (c) => {
  const siteId = c.req.param('id');
  const ctx = await loadSiteAndAuth(c, siteId);
  if ('err' in ctx) return ctx.err;
  const body = (await c.req.json().catch(() => ({}))) as { hostname?: unknown };
  const hostname = typeof body.hostname === 'string' ? body.hostname.trim().toLowerCase() : '';
  if (!hostname || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'hostname must be a valid domain',
          request_id: ctx.requestId,
        },
      },
      400,
    );
  }
  const id = crypto.randomUUID();
  const { error } = await dbInsert(c.env.DB, 'site_urls', {
    id,
    site_id: siteId,
    hostname,
    is_primary: 0,
  });
  if (error) {
    // UNIQUE(hostname) collision = 409.
    if (/UNIQUE constraint failed/i.test(error)) {
      return c.json(
        {
          error: {
            code: 'CONFLICT',
            message: 'Hostname already bound to a site',
            request_id: ctx.requestId,
          },
        },
        409,
      );
    }
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: error, request_id: ctx.requestId } },
      500,
    );
  }
  // Invalidate any cached aggregates so the next analytics call sees the new URL.
  try {
    // Best-effort cache nuke; can't enumerate KV by prefix so we let TTL expire.
    await c.env.CACHE_KV.delete(`zone:${hostname}`);
  } catch {
    /* */
  }
  return c.json({ data: { id, hostname, is_primary: 0 } });
});

/**
 * DELETE /api/sites/:id/urls/:urlId — Unbind an alternate URL.
 *
 * Soft-deletes the row (`deleted_at = now`). The primary URL cannot be
 * removed — clients should swap the primary via the existing hostnames
 * endpoint first.
 *
 * @auth Required.
 */
siteUrls.delete('/api/sites/:id/urls/:urlId', async (c) => {
  const siteId = c.req.param('id');
  const urlId = c.req.param('urlId');
  const ctx = await loadSiteAndAuth(c, siteId);
  if ('err' in ctx) return ctx.err;
  const row = await dbQueryOne<{ is_primary: number }>(
    c.env.DB,
    'SELECT is_primary FROM site_urls WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
    [urlId, siteId],
  );
  if (!row) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'URL binding not found', request_id: ctx.requestId } },
      404,
    );
  }
  if (row.is_primary) {
    return c.json(
      {
        error: {
          code: 'CONFLICT',
          message: 'Cannot remove the primary URL — set a different primary first',
          request_id: ctx.requestId,
        },
      },
      409,
    );
  }
  const { error: delUrlErr } = await dbExecute(
    c.env.DB,
    'UPDATE site_urls SET deleted_at = ?, updated_at = ? WHERE id = ?',
    [new Date().toISOString(), new Date().toISOString(), urlId],
  );
  // Pre-guarded (row loaded + primary-checked above) → changes===0 unreachable;
  // surface a genuine DB failure instead of a lying "deleted: true".
  if (delUrlErr) throw internalError(`Failed to remove URL: ${delUrlErr}`);
  return c.json({ data: { id: urlId, deleted: true } });
});

/**
 * GET /api/sites/:id/multi-url-analytics — Aggregated Cloudflare analytics across every URL.
 *
 * Sums page-views, unique visitors, top pages, countries, referrers, and
 * the daily series across every `site_urls` row bound to the site. Caches
 * the result in KV for 5 minutes keyed by `site_id + range + url_set`.
 *
 * @remarks Path is `/multi-url-analytics`, NOT `/analytics` — the `site_analytics`
 *   SUMMARY handler (`libs/features/site_analytics/handlers.ts`, mounted first)
 *   owns `/api/sites/:siteId/analytics` and shadowed this route, so the per-site
 *   panel received the bare summary shape (no `data` key) → every KPI rendered 0
 *   / "No traffic yet". Distinct paths let both features serve their own shape.
 *   (Gated on the loadSiteAndAuth `primary_hostname` fix — before it, this handler
 *   404'd "Site not found" for every site.)
 *
 * @queryParam range - One of `24h | 7d | 30d | 90d`. Defaults to `7d`.
 * @queryParam exclude - Comma-separated hostnames to skip (UI toggle pill).
 *
 * @returns When CF credentials are unavailable: `{ data: { ... ,
 *   any_real_data: false } }` so the frontend can show a "Connect
 *   Cloudflare" CTA. Otherwise: the aggregated envelope.
 *
 * @auth Required.
 */
siteUrls.get('/api/sites/:id/multi-url-analytics', async (c) => {
  const siteId = c.req.param('id');
  const ctx = await loadSiteAndAuth(c, siteId);
  if ('err' in ctx) return ctx.err;
  const range = parseRange(c.req.query('range'));
  const daysOverride = clampCustomDays(c.req.query('days')); // custom lookback (1–90) overrides the enum
  const excludeRaw = c.req.query('exclude') ?? '';
  const exclude = new Set(
    excludeRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );

  // Ensure at least the primary URL row exists before aggregating.
  const urls = await listSiteUrls(c.env, siteId);
  if (urls.length === 0) {
    const hostname = ctx.site.primary_hostname || `${ctx.site.slug}.projectsites.dev`;
    await dbInsert(c.env.DB, 'site_urls', {
      id: crypto.randomUUID(),
      site_id: siteId,
      hostname,
      is_primary: 1,
    });
  }

  let envelope: MultiUrlAnalytics;
  try {
    envelope = await loadMultiUrlAnalytics(c.env, siteId, ctx.site.org_id, range, exclude, daysOverride);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'api',
        route: 'GET /api/sites/:id/multi-url-analytics',
        site_id: siteId,
        error: err instanceof Error ? err.message : String(err),
        request_id: ctx.requestId,
      }),
    );
    return c.json(
      {
        error: {
          code: 'AI_GENERATION_ERROR',
          message: 'Failed to aggregate Cloudflare analytics',
          request_id: ctx.requestId,
        },
      },
      502,
    );
  }
  return c.json({ data: envelope });
});
