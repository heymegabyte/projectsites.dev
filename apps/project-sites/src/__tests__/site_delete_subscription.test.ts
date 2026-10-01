/**
 * Tests for DELETE /api/sites/:id — enhanced with subscription cancellation.
 *
 * The endpoint:
 * 1. Accepts optional JSON body: { cancel_subscription: boolean }
 * 2. Soft-deletes the site (UPDATE sites SET deleted_at, status='archived')
 * 3. Invalidates KV cache for the site's subdomain
 * 4. If cancel_subscription=true and site.plan='paid', cancels via Stripe API
 * 5. Writes an audit log with subscription_canceled metadata
 * 6. Returns { data: { deleted: true, subscription_canceled: boolean } }
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
  getAuditLogs: jest.fn().mockResolvedValue({ data: [] }),
  getSiteAuditLogs: jest.fn().mockResolvedValue({ data: [] }),
}));

jest.mock('../lib/posthog.js', () => ({
  capture: jest.fn(),
  trackAuth: jest.fn(),
  trackSite: jest.fn(),
  trackError: jest.fn(),
}));

// Full-teardown purge is awaited by the DELETE handler when the owner opts in with
// `purge_resources: true`. Stub it so the destructive-opt-in tests can assert the
// handler echoes the real purged count back to the caller (not a silent no-op).
const mockPurgeSiteResources = jest.fn();
jest.mock('../services/site_purge.js', () => ({
  purgeSiteResources: (...a: unknown[]) => mockPurgeSiteResources(...a),
}));

// WfP teardown is fire-and-forget off the response path; stub it so it can't reach CF.
jest.mock('../services/wfp_site_hosting.js', () => ({
  teardownSiteWfp: jest.fn().mockResolvedValue({
    attempted: false,
    slotsDeleted: 0,
    registryCleared: 0,
  }),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { api } from '../routes/api.js';
import { dbQueryOne } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockWriteAuditLog = writeAuditLog as jest.Mock;

const originalFetch = global.fetch;
let mockFetch: jest.Mock;

// ── Helpers ──────────────────────────────────────────────────

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    CACHE_KV: { delete: jest.fn().mockResolvedValue(undefined) } as unknown as KVNamespace,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    SENDGRID_API_KEY: 'test-sendgrid-key',
    ...overrides,
  } as unknown as Env;
}

/**
 * Creates an authenticated Hono app with the given user/org context variables.
 * Mounts the api routes and the error handler.
 */
function createAuthenticatedApp(vars: Partial<Variables> = {}, envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app, env };
}

/**
 * Creates an unauthenticated Hono app (no userId/orgId set).
 */
function createUnauthenticatedApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app, env };
}

function makeDelete(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  env: Env,
  siteId: string,
  body?: Record<string, unknown>,
) {
  const init: RequestInit = { method: 'DELETE' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return app.request(`/api/sites/${siteId}`, init, env);
}

// ── Mock D1 prepare().bind().run() helper ────────────────────

function createMockD1() {
  const runFn = jest.fn().mockResolvedValue({});
  const allFn = jest.fn().mockResolvedValue({ results: [] });
  const bindFn = jest.fn().mockReturnValue({ run: runFn, all: allFn });
  const prepareFn = jest.fn().mockReturnValue({ bind: bindFn });
  return { prepare: prepareFn, bind: bindFn, run: runFn, all: allFn } as unknown as D1Database & {
    prepare: jest.Mock;
    bind: jest.Mock;
    run: jest.Mock;
  };
}

// ── Setup / Teardown ─────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockPurgeSiteResources.mockResolvedValue({
    attempted: true,
    r2VersionObjectsDeleted: 3,
    dedicatedD1: 'deleted',
    dedicatedKv: 'deleted',
    dedicatedBuckets: [{ bucket: 'ps-site-x-uploads', ok: true }],
    wfp: { attempted: true, slotsDeleted: 2, registryCleared: 2 },
    allocationRetired: true,
    registryRetired: 1,
    hostnamesRetired: 1,
    hostKeyCleared: true,
    slugFreed: 'test-biz--purged-abc',
  });
  mockFetch = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'mock-id' }), {
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

// ── Tests ────────────────────────────────────────────────────

describe('DELETE /api/sites/:id', () => {
  const siteId = 'site-uuid-001';
  const orgId = 'org-uuid-001';
  const userId = 'user-uuid-001';

  it('deletes a site without canceling subscription (cancel_subscription=false)', async () => {
    const mockDb = createMockD1();

    // First dbQueryOne: SELECT site → found
    mockDbQueryOne.mockResolvedValueOnce({
      id: siteId,
      slug: 'test-biz',
      plan: 'paid',
    });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-1' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDelete(app, env, siteId, { cancel_subscription: false });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      deleted: true,
      subscription_canceled: false,
      archived: true,
      purged: false,
    });

    // Site should be soft-deleted via raw DB prepare
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sites SET deleted_at'),
    );

    // Stripe API should NOT be called
    expect(mockFetch).not.toHaveBeenCalled();

    // Audit log should be written
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        org_id: orgId,
        action: 'site.deleted',
        target_type: 'site',
        target_id: siteId,
        metadata_json: expect.objectContaining({
          subscription_canceled: false,
        }),
      }),
    );
  });

  it('deletes a paid site with cancel_subscription=true — triggers Stripe API call', async () => {
    const mockDb = createMockD1();

    // First dbQueryOne: SELECT site → found, plan=paid
    mockDbQueryOne
      .mockResolvedValueOnce({
        id: siteId,
        slug: 'paid-biz',
        plan: 'paid',
      })
      // Second dbQueryOne: SELECT subscription → has stripe_subscription_id
      .mockResolvedValueOnce({
        stripe_subscription_id: 'sub_stripe_123',
      });

    // Stripe cancellation succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'sub_stripe_123', cancel_at_period_end: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-2' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDelete(app, env, siteId, { cancel_subscription: true });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      deleted: true,
      subscription_canceled: true,
      archived: true,
      purged: false,
    });

    // Stripe API should have been called with correct URL and body
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/subscriptions/sub_stripe_123',
      expect.objectContaining({
        method: 'POST',
        body: 'cancel_at_period_end=true',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );

    // Verify Authorization header uses Basic auth with Stripe secret
    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Basic /);
  });

  it('deletes a free site with cancel_subscription=true — no Stripe call made', async () => {
    const mockDb = createMockD1();

    // First dbQueryOne: SELECT site → found, plan=free (not 'paid')
    mockDbQueryOne.mockResolvedValueOnce({
      id: siteId,
      slug: 'free-biz',
      plan: 'free',
    });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-3' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDelete(app, env, siteId, { cancel_subscription: true });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      deleted: true,
      subscription_canceled: false,
      archived: true,
      purged: false,
    });

    // Stripe should NOT be called for a free site
    expect(mockFetch).not.toHaveBeenCalled();

    // Site should still be soft-deleted
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sites SET deleted_at'),
    );
  });

  it('returns 404 for non-existent site', async () => {
    const mockDb = createMockD1();

    // dbQueryOne: SELECT site → not found
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-4' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDelete(app, env, 'nonexistent-site-id', { cancel_subscription: false });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('Site not found');

    // No soft-delete or Stripe call should happen
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it('returns 401 without authentication', async () => {
    const mockDb = createMockD1();

    const { app, env } = createUnauthenticatedApp({
      DB: mockDb as unknown as D1Database,
    });

    const res = await makeDelete(app, env, siteId, { cancel_subscription: false });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');

    // Nothing should happen
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it('handles Stripe API failure gracefully (site still deleted)', async () => {
    const mockDb = createMockD1();

    // Site exists with paid plan
    mockDbQueryOne
      .mockResolvedValueOnce({
        id: siteId,
        slug: 'paid-failing',
        plan: 'paid',
      })
      // Subscription lookup returns a subscription ID
      .mockResolvedValueOnce({
        stripe_subscription_id: 'sub_stripe_fail',
      });

    // Stripe API fails
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-6' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDelete(app, env, siteId, { cancel_subscription: true });

    // Site should still be deleted successfully
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
    // subscription_canceled should be false because Stripe call failed
    expect(body.data.subscription_canceled).toBe(false);

    // Soft-delete should still have happened
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sites SET deleted_at'),
    );

    // Audit log should still be written
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'site.deleted',
        metadata_json: expect.objectContaining({
          subscription_canceled: false,
        }),
      }),
    );
  });

  it('handles missing request body gracefully', async () => {
    const mockDb = createMockD1();

    // Site exists
    mockDbQueryOne.mockResolvedValueOnce({
      id: siteId,
      slug: 'no-body-biz',
      plan: 'free',
    });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-7' },
      { DB: mockDb as unknown as D1Database },
    );

    // Send DELETE with no body at all
    const res = await app.request(`/api/sites/${siteId}`, { method: 'DELETE' }, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      deleted: true,
      subscription_canceled: false,
      archived: true,
      purged: false,
    });

    // No Stripe call (cancel_subscription defaults to false)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('audit log includes subscription_canceled field', async () => {
    const mockDb = createMockD1();

    // Paid site
    mockDbQueryOne
      .mockResolvedValueOnce({
        id: siteId,
        slug: 'audit-check',
        plan: 'paid',
      })
      // Subscription exists
      .mockResolvedValueOnce({
        stripe_subscription_id: 'sub_stripe_audit',
      });

    // Stripe cancellation succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'sub_stripe_audit' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-8' },
      { DB: mockDb as unknown as D1Database },
    );

    await makeDelete(app, env, siteId, { cancel_subscription: true });

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = mockWriteAuditLog.mock.calls[0][1];

    expect(auditCall.action).toBe('site.deleted');
    expect(auditCall.target_type).toBe('site');
    expect(auditCall.target_id).toBe(siteId);
    expect(auditCall.org_id).toBe(orgId);
    expect(auditCall.metadata_json).toEqual(
      expect.objectContaining({
        site_id: siteId,
        slug: 'audit-check',
        subscription_canceled: true,
      }),
    );
  });
});

/**
 * Destructive-opt-in integrity (BACKLOG Frontier-0 "Destructive-opt-in silent downgrade").
 *
 * The `purge_resources: true` opt-in triggers an IRREVERSIBLE full teardown. The prior
 * contract read the body with `.catch(() => ({}))`, so a lost/garbled/non-object body
 * silently became `{}` → `purge_resources` undefined → `false` → the purge was skipped
 * while the DELETE still returned 200. A destructive action must FAIL LOUD on a body it
 * can't parse (400), never silently downgrade to a no-op — and a successful purge must
 * echo the purged count so a caller can ASSERT the effect happened.
 */
describe('DELETE /api/sites/:id — destructive purge_resources opt-in', () => {
  const siteId = 'site-uuid-900';
  const orgId = 'org-uuid-900';
  const userId = 'user-uuid-900';

  /** DELETE with a raw (possibly non-JSON) body string the caller fully controls. */
  function makeDeleteRaw(
    app: Hono<{ Bindings: Env; Variables: Variables }>,
    env: Env,
    id: string,
    rawBody: string,
  ) {
    return app.request(
      `/api/sites/${id}`,
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: rawBody },
      env,
    );
  }

  it('(a) FAILS LOUD with 400 on a malformed/garbled body — never a 200 silent no-op', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'purge-biz', plan: 'free' });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-purge-malformed' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDeleteRaw(app, env, siteId, 'not-json{bad');

    // The silent-downgrade bug returned 200 here; the destructive action must reject.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');

    // And it must NOT have run the destructive purge nor the soft-delete on a garbled body.
    expect(mockPurgeSiteResources).not.toHaveBeenCalled();
    expect(mockDb.prepare).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sites SET deleted_at'),
    );
  });

  it('(a2) FAILS LOUD with 400 when the body is valid JSON but not an object', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'purge-biz', plan: 'free' });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-purge-nonobject' },
      { DB: mockDb as unknown as D1Database },
    );

    // `"true"` parses to a boolean — reading `.purge_resources` off it would throw or
    // coerce to undefined, the exact ambiguity a destructive flag must never swallow.
    const res = await makeDeleteRaw(app, env, siteId, 'true');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(mockPurgeSiteResources).not.toHaveBeenCalled();
  });

  it('(b) a successful purge echoes { purged: <number> } the caller can assert', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'purge-biz', plan: 'free' });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-purge-ok' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await app.request(
      `/api/sites/${siteId}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge_resources: true }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // The destructive teardown actually ran, with the resolved owned-site identity.
    expect(mockPurgeSiteResources).toHaveBeenCalledTimes(1);
    expect(mockPurgeSiteResources).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId, siteId, slug: 'purge-biz' }),
    );

    // The caller can ASSERT the effect: a boolean `purged` + the count under `resources`.
    expect(body.data.deleted).toBe(true);
    expect(body.data.purged).toBe(true);
    // 3 R2 objects + D1 + KV + 1 bucket = 6 dedicated resources torn down.
    expect(body.data.resources.purgedCount).toBe(6);
  });

  it('(c) the valid empty-object no-op is preserved (200, no purge) — fix must not over-reject', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'purge-biz', plan: 'free' });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-purge-empty' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await makeDeleteRaw(app, env, siteId, '{}');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
    // No destructive opt-in → purged:false (boolean), no `resources` block, archived:true.
    expect(body.data.purged).toBe(false);
    expect(body.data.archived).toBe(true);
    expect(body.data.resources).toBeUndefined();
    expect(mockPurgeSiteResources).not.toHaveBeenCalled();
  });
});

/**
 * Cycle-2 — UNIFORM OUTCOME ECHO (gp-09 "destructive action must echo what it did").
 *
 * A destructive endpoint must let the caller ASSERT the outcome without parsing the
 * internal per-step summary shape. Every DELETE response therefore carries a uniform
 * `{ purged: boolean, archived: boolean, resources: {...} }` triad:
 *   - `archived` — the soft-delete always ran (true on every success).
 *   - `purged`   — true ONLY when a destructive teardown was intended AND attempted
 *                  (i.e. `purge_resources: true` AND the purge was not refused).
 *   - `resources` — the per-step outcome map, so a caller can inspect what fell.
 *
 * The prior echo exposed a bare `purged: <number>` count (ambiguous — 0 reads the same
 * whether no teardown was requested or a requested teardown no-op'd) and no boolean the
 * caller could branch on. These tests pin the asserable triad.
 */
describe('DELETE /api/sites/:id — uniform outcome echo { purged, archived, resources }', () => {
  const siteId = 'site-uuid-901';
  const orgId = 'org-uuid-901';
  const userId = 'user-uuid-901';

  it('(d) destructive success echoes purged:true + archived:true + resources{} the caller can assert', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'echo-biz', plan: 'free' });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-echo-ok' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await app.request(
      `/api/sites/${siteId}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge_resources: true }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // Uniform asserable triad — booleans the caller branches on, no count parsing.
    expect(body.data.archived).toBe(true);
    expect(body.data.purged).toBe(true);
    expect(body.data.resources).toEqual(
      expect.objectContaining({
        r2VersionObjectsDeleted: 3,
        dedicatedD1: 'deleted',
        dedicatedKv: 'deleted',
      }),
    );
  });

  it('(e) plain archive (no destructive flag) echoes purged:false + archived:true', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'echo-biz', plan: 'free' });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-echo-archive' },
      { DB: mockDb as unknown as D1Database },
    );

    // No body at all → legitimate soft-delete, no destructive opt-in.
    const res = await app.request(`/api/sites/${siteId}`, { method: 'DELETE' }, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.archived).toBe(true);
    expect(body.data.purged).toBe(false);
    expect(mockPurgeSiteResources).not.toHaveBeenCalled();
  });

  it('(f) destructive flag but purge REFUSED (attempted:false) echoes purged:false — no false claim', async () => {
    const mockDb = createMockD1();
    mockDbQueryOne.mockResolvedValueOnce({ id: siteId, slug: 'echo-biz', plan: 'free' });

    // The purge refuses (e.g. nothing dedicated to tear down / already clean): attempted:false.
    mockPurgeSiteResources.mockResolvedValueOnce({
      attempted: false,
      refusedReason: 'not_deleted',
      r2VersionObjectsDeleted: 0,
      dedicatedD1: 'skipped_absent',
      dedicatedKv: 'skipped_absent',
      dedicatedBuckets: [],
      wfp: { attempted: false, slotsDeleted: 0, registryCleared: 0 },
      allocationRetired: false,
      registryRetired: 0,
      hostnamesRetired: 0,
      hostKeyCleared: false,
      slugFreed: null,
    });

    const { app, env } = createAuthenticatedApp(
      { userId, orgId, requestId: 'req-echo-refused' },
      { DB: mockDb as unknown as D1Database },
    );

    const res = await app.request(
      `/api/sites/${siteId}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge_resources: true }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // The purge was attempted but refused — the echo must NOT claim purged:true.
    expect(body.data.archived).toBe(true);
    expect(body.data.purged).toBe(false);
    // resources still present so the caller can see WHY (refusedReason).
    expect(body.data.resources).toEqual(
      expect.objectContaining({ attempted: false, refusedReason: 'not_deleted' }),
    );
  });
});
