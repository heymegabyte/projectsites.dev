/**
 * Unit tests for R2 File Browser API routes:
 *   - GET /api/sites/:id/files (list files)
 *   - GET /api/sites/:id/files/:path (read file)
 *   - PUT /api/sites/:id/files/:path (write file)
 */

// ─── Module Mocks (must be before imports) ───────────────────

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue({ data: [] }),
  getSiteAuditLogs: jest.fn().mockResolvedValue({ data: [] }),
}));

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
// GET/PUT /api/sites/:id/files[/:path] moved to their own module (route-decomposition
// installment 10) — mount it alongside `api` so these hand-apps still serve the routes.
import { siteFiles } from '../../libs/features/site_files/handlers.js';
import { dbQueryOne } from '../services/db.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;

// ─── Helpers ─────────────────────────────────────────────────

const TEST_SITE_ID = 'aaa-bbb-ccc-ddd';
const TEST_ORG_ID = 'org-123';
const TEST_SLUG = 'vitos-mens-salon';

const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    CACHE_KV: { get: jest.fn(), put: jest.fn(), delete: jest.fn().mockResolvedValue(undefined) },
    SITES_BUCKET: {
      list: jest.fn().mockResolvedValue({ objects: [] }),
      get: jest.fn().mockResolvedValue(null),
      put: jest.fn().mockResolvedValue(undefined),
    },
    SENDGRID_API_KEY: 'test-sendgrid-key',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    STRIPE_SECRET_KEY: 'test-stripe-key',
    STRIPE_WEBHOOK_SECRET: 'test-stripe-webhook',
    ...overrides,
  }) as unknown as Env;

function createAuthenticatedApp(envOverrides: Partial<Env> = {}) {
  const authedApp = new Hono<{ Bindings: Env; Variables: Variables }>();
  authedApp.onError(errorHandler);
  authedApp.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('orgId', TEST_ORG_ID);
    c.set('requestId', 'req-1');
    await next();
  });
  authedApp.route('/', siteFiles);
  authedApp.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app: authedApp, env };
}

function createUnauthenticatedApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', siteFiles);
  app.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app, env };
}

// ─── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────

describe('GET /api/sites/:id/files', () => {
  it('returns 401 when not authenticated', async () => {
    const { app, env } = createUnauthenticatedApp();
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/files`, {}, env);
    expect(res.status).toBe(401);
  });

  it('returns 404 when site not found', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce(null);
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/files`, {}, env);
    expect(res.status).toBe(404);
  });

  it('returns empty file list for site with no files', async () => {
    const mockBucket = {
      list: jest.fn().mockResolvedValue({ objects: [] }),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG, current_build_version: 'v1' });
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/files`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.files).toEqual([]);
  });

  it('returns file list with correct metadata', async () => {
    const mockObjects = [
      {
        key: `sites/${TEST_SLUG}/v1/index.html`,
        size: 2048,
        uploaded: new Date('2026-01-01'),
        httpMetadata: { contentType: 'text/html' },
      },
      {
        key: `sites/${TEST_SLUG}/v1/style.css`,
        size: 512,
        uploaded: new Date('2026-01-01'),
        httpMetadata: { contentType: 'text/css' },
      },
    ];
    const mockBucket = {
      list: jest.fn().mockResolvedValue({ objects: mockObjects }),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG, current_build_version: 'v1' });
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/files`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.files).toHaveLength(2);
    expect(body.data.files[0].name).toBe('index.html');
    expect(body.data.files[0].size).toBe(2048);
    expect(body.data.files[0].content_type).toBe('text/html');
    expect(body.data.files[1].name).toBe('style.css');
  });
});

describe('GET /api/sites/:id/files/:path', () => {
  it('returns 401 when not authenticated', async () => {
    const { app, env } = createUnauthenticatedApp();
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/index.html`,
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when file not found', async () => {
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/missing.html`,
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns file content when found', async () => {
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn().mockResolvedValue({
        text: jest.fn().mockResolvedValue('<html>Hello</html>'),
        size: 18,
        httpMetadata: { contentType: 'text/html' },
      }),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/index.html`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe('<html>Hello</html>');
    expect(body.data.content_type).toBe('text/html');
  });

  it('returns 403 when trying to access another sites files', async () => {
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/other-site/v1/index.html`,
      {},
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/sites/:id/files/:path', () => {
  it('returns 401 when not authenticated', async () => {
    const { app, env } = createUnauthenticatedApp();
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/index.html`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '<html>Updated</html>' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('saves file content successfully', async () => {
    const mockPut = jest.fn().mockResolvedValue(undefined);
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: mockPut,
      head: jest.fn().mockResolvedValue({ size: 100 }),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/index.html`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '<html>Updated</html>' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.updated).toBe(true);
    expect(mockPut).toHaveBeenCalledWith(
      `sites/${TEST_SLUG}/v1/index.html`,
      '<html>Updated</html>',
      expect.objectContaining({ httpMetadata: { contentType: 'text/html' } }),
    );
  });

  it('returns 403 when trying to write to another sites files', async () => {
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/other-site/v1/index.html`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hacked' }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('blocks traversal: dot-dot in GET resolved by URL normalization stays in scope', async () => {
    // Hono resolves `..` in URLs before routing. A path like
    // sites/slug/v1/../../other-site/secret.html resolves to sites/other-site/secret.html
    // which fails the prefix check → 403
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/../../other-site/secret.html`,
      {},
      env,
    );
    expect(res.status).toBe(403);
    expect(mockBucket.get).not.toHaveBeenCalled();
  });

  it('blocks traversal: cross-site path via direct slug in GET', async () => {
    // Directly trying to access another site's files
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/attacker-site/v1/index.html`,
      {},
      env,
    );
    expect(res.status).toBe(403);
    expect(mockBucket.get).not.toHaveBeenCalled();
  });

  it('blocks traversal: cross-site path via direct slug in PUT', async () => {
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/attacker-site/v1/index.html`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'malicious' }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it('rejects null bytes in file path', async () => {
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/files/index.html%00.jpg`, {}, env);
    expect(res.status).toBe(403);
    expect(mockBucket.get).not.toHaveBeenCalled();
  });

  it('detects content type from file extension', async () => {
    const mockPut = jest.fn().mockResolvedValue(undefined);
    const mockBucket = {
      list: jest.fn(),
      get: jest.fn(),
      put: mockPut,
      head: jest.fn().mockResolvedValue(null),
    };
    const { app, env } = createAuthenticatedApp({
      SITES_BUCKET: mockBucket as unknown as R2Bucket,
    });
    mockDbQueryOne.mockResolvedValueOnce({ slug: TEST_SLUG });
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/files/sites/${TEST_SLUG}/v1/data.json`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '{"key":"val"}' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockPut).toHaveBeenCalledWith(
      `sites/${TEST_SLUG}/v1/data.json`,
      '{"key":"val"}',
      expect.objectContaining({ httpMetadata: { contentType: 'application/json' } }),
    );
  });
});
