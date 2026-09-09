/**
 * Unit tests for the GET /api/slug/check endpoint.
 * Tests slug validation and availability checking.
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
import { dbQueryOne } from '../services/db.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;

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

describe('GET /api/slug/check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns available=true for a unique slug', async () => {
    const { app, env } = createAuthApp();
    mockDbQueryOne.mockResolvedValueOnce(null); // No existing site

    const res = await app.request(
      'http://localhost/api/slug/check?slug=my-business',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.available).toBe(true);
    expect(json.data.slug).toBe('my-business');
    expect(json.data.reason).toBeNull();
  });

  it('returns available=false for a taken slug', async () => {
    const { app, env } = createAuthApp();
    mockDbQueryOne.mockResolvedValueOnce({ id: 'existing-id' });

    const res = await app.request(
      'http://localhost/api/slug/check?slug=taken-slug',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('Slug is already taken');
  });

  it('returns available=false for empty slug', async () => {
    const { app, env } = createAuthApp();

    const res = await app.request('http://localhost/api/slug/check?slug=', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('Slug is required');
  });

  it('returns available=false for slug with only 1 or 2 characters', async () => {
    const { app, env } = createAuthApp();

    const res1 = await app.request(
      'http://localhost/api/slug/check?slug=a',
      { method: 'GET' },
      env,
    );
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.data.available).toBe(false);
    expect(json1.data.reason).toContain('at least 3 characters');

    const res2 = await app.request(
      'http://localhost/api/slug/check?slug=ab',
      { method: 'GET' },
      env,
    );
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.data.available).toBe(false);
    expect(json2.data.reason).toContain('at least 3 characters');
  });

  it('normalizes slugs (uppercase, special chars)', async () => {
    const { app, env } = createAuthApp();
    mockDbQueryOne.mockResolvedValueOnce(null);

    const res = await app.request(
      'http://localhost/api/slug/check?slug=My%20Business%20Name!',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.slug).toBe('my-business-name');
    expect(json.data.available).toBe(true);
  });

  it('excludes a site by exclude_id parameter', async () => {
    const { app, env } = createAuthApp();
    mockDbQueryOne.mockResolvedValueOnce(null);

    const res = await app.request(
      'http://localhost/api/slug/check?slug=my-slug&exclude_id=site-abc',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.available).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const { app, env } = createUnauthApp();

    const res = await app.request(
      'http://localhost/api/slug/check?slug=test',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(401);
  });

  it('handles missing slug param gracefully', async () => {
    const { app, env } = createAuthApp();

    const res = await app.request('http://localhost/api/slug/check', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('Slug is required');
  });
});
