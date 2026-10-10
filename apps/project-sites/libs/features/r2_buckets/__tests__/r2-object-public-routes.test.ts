/**
 * Route-layer coverage for the B9 per-object public + revoke-safe signed-share endpoints:
 *   • POST   /api/sites/:siteId/r2/buckets/:bucket/objects/public   (authed — mint a share)
 *   • DELETE /api/sites/:siteId/r2/buckets/:bucket/objects/public   (authed — revoke)
 *   • GET    /api/r2/public/:slug                                    (UNAUTHED public gateway — serve)
 *
 * Proves the authed routes ship the SAME gate order as the rest of the surface (isolation BEFORE the op):
 * flag off → 404 (DARK) → unauth → 401 → foreign site → 404 → foreign bucket (per-bucket IDOR) → 404 →
 * then the op. Proves the UNAUTHED gateway: runs with NO orgId in context (never 401), 404s a bad /
 * revoked / expired / private slug WITHOUT a distinguishing body (never 403, no leak), and STREAMS a live
 * slug's bytes with the resolved content-type + revoke-aware cache headers. The static `/objects/public`
 * segment is NOT swallowed by the `/objects/*` wildcard (the DELETE especially).
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
  cloneSiteR2Bucket: jest.fn(),
  copySiteR2Object: jest.fn(),
  deleteSiteR2: jest.fn(),
  deleteSiteR2Object: jest.fn(),
  ensureDefaultSiteR2: jest.fn(),
  getObjectVisibility: jest.fn(),
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
  resolvePublicObject: jest.fn(),
  resolveSiteR2Allocation: jest.fn(),
  revokeObjectPublic: jest.fn(),
  searchSiteR2Objects: jest.fn(),
  setObjectPublic: jest.fn(),
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
import {
  getSiteR2Object,
  resolvePublicObject,
  resolveSiteR2Allocation,
  revokeObjectPublic,
  setObjectPublic,
} from '../../../../src/services/site_r2.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolveAlloc = resolveSiteR2Allocation as unknown as jest.Mock;
const mockSetPublic = setObjectPublic as unknown as jest.Mock;
const mockRevoke = revokeObjectPublic as unknown as jest.Mock;
const mockResolvePublic = resolvePublicObject as unknown as jest.Mock;
const mockGetObject = getSiteR2Object as unknown as jest.Mock;

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
  createdAt: '2026-10-10T00:00:00.000Z',
  displayName: 'uploads',
  environment: 'preview' as const,
  id: 'alloc1',
  isDefault: true,
  publicAccess: false,
  publicBaseUrl: null,
};

function postPublic(body: unknown, env = mockEnv(), a = authed()) {
  return a.request(
    '/api/sites/s1/r2/buckets/uploads/objects/public',
    { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' },
    env,
  );
}
function deletePublic(body: unknown, env = mockEnv(), a = authed()) {
  return a.request(
    '/api/sites/s1/r2/buckets/uploads/objects/public',
    { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'DELETE' },
    env,
  );
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolveAlloc.mockReset();
  mockSetPublic.mockReset();
  mockRevoke.mockReset();
  mockResolvePublic.mockReset();
  mockGetObject.mockReset();
});

describe('POST …/objects/public — gate order (isolation before the op)', () => {
  it('404 (DARK) when the flag is off — setObjectPublic never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await postPublic({ objectKey: 'a.pdf' });
    expect(res.status).toBe(404);
    expect(mockSetPublic).not.toHaveBeenCalled();
    expect(mockResolveAlloc).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await postPublic({ objectKey: 'a.pdf' }, mockEnv(), app());
    expect(res.status).toBe(401);
    expect(mockSetPublic).not.toHaveBeenCalled();
  });

  it('404 (IDOR) when the caller does not own the site — bucket never resolves', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await postPublic({ objectKey: 'a.pdf' }, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolveAlloc).not.toHaveBeenCalled();
    expect(mockSetPublic).not.toHaveBeenCalled();
  });

  it("404 (IDOR) when the bucket is NOT one of the site's allocations (foreign bucket)", async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(null);
    const res = await postPublic({ objectKey: 'a.pdf' });
    expect(res.status).toBe(404);
    expect(mockSetPublic).not.toHaveBeenCalled();
  });

  it('400 on a bad body (missing objectKey)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
    const res = await postPublic({});
    expect(res.status).toBe(400);
    expect(mockSetPublic).not.toHaveBeenCalled();
  });
});

describe('POST …/objects/public — success', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('201 with the slug + url + expiry; calls the service with the RESOLVED real bucket + ctx', async () => {
    mockSetPublic.mockResolvedValue({
      expiresAt: '2026-10-11T00:00:00.000Z',
      ok: true,
      publicSlug: 'Zm9vYmFyYmF6cXV4MTIzNDU2',
      url: 'https://projectsites.dev/api/r2/public/Zm9vYmFyYmF6cXV4MTIzNDU2',
    });
    const res = await postPublic({ expiresInSeconds: 3600, objectKey: 'docs/a.pdf' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { publicSlug: string; url: string; expiresAt: string } };
    expect(json.data.publicSlug).toBe('Zm9vYmFyYmF6cXV4MTIzNDU2');
    expect(json.data.url).toContain('/api/r2/public/');
    const [, resolvedCtx, alloc, key] = mockSetPublic.mock.calls[0] as [unknown, { siteId: string; orgId: string }, { bucketName: string }, string];
    expect(resolvedCtx).toMatchObject({ orgId: 'org1', siteId: 's1' });
    expect(alloc).toMatchObject({ bucketName: 'ps-site-s1-uploads' });
    expect(key).toBe('docs/a.pdf');
  });

  it('503 needs-creds maps honestly', async () => {
    mockSetPublic.mockResolvedValue({ ok: false, reason: 'needs_s3_credentials' });
    const res = await postPublic({ objectKey: 'a.pdf' });
    expect(res.status).toBe(503);
  });
});

describe('DELETE …/objects/public — revoke (NOT swallowed by the /objects/* wildcard)', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    mockResolveAlloc.mockResolvedValue(sampleAllocation);
  });

  it('200 revoked:true and the revoke service ran (static route won over the wildcard)', async () => {
    mockRevoke.mockResolvedValue({ ok: true, revoked: true });
    const res = await deletePublic({ objectKey: 'docs/a.pdf' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { revoked: boolean } };
    expect(json.data.revoked).toBe(true);
    expect(mockRevoke).toHaveBeenCalledTimes(1);
  });

  it('200 revoked:false for a never-shared object (idempotent no-op)', async () => {
    mockRevoke.mockResolvedValue({ ok: true, revoked: false });
    const res = await deletePublic({ objectKey: 'never.pdf' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { revoked: boolean } };
    expect(json.data.revoked).toBe(false);
  });

  it('404 (DARK) when the flag is off — revoke never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await deletePublic({ objectKey: 'a.pdf' });
    expect(res.status).toBe(404);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('GET /api/r2/public/:slug — UNAUTHED public gateway', () => {
  it('serves a live slug WITHOUT any auth context (never 401) — streams the bytes + content-type + cache headers', async () => {
    mockResolvePublic.mockResolvedValue({
      bucketName: 'ps-site-s1-uploads',
      objectKey: 'docs/report.pdf',
      orgId: 'org1',
      siteId: 's1',
      tenantId: 'org1',
    });
    mockGetObject.mockResolvedValue({
      body: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'application/pdf',
      ok: true,
      size: 4,
    });
    // NOTE: app() has NO orgId — an anonymous visitor. The gateway must still serve.
    const res = await app().request('/api/r2/public/Zm9vYmFyYmF6cXV4MTIzNDU2', { method: 'GET' }, mockEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toContain('must-revalidate');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3, 4]);
    // Streamed via the RESOLVED ctx/bucket/key — never a client-supplied value.
    const [, gctx, bucket, key] = mockGetObject.mock.calls[0] as [unknown, { siteId: string }, string, string];
    expect(gctx).toMatchObject({ siteId: 's1', tenantId: 'org1' });
    expect(bucket).toBe('ps-site-s1-uploads');
    expect(key).toBe('docs/report.pdf');
  });

  it('404 (never 403, no distinguishing body) when the slug DENIES — getObject never runs', async () => {
    mockResolvePublic.mockResolvedValue(null); // revoked / expired / private / unknown — all look identical
    const res = await app().request('/api/r2/public/revoked-or-bad', { method: 'GET' }, mockEnv());
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('NOT_FOUND');
    expect(json.error.message).toBe('Not found'); // generic — no "revoked"/"expired" leak
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it('404 (not a 5xx leak) when the slug resolves but the object is gone', async () => {
    mockResolvePublic.mockResolvedValue({
      bucketName: 'ps-site-s1-uploads',
      objectKey: 'docs/report.pdf',
      orgId: 'org1',
      siteId: 's1',
      tenantId: 'org1',
    });
    mockGetObject.mockResolvedValue({ ok: false, reason: 'object_not_found', status: 404 });
    const res = await app().request('/api/r2/public/live-but-deleted', { method: 'GET' }, mockEnv());
    expect(res.status).toBe(404);
  });
});
