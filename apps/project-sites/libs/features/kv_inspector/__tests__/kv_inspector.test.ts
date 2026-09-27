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
  put: jest.Mock;
  delete: jest.Mock;
}

// ─── KV namespace mocks ───────────────────────────────────────────────────────

const mockCacheKv: MockKv = {
  list: jest.fn(),
  getWithMetadata: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};
const mockPromptStore: MockKv = {
  list: jest.fn(),
  getWithMetadata: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

// ─── Deferred import (after mocks) ───────────────────────────────────────────

import { kvInspector, buildKvPutOptions } from '../handlers.js';

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

/** PUT/DELETE helper for the KV write endpoints. */
async function reqMethod(
  app: Hono,
  method: 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  env: AppEnv = makeEnv(),
): Promise<Response> {
  return app.request(
    path,
    {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    },
    env as never,
  );
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

describe('PUT /api/admin/kv/:binding/value — write (create/edit)', () => {
  it('404 when flag off / unauth / not super-admin (KV never written)', async () => {
    mockIsFlagOn.mockResolvedValueOnce(false);
    expect((await reqMethod(appWith('u'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'k', value: 'v' })).status).toBe(404);
    expect((await reqMethod(appWith(), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'k', value: 'v' })).status).toBe(404);
    mockDbQueryOne.mockResolvedValueOnce({ is_super_admin: 0 });
    expect((await reqMethod(appWith('owner'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'k', value: 'v' })).status).toBe(404);
    expect(mockCacheKv.put).not.toHaveBeenCalled();
  });

  it('404 for an unknown binding (client-supplied name never reaches KV)', async () => {
    expect((await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/EVIL_KV/value', { key: 'k', value: 'v' })).status).toBe(404);
    expect(mockCacheKv.put).not.toHaveBeenCalled();
  });

  it('400 on a missing key / oversized value / sub-60s TTL', async () => {
    expect((await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { value: 'v' })).status).toBe(400);
    expect((await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'k', value: 'x'.repeat(65_537) })).status).toBe(400);
    expect((await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'k', value: 'v', expirationTtl: 30 })).status).toBe(400);
    expect(mockCacheKv.put).not.toHaveBeenCalled();
  });

  it('200 writes the value via the resolved binding + surfaces eventual consistency', async () => {
    const res = await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'host:acme', value: 'zone123', expirationTtl: 120 });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; key: string; eventualConsistency: boolean }>();
    expect(body).toEqual({ ok: true, binding: 'CACHE_KV', key: 'host:acme', eventualConsistency: true });
    expect(mockCacheKv.put).toHaveBeenCalledWith('host:acme', 'zone123', { expirationTtl: 120 });
    expect(mockPromptStore.put).not.toHaveBeenCalled(); // only the resolved binding
  });

  it('502 when the KV write throws (honest failure, never a fake ok)', async () => {
    mockCacheKv.put.mockRejectedValueOnce(new Error('kv down'));
    const res = await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'k', value: 'v' });
    expect(res.status).toBe(502);
    expect((await res.json<{ ok: boolean }>()).ok).toBe(false);
  });

  it('PRESERVES existing metadata + expiration on a value edit (no TTL passed)', async () => {
    // The key already has metadata + a far-future expiration; editing only the value must keep both
    // (a bare put would wipe metadata + clear the TTL — the epic's "preserve unless explicitly changed").
    mockCacheKv.getWithMetadata.mockResolvedValueOnce({ value: 'old', metadata: { tenant: 'acme' } });
    mockCacheKv.list.mockResolvedValueOnce({
      keys: [{ name: 'host:acme', expiration: 9_999_999_999, metadata: { tenant: 'acme' } }],
      list_complete: true,
      cursor: undefined,
    });
    const res = await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'host:acme', value: 'new' });
    expect(res.status).toBe(200);
    expect(mockCacheKv.put).toHaveBeenCalledWith('host:acme', 'new', {
      expiration: 9_999_999_999,
      metadata: { tenant: 'acme' },
    });
  });

  it('an explicit new TTL WINS over the preserved expiration (deliberate change)', async () => {
    mockCacheKv.getWithMetadata.mockResolvedValueOnce({ value: 'old', metadata: { tenant: 'acme' } });
    mockCacheKv.list.mockResolvedValueOnce({
      keys: [{ name: 'host:acme', expiration: 9_999_999_999 }],
      list_complete: true,
      cursor: undefined,
    });
    const res = await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', { key: 'host:acme', value: 'new', expirationTtl: 300 });
    expect(res.status).toBe(200);
    // TTL replaces the old expiration; metadata is still preserved.
    expect(mockCacheKv.put).toHaveBeenCalledWith('host:acme', 'new', {
      expirationTtl: 300,
      metadata: { tenant: 'acme' },
    });
  });

  it('clearExpiration makes the key PERMANENT — drops the existing expiration, keeps metadata', async () => {
    mockCacheKv.getWithMetadata.mockResolvedValueOnce({ value: 'old', metadata: { tenant: 'acme' } });
    mockCacheKv.list.mockResolvedValueOnce({
      keys: [{ name: 'host:acme', expiration: 9_999_999_999 }],
      list_complete: true,
      cursor: undefined,
    });
    const res = await reqMethod(appWith('super'), 'PUT', '/api/admin/kv/CACHE_KV/value', {
      key: 'host:acme',
      value: 'new',
      clearExpiration: true,
    });
    expect(res.status).toBe(200);
    // No `expiration`/`expirationTtl` → the key becomes permanent; metadata still preserved.
    expect(mockCacheKv.put).toHaveBeenCalledWith('host:acme', 'new', { metadata: { tenant: 'acme' } });
  });
});

describe('buildKvPutOptions (preserve metadata + expiration unless explicitly changed) — pure', () => {
  const NOW = 1_000_000;

  it('explicit expirationTtl wins (a deliberate TTL change)', () => {
    expect(buildKvPutOptions({ expirationTtl: 300, existingExpiration: 9e9, nowSec: NOW })).toEqual({
      expirationTtl: 300,
    });
  });

  it('preserves a future existing expiration when no TTL is passed', () => {
    expect(buildKvPutOptions({ existingExpiration: NOW + 3600, nowSec: NOW })).toEqual({
      expiration: NOW + 3600,
    });
  });

  it('clearExpiration makes the key permanent — does NOT re-apply the existing expiration', () => {
    expect(buildKvPutOptions({ clearExpiration: true, existingExpiration: NOW + 3600, nowSec: NOW })).toBeUndefined();
    // metadata is still preserved even when the expiration is cleared
    expect(
      buildKvPutOptions({ clearExpiration: true, existingMetadata: { a: 1 }, existingExpiration: NOW + 3600, nowSec: NOW }),
    ).toEqual({ metadata: { a: 1 } });
  });

  it('an explicit new TTL wins over clearExpiration (both set → the concrete TTL)', () => {
    expect(
      buildKvPutOptions({ expirationTtl: 120, clearExpiration: true, existingExpiration: NOW + 3600, nowSec: NOW }),
    ).toEqual({ expirationTtl: 120 });
  });

  it('does NOT re-apply a past / sub-60s existing expiration (KV floor) — key left permanent', () => {
    expect(buildKvPutOptions({ existingExpiration: NOW - 10, nowSec: NOW })).toBeUndefined();
    expect(buildKvPutOptions({ existingExpiration: NOW + 30, nowSec: NOW })).toBeUndefined(); // under +60
  });

  it('always preserves existing metadata (there is no metadata-edit path)', () => {
    expect(buildKvPutOptions({ existingMetadata: { a: 1 }, nowSec: NOW })).toEqual({ metadata: { a: 1 } });
    expect(
      buildKvPutOptions({ expirationTtl: 120, existingMetadata: { a: 1 }, nowSec: NOW }),
    ).toEqual({ expirationTtl: 120, metadata: { a: 1 } });
  });

  it('returns undefined for a plain create (no TTL, no existing meta/expiration)', () => {
    expect(buildKvPutOptions({ nowSec: NOW })).toBeUndefined();
    expect(buildKvPutOptions({ existingMetadata: null, nowSec: NOW })).toBeUndefined();
  });
});

describe('DELETE /api/admin/kv/:binding/value — delete a key', () => {
  it('404 when not super-admin / unknown binding (KV never touched)', async () => {
    mockDbQueryOne.mockResolvedValueOnce({ is_super_admin: 0 });
    expect((await reqMethod(appWith('owner'), 'DELETE', '/api/admin/kv/CACHE_KV/value?key=k')).status).toBe(404);
    expect((await reqMethod(appWith('super'), 'DELETE', '/api/admin/kv/EVIL/value?key=k')).status).toBe(404);
    expect(mockCacheKv.delete).not.toHaveBeenCalled();
  });

  it('400 when no key is given', async () => {
    expect((await reqMethod(appWith('super'), 'DELETE', '/api/admin/kv/CACHE_KV/value')).status).toBe(400);
    expect(mockCacheKv.delete).not.toHaveBeenCalled();
  });

  it('200 deletes the key via the resolved binding', async () => {
    const res = await reqMethod(appWith('super'), 'DELETE', '/api/admin/kv/PROMPT_STORE/value?key=draft:1');
    expect(res.status).toBe(200);
    expect((await res.json<{ ok: boolean }>()).ok).toBe(true);
    expect(mockPromptStore.delete).toHaveBeenCalledWith('draft:1');
    expect(mockCacheKv.delete).not.toHaveBeenCalled();
  });
});
