/**
 * @module libs/features/cmdk_ai_actions/cmdk_suggest
 *
 * Cmd+K natural-language ACTION SUGGESTIONS — folded in from the retired
 * `cmd_k_actions` flag (2026-08-14). "rebuild njsk" → ranked admin actions
 * matched to a site. This is the deterministic sibling of the AI-resolve route
 * in `handlers.ts`; BOTH Cmd+K surfaces now live under the single
 * `cmdk_ai_actions` flag (was two duplicate flags gating `/api/cmdk` vs
 * `/api/cmdk/resolve`). Backs `POST /api/cmdk`; returns 404 when the flag is off.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { dbQuery } from '../../../src/services/db.js';

export const CmdKQuerySchema = z.object({ q: z.string().min(1).max(200) }).strict();

interface SiteRow {
  id: string;
  slug: string;
  name: string;
}

const ACTIONS = [
  { verb: 'rebuild', label: 'Rebuild', action: 'rebuild' as const, route: '/admin/sites/' },
  { verb: 'snapshot', label: 'Snapshot', action: 'snapshot' as const, route: '/admin/sites/' },
  { verb: 'delete', label: 'Delete', action: 'delete' as const, route: '/admin/sites/' },
  { verb: 'view', label: 'View', action: 'view' as const, route: '/admin/sites/' },
  { verb: 'edit', label: 'Edit', action: 'edit' as const, route: '/admin/sites/' },
  { verb: 'publish', label: 'Publish', action: 'publish' as const, route: '/admin/sites/' },
];

function matchScore(slug: string, name: string, query: string): number {
  const q = query.toLowerCase();
  let score = 0;
  if (slug.includes(q)) score += 10;
  if (name.toLowerCase().includes(q)) score += 8;
  if (slug.startsWith(q)) score += 5;
  return score;
}

/** Rank admin actions against the caller's sites for a Cmd+K query. */
export async function suggestActions(
  env: Env,
  orgId: string,
  query: string,
): Promise<
  { id: string; label: string; action: string; siteSlug: string | null; route: string }[]
> {
  // sites has no `name` column — it's `business_name`. Alias it back to `name` so
  // the SiteRow shape stays unchanged.
  const sites = await dbQuery<SiteRow>(
    env.DB,
    `SELECT id, slug, business_name as name FROM sites WHERE org_id=? AND deleted_at IS NULL ORDER BY business_name LIMIT 50`,
    [orgId],
  );
  const results: {
    score: number;
    id: string;
    label: string;
    action: string;
    siteSlug: string | null;
    route: string;
  }[] = [];
  for (const site of sites.data ?? []) {
    for (const a of ACTIONS) {
      const score = matchScore(site.slug, site.name, query);
      if (score > 0 || query.length < 2) {
        results.push({
          score,
          id: `${a.action}-${site.id}`,
          label: `${a.label}: ${site.name}`,
          action: a.action,
          siteSlug: site.slug,
          route: `${a.route}${site.id}`,
        });
      }
    }
  }
  if (query.length < 2) {
    results.push({
      score: 1,
      id: 'sites',
      label: 'Sites',
      action: 'view',
      siteSlug: null,
      route: '/admin/sites',
    });
    results.push({
      score: 1,
      id: 'billing',
      label: 'Billing',
      action: 'view',
      siteSlug: null,
      route: '/admin/billing',
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

/** `POST /api/cmdk` — natural-language action suggestions. 404 when the flag is off. */
export async function handleCmdK(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> {
  if (!(await isFlagOn(c.env, 'cmdk_ai_actions', { orgId: requireOrgId(c) }))) return c.notFound();
  const { q } = CmdKQuerySchema.parse(await c.req.json());
  return c.json({ suggestions: await suggestActions(c.env, requireOrgId(c), q) });
}
