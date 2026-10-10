/**
 * Route-layer coverage for the owner-facing scoped R2 key surface (`r2_buckets/handlers.ts` §keys, B5
 * slice 4). A SEPARATE credential from the Worker's internal object-ops token: the key a SITE OWNER
 * mints to use R2 from their OWN tooling. Proves:
 *   • the gate order that ships isolation BEFORE owner access — `r2_bucket_manager` flag off → 404 (DARK,
 *     never 403/leak) → unauth → 401 → foreign site (ownsSiteData) → 404 → then the owner-key service;
 *   • CREATE returns the SHOW-ONCE secret (201) on a fresh mint + masked (200) when one already exists;
 *   • ROTATE returns a new show-once secret; REVOKE is idempotent; GET returns MASKED status (no secret);
 *   • the show-once secret rides create/rotate ONLY and the masked GET never carries it.
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
  // Owner-key service (slice 4) — the functions under test.
  createSiteOwnerKey: jest.fn(),
  getSiteOwnerKeyStatus: jest.fn(),
  revokeSiteOwnerKey: jest.fn(),
  rotateSiteOwnerKey: jest.fn(),
  // The rest of the surface the handler module imports (unused here but required so the import resolves).
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
  createSiteOwnerKey,
  getSiteOwnerKeyStatus,
  revokeSiteOwnerKey,
  rotateSiteOwnerKey,
} from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockCreate = createSiteOwnerKey as unknown as jest.Mock;
const mockRotate = rotateSiteOwnerKey as unknown as jest.Mock;
const mockRevoke = revokeSiteOwnerKey as unknown as jest.Mock;
const mockStatus = getSiteOwnerKeyStatus as unknown as jest.Mock;

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
  accessKeyId: 'AKIAEXAMPLE1234',
  createdAt: '2026-10-10T00:00:00.000Z',
  secretAccessKey: 'super-secret-shown-once-abcdef0123456789',
  status: 'active' as const,
};
const MASKED = {
  accessKeyIdMasked: 'AKIA…1234',
  createdAt: '2026-10-10T00:00:00.000Z',
  exists: true,
  rotatedAt: null,
  status: 'active' as const,
};

beforeEach(() => {
  mockFlag.mockReset();
  mockCreate.mockReset();
  mockRotate.mockReset();
  mockRevoke.mockReset();
  mockStatus.mockReset();
});

const post = { method: 'POST' as const };
const del = { method: 'DELETE' as const };

describe('owner-key gate order (isolation before owner access)', () => {
  it('GET 404 (DARK) when r2_bucket_manager is off — service never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/r2/keys', {}, mockEnv());
    expect(res.status).toBe(404);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('POST create 404 (DARK) when the flag is off — create never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/r2/keys', post, mockEnv());
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request('/api/sites/s1/r2/keys', {}, mockEnv());
    expect(res.status).toBe(401);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the caller does NOT own the site (cross-org) — service never runs', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/s1/r2/keys', {}, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('POST create 404 (IDOR) on a foreign site — create never runs', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/s1/r2/keys', post, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/sites/:siteId/r2/keys — create', () => {
  it('returns the SHOW-ONCE secret (201) on a fresh mint', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ key: SHOW_ONCE, ok: true, reused: false });
    const res = await authed().request('/api/sites/s1/r2/keys', post, mockEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { secretAccessKey?: string; accessKeyId?: string } };
    expect(body.data.secretAccessKey).toBe(SHOW_ONCE.secretAccessKey);
    expect(body.data.accessKeyId).toBe(SHOW_ONCE.accessKeyId);
    // The handler forwards the per-site ctx (orgId + siteId + tenantId) to the service.
    expect(mockCreate.mock.calls[0]?.[1]).toMatchObject({ orgId: 'org1', siteId: 's1', tenantId: 'org1' });
  });

  it('returns MASKED status (200, NO secret) when an active key already exists (idempotent)', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ key: MASKED, ok: true, reused: true });
    const res = await authed().request('/api/sites/s1/r2/keys', post, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.accessKeyIdMasked).toBe('AKIA…1234');
    expect(body.data).not.toHaveProperty('secretAccessKey'); // show-once NEVER re-served
  });

  it('surfaces a 503 needs-creds when minting has no CF credentials', async () => {
    mockFlag.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ ok: false, reason: 'no_cf_credentials' });
    const res = await authed().request('/api/sites/s1/r2/keys', post, mockEnv());
    expect(res.status).toBe(503);
  });
});

describe('POST /api/sites/:siteId/r2/keys/rotate — rotate', () => {
  it('revokes old + returns a NEW show-once secret (201)', async () => {
    mockFlag.mockResolvedValue(true);
    const rotated = { ...SHOW_ONCE, accessKeyId: 'AKIAROTATED9999', secretAccessKey: 'rotated-secret-xyz' };
    mockRotate.mockResolvedValue({ key: rotated, ok: true });
    const res = await authed().request('/api/sites/s1/r2/keys/rotate', post, mockEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { secretAccessKey?: string; accessKeyId?: string } };
    expect(body.data.secretAccessKey).toBe('rotated-secret-xyz');
    expect(body.data.accessKeyId).toBe('AKIAROTATED9999');
    expect(mockRotate).toHaveBeenCalledTimes(1);
  });

  it('404 (DARK) when the flag is off — rotate never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/r2/keys/rotate', post, mockEnv());
    expect(res.status).toBe(404);
    expect(mockRotate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/sites/:siteId/r2/keys — revoke', () => {
  it('revokes an existing key (200, revoked:true)', async () => {
    mockFlag.mockResolvedValue(true);
    mockRevoke.mockResolvedValue({ ok: true, revoked: true });
    const res = await authed().request('/api/sites/s1/r2/keys', del, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { revoked: boolean } };
    expect(body.data.revoked).toBe(true);
  });

  it('is idempotent (200, revoked:false) when no key exists', async () => {
    mockFlag.mockResolvedValue(true);
    mockRevoke.mockResolvedValue({ ok: true, revoked: false });
    const res = await authed().request('/api/sites/s1/r2/keys', del, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { revoked: boolean } };
    expect(body.data.revoked).toBe(false);
  });

  it('404 (DARK) when the flag is off — revoke never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/r2/keys', del, mockEnv());
    expect(res.status).toBe(404);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('GET /api/sites/:siteId/r2/keys — masked status', () => {
  it('returns the MASKED status WITHOUT the secret', async () => {
    mockFlag.mockResolvedValue(true);
    mockStatus.mockResolvedValue({ key: MASKED, ok: true });
    const res = await authed().request('/api/sites/s1/r2/keys', {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.exists).toBe(true);
    expect(body.data.accessKeyIdMasked).toBe('AKIA…1234');
    expect(body.data.status).toBe('active');
    expect(body.data).not.toHaveProperty('secretAccessKey'); // NEVER the secret
    expect(body.data).not.toHaveProperty('secret');
  });

  it('returns the calm empty state when no key exists', async () => {
    mockFlag.mockResolvedValue(true);
    mockStatus.mockResolvedValue({
      key: { accessKeyIdMasked: null, createdAt: null, exists: false, rotatedAt: null, status: 'none' },
      ok: true,
    });
    const res = await authed().request('/api/sites/s1/r2/keys', {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { exists: boolean; status: string } };
    expect(body.data.exists).toBe(false);
    expect(body.data.status).toBe('none');
  });
});
