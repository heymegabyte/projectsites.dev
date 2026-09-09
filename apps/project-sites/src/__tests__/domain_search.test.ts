/**
 * Unit tests for domain search and workflow status API routes:
 *   - GET /api/domains/search (domain availability search)
 *   - GET /api/sites/:id/workflow (workflow status with audit logs)
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
import { domains } from '../../libs/features/domains/handlers.js';
import { dbQueryOne } from '../services/db.js';
import { getSiteAuditLogs } from '../services/audit.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockGetSiteAuditLogs = getSiteAuditLogs as jest.Mock;

// ─── Helpers ─────────────────────────────────────────────────

const TEST_SITE_ID = 'site-test-123';
const TEST_ORG_ID = 'org-456';

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
    CF_API_TOKEN: 'test-cf-token',
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
  authedApp.route('/', domains);
  authedApp.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app: authedApp, env };
}

function createUnauthenticatedApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', domains);
  app.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app, env };
}

// ─── Setup / Teardown ────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Mock global fetch for Cloudflare API calls
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: jest.fn().mockResolvedValue({}),
    text: jest.fn().mockResolvedValue(''),
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

// ─── Domain Search Tests ────────────────────────────────────

describe('GET /api/domains/search', () => {
  it('returns fallback results for query shorter than 2 chars', async () => {
    const { app, env } = createAuthenticatedApp();
    const res = await app.request('/api/domains/search?q=a', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('returns empty array for missing query', async () => {
    const { app, env } = createAuthenticatedApp();
    const res = await app.request('/api/domains/search', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('returns empty array for query exceeding 63 chars', async () => {
    const { app, env } = createAuthenticatedApp();
    const longQuery = 'a'.repeat(64);
    const res = await app.request(`/api/domains/search?q=${longQuery}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('sanitizes special characters from query', async () => {
    const { app, env } = createAuthenticatedApp();
    const res = await app.request('/api/domains/search?q=test<script>alert(1)</script>', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should not contain any script tags in results
    for (const r of body.data) {
      expect(r.domain).not.toContain('<');
      expect(r.domain).not.toContain('>');
    }
  });

  it('returns TLD variants when no dots in query', async () => {
    const { app, env } = createAuthenticatedApp();
    const res = await app.request('/api/domains/search?q=testbusiness', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    // Should include common TLDs
    const domains = body.data.map((d: { domain: string }) => d.domain);
    expect(domains).toContain('testbusiness.com');
    expect(domains).toContain('testbusiness.net');
  });

  it('surfaces status:"unknown" + a SEARCH_PROVIDER_UNAVAILABLE _error when RDAP fails for ALL candidates (not a lying "all taken")', async () => {
    // The default beforeEach fetch mock returns { ok:false, status:500 } → every RDAP
    // probe resolves to status:'unknown' (the total-outage case).
    const { app, env } = createAuthenticatedApp();
    const res = await app.request('/api/domains/search?q=testbusiness', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const d of body.data as Array<{ status: string; available: boolean }>) {
      expect(d.status).toBe('unknown'); // NOT collapsed into a misleading "taken"
      expect(d.available).toBe(false);
    }
    expect(body._error.code).toBe('SEARCH_PROVIDER_UNAVAILABLE');
    expect(body._error.status).toBe(503);
  });

  it('reports status:"available" with NO _error when RDAP returns 404 (unregistered)', async () => {
    const { app, env } = createAuthenticatedApp();
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404, // RDAP 404 → unregistered → available (not a total outage)
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue(''),
    });
    const res = await app.request('/api/domains/search?q=testbusiness', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._error).toBeUndefined();
    for (const d of body.data as Array<{ status: string; available: boolean }>) {
      expect(d.status).toBe('available');
      expect(d.available).toBe(true);
    }
  });

  it('returns fallback results as unavailable when Cloudflare API fails', async () => {
    const { app, env } = createAuthenticatedApp();
    // fetch is already mocked to fail
    const res = await app.request('/api/domains/search?q=mybusiness', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    // When the RDAP availability lookup fails, rows are marked unavailable.
    // Pricing comes from the STATIC TLD price table (cf_registrar
    // buildTldPriceMap — no network call), so `price` is a non-negative
    // estimate in cents, NOT 0. (Pricing no longer depends on the CF API.)
    for (const r of body.data) {
      expect(r).toHaveProperty('domain');
      expect(r.available).toBe(false);
      expect(typeof r.price).toBe('number');
      expect(r.price).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Workflow Status Tests ──────────────────────────────────

describe('GET /api/sites/:id/workflow', () => {
  it('returns 401 when not authenticated', async () => {
    const { app, env } = createUnauthenticatedApp();
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/workflow`, {}, env);
    expect(res.status).toBe(401);
  });

  it('returns 404 when site not found', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce(null);
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/workflow`, {}, env);
    expect(res.status).toBe(404);
  });

  it('returns workflow_available=false when no workflow binding', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce({ id: TEST_SITE_ID, status: 'building' });
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/workflow`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.workflow_available).toBe(false);
    expect(body.data.site_status).toBe('building');
  });

  it('includes recent_logs in response when available', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        action: 'workflow.step.started',
        metadata_json: JSON.stringify({
          step: 'research-profile',
          message: 'Starting profile research',
          phase: 'data_collection',
        }),
        created_at: '2026-02-19T10:00:00.000Z',
      },
      {
        id: 'log-2',
        action: 'workflow.step.complete',
        metadata_json: JSON.stringify({
          step: 'research-profile',
          message: 'Profile research complete',
          elapsed_ms: 3200,
          phase: 'data_collection',
        }),
        created_at: '2026-02-19T10:00:03.200Z',
      },
    ];

    const mockWorkflow = {
      get: jest.fn().mockReturnValue({
        id: 'wf-instance-1',
        status: jest.fn().mockResolvedValue({
          status: 'running',
          error: null,
          output: null,
        }),
      }),
    };

    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });
    mockDbQueryOne.mockResolvedValueOnce({ id: TEST_SITE_ID, status: 'building' });
    mockGetSiteAuditLogs.mockResolvedValueOnce({ data: mockLogs });

    const res = await app.request(`/api/sites/${TEST_SITE_ID}/workflow`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.workflow_status).toBe('running');
    expect(Array.isArray(body.data.recent_logs)).toBe(true);
    expect(body.data.recent_logs).toHaveLength(2);
    expect(body.data.recent_logs[0].action).toBe('workflow.step.started');
  });

  it('includes parsed metadata in recent_logs', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        action: 'workflow.step.complete',
        metadata_json: JSON.stringify({
          step: 'research-profile',
          message: 'Found business type: Barber Shop',
          elapsed_ms: 4500,
          phase: 'data_collection',
        }),
        created_at: '2026-02-19T10:00:04.500Z',
      },
    ];

    const mockWorkflow = {
      get: jest.fn().mockReturnValue({
        id: 'wf-instance-1',
        status: jest.fn().mockResolvedValue({
          status: 'running',
          error: null,
          output: null,
        }),
      }),
    };

    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });
    mockDbQueryOne.mockResolvedValueOnce({ id: TEST_SITE_ID, status: 'building' });
    mockGetSiteAuditLogs.mockResolvedValueOnce({ data: mockLogs });

    const res = await app.request(`/api/sites/${TEST_SITE_ID}/workflow`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();

    const log = body.data.recent_logs[0];
    expect(log.metadata).toBeDefined();
    expect(log.metadata.step).toBe('research-profile');
    expect(log.metadata.message).toContain('Barber Shop');
    expect(log.metadata.elapsed_ms).toBe(4500);
    expect(log.metadata.phase).toBe('data_collection');
  });

  it('honors ?instance_id= so reset-suffixed builds are reported, not the stale errored one', async () => {
    // The reset endpoint creates `{siteId}-reset-{ts}` instances when the bare
    // siteId instance already exists terminal — the status endpoint must read
    // THAT id, else it reports the stale errored instance forever (found live
    // 2026-08-19 while the fresh build was running).
    const mockWorkflow = {
      get: jest.fn().mockReturnValue({
        id: 'site-1-reset-999',
        status: jest.fn().mockResolvedValue({ status: 'running', error: null, output: null }),
      }),
    };

    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });
    mockDbQueryOne.mockResolvedValueOnce({ id: TEST_SITE_ID, status: 'building' });
    mockGetSiteAuditLogs.mockResolvedValueOnce({ data: [] });

    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/workflow?instance_id=${TEST_SITE_ID}-reset-999`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(mockWorkflow.get).toHaveBeenCalledWith(`${TEST_SITE_ID}-reset-999`);

    const body = await res.json();
    expect(body.data.instance_id).toBe('site-1-reset-999');
    expect(body.data.workflow_status).toBe('running');
  });
});
