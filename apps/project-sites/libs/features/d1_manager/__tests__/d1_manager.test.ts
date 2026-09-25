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
  return {
    DB: {},
    CF_ACCOUNT_ID: 'acct-123',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CLOUDFLARE_API_KEY: 'gk',
  };
}

async function req(app: Hono, path: string, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(path, {}, env as never);
}

async function postReq(
  app: Hono,
  path: string,
  body: unknown = {},
  env: AppEnv = makeEnv(),
): Promise<Response> {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env as never,
  );
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

/** A CF `/query` OK response: `result` is an ARRAY of per-statement `{ results, success, meta }`. */
function cfQueryResp(rows: unknown[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [{ results: rows, success: true, meta: {} }] }),
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
        {
          uuid: REAL_UUID,
          name: 'project-sites-db-production',
          created_at: '2026-01-01',
          version: 'production',
        },
        { uuid: '11111111-2222-3333-4444-555555555555', name: 'staging-db' },
      ]),
    );
    const res = await req(appWith('super-1'), '/api/admin/d1/databases');
    expect(res.status).toBe(200);
    const body = await res.json<{
      available: boolean;
      databases: { id: string; name: string; created: string | null; version: string | null }[];
    }>();
    expect(body.available).toBe(true);
    expect(body.databases).toHaveLength(2);
    expect(body.databases[0]).toEqual({
      id: REAL_UUID,
      name: 'project-sites-db-production',
      created: '2026-01-01',
      version: 'production',
    });
    expect(body.databases[1]).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      name: 'staging-db',
      created: null,
      version: null,
    });
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
    const body = await res.json<{
      found: boolean;
      name: string;
      fileSize: number;
      numTables: number;
      region: string;
      readReplication: string;
    }>();
    expect(body.found).toBe(true);
    expect(body.name).toBe('project-sites-db-production');
    expect(body.fileSize).toBe(33_067_008);
    expect(body.numTables).toBe(42);
    expect(body.region).toBe('ENAM');
    expect(body.readReplication).toBe('auto');
    // the id is interpolated into the path — verify no injection + correct path
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/${REAL_UUID}`,
    );
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
    const body = await res.json<{
      found: boolean;
      fileSize: number | null;
      numTables: number | null;
      region: string | null;
      readReplication: string | null;
    }>();
    expect(body.found).toBe(true);
    expect(body.fileSize).toBeNull();
    expect(body.numTables).toBeNull();
    expect(body.region).toBeNull();
    expect(body.readReplication).toBeNull();
  });
});

describe('GET /api/admin/d1/:databaseId/tables — schema catalog', () => {
  it('404 when flag off / unauth / non-super-admin (CF never called)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await req(appWith('u'), `/api/admin/d1/${REAL_UUID}/tables`)).status).toBe(404);
    mockIsFlagOn.mockResolvedValue(true);
    expect((await req(appWith(), `/api/admin/d1/${REAL_UUID}/tables`)).status).toBe(404);
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await req(appWith('owner'), `/api/admin/d1/${REAL_UUID}/tables`)).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('404 for a non-UUID id (no REST-path injection)', async () => {
    expect((await req(appWith('super-1'), '/api/admin/d1/not-a-uuid/tables')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps sqlite_master → typed objects + per-type counts; runs the catalog query on /query', async () => {
    mockFetch.mockResolvedValue(
      cfQueryResp([
        {
          type: 'table',
          name: 'users',
          tbl_name: 'users',
          sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)',
        },
        {
          type: 'view',
          name: 'active_users',
          tbl_name: 'active_users',
          sql: 'CREATE VIEW active_users AS SELECT 1',
        },
        {
          type: 'index',
          name: 'idx_users_email',
          tbl_name: 'users',
          sql: 'CREATE INDEX idx_users_email ON users(email)',
        },
        {
          type: 'trigger',
          name: 'trg_users',
          tbl_name: 'users',
          sql: 'CREATE TRIGGER trg_users AFTER INSERT ON users BEGIN SELECT 1; END',
        },
      ]),
    );
    const res = await req(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/tables`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      found: boolean;
      objects: { type: string; name: string; tableName: string; sql: string | null }[];
      counts: { table: number; view: number; index: number; trigger: number };
    }>();
    expect(body.found).toBe(true);
    expect(body.objects).toHaveLength(4);
    expect(body.objects[0]).toEqual({
      type: 'table',
      name: 'users',
      tableName: 'users',
      sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)',
    });
    expect(body.counts).toEqual({ table: 1, view: 1, index: 1, trigger: 1 });
    // Static catalog SELECT posted to the /query endpoint; credentials + account stay server-side.
    const [url, opts] = mockFetch.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/${REAL_UUID}/query`,
    );
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).sql).toContain('FROM sqlite_master');
    expect(opts.headers['X-Auth-Key']).toBe('gk');
  });

  it('found:false on a CF 404 (unknown database — never a fabricated catalog)', async () => {
    mockFetch.mockResolvedValue(cfResp(404, null));
    const res = await req(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/tables`);
    const body = await res.json<{ found: boolean; objects: unknown[] }>();
    expect(body.found).toBe(false);
    expect(body.objects).toEqual([]);
  });

  it('available:false (never a fabricated catalog) when the CF API fails', async () => {
    mockFetch.mockResolvedValue(cfResp(403, null));
    const res = await req(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/tables`);
    const body = await res.json<{ found: boolean; available: boolean; reason: string }>();
    expect(body.found).toBe(false);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('cf_403');
  });
});

describe('POST /api/admin/d1/:databaseId/export', () => {
  it('404 when flag off / unauth / non-super-admin (CF never called)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await postReq(appWith('u'), `/api/admin/d1/${REAL_UUID}/export`)).status).toBe(404);
    mockIsFlagOn.mockResolvedValue(true);
    expect((await postReq(appWith(), `/api/admin/d1/${REAL_UUID}/export`)).status).toBe(404);
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await postReq(appWith('owner'), `/api/admin/d1/${REAL_UUID}/export`)).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('404 for a non-UUID id (no REST-path injection); 400 for a hostile table name', async () => {
    expect((await postReq(appWith('super-1'), '/api/admin/d1/not-a-uuid/export')).status).toBe(404);
    const bad = await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`, {
      tables: ['users); DROP TABLE users;--'],
    });
    expect(bad.status).toBe(400); // rejected at the Zod boundary, never reaches CF
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('completes: returns the signed URL + filename + honest note when CF reports complete', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, {
        at_bookmark: 'bm-final',
        status: 'complete',
        result: { signed_url: 'https://cf-storage/dump.sql?sig=x', filename: 'db-export.sql' },
      }),
    );
    const res = await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      status: string;
      signedUrl: string;
      filename: string;
      note: string;
    }>();
    expect(body.status).toBe('complete');
    expect(body.signedUrl).toBe('https://cf-storage/dump.sql?sig=x');
    expect(body.filename).toBe('db-export.sql');
    expect(body.note).toContain('unavailable'); // the honest DB-unavailability caveat, always present
    // credentials stay server-side + the export POSTs polling to the account d1 export path
    const [url, opts] = mockFetch.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/${REAL_UUID}/export`,
    );
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ output_format: 'polling' });
    expect(opts.headers['X-Auth-Key']).toBe('gk');
  });

  it('scopes the export to specific tables via dump_options.tables', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, {
        at_bookmark: 'b',
        status: 'complete',
        result: { signed_url: 'u', filename: 'f' },
      }),
    );
    await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`, {
      tables: ['form_submissions'],
      dataOnly: true,
    });
    const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body)).toEqual({
      output_format: 'polling',
      dump_options: { tables: ['form_submissions'], no_schema: true },
    });
  });

  it('processing: bounded-polls then hands back the bookmark to resume (never blocks forever)', async () => {
    mockFetch.mockResolvedValue(cfResp(200, { at_bookmark: 'bm-1', status: 'processing' })); // never completes
    const res = await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`);
    const body = await res.json<{ status: string; bookmark: string }>();
    expect(body.status).toBe('processing');
    expect(body.bookmark).toBe('bm-1');
    expect(mockFetch).toHaveBeenCalledTimes(6); // MAX_EXPORT_POLLS
    // polls 2..6 resume with the current_bookmark from the prior poll
    const [, opts2] = mockFetch.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(opts2.body).current_bookmark).toBe('bm-1');
  });

  it('resumes an in-progress export from a client-supplied currentBookmark', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, {
        at_bookmark: 'bm-2',
        status: 'complete',
        result: { signed_url: 'u', filename: 'f' },
      }),
    );
    await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`, {
      currentBookmark: 'bm-resume',
    });
    const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body).current_bookmark).toBe('bm-resume');
  });

  it('error: CF export error surfaces status:error (never a fabricated URL)', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, { at_bookmark: 'b', status: 'error', error: 'export blew up' }),
    );
    const res = await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`);
    const body = await res.json<{ status: string; reason: string; signedUrl?: string }>();
    expect(body.status).toBe('error');
    expect(body.reason).toBe('export blew up');
    expect(body.signedUrl).toBeUndefined();
  });

  it('unavailable (no fabricated URL) when the worker has no CF key', async () => {
    const env = { ...makeEnv(), CLOUDFLARE_API_KEY: '', CLOUDFLARE_EMAIL: '' } as AppEnv;
    const res = await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`, {}, env);
    const body = await res.json<{ status: string; reason: string }>();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toBe('no_credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('database_not_found when CF 404s the export (honest, no URL)', async () => {
    mockFetch.mockResolvedValue(cfResp(404, null));
    const res = await postReq(appWith('super-1'), `/api/admin/d1/${REAL_UUID}/export`);
    const body = await res.json<{ status: string; reason: string }>();
    expect(body.status).toBe('error');
    expect(body.reason).toBe('database_not_found');
  });
});
