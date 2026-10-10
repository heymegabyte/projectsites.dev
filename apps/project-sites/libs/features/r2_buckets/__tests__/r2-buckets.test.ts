/**
 * Route-layer coverage for the per-site R2 Buckets surface (`r2_buckets/handlers.ts`). Proves the gate
 * order that ships isolation BEFORE owner access:
 *   flag off → 404 (DARK, never 403/leak) → unauth → 401 → foreign site (ownsSiteData) → 404 →
 *   then and only then resolve the bucket allocation → list/create/delete.
 * Also proves create returns the copyable address bundle + 409 on a dup name, and delete succeeds.
 *
 * `isFlagOn` + the `site_r2` service are mocked so the handler logic is tested in isolation; the
 * `ownsSiteData` IDOR guard runs for real against a mock D1.
 */
import { Hono } from 'hono';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../../../../src/services/site_r2.js', () => ({
  bucketAddress: jest.fn(() => ({
    accountId: 'acct',
    bindingName: 'UPLOADS_R2',
    bucketName: 'ps-site-s1-uploads',
    publicUrl: null,
    s3Endpoint: 'https://acct.r2.cloudflarestorage.com',
  })),
  deleteSiteR2: jest.fn(),
  deleteSiteR2Object: jest.fn(),
  ensureDefaultSiteR2: jest.fn(),
  getSiteR2Object: jest.fn(),
  hasObjectOpsForSite: jest.fn(async () => true),
  isValidBucketDisplayName: (s: unknown) =>
    typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/.test(s.trim()),
  listSiteR2Allocations: jest.fn(),
  listSiteR2Objects: jest.fn(),
  promoteSiteR2: jest.fn(),
  provisionSiteR2: jest.fn(),
  putSiteR2Object: jest.fn(),
  resolveSiteR2Allocation: jest.fn(),
  setSiteR2PublicAccess: jest.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow jest.mock (swc hoists the mocks)
import { r2Buckets } from '../handlers';
// eslint-disable-next-line import/first
import { errorHandler } from '../../../../src/middleware/error_handler.js';
// eslint-disable-next-line import/first
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
// eslint-disable-next-line import/first
import {
  deleteSiteR2,
  ensureDefaultSiteR2,
  getSiteR2Object,
  listSiteR2Allocations,
  provisionSiteR2,
  putSiteR2Object,
  resolveSiteR2Allocation,
} from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockEnsure = ensureDefaultSiteR2 as unknown as jest.Mock;
const mockListAlloc = listSiteR2Allocations as unknown as jest.Mock;
const mockProvision = provisionSiteR2 as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockDelete = deleteSiteR2 as unknown as jest.Mock;
const mockPut = putSiteR2Object as unknown as jest.Mock;
const mockGet = getSiteR2Object as unknown as jest.Mock;

function app(ids?: { orgId?: string; userId?: string }) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (ids?.orgId) c.set('orgId' as never, ids.orgId as never);
    if (ids?.userId) c.set('userId' as never, ids.userId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', r2Buckets);
  return a;
}
const authed = () => app({ orgId: 'org1', userId: 'u1' });

/** Mock env: D1 answers the `ownsSiteData` sites-ownership probe (owned unless `owned:false`). */
function mockEnv(opts: { owned?: boolean } = {}) {
  const owned = opts.owned ?? true;
  const DB = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () =>
              /FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null,
          };
        },
      };
    },
  };
  return { CF_ACCOUNT_ID: 'acct', DB } as never;
}

const sampleAllocation = {
  bucketName: 'ps-site-s1-uploads',
  createdAt: '2026-09-27T00:00:00.000Z',
  displayName: 'uploads',
  environment: 'preview' as const,
  id: 'alloc1',
  isDefault: true,
  publicAccess: false,
  publicBaseUrl: null,
};

beforeEach(() => {
  mockFlag.mockReset();
  mockEnsure.mockReset();
  mockListAlloc.mockReset();
  mockProvision.mockReset();
  mockResolveAlloc.mockReset();
  mockDelete.mockReset();
  mockPut.mockReset();
  mockGet.mockReset();
});

// REGRESSION (B5 slice 2): the `/objects/*` wildcard key extraction. Hono 4.x does NOT expose the
// trailing `*` as param('0')/param('*') (both undefined), so the key MUST come from the pathname after
// `/objects/`. These routes had ZERO coverage + object ops were never live, so the bug hid until the
// per-site-token flip turned object ops on. Guards that the key reaches the service verbatim.
describe('object routes — wildcard key extraction', () => {
  it('PUT forwards the exact (nested) object key + per-site ctx to putSiteR2Object', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    mockPut.mockResolvedValue({ key: 'a/b/c.txt', ok: true, size: 5 });
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/uploads/objects/a/b/c.txt',
      { body: 'hello', headers: { 'content-type': 'text/plain' }, method: 'PUT' },
      mockEnv(),
    );
    expect(res.status).toBe(201);
    const [, ctx, bucketName, key] = mockPut.mock.calls[0] as [unknown, { siteId: string; orgId: string }, string, string];
    expect(key).toBe('a/b/c.txt'); // was '' (null → 400) before the fix
    expect(bucketName).toBe('ps-site-s1-uploads');
    expect(ctx).toMatchObject({ orgId: 'org1', siteId: 's1' }); // per-site token resolution context
  });

  it('GET download forwards the exact key to getSiteR2Object', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    mockGet.mockResolvedValue({ body: new Uint8Array([1, 2]).buffer, contentType: 'image/png', ok: true, size: 2 });
    const res = await authed().request('/api/sites/s1/r2/buckets/uploads/objects/photo.png', {}, mockEnv());
    expect(res.status).toBe(200);
    expect((mockGet.mock.calls[0] as unknown[])[3]).toBe('photo.png');
  });

  it('400 when the key is empty (no segment after /objects/)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    const res = await authed().request('/api/sites/s1/r2/buckets/uploads/objects/', {}, mockEnv());
    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('GET /api/sites/:siteId/r2/buckets', () => {
  it('404 (DARK) when r2_buckets flag is off — ensure never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/r2/buckets', {}, mockEnv());
    expect(res.status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request('/api/sites/s1/r2/buckets', {}, mockEnv());
    expect(res.status).toBe(401);
  });

  it('404 (IDOR) when the caller does not own the site — ensure never runs', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/s1/r2/buckets', {}, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('lists the site\'s buckets (lazy-provisions the default) with the address bundle', async () => {
    mockFlag.mockResolvedValue(true);
    mockEnsure.mockResolvedValue({ allocation: sampleAllocation, ok: true, reused: false });
    mockListAlloc.mockResolvedValue([sampleAllocation]);
    const res = await authed().request('/api/sites/s1/r2/buckets', {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { buckets: Array<{ name: string; address: { s3Endpoint: string } }>; objectOpsAvailable: boolean };
    };
    expect(body.data.buckets).toHaveLength(1);
    expect(body.data.buckets[0].name).toBe('uploads');
    expect(body.data.buckets[0].address.s3Endpoint).toContain('r2.cloudflarestorage.com');
    expect(body.data.objectOpsAvailable).toBe(true);
  });
});

describe('POST /api/sites/:siteId/r2/buckets', () => {
  it('404 (DARK) when the flag is off — provision never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request(
      '/api/sites/s1/r2/buckets',
      { body: JSON.stringify({ name: 'assets' }), headers: { 'content-type': 'application/json' }, method: 'POST' },
      mockEnv(),
    );
    expect(res.status).toBe(404);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('400 on an invalid bucket name', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request(
      '/api/sites/s1/r2/buckets',
      { body: JSON.stringify({ name: '!!!' }), headers: { 'content-type': 'application/json' }, method: 'POST' },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('409 when a bucket with that display name already exists', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation); // dup exists
    const res = await authed().request(
      '/api/sites/s1/r2/buckets',
      { body: JSON.stringify({ name: 'uploads' }), headers: { 'content-type': 'application/json' }, method: 'POST' },
      mockEnv(),
    );
    expect(res.status).toBe(409);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('creates a bucket and returns the copyable address bundle (201)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // no dup
    mockProvision.mockResolvedValue({
      allocation: { ...sampleAllocation, displayName: 'assets', isDefault: false },
      ok: true,
      reused: false,
    });
    const res = await authed().request(
      '/api/sites/s1/r2/buckets',
      { body: JSON.stringify({ name: 'assets' }), headers: { 'content-type': 'application/json' }, method: 'POST' },
      mockEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { name: string; address: { bindingName: string } } };
    expect(body.data.name).toBe('assets');
    expect(body.data.address.bindingName).toBe('UPLOADS_R2');
  });

  it('surfaces a 503 needs-creds when provisioning has no CF credentials', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null);
    mockProvision.mockResolvedValue({ ok: false, reason: 'no_cf_credentials' });
    const res = await authed().request(
      '/api/sites/s1/r2/buckets',
      { body: JSON.stringify({ name: 'assets' }), headers: { 'content-type': 'application/json' }, method: 'POST' },
      mockEnv(),
    );
    expect(res.status).toBe(503);
  });
});

describe('DELETE /api/sites/:siteId/r2/buckets/:bucket', () => {
  it('404 (DARK) when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/r2/buckets/uploads', { method: 'DELETE' }, mockEnv());
    expect(res.status).toBe(404);
  });

  it('404 when the bucket is not one of the site\'s allocations', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // not the site's bucket
    const res = await authed().request('/api/sites/s1/r2/buckets/other', { method: 'DELETE' }, mockEnv());
    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('empties then deletes an owned bucket (200)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    mockDelete.mockResolvedValue({ deleted: true, objectsDeleted: 3, ok: true });
    const res = await authed().request('/api/sites/s1/r2/buckets/uploads', { method: 'DELETE' }, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean; objectsDeleted: number } };
    expect(body.data.deleted).toBe(true);
    expect(body.data.objectsDeleted).toBe(3);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
