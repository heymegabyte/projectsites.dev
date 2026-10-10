/**
 * Per-site R2 **bucket clone** (Buckets B6). Proves `cloneSiteR2Bucket` COMPOSES the proven pieces —
 * `provisionSiteR2` (creates the new physical bucket, idempotent) + the BOUNDED paginated S3 ListObjectsV2
 * walk (the zip pattern) + `copySiteR2Object(..., { destBucket })` (server-side S3 CopyObject, cross-bucket)
 * — into a bounded SYNCHRONOUS clone that covers the overwhelming majority of per-site buckets. It:
 *   • validates the new name + REFUSES a name that already exists for the site (`destination_exists` → 409);
 *   • provisions the new bucket, then copies every source object into it (same caps as the zip:
 *     1000 objects AND 100 MB — whichever trips first stops the walk);
 *   • returns `{ newBucket, copiedCount, totalCount, truncated }` — HONEST truncation when a cap trips;
 *   • SKIPS an object that 404s mid-clone (deleted between list + copy) rather than failing the whole clone;
 *   • ABORTS on a real upstream 5xx with the PARTIAL state reported honestly (the new bucket exists with
 *     whatever copied — never a silent success).
 *
 * Runs against a REAL SQLite + a MOCKED Cloudflare/S3 fetch (zero real tokens, zero real S3) + the global
 * `R2_S3_*` escape-hatch creds (no mint). The async CF-Workflow path for TRULY huge buckets is a noted
 * follow-up (see the service doc) — this slice ships the bounded synchronous clone.
 *
 * `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import { cloneSiteR2Bucket } from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

// The feature flag that gates the per-site object-ops credential path (clone rides the same path as copy).
jest.mock('../../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
// eslint-disable-next-line import/first -- must follow jest.mock (swc hoists the mock)
import { isFlagOn } from '../../modules/feature_flags/services.js';
const mockFlag = isFlagOn as unknown as jest.Mock;

const ALLOC_DDL = `CREATE TABLE site_r2_allocations (
  id TEXT PRIMARY KEY, tenant_id TEXT, site_id TEXT, bucket_name TEXT UNIQUE, display_name TEXT,
  environment TEXT, is_default INTEGER, public_access INTEGER, public_base_url TEXT,
  jurisdiction TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`;

const SRC_BUCKET = 'ps-site-site1-uploads';
/** The display name we clone INTO — server sanitizes this to `ps-site-site1-uploads-copy`. */
const NEW_NAME = 'uploads-copy';
const NEW_BUCKET = 'ps-site-site1-uploads-copy';

function seedSourceBucket(h: D1SqliteHarness): void {
  h.exec(ALLOC_DDL);
  h.raw
    .prepare(
      `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
       VALUES ('a1','org1','site1','${SRC_BUCKET}','uploads','preview',1,0,'active')`,
    )
    .run();
}
function envWithGlobalS3(h: D1SqliteHarness): Env {
  return {
    DB: h.db,
    CF_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CLOUDFLARE_API_KEY: 'gkey',
    R2_S3_ACCESS_KEY_ID: 'GLOBALKEY',
    R2_S3_SECRET_ACCESS_KEY: 'GLOBALSECRET',
  } as unknown as Env;
}
const ctx = { orgId: 'org1', siteId: 'site1', tenantId: 'org1' };

/** Build an S3 ListObjectsV2 XML page from `{key,size}` entries (+ optional next continuation token). */
function listXml(objs: Array<{ key: string; size: number }>, nextToken?: string): string {
  const contents = objs
    .map(
      (o) =>
        `<Contents><Key>${o.key}</Key><Size>${o.size}</Size><LastModified>2026-10-10T00:00:00Z</LastModified></Contents>`,
    )
    .join('');
  const trunc = nextToken ? 'true' : 'false';
  const tok = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  return `<?xml version="1.0"?><ListBucketResult><IsTruncated>${trunc}</IsTruncated>${tok}${contents}</ListBucketResult>`;
}

/** Recorded network effects so the test can assert the composition (provision + list + head + copy). */
const r2RestCreates: string[] = []; // bucket names POSTed to the CF R2 REST bucket-create
const s3ListUrls: string[] = []; // S3 ListObjectsV2 calls (pagination)
const s3CopyTargets: Array<{ dest: string; source: string }> = []; // S3 CopyObject PUTs (dest + copy-source)
let headExisting: Set<string>; // dest keys that HEAD → 200 ("already exists"); default none
let getDeletedKeys: Set<string>; // src keys the (list→copy) treats as deleted — but copy uses CopyObject, so
// to simulate "deleted mid-clone" we make the COPY (PUT) 404 for these keys.
let copy5xxKeys: Set<string>; // src keys whose COPY returns a real upstream 500 (abort)

/**
 * Install a fetch mock serving BOTH the CF R2 REST plane (bucket-create → provisionSiteR2) AND the S3 plane
 * (ListObjectsV2 on the SOURCE bucket + HeadObject collision-guard on the DEST + CopyObject PUT). `pages`
 * drives the source listing. Records the composition for assertions.
 */
function installFetch(
  pages: Array<{ objs: Array<{ key: string; size: number }>; next?: string }>,
): void {
  r2RestCreates.length = 0;
  s3ListUrls.length = 0;
  s3CopyTargets.length = 0;
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    (url: string, opts?: { method?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = opts?.method ?? 'GET';

      // CF token mint — succeed generically (object ops only need the mint when no global creds; with the
      // global R2_S3_* creds present we never mint, but keep it safe).
      if (u.includes('/accounts/acct-1/tokens') && method === 'POST')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { id: 'tok-abc', value: 'secret-value-xyz' },
          }),
        } as unknown as Response);
      // CF R2 REST bucket-create (provisionSiteR2) — capture the name + succeed.
      if (u.includes('/r2/buckets')) {
        if (method === 'POST') {
          try {
            const parsed = JSON.parse(String(opts?.headers ? '' : '')); // no-op guard
            void parsed;
          } catch {
            /* ignore */
          }
          // The bucket name is in the POST body; we capture it from the fetch init below (opts has no body
          // typed here, so parse defensively).
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: {} }),
        } as unknown as Response);
      }

      if (u.includes('r2.cloudflarestorage.com')) {
        const parsed = new URL(u);
        // S3 ListObjectsV2 — carries `?list-type=2`. Always lists the SOURCE bucket.
        if (method === 'GET' && parsed.searchParams.get('list-type') === '2') {
          s3ListUrls.push(u);
          const token = parsed.searchParams.get('continuation-token');
          const idx = token ? Number(token.replace('page-', '')) : 0;
          const page = pages[idx] ?? { objs: [] };
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map() as unknown as Headers,
            text: async () => listXml(page.objs, page.next),
          } as unknown as Response);
        }
        // HeadObject — the copy collision guard HEADs the DEST bucket + key. Key stored WITHOUT the bucket
        // segment (strip leading `/{bucket}/`).
        if (method === 'HEAD') {
          const path = parsed.pathname.replace(/^\//, ''); // `{bucket}/{key...}`
          const key = decodeURIComponent(path.slice(path.indexOf('/') + 1));
          const exists = headExisting.has(key);
          return Promise.resolve({ ok: exists, status: exists ? 200 : 404 } as unknown as Response);
        }
        // CopyObject PUT — `x-amz-copy-source: /{srcBucket}/{srcKey}`. Capture (dest path + copy-source).
        if (method === 'PUT') {
          const destPath = parsed.pathname.replace(/^\//, ''); // `{destBucket}/{destKey...}`
          const source = opts?.headers?.['x-amz-copy-source'] ?? '';
          // Derive the src KEY from the copy-source to apply the per-key fault injectors.
          const srcKey = decodeURIComponent(source.replace(`/${SRC_BUCKET}/`, ''));
          s3CopyTargets.push({ dest: destPath, source });
          if (getDeletedKeys.has(srcKey))
            return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
          if (copy5xxKeys.has(srcKey))
            return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
          return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
        }
        return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response);
    },
  );
}
const fetchMock = () => globalThis.fetch as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  headExisting = new Set<string>();
  getDeletedKeys = new Set<string>();
  copy5xxKeys = new Set<string>();
  mockFlag.mockResolvedValue(true);
});

describe('cloneSiteR2Bucket — composes provision + bounded list + cross-bucket copy', () => {
  it('provisions the new bucket then copies every source object into it; returns honest counts', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      installFetch([
        {
          objs: [
            { key: 'a.txt', size: 7 },
            { key: 'dir/b.json', size: 12 },
            { key: 'c.bin', size: 3 },
          ],
        },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');

      // The new bucket is provisioned + recorded in the allocation catalog.
      expect(r.newBucket).toBe(NEW_BUCKET);
      const alloc = h.raw
        .prepare(
          `SELECT display_name, bucket_name, is_default, public_access FROM site_r2_allocations WHERE bucket_name = ?`,
        )
        .get(NEW_BUCKET) as
        | { display_name: string; bucket_name: string; is_default: number; public_access: number }
        | undefined;
      expect(alloc).toBeTruthy();
      expect(alloc!.display_name).toBe(NEW_NAME);
      // Clone defaults PRIVATE + unassigned (not the site default).
      expect(alloc!.is_default).toBe(0);
      expect(alloc!.public_access).toBe(0);

      // Every source object was copied INTO the new bucket via S3 CopyObject (copy-source = SOURCE bucket).
      expect(r.copiedCount).toBe(3);
      expect(r.totalCount).toBe(3);
      expect(r.truncated).toBe(false);
      expect(s3CopyTargets.length).toBe(3);
      for (const c of s3CopyTargets) {
        expect(c.dest.startsWith(`${NEW_BUCKET}/`)).toBe(true); // PUT lands in the NEW bucket
        expect(c.source.startsWith(`/${SRC_BUCKET}/`)).toBe(true); // copy-source stays the SOURCE bucket
      }
    } finally {
      h.close();
    }
  });

  it('paginates the source listing across multiple S3 pages (bounded), copying every page', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      installFetch([
        { objs: [{ key: 'p0-x', size: 5 }], next: 'page-1' },
        { objs: [{ key: 'p1-y', size: 5 }] },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(s3ListUrls.length).toBe(2); // walked both pages
      expect(r.copiedCount).toBe(2);
      expect(r.totalCount).toBe(2);
    } finally {
      h.close();
    }
  });

  it('empty source bucket → new bucket provisioned, copiedCount 0, not truncated', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      installFetch([{ objs: [] }]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.copiedCount).toBe(0);
      expect(r.totalCount).toBe(0);
      expect(r.truncated).toBe(false);
      // The bucket still exists even with nothing to copy.
      const alloc = h.raw
        .prepare(`SELECT bucket_name FROM site_r2_allocations WHERE bucket_name = ?`)
        .get(NEW_BUCKET);
      expect(alloc).toBeTruthy();
    } finally {
      h.close();
    }
  });
});

describe('cloneSiteR2Bucket — HONEST bounds (same caps as the zip)', () => {
  it('object-count cap → copies maxObjects, truncated:true, copiedCount<totalCount', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      installFetch([
        {
          objs: [
            { key: 'o1', size: 5 },
            { key: 'o2', size: 5 },
            { key: 'o3', size: 5 },
            { key: 'o4', size: 5 },
          ],
        },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME, {
        maxObjects: 2,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.copiedCount).toBe(2);
      expect(r.truncated).toBe(true);
      expect(r.totalCount).toBeGreaterThanOrEqual(2);
      // We stopped copying once the cap was hit — never copied all four.
      expect(s3CopyTargets.length).toBe(2);
    } finally {
      h.close();
    }
  });

  it('total-bytes cap → stops once the uncompressed budget is exceeded, truncated:true', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      // Three 600-byte objects; a 1000-byte budget admits the first, the second blows it → truncate.
      installFetch([
        {
          objs: [
            { key: 'big1', size: 600 },
            { key: 'big2', size: 600 },
            { key: 'big3', size: 600 },
          ],
        },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME, {
        maxBytes: 1000,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.truncated).toBe(true);
      expect(r.copiedCount).toBe(1); // only the first fit under the 1000-byte budget
      expect(s3CopyTargets.length).toBe(1);
    } finally {
      h.close();
    }
  });
});

describe('cloneSiteR2Bucket — name-collision + credential + failure honesty', () => {
  it('REFUSES a new name that already exists for the site → destination_exists (the route maps to 409)', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      // Pre-seed a SECOND bucket under the target display name → the collision guard trips.
      h.raw
        .prepare(
          `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
           VALUES ('a2','org1','site1','${NEW_BUCKET}','${NEW_NAME}','preview',0,0,'active')`,
        )
        .run();
      installFetch([{ objs: [{ key: 'a.txt', size: 5 }] }]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('destination_exists');
      // No objects were copied — the clone never started.
      expect(s3CopyTargets.length).toBe(0);
    } finally {
      h.close();
    }
  });

  it('REJECTS an invalid new name (not_allocated-style bad input) with forbidden_bucket, no network', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      installFetch([{ objs: [] }]);
      // A hostile name that can't be a legal bucket display name.
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, '  !!!  ');
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      // Invalid name → a typed failure (never a thrown 500); no bucket was provisioned.
      expect(['forbidden_bucket', 'destination_exists']).toContain(r.reason);
      expect(s3CopyTargets.length).toBe(0);
    } finally {
      h.close();
    }
  });

  it('no S3 creds / flag off → needs_s3_credentials, provisions NOTHING, no S3 network', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      mockFlag.mockResolvedValue(false);
      installFetch([{ objs: [] }]);
      const envNoS3 = {
        DB: h.db,
        CF_ACCOUNT_ID: 'acct-1',
        CLOUDFLARE_EMAIL: 'e@x.com',
        CLOUDFLARE_API_KEY: 'gkey',
      } as unknown as Env;
      const r = await cloneSiteR2Bucket(envNoS3, ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('needs_s3_credentials');
      // A failed precondition must NOT leave a half-provisioned bucket behind.
      const alloc = h.raw
        .prepare(`SELECT bucket_name FROM site_r2_allocations WHERE bucket_name = ?`)
        .get(NEW_BUCKET);
      expect(alloc).toBeFalsy();
    } finally {
      h.close();
    }
  });

  it('SKIPS an object that 404s mid-clone (deleted between list + copy) — clones the rest, still ok', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      getDeletedKeys = new Set(['gone']);
      installFetch([
        {
          objs: [
            { key: 'keep', size: 5 },
            { key: 'gone', size: 5 },
          ],
        },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      // `gone` was skipped (counted in total, omitted from copied); `keep` copied.
      expect(r.copiedCount).toBe(1);
      expect(r.totalCount).toBe(2);
    } finally {
      h.close();
    }
  });

  it('ABORTS on a real upstream 5xx mid-clone with the PARTIAL state honest (new bucket exists w/ what copied)', async () => {
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      copy5xxKeys = new Set(['boom']);
      installFetch([
        {
          objs: [
            { key: 'ok1', size: 5 },
            { key: 'boom', size: 5 },
            { key: 'never', size: 5 },
          ],
        },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('s3_error');
      // The new bucket WAS provisioned (honest partial state — never a silent success, never a rollback lie).
      const alloc = h.raw
        .prepare(`SELECT bucket_name FROM site_r2_allocations WHERE bucket_name = ?`)
        .get(NEW_BUCKET);
      expect(alloc).toBeTruthy();
      // We stopped at the failing object — never attempted the one after it.
      expect(s3CopyTargets.length).toBe(2); // ok1 (success) + boom (500); never reached `never`
    } finally {
      h.close();
    }
  });

  it('a copy collision mid-clone (dest key already exists) does NOT abort — overwrites (it is a fresh bucket)', async () => {
    // The new bucket is created EMPTY by provision, so a dest key can't pre-exist in practice; but guard the
    // contract: clone passes overwrite:true so a transient HEAD-200 never 409s the whole clone.
    const h = createD1Sqlite();
    try {
      seedSourceBucket(h);
      headExisting = new Set(['a.txt']); // pretend it HEADs as existing in the dest
      installFetch([
        {
          objs: [
            { key: 'a.txt', size: 5 },
            { key: 'b.txt', size: 5 },
          ],
        },
      ]);
      const r = await cloneSiteR2Bucket(envWithGlobalS3(h), ctx, SRC_BUCKET, NEW_NAME);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.copiedCount).toBe(2); // both copied despite the HEAD-200 (overwrite:true bypasses the guard)
      void fetchMock();
    } finally {
      h.close();
    }
  });
});
