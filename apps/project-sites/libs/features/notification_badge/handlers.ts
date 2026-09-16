import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { getBadgeCounts } from './service.js';

export async function handleBadge(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) return c.notFound();
  return c.json(await getBadgeCounts(c.env, requireOrgId(c)));
}
