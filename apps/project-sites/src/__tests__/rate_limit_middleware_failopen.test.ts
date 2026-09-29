/**
 * rate_limit middleware — fail-OPEN observability contract.
 *
 * Locks that when `CACHE_KV` throws (a KV outage), `rateLimitMiddleware`:
 *   (a) STILL falls through and runs the handler UNMETERED (fail-open preserved —
 *       `next()` runs exactly once, NO 429, NO X-RateLimit-* headers), AND
 *   (b) the failure is now OBSERVABLE — a structured `console.warn` line + a
 *       Sentry `captureException` fire, so a masked KV outage is visible.
 *
 * The fail-open control flow is UNCHANGED by the logging; these tests prove it.
 */

// Mock Sentry so captureException never attempts a real fetch.
jest.mock('../lib/sentry.js', () => ({ captureException: jest.fn() }));

import { rateLimitMiddleware } from '../middleware/rate_limit.js';
import { captureException } from '../lib/sentry.js';

const captureMock = captureException as unknown as jest.Mock;

/** A CACHE_KV double whose get()/put() can be made to throw. */
function kv(throwing: boolean) {
  return {
    get: jest.fn(async () => {
      if (throwing) throw new Error('KV boom');
      return null;
    }),
    put: jest.fn(async () => {
      if (throwing) throw new Error('KV boom');
    }),
  };
}

/** Minimal Hono-context double for the middleware. */
function ctx(throwing: boolean) {
  const vars = new Map<string, unknown>([['requestId', 'req_test']]);
  const headers: Record<string, string> = {};
  let jsonCalled = false;
  const c = {
    env: { CACHE_KV: kv(throwing) },
    req: {
      method: 'POST',
      header: (k: string) => (k === 'cf-connecting-ip' ? '203.0.113.7' : undefined),
    },
    get: (k: string) => vars.get(k),
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (..._args: unknown[]) => {
      jsonCalled = true;
      return { __response: true };
    },
  } as never;
  return { c, headers, jsonCalled: () => jsonCalled };
}

const OPTS = { maxRequests: 5, windowSeconds: 60, prefix: 'rl:test' };

describe('rateLimitMiddleware — KV outage fails open + is observable', () => {
  beforeEach(() => captureMock.mockClear());

  it('KV get() throws → request STILL proceeds unmetered (next runs once, no 429/headers)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { c, headers, jsonCalled } = ctx(true);
      let nexted = 0;
      const next = async () => {
        nexted += 1;
      };

      await rateLimitMiddleware(OPTS)(c, next);

      // Fail-OPEN preserved: handler ran, no 429 returned, no rate-limit headers.
      expect(nexted).toBe(1);
      expect(jsonCalled()).toBe(false);
      expect(headers['X-RateLimit-Limit']).toBeUndefined();
      expect(headers['X-RateLimit-Remaining']).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('KV outage is LOGGED (console.warn + Sentry) — no longer swallowed silently', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { c } = ctx(true);
      await rateLimitMiddleware(OPTS)(c, async () => undefined);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(payload.level).toBe('warn');
      expect(payload.msg).toContain('KV unavailable');
      expect(payload.prefix).toBe('rl:test');
      expect(payload.err).toContain('KV boom');
      expect(payload.requestId).toBe('req_test');

      expect(captureMock).toHaveBeenCalledTimes(1);
      expect(captureMock.mock.calls[0][2]).toMatchObject({ path: 'rate_limit:rl:test' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('healthy KV path does NOT log (no error swallowed) and still meters', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { c, headers } = ctx(false);
      let nexted = 0;
      await rateLimitMiddleware(OPTS)(c, async () => {
        nexted += 1;
      });

      expect(nexted).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(captureMock).not.toHaveBeenCalled();
      // Metered path sets the rate-limit headers after next().
      expect(headers['X-RateLimit-Limit']).toBe('5');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
