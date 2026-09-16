import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { getSparkline } from './service.js';

export async function handleSparkline(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'site_doctor', { orgId: requireOrgId(c) }))) return c.notFound();
  const siteId = c.req.param('siteId');
  const days = Math.min(Number(c.req.query('days') ?? '7'), 30);
  return c.json(await getSparkline(c.env, siteId, days));
}
