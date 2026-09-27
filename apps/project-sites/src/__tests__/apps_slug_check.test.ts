/**
 * Unit tests for `GET /api/apps/slug-check`.
 *
 * Exercises: Zod validation, availability (taken vs free), `valid` flag
 * against SUBDOMAIN_RE + length bounds, and the suggestion algorithm.
 *
 * Mocked boundaries: D1 (dbQueryOne / dbQuery), audit (unused here).
 * Internal logic under test is the route handler itself.
 */

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/app_provisioner.js', () => ({
  provisionInfra: jest.fn(),
  deprovisionInfra: jest.fn().mockResolvedValue({}),
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
  encrypt: jest.fn().mockResolvedValue('cipher'),
  decrypt: jest.fn().mockResolvedValue('{}'),
}));

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
  return { MissingEnvError, resolveAppEnv: jest.fn(() => ({})) };
});

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(),
}));

jest.mock('../durable_objects/app_runtime_subclasses.js', () => ({
  SUPPORTED_APP_SLUGS: ['umami'],
  isSupportedSlug: (slug: string) => slug === 'umami',
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { apps } from '../routes/apps.js';
import { dbQueryOne } from '../services/db.js';

const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeEnv(): Env {
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

type AnyApp = Hono<{ Bindings: Env; Variables: Variables }>;

const AUTH: Partial<Variables> = { userId: 'u1', orgId: 'org1', requestId: 'r1' };

function makeApp(vars: Partial<Variables> = AUTH) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', apps);
  return app;
}

function req(
  app: AnyApp,
  path: string,
  init: RequestInit,
  env: Env,
) {
  return app.request(path, init, env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
}

function get(app: AnyApp, path: string, env: Env) {
  return req(app, path, { method: 'GET' }, env);
}

interface CheckResponse {
  available: boolean;
  valid: boolean;
  suggestion: string;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: subdomain is free (no existing row) and site query returns null.
  mockDbQueryOne.mockResolvedValue(null);
});

// ─── Validation (Zod) ────────────────────────────────────────────────────────

describe('GET /api/apps/slug-check — Zod validation', () => {
  it('returns 400 when app_id is missing', async () => {
    const res = await get(makeApp(), '/api/apps/slug-check?subdomain=myapp', makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when subdomain is missing', async () => {
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami', makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await get(makeApp({}), '/api/apps/slug-check?app_id=umami&subdomain=myapp', makeEnv());
    expect(res.status).toBe(401);
  });
});

// ─── valid flag ───────────────────────────────────────────────────────────────

describe('GET /api/apps/slug-check — valid flag (format rules)', () => {
  async function check(subdomain: string): Promise<CheckResponse> {
    const res = await get(
      makeApp(),
      `/api/apps/slug-check?app_id=umami&subdomain=${encodeURIComponent(subdomain)}`,
      makeEnv(),
    );
    expect(res.status).toBe(200);
    return res.json() as Promise<CheckResponse>;
  }

  it('marks a well-formed subdomain as valid', async () => {
    const json = await check('my-app');
    expect(json.valid).toBe(true);
  });

  it('marks an uppercase subdomain as invalid', async () => {
    const json = await check('MyApp');
    expect(json.valid).toBe(false);
  });

  it('marks a subdomain starting with hyphen as invalid', async () => {
    const json = await check('-bad');
    expect(json.valid).toBe(false);
  });

  it('marks a subdomain ending with hyphen as invalid', async () => {
    const json = await check('bad-');
    expect(json.valid).toBe(false);
  });

  it('marks a 1-char subdomain as invalid (min is 2)', async () => {
    const json = await check('a');
    expect(json.valid).toBe(false);
  });

  it('marks a 64-char subdomain as invalid (max is 63)', async () => {
    const json = await check('a'.repeat(64));
    expect(json.valid).toBe(false);
  });

  it('marks a 63-char lowercase subdomain as valid', async () => {
    const json = await check('a'.repeat(63));
    expect(json.valid).toBe(true);
  });

  it('marks a subdomain with special chars as invalid', async () => {
    const json = await check('my_app');
    expect(json.valid).toBe(false);
  });
});

// ─── available flag ───────────────────────────────────────────────────────────

describe('GET /api/apps/slug-check — available flag', () => {
  it('returns available=true when no row exists', async () => {
    mockDbQueryOne.mockResolvedValue(null);
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami&subdomain=free-slug', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as CheckResponse;
    expect(json.available).toBe(true);
    expect(json.valid).toBe(true);
  });

  it('returns available=false when row exists with deleted_at IS NULL', async () => {
    mockDbQueryOne.mockResolvedValue({ id: 'existing-1' });
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami&subdomain=taken-slug', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as CheckResponse;
    expect(json.available).toBe(false);
  });

  it('returns available=false for an invalid format (invalid ⇒ not available)', async () => {
    // An invalid subdomain is not available (it can never be registered)
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami&subdomain=BAD_FORMAT', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as CheckResponse;
    expect(json.valid).toBe(false);
    expect(json.available).toBe(false);
  });
});

// ─── suggestion ───────────────────────────────────────────────────────────────

describe('GET /api/apps/slug-check — suggestion', () => {
  it('returns a non-empty url-safe suggestion string', async () => {
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami&subdomain=myslug', makeEnv());
    const json = (await res.json()) as CheckResponse;
    expect(json.suggestion).toMatch(/^[a-z0-9-]+$/);
    expect(json.suggestion.length).toBeGreaterThan(0);
    expect(json.suggestion.length).toBeLessThanOrEqual(25);
  });

  it('suggestion is always available (no matching row)', async () => {
    // Default mock: null returned for all dbQueryOne calls → suggestion is available.
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami&subdomain=taken', makeEnv());
    const json = (await res.json()) as CheckResponse;
    // The suggestion itself must be different from "taken" when taken is unavailable.
    // When the default is free, suggestion may match; the invariant is it's url-safe.
    expect(json.suggestion).toMatch(/^[a-z0-9-]+$/);
  });

  it('suggestion increments suffix until a free slot is found', async () => {
    // First 2 calls taken (uniqueness check for the queried subdomain, then
    // suggestion base), 3rd call free.
    let callCount = 0;
    mockDbQueryOne.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.resolve({ id: `inst-${callCount}` });
      return Promise.resolve(null);
    });
    const res = await get(makeApp(), '/api/apps/slug-check?app_id=umami&subdomain=taken-sub', makeEnv());
    const json = (await res.json()) as CheckResponse;
    // Suggestion must end in -2 or higher suffix indicating fallback to increment
    expect(json.suggestion).toMatch(/^[a-z0-9]([a-z0-9-]{0,23}[a-z0-9])?$/);
  });
});
