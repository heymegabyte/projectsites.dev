import { Hono } from 'hono';

import { analyticsRoutes } from '../routes/analytics';
import { dbQueryOne } from '../services/db.js';

/**
 * Cross-tenant IDOR regression for the Analytics ingestion plane (routes/analytics.ts).
 *
 * `GET /api/analytics-data`, `GET /api/analytics-debug`, and `POST /api/test-event` each
 * accept a CLIENT-supplied `siteId` (slug OR record id) and touch that site's data — and
 * `authMiddleware` is populate-only (never 401s). Before AL-789 they had ZERO ownership
 * check, so an anonymous caller could read ANY tenant's `visitor_events` (session ids,
 * visitor geo, UA strings) by guessing a public subdomain slug, and inject synthetic
 * events into any tenant's feed. PROVEN LIVE via an unauthenticated curl that returned
 * franklin-barbecue's real visitor rows.
 *
 * The fix resolves the site to the caller's org (`resolveOwnedSiteId`, the slug-aware
 * companion to services/site_ownership) and returns 404 — never 403 — for unauthenticated,
 * foreign-org, and unknown sites alike (existence-leak protocol). These lock the deny paths
 * AND prove the legit owner path still returns the feed.
 */
jest.mock('../services/db.js', () => ({ dbQueryOne: jest.fn(), dbQuery: jest.fn() }));
const mockOwn = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;

/** Mount the analytics routes behind a middleware injecting the authed-session vars. */
function makeApp(auth: { userId?: string; orgId?: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    if (auth.userId) c.set('userId', auth.userId);
    if (auth.orgId) c.set('orgId', auth.orgId);
    await next();
  });
  app.route('/', analyticsRoutes);
  return app;
}

const EVENTS = [
  {
    id: 'e1',
    eventId: 'e1',
    eventType: 'pageview',
    sessionId: 's1',
    timestamp: 1,
    payload: '{"city":"NYC"}',
    status: 'ingested',
  },
];

/** env whose D1 `prepare().bind().all()` returns the visitor_events feed. */
function makeEnv() {
  return {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: EVENTS }) }) }) },
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/analytics-data — cross-tenant IDOR guard', () => {
  it('404s an UNAUTHENTICATED caller (no org) — never leaks a foreign feed', async () => {
    const res = await makeApp({}).request(
      '/api/analytics-data?siteId=franklin-barbecue',
      {},
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(mockOwn).not.toHaveBeenCalled(); // short-circuits on missing org (no DB hit)
  });

  it('404s an authed caller for a site owned by ANOTHER org (no existence leak — not 403)', async () => {
    mockOwn.mockResolvedValue(null); // resolveOwnedSiteId → not owned by this org
    const res = await makeApp({ userId: 'u1', orgId: 'org-a' }).request(
      '/api/analytics-data?siteId=foreign-slug',
      {},
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('200s + returns the feed for the OWNER (legit admin path preserved)', async () => {
    mockOwn.mockResolvedValue({ id: 'site-rec-1' } as never);
    const res = await makeApp({ userId: 'u1', orgId: 'org-a' }).request(
      '/api/analytics-data?siteId=mine',
      {},
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; count: number };
    expect(body.count).toBe(1);
  });

  it('400s when siteId is missing (input check unchanged, before the ownership gate)', async () => {
    const res = await makeApp({ userId: 'u1', orgId: 'org-a' }).request(
      '/api/analytics-data',
      {},
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/test-event — cross-tenant WRITE IDOR guard', () => {
  it('404s an unauthenticated writer (no synthetic event into a foreign feed)', async () => {
    const res = await makeApp({}).request(
      '/api/test-event?siteId=franklin-barbecue',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('404s an authed writer targeting a foreign-org site', async () => {
    mockOwn.mockResolvedValue(null);
    const res = await makeApp({ userId: 'u1', orgId: 'org-a' }).request(
      '/api/test-event?siteId=foreign-slug',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/analytics-debug — cross-tenant IDOR guard', () => {
  it('404s an unauthenticated caller before proxying the DO', async () => {
    const res = await makeApp({}).request(
      '/api/analytics-debug?siteId=franklin-barbecue',
      {},
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});
