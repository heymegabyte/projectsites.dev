import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { FLAG_KEY, scheduleForSite, getSchedulesForSite, cancelForSite } from './service.js';
import {
  CreatePublishScheduleSchema,
  PublishScheduleResponseSchema,
  PublishScheduleListResponseSchema,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };
export const sitePublishSchedule = new Hono<AppContext>();

/** Structured JSON log line (charter: every path a fire touches emits correlated logs). */
function log(c: import('hono').Context<AppContext>, event: string, extra: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'scheduled_publish',
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

// POST /api/sites/:id/publish-schedule — schedule (or reschedule) this site's go-live.
sitePublishSchedule.post(
  '/api/sites/:id/publish-schedule',
  zValidator('json', CreatePublishScheduleSchema),
  async (c) => {
    const blocked = await guard(c);
    if (blocked) return blocked;
    const orgId = c.get('orgId');
    if (!orgId) return unauthorized(c);
    const siteId = c.req.param('id');
    const { publish_at, label } = c.req.valid('json');
    // FUTURE guard (a Zod schema can't read the clock): reject a past/now datetime.
    if (Date.parse(publish_at) <= Date.now()) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'publish_at must be in the future' } },
        400,
      );
    }
    try {
      const res = await scheduleForSite(c.env, orgId, siteId, publish_at, label ?? null);
      if (!res.ok) {
        if (res.reason === 'not_found') return notFound(c);
        // not_built — a genuine precondition the owner must resolve (action-button-must-gate-on-server-precondition)
        log(c, 'schedule.rejected_not_built', { siteId });
        return c.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'This site has not finished building yet — you can schedule its go-live once the build completes.',
            },
          },
          409,
        );
      }
      log(c, 'schedule.created', { siteId, scheduleId: res.schedule.id, publishAt: publish_at });
      return c.json(PublishScheduleResponseSchema.parse({ schedule: res.schedule }), 201);
    } catch (err) {
      log(c, 'schedule.create_failed', { siteId, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Could not schedule publish' } }, 500);
    }
  },
);

// GET /api/sites/:id/publish-schedule — this site's schedules (newest first).
sitePublishSchedule.get('/api/sites/:id/publish-schedule', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const schedules = await getSchedulesForSite(c.env, orgId, c.req.param('id'));
  return c.json(PublishScheduleListResponseSchema.parse({ schedules, count: schedules.length }));
});

// DELETE /api/sites/:id/publish-schedule — cancel the pending schedule for this site.
sitePublishSchedule.delete('/api/sites/:id/publish-schedule', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const siteId = c.req.param('id');
  const ok = await cancelForSite(c.env, orgId, siteId);
  if (!ok) return notFound(c);
  log(c, 'schedule.canceled', { siteId });
  return c.json({ canceled: true, site_id: siteId });
});
