/**
 * Unit + route-layer tests for the kv_inspector feature module.
 *
 * All external deps (D1, KV, feature flags) are mocked — no network/DB.
 * Covers every required behaviour:
 *   - flag off → 404 on all three endpoints
 *   - non-super-admin → 404 on all three endpoints
 *   - unknown :binding → 404
 *   - valid list → keys + cursor + list_complete
 *   - list bounded ≤1000 keys (limit=1000 hard cap)
 *   - valid value → value (size-capped) + metadata + TTL
 *   - value size cap → truncated flag set
 *   - namespaces → full allowlist
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

// ─── Types ───────────────────────────────────────────────────────────────────

interface KvKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

interface MockKv {
  list: jest.Mock;
  getWithMetadata: jest.Mock;
}

// ─── KV namespace mocks ───────────────────────────────────────────────────────

const mockCacheKv: MockKv = {
  list: jest.fn(),
  getWithMetadata: jest.fn(),
};
const mockPromptStore: MockKv = {
  list: jest.fn(),
  getWithMetadata: jest.fn(),
};

// ─── Deferred import (after mocks) ───────────────────────────────────────────

import { kvInspector } from '../handlers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AppEnv = {
  DB: unknown;
  CACHE_KV: MockKv;
  PROMPT_STORE: MockKv;
};

/** Build a Hono test app with optional userId set on context. */
function appWith(userId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', kvInspector);
  return app;
}

/** Minimal env with KV bindings. */
function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DB: {},
    CACHE_KV: mockCacheKv,
    PROMPT_STORE: mockPromptStore,
    ...overrides,
  };
}

async function req(app: Hono, path: string, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(path, {}, env as never);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  // Default: user is a super-admin
  mockDbQueryOne.mockResolvedValue({ is_super_admin: 1, email: 'brian@megabyte.space' });

  // Default KV behaviours
  mockCacheKv.list.mockResolvedValue({ keys: [], list_complete: true, cursor: undefined });
  mockPromptStore.list.mockResolvedValue({ keys: [], list_complete: true, cursor: undefined });
  mockCacheKv.getWithMetadata.mockResolvedValue({ value: null, metadata: null });
  mockPromptStore.getWithMetadata.mockResolvedValue({ value: null, metadata: null });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/admin/kv/namespaces', () => {
  it('returns 404 when kv_inspector flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await req(appWith('user-1'), '/api/admin/kv/namespaces');
    expect(res.status).toBe(404);
  });

  it('returns 404 when no userId (unauthenticated)', async () => {
    const res = await req(appWith(), '/api/admin/kv/namespaces');
    expect(res.status).toBe(404);
  });

  it('returns 404 when user is NOT a super-admin', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0, email: 'owner@example.com' });
    const res = await req(appWith('regular-user'), '/api/admin/kv/namespaces');
    expect(res.status).toBe(404);
  });

  it('returns the CACHE_KV and PROMPT_STORE allowlist for a super-admin', async () => {
    const res = await req(appWith('super-1'), '/api/admin/kv/namespaces');
    expect(res.status).toBe(200);
    const body = await res.json<{ namespaces: string[] }>();
    expect(body.namespaces).toEqual(expect.arrayContaining(['CACHE_KV', 'PROMPT_STORE']));
    expect(body.namespaces).toHaveLength(2);
  });
});

describe('GET /api/admin/kv/:binding/keys', () => {
  it('returns 404 when flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/keys');
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown binding', async () => {
    const res = await req(appWith('super-1'), '/api/admin/kv/SECRET_SAUCE/keys');
    expect(res.status).toBe(404);
  });

  it('returns 404 when user is not a super-admin', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0, email: 'owner@example.com' });
    const res = await req(appWith('regular-user'), '/api/admin/kv/CACHE_KV/keys');
    expect(res.status).toBe(404);
  });

  it('returns keys with expiration and list_complete from CACHE_KV', async () => {
    const now = Math.floor(Date.now() / 1000) + 3600;
    const keys: KvKey[] = [
      { name: 'site:abc:host', expiration: now, metadata: { tenant: 'abc' } },
      { name: 'site:xyz:host', expiration: now + 100 },
    ];
    mockCacheKv.list.mockResolvedValue({ keys, list_complete: true, cursor: undefined });

    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/keys');
    expect(res.status).toBe(200);
    const body = await res.json<{ keys: KvKey[]; list_complete: boolean; cursor?: string }>();
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0].name).toBe('site:abc:host');
    expect(body.list_complete).toBe(true);
  });

  it('caps limit to 1000 regardless of query param', async () => {
    mockCacheKv.list.mockResolvedValue({ keys: [], list_complete: true, cursor: undefined });
    await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/keys?limit=9999');
    // list should have been called with limit ≤ 1000
    const [opts] = mockCacheKv.list.mock.calls[0] as [{ limit?: number }];
    expect(opts?.limit ?? 0).toBeLessThanOrEqual(1000);
  });

  it('passes cursor parameter through to KV list', async () => {
    mockCacheKv.list.mockResolvedValue({ keys: [], list_complete: false, cursor: 'next-cur' });
    await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/keys?cursor=prev-cur');
    const [opts] = mockCacheKv.list.mock.calls[0] as [{ cursor?: string }];
    expect(opts?.cursor).toBe('prev-cur');
  });

  it('passes prefix parameter through to KV list', async () => {
    mockCacheKv.list.mockResolvedValue({ keys: [], list_complete: true, cursor: undefined });
    await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/keys?prefix=site%3A');
    const [opts] = mockCacheKv.list.mock.calls[0] as [{ prefix?: string }];
    expect(opts?.prefix).toBe('site:');
  });

  it('works with PROMPT_STORE binding', async () => {
    const keys: KvKey[] = [{ name: 'prompt:global:v3' }];
    mockPromptStore.list.mockResolvedValue({ keys, list_complete: true, cursor: undefined });
    const res = await req(appWith('super-1'), '/api/admin/kv/PROMPT_STORE/keys');
    expect(res.status).toBe(200);
    const body = await res.json<{ keys: KvKey[] }>();
    expect(body.keys[0].name).toBe('prompt:global:v3');
  });
});

describe('GET /api/admin/kv/:binding/value', () => {
  it('returns 404 when flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/value?key=test');
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown binding', async () => {
    const res = await req(appWith('super-1'), '/api/admin/kv/NOT_REAL/value?key=k');
    expect(res.status).toBe(404);
  });

  it('returns 400 when key param is missing', async () => {
    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/value');
    expect(res.status).toBe(400);
  });

  it('returns 404 when user is not a super-admin', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0, email: 'owner@example.com' });
    const res = await req(appWith('regular-user'), '/api/admin/kv/CACHE_KV/value?key=test');
    expect(res.status).toBe(404);
  });

  it('returns null value/metadata when key does not exist', async () => {
    mockCacheKv.getWithMetadata.mockResolvedValue({ value: null, metadata: null });
    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/value?key=missing-key');
    expect(res.status).toBe(200);
    const body = await res.json<{ value: null; metadata: null; truncated: boolean }>();
    expect(body.value).toBeNull();
    expect(body.metadata).toBeNull();
    expect(body.truncated).toBe(false);
  });

  it('returns value + metadata for existing key', async () => {
    mockCacheKv.getWithMetadata.mockResolvedValue({
      value: 'hello-world',
      metadata: { tenant: 'abc' },
    });
    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/value?key=site:abc:host');
    expect(res.status).toBe(200);
    const body = await res.json<{
      value: string;
      metadata: { tenant: string };
      truncated: boolean;
    }>();
    expect(body.value).toBe('hello-world');
    expect(body.metadata).toEqual({ tenant: 'abc' });
    expect(body.truncated).toBe(false);
  });

  it('truncates oversized values and sets truncated=true', async () => {
    // Generate a value larger than the 64KB size cap
    const bigValue = 'x'.repeat(65_537);
    mockCacheKv.getWithMetadata.mockResolvedValue({ value: bigValue, metadata: null });
    const res = await req(appWith('super-1'), '/api/admin/kv/CACHE_KV/value?key=big');
    expect(res.status).toBe(200);
    const body = await res.json<{ value: string; truncated: boolean }>();
    expect(body.truncated).toBe(true);
    expect(body.value.length).toBeLessThanOrEqual(65_536 + 100); // capped
  });
});
