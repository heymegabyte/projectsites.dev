/**
 * Activity Feed handlers — GET /api/activity
 *
 * Returns paginated, org-scoped activity timeline. Flag-gated behind
 * `activity_feed` (default-off, experimental).
 *
 * @module libs/features/activity_feed/handlers
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { getActivityFeed } from './service.js';

/** GET /api/activity?limit=50&cursor=... — org-scoped activity timeline */
export async function handleActivityFeed(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) {
    return c.notFound();
  }
  const limit = Math.min(Number(c.req.query('limit') ?? '50'), 100);
  const cursor = c.req.query('cursor') ?? undefined;
  const { entries, hasMore } = await getActivityFeed(c.env, requireOrgId(c), limit, cursor);
  return c.json({
    data: entries,
    cursor: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
    hasMore,
  });
}
