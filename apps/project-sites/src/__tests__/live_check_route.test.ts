/**
 * Route-layer coverage for `GET /api/sites/:id/live-check` — the CORS-safe, server-side
 * liveness PROBE the admin hosting UI will later poll after publish/deploy, revealing
 * "View Live" only once the site TRULY serves 200 (a propagation guard against the 60s
 * host→manifest KV cache + CF edge warm-up showing a dead URL the instant a deploy returns).
 *
 * This is the PUBLISH leg's worker half (PUBLISH-1). The money path is: owner edits → publish →
 * site must become LIVE. A naive "publish returned 200 → show View Live" link sends the owner to a
 * blank/404 page during propagation — the single most damaging first-impression bug on the paid path.
 * This endpoint lets the FE poll until the probe reports `live:true` before unlocking the link.
 *
 * The four invariants that make the probe SAFE + HONEST, each locked by a case below:
 *   1. Auth — `orgId` from context, else 401 (never probe on behalf of an anonymous caller).
 *   2. IDOR — `requireOwnedSite(..., 'id, slug')` → 404 on a foreign/missing id (never 403, never
 *      leak existence), and the outbound fetch is NEVER issued for a site the caller does not own
 *      (otherwise the endpoint is an authenticated SSRF-lite oracle against arbitrary owned slugs).
 *   3. Flag — default-OFF `publish_live_check`; OFF → 404 (NOT 403), and NO fetch fires.
 *   4. No-SSRF URL — the probed URL is SERVER-DERIVED from the owned slug
 *      (`https://${slug}${SITES_SUFFIX}`), NEVER a request param — a caller can't point the probe
 *      at an internal host. A fetch THROW degrades to `{live:false, status:0}`, never a 500.
 *
 * Harness mirrors `publish_bolt_ownership.test.ts` / `deploy_kv_purge.test.ts`: the full `api`
 * router mounted on a Hono app + `errorHandler`, a prepare/bind DB mock serving requireOwnedSite's
 * `SELECT … FROM sites WHERE id = ?` query, `isFlagOn` mocked, and the global `fetch` stubbed +
 * asserted (call count proves "fetch never fired" on the 401/404 paths).
 */
import { Hono } from 'hono';

// MUST precede the `../routes/api.js` import so @swc/jest hoists it above the router module —
// the router calls the REAL isFlagOn otherwise (which blows up on an env with no CACHE_KV).
// Uses the GLOBAL `jest` (no `@jest/globals` import) so the hoist actually happens (repo gotcha #12).
jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow jest.mock (swc hoists the mock)
import type { Env, Variables } from '../types/env.js';
// eslint-disable-next-line import/first
import { api } from '../routes/api.js';
// eslint-disable-next-line import/first
import { errorHandler } from '../middleware/error_handler.js';
// eslint-disable-next-line import/first
import { isFlagOn } from '../modules/feature_flags/services.js';

const mockFlag = isFlagOn as unknown as jest.Mock;

interface SiteRow {
  id: string;
  slug: string;
}

/**
 * Mock env whose DB answers requireOwnedSite's `SELECT id, slug FROM sites WHERE id = ? AND
 * org_id = ? AND deleted_at IS NULL` — `dbQueryOne` reads `.all().results[0]`, so `all()` returns
 * `[site]` when owned, `[]` (→ 404) otherwise. No R2/KV needed — the probe only reads the DB + fetches.
 */
function makeEnv(site: SiteRow | null): { env: Env } {
  const DB = {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          const isSiteLookup = /FROM sites WHERE id = \?/i.test(sql);
          return {
            first: async () => (isSiteLookup ? site : null),
            all: async () => ({ results: isSiteLookup && site ? [site] : [] }),
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env };
}

function makeApp(env: Env, caller: { orgId?: string; userId?: string }) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (caller.orgId) c.set('orgId', caller.orgId);
    if (caller.userId) c.set('userId', caller.userId);
    c.set('requestId', 'test-req');
    await next();
  });
  app.route('/', api);
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return (path: string) =>
    app.request(path, { method: 'GET' }, { ...({} as Env), ...env } as Env, ctx);
}

const OWNED: SiteRow = { id: 's1', slug: 'acme' };

describe('GET /api/sites/:id/live-check — server-side liveness probe (auth · IDOR · flag · no-SSRF)', () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    mockFlag.mockReset();
    // Default: flag ON + the probed URL answers 200. Individual cases override.
    mockFlag.mockResolvedValue(true);
    fetchSpy = jest.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  it('401 when unauthenticated (no orgId) — and never probes', async () => {
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, {})('/api/sites/s1/live-check');
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404 for a foreign / unowned site (requireOwnedSite) — never 403, never probes', async () => {
    const { env } = makeEnv(null); // ownership SELECT returns nothing
    const res = await makeApp(env, { orgId: 'attacker-org', userId: 'a' })(
      '/api/sites/s1/live-check',
    );
    expect(res.status).toBe(404);
    // The outbound probe MUST NOT fire for a site the caller does not own (no SSRF-lite oracle).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404 (not 403) when the publish_live_check flag is OFF — and never probes', async () => {
    mockFlag.mockResolvedValue(false);
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'u' })('/api/sites/s1/live-check');
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('200 + {live:true, status:200, server-derived url} when the HEAD probe returns 200', async () => {
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'u' })('/api/sites/s1/live-check');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { live: boolean; status: number; url: string };
    };
    expect(payload.data).toEqual({
      live: true,
      status: 200,
      url: 'https://acme.projectsites.dev',
    });
    // The URL was SERVER-DERIVED from the owned slug (never a request param).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://acme.projectsites.dev');
    expect(init.method).toBe('HEAD');
    expect(init.redirect).toBe('manual');
  });

  it('200 + {live:false, status:404} when the site is not yet serving (HEAD 404 — propagation)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'u' })('/api/sites/s1/live-check');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { live: boolean; status: number } };
    expect(payload.data.live).toBe(false);
    expect(payload.data.status).toBe(404);
  });

  it('200 + {live:false, status:0} when the probe THROWS — degrades, never 500s', async () => {
    fetchSpy.mockRejectedValue(new Error('network/timeout/abort'));
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'u' })('/api/sites/s1/live-check');
    expect(res.status).toBe(200); // NOT a 500 — a dead probe is a datum, not a server fault
    const payload = (await res.json()) as { data: { live: boolean; status: number; url: string } };
    expect(payload.data).toEqual({
      live: false,
      status: 0,
      url: 'https://acme.projectsites.dev',
    });
  });
});
