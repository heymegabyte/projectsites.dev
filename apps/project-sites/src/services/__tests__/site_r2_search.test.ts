/**
 * Per-site R2 **server-side whole-bucket search** (Buckets B11). Proves `searchSiteR2Objects` searches
 * the WHOLE bucket — not just one loaded page — via a BOUNDED paginated S3 ListObjectsV2 scan, filtering
 * keys by a case-insensitive SUBSTRING match, narrowing with the native S3 `prefix` when supplied, capping
 * the result set, and reporting HONEST limits (`scannedAll` / `scanned` / `truncated`) so the UI never
 * lies about completeness. Runs against a MOCKED Cloudflare/S3 fetch (zero real tokens, zero real S3) +
 * the global `R2_S3_*` escape-hatch creds so no token mint is needed.
 *
 * `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import { searchSiteR2Objects } from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

// The feature flag that gates the per-site object-ops path (search rides the same credential path).
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

/** Build an S3 ListObjectsV2 XML page from keys (+ optional next continuation token). */
function listXml(keys: string[], nextToken?: string): string {
  const contents = keys
    .map(
      (k) =>
        `<Contents><Key>${k}</Key><Size>5</Size><LastModified>2026-10-10T00:00:00Z</LastModified></Contents>`,
    )
    .join('');
  const trunc = nextToken ? 'true' : 'false';
  const tok = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  return `<?xml version="1.0"?><ListBucketResult><IsTruncated>${trunc}</IsTruncated>${tok}${contents}</ListBucketResult>`;
}

/**
 * Install a fetch mock that serves a *synthetic bucket* across S3 list pages. `pages` is an array of
 * { keys, next } — each list call returns the page matching the inbound `continuation-token` (start =
 * page 0). Records every S3 list URL so the test can assert the `prefix` is passed natively.
 */
const s3ListUrls: string[] = [];
function installPagedFetch(pages: Array<{ keys: string[]; next?: string }>): void {
  s3ListUrls.length = 0;
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string) => {
    const u = String(url);
    if (u.includes('r2.cloudflarestorage.com')) {
      s3ListUrls.push(u);
      const parsed = new URL(u);
      const token = parsed.searchParams.get('continuation-token');
      const idx = token ? Number(token.replace('page-', '')) : 0;
      const page = pages[idx] ?? { keys: [] };
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/xml']]) as unknown as Headers,
        text: async () => listXml(page.keys, page.next),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response);
  });
}
const fetchMock = () => globalThis.fetch as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockFlag.mockResolvedValue(true);
});

describe('searchSiteR2Objects — whole-bucket substring scan (B11)', () => {
  it('scans MULTIPLE S3 pages and returns every substring match across the whole bucket (not just page 1)', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      // Two pages. "logo" appears on BOTH pages — a page-1-only filter would miss page 2's hit.
      installPagedFetch([
        { keys: ['images/logo.png', 'images/hero.jpg', 'docs/readme.md'], next: 'page-1' },
        { keys: ['assets/logo-dark.svg', 'assets/favicon.ico'] },
      ]);
      const r = await searchSiteR2Objects(envWithGlobalS3(h), ctx, 'ps-site-site1-preview', {
        search: 'logo',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.objects.map((o) => o.key).sort()).toEqual([
        'assets/logo-dark.svg',
        'images/logo.png',
      ]);
      // Scanned the whole bucket (both pages) → honest "scanned everything" signal.
      expect(r.scannedAll).toBe(true);
      expect(r.truncated).toBe(false);
      expect(r.scanned).toBe(5); // 3 + 2 keys walked
      expect(fetchMock()).toHaveBeenCalledTimes(2); // walked both pages
    } finally {
      h.close();
    }
  });

  it('is CASE-INSENSITIVE on the key', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      installPagedFetch([{ keys: ['Images/LOGO.PNG', 'other.txt'] }]);
      const r = await searchSiteR2Objects(envWithGlobalS3(h), ctx, 'ps-site-site1-preview', {
        search: 'logo',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.objects.map((o) => o.key)).toEqual(['Images/LOGO.PNG']);
    } finally {
      h.close();
    }
  });

  it('passes a native S3 `prefix` to NARROW the scan server-side when supplied', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      installPagedFetch([{ keys: ['images/logo.png', 'images/hero.jpg'] }]);
      const r = await searchSiteR2Objects(envWithGlobalS3(h), ctx, 'ps-site-site1-preview', {
        search: 'logo',
        prefix: 'images/',
      });
      expect(r.ok).toBe(true);
      // The S3 list call carried prefix=images/ (efficient narrowing, not a full-bucket walk).
      expect(
        s3ListUrls.some((u) => u.includes('prefix=images%2F') || u.includes('prefix=images/')),
      ).toBe(true);
    } finally {
      h.close();
    }
  });

  it('CAPS the result set and reports truncated:true when more matches exist than the cap', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      // 1500 matching keys on one page; cap is 1000 → truncated, honest.
      const many = Array.from({ length: 1500 }, (_, i) => `logo-${i}.png`);
      installPagedFetch([{ keys: many }]);
      const r = await searchSiteR2Objects(envWithGlobalS3(h), ctx, 'ps-site-site1-preview', {
        search: 'logo',
        maxResults: 1000,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.objects).toHaveLength(1000);
      expect(r.truncated).toBe(true); // more matches than the cap → honest truncation
    } finally {
      h.close();
    }
  });

  it('stops at the page-scan cap and reports scannedAll:false (bounded, honest about NOT reaching the end)', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      // Every page says "there's another page" forever; the scan must stop at maxPages and admit it.
      const pages = Array.from({ length: 50 }, (_, i) => ({
        keys: ['nomatch.bin'],
        next: `page-${i + 1}`,
      }));
      installPagedFetch(pages);
      const r = await searchSiteR2Objects(envWithGlobalS3(h), ctx, 'ps-site-site1-preview', {
        search: 'logo',
        maxPages: 3,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.scannedAll).toBe(false); // the bucket is bigger than we scanned — do NOT claim "all"
      expect(fetchMock()).toHaveBeenCalledTimes(3); // bounded at maxPages
    } finally {
      h.close();
    }
  });

  it('flag OFF + no global creds → needs_s3_credentials, NO network', async () => {
    const h = createD1Sqlite();
    try {
      seedPreviewBucket(h);
      mockFlag.mockResolvedValue(false);
      installPagedFetch([{ keys: [] }]);
      const noCredsEnv = {
        DB: h.db,
        CF_ACCOUNT_ID: 'acct-1',
        CLOUDFLARE_EMAIL: 'e@x.com',
        CLOUDFLARE_API_KEY: 'gkey',
      } as unknown as Env;
      const r = await searchSiteR2Objects(noCredsEnv, ctx, 'ps-site-site1-preview', {
        search: 'x',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('needs_s3_credentials');
      // never walked S3 when there are no creds
      const s3 = fetchMock().mock.calls.filter((c) =>
        String(c[0]).includes('r2.cloudflarestorage.com'),
      );
      expect(s3).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});
