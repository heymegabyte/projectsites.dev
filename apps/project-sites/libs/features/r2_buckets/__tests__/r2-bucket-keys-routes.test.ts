/**
 * Route-layer coverage for the PER-BUCKET owner-facing scoped R2 key surface (`r2_buckets/handlers.ts`
 * §bucket keys, B4). A finer grain than the site-wide owner key (slice 4): the key a SITE OWNER mints
 * scoped to ONE of their buckets. Proves:
 *   • the gate order that ships isolation BEFORE owner access — `r2_bucket_manager` flag off → 404 (DARK,
 *     never 403/leak) → unauth → 401 → foreign site (ownsSiteData) → 404 → unowned bucket
 *     (resolveSiteR2Allocation) → 404 → then the per-bucket key service;
 *   • CREATE returns the SHOW-ONCE secret (201) on a fresh mint + masked (200) when one already exists;
 *   • ROTATE returns a new show-once secret; REVOKE is idempotent; GET returns MASKED status (no secret);
 *   • the handler forwards the resolved REAL bucket name + per-site ctx to the service.
 *
 * `isFlagOn` + the `site_r2` service are mocked so the handler logic is tested in isolation; the
 * `ownsSiteData` IDOR guard runs for real against a mock D1. (A jest.mock of a src/ module from this dir
 * needs FOUR `../`; the GLOBAL `jest` is used so @swc hoists the mocks above the handler import.)
 */
import { Hono } from 'hono';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../../../../src/services/site_r2.js', () => ({
  // Per-bucket key service (B4) — the functions under test.
  createBucketOwnerKey: jest.fn(),
  getBucketOwnerKeyStatus: jest.fn(),
  revokeBucketOwnerKey: jest.fn(),
  rotateBucketOwnerKey: jest.fn(),
  // resolveSiteR2Allocation gates the bucket (real site-scoped resolve) — mocked to return an allocation.
  resolveSiteR2Allocation: jest.fn(),
  // The rest of the surface the handler module imports (unused here but required so the import resolves).
  bucketAddress: jest.fn(() => ({
    accountId: 'acct',
    bindingName: 'ALPHA_R2',
    bucketName: 'ps-site-s1-alpha',
    publicUrl: null,
    s3Endpoint: 'https://acct.r2.cloudflarestorage.com',
  })),
  createSiteOwnerKey: jest.fn(),
  deleteSiteR2: jest.fn(),
  deleteSiteR2Object: jest.fn(),
  ensureDefaultSiteR2: jest.fn(),
  getSiteOwnerKeyStatus: jest.fn(),
  getSiteR2Object: jest.fn(),
  hasObjectOpsForSite: jest.fn(async () => true),
  isValidBucketDisplayName: (s: unknown) =>
    typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/.test(s.trim()),
  listSiteR2Allocations: jest.fn(),
  listSiteR2Objects: jest.fn(),
  promoteSiteR2: jest.fn(),
  provisionSiteR2: jest.fn(),
  putSiteR2Object: jest.fn(),
  revokeSiteOwnerKey: jest.fn(),
  rotateSiteOwnerKey: jest.fn(),
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
  createBucketOwnerKey,
  getBucketOwnerKeyStatus,
  resolveSiteR2Allocation,
  revokeBucketOwnerKey,
  rotateBucketOwnerKey,
} from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockCreate = createBucketOwnerKey as unknown as jest.Mock;
const mockRotate = rotateBucketOwnerKey as unknown as jest.Mock;
const mockRevoke = revokeBucketOwnerKey as unknown as jest.Mock;
const mockStatus = getBucketOwnerKeyStatus as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;

const REAL_BUCKET = 'ps-site-s1-alpha';
const ALLOC = {
  bucketName: REAL_BUCKET,
  createdAt: '2026-10-10T00:00:00.000Z',
  displayName: 'Alpha',
  environment: 'preview' as const,
  id: 'alloc-a',
  isDefault: false,
  publicAccess: false,
  publicBaseUrl: null,
};

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

const SHOW_ONCE = {
  accessKeyId: 'AKIABUCKET12345',
  createdAt: '2026-10-10T00:00:00.000Z',
  secretAccessKey: 'bucket-secret-shown-once-abcdef0123456789',
  status: 'active' as const,
};
const MASKED = {
  accessKeyIdMasked: 'AKIA…2345',
  createdAt: '2026-10-10T00:00:00.000Z',
  exists: true,
  rotatedAt: null,
  status: 'active' as const,
};

const BUCKET_KEYS = `/api/sites/s1/r2/buckets/${encodeURIComponent('Alpha')}/keys`;
const post = { method: 'POST' as const };
const del = { method: 'DELETE' as const };

beforeEach(() => {
  mockFlag.mockReset();
  mockCreate.mockReset();
  mockRotate.mockReset();
  mockRevoke.mockReset();
  mockStatus.mockReset();
  mockResolveAlloc.mockReset();
  mockResolveAlloc.mockResolvedValue(ALLOC); // owned bucket resolves by default
});

describe('per-bucket key gate order (isolation before owner access)', () => {
  it('GET 404 (DARK) when r2_bucket_manager is off — service never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request(BUCKET_KEYS, {}, mockEnv());
    expect(res.status).toBe(404);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('POST create 404 (DARK) when the flag is off — create never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request(BUCKET_KEYS, post, mockEnv());
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request(BUCKET_KEYS, {}, mockEnv());
    expect(res.status).toBe(401);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the caller does NOT own the site — service never runs', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request(BUCKET_KEYS, post, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('404 when the bucket is not one of the site’s allocations (unowned bucket)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // bucket not found for this site
    const res = await authed().request(BUCKET_KEYS, post, mockEnv());
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/sites/:siteId/r2/buckets/:bucket/keys — create', () => {
  it('returns the SHOW-ONCE secret (201) on a fresh mint + forwards the REAL bucket name', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ key: SHOW_ONCE, ok: true, reused: false });
    const res = await authed().request(BUCKET_KEYS, post, mockEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { secretAccessKey?: string; accessKeyId?: string } };
    expect(body.data.secretAccessKey).toBe(SHOW_ONCE.secretAccessKey);
    expect(body.data.accessKeyId).toBe(SHOW_ONCE.accessKeyId);
    // ctx + the RESOLVED real bucket name (not the display name) are forwarded to the service.
    expect(mockCreate.mock.calls[0]?.[1]).toMatchObject({ orgId: 'org1', siteId: 's1', tenantId: 'org1' });
    expect(mockCreate.mock.calls[0]?.[2]).toBe(REAL_BUCKET);
  });

  it('returns MASKED status (200, NO secret) when a per-bucket key already exists (idempotent)', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ key: MASKED, ok: true, reused: true });
    const res = await authed().request(BUCKET_KEYS, post, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.accessKeyIdMasked).toBe('AKIA…2345');
    expect(body.data).not.toHaveProperty('secretAccessKey');
  });

  it('surfaces a 404 when the service reports the bucket is not allocated (defense-in-depth)', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ ok: false, reason: 'not_allocated' });
    const res = await authed().request(BUCKET_KEYS, post, mockEnv());
    expect(res.status).toBe(404);
  });

  it('surfaces a 503 needs-creds when minting has no CF credentials', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ ok: false, reason: 'no_cf_credentials' });
    const res = await authed().request(BUCKET_KEYS, post, mockEnv());
    expect(res.status).toBe(503);
  });
});

describe('POST /api/sites/:siteId/r2/buckets/:bucket/keys/rotate — rotate', () => {
  it('revokes old + returns a NEW show-once secret (201)', async () => {
    mockFlag.mockResolvedValue(true);
    const rotated = { ...SHOW_ONCE, accessKeyId: 'AKIAROT99', secretAccessKey: 'rotated-bucket-secret' };
    mockRotate.mockResolvedValue({ key: rotated, ok: true });
    const res = await authed().request(`${BUCKET_KEYS}/rotate`, post, mockEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { secretAccessKey?: string } };
    expect(body.data.secretAccessKey).toBe('rotated-bucket-secret');
    expect(mockRotate.mock.calls[0]?.[2]).toBe(REAL_BUCKET);
  });

  it('404 (DARK) when the flag is off — rotate never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request(`${BUCKET_KEYS}/rotate`, post, mockEnv());
    expect(res.status).toBe(404);
    expect(mockRotate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/sites/:siteId/r2/buckets/:bucket/keys — revoke', () => {
  it('revokes an existing key (200, revoked:true)', async () => {
    mockFlag.mockResolvedValue(true);
    mockRevoke.mockResolvedValue({ ok: true, revoked: true });
    const res = await authed().request(BUCKET_KEYS, del, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { revoked: boolean } };
    expect(body.data.revoked).toBe(true);
    expect(mockRevoke.mock.calls[0]?.[2]).toBe(REAL_BUCKET);
  });

  it('is idempotent (200, revoked:false) when no key exists', async () => {
    mockFlag.mockResolvedValue(true);
    mockRevoke.mockResolvedValue({ ok: true, revoked: false });
    const res = await authed().request(BUCKET_KEYS, del, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { revoked: boolean } };
    expect(body.data.revoked).toBe(false);
  });
});

describe('GET /api/sites/:siteId/r2/buckets/:bucket/keys — masked status', () => {
  it('returns the MASKED status WITHOUT the secret', async () => {
    mockFlag.mockResolvedValue(true);
    mockStatus.mockResolvedValue({ key: MASKED, ok: true });
    const res = await authed().request(BUCKET_KEYS, {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.exists).toBe(true);
    expect(body.data.accessKeyIdMasked).toBe('AKIA…2345');
    expect(body.data).not.toHaveProperty('secretAccessKey');
    expect(body.data).not.toHaveProperty('secret');
  });

  it('returns the calm empty state when no per-bucket key exists', async () => {
    mockFlag.mockResolvedValue(true);
    mockStatus.mockResolvedValue({
      key: { accessKeyIdMasked: null, createdAt: null, exists: false, rotatedAt: null, status: 'none' },
      ok: true,
    });
    const res = await authed().request(BUCKET_KEYS, {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { exists: boolean; status: string } };
    expect(body.data.exists).toBe(false);
    expect(body.data.status).toBe('none');
  });
});
