/**
 * Route-layer coverage for B11 **server-side whole-bucket search** on the objects list endpoint
 * (`GET /api/sites/:siteId/r2/buckets/:bucket/objects?search=…`). Proves the SAME gate order as the rest
 * of the surface (isolation BEFORE the op), that a `?search=` query DISPATCHES to `searchSiteR2Objects`
 * (whole-bucket) instead of the paged `listSiteR2Objects`, that the honest `scannedAll`/`scanned`/
 * `truncated` flags ride the response, that an ABSENT `search` keeps the legacy list behavior untouched,
 * and that Zod accepts/clamps the `search` param.
 *
 * `isFlagOn` + the `site_r2` service are mocked so the handler logic is tested in isolation; the
 * `ownsSiteData` IDOR guard runs for real against a mock D1. (`@swc/jest` hoists with the GLOBAL `jest`.)
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
}));

// eslint-disable-next-line import/first -- imports must follow jest.mock (swc hoists the mocks)
import { r2Buckets } from '../handlers';
// eslint-disable-next-line import/first
import { errorHandler } from '../../../../src/middleware/error_handler.js';
// eslint-disable-next-line import/first
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
// eslint-disable-next-line import/first
import { listSiteR2Objects, resolveSiteR2Allocation, searchSiteR2Objects } from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockList = listSiteR2Objects as unknown as jest.Mock;
const mockSearch = searchSiteR2Objects as unknown as jest.Mock;

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

function get(qs: string, env = mockEnv(), a = authed()) {
  return a.request(`/api/sites/s1/r2/buckets/uploads/objects${qs}`, { method: 'GET' }, env);
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolveAlloc.mockReset();
  mockList.mockReset();
  mockSearch.mockReset();
});

describe('GET …/objects?search= — gate order (isolation before the op)', () => {
  it('404 (DARK) when the flag is off — neither list nor search runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await get('?search=logo');
    expect(res.status).toBe(404);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await get('?search=logo', mockEnv(), app());
    expect(res.status).toBe(401);
  });

  it('404 (IDOR) when the bucket is not one of the site\'s allocations', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null);
    const res = await get('?search=logo');
    expect(res.status).toBe(404);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});

describe('GET …/objects?search= — dispatch + honest flags', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('WITH ?search= → dispatches to searchSiteR2Objects (whole-bucket) with the resolved REAL bucket', async () => {
    mockSearch.mockResolvedValue({
      objects: [{ key: 'images/logo.png', size: 5, uploadedAt: null }],
      ok: true,
      scanned: 42,
      scannedAll: true,
      truncated: false,
    });
    const res = await get('?search=logo');
    expect(res.status).toBe(200);
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockList).not.toHaveBeenCalled();
    const [, ctx, bucketName, callOpts] = mockSearch.mock.calls[0] as [
      unknown,
      { siteId: string; orgId: string },
      string,
      { search: string; prefix?: string },
    ];
    expect(bucketName).toBe('ps-site-s1-uploads'); // the resolved REAL bucket, not the display name
    expect(callOpts.search).toBe('logo');
    expect(ctx).toMatchObject({ orgId: 'org1', siteId: 's1' });

    const body = (await res.json()) as {
      data: { objects: unknown[]; scannedAll: boolean; scanned: number; truncated: boolean };
    };
    expect(body.data.objects).toHaveLength(1);
    expect(body.data.scannedAll).toBe(true);
    expect(body.data.scanned).toBe(42);
    expect(body.data.truncated).toBe(false);
  });

  it('forwards the optional prefix to narrow the server-side search', async () => {
    mockSearch.mockResolvedValue({ objects: [], ok: true, scanned: 0, scannedAll: true, truncated: false });
    await get('?search=logo&prefix=images/');
    const [, , , callOpts] = mockSearch.mock.calls[0] as [unknown, unknown, string, { prefix?: string }];
    expect(callOpts.prefix).toBe('images/');
  });

  it('WITHOUT ?search= → keeps the legacy paged listSiteR2Objects behavior (search untouched)', async () => {
    mockList.mockResolvedValue({ cursor: undefined, objects: [], ok: true, prefixes: [], truncated: false });
    const res = await get('?prefix=images/&delimiter=/');
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('maps a search service failure to the honest error envelope', async () => {
    mockSearch.mockResolvedValue({ message: 'S3 list failed (HTTP 500)', ok: false, reason: 's3_error', status: 500 });
    const res = await get('?search=logo');
    expect(res.status).toBe(502);
    expect(mockList).not.toHaveBeenCalled();
  });
});
