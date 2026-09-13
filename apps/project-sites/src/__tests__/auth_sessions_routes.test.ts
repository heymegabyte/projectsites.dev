/**
 * @file auth_sessions_routes.test.ts
 * @description Custom-auth "Active sessions" mutations (`/api/auth/*`) for
 * `/admin/auth-security` (Better Auth is dark → this custom D1 path is LIVE).
 *
 * Both revoke endpoints ran a `dbExecute(...UPDATE sessions...)` and ignored the
 * `{ error, changes }` result → a lying `{ status: true }` even when the sign-out
 * did not happen (DB error, or a session that isn't the caller's). Auth-sensitive:
 * a user must never be told a device was signed out when it wasn't.
 *
 *   revoke-session       — SOLE-GUARD (id + user_id): error→500, changes===0→404.
 *   revoke-other-sessions — BULK (all but current): error→500, but changes===0 is a
 *                           VALID success (the caller simply has no other sessions).
 */
jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbExecute: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { authSessions } from '../routes/auth_sessions.js';
import { dbExecute } from '../services/db.js';

const mockDbExecute = dbExecute as unknown as jest.Mock;

function makeEnv(): Env {
  return { ENVIRONMENT: 'test', DB: {} as D1Database } as unknown as Env;
}

function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', authSessions);
  return app;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

type AnyApp = Hono<{ Bindings: Env; Variables: Variables }>;
function req(app: AnyApp, path: string, init: RequestInit, env: Env) {
  return app.request(path, init, env, makeCtx());
}
function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const AUTH: Partial<Variables> = { userId: 'user-1', requestId: 'req-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockDbExecute.mockResolvedValue({ error: null, changes: 1 });
});

describe('POST /api/auth/revoke-session (sole-guard)', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await req(
      makeApp(),
      '/api/auth/revoke-session',
      jsonInit('POST', { token: 'sess-1' }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when the session id is missing', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-session',
      jsonInit('POST', {}),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('revokes the caller session and returns 200 { status: true }', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-session',
      jsonInit('POST', { token: 'sess-1' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
  });

  it('returns 404 (not a lying 200) when the session is not the caller’s / already revoked', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: null, changes: 0 });
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-session',
      jsonInit('POST', { token: 'sess-nope' }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 (never a lying 200) when the revoke UPDATE errors', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-session',
      jsonInit('POST', { token: 'sess-1' }),
      makeEnv(),
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/auth/revoke-other-sessions (bulk)', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await req(
      makeApp(),
      '/api/auth/revoke-other-sessions',
      jsonInit('POST'),
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('revokes other sessions and returns 200 { status: true }', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-other-sessions',
      jsonInit('POST'),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
  });

  it('stays 200 when there are NO other sessions (changes===0 is a valid bulk success — NOT 404)', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: null, changes: 0 });
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-other-sessions',
      jsonInit('POST'),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
  });

  it('returns 500 (never a lying 200) when the bulk UPDATE errors', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    const res = await req(
      makeApp(AUTH),
      '/api/auth/revoke-other-sessions',
      jsonInit('POST'),
      makeEnv(),
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/auth/sign-out (revoke CURRENT session — AL-506 replay-gap fix)', () => {
  const bearerInit = (): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sess-token-abc' },
    body: '{}',
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await req(makeApp(), '/api/auth/sign-out', bearerInit(), makeEnv());
    expect(res.status).toBe(401);
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('revokes THE CURRENT session (UPDATE by user_id + token_hash =, not !=) → 200 { status: true }', async () => {
    const res = await req(makeApp(AUTH), '/api/auth/sign-out', bearerInit(), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
    const sql = mockDbExecute.mock.calls[0][1] as string;
    expect(sql).toMatch(/UPDATE sessions SET deleted_at/i);
    expect(sql).toMatch(/token_hash = \?/); // targets THE current session…
    expect(sql).not.toMatch(/token_hash != \?/); // …never the revoke-OTHERS inverse (would keep the token alive)
  });

  it('is a no-op 200 when there is NO bearer token (cookie/local-only sign-out — never blocks)', async () => {
    const noBearer: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    const res = await req(makeApp(AUTH), '/api/auth/sign-out', noBearer, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('stays 200 when changes===0 (already revoked / hash miss is idempotent — NOT 404)', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: null, changes: 0 });
    const res = await req(makeApp(AUTH), '/api/auth/sign-out', bearerInit(), makeEnv());
    expect(res.status).toBe(200);
  });

  it('returns 500 (never a lying 200) when the revoke UPDATE errors', async () => {
    mockDbExecute.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    const res = await req(makeApp(AUTH), '/api/auth/sign-out', bearerInit(), makeEnv());
    expect(res.status).toBe(500);
  });
});
