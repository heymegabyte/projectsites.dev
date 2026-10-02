/**
 * Log Explorer routes — `POST /api/logs/search` + `GET /api/logs/cost-by-route`
 * powering the `/admin/logs` section. Both back onto Cloudflare Workers
 * Observability via {@link ../services/logs_explorer.ts}.
 *
 * Gated by the `log_explorer` feature flag: when OFF, both return 404 (never
 * 403) so the admin UI shows its honest "isn't enabled" notice instead of
 * leaking the route. When ON (stable/100%), they serve real tail-log data.
 *
 * These MUST be mounted before the `api` catch-all in `index.ts` so the
 * `/api/logs/*` paths win over the unmatched-route handler (which is exactly
 * what made these 404 before the routes existed).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { costByRoute, parseLogRange, searchLogs } from '../services/logs_explorer.js';
import { isSuperAdmin } from '../services/sysadmin.js';

export const logsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Auth guard — returns the caller's ids or null (→ 401). */
function requireAuth(c: { get: (k: string) => unknown }): { userId: string; orgId: string } | null {
  const userId = c.get('userId') as string | undefined;
  const orgId = c.get('orgId') as string | undefined;
  if (!userId || !orgId) return null;
  return { userId, orgId };
}

const SearchBody = z.object({
  query: z.string().max(512).optional().default(''),
  range: z.string().optional().default('24h'),
  limit: z.number().int().min(1).max(200).optional().default(100),
  cursor: z.string().nullable().optional(),
});

/**
 * `POST /api/logs/search` — Search Worker tail logs with the admin DSL.
 *
 * Body: `{ query?, range?, limit?, cursor? }`. Returns
 * `{ data: { items, next_cursor, total_returned } }`. 404 when `log_explorer`
 * is off; 401 when unauthenticated.
 */
logsRoutes.post('/api/logs/search', async (c) => {
  const ctx = requireAuth(c);
  if (!ctx) return c.json({ error: { code: 'UNAUTHORIZED', message: 'auth required' } }, 401);
  // log_explorer un-flagged 2026-08-13 (was stable/100%) — always available.
  // Observability tail-logs are CROSS-TENANT (platform-wide, NOT org-scoped) and since
  // WLK-28 these rows surface raw AppError.message/code — gate to super-admin only,
  // matching the sibling KV/D1/R2 + admin_analytics inspectors (CWE-200 / CWE-639).
  if (!(await isSuperAdmin(c.env, ctx.userId))) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Super-admin access required' } }, 403);
  }

  const parsed = SearchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'invalid search body' } }, 400);
  }
  const data = await searchLogs(c.env, {
    query: parsed.data.query,
    range: parseLogRange(parsed.data.range),
    limit: parsed.data.limit,
  });
  return c.json({ data });
});

/**
 * `GET /api/logs/cost-by-route?range=24h` — Per-route cost + volume rollup.
 *
 * Returns `{ data: { range, grand_total_cost, rows } }`. 404 when `log_explorer`
 * is off; 401 when unauthenticated.
 */
logsRoutes.get('/api/logs/cost-by-route', async (c) => {
  const ctx = requireAuth(c);
  if (!ctx) return c.json({ error: { code: 'UNAUTHORIZED', message: 'auth required' } }, 401);
  // log_explorer un-flagged 2026-08-13 (was stable/100%) — always available.
  // Observability tail-logs are CROSS-TENANT (platform-wide, NOT org-scoped) and since
  // WLK-28 these rows surface raw AppError.message/code — gate to super-admin only,
  // matching the sibling KV/D1/R2 + admin_analytics inspectors (CWE-200 / CWE-639).
  if (!(await isSuperAdmin(c.env, ctx.userId))) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Super-admin access required' } }, 403);
  }

  const data = await costByRoute(c.env, parseLogRange(c.req.query('range')));
  return c.json({ data });
});
