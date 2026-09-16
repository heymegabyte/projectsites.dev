import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { BatchRequestSchema } from './schemas.js';
import { batchProcess } from './service.js';

export async function handleBatchOps(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'batch_operations', { orgId: requireOrgId(c) }))) return c.notFound();
  const body = BatchRequestSchema.parse(await c.req.json());
  const results = await batchProcess(c.env, requireOrgId(c), body.siteIds, body.action);
  return c.json({ results, summary: { total: results.length, ok: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length } });
}
