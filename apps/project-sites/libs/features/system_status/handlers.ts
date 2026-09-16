/**
 * System Status handlers — GET /api/system/status
 *
 * Returns aggregated health status for all platform integrations.
 * Flag-gated behind `system_status` (default-off, experimental).
 *
 * @module libs/features/system_status/handlers
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { probeAll } from './service.js';

/** GET /api/system/status — real-time integration health */
export async function handleSystemStatus(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> {
  if (!(await isFlagOn(c.env, 'system_status', { orgId: requireOrgId(c) }))) {
    return c.notFound();
  }
  const status = await probeAll(fetch);
  return c.json(status);
}
