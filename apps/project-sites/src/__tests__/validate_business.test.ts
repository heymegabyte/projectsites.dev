/**
 * Unit tests for the POST /api/validate-business endpoint.
 * Tests AI-powered business data validation.
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

// ─── Helpers ─────────────────────────────────────────────────

const createMockEnv = (): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    SENDGRID_API_KEY: 'test-sendgrid-key',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    STRIPE_SECRET_KEY: 'test-stripe-key',
    STRIPE_WEBHOOK_SECRET: 'test-stripe-webhook',
    AI: {
      run: jest.fn(),
    },
  }) as unknown as Env;

function createAuthApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('userId', 'user-123');
    c.set('orgId', 'org-456');
    c.set('requestId', 'req-789');
    await next();
  });
  app.route('/', api);
  return { app, env: createMockEnv() };
}

function createUnauthApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', api);
  return { app, env: createMockEnv() };
}

// ─── Tests ──────────────────────────────────────────────────

describe('POST /api/validate-business', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const { app, env } = createUnauthApp();
    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Business' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns invalid for too-short business name', async () => {
    const { app, env } = createAuthApp();
    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.data.valid).toBe(false);
    expect(d.data.reason).toContain('too short');
  });

  it('returns invalid for too-long business name', async () => {
    const { app, env } = createAuthApp();
    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(201) }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.data.valid).toBe(false);
    expect(d.data.reason).toContain('too long');
  });

  it('returns 400 for missing name', async () => {
    const { app, env } = createAuthApp();
    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns valid when AI says valid', async () => {
    const { app, env } = createAuthApp();
    (env as unknown as { AI: { run: jest.Mock } }).AI.run.mockResolvedValueOnce({
      response: '{"valid": true}',
    });

    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp', address: '123 Main St' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.data.valid).toBe(true);
  });

  it('returns invalid with reason when AI says invalid', async () => {
    const { app, env } = createAuthApp();
    (env as unknown as { AI: { run: jest.Mock } }).AI.run.mockResolvedValueOnce({
      response: '{"valid": false, "reason": "Business name appears to be nonsensical"}',
    });

    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'asdfgh', address: '123 Fake St' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.data.valid).toBe(false);
    expect(d.data.reason).toContain('nonsensical');
  });

  it('returns valid when AI fails (graceful degradation)', async () => {
    const { app, env } = createAuthApp();
    (env as unknown as { AI: { run: jest.Mock } }).AI.run.mockRejectedValueOnce(
      new Error('AI service unavailable'),
    );

    const res = await app.request(
      'http://localhost/api/validate-business',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Corp' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.data.valid).toBe(true);
  });
});
