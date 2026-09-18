/**
 * Regression: the OAuth / magic-link callbacks must resolve a RELATIVE returnUrl.
 *
 * INCIDENT (2026-09-18, req 12370f00): "Sign in with Google" returned a raw
 * `{"error":{"code":"INTERNAL_ERROR"}}` 500. Root cause — AL-678 made the sign-in page send a
 * RELATIVE returnUrl (`/api/auth/google?returnUrl=/admin`), stored verbatim in `oauth_states`,
 * but the callback did a bare `new URL(result.redirect_url)` which throws `TypeError: Invalid URL`
 * on a relative path (an absolute base is required). The throw is AFTER the friendly try/catch
 * around the token exchange → it surfaced as an unguarded 500.
 *
 * Fix: `new URL(rawRedirect, baseUrl)` at all four callback sites (google, github, magic-link ×2).
 * These tests lock the fix: a relative returnUrl 302s to the resolved absolute URL, and the
 * open-redirect allowlist STILL blocks an absolute off-domain URL (resolving against a base does
 * not weaken the defense).
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
}));

jest.mock('../services/auth.js', () => {
  const actual = jest.requireActual('../services/auth.js');
  return {
    ...actual,
    handleGoogleOAuthCallback: jest.fn(),
    findOrCreateUser: jest.fn(),
    createSession: jest.fn(),
  };
});

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { api } from '../routes/api.js';
import * as authService from '../services/auth.js';

const mockCallback = authService.handleGoogleOAuthCallback as unknown as jest.Mock;
const mockFind = authService.findOrCreateUser as unknown as jest.Mock;
const mockSession = authService.createSession as unknown as jest.Mock;

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', api);
  return app;
}
const env = {
  ENVIRONMENT: 'test',
  DB: {} as D1Database,
  GOOGLE_CLIENT_ID: 'test-google-id',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
} as unknown as Env;

// The callback calls posthog.trackAuth(c.env, c.executionCtx, …); Hono's c.executionCtx getter
// throws when the test request supplies none. Workers always provide one in prod — mock it here.
const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

beforeEach(() => {
  mockFind.mockResolvedValue({ user_id: 'u1', org_id: 'o1' });
  mockSession.mockResolvedValue({ token: 'sess-tok' });
});

describe('GET /api/auth/google/callback — relative returnUrl resolution (incident regression)', () => {
  it('302s a RELATIVE returnUrl to the resolved absolute URL (never a 500)', async () => {
    mockCallback.mockResolvedValue({
      email: 'owner@example.com',
      display_name: 'Owner',
      avatar_url: null,
      redirect_url: '/admin/billing',
    });
    const res = await buildApp().request(
      '/api/auth/google/callback?code=c&state=s',
      undefined,
      env,
      execCtx,
    );
    expect(res.status).toBe(302); // was 500 before the fix
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith('https://')).toBe(true);
    expect(loc).toContain('/admin/billing');
    expect(loc).toContain('token=sess-tok');
    expect(loc).toContain('auth_callback=google');
  });

  it('still BLOCKS an absolute off-domain returnUrl → /?error=invalid_redirect (defense intact)', async () => {
    mockCallback.mockResolvedValue({
      email: 'owner@example.com',
      display_name: null,
      avatar_url: null,
      redirect_url: 'https://evil.example.com/steal',
    });
    const res = await buildApp().request(
      '/api/auth/google/callback?code=c&state=s',
      undefined,
      env,
      execCtx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/?error=invalid_redirect');
  });

  it('302s to the homepage with the token when there is NO returnUrl', async () => {
    mockCallback.mockResolvedValue({
      email: 'owner@example.com',
      display_name: null,
      avatar_url: null,
      redirect_url: null,
    });
    const res = await buildApp().request(
      '/api/auth/google/callback?code=c&state=s',
      undefined,
      env,
      execCtx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('token=sess-tok');
  });
});
