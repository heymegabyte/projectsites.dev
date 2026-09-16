/**
 * Usage Gauges handlers — GET /api/usage
 *
 * Returns per-org usage metrics (sites, builds, media, bandwidth)
 * for SVG gauge-ring visualization. Flag-gated behind `usage_gauges`.
 *
 * @module libs/features/usage_gauges/handlers
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { computeUsageGauges } from './service.js';

export async function handleUsageGauges(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) {
    return c.notFound();
  }
  const gauges = await computeUsageGauges(c.env, requireOrgId(c));
  return c.json({ data: gauges, period: 'current' });
}
