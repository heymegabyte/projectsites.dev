/**
 * Cross-org publish IDOR guards for the two bolt.diy publish endpoints.
 *
 * BUG CLASS — write-to-attacker-controlled-slug (site takeover / defacement):
 *
 *  1. `POST /api/publish/bolt` (no `:id`, reachable UNAUTHENTICATED) took the
 *     target `slug` from the request BODY and, when it named an EXISTING site,
 *     overwrote that site's R2 files + `_manifest.json` current_version + purged
 *     its hostname KV — with ZERO ownership check. Any caller could POST
 *     `{ files:[…], slug:'<victim>' }` and replace another org's LIVE site with
 *     arbitrary HTML/JS. Fix: re-publish over an existing site row requires the
 *     caller's org to own it (404 non-leak otherwise); brand-new slugs stay
 *     anonymously publishable.
 *
 *  2. `POST /api/sites/:id/publish-bolt` verified org-ownership of the `:id`
 *     path param but then wrote to a body-supplied `providedSlug || site.slug`
 *     — so an owner of site A could pass `slug:'<victim>'` and overwrite site B.
 *     Fix: always publish to the verified-owned `site.slug`; ignore the body slug.
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { api } from '../routes/api.js';
import { errorHandler } from '../middleware/error_handler.js';

interface DbConfig {
  /** org_id returned for `SELECT … FROM sites WHERE slug = ?`, or null (no row). */
  siteBySlugOrg?: string | null;
  /** Row returned for `SELECT … FROM sites WHERE id = ?`, or null. */
  siteById?: { id: string; slug: string; org_id: string; business_name: string | null } | null;
}

function makeEnv(cfg: DbConfig) {
  const r2Puts: string[] = [];
  const kvDeletes: string[] = [];
  // Resolve the row a SELECT should yield (dbQueryOne reads `.all().results[0]`;
  // the mock also serves `.first()` defensively for any direct-read consumer).
  const rowFor = (sql: string): Record<string, unknown> | null => {
    if (/FROM sites WHERE slug = \?/i.test(sql)) {
      return cfg.siteBySlugOrg == null ? null : { org_id: cfg.siteBySlugOrg };
    }
    if (/FROM sites WHERE id = \?/i.test(sql)) return cfg.siteById ?? null;
    return null;
  };
  // Capture every executed write (UPDATE/INSERT) so a test can assert the causal D1 effects
  // (status flip + current_build_version advance), not just the R2/KV side effects.
  const dbRuns: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const row = rowFor(sql);
          return {
            first: async () => row,
            all: async () => ({ results: row ? [row] : [] }),
            run: async () => {
              dbRuns.push({ sql, params });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
  const SITES_BUCKET = {
    get: async () => null,
    put: jest.fn(async (key: string, body?: unknown) => {
      r2Puts.push(key);
      return {} as R2Object;
    }),
  } as unknown as Env['SITES_BUCKET'];
  const CACHE_KV = {
    delete: async (key: string) => {
      kvDeletes.push(key);
    },
  } as unknown as Env['CACHE_KV'];
  const env = { DB: db, SITES_BUCKET, CACHE_KV } as unknown as Env;
  return { env, r2Puts, kvDeletes, dbRuns };
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
  return (path: string, body: unknown) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { ...({} as Env), ...env } as Env,
      ctx,
    );
}

const FILES = [{ path: 'index.html', content: '<h1>x</h1>' }];
const CHAT = { messages: [], description: 'X', exportDate: '2026-01-01' };

describe('POST /api/publish/bolt — cross-org overwrite guard', () => {
  it('404s + writes nothing when a DIFFERENT org publishes over an existing site', async () => {
    const { env, r2Puts, kvDeletes } = makeEnv({ siteBySlugOrg: 'victim-org' });
    const res = await makeApp(env, { orgId: 'attacker-org', userId: 'attacker' })(
      '/api/publish/bolt',
      {
        files: FILES,
        chat: CHAT,
        slug: 'victim-slug',
      },
    );
    expect(res.status).toBe(404);
    expect(r2Puts).toEqual([]); // never touched the victim's R2
    expect(kvDeletes).toEqual([]); // never purged the victim's cache
  });

  it('404s + writes nothing when an UNAUTHENTICATED caller publishes over an existing site', async () => {
    const { env, r2Puts } = makeEnv({ siteBySlugOrg: 'victim-org' });
    const res = await makeApp(env, {})('/api/publish/bolt', {
      files: FILES,
      chat: CHAT,
      slug: 'victim-slug',
    });
    expect(res.status).toBe(404);
    expect(r2Puts).toEqual([]);
  });

  it('allows the OWNING org to re-publish its own existing site', async () => {
    const { env, r2Puts } = makeEnv({ siteBySlugOrg: 'victim-org' });
    const res = await makeApp(env, { orgId: 'victim-org', userId: 'owner' })('/api/publish/bolt', {
      files: FILES,
      chat: CHAT,
      slug: 'victim-slug',
    });
    expect(res.status).toBe(201);
    expect(r2Puts.some((k) => k.startsWith('sites/victim-slug/'))).toBe(true);
  });

  it('allows anonymous publish to a BRAND-NEW slug (no existing site row)', async () => {
    const { env, r2Puts } = makeEnv({ siteBySlugOrg: null });
    const res = await makeApp(env, {})('/api/publish/bolt', {
      files: FILES,
      chat: CHAT,
      slug: 'brand-new-slug',
    });
    expect(res.status).toBe(201);
    expect(r2Puts.some((k) => k.startsWith('sites/brand-new-slug/'))).toBe(true);
  });
});

describe('POST /api/publish/bolt — the root manifest must never lie about its files', () => {
  it('writes the file LIST into the root _manifest.json (no files: [] copy)', async () => {
    const { env, r2Puts } = makeEnv({});
    await makeApp(env, { orgId: null, userId: null })('/api/publish/bolt', {
      files: [{ path: 'index.html', content: '<html><h1>x</h1></html>' }],
      chat: { messages: [], description: 'X', exportDate: 'now' },
      slug: null,
    });
    const manifestPut = r2Puts.find((k) => k.endsWith('/_manifest.json'));
    expect(manifestPut).toBeDefined();
    const putCall = (env.SITES_BUCKET.put as jest.Mock).mock.calls.find((c) =>
      String(c[0]).endsWith('/_manifest.json'),
    );
    expect(putCall).toBeDefined();
    const manifestJson = JSON.parse(String(putCall[1]));
    expect(manifestJson.files).toBeInstanceOf(Array);
    expect(manifestJson.files).toHaveLength(1);
    expect(manifestJson.files[0]).toEqual({
      name: 'index.html',
      size: '<html><h1>x</h1></html>'.length,
      type: 'text/html',
    });
  });
});

describe('POST /api/sites/:id/publish-bolt — write target is the OWNED slug, not the body slug', () => {
  it('ignores an attacker-supplied body slug and writes only to the owned site slug', async () => {
    const { env, r2Puts, kvDeletes } = makeEnv({
      siteById: {
        id: 'site-a-id',
        slug: 'site-a-slug',
        org_id: 'attacker-org',
        business_name: 'A',
      },
    });
    const res = await makeApp(env, { orgId: 'attacker-org', userId: 'attacker' })(
      '/api/sites/site-a-id/publish-bolt',
      { files: FILES, chat: CHAT, slug: 'victim-slug' },
    );
    expect(res.status).toBe(200);
    // Every R2 write + cache purge targets the OWNED slug, never the body slug.
    expect(r2Puts.every((k) => k.startsWith('sites/site-a-slug/'))).toBe(true);
    expect(r2Puts.some((k) => k.includes('victim-slug'))).toBe(false);
    expect(kvDeletes.every((k) => !k.includes('victim-slug'))).toBe(true);
  });
});

/**
 * The money-path EDIT leg's FORWARD causal chain (not the security axis the blocks above lock):
 * an owner edits in the embed → `publish-bolt` → the edit must actually become LIVE. The three
 * effects that make "edit → live" true, all keyed to ONE version computed once in the handler:
 *   1. D1 advances `current_build_version` to the new version + flips `status='published'`.
 *   2. The files are written under that SAME version's R2 prefix (a version drift between the
 *      DB pointer and the R2 path = the manifest points at a build with no files → nothing serves).
 *   3. The OWNED slug's host KV entry is PURGED, so the very next request resolves the fresh
 *      version instead of a 60s-stale cache — THE "the changed text is live now" guarantee.
 * A regression in any of these silently breaks edit→live while every security test stays green.
 */
describe('POST /api/sites/:id/publish-bolt — the EDIT→publish causal chain (persist · version-advance · cache-bust)', () => {
  it('advances current_build_version + publishes, writes files under that same version, and purges the owned host cache', async () => {
    const { env, r2Puts, kvDeletes, dbRuns } = makeEnv({
      siteById: { id: 'site-a-id', slug: 'site-a-slug', org_id: 'owner-org', business_name: 'A' },
    });
    const res = await makeApp(env, { orgId: 'owner-org', userId: 'owner' })(
      '/api/sites/site-a-id/publish-bolt',
      { files: [{ path: 'index.html', content: '<h1>edited copy</h1>' }], chat: CHAT, slug: null },
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { slug: string; version: string; url: string } };

    // Response reveals the live URL + the new version so the editor can surface "View Live".
    expect(payload.data.slug).toBe('site-a-slug');
    expect(payload.data.url).toBe('https://site-a-slug.projectsites.dev');
    const version = payload.data.version;
    expect(version).toBeTruthy();

    // (1) D1 causal write — status flips to published AND current_build_version binds the NEW
    //     version against the OWNED id (never a body slug / foreign id).
    const update = dbRuns.find((r) => /UPDATE sites SET status = 'published'/.test(r.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('current_build_version = ?');
    expect(update!.params).toEqual([version, 'site-a-id']);

    // (2) Version CONSISTENCY — the edited file was written under the exact version the DB now
    //     points at (handler computes `version` once + reuses it; lock that it never drifts).
    expect(r2Puts).toContain(`sites/site-a-slug/${version}/index.html`);

    // (3) Cache-bust — the owned host KV is purged so the next request serves the fresh build.
    expect(kvDeletes).toContain('host:site-a-slug.projectsites.dev');
  });
});
