/**
 * Super-Admin analytics rollup routes (§9) — the raw-pipe consumers that sit
 * beside `admin_funnel`'s shaped funnel.
 *
 * - `GET /api/admin/analytics/events-daily`     → events_by_tenant_daily pipe
 * - `GET /api/admin/analytics/publishes-by-source` → site_publishes_by_source pipe
 *
 * Both return `{ rows, degraded, count }` via {@link fetchPipeRows} — `degraded`
 * flags the zero-state (Tinybird removed — D1 source TODO) so the dashboard renders
 * an empty rollup instead of an error. Gate (in order): auth (401) → super-admin
 * (403). Operator-only, no feature flag — mirrors `admin_outbox` / `admin_funnel`.
 *
 * @packageDocumentation
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { Env, Variables } from '../types/env.js';
import { isSuperAdmin } from '../services/sysadmin.js';
import {
  fetchPipeRows,
  type EventsDailyRow,
  type PublishesBySourceRow,
  type ClaimsBySourceRow,
} from '../services/analytics_query.js';

/** RFC7807-ish error envelope used across the worker. */
function errorBody(code: string, message: string, requestId: string | undefined) {
  return { error: { code, message, request_id: requestId ?? null } };
}

const daysParam = z.coerce.number().int().min(1).max(365).optional();
const tenantParam = z.string().min(1).max(128).optional();

const EventsDailySchema = z
  .object({ tenant_id: tenantParam, days: daysParam, event: z.string().min(1).max(64).optional() })
  .strip();
const PublishesSchema = z
  .object({ tenant_id: tenantParam, days: daysParam, source: z.string().min(1).max(32).optional() })
  .strip();
const ClaimsSchema = z
  .object({
    tenant_id: tenantParam,
    days: daysParam,
    source: z.string().min(1).max(120).optional(),
    campaign: z.string().min(1).max(120).optional(),
  })
  .strip();

export const adminAnalytics = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** Shared gate: 401 when anonymous, 403 when not super-admin; else null. */
async function guard(c: Ctx) {
  const requestId = c.get('requestId');
  const userId = c.get('userId');
  if (!userId) return c.json(errorBody('UNAUTHORIZED', 'Sign in required', requestId), 401);
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(errorBody('FORBIDDEN', 'Super-admin access required', requestId), 403);
  }
  return null;
}

adminAnalytics.get('/api/admin/analytics/events-daily', async (c) => {
  const denied = await guard(c);
  if (denied) return denied;
  const parsed = EventsDailySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(errorBody('VALIDATION_ERROR', 'Invalid query', c.get('requestId')), 400);
  }
  const { rows, degraded } = await fetchPipeRows<EventsDailyRow>(
    c.env,
    'events_by_tenant_daily',
    parsed.data,
  );
  return c.json({ rows, degraded, count: rows.length }, 200);
});

adminAnalytics.get('/api/admin/analytics/publishes-by-source', async (c) => {
  const denied = await guard(c);
  if (denied) return denied;
  const parsed = PublishesSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(errorBody('VALIDATION_ERROR', 'Invalid query', c.get('requestId')), 400);
  }
  const { rows, degraded } = await fetchPipeRows<PublishesBySourceRow>(
    c.env,
    'site_publishes_by_source',
    parsed.data,
  );
  return c.json({ rows, degraded, count: rows.length }, 200);
});

adminAnalytics.get('/api/admin/analytics/claims-by-source', async (c) => {
  const denied = await guard(c);
  if (denied) return denied;
  const parsed = ClaimsSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(errorBody('VALIDATION_ERROR', 'Invalid query', c.get('requestId')), 400);
  }
  const { rows, degraded } = await fetchPipeRows<ClaimsBySourceRow>(
    c.env,
    'claims_by_source',
    parsed.data,
  );
  return c.json({ rows, degraded, count: rows.length }, 200);
});
