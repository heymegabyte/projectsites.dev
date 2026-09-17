import { describe, expect, it } from 'vitest';
import {
  deriveRoutes,
  deriveWrangler,
  fileToRoute,
  scaffoldFunction,
  stripJsonComments,
} from './functions-panel-logic';
import type { FileMap } from '~/lib/stores/files';

/*
 * WORK_DIR is a runtime value — vite-tsconfig-paths does NOT rewrite the `~/`
 * alias for value imports inside a .spec.ts under vitest (only the type import
 * above survives, since types are erased at transform). Import it relatively so
 * the spec loads; the other workbench specs sidestep this by only importing `./`
 * siblings.
 */
// eslint-disable-next-line no-restricted-imports
import { WORK_DIR } from '../../utils/constants';

/**
 * Regression for AL-004 (Brian directive 2026-09-05): the Functions tab rendered
 * hardcoded MOCK_ROUTES/MOCK_BINDINGS. It now derives the route table + bindings
 * from the OPEN project's real `functions/` folder + `wrangler.jsonc` in the
 * workbench file store. These lock that derivation (the panel just renders it).
 */

const file = (content: string) => ({ type: 'file' as const, content, isBinary: false });

const FILES: FileMap = {
  // Real Pages Functions (mirrors template.projectsites.dev/functions)
  [`${WORK_DIR}/functions/api/contact.ts`]: file(
    'export const onRequestPost: PagesFunction = async (ctx) => { await ctx.env.DB.prepare("…"); };',
  ),
  [`${WORK_DIR}/functions/api/hello.ts`]: file(
    'export const onRequestGet: PagesFunction = async () => new Response("hi");',
  ),
  [`${WORK_DIR}/functions/api/ai/chat.ts`]: file('export const onRequestPost = async () => {};'),
  [`${WORK_DIR}/functions/api/[id].ts`]: file(
    'export const onRequestGet = async () => {}; export const onRequestDelete = async () => {};',
  ),
  [`${WORK_DIR}/functions/api/_middleware.ts`]: file('export const onRequest = async (ctx) => ctx.next();'),

  // Non-code artefacts under functions/ must be ignored
  [`${WORK_DIR}/functions/_routes.json`]: file('{ "version": 1, "include": ["/api/*"] }'),
  [`${WORK_DIR}/functions/README.md`]: file('# functions'),

  // A file OUTSIDE functions/ must never become a route
  [`${WORK_DIR}/src/app.tsx`]: file('export default function App() {}'),

  // wrangler.jsonc with comments + real binding blocks
  [`${WORK_DIR}/wrangler.jsonc`]: file(`{
    // the site worker
    "name": "vanta-strength-site",
    "compatibility_date": "2026-06-30",
    "d1_databases": [{ "binding": "DB", "database_name": "vanta_db" }],
    "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "vanta_media" }],
    "vars": { "PUBLIC_MODE": "live" }
  }`),
};

describe('FunctionsPanel — fileToRoute', () => {
  it('maps Pages Function files to their served routes', () => {
    expect(fileToRoute('/api/contact.ts')).toBe('/api/contact');
    expect(fileToRoute('/api/ai/chat.ts')).toBe('/api/ai/chat');
    expect(fileToRoute('/api/index.ts')).toBe('/api');
    expect(fileToRoute('/api/[id].ts')).toBe('/api/:id');
    expect(fileToRoute('/api/[[catchall]].ts')).toBe('/api/*');
    expect(fileToRoute('/index.ts')).toBe('/');
  });
});

describe('FunctionsPanel — deriveRoutes (from real functions/ file map)', () => {
  const routes = deriveRoutes(FILES, new Set(['DB', 'BUCKET']));

  it('derives one route per code file, ignoring _routes.json / README / non-functions files', () => {
    const paths = routes.map((r) => r.path).sort();
    expect(paths).toEqual(['/api/*', '/api/ai/chat', '/api/contact', '/api/hello', '/api/:id'].sort());
    expect(routes.some((r) => r.handlerFile.includes('src/app'))).toBe(false); // outside functions/ never routed
    expect(routes.some((r) => r.handlerFile.includes('_routes.json'))).toBe(false); // json ignored
  });

  it('parses HTTP methods from the onRequest{Method} exports', () => {
    expect(routes.find((r) => r.path === '/api/contact')?.methods).toEqual(['POST']);
    expect(routes.find((r) => r.path === '/api/hello')?.methods).toEqual(['GET']);
    expect(routes.find((r) => r.path === '/api/:id')?.methods.sort()).toEqual(['DELETE', 'GET']);
  });

  it('treats a bare onRequest (middleware) as ALL verbs + a /* scope', () => {
    const mw = routes.find((r) => r.handlerFile.endsWith('_middleware.ts'));
    expect(mw?.methods).toContain('ALL');
    expect(mw?.path).toBe('/api/*');
  });

  it('flags which declared resources (env.X) a handler references', () => {
    expect(routes.find((r) => r.path === '/api/contact')?.usesResources).toEqual(['DB']);
    expect(routes.find((r) => r.path === '/api/hello')?.usesResources).toEqual([]);
  });
});

describe('FunctionsPanel — deriveWrangler (bindings + script from wrangler.jsonc)', () => {
  it('strips comments and parses the real bindings + script + compat date', () => {
    const { bindings, script, compatDate } = deriveWrangler(FILES);
    expect(script).toBe('vanta-strength-site');
    expect(compatDate).toBe('2026-06-30');

    const byName = Object.fromEntries(bindings.map((b) => [b.name, b.type]));
    expect(byName).toEqual({ DB: 'd1', BUCKET: 'r2', PUBLIC_MODE: 'env' });
  });

  it('returns empty (never throws) when no wrangler config is present', () => {
    expect(deriveWrangler({})).toEqual({ bindings: [], script: null, compatDate: null });
  });

  it('stripJsonComments removes // and block comments without corrupting URL values', () => {
    const out = stripJsonComments('{ "a": 1, // c\n "url": "http://x" }');
    expect(JSON.parse(out)).toEqual({ a: 1, url: 'http://x' });
  });
});

describe('FunctionsPanel — scaffoldFunction (the "create a function" control)', () => {
  const ok = (r: ReturnType<typeof scaffoldFunction>) => {
    if ('error' in r) {
      throw new Error(`expected success, got error: ${r.error}`);
    }

    return r;
  };

  it('a bare name scaffolds under api/ → the right file, route, and onRequestGet handler', () => {
    const r = ok(scaffoldFunction('contact'));
    expect(r.path).toBe(`${WORK_DIR}/functions/api/contact.ts`);
    expect(r.route).toBe('/api/contact');
    expect(r.content).toContain('export async function onRequestGet');
    expect(r.content).toContain('route: "/api/contact"');

    // The scaffold is a REAL route the panel's own deriver picks up (GET method).
    const derived = deriveRoutes({ [r.path]: file(r.content) }, new Set());
    expect(derived[0].path).toBe('/api/contact');
    expect(derived[0].methods).toEqual(['GET']);
  });

  it('an explicit folder path is respected (not force-prefixed with api/)', () => {
    expect(ok(scaffoldFunction('webhooks/stripe')).path).toBe(`${WORK_DIR}/functions/webhooks/stripe.ts`);
    expect(ok(scaffoldFunction('webhooks/stripe')).route).toBe('/webhooks/stripe');
    expect(ok(scaffoldFunction('api/booking')).path).toBe(`${WORK_DIR}/functions/api/booking.ts`);
  });

  it('normalizes a typed extension / slashes / case', () => {
    expect(ok(scaffoldFunction('/API/Hello.ts/')).path).toBe(`${WORK_DIR}/functions/api/hello.ts`);
  });

  it('rejects empty, unsafe, and colliding names', () => {
    expect('error' in scaffoldFunction('')).toBe(true);
    expect('error' in scaffoldFunction('  ')).toBe(true);
    expect('error' in scaffoldFunction('has spaces')).toBe(true);
    expect('error' in scaffoldFunction('../etc/passwd')).toBe(true);

    const existing: FileMap = { [`${WORK_DIR}/functions/api/contact.ts`]: file('x') };
    const collision = scaffoldFunction('contact', existing);
    expect('error' in collision && collision.error).toContain('already exists');
  });
});

describe('FunctionsPanel — delete route drops it from the live-derived table (AL-721)', () => {
  /*
   * The panel's delete control calls workbenchStore.deleteFile(handlerFile) then clears the
   * selection; the route table is deriveRoutes(files) so it re-renders WITHOUT the deleted route.
   * This locks that contract purely (the editor test env is pure-logic-only — no component render).
   */
  it('deriveRoutes no longer yields a route once its functions/ file is removed', () => {
    const before = deriveRoutes(FILES, new Set(['DB', 'BUCKET']));
    expect(before.some((r) => r.path === '/api/contact')).toBe(true);

    // Simulate the delete: workbenchStore.deleteFile removes the handler from the file map.
    const afterDelete: FileMap = { ...FILES };
    delete afterDelete[`${WORK_DIR}/functions/api/contact.ts`];

    const after = deriveRoutes(afterDelete, new Set(['DB', 'BUCKET']));
    expect(after.some((r) => r.path === '/api/contact')).toBe(false);
    expect(after.length).toBe(before.length - 1); // exactly that one route dropped
  });
});
