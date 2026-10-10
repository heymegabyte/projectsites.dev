/**
 * Route-layer coverage for the B8 object copy/move/rename endpoint
 * (`POST /api/sites/:siteId/r2/buckets/:bucket/objects/copy`). Proves the SAME gate order the rest of the
 * surface ships (isolation BEFORE the op): flag off → 404 (DARK) → unauth → 401 → foreign site → 404 →
 * foreign/other bucket (the per-bucket IDOR guard) → 404 → then and only then the copy/move/rename op.
 * Also proves the op dispatch (copy vs rename vs move-by-prefix), the 409 collision mapping, Zod
 * validation (same src+dest rejected), and that the audit log records the right action verb.
 *
 * `isFlagOn` + the `site_r2` service + `writeAuditLog` are mocked so the handler logic is tested in
 * isolation; the `ownsSiteData` IDOR guard runs for real against a mock D1.
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
  setSiteR2PublicAccess: jest.fn(),
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
import {
  copySiteR2Object,
  moveSiteR2Prefix,
  renameSiteR2Object,
  resolveSiteR2Allocation,
} from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockCopy = copySiteR2Object as unknown as jest.Mock;
const mockRename = renameSiteR2Object as unknown as jest.Mock;
const mockMove = moveSiteR2Prefix as unknown as jest.Mock;
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

/** POST the copy endpoint with a JSON body. */
function post(body: unknown, env = mockEnv(), a = authed()) {
  return a.request(
    '/api/sites/s1/r2/buckets/uploads/objects/copy',
    { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' },
    env,
  );
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolveAlloc.mockReset();
  mockCopy.mockReset();
  mockRename.mockReset();
  mockMove.mockReset();
  mockAudit.mockClear();
});

describe('POST …/objects/copy — gate order (isolation before the op)', () => {
  it('404 (DARK) when the r2_bucket_manager flag is off — copy never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await post({ destKey: 'b.txt', srcKey: 'a.txt' });
    expect(res.status).toBe(404);
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mockResolveAlloc).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await post({ destKey: 'b.txt', srcKey: 'a.txt' }, mockEnv(), app());
    expect(res.status).toBe(401);
  });

  it('404 (IDOR) when the caller does not own the site — bucket never resolves', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await post({ destKey: 'b.txt', srcKey: 'a.txt' }, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolveAlloc).not.toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the bucket is NOT one of the site\'s allocations (foreign bucket)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null); // not the site's bucket → the per-bucket guard trips
    const res = await post({ destKey: 'b.txt', srcKey: 'a.txt' });
    expect(res.status).toBe(404);
    expect(mockCopy).not.toHaveBeenCalled();
  });
});

describe('POST …/objects/copy — op dispatch + responses', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('400 when src and dest are identical (Zod refine) — no op fires', async () => {
    const res = await post({ destKey: 'same.txt', srcKey: 'same.txt' });
    expect(res.status).toBe(400);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('COPY (no deleteSource) → copySiteR2Object with the resolved real bucket + keys; audits r2.object.copied', async () => {
    mockCopy.mockResolvedValue({ key: 'b.txt', ok: true });
    const res = await post({ destKey: 'b.txt', srcKey: 'a.txt' });
    expect(res.status).toBe(200);
    const [, ctx, bucketName, srcKey, destKey] = mockCopy.mock.calls[0] as [unknown, { siteId: string; orgId: string }, string, string, string];
    expect(bucketName).toBe('ps-site-s1-uploads'); // the resolved REAL bucket, not the display name
    expect(srcKey).toBe('a.txt');
    expect(destKey).toBe('b.txt');
    expect(ctx).toMatchObject({ orgId: 'org1', siteId: 's1' });
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect((mockAudit.mock.calls[0] as [unknown, { action: string }])[1].action).toBe('r2.object.copied');
  });

  it('RENAME (deleteSource, same parent folder) → renameSiteR2Object; audits r2.object.renamed', async () => {
    mockRename.mockResolvedValue({ key: 'a/new.txt', ok: true });
    const res = await post({ deleteSource: true, destKey: 'a/new.txt', srcKey: 'a/old.txt' });
    expect(res.status).toBe(200);
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockCopy).not.toHaveBeenCalled();
    expect((mockAudit.mock.calls[0] as [unknown, { action: string }])[1].action).toBe('r2.object.renamed');
  });

  it('MOVE (deleteSource, different parent) → renameSiteR2Object; audits r2.object.moved', async () => {
    mockRename.mockResolvedValue({ key: 'z/old.txt', ok: true });
    const res = await post({ deleteSource: true, destKey: 'z/old.txt', srcKey: 'a/old.txt' });
    expect(res.status).toBe(200);
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect((mockAudit.mock.calls[0] as [unknown, { action: string }])[1].action).toBe('r2.object.moved');
  });

  it('MOVE-BY-PREFIX (deleteSource + trailing / on both) → moveSiteR2Prefix; audits r2.object.moved with count', async () => {
    mockMove.mockResolvedValue({ moved: 4, ok: true });
    const res = await post({ deleteSource: true, destKey: 'new/', srcKey: 'old/' });
    expect(res.status).toBe(200);
    expect(mockMove).toHaveBeenCalledTimes(1);
    expect(mockRename).not.toHaveBeenCalled();
    const body = (await res.json()) as { data: { moved: number } };
    expect(body.data.moved).toBe(4);
    const auditEntry = (mockAudit.mock.calls[0] as [unknown, { action: string; metadata_json: { moved: number } }])[1];
    expect(auditEntry.action).toBe('r2.object.moved');
    expect(auditEntry.metadata_json.moved).toBe(4);
  });

  it('409 when the destination already exists (destination_exists → CONFLICT) — no audit', async () => {
    mockCopy.mockResolvedValue({ ok: false, reason: 'destination_exists' });
    const res = await post({ destKey: 'taken.txt', srcKey: 'a.txt' });
    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('503 needs-creds when object storage is still being set up', async () => {
    mockCopy.mockResolvedValue({ ok: false, reason: 'needs_s3_credentials' });
    const res = await post({ destKey: 'b.txt', srcKey: 'a.txt' });
    expect(res.status).toBe(503);
  });
});
