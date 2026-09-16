import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { CloneSiteSchema } from './schemas.js';
import { cloneSite } from './service.js';

export async function handleSiteClone(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'batch_operations', { orgId: requireOrgId(c) }))) return c.notFound();
  const body = CloneSiteSchema.parse(await c.req.json());
  try { return c.json(await cloneSite(c.env, requireOrgId(c), body.sourceSiteId, body.targetSlug, body.targetName), 201); }
  catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e);
    // source_not_found → 404, slug_taken (+default) → 409, clone_failed (dropped
    // sites INSERT) → 500 so a DB write failure is an honest error, not a lying 201.
    const status = m === 'source_not_found' ? 404 : m === 'clone_failed' ? 500 : 409;
    return c.json({ error: m }, status);
  }
}
