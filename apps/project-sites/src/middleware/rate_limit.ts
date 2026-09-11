/**
 * @module middleware/rate_limit
 * @description KV-based per-IP rate limiting middleware.
 *
 * Uses Cloudflare KV with TTL-based expiry for sliding window counters.
 * Each rate limit rule specifies max requests per window (in seconds).
 *
 * @example
 * ```ts
 * // 5 requests per 60 seconds for auth endpoints
 * app.use('/api/auth/*', rateLimitMiddleware({ maxRequests: 5, windowSeconds: 60, prefix: 'rl:auth' }));
 * ```
 */

import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types/env.js';

export interface RateLimitOptions {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** KV key prefix for this limiter */
  prefix: string;
}

/** A rate-limit rule = a path pattern + its budget. */
export interface RateLimitRule extends RateLimitOptions {
  /** Hono path pattern the limiter is mounted on via `app.use(path, …)`. */
  path: string;
}

/**
 * THE single source of truth for every per-IP rate-limit budget in the worker.
 * `src/index.ts` applies these in a loop; `auth-rate-limit.test.ts` imports the
 * same array — so the test can never pass while production drifts (the prior
 * hand-mirrored config was drift-prone). Add a new throttled surface HERE only.
 *
 * Prefixes may repeat across paths (e.g. the legacy `/admin-api/*` + current
 * `/api/bolt/*` aliases share a counter on purpose).
 */
export const RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  // Auth surface (email cost + DoS shield; OAuth start/callback looser).
  { path: '/api/auth/magic-link', maxRequests: 5, windowSeconds: 60, prefix: 'auth:magic-link' },
  {
    path: '/api/auth/magic-link/verify',
    maxRequests: 10,
    windowSeconds: 60,
    prefix: 'auth:magic-link-verify',
  },
  {
    // Test-only peek (dark 404 unless E2E_PEEK_SECRET set) — bounded anyway so
    // a leaked secret can't be brute-forced against token rows at speed.
    path: '/api/auth/magic-link/peek',
    maxRequests: 30,
    windowSeconds: 60,
    prefix: 'auth:magic-link-peek',
  },
  { path: '/api/auth/google', maxRequests: 20, windowSeconds: 60, prefix: 'auth:google' },
  {
    path: '/api/auth/google/callback',
    maxRequests: 20,
    windowSeconds: 60,
    prefix: 'auth:google-callback',
  },
  { path: '/api/auth/github', maxRequests: 20, windowSeconds: 60, prefix: 'auth:github' },
  {
    path: '/api/auth/github/callback',
    maxRequests: 20,
    windowSeconds: 60,
    prefix: 'auth:github-callback',
  },
  // Public / cost-incurring (paid APIs, Stripe sessions, email sends).
  { path: '/api/search/businesses', maxRequests: 30, windowSeconds: 60, prefix: 'rl:search' },
  { path: '/api/search/address', maxRequests: 30, windowSeconds: 60, prefix: 'rl:search-addr' },
  { path: '/api/contact-form/*', maxRequests: 5, windowSeconds: 60, prefix: 'rl:contact' },
  // Platform contact form — public, unauthenticated, sends email + writes an audit
  // row. Same abuse/cost budget as the per-site form above (distinct path: this
  // never matches /api/contact-form/* — `contact` vs `contact-form` segment).
  { path: '/api/contact', maxRequests: 5, windowSeconds: 60, prefix: 'rl:contact-platform' },
  // Feedback form — public (auth optional), inserts a `feedback` row on every
  // POST. Without a budget an attacker floods the table; 10/min/IP is generous
  // for a human rating a build.
  { path: '/api/feedback', maxRequests: 10, windowSeconds: 60, prefix: 'rl:feedback' },
  // Newsletter double-opt-in subscribe — PUBLIC + unauthenticated, INSERTs a
  // `newsletter_subscribers` row AND signals a confirmation email (double-opt-in,
  // `confirm_email_sent:true`) per distinct address. Was UNMETERED → a flood of
  // distinct emails = unbounded subscriber rows + unbounded SES confirmation sends to
  // (often harvested) addresses: storage abuse + real SES-reputation/cost damage.
  // 5/min/IP matches the email-sending contact budget (a human subscribes once).
  // Unsubscribe only flips a flag (no email) → looser 10/min. (AL-337 security audit.)
  {
    path: '/api/newsletter/subscribe',
    maxRequests: 5,
    windowSeconds: 60,
    prefix: 'rl:newsletter-sub',
  },
  {
    path: '/api/newsletter/unsubscribe',
    maxRequests: 10,
    windowSeconds: 60,
    prefix: 'rl:newsletter-unsub',
  },
  {
    path: '/api/sites/create-from-search',
    maxRequests: 10,
    windowSeconds: 3600,
    prefix: 'rl:create',
  },
  { path: '/api/v1/forms/submit', maxRequests: 30, windowSeconds: 60, prefix: 'rl:forms' },
  { path: '/api/ai/*', maxRequests: 20, windowSeconds: 60, prefix: 'rl:ai' },
  { path: '/api/sites/autofill', maxRequests: 20, windowSeconds: 60, prefix: 'rl:autofill' },
  // Media generation — external PAID AI (DALL-E image, Sora/Veo video, TTS podcast).
  // Authed but previously UN-metered, so a single org could flood the most expensive
  // endpoints in the app for unbounded provider cost. Per-IP flood shields (video is
  // tightest — Sora/Veo runs dollars-per-clip); total-per-plan budgeting stays a
  // separate entitlement concern.
  {
    path: '/api/media/generate/image',
    maxRequests: 10,
    windowSeconds: 60,
    prefix: 'rl:media-image',
  },
  {
    path: '/api/media/generate/video',
    maxRequests: 3,
    windowSeconds: 60,
    prefix: 'rl:media-video',
  },
  {
    path: '/api/media/generate/podcast',
    maxRequests: 8,
    windowSeconds: 60,
    prefix: 'rl:media-podcast',
  },
  // Bolt admin (Workers AI + D1 abuse vectors) — legacy + current aliases.
  { path: '/admin-api/vision-ocr', maxRequests: 5, windowSeconds: 60, prefix: 'rl:vision' },
  { path: '/api/bolt/vision-ocr', maxRequests: 5, windowSeconds: 60, prefix: 'rl:vision' },
  { path: '/admin-api/transcribe', maxRequests: 10, windowSeconds: 60, prefix: 'rl:transcribe' },
  { path: '/api/bolt/transcribe', maxRequests: 10, windowSeconds: 60, prefix: 'rl:transcribe' },
  {
    path: '/admin-api/chat/suggest-prompts',
    maxRequests: 30,
    windowSeconds: 60,
    prefix: 'rl:suggest',
  },
  {
    path: '/api/bolt/chat/suggest-prompts',
    maxRequests: 30,
    windowSeconds: 60,
    prefix: 'rl:suggest',
  },
  {
    path: '/admin-api/sites/by-slug/*/chat-state',
    maxRequests: 60,
    windowSeconds: 60,
    prefix: 'rl:chat-state',
  },
  {
    path: '/api/bolt/sites/by-slug/*/chat-state',
    maxRequests: 60,
    windowSeconds: 60,
    prefix: 'rl:chat-state',
  },
  // Read/stream parity — polling + SSE GET budgets.
  {
    path: '/api/sites/:id/workflow',
    maxRequests: 60,
    windowSeconds: 60,
    prefix: 'rl:workflow-status',
  },
  { path: '/api/sites/:id/logs', maxRequests: 60, windowSeconds: 60, prefix: 'rl:site-logs' },
  {
    path: '/api/sites/:id/build/stream',
    maxRequests: 30,
    windowSeconds: 60,
    prefix: 'rl:build-stream',
  },
  { path: '/api/dashboard/chat', maxRequests: 20, windowSeconds: 60, prefix: 'rl:dashboard-chat' },
  // MCP/OAuth surface — public + bot-challenge-exempt (WAF skip rule for automated
  // clients), so the unauthenticated mint/registration paths need an explicit budget
  // against KV-write + token-mint cost abuse (the bot challenge previously covered this).
  { path: '/oauth/register', maxRequests: 5, windowSeconds: 60, prefix: 'rl:oauth-register' },
  { path: '/oauth/token', maxRequests: 10, windowSeconds: 60, prefix: 'rl:oauth-token' },
  { path: '/api/mcp', maxRequests: 60, windowSeconds: 60, prefix: 'rl:platform-mcp' },
];

/**
 * Apply every {@link RATE_LIMIT_RULES} entry to a Hono app via `app.use`.
 * Used by `src/index.ts` (production) and the rate-limit test (mirror-free).
 */
export function applyRateLimits(app: {
  use: (path: string, mw: ReturnType<typeof rateLimitMiddleware>) => unknown;
}): void {
  for (const { path, ...opts } of RATE_LIMIT_RULES) {
    app.use(path, rateLimitMiddleware(opts));
  }
}

/**
 * Create a rate limiting middleware using KV counters.
 *
 * @param opts - Rate limit configuration
 * @returns Hono middleware that returns 429 when limit exceeded
 */
export function rateLimitMiddleware(opts: RateLimitOptions): MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> {
  return async (c, next) => {
    // Extract client IP (Cloudflare headers)
    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown';

    const key = `${opts.prefix}:${ip}`;

    // ONLY the KV ops live in the try — `next()` is called exactly once, OUTSIDE
    // it. If next() were inside, a downstream HANDLER throw would be mistaken for
    // a KV failure and next() would be invoked a second time → Hono throws
    // "next() called multiple times", masking the handler's real error with a
    // misleading 500. `count` defaults to 0 + `limited=false` so a KV outage
    // fails OPEN (request runs, no limiting, no headers).
    let count = 0;
    let limited = false;
    try {
      const current = await c.env.CACHE_KV.get(key);
      count = current ? parseInt(current, 10) : 0;

      if (count >= opts.maxRequests) {
        return c.json(
          {
            error: {
              code: 'RATE_LIMITED',
              message: `Too many requests. Please try again in ${opts.windowSeconds} seconds.`,
              retry_after: opts.windowSeconds,
            },
          },
          429,
          {
            'Retry-After': String(opts.windowSeconds),
            'X-RateLimit-Limit': String(opts.maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + opts.windowSeconds),
          },
        );
      }

      // Increment counter with TTL
      await c.env.CACHE_KV.put(key, String(count + 1), { expirationTtl: opts.windowSeconds });
      limited = true;
    } catch {
      // KV unavailable → fail open: fall through to run the handler unmetered.
    }

    await next();

    if (limited) {
      c.header('X-RateLimit-Limit', String(opts.maxRequests));
      c.header('X-RateLimit-Remaining', String(Math.max(0, opts.maxRequests - count - 1)));
    }
  };
}
