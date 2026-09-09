/**
 * Unit tests for POST /api/sites/:id/reset (re-crawl & rebuild).
 *
 * Covers:
 *   - 401 when not authenticated
 *   - 404 when site not found / not owned
 *   - 200 with building status on success
 *   - Empty/malformed body handled gracefully
 *   - Workflow trigger when SITE_WORKFLOW binding is available
 *   - Workflow creation failure handled gracefully
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
import { dbQueryOne } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockWriteAuditLog = writeAuditLog as jest.Mock;

// ─── Helpers ─────────────────────────────────────────────────

const TEST_SITE_ID = 'site-reset-123';
const TEST_ORG_ID = 'org-reset-456';

const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          run: jest.fn().mockResolvedValue({ success: true }),
        }),
      }),
    } as unknown as D1Database,
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
    c.set('requestId', 'req-reset-1');
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

// ─── Setup / Teardown ────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Mock global fetch for any external calls
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

// ─── POST /api/sites/:id/reset Tests ─────────────────────────

describe('POST /api/sites/:id/reset', () => {
  it('returns 401 when not authenticated', async () => {
    const { app, env } = createUnauthenticatedApp();
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when site not found', async () => {
    const { app, env } = createAuthenticatedApp();
    // dbQueryOne returns null → site not found
    mockDbQueryOne.mockResolvedValueOnce(null);
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with building status on success', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business: { name: 'My Biz', address: '123 Main St' },
          additional_context: 'Open late on weekends',
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.site_id).toBe(TEST_SITE_ID);
    expect(body.data.slug).toBe('my-biz');
    expect(body.data.status).toBe('building');
    // No workflow binding → workflow_instance_id should be null
    expect(body.data.workflow_instance_id).toBeNull();
  });

  it('handles empty body gracefully (no crash)', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    // Send request with no body at all
    const res = await app.request(`/api/sites/${TEST_SITE_ID}/reset`, { method: 'POST' }, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('building');
    expect(body.data.site_id).toBe(TEST_SITE_ID);
  });

  it('triggers workflow when SITE_WORKFLOW binding is available', async () => {
    const mockCreate = jest.fn().mockResolvedValue({ id: 'wf-reset-1' });
    const mockWorkflow = { create: mockCreate };

    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });

    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business: { name: 'My Biz', address: '123 Main St' },
          additional_context: 'We have 5-star reviews',
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.workflow_instance_id).toBe('wf-reset-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Verify the workflow was called with expected params
    const createArgs = mockCreate.mock.calls[0][0];
    expect(createArgs.id).toBe(TEST_SITE_ID);
    expect(createArgs.params.siteId).toBe(TEST_SITE_ID);
    expect(createArgs.params.slug).toBe('my-biz');
    expect(createArgs.params.businessName).toBe('My Biz');
    expect(createArgs.params.businessAddress).toBe('123 Main St');
    expect(createArgs.params.additionalContext).toBe('We have 5-star reviews');
    expect(createArgs.params.isReset).toBe(true);
    expect(createArgs.params.orgId).toBe(TEST_ORG_ID);
  });

  it('handles workflow creation failure gracefully', async () => {
    // First create call fails (duplicate ID), second also fails
    const mockCreate = jest
      .fn()
      .mockRejectedValueOnce(new Error('Instance already exists'))
      .mockRejectedValueOnce(new Error('Workflow unavailable'));

    const mockWorkflow = { create: mockCreate };

    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });

    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business: { name: 'My Biz' } }),
      },
      env,
    );

    // Should still return 200 even when workflow fails
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('building');
    // Workflow failed both attempts → null
    expect(body.data.workflow_instance_id).toBeNull();
    // Both the initial create and the retry were attempted
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries workflow creation with a unique suffix when first attempt fails', async () => {
    // First create call fails, second succeeds with the reset-suffixed ID
    const mockCreate = jest
      .fn()
      .mockRejectedValueOnce(new Error('Instance already exists'))
      .mockResolvedValueOnce({ id: `${TEST_SITE_ID}-reset-12345` });

    const mockWorkflow = { create: mockCreate };

    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });

    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // The retry succeeded and returned a suffixed instance ID
    expect(body.data.workflow_instance_id).toBe(`${TEST_SITE_ID}-reset-12345`);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Verify the retry used a suffixed ID and includes orgId
    const retryArgs = mockCreate.mock.calls[1][0];
    expect(retryArgs.id).toMatch(new RegExp(`^${TEST_SITE_ID}-reset-\\d+$`));
    expect(retryArgs.params.orgId).toBe(TEST_ORG_ID);
  });

  it('accepts the v1 FLAT business_name (normalized — the journey defect where flat resets kept stale names)', async () => {
    const mockCreate = jest.fn().mockResolvedValue({ id: 'wf-flat-1' });
    const mockWorkflow = { create: mockCreate };
    const { app, env } = createAuthenticatedApp({
      SITE_WORKFLOW: mockWorkflow as unknown as Env['SITE_WORKFLOW'],
    });
    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
      business_name: 'Old Name',
    });

    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_name: 'New Name', business_address: '1 Flat St' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const createArgs = mockCreate.mock.calls[0][0];
    expect(createArgs.params.businessName).withContext?.(
      'flat business_name must reach the workflow',
    ) ?? expect(createArgs.params.businessName).toBe('New Name');
  });

  it('writes audit log on successful reset', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business: { name: 'Biz' } }),
      },
      env,
    );

    // Audit log should have been called with action 'site.reset'
    const resetCall = mockWriteAuditLog.mock.calls.find(
      (call: unknown[]) => (call[1] as { action: string }).action === 'site.reset',
    );
    expect(resetCall).toBeDefined();
    expect(resetCall![1].target_id).toBe(TEST_SITE_ID);
    expect(resetCall![1].metadata_json.slug).toBe('my-biz');
  });

  it('handles malformed JSON body gracefully', async () => {
    const { app, env } = createAuthenticatedApp();
    mockDbQueryOne.mockResolvedValueOnce({
      id: TEST_SITE_ID,
      slug: 'my-biz',
      org_id: TEST_ORG_ID,
    });

    // Send invalid JSON
    const res = await app.request(
      `/api/sites/${TEST_SITE_ID}/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      },
      env,
    );

    // The endpoint catches JSON parse errors and proceeds with defaults
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('building');
    expect(body.data.site_id).toBe(TEST_SITE_ID);
  });
});
