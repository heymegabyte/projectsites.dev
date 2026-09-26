/**
 * Unit + route-layer tests for the r2_inspector feature module.
 *
 * All external deps (D1 super-admin lookup, R2, feature flags) are mocked — no
 * network/DB. Mirrors kv_inspector's contract:
 *   - flag off → 404 on all three endpoints
 *   - non-super-admin / unauthenticated → 404
 *   - unknown :bucket → 404
 *   - valid list → objects (key/size/uploaded/etag/contentType) + cursor + truncated
 *   - list bounded ≤1000 objects (limit hard cap)
 *   - prefix + cursor passthrough
 *   - object HEAD → metadata (found:true); missing key → found:false (never fabricated)
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

// ─── R2 bucket mock ───────────────────────────────────────────────────────────

interface MockR2 {
  list: jest.Mock;
  head: jest.Mock;
}

const mockSitesBucket: MockR2 = { list: jest.fn(), head: jest.fn() };

// ─── Deferred import (after mocks) ───────────────────────────────────────────

import { r2Inspector } from '../handlers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AppEnv = { DB: unknown; SITES_BUCKET: MockR2 };

function appWith(userId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', r2Inspector);
  return app;
}

function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return { DB: {}, SITES_BUCKET: mockSitesBucket, ...overrides };
}

async function req(app: Hono, path: string, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(path, {}, env as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockDbQueryOne.mockResolvedValue({ is_super_admin: 1, email: 'brian@megabyte.space' });
  mockSitesBucket.list.mockResolvedValue({ objects: [], truncated: false });
  mockSitesBucket.head.mockResolvedValue(null);
});

describe('GET /api/admin/r2/buckets', () => {
  it('404 when flag off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await req(appWith('u'), '/api/admin/r2/buckets')).status).toBe(404);
  });
  it('404 when unauthenticated', async () => {
    expect((await req(appWith(), '/api/admin/r2/buckets')).status).toBe(404);
  });
  it('404 when NOT super-admin', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await req(appWith('owner'), '/api/admin/r2/buckets')).status).toBe(404);
  });
  it('returns the SITES_BUCKET allowlist for a super-admin', async () => {
    const res = await req(appWith('super-1'), '/api/admin/r2/buckets');
    expect(res.status).toBe(200);
    const body = await res.json<{ buckets: string[] }>();
    expect(body.buckets).toEqual(['SITES_BUCKET']);
  });
});

describe('GET /api/admin/r2/:bucket/objects', () => {
  it('404 for an unknown (non-allowlisted) bucket — client name never reaches R2', async () => {
    const res = await req(appWith('super-1'), '/api/admin/r2/SECRET_BUCKET/objects');
    expect(res.status).toBe(404);
    expect(mockSitesBucket.list).not.toHaveBeenCalled();
  });

  it('404 when NOT super-admin', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await req(appWith('owner'), '/api/admin/r2/SITES_BUCKET/objects')).status).toBe(404);
  });

  it('returns objects with key/size/uploaded/etag/contentType + truncated', async () => {
    const uploaded = new Date('2026-09-01T12:00:00.000Z');
    mockSitesBucket.list.mockResolvedValue({
      objects: [
        {
          key: 'sites/a/index.html',
          size: 1234,
          uploaded,
          etag: 'e1',
          httpMetadata: { contentType: 'text/html' },
        },
        { key: 'media/o1/logo.png', size: 5678, uploaded, etag: 'e2', httpMetadata: {} },
      ],
      truncated: true,
      cursor: 'next-cur',
    });
    const res = await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/objects');
    expect(res.status).toBe(200);
    const body = await res.json<{
      objects: { key: string; size: number; uploaded: string; contentType: string | null }[];
      truncated: boolean;
      cursor?: string;
    }>();
    expect(body.objects).toHaveLength(2);
    expect(body.objects[0]).toEqual({
      key: 'sites/a/index.html',
      size: 1234,
      uploaded: '2026-09-01T12:00:00.000Z',
      etag: 'e1',
      contentType: 'text/html',
    });
    expect(body.objects[1].contentType).toBeNull();
    expect(body.truncated).toBe(true);
    expect(body.cursor).toBe('next-cur');
  });

  it('caps limit to 1000 regardless of query param', async () => {
    await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/objects?limit=9999');
    const [opts] = mockSitesBucket.list.mock.calls[0] as [{ limit?: number }];
    expect(opts?.limit ?? 0).toBeLessThanOrEqual(1000);
  });

  it('passes prefix + cursor through to R2 list', async () => {
    await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/objects?prefix=sites%2Fa&cursor=c0');
    const [opts] = mockSitesBucket.list.mock.calls[0] as [{ prefix?: string; cursor?: string }];
    expect(opts?.prefix).toBe('sites/a');
    expect(opts?.cursor).toBe('c0');
  });

  it('forwards a delimiter to R2 list + returns delimitedPrefixes (folder grouping)', async () => {
    mockSitesBucket.list.mockResolvedValueOnce({
      objects: [{ key: 'logs/root.txt', size: 3, uploaded: new Date(0), etag: 'e', httpMetadata: {} }],
      delimitedPrefixes: ['logs/2026/', 'logs/2025/'],
      truncated: false,
    });
    const res = await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/objects?prefix=logs%2F&delimiter=%2F');
    expect(res.status).toBe(200);
    const [opts] = mockSitesBucket.list.mock.calls[0] as [{ delimiter?: string }];
    expect(opts?.delimiter).toBe('/');
    const body = await res.json<{ delimitedPrefixes: string[]; objects: unknown[] }>();
    expect(body.delimitedPrefixes).toEqual(['logs/2026/', 'logs/2025/']);
    expect(body.objects).toHaveLength(1);
  });

  it('omits the delimiter from R2 list when not requested (flat listing) + defaults delimitedPrefixes to []', async () => {
    mockSitesBucket.list.mockResolvedValueOnce({ objects: [], truncated: false });
    const res = await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/objects');
    const [opts] = mockSitesBucket.list.mock.calls[0] as [{ delimiter?: string }];
    expect(opts?.delimiter).toBeUndefined();
    const body = await res.json<{ delimitedPrefixes: string[] }>();
    expect(body.delimitedPrefixes).toEqual([]);
  });
});

describe('GET /api/admin/r2/:bucket/object', () => {
  it('400 when key is missing', async () => {
    expect((await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/object')).status).toBe(400);
  });

  it('returns HEAD metadata (found:true) for an existing object', async () => {
    mockSitesBucket.head.mockResolvedValue({
      key: 'sites/a/index.html',
      size: 999,
      uploaded: new Date('2026-09-02T00:00:00.000Z'),
      etag: 'eee',
      httpMetadata: { contentType: 'text/html' },
      customMetadata: { site: 'a' },
    });
    const res = await req(
      appWith('super-1'),
      '/api/admin/r2/SITES_BUCKET/object?key=sites%2Fa%2Findex.html',
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      found: boolean;
      size: number;
      contentType: string;
      customMetadata: unknown;
    }>();
    expect(body.found).toBe(true);
    expect(body.size).toBe(999);
    expect(body.contentType).toBe('text/html');
    expect(body.customMetadata).toEqual({ site: 'a' });
    expect(mockSitesBucket.head).toHaveBeenCalledWith('sites/a/index.html');
  });

  it('returns found:false for a missing key (never a fabricated object)', async () => {
    mockSitesBucket.head.mockResolvedValue(null);
    const res = await req(appWith('super-1'), '/api/admin/r2/SITES_BUCKET/object?key=nope');
    expect(res.status).toBe(200);
    const body = await res.json<{ found: boolean; size: number | null }>();
    expect(body.found).toBe(false);
    expect(body.size).toBeNull();
  });
});
