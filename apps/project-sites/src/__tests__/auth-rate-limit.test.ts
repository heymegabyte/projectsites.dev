/**
 * @module __tests__/auth-rate-limit
 *
 * @description
 * Validates the auth-surface rate-limit budgets from improvement item #6.
 * Every `/api/auth/*` endpoint must:
 *   - allow requests under the per-IP budget,
 *   - return 429 with `Retry-After` once the budget is exhausted,
 *   - re-allow traffic after the sliding window expires (KV TTL drives this).
 *
 * Tests mount the real `rateLimitMiddleware` against a tiny Hono app and
 * inject a KV stub that honours `expirationTtl` against a virtual clock.
 */

import { Hono } from 'hono';
import {
  applyRateLimits,
  RATE_LIMIT_RULES,
  rateLimitMiddleware,
} from '../middleware/rate_limit.js';

/**
 * Build an in-memory KV stub that honours `expirationTtl` against a virtual
 * clock. The clock is driven by `now()` so tests can fast-forward without
 * relying on real `setTimeout`s.
 *
 * @example
 * ```ts
 * const clock = { now: 1_000_000 };
 * const kv = createKv(() => clock.now);
 * clock.now += 61_000; // fast-forward past a 60s window
 * ```
 */
function createKv(now: () => number): KVNamespace {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const kv = {
    get: jest.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    put: jest.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const ttl = opts?.expirationTtl ?? 3600;
      store.set(key, { value, expiresAt: now() + ttl * 1000 });
    }),
    delete: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return kv as unknown as KVNamespace;
}

/**
 * Spin a Hono app that applies the PRODUCTION rate-limit config
 * ({@link RATE_LIMIT_RULES} via {@link applyRateLimits}) — no hand-mirroring,
 * so this test verifies the real budgets and can never pass while index.ts
 * drifts. A catch-all responder answers every request the limiter lets through.
 */
function createApp() {
  const app = new Hono<{ Bindings: { CACHE_KV: KVNamespace }; Variables: Record<string, never> }>();
  applyRateLimits(app);
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

const IP = '203.0.113.5';

describe('auth rate-limit (item #6)', () => {
  let clock: { now: number };
  let kv: KVNamespace;
  let app: ReturnType<typeof createApp>;

  /**
   * Shortcut: fire one request against the wired app with the shared KV +
   * stable IP, returning the Response. Mirrors how production traffic hits
   * the worker (CF-Connecting-IP header + KV binding via env).
   */
  function hit(path: string, method: 'GET' | 'POST' = 'POST', ip: string = IP): Promise<Response> {
    return app.request(path, { method, headers: { 'cf-connecting-ip': ip } }, { CACHE_KV: kv });
  }

  beforeEach(() => {
    clock = { now: 1_700_000_000_000 };
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    kv = createKv(() => clock.now);
    app = createApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['/api/auth/magic-link', 5, 'POST'],
    ['/api/auth/magic-link/verify', 10, 'POST'],
    ['/api/auth/google', 20, 'GET'],
    ['/api/auth/google/callback', 20, 'GET'],
    ['/api/auth/github', 20, 'GET'],
    ['/api/auth/github/callback', 20, 'GET'],
    // Media generation cost shields (external paid AI) — video is tightest.
    ['/api/media/generate/image', 10, 'POST'],
    ['/api/media/generate/video', 3, 'POST'],
    ['/api/media/generate/podcast', 8, 'POST'],
  ])('allows requests under the budget on %s (budget=%i)', async (path, budget, method) => {
    for (let i = 0; i < budget; i++) {
      const res = await hit(path, method as 'GET' | 'POST');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 with Retry-After + standard envelope past the magic-link budget', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await hit('/api/auth/magic-link');
      expect(res.status).toBe(200);
    }

    const blocked = await hit('/api/auth/magic-link');

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');

    const body = (await blocked.json()) as { error: { code: string; retry_after: number } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retry_after).toBe(60);
  });

  it('returns 429 once the GitHub OAuth callback budget is exceeded', async () => {
    for (let i = 0; i < 20; i++) {
      const ok = await hit('/api/auth/github/callback?code=x&state=y', 'GET');
      expect(ok.status).toBe(200);
    }
    const blocked = await hit('/api/auth/github/callback?code=x&state=y', 'GET');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('throttles the expensive Sora/Veo video-generation endpoint past its 3/min shield', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await hit('/api/media/generate/video')).status).toBe(200);
    }
    const blocked = await hit('/api/media/generate/video');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe('3');
  });

  it('sliding window forgets after 60s (TTL expiry)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await hit('/api/auth/magic-link');
      expect(res.status).toBe(200);
    }
    const blocked = await hit('/api/auth/magic-link');
    expect(blocked.status).toBe(429);

    // Fast-forward past the 60-second sliding window. KV TTL expires the
    // counter, the next request should be allowed afresh.
    clock.now += 61_000;

    const reopened = await hit('/api/auth/magic-link');
    expect(reopened.status).toBe(200);
  });

  it.each([
    ['/api/contact-form/nsk', 5, 'POST'],
    ['/api/contact', 5, 'POST'],
    ['/api/feedback', 10, 'POST'],
    ['/api/search/address', 30, 'GET'],
    // AL-337: newsletter double-opt-in subscribe (INSERTs a row + sends a
    // confirmation email per distinct address) + unsubscribe — were PUBLIC +
    // UNMETERED (subscriber-row flood + unbounded SES confirmation sends /
    // reputation abuse). Now budgeted like the other public email-write routes.
    ['/api/newsletter/subscribe', 5, 'POST'],
    ['/api/newsletter/unsubscribe', 10, 'POST'],
  ])('rate-limits the public cost endpoint %s (budget=%i)', async (path, budget, method) => {
    for (let i = 0; i < budget; i++) {
      const ok = await hit(path, method as 'GET' | 'POST');
      expect(ok.status).toBe(200);
    }
    const blocked = await hit(path, method as 'GET' | 'POST');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('RATE_LIMIT_RULES is well-formed (unique paths, positive budgets)', () => {
    expect(RATE_LIMIT_RULES.length).toBeGreaterThanOrEqual(20);
    const paths = RATE_LIMIT_RULES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length); // no duplicate paths
    for (const r of RATE_LIMIT_RULES) {
      expect(r.maxRequests).toBeGreaterThan(0);
      expect(r.windowSeconds).toBeGreaterThan(0);
      expect(r.prefix.length).toBeGreaterThan(0);
    }
  });

  it('partitions counters per IP (one abuser does not starve another)', async () => {
    for (let i = 0; i < 5; i++) {
      await hit('/api/auth/magic-link', 'POST', '198.51.100.1');
    }
    const otherIp = await hit('/api/auth/magic-link', 'POST', '198.51.100.2');
    expect(otherIp.status).toBe(200);
  });

  it('propagates a downstream handler error verbatim (next() not double-invoked)', async () => {
    // The handler throws AFTER the limiter ran. The middleware must NOT mistake
    // that for a KV failure + call next() again ("next() called multiple times").
    const a = new Hono<{ Bindings: { CACHE_KV: KVNamespace }; Variables: Record<string, never> }>();
    let onErrorMsg = '';
    a.onError((err, c) => {
      onErrorMsg = err.message;
      return c.json({ error: 'handled' }, 500);
    });
    a.use(
      '/api/auth/magic-link',
      rateLimitMiddleware({ maxRequests: 5, windowSeconds: 60, prefix: 'rl:test-throw' }),
    );
    a.post('/api/auth/magic-link', () => {
      throw new Error('handler-boom');
    });
    const res = await a.request(
      '/api/auth/magic-link',
      { method: 'POST', headers: { 'cf-connecting-ip': IP } },
      { CACHE_KV: kv },
    );
    expect(res.status).toBe(500);
    expect(onErrorMsg).toBe('handler-boom'); // the REAL error, not "next() called multiple times"
  });

  it('fails OPEN when KV errors (request still served, unmetered)', async () => {
    const brokenKv = {
      get: jest.fn(async () => {
        throw new Error('kv down');
      }),
      put: jest.fn(),
    } as unknown as KVNamespace;
    const a = new Hono<{ Bindings: { CACHE_KV: KVNamespace }; Variables: Record<string, never> }>();
    a.use(
      '/api/auth/magic-link',
      rateLimitMiddleware({ maxRequests: 1, windowSeconds: 60, prefix: 'rl:test-failopen' }),
    );
    a.all('*', (c) => c.json({ ok: true }));
    // Two hits despite a budget of 1 — KV is down, so the limiter fails open.
    for (let i = 0; i < 2; i++) {
      const res = await a.request(
        '/api/auth/magic-link',
        { method: 'POST', headers: { 'cf-connecting-ip': IP } },
        { CACHE_KV: brokenKv },
      );
      expect(res.status).toBe(200);
    }
  });
});
