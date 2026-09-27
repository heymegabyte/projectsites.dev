/**
 * Route coverage for `/api/apps/*` (convergence r46).
 *
 * Exercises every handler in {@link apps} end-to-end through the real Hono
 * app + the shared {@link errorHandler}, mocking only the boundaries:
 * the container dispatcher, the infra provisioner, AES-GCM crypto, D1, and
 * the audit log. No real APIs, Neon, Upstash, or containers are touched.
 *
 * Covered:
 *  - Catalog: list (public, cached) + `?supported=true` filter + detail 404
 *  - Auth: 401 when org context is missing (instances list/create)
 *  - Org scoping: 404 (non-leak) when an instance belongs to another org
 *  - Zod: 400 on malformed create body + bad subdomain
 *  - Provisioning dispatch: 201 create success (mocked) + provisioner error
 *    fallback + unsupported-slug 424
 *  - Lifecycle: restart / stop / delete success through the mocked dispatcher
 */

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/app_provisioner.js', () => ({
  provisionInfra: jest.fn(),
  deprovisionInfra: jest.fn().mockResolvedValue({ neon: true, upstash: true, r2: true }),
}));

jest.mock('../services/container_dispatcher.js', () => ({
  startContainer: jest.fn(),
  stopContainer: jest.fn(),
  restartContainer: jest.fn(),
  destroyContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  tailContainerLogs: jest.fn(),
  getContainerStatus: jest.fn(),
}));

jest.mock('../services/ai_crypto.js', () => ({
  encrypt: jest.fn().mockResolvedValue('cipher-blob'),
  decrypt: jest.fn().mockResolvedValue('{}'),
}));

// Mock the env resolver so the create path doesn't require real provisioned
// connection strings. We keep the real `MissingEnvError` class so the route's
// `instanceof` branch still type-checks, but `resolveAppEnv` returns a valid
// map by default.
jest.mock('../services/app_env_resolver.js', () => {
  class MissingEnvError extends Error {
    code = 'missing_env';
    constructor(
      public key: string,
      public appId: string,
    ) {
      super(`Required env var ${key} for app ${appId} could not be resolved.`);
    }
  }
  return {
    MissingEnvError,
    resolveAppEnv: jest.fn(() => ({
      DATABASE_URL: 'postgres://x',
      APP_SECRET: 's',
      HASH_SALT: 'h',
    })),
  };
});

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(),
}));

// Stub the DO-subclass module so the route import doesn't pull in the
// `@cloudflare/containers` ESM package (which jest can't transform). We
// mirror the real SUPPORTED_APP_SLUGS so the supported/unsupported
// assertions stay faithful — `umami` is supported, `matomo` is not.
jest.mock('../durable_objects/app_runtime_subclasses.js', () => {
  const SUPPORTED = [
    'umami',
    'outline',
    'n8n',
    'vaultwarden',
    'uptime-kuma',
    'nocodb',
    'listmonk',
    'memos',
    'pocketbase',
    'open-webui',
  ];
  return {
    SUPPORTED_APP_SLUGS: SUPPORTED,
    isSupportedSlug: (slug: string) => SUPPORTED.includes(slug),
  };
});

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { apps } from '../routes/apps.js';
import { writeAuditLog } from '../services/audit.js';
import { provisionInfra, deprovisionInfra } from '../services/app_provisioner.js';
import * as dispatcher from '../services/container_dispatcher.js';
import { dbQuery, dbQueryOne, dbInsert, dbUpdate, dbExecute } from '../services/db.js';

const mockProvision = provisionInfra as unknown as jest.Mock;
const mockDeprovision = deprovisionInfra as unknown as jest.Mock;
const mockStart = dispatcher.startContainer as unknown as jest.Mock;
const mockStop = dispatcher.stopContainer as unknown as jest.Mock;
const mockRestart = dispatcher.restartContainer as unknown as jest.Mock;
const mockDestroy = dispatcher.destroyContainer as unknown as jest.Mock;
const mockDbQuery = dbQuery as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockDbInsert = dbInsert as unknown as jest.Mock;
const mockDbUpdate = dbUpdate as unknown as jest.Mock;
const mockDbExecute = dbExecute as unknown as jest.Mock;
const mockAudit = writeAuditLog as unknown as jest.Mock;

// ─── Env + harness ───────────────────────────────────────────────────────────

function makeEnv(): Env {
  // In-memory CACHE_KV so the Phase-1 host-map write/clear (setAppHost /
  // clearAppHost on instance create/delete) runs instead of throwing.
  const kv = new Map<string, string>();
  return {
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    CACHE_KV: {
      get: async (k: string) => {
        const v = kv.get(k);
        return v === undefined ? null : JSON.parse(v);
      },
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    } as unknown as KVNamespace,
  } as unknown as Env;
}

/**
 * Env whose USER_DISPATCH binding returns a caller-controlled Response — lets a test drive
 * the CF-native readiness probe (probeInstanceReady dispatches to the user Worker directly).
 */
function makeDispatchEnv(probeResponse: () => Response): Env {
  return {
    ...makeEnv(),
    USER_DISPATCH: {
      get: (_name: string, _args?: unknown, _opts?: unknown) => ({
        fetch: async (_req: Request) => probeResponse(),
      }),
    },
  } as unknown as Env;
}

function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    if (vars.userRole) c.set('userRole', vars.userRole);
    await next();
  });
  app.route('/', apps);
  return app;
}

/** Minimal ExecutionContext so the handlers' `waitUntil(...)` calls work. */
function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

type AnyApp = Hono<{ Bindings: Env; Variables: Variables }>;

function req(app: AnyApp, path: string, init: RequestInit, env: Env) {
  return app.request(path, init, env, makeCtx());
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const AUTH: Partial<Variables> = { userId: 'user-1', orgId: 'org-1', requestId: 'req-1' };

/** A representative row for an instance owned by org-1. */
function instanceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    org_id: 'org-1',
    created_by: 'user-1',
    app_slug: 'umami',
    subdomain: 'my-umami',
    status: 'starting',
    env_encrypted: null,
    env_iv: null,
    neon_project_id: 'neon-1',
    upstash_database_id: null,
    r2_bucket_name: null,
    do_instance_id: 'inst-1',
    last_started_at: null,
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults — individual tests override.
  mockDbQuery.mockResolvedValue({ data: [], error: null });
  mockDbQueryOne.mockResolvedValue(null);
  mockDbInsert.mockResolvedValue({ error: null });
  mockDbUpdate.mockResolvedValue({ error: null });
  mockDbExecute.mockResolvedValue({ error: null, changes: 1 });
  mockProvision.mockResolvedValue({ needsVolume: false, postgres: { projectId: 'neon-1' } });
  mockStart.mockResolvedValue({ ok: true });
  mockStop.mockResolvedValue({ ok: true });
  mockRestart.mockResolvedValue({ ok: true });
  mockDestroy.mockResolvedValue({ ok: true });
});

// ─── Catalog (public) ────────────────────────────────────────────────────────

// ⚠️ These tests mount ONLY the `apps` router, so they exercise the marketplace
// handler at apps.ts:159 (`{apps, count}`, self-host apps: umami/…). In PROD that
// handler is SHADOWED: `index.ts:578` (the `app_launcher` feature) registers the
// same `GET /api/apps/catalog` FIRST and WINS, returning `{data}` container apps
// (plane/twenty/…). So these tests prove the marketplace handler's LOGIC, NOT the
// live routing — the two disagree on both catalog AND shape. Tracked as a `review`
// dup in scripts/check-duplicate-routes.mjs + the apps-catalog resolution in
// .claude/refactor-state.md (needs the marketplace-vs-launcher owner decision).
describe('GET /api/apps/catalog', () => {
  it('lists every catalog app with a cache header and supported flag', async () => {
    const res = await req(makeApp(), '/api/apps/catalog', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
    const json = (await res.json()) as {
      apps: Array<{ id: string; supported: boolean }>;
      count: number;
    };
    expect(json.count).toBeGreaterThan(0);
    expect(json.apps.length).toBe(json.count);
    const umami = json.apps.find((a) => a.id === 'umami');
    expect(umami?.supported).toBe(true);
  });

  it('filters to supported apps with ?supported=true', async () => {
    const res = await req(
      makeApp(),
      '/api/apps/catalog?supported=true',
      { method: 'GET' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { apps: Array<{ supported: boolean }> };
    expect(json.apps.length).toBeGreaterThan(0);
    expect(json.apps.every((a) => a.supported === true)).toBe(true);
  });
});

describe('GET /api/apps/install-counts (A5)', () => {
  it('returns DISTINCT-org counts keyed by app slug, cached, no auth', async () => {
    mockDbQuery.mockResolvedValue({
      data: [
        { app_slug: 'ghost', n: 3 },
        { app_slug: 'listmonk', n: 1 },
      ],
      error: null,
    });
    const res = await req(makeApp(), '/api/apps/install-counts', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    expect((await res.json()).counts).toEqual({ ghost: 3, listmonk: 1 });
  });

  it('soft-degrades to {} when the DB errors (catalog never breaks over counts)', async () => {
    mockDbQuery.mockResolvedValue({ data: [], error: 'boom' });
    const res = await req(makeApp(), '/api/apps/install-counts', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(200);
    expect((await res.json()).counts).toEqual({});
  });
});

describe('GET /api/apps/catalog/:id', () => {
  it('returns one catalog app by id', async () => {
    const res = await req(makeApp(), '/api/apps/catalog/umami', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { app: { id: string; supported: boolean } };
    expect(json.app.id).toBe('umami');
    expect(json.app.supported).toBe(true);
  });

  it('returns 404 for an unknown catalog id', async () => {
    const res = await req(
      makeApp(),
      '/api/apps/catalog/does-not-exist',
      { method: 'GET' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('NOT_FOUND');
  });
});

// ─── Instance list ─────────────────────────────────────────────────────────

describe('GET /api/apps/instances', () => {
  it('returns 401 when org context is missing', async () => {
    const res = await req(makeApp(), '/api/apps/instances', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('UNAUTHORIZED');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('lists the org instances with the encrypted env stripped', async () => {
    mockDbQuery.mockResolvedValue({
      data: [instanceRow({ env_encrypted: 'cipher', env_iv: 'inline' })],
      error: null,
    });
    const res = await req(makeApp(AUTH), '/api/apps/instances', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { instances: Array<Record<string, unknown>> };
    expect(json.instances).toHaveLength(1);
    expect(json.instances[0]).not.toHaveProperty('env_encrypted');
    expect(json.instances[0]).not.toHaveProperty('env_iv');
    expect(json.instances[0]['env']).toBeNull();
    // org-scoped query
    expect(mockDbQuery.mock.calls[0][2]).toEqual(['org-1']);
  });
});

// ─── Instance create ─────────────────────────────────────────────────────────

describe('POST /api/apps/instances', () => {
  it('returns 401 when org context is missing', async () => {
    const res = await req(
      makeApp(),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'umami', subdomain: 'x1' }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns 400 when the body fails Zod validation (missing app_id)', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { subdomain: 'my-umami' }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    // `.parse()` throws a ZodError → the shared handler maps it to VALIDATION_ERROR.
    expect(json.error?.code).toBe('VALIDATION_ERROR');
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns 400 when the subdomain is malformed', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'umami', subdomain: '-bad-' }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown app id', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'no-such-app', subdomain: 'my-app' }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns 424 (coming soon) for an unsupported but cataloged app id', async () => {
    // `stirling-pdf` is in the catalog but NOT in this mock`s SUPPORTED_APP_SLUGS.
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'stirling-pdf', subdomain: 'my-stirlingpdf' }),
      makeEnv(),
    );
    expect(res.status).toBe(424);
    const json = (await res.json()) as { error?: string; app_id?: string };
    expect(json.error).toBe('app_not_supported');
    expect(json.app_id).toBe('stirling-pdf');
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns 409 when the subdomain is already taken', async () => {
    mockDbQueryOne.mockResolvedValueOnce({ id: 'existing-inst' });
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'umami', subdomain: 'taken-sub' }),
      makeEnv(),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('CONFLICT');
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('provisions infra + creates the instance and returns 201', async () => {
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'umami', subdomain: 'my-umami' }),
      makeEnv(),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { instance_id: string; status: string; subdomain: string };
    expect(json.status).toBe('provisioning');
    expect(json.subdomain).toBe('my-umami');
    expect(typeof json.instance_id).toBe('string');

    expect(mockProvision).toHaveBeenCalledTimes(1);
    // provisionInfra(env, infra, { instanceId, slug })
    expect(mockProvision.mock.calls[0][2]).toMatchObject({ slug: 'umami' });
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    expect(mockDbInsert.mock.calls[0][1]).toBe('app_instances');
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'apps.instance.created',
      org_id: 'org-1',
      actor_id: 'user-1',
    });
  });

  it('rolls back infra and rethrows when provisionInfra fails', async () => {
    mockProvision.mockRejectedValueOnce(new Error('upstream boom'));
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances',
      jsonInit('POST', { app_id: 'umami', subdomain: 'my-umami' }),
      makeEnv(),
    );
    // Generic Error surfaces through the error handler as a 500.
    expect(res.status).toBe(500);
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// ─── Instance detail (decrypted env) ──────────────────────────────────────────

describe('GET /api/apps/instances/:id', () => {
  it('returns 404 (non-leak) when the instance belongs to another org', async () => {
    // loadInstance is org-scoped → returns null for a foreign instance.
    mockDbQueryOne.mockResolvedValue(null);
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-foreign',
      { method: 'GET' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('NOT_FOUND');
    // org-scoped lookup
    expect(mockDbQueryOne.mock.calls[0][2]).toEqual(['inst-foreign', 'org-1']);
  });

  it('returns 403 when a non-admin role requests decrypted env', async () => {
    const res = await req(
      makeApp({ ...AUTH, userRole: 'member' }),
      '/api/apps/instances/inst-1',
      { method: 'GET' },
      makeEnv(),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('FORBIDDEN');
  });

  it('returns the instance with decrypted env for an admin', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow({ env_encrypted: 'cipher', env_iv: 'inline' }));
    const res = await req(
      makeApp({ ...AUTH, userRole: 'admin' }),
      '/api/apps/instances/inst-1',
      { method: 'GET' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { instance: { id: string; env: Record<string, unknown> } };
    expect(json.instance.id).toBe('inst-1');
    expect(json.instance.env).toEqual({}); // decrypt mock returns "{}"
  });

  it('flips a provisioning payload instance to running once the real admin answers', async () => {
    mockDbQueryOne.mockResolvedValue(
      instanceRow({
        app_slug: 'payload',
        status: 'provisioning',
        worker_script_name: 'payload-acme-abc12345',
        subdomain: 'acme',
      }),
    );
    // A 200 WITHOUT the bootstrap "finishing setup" marker = the real admin is live.
    const env = makeDispatchEnv(
      () =>
        new Response('<html><body>Payload — create your first user</body></html>', { status: 200 }),
    );
    const res = await req(
      makeApp({ ...AUTH, userRole: 'admin' }),
      '/api/apps/instances/inst-1',
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { instance: { status: string } };
    expect(json.instance.status).toBe('running');
    expect(mockDbUpdate).toHaveBeenCalledWith(
      expect.anything(),
      'app_instances',
      expect.objectContaining({ status: 'running' }),
      'id = ?',
      ['inst-1'],
    );
  });

  it('keeps a payload instance provisioning while only the bootstrap placeholder answers', async () => {
    mockDbQueryOne.mockResolvedValue(
      instanceRow({
        app_slug: 'payload',
        status: 'provisioning',
        worker_script_name: 'payload-acme-abc12345',
        subdomain: 'acme',
      }),
    );
    // The bootstrap placeholder 200s the "finishing setup" page — NOT the real admin.
    const env = makeDispatchEnv(
      () =>
        new Response(
          '<html><body><p style="opacity:.7">Admin UI finishing setup…</p></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    );
    const res = await req(
      makeApp({ ...AUTH, userRole: 'admin' }),
      '/api/apps/instances/inst-1',
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { instance: { status: string } };
    expect(json.instance.status).toBe('provisioning');
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// ─── Lifecycle: restart / stop / delete ──────────────────────────────────────

describe('POST /api/apps/instances/:id/restart', () => {
  it('returns 404 when the instance is not found', async () => {
    mockDbQueryOne.mockResolvedValue(null);
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-x/restart',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it('dispatches a restart and audit-logs it', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow());
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/restart',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(mockRestart).toHaveBeenCalledWith(expect.anything(), 'inst-1', 'umami');
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'apps.instance.restarted' });
  });

  it('returns 500 (not a lying 200) when the status-write fails', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow());
    mockDbUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full' });
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/restart',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(500);
  });

  it('restart on a CF-native payload instance re-probes (no container dispatch, honest status)', async () => {
    mockDbQueryOne.mockResolvedValue(
      instanceRow({ app_slug: 'payload', worker_script_name: 'payload-x-abc', subdomain: 'acme' }),
    );
    const env = makeDispatchEnv(() => new Response('<html>Payload login</html>', { status: 200 }));
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/restart',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status: string };
    expect(json).toMatchObject({ ok: true, status: 'running' });
    expect(mockRestart).not.toHaveBeenCalled(); // NEVER the container path for cf-native
    expect(mockDbUpdate.mock.calls[0][2]).toMatchObject({ status: 'running' });
  });
});

describe('POST /api/apps/instances/:id/stop', () => {
  it('dispatches a stop and persists the stopped status', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow());
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/stop',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(mockStop).toHaveBeenCalledWith(expect.anything(), 'inst-1', 'umami');
    expect(mockDbUpdate.mock.calls[0][2]).toMatchObject({ status: 'stopped' });
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'apps.instance.stopped' });
  });

  it('stop on a CF-native payload instance marks stopped (no container dispatch)', async () => {
    mockDbQueryOne.mockResolvedValue(
      instanceRow({ app_slug: 'payload', worker_script_name: 'payload-x-abc', subdomain: 'acme' }),
    );
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/stop',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status: string };
    expect(json).toMatchObject({ ok: true, status: 'stopped' });
    expect(mockStop).not.toHaveBeenCalled(); // NEVER the container path for cf-native
    expect(mockDbUpdate.mock.calls[0][2]).toMatchObject({ status: 'stopped' });
  });

  it('persists an error status when the dispatcher reports failure', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow());
    mockStop.mockResolvedValue({ ok: false, detail: 'do_unreachable' });
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/stop',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; detail: string | null };
    expect(json.ok).toBe(false);
    expect(json.detail).toBe('do_unreachable');
    expect(mockDbUpdate.mock.calls[0][2]).toMatchObject({
      status: 'error',
      last_error: 'do_unreachable',
    });
  });

  it('returns 500 (not a lying 200) when the status-write fails', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow());
    mockDbUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full' });
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/stop',
      { method: 'POST' },
      makeEnv(),
    );
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/apps/instances/:id/env', () => {
  it('persists the merged env and returns 200 { status: starting }', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow({ env_encrypted: 'cipher', env_iv: 'inline' }));
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/env',
      jsonInit('PATCH', { env_overrides: { FOO: 'bar' } }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status: string };
    expect(json).toMatchObject({ ok: true, status: 'starting' });
    expect(mockDbUpdate.mock.calls[0][2]).toMatchObject({ env_encrypted: 'cipher-blob' });
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'apps.instance.env_updated' });
  });

  it('returns 500 (never silently drops the env save) when the write fails', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow({ env_encrypted: 'cipher', env_iv: 'inline' }));
    mockDbUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full' });
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1/env',
      jsonInit('PATCH', { env_overrides: { FOO: 'bar' } }),
      makeEnv(),
    );
    expect(res.status).toBe(500);
    // The restart must NOT be scheduled when the env save failed.
    expect(mockRestart).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/apps/instances/:id', () => {
  it('returns 401 when org context is missing', async () => {
    const res = await req(makeApp(), '/api/apps/instances/inst-1', { method: 'DELETE' }, makeEnv());
    expect(res.status).toBe(401);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('returns 404 when the instance is not found', async () => {
    mockDbQueryOne.mockResolvedValue(null);
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-x',
      { method: 'DELETE' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('destroys the container, deprovisions infra, soft-deletes, and audit-logs', async () => {
    mockDbQueryOne.mockResolvedValue(instanceRow());
    const res = await req(
      makeApp(AUTH),
      '/api/apps/instances/inst-1',
      { method: 'DELETE' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; cleanup: Record<string, boolean> };
    expect(json.ok).toBe(true);
    expect(json.cleanup).toEqual({ neon: true, upstash: true, r2: true });
    expect(mockDestroy).toHaveBeenCalledWith(expect.anything(), 'inst-1', 'umami');
    expect(mockDeprovision).toHaveBeenCalledWith(expect.anything(), {
      neonProjectId: 'neon-1',
      upstashDatabaseId: null,
      r2BucketName: null,
    });
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'apps.instance.destroyed' });
  });
});
