/**
 * Unit tests for site-specific audit logs:
 *   1. getSiteAuditLogs service function (from ../services/audit.js)
 *   2. GET /api/sites/:id/logs route endpoint (from ../routes/api.js)
 */

// ─── Module Mocks (must be before imports) ───────────────────

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../services/audit.js', () => {
  const actual = jest.requireActual('../services/audit.js');
  return {
    ...actual,
    writeAuditLog: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../lib/posthog.js', () => ({
  capture: jest.fn(),
  trackAuth: jest.fn(),
  trackSite: jest.fn(),
  trackError: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { api } from '../routes/api.js';
import { dbQuery, dbQueryOne } from '../services/db.js';
import { getSiteAuditLogs } from '../services/audit.js';

const mockDbQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;
const mockDbQueryOne = dbQueryOne as jest.Mock;

// ─── Helpers ─────────────────────────────────────────────────

const mockDb = {} as D1Database;

const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    CACHE_KV: { get: jest.fn(), put: jest.fn(), delete: jest.fn() },
    SITES_BUCKET: { get: jest.fn(), put: jest.fn() },
    SENDGRID_API_KEY: 'test-sendgrid-key',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    STRIPE_SECRET_KEY: 'test-stripe-key',
    STRIPE_WEBHOOK_SECRET: 'test-stripe-webhook',
    ...overrides,
  }) as unknown as Env;

function createAuthenticatedApp(vars: Partial<Variables> = {}, envOverrides: Partial<Env> = {}) {
  const authedApp = new Hono<{ Bindings: Env; Variables: Variables }>();
  authedApp.onError(errorHandler);
  authedApp.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  authedApp.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app: authedApp, env };
}

function createUnauthenticatedApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app, env };
}

function makeRequest(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  env: Env,
  path: string,
  options?: RequestInit,
) {
  return app.request(path, options, env);
}

// ─── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// 1. getSiteAuditLogs — Service Function Tests
// ═══════════════════════════════════════════════════════════════

describe('getSiteAuditLogs', () => {
  const orgId = 'org-001';
  const siteId = 'site-001';

  it('returns logs filtered by site ID', async () => {
    const logs = [
      { id: 'log-1', action: 'site.created', target_id: siteId, org_id: orgId },
      {
        id: 'log-2',
        action: 'hostname.provisioned',
        target_id: 'host-1',
        org_id: orgId,
        metadata_json: `{"site_id":"${siteId}"}`,
      },
    ];
    mockDbQuery.mockResolvedValueOnce({ data: logs, error: null });

    const result = await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(result.data).toEqual(logs);
    expect(result.error).toBeNull();
    expect(mockDbQuery).toHaveBeenCalledWith(
      mockDb,
      expect.stringContaining('target_id = ?'),
      expect.arrayContaining([orgId, siteId]),
    );
    // Verify the LIKE clause for metadata_json matching
    expect(mockDbQuery).toHaveBeenCalledWith(
      mockDb,
      expect.stringContaining('metadata_json LIKE ?'),
      expect.arrayContaining([`%"site_id":"${siteId}"%`]),
    );
  });

  it('handles empty results', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    const result = await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(result.data).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('returns the TOTAL matching count (not just the page) so callers can paginate', async () => {
    // A full page of 100 rows, but 353 match in the store — the classic silent-cap:
    // the page is capped at `limit` while 253 rows are invisible unless `total` is exposed.
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `log-${i}`, target_id: siteId }));
    mockDbQuery
      .mockResolvedValueOnce({ data: page, error: null }) // SELECT … LIMIT 100
      .mockResolvedValueOnce({ data: [{ n: 353 }], error: null }); // COUNT(*)

    const result = await getSiteAuditLogs(mockDb, orgId, siteId, { limit: 100, offset: 0 });

    expect(result.data).toHaveLength(100);
    expect(result.total).toBe(353);
    // COUNT must use the SAME filter (target_id OR metadata LIKE) WITHOUT limit/offset.
    expect(mockDbQuery).toHaveBeenCalledWith(mockDb, expect.stringContaining('COUNT(*)'), [
      orgId,
      siteId,
      `%"site_id":"${siteId}"%`,
    ]);
  });

  it('falls back total to page length when the COUNT query returns nothing', async () => {
    // Defensive: a swallowed COUNT error must not make total NaN/undefined.
    mockDbQuery
      .mockResolvedValueOnce({ data: [{ id: 'log-1', target_id: siteId }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const result = await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(result.total).toBe(1);
  });

  it('uses default limit=100 and offset=0', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(mockDbQuery).toHaveBeenCalledWith(mockDb, expect.stringContaining('LIMIT'), [
      orgId,
      siteId,
      `%"site_id":"${siteId}"%`,
      100,
      0,
    ]);
  });

  it('respects custom limit and offset', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    await getSiteAuditLogs(mockDb, orgId, siteId, { limit: 25, offset: 50 });

    expect(mockDbQuery).toHaveBeenCalledWith(mockDb, expect.stringContaining('LIMIT'), [
      orgId,
      siteId,
      `%"site_id":"${siteId}"%`,
      25,
      50,
    ]);
  });

  it('handles database errors', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: 'D1 connection lost' });

    const result = await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(result.data).toEqual([]);
    expect(result.error).toBe('D1 connection lost');
  });

  it('queries with ORDER BY created_at DESC', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(mockDbQuery).toHaveBeenCalledWith(
      mockDb,
      expect.stringContaining('ORDER BY created_at DESC'),
      expect.any(Array),
    );
  });

  it('scopes query to the given org_id', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    await getSiteAuditLogs(mockDb, orgId, siteId);

    expect(mockDbQuery).toHaveBeenCalledWith(
      mockDb,
      expect.stringContaining('org_id = ?'),
      expect.arrayContaining([orgId]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. GET /api/sites/:id/logs — Route Endpoint Tests
// ═══════════════════════════════════════════════════════════════

describe('GET /api/sites/:id/logs', () => {
  const userId = 'user-abc';
  const orgId = 'org-xyz';
  const siteId = 'site-123';

  it('returns 401 without auth (no orgId)', async () => {
    const { app, env } = createUnauthenticatedApp();

    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 when site does not exist', async () => {
    // dbQueryOne for the site ownership check returns null
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp({ userId, orgId });

    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Site not found');
  });

  it('returns 404 when site belongs to a different org', async () => {
    // dbQueryOne SELECT ... WHERE id = ? AND org_id = ? won't match
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp({ userId, orgId: 'other-org' });

    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    expect(res.status).toBe(404);
  });

  it('returns logs for a valid authenticated site', async () => {
    const mockLogs = [
      {
        id: 'log-a',
        action: 'site.created',
        target_id: siteId,
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'log-b',
        action: 'site.updated',
        target_id: siteId,
        created_at: '2025-01-02T00:00:00Z',
      },
    ];

    // First call: dbQueryOne for site ownership check
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId });
    // Second call: dbQuery for getSiteAuditLogs
    mockDbQuery.mockResolvedValueOnce({ data: mockLogs, error: null });

    const { app, env } = createAuthenticatedApp({ userId, orgId });

    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof mockLogs };
    expect(body.data).toEqual(mockLogs);
    expect(body.data).toHaveLength(2);
  });

  it('exposes meta.total + has_more (documented contract, never silently caps)', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `log-${i}`, target_id: siteId }));
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId }); // ownership check
    mockDbQuery
      .mockResolvedValueOnce({ data: page, error: null }) // SELECT page
      .mockResolvedValueOnce({ data: [{ n: 353 }], error: null }); // COUNT(*)

    const { app, env } = createAuthenticatedApp({ userId, orgId });
    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs?limit=100&offset=0`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      meta: { total: number; has_more: boolean; limit: number; offset: number };
    };
    expect(body.data).toHaveLength(100);
    expect(body.meta.total).toBe(353);
    expect(body.meta.has_more).toBe(true); // 0 + 100 < 353
    expect(body.meta.limit).toBe(100);
    expect(body.meta.offset).toBe(0);
  });

  it('returns empty array when site has no logs', async () => {
    // Site exists
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId });
    // No logs found
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    const { app, env } = createAuthenticatedApp({ userId, orgId });

    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('uses default limit=100 and offset=0 when no query params', async () => {
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId });
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    const { app, env } = createAuthenticatedApp({ userId, orgId });

    await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    // The getSiteAuditLogs call should receive limit=100, offset=0
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('LIMIT'),
      expect.arrayContaining([100, 0]),
    );
  });

  it('passes custom limit and offset from query params', async () => {
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId });
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    const { app, env } = createAuthenticatedApp({ userId, orgId });

    await makeRequest(app, env, `/api/sites/${siteId}/logs?limit=10&offset=20`);

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('LIMIT'),
      expect.arrayContaining([10, 20]),
    );
  });

  it('returns data array at the top level (not nested under result)', async () => {
    const mockLogs = [{ id: 'log-1', action: 'site.created' }];
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId });
    mockDbQuery.mockResolvedValueOnce({ data: mockLogs, error: null });

    const { app, env } = createAuthenticatedApp({ userId, orgId });

    const res = await makeRequest(app, env, `/api/sites/${siteId}/logs`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof mockLogs };
    // The route returns { data: result.data }, not { data: { data: ..., error: ... } }
    expect(body.data).toEqual(mockLogs);
    expect(body).not.toHaveProperty('error');
  });
});
