/**
 * Domain management admin routes and enhanced domain service tests.
 * Tests cover: admin list all domains, verify domain, re-verify,
 * deprovision, domain health checks, and enhanced analytics tracking.
 *
 * TDD: Written BEFORE implementation (Red phase).
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/posthog.js', () => ({
  capture: jest.fn(),
  trackAuth: jest.fn(),
  trackSite: jest.fn(),
  trackError: jest.fn(),
  trackDomain: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { api } from '../routes/api.js';
import { hostnames } from '../../libs/features/hostnames/handlers.js';
import { dbQuery, dbQueryOne, dbUpdate } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';

const mockDbQuery = dbQuery as jest.Mock;
const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockDbUpdate = dbUpdate as jest.Mock;
const mockWriteAuditLog = writeAuditLog as jest.Mock;

const originalFetch = global.fetch;
let mockFetch: jest.Mock;

const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          run: jest.fn().mockResolvedValue({ meta: { changes: 1 } }),
          all: jest.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    } as unknown as D1Database,
    CACHE_KV: {
      delete: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      put: jest.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    SITES_BUCKET: {} as unknown as R2Bucket,
    STRIPE_SECRET_KEY: 'test-stripe-key',
    STRIPE_PUBLISHABLE_KEY: 'test-stripe-pub',
    STRIPE_WEBHOOK_SECRET: 'test-stripe-webhook',
    CF_API_TOKEN: 'test-cf-token',
    CF_ZONE_ID: 'test-zone-id',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    GOOGLE_PLACES_API_KEY: 'test-places-key',
    POSTHOG_API_KEY: 'test-posthog-key',
    SENTRY_DSN: '',
    SENDGRID_API_KEY: 'test-sendgrid-key',
    ...overrides,
  }) as unknown as Env;

function createAuthenticatedApp(vars: Partial<Variables> = {}, envOverrides: Partial<Env> = {}) {
  const authedApp = new Hono<{ Bindings: Env; Variables: Variables }>();
  authedApp.onError(errorHandler);
  authedApp.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    if (vars.userRole) c.set('userRole', vars.userRole);
    await next();
  });
  authedApp.route('/', hostnames);
  authedApp.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app: authedApp, env };
}

function makeRequest(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  env: Env,
  path: string,
  options?: RequestInit,
) {
  return app.request(path, options, env);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockFetch = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { id: 'mock-id' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = originalFetch;
});

// NOTE: `GET /api/admin/domains` (base list) was REMOVED from the `api` router
// iter 48 — it was a dead shadow of aiAdmin's sites-grouped handler (which mounts
// first and wins in the real worker). Its 5 isolation tests here only passed
// because this file mounts `api` alone. The live handler is covered end-to-end by
// platform/admin E2E; the routes below (verify/delete/health/summary) remain unique
// to this router and are exercised here.

// ─── POST /api/admin/domains/:hostnameId/verify — Re-verify domain ───

describe('POST /api/admin/domains/:hostnameId/verify', () => {
  it('returns 401 when not authenticated', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.route('/', hostnames);
    app.route('/', api);
    const env = createMockEnv();

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/verify', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('triggers re-verification and returns updated status', async () => {
    // Mock: find hostname
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      status: 'pending',
    });

    // Mock: Cloudflare API checkHostnameStatus
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { status: 'active', ssl: { status: 'active' } },
      }),
      text: async () => '',
    });

    // Mock: dbUpdate
    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/verify', {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.status).toBe('active');
    expect(body.data.ssl_status).toBe('active');
  });

  it('returns 404 when hostname not found', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/nonexistent/verify', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when hostname belongs to different org', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-other',
      site_id: 'site-1',
      status: 'pending',
    });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/verify', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('handles verification failure gracefully', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      status: 'pending',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          status: 'pending',
          ssl: { status: 'pending_validation' },
          verification_errors: ['CNAME not found'],
        },
      }),
      text: async () => '',
    });

    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/verify', {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.verification_errors).toContain('CNAME not found');
  });

  it('writes audit log on re-verification', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      status: 'pending',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { status: 'active', ssl: { status: 'active' } },
      }),
      text: async () => '',
    });

    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
      requestId: 'req-test',
    });

    await makeRequest(app, env, '/api/admin/domains/h-1/verify', {
      method: 'POST',
    });

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        org_id: 'org-1',
        action: 'hostname.verified',
        target_type: 'hostname',
        target_id: 'h-1',
      }),
    );
  });
});

// ─── DELETE /api/admin/domains/:hostnameId — Admin deprovision ───

describe('DELETE /api/admin/domains/:hostnameId', () => {
  it('returns 401 when not authenticated', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.route('/', hostnames);
    app.route('/', api);
    const env = createMockEnv();

    const res = await makeRequest(app, env, '/api/admin/domains/h-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('deprovisions hostname and deletes from Cloudflare', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      type: 'custom_cname',
      status: 'active',
    });

    // CF delete
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { id: 'cf-host-1' } }),
      text: async () => '',
    });

    // DB soft-delete
    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/h-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.deprovisioned).toBe(true);
  });

  it('returns 404 when hostname not found', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/nonexistent', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('invalidates KV cache after deprovisioning', async () => {
    const mockKvDelete = jest.fn().mockResolvedValue(undefined);

    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      type: 'custom_cname',
      status: 'active',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { id: 'cf-host-1' } }),
      text: async () => '',
    });

    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const { app, env } = createAuthenticatedApp(
      { userId: 'user-1', orgId: 'org-1' },
      {
        CACHE_KV: {
          delete: mockKvDelete,
          get: jest.fn(),
          put: jest.fn(),
        } as unknown as KVNamespace,
      },
    );

    await makeRequest(app, env, '/api/admin/domains/h-1', {
      method: 'DELETE',
    });

    expect(mockKvDelete).toHaveBeenCalledWith('host:custom.example.com');
  });

  it('writes audit log on deprovision', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      type: 'custom_cname',
      status: 'active',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: {} }),
      text: async () => '',
    });

    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
      requestId: 'req-test',
    });

    await makeRequest(app, env, '/api/admin/domains/h-1', {
      method: 'DELETE',
    });

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        org_id: 'org-1',
        action: 'hostname.deprovisioned',
        target_type: 'hostname',
        target_id: 'h-1',
      }),
    );
  });
});

// ─── GET /api/admin/domains/:hostnameId/health — Domain health check ───

describe('GET /api/admin/domains/:hostnameId/health', () => {
  it('returns 401 when not authenticated', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.route('/', hostnames);
    app.route('/', api);
    const env = createMockEnv();

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/health');
    expect(res.status).toBe(401);
  });

  it('returns comprehensive health status for a domain', async () => {
    // hostname lookup
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      type: 'custom_cname',
      status: 'active',
      ssl_status: 'active',
      last_verified_at: '2026-02-15T00:00:00Z',
    });

    // CF hostname status check
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          status: 'active',
          ssl: { status: 'active' },
          verification_errors: [],
        },
      }),
      text: async () => '',
    });

    // CNAME check
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Answer: [{ type: 5, data: 'projectsites.dev.' }],
      }),
    });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.hostname).toBe('custom.example.com');
    expect(body.data.cf_status).toBe('active');
    expect(body.data.ssl_status).toBe('active');
    expect(body.data.dns_configured).toBe(true);
    expect(body.data.cname_target).toBe('projectsites.dev');
  });

  it('returns 404 when hostname not found or not owned', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/nonexistent/health');
    expect(res.status).toBe(404);
  });

  it('handles Cloudflare API failure gracefully', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'h-1',
      hostname: 'custom.example.com',
      cf_custom_hostname_id: 'cf-host-1',
      org_id: 'org-1',
      site_id: 'site-1',
      type: 'custom_cname',
      status: 'active',
      ssl_status: 'active',
      last_verified_at: '2026-02-15T00:00:00Z',
    });

    // CF API fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'Internal Server Error',
    });

    // DNS check returns null
    mockFetch.mockResolvedValueOnce({
      ok: false,
    });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/h-1/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.cf_status).toBe('unknown');
    expect(body.data.dns_configured).toBe(false);
  });
});

// ─── GET /api/admin/domains/summary — Domain stats overview ───

describe('GET /api/admin/domains/summary', () => {
  it('returns 401 when not authenticated', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.route('/', hostnames);
    app.route('/', api);
    const env = createMockEnv();

    const res = await makeRequest(app, env, '/api/admin/domains/summary');
    expect(res.status).toBe(401);
  });

  it('returns domain counts by status and type', async () => {
    // Total count query
    mockDbQuery.mockResolvedValueOnce({
      data: [{ total: 5, active: 3, pending: 1, failed: 1, free_subdomain: 3, custom_cname: 2 }],
      error: null,
    });

    const { app, env } = createAuthenticatedApp({
      userId: 'user-1',
      orgId: 'org-1',
    });

    const res = await makeRequest(app, env, '/api/admin/domains/summary');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty('total');
    expect(body.data).toHaveProperty('by_status');
    expect(body.data).toHaveProperty('by_type');
  });
});
