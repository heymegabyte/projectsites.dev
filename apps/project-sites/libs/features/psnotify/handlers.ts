/**
 * @module libs/features/psnotify/handlers
 * @description Authed HTTP surface for the psnotify inbox (first slice).
 *
 * - `GET  /api/notifications`          — the caller's OWN inbox (+ unread count).
 * - `POST /api/notifications/:id/read` — mark one of the caller's notifications read.
 *
 * Caller-scoping is structural (the psnotify analogue of `assertSiteOwned`):
 * the inbox DO is resolved with `getByName(userId)` from the AUTHED session —
 * the id is NEVER taken from the request — so a user can only ever read/mutate
 * THEIR own inbox. Flag-gated behind `psnotify`; off → 404 (never 403, never
 * leak existence). The DO binding may be absent (migration not yet deployed) →
 * fail-soft to an empty inbox, never a 500.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';

import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { FLAG_KEY, type ListResponse } from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };
export const psnotifyInbox = new Hono<AppContext>();

/** Structured, correlated JSON log line (charter: every path a fire touches logs). */
function log(
  c: import('hono').Context<AppContext>,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'psnotify',
      event,
      requestId: c.get('requestId') ?? null,
      ...extra,
    }),
  );
}

/**
 * Auth + flag gate. Returns the caller's userId to proceed, or a short-circuit
 * Response (401 unauth · 404 flag-off — dark, never 403).
 */
async function guard(
  c: import('hono').Context<AppContext>,
): Promise<string | Response> {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const on = await isFlagOn(c.env, FLAG_KEY, { userId, orgId: c.get('orgId') }).catch(() => false);
  if (!on) return notFound(c);
  return userId;
}

// GET /api/notifications?unreadOnly&limit — the caller's OWN inbox.
psnotifyInbox.get('/api/notifications', async (c) => {
  const gated = await guard(c);
  if (typeof gated !== 'string') return gated;
  const userId = gated;

  // Fail-soft: the DO binding is absent until the DO-migration deploy lands.
  if (!c.env.PSNOTIFY_DO) {
    log(c, 'inbox.list.binding_missing');
    return c.json({ notifications: [], unread: 0 } satisfies ListResponse);
  }

  const unreadOnly = c.req.query('unreadOnly') === 'true' || c.req.query('unreadOnly') === '1';
  const limit = c.req.query('limit') ?? '50';
  try {
    // Caller-scoping: resolve the inbox by the AUTHED userId — never a request-supplied id.
    const stub = c.env.PSNOTIFY_DO.getByName(userId);
    const res = await stub.fetch(
      `http://do/list?unreadOnly=${unreadOnly ? '1' : '0'}&limit=${encodeURIComponent(limit)}`,
    );
    const data = (await res.json()) as ListResponse;
    log(c, 'inbox.list', { unread: data.unread, count: data.notifications.length });
    return c.json(data);
  } catch (err) {
    // Never 500 a bell fetch — degrade to an empty inbox + a correlated warn.
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'psnotify',
        event: 'inbox.list.error',
        requestId: c.get('requestId') ?? null,
        reason: (err as Error)?.message || 'exception',
      }),
    );
    return c.json({ notifications: [], unread: 0 } satisfies ListResponse);
  }
});

// POST /api/notifications/:id/read — mark one of the caller's notifications read.
psnotifyInbox.post('/api/notifications/:id/read', async (c) => {
  const gated = await guard(c);
  if (typeof gated !== 'string') return gated;
  const userId = gated;
  const id = c.req.param('id');

  if (!c.env.PSNOTIFY_DO) {
    log(c, 'inbox.read.binding_missing');
    return c.json({ ok: true, updated: false });
  }

  try {
    const stub = c.env.PSNOTIFY_DO.getByName(userId);
    const res = await stub.fetch('http://do/read', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    const data = (await res.json()) as { ok: true; updated: boolean };
    log(c, 'inbox.read', { updated: data.updated });
    return c.json(data);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'psnotify',
        event: 'inbox.read.error',
        requestId: c.get('requestId') ?? null,
        reason: (err as Error)?.message || 'exception',
      }),
    );
    return c.json({ ok: true, updated: false });
  }
});
