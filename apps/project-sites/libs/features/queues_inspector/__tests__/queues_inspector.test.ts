/**
 * Unit + route-layer tests for the queues_inspector feature module.
 *
 * Mocks the D1 super-admin lookup (`dbQueryOne`), the feature flag, and the Cloudflare
 * account REST API (global `fetch`). The real `resolveCfCredentials` runs with `orgId=null`,
 * reading the worker-bundled `CLOUDFLARE_*` env vars (no DB). Mirrors kv/r2/vectorize:
 *   - flag off / unauthenticated / non-super-admin → 404 (never leak existence)
 *   - list → queues mapped (id/name/producers/consumers); CF failure → available:false (never fake empty)
 *   - describe → settings + producers/consumers; unknown id → found:false; bad slug → 404
 *   - credentials stay server-side: X-Auth headers + server account id go to CF, not the client
 */

import { Hono } from 'hono';

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockDbQueryOne = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
}));

import { queuesInspector } from '../handlers.js';

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
  app.route('/', queuesInspector);
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

describe('GET /api/admin/queues — gating', () => {
  it('404 when flag off (CF never called)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await req(appWith('u'), '/api/admin/queues')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when unauthenticated', async () => {
    expect((await req(appWith(), '/api/admin/queues')).status).toBe(404);
  });
  it('404 when NOT super-admin (CF never called)', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await req(appWith('owner'), '/api/admin/queues')).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/queues — list', () => {
  it('maps queues + sends server-side global-key auth to the account REST path', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, [
        { queue_id: 'q1', queue_name: 'gitlink-jobs', created_on: '2026-01-01', modified_on: '2026-02-01', producers: [{ type: 'worker', script: 'p' }], consumers: [{ type: 'worker', script: 'c' }] },
        { queue_id: 'q2', queue_name: 'grants-dlq', producers: [], consumers: [] },
      ]),
    );
    const res = await req(appWith('super-1'), '/api/admin/queues');
    expect(res.status).toBe(200);
    const body = await res.json<{ available: boolean; queues: { id: string; name: string; producers: number; consumers: number }[] }>();
    expect(body.available).toBe(true);
    expect(body.queues).toHaveLength(2);
    expect(body.queues[0]).toEqual({ id: 'q1', name: 'gitlink-jobs', producers: 1, consumers: 1, created: '2026-01-01', modified: '2026-02-01' });
    const [url, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/queues');
    expect(opts.headers['X-Auth-Email']).toBe('e@x.com');
    expect(opts.headers['X-Auth-Key']).toBe('gk');
  });

  it('honest available:false (never a fabricated empty list) when the CF API fails', async () => {
    mockFetch.mockResolvedValue(cfResp(403, null));
    const body = await (await req(appWith('super-1'), '/api/admin/queues')).json<{ available: boolean; queues: unknown[]; reason: string }>();
    expect(body.available).toBe(false);
    expect(body.queues).toEqual([]);
    expect(body.reason).toBe('cf_403');
  });

  it('available:false with no_credentials when the worker has no CF key', async () => {
    const env = { ...makeEnv(), CLOUDFLARE_API_KEY: '', CLOUDFLARE_EMAIL: '' } as AppEnv;
    const body = await (await req(appWith('super-1'), '/api/admin/queues', env)).json<{ available: boolean; reason: string }>();
    expect(body.available).toBe(false);
    expect(body.reason).toBe('no_credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/queues/:id — describe', () => {
  it('404 for a non-slug id (no REST-path injection)', async () => {
    expect((await req(appWith('super-1'), '/api/admin/queues/bad%2Fid')).status).toBe(404);
  });

  it('describes a queue with settings + producers/consumers (worker script)', async () => {
    mockFetch.mockResolvedValue(
      cfResp(200, {
        queue_id: 'q1',
        queue_name: 'gitlink-jobs',
        settings: { delivery_delay: 0, message_retention_period: 345600 },
        producers: [{ type: 'worker', script: 'gitlink-api' }],
        consumers: [{ type: 'worker', script: 'gitlink-worker' }],
      }),
    );
    const res = await req(appWith('super-1'), '/api/admin/queues/q1');
    expect(res.status).toBe(200);
    const body = await res.json<{ found: boolean; name: string; settings: { messageRetentionSeconds: number }; consumers: { type: string; script: string }[] }>();
    expect(body.found).toBe(true);
    expect(body.name).toBe('gitlink-jobs');
    expect(body.settings.messageRetentionSeconds).toBe(345600);
    expect(body.consumers[0]).toEqual({ type: 'worker', script: 'gitlink-worker' });
  });

  it('found:false for an unknown queue (CF 404 — never a fabricated queue)', async () => {
    mockFetch.mockResolvedValue(cfResp(404, null));
    const body = await (await req(appWith('super-1'), '/api/admin/queues/does-not-exist')).json<{ found: boolean }>();
    expect(body.found).toBe(false);
  });
});
