/**
 * Unit + route-layer tests for the d1_manager feature module.
 *
 * All external deps are mocked — the D1 super-admin lookup (`dbQueryOne`), the feature flag,
 * and the Cloudflare D1 REST API (global `fetch`). The real `resolveCfCredentials` runs with
 * `orgId=null`, so it reads the worker-bundled `CLOUDFLARE_*` env vars (no DB).
 * Mirrors vectorize_inspector:
 *   - flag off / unauthenticated / non-super-admin → 404 (never leak existence); CF never called
 *   - list → databases mapped (id/name/created/version); CF failure → available:false (never fake empty)
 *   - overview → metadata (fileSize/numTables/region/readReplication); unknown → found:false; bad id → 404
 *   - credentials stay server-side: the X-Auth headers + server account id go to CF, not the client
 *   - metrics are null (never a fabricated 0) when the CF API omits them
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

import { d1Manager } from '../handlers.js';

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
  app.route('/', d1Manager);
  return app;
}

function makeEnv(): AppEnv {
  return { DB: {}, CF_ACCOUNT_ID: 'acct-123', CLOUDFLARE_EMAIL: 'e@x.com', CLOUDFLARE_API_KEY: 'gk' };
}

async function req(app: Hono, path: string, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(path, {}, env as never);
}

const REAL_UUID = 'ea3e839a-c641-4861-ae30-dfc63bff8032';

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

describe('GET /api/admin/d1/databases — gating', () => {
  it('404 when flag off (CF never called)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await req(appWith('u'), '/api/admin/d1/databases')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when unauthenticated (CF never called)', async () => {
    expect((await req(appWith(), '/api/admin/d1/databases')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when NOT super-admin (CF never called)', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await req(appWith('owner'), '/api/admin/d1/databases')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/d1/databases — list', () => {
  it('maps CF databases + sends server-side global-key auth to the account d1 REST path', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, [
        { uuid: REAL_UUID, name: 'project-sites-db-production', created_at: '2026-01-01', version: 'production' },
        { uuid: '11111111-2222-3333-4444-555555555555', name: 'staging-db' },
      ]),
    );
    const res = await req(appWith('super-1'), '/api/admin/d1/databases');
    expect(res.status).toBe(200);
    const body = await res.json<{ available: boolean; databases: { id: string; name: string; created: string | null; version: string | null }[] }>();
    expect(body.available).toBe(true);
    expect(body.databases).toHaveLength(2);
    expect(body.databases[0]).toEqual({ id: REAL_UUID, name: 'project-sites-db-production', created: '2026-01-01', version: 'production' });
    expect(body.databases[1]).toEqual({ id: '11111111-2222-3333-4444-555555555555', name: 'staging-db', created: null, version: null });
    // Credentials + account stay server-side: the CF call carries the global-key headers + our account id.
    const [url, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database');
    expect(opts.headers['X-Auth-Email']).toBe('e@x.com');
    expect(opts.headers['X-Auth-Key']).toBe('gk');
  });

  it('honest available:false (never a fabricated empty list) when the CF API fails', async () => {
    mockFetch.mockResolvedValue(cfResp(403, null));
    const res = await req(appWith('super-1'), '/api/admin/d1/databases');
    expect(res.status).toBe(200);
    const body = await res.json<{ available: boolean; databases: unknown[]; reason: string }>();
    expect(body.available).toBe(false);
    expect(body.databases).toEqual([]);
    expect(body.reason).toBe('cf_403');
  });

  it('available:false with no_credentials when the worker has no CF key', async () => {
    const env = { ...makeEnv(), CLOUDFLARE_API_KEY: '', CLOUDFLARE_EMAIL: '' } as AppEnv;
    const res = await req(appWith('super-1'), '/api/admin/d1/databases', env);
    const body = await res.json<{ available: boolean; reason: string }>();
    expect(body.available).toBe(false);
    expect(body.reason).toBe('no_credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/d1/:databaseId/overview', () => {
  it('404 for a non-UUID id (no REST-path injection)', async () => {
    expect((await req(appWith('super-1'), '/api/admin/d1/not-a-uuid/overview')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns metadata (fileSize/numTables/region/readReplication) for a real db', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, {
        uuid: REAL_UUID,
        name: 'project-sites-db-production',
        version: 'production',
        num_tables: 42,
        file_size: 33_067_008,
        running_in_region: 'ENAM',
        read_replication: { mode: 'auto' },
      }),
    );
    const res = await req(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/overview`);
    expect(res.status).toBe(200);
    const body = await res.json<{ found: boolean; name: string; fileSize: number; numTables: number; region: string; readReplication: string }>();
    expect(body.found).toBe(true);
    expect(body.name).toBe('project-sites-db-production');
    expect(body.fileSize).toBe(33_067_008);
    expect(body.numTables).toBe(42);
    expect(body.region).toBe('ENAM');
    expect(body.readReplication).toBe('auto');
    // the id is interpolated into the path — verify no injection + correct path
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/${REAL_UUID}`);
  });

  it('found:false for an unknown database (CF 404 — never a fabricated database)', async () => {
    mockFetch.mockResolvedValue(cfResp(404, null));
    const res = await req(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/overview`);
    expect(res.status).toBe(200);
    const body = await res.json<{ found: boolean }>();
    expect(body.found).toBe(false);
  });

  it('metrics null (never a fabricated 0) when the CF API omits them', async () => {
    mockFetch.mockResolvedValue(cfResp(200, { uuid: REAL_UUID, name: 'x', version: 'production' }));
    const res = await req(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/overview`);
    const body = await res.json<{ found: boolean; fileSize: number | null; numTables: number | null; region: string | null; readReplication: string | null }>();
    expect(body.found).toBe(true);
    expect(body.fileSize).toBeNull();
    expect(body.numTables).toBeNull();
    expect(body.region).toBeNull();
    expect(body.readReplication).toBeNull();
  });
});
