/**
 * Route-layer coverage for the B6 bucket CLONE endpoint
 * (`POST /api/sites/:siteId/r2/buckets/:bucket/clone`). Proves the SAME gate order the rest of the surface
 * ships (isolation BEFORE the op): flag off → 404 (DARK) → unauth → 401 → foreign site → 404 →
 * foreign/other SOURCE bucket (the per-bucket IDOR guard) → 404 → then and only then the clone op. Also
 * proves the success response carries the clone summary + the NEW bucket view, the 409 name-collision
 * mapping, Zod validation (missing/invalid name rejected), the honest truncation flags, and that the audit
 * log records `r2.bucket.cloned` with the source + new names + copied count.
 *
 * `isFlagOn` + the `site_r2` service + `writeAuditLog` are mocked so the handler logic is tested in
 * isolation; the `ownsSiteData` IDOR guard runs for real against a mock D1. `@swc/jest` only hoists
 * `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import { Hono } from 'hono';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../../../../src/services/audit.js', () => ({ writeAuditLog: jest.fn(async () => undefined) }));
jest.mock('../../../../src/services/site_r2.js', () => ({
  bucketAddress: jest.fn(() => ({ s3Endpoint: 'https://acct.r2.cloudflarestorage.com', bindingName: 'B', bucket: 'x', publicUrl: null })),
  cloneSiteR2Bucket: jest.fn(),
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
import { writeAuditLog } from '../../../../src/services/audit.js';
// eslint-disable-next-line import/first
import { cloneSiteR2Bucket, resolveSiteR2Allocation } from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockClone = cloneSiteR2Bucket as unknown as jest.Mock;
const mockAudit = writeAuditLog as unknown as jest.Mock;

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
/** The provisioned NEW bucket the service hands back in the summary. */
const newAllocation = {
  bucketName: 'ps-site-s1-uploads-copy',
  createdAt: '2026-10-10T00:00:00.000Z',
  displayName: 'uploads-copy',
  environment: 'preview' as const,
  id: 'alloc2',
  isDefault: false,
  publicAccess: false,
  publicBaseUrl: null,
};

/** POST the clone endpoint with a JSON body. */
function post(body: unknown, env = mockEnv(), a = authed()) {
  return a.request(
    '/api/sites/s1/r2/buckets/uploads/clone',
    { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' },
    env,
  );
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolveAlloc.mockReset();
  mockClone.mockReset();
  mockAudit.mockClear();
});

describe('POST …/clone — gate order (isolation before the op)', () => {
  it('404 (DARK) when the flag is off — clone never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await post({ name: 'uploads-copy' });
    expect(res.status).toBe(404);
    expect(mockClone).not.toHaveBeenCalled();
    expect(mockResolveAlloc).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await post({ name: 'uploads-copy' }, mockEnv(), app());
    expect(res.status).toBe(401);
    expect(mockClone).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the caller does not own the site — source bucket never resolves', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await post({ name: 'uploads-copy' }, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolveAlloc).not.toHaveBeenCalled();
    expect(mockClone).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the SOURCE bucket is NOT one of the site\'s allocations (foreign bucket)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // not the site's bucket → the per-bucket guard trips
    const res = await post({ name: 'uploads-copy' });
    expect(res.status).toBe(404);
    expect(mockClone).not.toHaveBeenCalled();
  });
});

describe('POST …/clone — validation + success + honest summary', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('400 when the new name is missing / invalid (Zod) — clone never runs', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(mockClone).not.toHaveBeenCalled();
  });

  it('201 → clones the RESOLVED real source bucket; returns the summary + the new bucket view; audits r2.bucket.cloned', async () => {
    mockClone.mockResolvedValue({
      copiedCount: 3,
      newAllocation,
      newBucket: 'ps-site-s1-uploads-copy',
      ok: true,
      totalCount: 3,
      truncated: false,
    });
    const res = await post({ name: 'uploads-copy' });
    expect(res.status).toBe(201);

    // The service was called with the RESOLVED real source bucket (not the display name) + the new NAME.
    const [, ctx, srcBucket, newName] = mockClone.mock.calls[0] as [unknown, { siteId: string; orgId: string }, string, string];
    expect(srcBucket).toBe('ps-site-s1-uploads');
    expect(newName).toBe('uploads-copy');
    expect(ctx).toMatchObject({ orgId: 'org1', siteId: 's1' });

    const body = (await res.json()) as { data: { copiedCount: number; totalCount: number; truncated: boolean; bucket: { name: string } } };
    expect(body.data.copiedCount).toBe(3);
    expect(body.data.totalCount).toBe(3);
    expect(body.data.truncated).toBe(false);
    expect(body.data.bucket.name).toBe('uploads-copy'); // the new bucket view

    // Audit records BOTH names + the copied count.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const audit = (mockAudit.mock.calls[0] as [unknown, { action: string; metadata_json: Record<string, unknown> }])[1];
    expect(audit.action).toBe('r2.bucket.cloned');
    expect(audit.metadata_json).toMatchObject({ sourceBucket: 'uploads', newBucket: 'uploads-copy', copiedCount: 3 });
  });

  it('truncated clone → the summary carries truncated:true with copied<total', async () => {
    mockClone.mockResolvedValue({
      copiedCount: 1000,
      newAllocation,
      newBucket: 'ps-site-s1-uploads-copy',
      ok: true,
      totalCount: 4096,
      truncated: true,
    });
    const res = await post({ name: 'uploads-copy' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { copiedCount: number; totalCount: number; truncated: boolean } };
    expect(body.data.truncated).toBe(true);
    expect(body.data.copiedCount).toBe(1000);
    expect(body.data.totalCount).toBe(4096);
  });
});

describe('POST …/clone — honest failure mapping', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('409 when a bucket with the new name already exists (destination_exists → CONFLICT) — no audit', async () => {
    mockClone.mockResolvedValue({ ok: false, reason: 'destination_exists' });
    const res = await post({ name: 'uploads' });
    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('503 needs-creds when object storage is still being set up', async () => {
    mockClone.mockResolvedValue({ ok: false, reason: 'needs_s3_credentials' });
    const res = await post({ name: 'uploads-copy' });
    expect(res.status).toBe(503);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('502 on a real S3 error (partial clone) — never a partial-but-ok lie, no audit', async () => {
    mockClone.mockResolvedValue({ ok: false, reason: 's3_error', status: 500 });
    const res = await post({ name: 'uploads-copy' });
    expect(res.status).toBe(502);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
