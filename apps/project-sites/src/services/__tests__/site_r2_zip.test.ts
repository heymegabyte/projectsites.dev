/**
 * Per-site R2 **bucket ZIP export** (Buckets B7). Proves `zipSiteR2Bucket` lists a bucket's objects via a
 * BOUNDED paginated S3 ListObjectsV2 scan, fetches each object's bytes, and assembles ONE valid `.zip`
 * (fflate `zipSync` — PK magic, round-trips with `unzipSync`), preserving folder paths as zip entry names.
 * The caps are HONEST: a bucket that exceeds the object-count cap OR the total-uncompressed-bytes cap stops
 * early and reports `truncated:true` with the `includedCount` actually zipped vs the `totalCount` seen — so
 * the UI/filename can signal the partial export instead of lying "complete". Runs against a MOCKED
 * Cloudflare/S3 fetch (zero real tokens, zero real S3) + the global `R2_S3_*` escape-hatch creds (no mint).
 *
 * `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import { unzipSync } from 'fflate';

import { zipSiteR2Bucket } from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

// The feature flag that gates the per-site object-ops credential path (zip rides the same path as get/list).
jest.mock('../../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
// eslint-disable-next-line import/first -- must follow jest.mock (swc hoists the mock)
import { isFlagOn } from '../../modules/feature_flags/services.js';
const mockFlag = isFlagOn as unknown as jest.Mock;

const ALLOC_DDL = `CREATE TABLE site_r2_allocations (
  id TEXT PRIMARY KEY, tenant_id TEXT, site_id TEXT, bucket_name TEXT UNIQUE, display_name TEXT,
  environment TEXT, is_default INTEGER, public_access INTEGER, public_base_url TEXT,
  jurisdiction TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`;

function seedPreviewBucket(h: D1SqliteHarness): void {
  h.exec(ALLOC_DDL);
  h.raw
    .prepare(
      `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
       VALUES ('a1','org1','site1','ps-site-site1-preview','Preview','preview',1,0,'active')`,
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
const BUCKET = 'ps-site-site1-preview';

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

/**
 * Install a fetch mock serving a *synthetic bucket* across S3 list pages + object GETs. `pages` is an array
 * of `{ objs, next }`; a GET `/{bucket}/{key}` returns bytes whose content is derived from the key (so the
 * test can assert each entry's bytes round-trip). `perKeyBytes` overrides the body size for a given key
 * (used to exceed the byte cap). Records every S3 list URL so we can assert pagination.
 */
const s3ListUrls: string[] = [];
const s3GetKeys: string[] = [];
function bodyFor(key: string, perKeyBytes: Record<string, number>): Uint8Array {
  const n = perKeyBytes[key];
  if (typeof n === 'number') return new Uint8Array(n).fill(65); // 'A' * n
  // Default: encode the key itself so we can assert the exact bytes landed in the zip.
  return new TextEncoder().encode(`body:${key}`);
}
function installBucketFetch(
  pages: Array<{ objs: Array<{ key: string; size: number }>; next?: string }>,
  perKeyBytes: Record<string, number> = {},
): void {
  s3ListUrls.length = 0;
  s3GetKeys.length = 0;
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    (url: string, opts?: { method?: string }) => {
      const u = String(url);
      if (u.includes('r2.cloudflarestorage.com')) {
        const parsed = new URL(u);
        const isList = parsed.searchParams.get('list-type') === '2';
        if (isList) {
          s3ListUrls.push(u);
          const token = parsed.searchParams.get('continuation-token');
          const idx = token ? Number(token.replace('page-', '')) : 0;
          const page = pages[idx] ?? { objs: [] };
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/xml']]) as unknown as Headers,
            text: async () => listXml(page.objs, page.next),
          } as unknown as Response);
        }
        // Object GET — decode the key from the path (after `/{bucket}/`).
        const key = decodeURIComponent(parsed.pathname.replace(`/${BUCKET}/`, ''));
        s3GetKeys.push(key);
        const bytes = bodyFor(key, perKeyBytes);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/octet-stream']]) as unknown as Headers,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          text: async () => '',
        } as unknown as Response);
      }
      void opts;
      return Promise.resolve({
        ok: false,
        status: 404,
        text: async () => '',
        json: async () => ({}),
      } as unknown as Response);
    },
  );
}
const fetchMock = () => globalThis.fetch as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockFlag.mockResolvedValue(true);
});

describe('zipSiteR2Bucket — assembles a valid zip from listed + fetched objects', () => {
  it('zips every object, preserves folder paths, round-trips the bytes, filename={bucket}.zip', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      installBucketFetch([
        {
          objs: [
            { key: 'a.txt', size: 7 },
            { key: 'dir/b.json', size: 12 },
            { key: 'nested/deep/c.bin', size: 3 },
          ],
        },
      ]);
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');

      // Valid zip (PK magic) + a suggested download filename derived from the bucket.
      expect(r.zip[0]).toBe(0x50); // 'P'
      expect(r.zip[1]).toBe(0x4b); // 'K'
      expect(r.filename).toBe('ps-site-site1-preview.zip');
      expect(r.includedCount).toBe(3);
      expect(r.totalCount).toBe(3);
      expect(r.truncated).toBe(false);

      // Round-trip: every object is present under its full key, with the exact bytes we served.
      const files = unzipSync(r.zip);
      expect(Object.keys(files).sort()).toEqual(['a.txt', 'dir/b.json', 'nested/deep/c.bin']);
      expect(new TextDecoder().decode(files['a.txt']!)).toBe('body:a.txt');
      expect(new TextDecoder().decode(files['dir/b.json']!)).toBe('body:dir/b.json');
      // All three objects were actually fetched from S3.
      expect(s3GetKeys.sort()).toEqual(['a.txt', 'dir/b.json', 'nested/deep/c.bin']);
    } finally {
      h.close();
    }
  });

  it('paginates the listing across multiple S3 pages (bounded), zipping every page', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      installBucketFetch([
        { objs: [{ key: 'p0-x', size: 5 }], next: 'page-1' },
        { objs: [{ key: 'p1-y', size: 5 }] },
      ]);
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(s3ListUrls.length).toBe(2); // walked both pages
      const files = unzipSync(r.zip);
      expect(Object.keys(files).sort()).toEqual(['p0-x', 'p1-y']);
      expect(r.includedCount).toBe(2);
    } finally {
      h.close();
    }
  });

  it('empty bucket → a valid (empty) zip, includedCount 0, not truncated', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      installBucketFetch([{ objs: [] }]);
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.includedCount).toBe(0);
      expect(r.totalCount).toBe(0);
      expect(r.truncated).toBe(false);
      expect(r.zip[0]).toBe(0x50); // still a valid (empty) zip
      expect(Object.keys(unzipSync(r.zip))).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe('zipSiteR2Bucket — HONEST bounds (caps stop early + report truncation)', () => {
  it('object-count cap → stops at maxObjects, truncated:true, includedCount<totalCount', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      // Four objects available; cap at 2 → only 2 zipped, but totalCount reflects what we saw.
      installBucketFetch([
        {
          objs: [
            { key: 'o1', size: 5 },
            { key: 'o2', size: 5 },
            { key: 'o3', size: 5 },
            { key: 'o4', size: 5 },
          ],
        },
      ]);
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET, { maxObjects: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.includedCount).toBe(2);
      expect(r.truncated).toBe(true);
      expect(r.totalCount).toBeGreaterThanOrEqual(2);
      expect(Object.keys(unzipSync(r.zip)).length).toBe(2);
      // We stopped fetching once the cap was hit — never fetched all four.
      expect(s3GetKeys.length).toBe(2);
    } finally {
      h.close();
    }
  });

  it('total-bytes cap → stops once the uncompressed budget is exceeded, truncated:true', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      // Two 600-byte objects; a 1000-byte budget admits the first, the second would blow it → truncate.
      installBucketFetch(
        [
          {
            objs: [
              { key: 'big1', size: 600 },
              { key: 'big2', size: 600 },
              { key: 'big3', size: 600 },
            ],
          },
        ],
        { big1: 600, big2: 600, big3: 600 },
      );
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET, { maxBytes: 1000 });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.truncated).toBe(true);
      expect(r.includedCount).toBe(1); // only the first fit under the 1000-byte budget
      expect(r.bytesIncluded).toBeLessThanOrEqual(1000);
      expect(Object.keys(unzipSync(r.zip)).length).toBe(1);
    } finally {
      h.close();
    }
  });
});

describe('zipSiteR2Bucket — credential + failure honesty', () => {
  it('no S3 creds / flag off → needs_s3_credentials, NO network (honest "being set up")', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      mockFlag.mockResolvedValue(false);
      installBucketFetch([{ objs: [] }]);
      const envNoS3 = {
        DB: h.db,
        CF_ACCOUNT_ID: 'acct-1',
        CLOUDFLARE_EMAIL: 'e@x.com',
        CLOUDFLARE_API_KEY: 'gkey',
      } as unknown as Env;
      const r = await zipSiteR2Bucket(envNoS3, ctx, BUCKET);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('needs_s3_credentials');
      expect(fetchMock()).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('S3 list 500 → s3_error (never a partial-but-ok lie)', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string) => {
        const u = String(url);
        if (u.includes('r2.cloudflarestorage.com'))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => '',
            headers: new Map() as unknown as Headers,
          } as unknown as Response);
        return Promise.resolve({
          ok: false,
          status: 404,
          text: async () => '',
        } as unknown as Response);
      });
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('s3_error');
    } finally {
      h.close();
    }
  });

  it('skips an object that 404s mid-zip (deleted between list + get) — zips the rest, still ok', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      // Serve the list normally, but 404 the GET for 'gone' — the zip includes the survivors.
      (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string) => {
        const u = String(url);
        const parsed = new URL(u);
        if (parsed.searchParams.get('list-type') === '2')
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map() as unknown as Headers,
            text: async () =>
              listXml([
                { key: 'keep', size: 5 },
                { key: 'gone', size: 5 },
              ]),
          } as unknown as Response);
        const key = decodeURIComponent(parsed.pathname.replace(`/${BUCKET}/`, ''));
        if (key === 'gone')
          return Promise.resolve({
            ok: false,
            status: 404,
            headers: new Map() as unknown as Headers,
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => '',
          } as unknown as Response);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
          arrayBuffer: async () => new TextEncoder().encode('kept').buffer,
          text: async () => '',
        } as unknown as Response);
      });
      const r = await zipSiteR2Bucket(envWithGlobalS3(h), ctx, BUCKET);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      const files = unzipSync(r.zip);
      expect(Object.keys(files)).toEqual(['keep']);
      expect(r.includedCount).toBe(1);
    } finally {
      h.close();
    }
  });
});
