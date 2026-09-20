/**
 * @module middleware/idempotency
 * @description General `Idempotency-Key` dedupe for mutating API requests.
 *
 * A client that retries a mutation (network blip, double-click, queue redelivery)
 * sends a stable `Idempotency-Key` header; the first response is cached in
 * `CACHE_KV` and replayed verbatim for any subsequent request with the same key,
 * so the underlying handler runs exactly once. Until now only Stripe webhooks
 * deduped — this generalizes it to every mutation that opts in via the header.
 *
 * Safe-by-default: a no-op when the header is absent OR the method is not
 * mutating, so existing traffic is unaffected. Only successful (2xx) JSON
 * responses are cached — errors stay retryable. Scoped by `orgId` for authenticated
 * callers (one tenant's key can never replay another's) and by the CF edge IP for
 * anonymous callers on public routes (two different visitors can never collide); a
 * caller with neither identity skips dedupe entirely.
 *
 * @packageDocumentation
 */

import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types/env.js';

/** Methods whose effects should be deduped. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Replay window — KV TTL (CF KV minimum is 60s; 24h matches Stripe's window). */
const TTL_SECONDS = 86_400;
/** Don't cache oversized bodies (KV value cap is 25 MB; stay well under + cheap). */
const MAX_CACHED_BODY = 256 * 1024;

/**
 * Build the per-tenant KV key for an idempotent request.
 *
 * @remarks Scoped by caller identity (orgId for authenticated, `anon:<cf-edge-ip>` for
 * anonymous) + method + path so the same client key on a different route, tenant, or
 * anonymous visitor never collides. Exported for unit testing.
 */
export function idempotencyCacheKey(
  scope: string,
  method: string,
  pathname: string,
  clientKey: string,
): string {
  return `idem:${scope}:${method}:${pathname}:${clientKey}`;
}

/**
 * Dedupe mutating requests carrying an `Idempotency-Key` header.
 *
 * @example
 * ```ts
 * app.use('/api/*', authMiddleware);
 * app.use('/api/*', idempotencyMiddleware); // after auth so orgId is set
 * ```
 */
export const idempotencyMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const clientKey = c.req.header('idempotency-key');
  if (!clientKey || !MUTATING_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  // Scope the dedupe key. An AUTHENTICATED caller scopes by tenant (orgId) so one tenant's
  // key can never replay another's. An UNAUTHENTICATED caller has NO tenant — collapsing every
  // anon caller into one shared 'anon' bucket let two DIFFERENT visitors with the same
  // Idempotency-Key on the same PUBLIC mutating path (e.g. POST /api/contact-form/:slug) replay
  // each other's cached response (cross-caller leak). Scope anon callers by the unspoofable CF
  // edge IP instead: distinct visitors never collide, while a single visitor's retry still
  // dedupes. If we can identify NEITHER a tenant NOR an edge IP, skip dedupe (run the handler)
  // rather than risk a shared-bucket collision.
  const orgId = c.get('orgId');
  const anonIp = c.req.header('cf-connecting-ip');
  const scope = orgId ?? (anonIp ? `anon:${anonIp}` : undefined);
  if (!scope) {
    await next();
    return;
  }
  const kvKey = idempotencyCacheKey(scope, c.req.method, new URL(c.req.url).pathname, clientKey);

  const cached = (await c.env.CACHE_KV.get(kvKey, 'json').catch(() => null)) as {
    status: number;
    body: string;
  } | null;
  if (cached) {
    c.res = new Response(cached.body, {
      status: cached.status,
      headers: { 'content-type': 'application/json', 'idempotency-replayed': 'true' },
    });
    return;
  }

  await next();

  // Cache only successful responses so failures stay retryable.
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    try {
      const body = await c.res.clone().text();
      if (body.length <= MAX_CACHED_BODY) {
        await c.env.CACHE_KV.put(kvKey, JSON.stringify({ status, body }), {
          expirationTtl: TTL_SECONDS,
        });
      }
    } catch {
      // Never fail the live request because the idempotency cache write failed.
    }
  }
};
