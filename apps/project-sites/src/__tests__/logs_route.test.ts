import { Hono } from 'hono';

import { logsRoutes } from '../routes/logs';
import { isSuperAdmin } from '../services/sysadmin.js';

/**
 * Log Explorer route AUTHZ contract (fire-71 security hardening).
 *
 * `/api/logs/*` serves CROSS-TENANT Cloudflare Observability tail-logs (platform-wide,
 * NOT org-scoped). Since WLK-28 the rows surface raw AppError.message/code, so the surface
 * MUST be super-admin-only — matching the sibling KV/D1/R2 + admin_analytics inspectors.
 * These lock: 401 when anonymous, 403 when authed-but-not-super-admin (service never runs),
 * 200 for a super-admin. The logs_explorer service fns are mocked so no network/Observability
 * is touched. Regression guard for CWE-200 / CWE-639.
 */
jest.mock('../services/sysadmin.js', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('../services/logs_explorer.js', () => ({
  searchLogs: jest.fn(),
  costByRoute: jest.fn(),
  parseLogRange: jest.fn(() => ({ sinceMs: 0, untilMs: 1 })),
}));

const mockIsSuperAdmin = isSuperAdmin as jest.MockedFunction<typeof isSuperAdmin>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockSearch = require('../services/logs_explorer.js').searchLogs as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockCost = require('../services/logs_explorer.js').costByRoute as jest.Mock;

/** Mount the route behind a middleware that injects the authed-session vars. */
function makeApp(auth: { userId?: string; orgId?: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    if (auth.userId) c.set('userId', auth.userId);
    if (auth.orgId) c.set('orgId', auth.orgId);
    await next();
  });
  app.route('/', logsRoutes);
  return app;
}

const env = { DB: {} } as never;

function search(app: Hono, body: unknown = { query: '', range: '24h' }) {
  return app.request(
    '/api/logs/search',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

function cost(app: Hono) {
  return app.request('/api/logs/cost-by-route?range=24h', { method: 'GET' }, env);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsSuperAdmin.mockResolvedValue(true);
  mockSearch.mockResolvedValue({ items: [], next_cursor: null, total_returned: 0 });
  mockCost.mockResolvedValue({ range: '24h', grand_total_cost: 0, rows: [] });
});

describe('POST /api/logs/search — super-admin gate', () => {
  it('401s when unauthenticated', async () => {
    const res = await search(makeApp({}));
    expect(res.status).toBe(401);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('403s when authed but NOT super-admin (cross-tenant logs stay hidden)', async () => {
    mockIsSuperAdmin.mockResolvedValue(false);
    const res = await search(makeApp({ userId: 'u1', orgId: 'o1' }));
    expect(res.status).toBe(403);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('200s for a super-admin', async () => {
    const res = await search(makeApp({ userId: 'root', orgId: 'o1' }));
    expect(res.status).toBe(200);
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/logs/cost-by-route — super-admin gate', () => {
  it('401s when unauthenticated', async () => {
    const res = await cost(makeApp({}));
    expect(res.status).toBe(401);
    expect(mockCost).not.toHaveBeenCalled();
  });

  it('403s when authed but NOT super-admin', async () => {
    mockIsSuperAdmin.mockResolvedValue(false);
    const res = await cost(makeApp({ userId: 'u1', orgId: 'o1' }));
    expect(res.status).toBe(403);
    expect(mockCost).not.toHaveBeenCalled();
  });

  it('200s for a super-admin', async () => {
    const res = await cost(makeApp({ userId: 'root', orgId: 'o1' }));
    expect(res.status).toBe(200);
    expect(mockCost).toHaveBeenCalledTimes(1);
  });
});
