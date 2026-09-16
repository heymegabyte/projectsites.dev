/**
 * MRU Cards handlers — GET /api/mru
 *
 * Returns the most-recently-active sites for the current org.
 * Flag-gated behind `mru_cards` (default-off, experimental).
 *
 * @module libs/features/mru_cards/handlers
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { getMruCards } from './service.js';

export async function handleMruCards(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) {
    return c.notFound();
  }
  const limit = Math.min(Number(c.req.query('limit') ?? '5'), 20);
  const cards = await getMruCards(c.env, requireOrgId(c), limit);
  return c.json({ data: cards });
}
