import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { getOnboardingProgress } from './service.js';

export async function handleOnboardingProgress(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'onboarding_copilot', { orgId: requireOrgId(c) }))) return c.notFound();
  return c.json(await getOnboardingProgress(c.env, requireOrgId(c)));
}
