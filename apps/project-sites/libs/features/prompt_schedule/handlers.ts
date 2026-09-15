import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import {
  FLAG_KEY,
  createSchedule,
  listSchedules,
  deleteSchedule,
  getActiveVariant,
} from './service.js';
import {
  CreatePromptScheduleSchema,
  PromptScheduleListResponseSchema,
  ActiveScheduleResponseSchema,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };
export const promptSchedule = new Hono<AppContext>();

/** Structured JSON log line (charter: every path a fire touches emits correlated logs). */
function log(c: import('hono').Context<AppContext>, event: string, extra: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'prompt_schedule',
      event,
      requestId: c.get('requestId') ?? null,
      orgId: c.get('orgId') ?? null,
      ...extra,
    }),
  );
}

/** Auth + flag gate — returns a Response to short-circuit, or null to proceed. Flag off → 404 (dark, never 403). */
async function guard(c: import('hono').Context<AppContext>): Promise<Response | null> {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const on = await isFlagOn(c.env, FLAG_KEY, { userId, orgId: c.get('orgId') }).catch(() => false);
  if (!on) return notFound(c);
  return null;
}

promptSchedule.post('/api/prompt-schedules', zValidator('json', CreatePromptScheduleSchema), async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  try {
    const schedule = await createSchedule(c.env, orgId, c.req.valid('json'));
    log(c, 'schedule.created', { scheduleId: schedule.id, promptKey: schedule.prompt_key, variant: schedule.variant });
    return c.json({ schedule }, 201);
  } catch (err) {
    log(c, 'schedule.create_failed', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Could not create schedule' } }, 500);
  }
});

promptSchedule.get('/api/prompt-schedules', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const schedules = await listSchedules(c.env, orgId);
  return c.json(PromptScheduleListResponseSchema.parse({ schedules, count: schedules.length }));
});

promptSchedule.get('/api/prompt-schedules/active', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const key = c.req.query('key');
  if (!key) return c.json({ error: { code: 'BAD_REQUEST', message: 'key query param required' } }, 400);
  const active = await getActiveVariant(c.env, orgId, key, Date.now());
  return c.json(
    ActiveScheduleResponseSchema.parse({
      prompt_key: key,
      variant: active?.variant ?? null,
      schedule_id: active?.id ?? null,
      label: active?.label ?? null,
      resolved_at: new Date().toISOString(),
    }),
  );
});

promptSchedule.delete('/api/prompt-schedules/:id', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const ok = await deleteSchedule(c.env, orgId, c.req.param('id'));
  if (!ok) return notFound(c);
  log(c, 'schedule.deleted', { scheduleId: c.req.param('id') });
  return c.json({ deleted: true, id: c.req.param('id') });
});
