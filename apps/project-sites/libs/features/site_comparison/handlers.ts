import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { SiteCompareSchema } from './schemas.js';
import { compareSites } from './service.js';

export async function handleSiteCompare(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'batch_operations', { orgId: requireOrgId(c) }))) return c.notFound();
  const body = SiteCompareSchema.parse(await c.req.json());
  const result = await compareSites(c.env, body.siteIdA, body.siteIdB);
  if (!result) return c.json({ error: 'One or both sites not found' }, 404);
  return c.json(result);
}
