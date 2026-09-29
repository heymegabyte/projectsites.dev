/**
 * Handler tests for the psnotify inbox HTTP surface (`libs/features/psnotify/handlers.ts`).
 *
 * These lock the LEGACY D1 bell CONTRACT the psnotify feature is being aligned to so a
 * later flag-flip is a clean swap:
 *   - `GET /api/notifications`      → `{ data: Notification[], unread_count: number }`
 *     (NOT the old `{ notifications, unread }`) — matches `libs/features/notifications`
 *     + `notification-bell.component.ts`.
 *   - `POST /api/notifications/read-all` → mark ALL the caller's unread read, scoped by the
 *     AUTHED userId (never a request-supplied id), mirroring the legacy endpoint.
 *
 * The flag + auth gate is exercised too: flag OFF → 404 (dark, never 403); no userId → 401.
 * The DO is faked with an in-memory stub resolved by name, so caller-scoping is asserted
 * structurally (getByName(userId), never a client id).
 */

// NOTE: `jest` is the INJECTED GLOBAL (not imported from '@jest/globals') — @swc/jest
// only hoists `jest.mock(...)` above the imports when it sees the global identifier
// (repo gotcha, apps/project-sites/CLAUDE.md #12). Importing `jest` leaves the mock
// BELOW the handler import → the real isFlagOn loads first → the mock no-ops → 404.
import { describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn().mockResolvedValue(true),
}));

import { Hono } from 'hono';
import { psnotifyInbox } from '../handlers.js';
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
import type { Env, Variables } from '../../../../src/types/env.js';

/** The mocked flag gate — cast to the jest mock for per-test control. */
const mockIsFlagOn = isFlagOn as unknown as jest.Mock;

/**
 * A fake per-user inbox stub. `/list` returns the DO's NATURAL shape
 * `{ notifications, unread }` (NOT the HTTP shape) — the handler under test is
 * responsible for mapping it to the legacy `{ data, unread_count }` bell contract.
 */
class FakeInboxStub {
  constructor(
    private list_: { data: unknown[]; unread: number },
    private readAll_: number,
  ) {}
  async fetch(url: string, init?: { method?: string }): Promise<Response> {
    const path = new URL(url).pathname;
    if (path === '/list') {
      return Response.json({ notifications: this.list_.data, unread: this.list_.unread });
    }
    if (path === '/read-all' && init?.method === 'POST') {
      return Response.json({ ok: true, updated: this.readAll_ });
    }
    if (path === '/read' && init?.method === 'POST') return Response.json({ ok: true, updated: true });
    return new Response('not found', { status: 404 });
  }
}

/**
 * Build a Hono app with the inbox routes mounted + the auth vars pre-seeded.
 * `resolvedNames` records every getByName key so we can assert caller-scoping.
 */
function makeApp(opts: {
  userId?: string | null;
  hasBinding?: boolean;
  list?: { data: unknown[]; unread: number };
  readAll?: number;
}) {
  const resolvedNames: string[] = [];
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const stub = new FakeInboxStub(opts.list ?? { data: [], unread: 0 }, opts.readAll ?? 0);
  const env = {
    PSNOTIFY_DO: opts.hasBinding === false
      ? undefined
      : {
          getByName: (name: string) => {
            resolvedNames.push(name);
            return stub;
          },
        },
  } as unknown as Env;

  app.use('*', async (c, next) => {
    if (opts.userId !== null) c.set('userId', opts.userId ?? 'user-1');
    c.set('orgId', 'org-1');
    c.set('requestId', 'req-1');
    await next();
  });
  app.route('/', psnotifyInbox);
  return { app, env, resolvedNames };
}

describe('psnotify inbox handlers — legacy D1 bell contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFlagOn.mockResolvedValue(true);
  });

  it('GET /api/notifications returns { data, unread_count } (NOT { notifications, unread })', async () => {
    const { app, env } = makeApp({
      list: { data: [{ id: '1', type: 'system', title: 'hi' }], unread: 3 },
    });
    const res = await app.request('/api/notifications', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('unread_count', 3);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).not.toHaveProperty('notifications');
    expect(body).not.toHaveProperty('unread');
  });

  it('GET /api/notifications is caller-scoped — resolves the inbox by the AUTHED userId', async () => {
    const { app, env, resolvedNames } = makeApp({ userId: 'alice@x.dev' });
    await app.request('/api/notifications', {}, env);
    expect(resolvedNames).toEqual(['alice@x.dev']);
  });

  it('GET /api/notifications fails soft to an empty { data, unread_count } when the DO binding is absent', async () => {
    const { app, env } = makeApp({ hasBinding: false });
    const res = await app.request('/api/notifications', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], unread_count: 0 });
  });

  it('GET /api/notifications → 401 when unauthenticated', async () => {
    const { app, env } = makeApp({ userId: null });
    const res = await app.request('/api/notifications', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/notifications → 404 (dark, never 403) when the flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const { app, env } = makeApp({});
    const res = await app.request('/api/notifications', {}, env);
    expect(res.status).toBe(404);
  });

  it('POST /api/notifications/read-all marks all read + returns { ok, updated }, scoped by userId', async () => {
    const { app, env, resolvedNames } = makeApp({ userId: 'bob@x.dev', readAll: 5 });
    const res = await app.request('/api/notifications/read-all', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 5 });
    // Scoped strictly to the authed caller — never a request-supplied id.
    expect(resolvedNames).toEqual(['bob@x.dev']);
  });

  it('POST /api/notifications/read-all fails soft (never 500) when the DO binding is absent', async () => {
    const { app, env } = makeApp({ hasBinding: false });
    const res = await app.request('/api/notifications/read-all', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 0 });
  });

  it('POST /api/notifications/read-all → 404 (dark) when the flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const { app, env } = makeApp({});
    const res = await app.request('/api/notifications/read-all', { method: 'POST' }, env);
    expect(res.status).toBe(404);
  });
});
