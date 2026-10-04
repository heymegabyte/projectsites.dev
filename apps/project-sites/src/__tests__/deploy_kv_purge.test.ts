/**
 * Forward-causal lock for `POST /api/sites/:id/deploy` (the ZIP-deploy publish path).
 *
 * Before fire-172 the real deploy handler had NO route-layer test — `middleware.test.ts` only
 * exercises a STUB handler for the 50MB payload limit. So the effects that make a deploy actually go
 * LIVE were unasserted. The load-bearing one is the SAME cache-bust class as publish-bolt (fire-164)
 * and DELETE (fire-170): after writing the new build to R2 and flipping the DB to `published@version`,
 * the handler MUST PURGE the owned slug's host KV entry — otherwise the 60s host→site manifest cache
 * keeps serving the OLD build for up to a minute after a deploy (user-visible: "I deployed but the
 * site still shows the old version"). A regression dropping that purge passes every other test.
 *
 * Harness mirrors `publish_bolt_ownership.test.ts`: a prepare/bind DB mock (requireOwnedSite reads it
 * via the real `dbQueryOne`), capturing r2Puts / kvDeletes / dbRuns; a real JSZip + multipart request.
 */
import { Hono } from 'hono';
import JSZip from 'jszip';
import type { Env, Variables } from '../types/env.js';
import { api } from '../routes/api.js';
import { errorHandler } from '../middleware/error_handler.js';

interface SiteRow {
  id: string;
  slug: string;
  org_id: string;
}

/** Mock env: the DB answers `requireOwnedSite`'s `SELECT … FROM sites WHERE id = ? AND org_id = ?`. */
function makeEnv(site: SiteRow | null) {
  const r2Puts: string[] = [];
  const kvDeletes: string[] = [];
  const dbRuns: { sql: string; params: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const isSiteLookup = /FROM sites WHERE id = \?/.test(sql);
          return {
            first: async () => (isSiteLookup ? site : null),
            all: async () => ({ results: isSiteLookup && site ? [site] : [] }),
            run: async () => {
              dbRuns.push({ sql, params });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const SITES_BUCKET = {
    put: jest.fn(async (key: string) => {
      r2Puts.push(key);
      return {} as R2Object;
    }),
  };
  const CACHE_KV = {
    delete: jest.fn(async (key: string) => {
      kvDeletes.push(key);
    }),
  };
  return { env: { DB, SITES_BUCKET, CACHE_KV } as unknown as Env, r2Puts, kvDeletes, dbRuns };
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
  return (path: string, body: FormData) =>
    app.request(path, { method: 'POST', body }, { ...({} as Env), ...env } as Env, ctx);
}

/** A real multipart form carrying a real ZIP built from the given {path: content} map. */
async function zipForm(files: Record<string, string>): Promise<FormData> {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(files)) zip.file(p, content);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  const fd = new FormData();
  fd.append('zip', new File([buf], 'site.zip', { type: 'application/zip' }));
  return fd;
}

const OWNED: SiteRow = { id: 's1', slug: 'acme', org_id: 'owner-org' };

describe('POST /api/sites/:id/deploy — the ZIP-deploy causal chain (publish + cache-bust)', () => {
  it('401 when unauthenticated', async () => {
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, {})(
      '/api/sites/s1/deploy',
      await zipForm({ 'dist/index.html': '<h1>x</h1>' }),
    );
    expect(res.status).toBe(401);
  });

  it('404 for a foreign / unowned site (requireOwnedSite — never leaks, never deploys)', async () => {
    const { env, r2Puts } = makeEnv(null); // ownership SELECT returns nothing
    const res = await makeApp(env, { orgId: 'attacker-org', userId: 'a' })(
      '/api/sites/s1/deploy',
      await zipForm({ 'dist/index.html': '<h1>x</h1>' }),
    );
    expect(res.status).toBe(404);
    expect(r2Puts).toEqual([]); // nothing written to the victim's R2
  });

  it('400 when no ZIP is provided', async () => {
    const { env } = makeEnv(OWNED);
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'u' })(
      '/api/sites/s1/deploy',
      new FormData(),
    );
    expect(res.status).toBe(400);
  });

  it('200 deploys the build AND purges the owned host cache so the NEW build serves immediately', async () => {
    const { env, r2Puts, kvDeletes, dbRuns } = makeEnv(OWNED);
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'u' })(
      '/api/sites/s1/deploy',
      await zipForm({ 'dist/index.html': '<h1>edited build</h1>' }),
    );
    expect(res.status).toBe(200);
    // (1) The extracted file lands under the OWNED slug's versioned R2 prefix (dist/ stripped).
    expect(r2Puts.some((k) => k.startsWith('sites/acme/') && k.endsWith('/index.html'))).toBe(true);
    // (2) D1 flips to published + advances current_build_version for the OWNED id.
    const update = dbRuns.find((r) => /UPDATE sites SET status = 'published'/.test(r.sql));
    expect(update).toBeDefined();
    expect(update!.params[1]).toBe('s1');
    // (3) THE cache-bust: the host KV entry is purged so the next request serves the fresh build
    //     (a dropped purge would serve the prior build from the 60s cache — the untested gap).
    expect(kvDeletes).toContain('host:acme.projectsites.dev');
  });
});
