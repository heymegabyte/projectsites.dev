/**
 * @module routes/auth_sessions
 * @description Custom-auth "Active sessions" endpoints for `/admin/auth-security`.
 *
 * The auth-security SPA is a thin wrapper around Better Auth, calling its session
 * paths (`/api/auth/list-sessions`, `/revoke-session`, `/revoke-other-sessions`).
 * But Better Auth ships DARK (the custom D1-`sessions` auth is the live path), so
 * those paths 401'd on every load — the "Active sessions" panel showed
 * "unavailable" for every real user. These handlers implement the SAME paths +
 * the exact `AuthSession` contract over the live `sessions` table.
 *
 * When the `better_auth` flag flips ON, the `/api/auth/*` middleware in `index.ts`
 * (registered BEFORE these routes) takes the paths over first — so these are the
 * custom-auth-path implementation, reached only while Better Auth is off.
 *
 * `authMiddleware` (`app.use('/api/*', …)`) runs first and sets `c.get('userId')`
 * from the caller's D1 session, so these handlers are already authenticated.
 *
 * | Method | Path                            | Body / Response                          |
 * | ------ | ------------------------------- | ---------------------------------------- |
 * | GET    | /api/auth/list-sessions         | → `AuthSession[]` (bare array)           |
 * | POST   | /api/auth/revoke-session        | `{ token }` (=session id) → `{ status }` |
 * | POST   | /api/auth/revoke-other-sessions | revoke all but the caller's → `{ status }` |
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import { internalError, notFound, sha256Hex } from '@project-sites/shared';
import type { Env, Variables } from '../types/env.js';
import { dbQuery, dbExecute } from '../services/db.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const authSessions = new Hono<AppContext>();

/** The raw bearer session token (used to identify the CURRENT session by hash). */
function bearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

const unauthorized = (c: import('hono').Context<AppContext>) =>
  c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401);

/**
 * GET /api/auth/list-sessions — the caller's active (non-deleted, non-expired)
 * sessions, most-recently-active first, mapped to the SPA's `AuthSession` shape.
 * `token` is the session id (never the real token/hash) — revoke identifies by it.
 */
authSessions.get('/api/auth/list-sessions', async (c) => {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const { data } = await dbQuery<{
    id: string;
    device_info: string | null;
    ip_address: string | null;
    expires_at: string;
    created_at: string;
    updated_at: string;
  }>(
    c.env.DB,
    `SELECT id, device_info, ip_address, expires_at, created_at, updated_at
       FROM sessions
      WHERE user_id = ? AND deleted_at IS NULL AND expires_at > ?
      ORDER BY last_active_at DESC
      LIMIT 100`,
    [userId, new Date().toISOString()],
  );
  const sessions = data.map((s) => ({
    id: s.id,
    token: s.id,
    userId,
    ipAddress: s.ip_address ?? null,
    userAgent: s.device_info ?? null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    expiresAt: s.expires_at,
  }));
  return c.json(sessions);
});

/** POST /api/auth/revoke-session — soft-delete one of the caller's sessions by id. */
authSessions.post('/api/auth/revoke-session', async (c) => {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
  const id = String(body.token ?? '').trim();
  if (!id) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'A session id is required.' } },
      400,
    );
  }
  const now = new Date().toISOString();
  const { error, changes } = await dbExecute(
    c.env.DB,
    `UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [now, now, id, userId],
  );
  if (error) throw internalError(`Failed to revoke session: ${error}`);
  // Sole-guard WHERE (id + user_id) — 0 rows means the session isn't the caller's or was
  // already revoked. Auth-sensitive: never report a sign-out that didn't actually happen.
  if (changes === 0) throw notFound('Session not found or already revoked.');
  return c.json({ status: true });
});

/**
 * POST /api/auth/revoke-other-sessions — sign out everywhere except the caller's
 * current session (identified by hashing the caller's bearer token to `token_hash`).
 */
authSessions.post('/api/auth/revoke-other-sessions', async (c) => {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const token = bearerToken(c.req.header('authorization') ?? null);
  const currentHash = token ? await sha256Hex(token) : '';
  const now = new Date().toISOString();
  const { error } = await dbExecute(
    c.env.DB,
    `UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND token_hash != ? AND deleted_at IS NULL`,
    [now, now, userId, currentHash],
  );
  // Bulk revoke — changes===0 is a VALID success (the caller has no other sessions). Only a
  // DB error must surface: a swallowed failure would falsely claim "signed out everywhere".
  if (error) throw internalError(`Failed to revoke other sessions: ${error}`);
  return c.json({ status: true });
});

/**
 * POST /api/auth/sign-out — revoke the caller's CURRENT session (identified by hashing the bearer
 * token → `token_hash`). Closes the replay-risk gap (AL-506): the client `signOut()` cleared the
 * local `ps_session` but the D1 session SURVIVED — the FE POST hit the Better-Auth `/api/auth/sign-out`
 * (dark / a no-op for a legacy D1 token), so a Bearer token copied before sign-out still authed
 * (`/api/auth/me` → 200 after "sign out", proven by `verify-signout-causal.mjs`). Mirrors
 * `revoke-other-sessions` but targets the CURRENT session (`token_hash = currentHash`). Idempotent:
 * no bearer / already-revoked → still `{status:true}` (local sign-out must never block on this).
 */
authSessions.post('/api/auth/sign-out', async (c) => {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const token = bearerToken(c.req.header('authorization') ?? null);
  const currentHash = token ? await sha256Hex(token) : '';
  if (!currentHash) return c.json({ status: true }); // cookie/local-only sign-out; nothing D1 to revoke
  const now = new Date().toISOString();
  const { error } = await dbExecute(
    c.env.DB,
    `UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND token_hash = ? AND deleted_at IS NULL`,
    [now, now, userId, currentHash],
  );
  // Revoking the CURRENT session — changes===0 is valid (already revoked / hash miss); only a DB
  // error must surface (a swallowed failure would falsely claim the token was killed).
  if (error) throw internalError(`Failed to sign out: ${error}`);
  return c.json({ status: true });
});
