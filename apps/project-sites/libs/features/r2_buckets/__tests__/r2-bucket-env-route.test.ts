/**
 * B10 — route coverage for `POST /api/sites/:siteId/r2/buckets/:bucket/environment` (reversible env
 * reassignment). Proves the gate order ships isolation BEFORE the mutation:
 *   flag off → 404 (DARK) → unauth → 401 → foreign site (ownsSiteData) → 404 → foreign BUCKET
 *   (resolveSiteR2Allocation null, the IDOR guard) → 404 → then and only then `assignBucketEnv`.
 * Also proves: a bad body → 400; the success reply carries `previousEnvironment` (so the UI can roll
 * back); the 2-default invariant violation surfaces as 409 CONFLICT; and the audit is written.
 *
 * `isFlagOn` + the `site_r2` service + `writeAuditLog` are mocked so the handler logic is tested in
 * isolation; the `ownsSiteData` IDOR guard runs for real against a mock D1.
 */
import { Hono } from 'hono';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../../../../src/services/audit.js', () => ({
  writeAuditLog: jest.fn(async () => undefined),
}));
jest.mock('../../../../src/services/site_r2.js', () => ({
  assignBucketEnv: jest.fn(),
  bucketAddress: jest.fn(() => ({
    accountId: 'acct',
    bindingName: 'MEDIA_R2',
    bucketName: 'ps-site-s1-media',
    publicUrl: null,
    s3Endpoint: 'https://acct.r2.cloudflarestorage.com',
  })),
  resolveSiteR2Allocation: jest.fn(),
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
import { assignBucketEnv, resolveSiteR2Allocation } from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockAssign = assignBucketEnv as unknown as jest.Mock;
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
  bucketName: 'ps-site-s1-media',
  createdAt: '2026-09-27T00:00:00.000Z',
  displayName: 'Media',
  environment: 'preview' as const,
  id: 'alloc1',
  isDefault: false,
  publicAccess: false,
  publicBaseUrl: null,
};

function req(body: unknown) {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolveAlloc.mockReset();
  mockAssign.mockReset();
  mockAudit.mockClear();
});

describe('POST /api/sites/:siteId/r2/buckets/:bucket/environment', () => {
  it('404 (DARK) when the r2_buckets flag is off — assign never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/Media/environment',
      req({ environment: 'production' }),
      mockEnv(),
    );
    expect(res.status).toBe(404);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request(
      '/api/sites/s1/r2/buckets/Media/environment',
      req({ environment: 'production' }),
      mockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('404 (IDOR) when the caller does not own the site', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/Media/environment',
      req({ environment: 'production' }),
      mockEnv({ owned: false }),
    );
    expect(res.status).toBe(404);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the bucket is not one of the site\'s allocations (foreign bucket)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // foreign / unknown bucket
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/Someone-Elses/environment',
      req({ environment: 'production' }),
      mockEnv(),
    );
    expect(res.status).toBe(404);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('400 on an invalid environment value', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/Media/environment',
      req({ environment: 'staging' }),
      mockEnv(),
    );
    expect(res.status).toBe(400);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('reassigns + returns the previousEnvironment (so the UI can roll back) + audits', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    mockAssign.mockResolvedValue({
      bucket: { ...sampleAllocation, environment: 'production' },
      ok: true,
      previousEnvironment: 'preview',
    });
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/Media/environment',
      req({ environment: 'production' }),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { previousEnvironment: string; bucket: { environment: string; name: string } };
    };
    expect(body.data.previousEnvironment).toBe('preview');
    expect(body.data.bucket.environment).toBe('production');
    expect(body.data.bucket.name).toBe('Media');

    // The forwarded args: resolved allocation + the new environment.
    const [, siteId, alloc, newEnv] = mockAssign.mock.calls[0] as [unknown, string, { displayName: string }, string];
    expect(siteId).toBe('s1');
    expect(alloc.displayName).toBe('Media');
    expect(newEnv).toBe('production');

    // Audit written with from/to + bucket.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const auditArg = (mockAudit.mock.calls[0] as unknown[])[1] as {
      action: string;
      metadata_json: { bucket: string; from: string; to: string };
    };
    expect(auditArg.action).toBe('r2.bucket.env_reassigned');
    expect(auditArg.metadata_json).toMatchObject({ bucket: 'Media', from: 'preview', to: 'production' });
  });

  it('409 CONFLICT when the 2-default invariant would break (default_invariant) — no audit', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue({ ...sampleAllocation, displayName: 'Preview', isDefault: true });
    mockAssign.mockResolvedValue({ ok: false, reason: 'default_invariant' });
    const res = await authed().request(
      '/api/sites/s1/r2/buckets/Preview/environment',
      req({ environment: 'production' }),
      mockEnv(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
