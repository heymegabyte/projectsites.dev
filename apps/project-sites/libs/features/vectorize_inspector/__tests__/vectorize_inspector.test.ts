/**
 * Unit + route-layer tests for the vectorize_inspector feature module.
 *
 * All external deps are mocked — the D1 super-admin lookup (`dbQueryOne`), the feature
 * flag, and the Cloudflare v2 REST API (global `fetch`). The real `resolveCfCredentials`
 * runs with `orgId=null`, so it reads the worker-bundled `CLOUDFLARE_*` env vars (no DB).
 * Mirrors kv_inspector / r2_inspector:
 *   - flag off / unauthenticated / non-super-admin → 404 (never leak existence)
 *   - list → indexes mapped (name/dimensions/metric/…); CF failure → available:false (never fake empty)
 *   - describe → config + vectorCount (from /info); unknown index → found:false; bad slug → 404
 *   - credentials stay server-side: the X-Auth headers + server account id go to CF, not the client
 */

import { Hono } from 'hono';

// ─── Mocks (must precede handler imports) ────────────────────────────────────
const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockDbQueryOne = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
}));

import { vectorizeInspector } from '../handlers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
type AppEnv = {
  DB: unknown;
  CF_ACCOUNT_ID: string;
  CLOUDFLARE_EMAIL: string;
  CLOUDFLARE_API_KEY: string;
};

function appWith(userId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', vectorizeInspector);
  return app;
}

function makeEnv(): AppEnv {
  return { DB: {}, CF_ACCOUNT_ID: 'acct-123', CLOUDFLARE_EMAIL: 'e@x.com', CLOUDFLARE_API_KEY: 'gk' };
}

async function req(app: Hono, path: string, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(path, {}, env as never);
}

const mockFetch = jest.fn();

function cfResp(status: number, result: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ success: status < 400, result }),
  } as unknown as Response);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockDbQueryOne.mockResolvedValue({ is_super_admin: 1, email: 'brian@megabyte.space' });
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockResolvedValue(cfResp(200, []));
});

describe('GET /api/admin/vectorize/indexes — gating', () => {
  it('404 when flag off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await req(appWith('u'), '/api/admin/vectorize/indexes')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when unauthenticated', async () => {
    expect((await req(appWith(), '/api/admin/vectorize/indexes')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when NOT super-admin (CF never called)', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await req(appWith('owner'), '/api/admin/vectorize/indexes')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/vectorize/indexes — list', () => {
  it('maps CF indexes + sends server-side global-key auth to the account v2 REST path', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, [
        { name: 'projectsites-rag', description: 'RAG', created_on: '2026-01-01', modified_on: '2026-02-01', config: { dimensions: 768, metric: 'cosine' } },
        { name: 'crew-skills-v1', config: { dimensions: 1024, metric: 'cosine' } },
      ]),
    );
    const res = await req(appWith('super-1'), '/api/admin/vectorize/indexes');
    expect(res.status).toBe(200);
    const body = await res.json<{ available: boolean; indexes: { name: string; dimensions: number | null; metric: string | null }[] }>();
    expect(body.available).toBe(true);
    expect(body.indexes).toHaveLength(2);
    expect(body.indexes[0]).toEqual({ name: 'projectsites-rag', dimensions: 768, metric: 'cosine', description: 'RAG', created: '2026-01-01', modified: '2026-02-01' });
    // Credentials + account stay server-side: the CF call carries the global-key headers + our account id.
    const [url, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/vectorize/v2/indexes');
    expect(opts.headers['X-Auth-Email']).toBe('e@x.com');
    expect(opts.headers['X-Auth-Key']).toBe('gk');
  });

  it('honest available:false (never a fabricated empty list) when the CF API fails', async () => {
    mockFetch.mockResolvedValue(cfResp(403, null));
    const res = await req(appWith('super-1'), '/api/admin/vectorize/indexes');
    expect(res.status).toBe(200);
    const body = await res.json<{ available: boolean; indexes: unknown[]; reason: string }>();
    expect(body.available).toBe(false);
    expect(body.indexes).toEqual([]);
    expect(body.reason).toBe('cf_403');
  });

  it('available:false with no_credentials when the worker has no CF key', async () => {
    const env = { ...makeEnv(), CLOUDFLARE_API_KEY: '', CLOUDFLARE_EMAIL: '' } as AppEnv;
    const res = await req(appWith('super-1'), '/api/admin/vectorize/indexes', env);
    const body = await res.json<{ available: boolean; reason: string }>();
    expect(body.available).toBe(false);
    expect(body.reason).toBe('no_credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/vectorize/indexes/:name — describe', () => {
  it('404 for a non-slug name (no REST-path injection)', async () => {
    expect((await req(appWith('super-1'), '/api/admin/vectorize/indexes/bad%2Fname')).status).toBe(404);
  });

  it('describes an index with config + vectorCount from /info', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/info')) return cfResp(200, { vectorCount: 4210, processedUpToMutation: 'm-9' });
      return cfResp(200, { name: 'projectsites-rag', description: 'RAG', config: { dimensions: 768, metric: 'cosine' } });
    });
    const res = await req(appWith('super-1'), '/api/admin/vectorize/indexes/projectsites-rag');
    expect(res.status).toBe(200);
    const body = await res.json<{ found: boolean; dimensions: number; metric: string; vectorCount: number; processedUpToMutation: string }>();
    expect(body.found).toBe(true);
    expect(body.dimensions).toBe(768);
    expect(body.metric).toBe('cosine');
    expect(body.vectorCount).toBe(4210);
    expect(body.processedUpToMutation).toBe('m-9');
  });

  it('found:false for an unknown index (CF 404 — never a fabricated index)', async () => {
    mockFetch.mockResolvedValue(cfResp(404, null));
    const res = await req(appWith('super-1'), '/api/admin/vectorize/indexes/does-not-exist');
    expect(res.status).toBe(200);
    const body = await res.json<{ found: boolean }>();
    expect(body.found).toBe(false);
  });

  it('vectorCount null (never fabricated) when /info is unavailable but describe succeeds', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/info')) return cfResp(500, null);
      return cfResp(200, { name: 'x', config: { dimensions: 1024, metric: 'cosine' } });
    });
    const res = await req(appWith('super-1'), '/api/admin/vectorize/indexes/x');
    const body = await res.json<{ found: boolean; vectorCount: number | null }>();
    expect(body.found).toBe(true);
    expect(body.vectorCount).toBeNull();
  });
});
