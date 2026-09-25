/**
 * @module __tests__/analytics_routes
 *
 * Jest unit tests for the `analyticsRoutes` Hono sub-app.
 * Uses `app.request()` — no real network, no real DO bindings.
 *
 * The executionCtx guard in the source (`try { c.executionCtx.waitUntil(p) } catch { void p }`)
 * prevents the Hono test harness (which throws on executionCtx access) from crashing
 * these tests. No mocking of executionCtx is needed.
 */

import { Hono } from 'hono';

import { analyticsRoutes, persistAnalyticsEvent, normalizeClickHref } from '../routes/analytics.js';
import type { IncomingEvent } from '../services/analytics_events.js';

/** Minimal Env stub — all optional/unknown bindings absent */
const mockEnv = {} as unknown as import('../types/env.js').Env;

const validEvent: IncomingEvent = {
  eventId: '123e4567-e89b-42d3-a456-426614174000',
  siteId: 's1',
  eventType: 'pageview',
  timestamp: 1_700_000_000_000,
};

function mockDb(opts: { rows?: unknown[]; runImpl?: jest.Mock } = {}) {
  const run = opts.runImpl ?? jest.fn().mockResolvedValue({});
  const all = jest.fn().mockResolvedValue({ results: opts.rows ?? [] });
  const prepare = jest.fn(() => ({ bind: () => ({ run, all }) }));
  const exec = jest.fn().mockResolvedValue({});
  return { db: { prepare, exec } as unknown as D1Database, prepare, run, all, exec };
}

/**
 * Mount analyticsRoutes behind a middleware injecting the authed org. The site-scoped
 * analytics endpoints (analytics-data / analytics-debug / test-event) now require the
 * caller to OWN the site (org-scoped IDOR guard, AL-789) — an unwrapped
 * `analyticsRoutes.request` carries no org, so those endpoints 404 (the correct secure
 * default; the cross-tenant deny paths are locked in analytics_idor.test.ts).
 */
function makeApp(auth: { orgId?: string } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    if (auth.orgId) c.set('orgId', auth.orgId);
    await next();
  });
  app.route('/', analyticsRoutes);
  return app;
}

describe('POST /api/events', () => {
  it('returns 202 + {status:"queued"} for a valid event', async () => {
    const validEvent = {
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      siteId: 's1',
      eventType: 'pageview',
      timestamp: 1700000000000,
    };

    const res = await analyticsRoutes.request(
      '/api/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validEvent),
      },
      mockEnv,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');
  });

  it('returns 400 + error:"invalid_event" when eventId is not a UUID', async () => {
    const badEvent = {
      eventId: 'not-a-uuid',
      siteId: 's1',
      eventType: 'pageview',
      timestamp: 1700000000000,
    };

    const res = await analyticsRoutes.request(
      '/api/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(badEvent),
      },
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_event');
  });
});

describe('GET /api/analytics-debug', () => {
  it('returns 400 when siteId query param is absent', async () => {
    const res = await analyticsRoutes.request('/api/analytics-debug', { method: 'GET' }, mockEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_param');
  });

  it('returns 200 + note:"dispatcher_unavailable" for an OWNER when EVENT_DISPATCHER binding absent', async () => {
    const m = mockDb({ rows: [{ id: 's1' }] }); // ownership resolve → owned
    const env = { DB: m.db } as unknown as import('../types/env.js').Env;
    const res = await makeApp({ orgId: 'o1' }).request(
      '/api/analytics-debug?siteId=s1',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; note: string };
    expect(body.note).toBe('dispatcher_unavailable');
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('404s a caller who is not authenticated (no org) — cross-tenant IDOR guard', async () => {
    const m = mockDb({ rows: [{ id: 's1' }] });
    const env = { DB: m.db } as unknown as import('../types/env.js').Env;
    const res = await analyticsRoutes.request(
      '/api/analytics-debug?siteId=s1',
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('normalizeClickHref (outbound-click destination — privacy boundary)', () => {
  it('keeps tel: / mailto: / sms: whole (the owner’s own contact)', () => {
    expect(normalizeClickHref('tel:+15551234567')).toBe('tel:+15551234567');
    expect(normalizeClickHref('mailto:hi@biz.com')).toBe('mailto:hi@biz.com');
    expect(normalizeClickHref('sms:+15551234567')).toBe('sms:+15551234567');
  });
  it('STRIPS query + fragment from http(s) (never store tracking params)', () => {
    expect(normalizeClickHref('https://instagram.com/biz?igsh=abc123&utm=x#top')).toBe('https://instagram.com/biz');
    expect(normalizeClickHref('https://book.me/slot/')).toBe('https://book.me/slot/');
  });
  it('drops non-link hrefs (relative, #, javascript:, empty, non-string)', () => {
    expect(normalizeClickHref('#section')).toBeUndefined();
    expect(normalizeClickHref('/about')).toBeUndefined();
    expect(normalizeClickHref('javascript:void(0)')).toBeUndefined();
    expect(normalizeClickHref('')).toBeUndefined();
    expect(normalizeClickHref(undefined)).toBeUndefined();
    expect(normalizeClickHref(42)).toBeUndefined();
  });
  it('length-caps defensively', () => {
    const out = normalizeClickHref(`https://x.test/${'a'.repeat(500)}`);
    expect(out && out.length).toBeLessThanOrEqual(200);
  });
});

describe('persistAnalyticsEvent', () => {
  it('INSERT OR IGNOREs the event into analytics_events', async () => {
    const m = mockDb();
    await persistAnalyticsEvent(m.db, validEvent);
    expect(m.prepare).toHaveBeenCalled();
    expect(String(m.prepare.mock.calls[0][0])).toContain('INSERT OR IGNORE INTO analytics_events');
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('self-heals once (ensureAnalyticsSchema + retry) when the table is missing', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('no such table')).mockResolvedValue({});
    const m = mockDb({ runImpl: run });
    await persistAnalyticsEvent(m.db, validEvent);
    expect(m.exec).toHaveBeenCalled(); // ensureAnalyticsSchema ran the DDL
    expect(run).toHaveBeenCalledTimes(2); // original + retry
  });

  it('never throws even when both insert attempts fail', async () => {
    const run = jest.fn().mockRejectedValue(new Error('hard fail'));
    const m = mockDb({ runImpl: run });
    await expect(persistAnalyticsEvent(m.db, validEvent)).resolves.toBeUndefined();
  });
});

describe('GET /api/analytics-data', () => {
  it('returns 400 without siteId', async () => {
    const res = await analyticsRoutes.request('/api/analytics-data', { method: 'GET' }, mockEnv);
    expect(res.status).toBe(400);
  });

  it('404s (fail-closed) when DB is absent — ownership cannot be verified, so no feed is served', async () => {
    // The org-ownership gate (AL-789) runs before the feed read; with no DB the resolve
    // fails closed (dbQuery swallows the error → null) → 404, never the old graceful feed.
    const res = await makeApp({ orgId: 'o1' }).request(
      '/api/analytics-data?siteId=s1',
      { method: 'GET' },
      mockEnv,
    );
    expect(res.status).toBe(404);
  });

  it('returns stored events with parsed payloads', async () => {
    const m = mockDb({
      rows: [
        {
          id: '1',
          eventId: 'a',
          eventType: 'pageview',
          timestamp: 2,
          payload: '{"path":"/"}',
          status: 'ingested',
        },
        {
          id: '2',
          eventId: 'b',
          eventType: 'click',
          timestamp: 1,
          payload: '{"el":"btn"}',
          status: 'ingested',
        },
      ],
    });
    const env = { DB: m.db } as unknown as import('../types/env.js').Env;
    // makeApp injects the owning org; the mockDb resolves ownership (row[0].id) then
    // returns the same rows as the feed.
    const res = await makeApp({ orgId: 'o1' }).request(
      '/api/analytics-data?siteId=s1&limit=50',
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ payload: unknown }>;
      count: number;
      has_more: boolean;
    };
    expect(body.count).toBe(2);
    expect(body.has_more).toBe(false);
    expect(body.events[0]?.payload).toEqual({ path: '/' });
  });
});

describe('POST /api/test-event', () => {
  it('returns 400 without siteId', async () => {
    const res = await analyticsRoutes.request('/api/test-event', { method: 'POST' }, mockEnv);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown provider', async () => {
    const res = await analyticsRoutes.request(
      '/api/test-event?siteId=s1&provider=bogus',
      { method: 'POST' },
      mockEnv,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad_provider');
  });

  it('returns 200 + ok with a fresh eventId and dispatched:false (no DO) for an OWNER', async () => {
    const m = mockDb({ rows: [{ id: 's1' }] }); // ownership resolve → owned
    const env = { DB: m.db } as unknown as import('../types/env.js').Env;
    const res = await makeApp({ orgId: 'o1' }).request(
      '/api/test-event?siteId=s1&provider=sentry',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      eventId: string;
      provider: string;
      dispatched: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('sentry');
    expect(body.dispatched).toBe(false);
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
