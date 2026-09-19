/**
 * @module routes/search
 * @description Public search and site-creation routes for the homepage SPA.
 *
 * Screen 1 (Search)   → GET  /api/search/businesses      → Google Places proxy
 * Screen 1 (Lookup)   → GET  /api/sites/lookup            → check existing site by place_id/slug
 * Screen 3 (Create)   → POST /api/sites/create-from-search → create site + enqueue AI workflow
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { badRequest } from '@project-sites/shared';

import { dbQuery, dbQueryOne } from '../services/db.js';
import { sanitizeLikeTerm } from '../services/like_pattern.js';

const search = new Hono<{ Bindings: Env; Variables: Variables }>();

// Google Places search (GET /api/search/businesses + GET /api/search/address —
// business text-search + address autocomplete, KV-cached, honest-empty degradation)
// moved to `libs/features/places_search/handlers.ts` (route-decomposition installment
// 25). The GooglePlace/GooglePlacesResponse + Autocomplete* interfaces moved with them;
// `badRequest` stays (still used by lookup/create-from-search/prompt routes here).

// ─── Site Search (pre-built) ─────────────────────────────────

interface SiteSearchRow {
  id: string;
  slug: string;
  business_name: string;
  business_address: string | null;
  google_place_id: string | null;
  status: string;
  current_build_version: string | null;
}

search.get('/api/sites/search', async (c) => {
  const q = c.req.query('q');

  if (!q || q.trim().length < 2) {
    return c.json({ data: [] });
  }

  // Bound query length, and strip the user's own %/_ wildcards so they match
  // literally — otherwise a wildcard-heavy term crashes the query (`LIKE pattern
  // too complex`, swallowed → lying-empty) and matches wrong rows.
  const bounded = q.trim().slice(0, 100);
  const searchTerm = `%${sanitizeLikeTerm(bounded)}%`;
  // Exclude LYING-PUBLISHED rows: a `status='published'` site with a NULL
  // `current_build_version` is not a real, viewable site — its subdomain serves
  // the branded 503 ("the last build didn't finish"). Such rows (e.g. e2e/mock
  // seed stubs) otherwise leak into this PUBLIC "pre-built sites" discovery search
  // and present a fake/dead business as an existing site. Non-published rows
  // (building/draft/error — also null-build) still surface (a build-in-progress is
  // legitimately discoverable); real published sites (with a build) still surface.
  const { data } = await dbQuery<SiteSearchRow>(
    c.env.DB,
    "SELECT id, slug, business_name, business_address, google_place_id, status, current_build_version FROM sites WHERE business_name LIKE ? AND deleted_at IS NULL AND (status != 'published' OR current_build_version IS NOT NULL) ORDER BY CASE WHEN status = 'published' THEN 0 WHEN status = 'building' THEN 1 ELSE 2 END, created_at DESC LIMIT 5",
    [searchTerm],
  );

  return c.json({
    data: data.map((site) => ({
      site_id: site.id,
      slug: site.slug,
      business_name: site.business_name,
      business_address: site.business_address,
      google_place_id: site.google_place_id,
      status: site.status,
      has_build: site.current_build_version !== null,
    })),
  });
});

// ─── Command-palette search (⌘K smart results) ──────────────
// Powers the full-screen ⌘K "Smart results" group: static admin-route catalog +
// the caller's own sites (by name) + best-effort AutoRAG enrichment over indexed
// content. AutoRAG is optional — when the instance isn't configured the handler
// still returns catalog + site matches.

interface CommandResult {
  id: string;
  label: string;
  icon: string;
  route?: string;
  url?: string;
  detail?: string;
}

const ADMIN_COMMAND_CATALOG: ReadonlyArray<CommandResult> = [
  { id: 'cs-dashboard', label: 'Dashboard', icon: 'dashboard', route: '/admin', detail: 'Admin' },
  // 'Sites' → the dashboard IS the sites hub. This is a SINGLE-SITE admin: there
  // is deliberately NO bare `/admin/sites` list route (only `/admin/sites/:id`),
  // so `/admin/sites` resolves to the admin 404. Point at `/admin` instead.
  { id: 'cs-sites', label: 'Sites', icon: 'dashboard', route: '/admin', detail: 'Admin' },
  { id: 'cs-editor', label: 'Editor', icon: 'edit', route: '/admin/editor', detail: 'Admin' },
  // No 'Media library' command — there is no `/admin/media` route or media library
  // UI in this SPA (the `/api/media/*` worker surface has no admin page), so
  // advertising it dead-ended ⌘K users on the admin 404. Restore only when a real
  // `/admin/media` route ships.
  {
    id: 'cs-analytics',
    label: 'Analytics',
    icon: 'status',
    route: '/admin/analytics',
    detail: 'Admin',
  },
  { id: 'cs-forms', label: 'Forms', icon: 'document', route: '/admin/forms', detail: 'Admin' },
  { id: 'cs-seo', label: 'SEO', icon: 'search', route: '/admin/seo', detail: 'Admin' },
  { id: 'cs-social', label: 'Social', icon: 'changelog', route: '/admin/social', detail: 'Admin' },
  { id: 'cs-apps', label: 'Apps', icon: 'plus', route: '/admin/apps', detail: 'Admin' },
  { id: 'cs-domains', label: 'Domains', icon: 'lock', route: '/admin/domains', detail: 'Admin' },
  { id: 'cs-billing', label: 'Billing', icon: 'billing', route: '/admin/billing', detail: 'Admin' },
  {
    id: 'cs-feature-flags',
    label: 'Feature Flags',
    icon: 'settings',
    route: '/admin/feature-flags',
    detail: 'Admin',
  },
  {
    id: 'cs-features',
    label: 'Features',
    icon: 'sparkle',
    route: '/admin/site-features',
    detail: 'Admin',
  },
  {
    id: 'cs-settings',
    label: 'Settings',
    icon: 'settings',
    route: '/admin/settings',
    detail: 'Admin',
  },
  { id: 'cs-docs', label: 'API Docs', icon: 'document', route: '/admin/docs', detail: 'Admin' },
  { id: 'cs-status', label: 'System Status', icon: 'status', route: '/status', detail: 'Public' },
];

/** Case-insensitive substring match on label or route. Exported for unit tests. */
export function matchCommandCatalog(q: string, limit = 6): CommandResult[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  return ADMIN_COMMAND_CATALOG.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(term) || (cmd.route ?? '').toLowerCase().includes(term),
  ).slice(0, limit);
}

search.get('/api/search/command', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ results: [] });
  const bounded = q.slice(0, 100);
  const results: CommandResult[] = [...matchCommandCatalog(bounded)];

  // The caller's own sites by name → jump straight to that site in the admin.
  const orgId = c.get('orgId');
  if (orgId) {
    try {
      const { data } = await dbQuery<{ id: string; slug: string; business_name: string }>(
        c.env.DB,
        'SELECT id, slug, business_name FROM sites WHERE org_id = ? AND business_name LIKE ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5',
        [orgId, `%${sanitizeLikeTerm(bounded)}%`],
      );
      for (const s of data) {
        results.push({
          id: `cs-site-${s.id}`,
          label: s.business_name || s.slug,
          icon: 'dashboard',
          route: `/admin?site=${encodeURIComponent(s.id)}`,
          detail: 'Your site',
        });
      }
    } catch {
      /* site search is best-effort */
    }
  }

  // Best-effort AutoRAG enrichment over indexed content (skipped when unconfigured).
  try {
    const ai = c.env.AI as unknown as {
      autorag?: (name: string) => {
        search: (opts: { query: string }) => Promise<{
          data?: Array<{ filename?: string; attributes?: Record<string, unknown> }>;
        }>;
      };
    };
    if (ai?.autorag) {
      const rag = await ai.autorag('projectsites-rag').search({ query: bounded });
      for (const d of (rag?.data ?? []).slice(0, 4)) {
        const title = String(d.attributes?.['title'] ?? d.filename ?? 'Result');
        const url = d.attributes?.['url'] ? String(d.attributes['url']) : undefined;
        results.push({
          id: `cs-rag-${title}`,
          label: title,
          icon: 'sparkle',
          url,
          detail: 'AI · AutoRAG',
        });
      }
    }
  } catch {
    /* AutoRAG optional */
  }

  return c.json({ results: results.slice(0, 14) });
});

// ─── Site Lookup ────────────────────────────────────────────

interface SiteRow {
  id: string;
  slug: string;
  status: string;
  current_build_version: string | null;
}

search.get('/api/sites/lookup', async (c) => {
  // Bound BOTH public inputs — this is an unauthenticated endpoint that hits D1 per request, so an
  // unbounded place_id/slug is a cheap DB-hammering vector (the sibling /api/sites/search already
  // caps `q` at 100; this handler had NO cap). Trim + length-cap: slug ≤63 (its canonical
  // `^[a-z0-9-]{1,63}$` charset ceiling), place_id ≤256 (Google IDs vary but are never longer).
  const placeId = c.req.query('place_id')?.trim().slice(0, 256);
  const slug = c.req.query('slug')?.trim().slice(0, 63);

  if (!placeId && !slug) {
    throw badRequest('Missing required query parameter: place_id or slug');
  }

  let site: SiteRow | null = null;

  if (placeId) {
    site = await dbQueryOne<SiteRow>(
      c.env.DB,
      'SELECT id, slug, status, current_build_version FROM sites WHERE google_place_id = ? AND deleted_at IS NULL',
      [placeId],
    );
  } else if (slug) {
    // A slug outside the canonical charset can never match a real row — short-circuit to
    // exists:false with NO DB hit (bounds abuse AND saves a query). `else if (slug)` also
    // narrows `slug` to string, dropping the prior non-null `slug!` assertion.
    if (!/^[a-z0-9-]{1,63}$/.test(slug)) {
      return c.json({ data: { exists: false } });
    }
    site = await dbQueryOne<SiteRow>(
      c.env.DB,
      'SELECT id, slug, status, current_build_version FROM sites WHERE slug = ? AND deleted_at IS NULL',
      [slug],
    );
  }

  if (!site) {
    return c.json({ data: { exists: false } });
  }

  return c.json({
    data: {
      exists: true,
      site_id: site.id,
      slug: site.slug,
      status: site.status,
      has_build: site.current_build_version !== null,
    },
  });
});
export { search };
