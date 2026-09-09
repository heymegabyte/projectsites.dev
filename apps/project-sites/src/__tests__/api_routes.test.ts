/**
 * Functional / integration tests for API routes.
 * Mounts the full route tree and tests multi-step flows.
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

// #121: the contact handler MX-pre-checks the submitter domain before sending the
// receipt. Stub deliverable=true so these integration tests exercise both emails
// (the real DoH lookup is covered in email_deliverability.test.ts).
jest.mock('../services/email_deliverability.js', () => ({
  hasDeliverableMx: jest.fn(async () => true),
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
import { feedback } from '../../libs/features/feedback/handlers.js';
import { dbQueryOne, dbExecute, dbInsert } from '../services/db.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockDbExecute = dbExecute as unknown as jest.Mock;
const mockDbInsert = dbInsert as unknown as jest.Mock;

const originalFetch = global.fetch;
let mockFetch: jest.Mock;

const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    // Resend removed 2026-09-09 (Brian directive); SendGrid is the break-glass rail.
    SENDGRID_API_KEY: 'test-sendgrid-key',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    STRIPE_SECRET_KEY: 'test-stripe-key',
    STRIPE_WEBHOOK_SECRET: 'test-stripe-webhook',
    ...overrides,
  }) as unknown as Env;

function createApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', feedback);
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

function createAuthenticatedApp(vars: Partial<Variables> = {}, envOverrides: Partial<Env> = {}) {
  const authedApp = new Hono<{ Bindings: Env; Variables: Variables }>();
  authedApp.onError(errorHandler);
  authedApp.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  authedApp.route('/', feedback);
  authedApp.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app: authedApp, env };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
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

// ─── Contact Form Routes ────────────────────────────────────

describe('POST /api/contact', () => {
  it('returns 200 with success for valid contact form', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jane Doe',
        email: 'jane@example.com',
        message: 'Hello, I have a question about your platform.',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);
    // Should have made 2 fetch calls (notification + confirmation emails)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns 400 for missing email', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        message: 'This is a test message.',
      }),
    });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for XSS in message', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        email: 'bob@test.com',
        message: 'Hello <script>alert("xss")</script> world',
      }),
    });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for message too short', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        email: 'bob@test.com',
        message: 'Short',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('handles email provider failure gracefully', async () => {
    mockFetch.mockResolvedValue(new Response('error', { status: 500 }));
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        email: 'bob@test.com',
        message: 'Testing email provider failure scenario.',
      }),
    });

    // Both email rails fail, but the lead was persisted to the contacts table
    // first → the visitor still succeeds. Email-only used to 400 here and LOSE
    // the lead; persistence makes an email outage non-fatal.
    expect(res.status).toBe(200);
  });

  it('delivers via SendGrid (SES unconfigured) and never touches Resend', async () => {
    // Resend removed 2026-09-09 (Brian directive). With no SES creds, sendEmail
    // routes through the SendGrid break-glass rail; Resend must never be called.
    mockFetch.mockResolvedValue(new Response('', { status: 202 })); // SendGrid accepts every send

    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jane',
        email: 'jane@test.com',
        message: 'Testing the SendGrid delivery rail.',
      }),
    });

    expect(res.status).toBe(200);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('api.sendgrid.com'))).toBe(true); // SendGrid delivered
    expect(urls.every((u) => !u.includes('api.resend.com'))).toBe(true); // Resend never used
  });

  it('still succeeds when no email provider is configured (lead persisted to D1)', async () => {
    const { app, env } = createApp({
      SENDGRID_API_KEY: undefined,
    } as any);

    const res = await makeRequest(app, env, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        email: 'bob@test.com',
        message: 'Testing no email providers.',
      }),
    });

    // Email absence no longer loses the lead (was: 400 'Email delivery is not
    // configured'). The contacts row is written first, so the visitor succeeds.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);
  });
});

// ─── Auth Routes (unauthenticated) ──────────────────────────

describe('POST /api/auth/magic-link', () => {
  it('returns 400 for missing email', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/auth/me ───────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns 401 when not authenticated', async () => {
    const { app, env } = createApp();

    const res = await makeRequest(app, env, '/api/auth/me');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns user info (incl. the real org_name) when authenticated', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({ email: 'alice@example.com', display_name: 'Alice' }) // user row
      .mockResolvedValueOnce({ name: 'Acme Corp' }); // org row → labels org-scoped surfaces

    const { app, env } = createAuthenticatedApp({
      userId: 'user-123',
      orgId: 'org-456',
    });

    const res = await makeRequest(app, env, '/api/auth/me');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      user_id: 'user-123',
      org_id: 'org-456',
      org_name: 'Acme Corp',
      email: 'alice@example.com',
      display_name: 'Alice',
      is_super_admin: false,
    });
  });

  it('fail-soft: a missing org row leaves org_name null (never blocks /me)', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({ email: 'alice@example.com', display_name: 'Alice' }) // user row
      .mockResolvedValueOnce(null); // org row absent

    const { app, env } = createAuthenticatedApp({ userId: 'user-123', orgId: 'org-456' });

    const res = await makeRequest(app, env, '/api/auth/me');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.org_name).toBeNull();
    expect(body.data.org_id).toBe('org-456');
  });

  it('returns 401 when user not found in DB', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    const { app, env } = createAuthenticatedApp({
      userId: 'deleted-user',
      orgId: 'org-456',
    });

    const res = await makeRequest(app, env, '/api/auth/me');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  // Consistency with the server gate `isSuperAdmin()`: an operator on the email
  // allowlist must report is_super_admin:true even when the column is unset —
  // otherwise the route gates admit them but the super-admin UI stays hidden.
  it('reports is_super_admin:true for an allowlist operator with column unset', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      email: 'Hey@Megabyte.Space', // mixed-case → exercises trim().toLowerCase()
      display_name: 'Brian',
      is_super_admin: 0,
    });

    const { app, env } = createAuthenticatedApp({ userId: 'op-1', orgId: 'org-1' });
    const res = await makeRequest(app, env, '/api/auth/me');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.is_super_admin).toBe(true);
  });

  it('reports is_super_admin:true via the column for a non-allowlist user', async () => {
    mockDbQueryOne.mockResolvedValueOnce({
      email: 'staff@example.com',
      display_name: 'Staff',
      is_super_admin: 1,
    });

    const { app, env } = createAuthenticatedApp({ userId: 'op-2', orgId: 'org-1' });
    const res = await makeRequest(app, env, '/api/auth/me');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.is_super_admin).toBe(true);
  });
});

describe('PATCH /api/admin/profile (self display-name edit)', () => {
  const patch = (name: string) => ({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  it('updates the display name and returns it on success', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: null, changes: 1 });
    const { app, env } = createAuthenticatedApp({ userId: 'user-1', requestId: 'req-1' });
    const res = await makeRequest(app, env, '/api/admin/profile', patch('New Name'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { display_name: 'New Name' } });
  });

  it('returns 404 (not a lying save) when the account row is gone (changes===0)', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: null, changes: 0 });
    const { app, env } = createAuthenticatedApp({ userId: 'user-1', requestId: 'req-1' });
    const res = await makeRequest(app, env, '/api/admin/profile', patch('New Name'));
    expect(res.status).toBe(404);
  });

  it('returns 500 (never a lying save) when the UPDATE errors', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    const { app, env } = createAuthenticatedApp({ userId: 'user-1', requestId: 'req-1' });
    const res = await makeRequest(app, env, '/api/admin/profile', patch('New Name'));
    expect(res.status).toBe(500);
  });
});

// ─── Feedback ingestion ─────────────────────────────────────
// `dbInsert` returns { error } and never throws, so the handler's try/catch is
// dead for a write failure — a bare await returned a lying 201 while the
// feedback row silently dropped. It must surface an honest 500 instead.
describe('POST /api/feedback', () => {
  const submit = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('persists valid feedback → 201 submitted', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(
      app,
      env,
      '/api/feedback',
      submit({ rating: 5, comment: 'Build was great.', page_url: '/site/x' }),
    );
    expect(res.status).toBe(201);
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    expect(mockDbInsert.mock.calls[0][1]).toBe('feedback');
    const body = (await res.json()) as { data: { submitted: boolean } };
    expect(body.data.submitted).toBe(true);
  });

  it('returns 500 (NOT a lying 201) when the feedback row drops', async () => {
    mockDbInsert.mockResolvedValueOnce({ error: 'D1_ERROR: disk I/O' });
    const { app, env } = createApp();
    const res = await makeRequest(
      app,
      env,
      '/api/feedback',
      submit({ rating: 4, comment: 'Dropped write must not lie.', page_url: '/site/y' }),
    );
    expect(res.status).toBe(500);
  });

  it('rejects an out-of-range rating with 400 before any write', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, '/api/feedback', submit({ rating: 9 }));
    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});
