/**
 * Route-layer coverage for the B7 bucket ZIP export endpoint
 * (`GET /api/sites/:siteId/r2/buckets/:bucket/zip`). Proves the SAME gate order the rest of the surface
 * ships (isolation BEFORE the op): flag off → 404 (DARK) → unauth → 401 → foreign site → 404 →
 * foreign/other bucket (the per-bucket IDOR guard) → 404 → then and only then the zip op. Also proves the
 * success response is a raw `application/zip` download with the right `Content-Disposition` filename and
 * the honest truncation headers (`x-ps-zip-truncated` / `x-ps-zip-count` / `x-ps-zip-total` /
 * `x-ps-zip-bytes`), plus the honest failure mapping (503 needs-creds, 502 s3_error).
 *
 * `isFlagOn` + the `site_r2` service are mocked so the handler logic is tested in isolation; the
 * `ownsSiteData` IDOR guard runs for real against a mock D1. `@swc/jest` only hoists `jest.mock(...)` with
 * the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import { Hono } from 'hono';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../../../../src/services/audit.js', () => ({ writeAuditLog: jest.fn(async () => undefined) }));
jest.mock('../../../../src/services/site_r2.js', () => ({
  bucketAddress: jest.fn(),
  copySiteR2Object: jest.fn(),
  deleteSiteR2: jest.fn(),
  deleteSiteR2Object: jest.fn(),
  ensureDefaultSiteR2: jest.fn(),
  getSiteR2Object: jest.fn(),
  hasObjectOpsForSite: jest.fn(async () => true),
  isValidBucketDisplayName: jest.fn(() => true),
  listSiteR2Allocations: jest.fn(),
  listSiteR2Objects: jest.fn(),
  moveSiteR2Prefix: jest.fn(),
  promoteSiteR2: jest.fn(),
  provisionSiteR2: jest.fn(),
  putSiteR2Object: jest.fn(),
  renameSiteR2Object: jest.fn(),
  resolveSiteR2Allocation: jest.fn(),
  searchSiteR2Objects: jest.fn(),
  setSiteR2PublicAccess: jest.fn(),
  zipSiteR2Bucket: jest.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow jest.mock (swc hoists the mocks)
import { r2Buckets } from '../handlers';
// eslint-disable-next-line import/first
import { errorHandler } from '../../../../src/middleware/error_handler.js';
// eslint-disable-next-line import/first
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
// eslint-disable-next-line import/first
import { resolveSiteR2Allocation, zipSiteR2Bucket } from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockZip = zipSiteR2Bucket as unknown as jest.Mock;

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

/** GET the zip endpoint. */
function get(env = mockEnv(), a = authed()) {
  return a.request('/api/sites/s1/r2/buckets/uploads/zip', { method: 'GET' }, env);
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolveAlloc.mockReset();
  mockZip.mockReset();
});

describe('GET …/r2/buckets/:bucket/zip — gate order (isolation before the op)', () => {
  it('404 (DARK) when the r2_bucket_manager flag is off — zip never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockZip).not.toHaveBeenCalled();
    expect(mockResolveAlloc).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await get(mockEnv(), app());
    expect(res.status).toBe(401);
    expect(mockZip).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the caller does not own the site — bucket never resolves', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await get(mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolveAlloc).not.toHaveBeenCalled();
    expect(mockZip).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the bucket is NOT one of the site\'s allocations (foreign bucket)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // not the site's bucket → the per-bucket guard trips
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockZip).not.toHaveBeenCalled();
  });
});

describe('GET …/r2/buckets/:bucket/zip — success download + honest headers', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('200 application/zip with Content-Disposition {bucket}.zip + not-truncated headers; zips the RESOLVED real bucket', async () => {
    const fakeZip = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]); // PK… sentinel bytes
    mockZip.mockResolvedValue({
      bytesIncluded: 42,
      filename: 'ps-site-s1-uploads.zip',
      includedCount: 3,
      ok: true,
      totalCount: 3,
      truncated: false,
      zip: fakeZip,
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    // Filename uses the owner's display name (friendlier than the real `ps-site-…` name).
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="uploads.zip"');
    expect(res.headers.get('x-ps-zip-truncated')).toBe('false');
    expect(res.headers.get('x-ps-zip-count')).toBe('3');
    expect(res.headers.get('x-ps-zip-total')).toBe('3');
    expect(res.headers.get('x-ps-zip-bytes')).toBe('42');

    // The service was called with the RESOLVED real bucket (not the display name) + the right ctx.
    const [, ctx, bucketName] = mockZip.mock.calls[0] as [unknown, { siteId: string; orgId: string }, string];
    expect(bucketName).toBe('ps-site-s1-uploads');
    expect(ctx).toMatchObject({ orgId: 'org1', siteId: 's1' });

    // The body is the raw zip bytes.
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(fakeZip));
  });

  it('truncated export → x-ps-zip-truncated:true with the honest included<total counts', async () => {
    mockZip.mockResolvedValue({
      bytesIncluded: 100 * 1024 * 1024,
      filename: 'ps-site-s1-uploads.zip',
      includedCount: 1000,
      ok: true,
      totalCount: 4096,
      truncated: true,
      zip: new Uint8Array([0x50, 0x4b, 5, 6]),
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ps-zip-truncated')).toBe('true');
    expect(res.headers.get('x-ps-zip-count')).toBe('1000');
    expect(res.headers.get('x-ps-zip-total')).toBe('4096');
  });

  it('empty bucket → still a 200 zip download (count 0, not truncated)', async () => {
    mockZip.mockResolvedValue({
      bytesIncluded: 0,
      filename: 'ps-site-s1-uploads.zip',
      includedCount: 0,
      ok: true,
      totalCount: 0,
      truncated: false,
      zip: new Uint8Array([0x50, 0x4b, 5, 6, 0, 0]),
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ps-zip-count')).toBe('0');
  });
});

describe('GET …/r2/buckets/:bucket/zip — honest failure mapping', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('503 needs-creds when object storage is still being set up', async () => {
    mockZip.mockResolvedValue({ ok: false, reason: 'needs_s3_credentials' });
    const res = await get();
    expect(res.status).toBe(503);
  });

  it('502 on a real S3 error (never a partial-but-ok lie)', async () => {
    mockZip.mockResolvedValue({ ok: false, reason: 's3_error', status: 500 });
    const res = await get();
    expect(res.status).toBe(502);
  });
});
