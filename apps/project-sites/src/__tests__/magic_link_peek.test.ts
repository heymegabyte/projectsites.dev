/**
 * Unit tests for the test-only magic-link PEEK seam (Pathway C enabler).
 *
 * `GET /api/auth/magic-link/peek?email=...&secret=...`
 *
 * Contract under test:
 * - `env.E2E_PEEK_SECRET` unset → dark 404 (same envelope as unknown route, D1 untouched)
 * - wrong secret → identical 404 (constant-time digest compare, no oracle)
 * - malformed/missing email → 400 VALIDATION_ERROR (Zod at the boundary)
 * - happy path → `{ token }` from the KV plaintext stash, pinned by hash to the
 *   NEWEST unconsumed `magic_links` row for that exact email; row NEVER consumed
 * - consumed/absent/stale/expired → `{ token: null }` with 200
 * - `POST /api/auth/magic-link` stashes plaintext in KV ONLY when seam is armed
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

import { Hono } from 'hono';
import { sha256Hex } from '@project-sites/shared';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { api } from '../routes/api.js';
import { dbQueryOne, dbUpdate } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockDbUpdate = dbUpdate as jest.Mock;
const mockWriteAuditLog = writeAuditLog as jest.Mock;

const PEEK_SECRET = 'peek-secret-123';
const EMAIL = 'e2e@megabyte.space';

interface KvMock {
  get: jest.Mock;
  put: jest.Mock;
}

const createKvMock = (): KvMock => ({
  get: jest.fn().mockResolvedValue(null),
  put: jest.fn().mockResolvedValue(undefined),
});

/**
 * Key-aware KV get: the peek handler reads TWO stashes — the legacy plaintext
 * token (`e2e:magic-link:<email>`) and the Better Auth verify URL
 * (`e2e:ba-magic-url:<email>`). A key-blind mock leaks the legacy value into
 * the BA field and vice versa.
 */
const kvWith = (kv: KvMock, entries: Record<string, string | null>): void => {
  kv.get.mockImplementation((key: string) => Promise.resolve(entries[key] ?? null));
};
const LEGACY_KEY = `e2e:magic-link:${EMAIL}`;
const BA_KEY = `e2e:ba-magic-url:${EMAIL}`;

const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    CACHE_KV: createKvMock() as unknown as KVNamespace,
    ...overrides,
  }) as unknown as Env;

function createApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', api);
  const env = createMockEnv(envOverrides);
  return { app, env };
}

/** Hono's `c.executionCtx` getter throws without one — stub it for handlers that touch posthog. */
const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const peekPath = (email: string, secret: string) =>
  `/api/auth/magic-link/peek?email=${encodeURIComponent(email)}&secret=${encodeURIComponent(secret)}`;

const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastIso = () => new Date(Date.now() - 60 * 1000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  global.fetch = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'mock-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/auth/magic-link/peek', () => {
  it('returns a dark 404 when E2E_PEEK_SECRET is unset and never touches D1', async () => {
    const { app, env } = createApp(); // seam OFF — no E2E_PEEK_SECRET
    const res = await app.request(peekPath(EMAIL, 'anything'), {}, env, execCtx);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });

  it('returns the identical dark 404 on secret mismatch (no oracle, D1 untouched)', async () => {
    const { app, env } = createApp({ E2E_PEEK_SECRET: PEEK_SECRET });
    const res = await app.request(peekPath(EMAIL, 'wrong-secret'), {}, env, execCtx);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });

  it('rejects a malformed or missing email with 400 VALIDATION_ERROR', async () => {
    const { app, env } = createApp({ E2E_PEEK_SECRET: PEEK_SECRET });

    const malformed = await app.request(peekPath('not-an-email', PEEK_SECRET), {}, env, execCtx);
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const missing = await app.request(
      `/api/auth/magic-link/peek?secret=${encodeURIComponent(PEEK_SECRET)}`,
      {},
      env,
      execCtx,
    );
    expect(missing.status).toBe(400);
  });

  it('happy path: returns the newest unconsumed token WITHOUT consuming it + audits', async () => {
    const token = 'a'.repeat(64);
    const kv = createKvMock();
    kvWith(kv, { [LEGACY_KEY]: token });
    mockDbQueryOne.mockResolvedValue({
      token_hash: await sha256Hex(token),
      expires_at: futureIso(),
    });

    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });
    const res = await app.request(peekPath(EMAIL, PEEK_SECRET), {}, env, execCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token, url: null });

    // Newest-unconsumed lookup, exact-email scoped, read-only.
    const [, sql, params] = mockDbQueryOne.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('FROM magic_links');
    expect(sql).toContain('used = 0');
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    expect(params).toEqual([EMAIL]);
    expect(mockDbUpdate).not.toHaveBeenCalled(); // NEVER marks the link used

    // Audit line via the existing audit service pattern.
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ action: 'e2e.magic_link_peek', target_id: EMAIL }),
    );
  });

  it('normalizes the email to lowercase before lookup', async () => {
    const kv = createKvMock();
    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });
    mockDbQueryOne.mockResolvedValue(null);

    const res = await app.request(peekPath('E2E@Megabyte.SPACE', PEEK_SECRET), {}, env, execCtx);
    expect(res.status).toBe(200);

    const [, , params] = mockDbQueryOne.mock.calls[0] as [unknown, string, unknown[]];
    expect(params).toEqual([EMAIL]);
  });

  it('returns { token: null } when no unconsumed row exists (consumed/absent)', async () => {
    const kv = createKvMock();
    kvWith(kv, { [LEGACY_KEY]: 'stale-plaintext-from-a-consumed-link' });
    mockDbQueryOne.mockResolvedValue(null);

    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });
    const res = await app.request(peekPath(EMAIL, PEEK_SECRET), {}, env, execCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, url: null });
  });

  it('returns { token: null } when the KV stash does not hash to the newest row', async () => {
    const kv = createKvMock();
    kvWith(kv, { [LEGACY_KEY]: 'older-plaintext-token-000000000000' });
    mockDbQueryOne.mockResolvedValue({
      token_hash: await sha256Hex('a-different-newer-token-1111111111'),
      expires_at: futureIso(),
    });

    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });
    const res = await app.request(peekPath(EMAIL, PEEK_SECRET), {}, env, execCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, url: null });
  });

  it('returns the Better Auth verify URL from the BA stash (flag-ON send path)', async () => {
    const baUrl =
      'https://projectsites.dev/api/auth/magic-link/verify?token=ba-tok&callbackURL=%2Fadmin';
    const kv = createKvMock();
    kvWith(kv, { [BA_KEY]: baUrl });
    mockDbQueryOne.mockResolvedValue(null); // no legacy row — BA owns the send

    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });
    const res = await app.request(peekPath(EMAIL, PEEK_SECRET), {}, env, execCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, url: baUrl });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ action: 'e2e.magic_link_peek' }),
    );
  });

  it('returns { token: null } when the newest unconsumed row is expired', async () => {
    const token = 'b'.repeat(64);
    const kv = createKvMock();
    kvWith(kv, { [LEGACY_KEY]: token });
    mockDbQueryOne.mockResolvedValue({
      token_hash: await sha256Hex(token),
      expires_at: pastIso(),
    });

    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });
    const res = await app.request(peekPath(EMAIL, PEEK_SECRET), {}, env, execCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, url: null });
  });
});

describe('POST /api/auth/magic-link — E2E peek stash', () => {
  const post = (app: Hono<{ Bindings: Env; Variables: Variables }>, env: Env): Promise<Response> =>
    app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL }),
      },
      env,
      execCtx,
    );

  it('stashes the plaintext token in KV when the seam is armed', async () => {
    const kv = createKvMock();
    const { app, env } = createApp({
      E2E_PEEK_SECRET: PEEK_SECRET,
      CACHE_KV: kv as unknown as KVNamespace,
    });

    const res = await post(app, env);
    expect(res.status).toBe(200);

    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, value, opts] = kv.put.mock.calls[0] as [string, string, { expirationTtl?: number }];
    expect(key).toBe(`e2e:magic-link:${EMAIL}`);
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThanOrEqual(32); // plaintext token, never the hash of it
    expect(opts).toEqual(expect.objectContaining({ expirationTtl: expect.any(Number) }));
  });

  it('does NOT stash anything when the seam is dark', async () => {
    const kv = createKvMock();
    const { app, env } = createApp({ CACHE_KV: kv as unknown as KVNamespace });

    const res = await post(app, env);
    expect(res.status).toBe(200);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
