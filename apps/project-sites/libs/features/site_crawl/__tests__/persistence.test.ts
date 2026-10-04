/**
 * CRAWL-3 unit coverage for the crawl persistence layer (R2 corpus + D1 metadata).
 *
 * Proves, WITHOUT the network:
 *  - R2 gets the deterministic corpus keys: manifest.json / links.json / full-site.md + one
 *    pages/{pageId}.md per page, all under `crawls/{normalizedDomain}/{crawlId}/`.
 *  - The manifest written to R2 is the Zod-validated CrawlManifest (counts + r2Keys + fingerprint).
 *  - D1 gets ONE upsert with the expected column values (status/mode/provider/coverage/content_bytes
 *    /fingerprint/r2_prefix/previous_crawl_id/config) and an `ON CONFLICT(id) DO UPDATE` (idempotent).
 *  - Re-persisting the same crawl re-writes the SAME keys + upserts again (overwrite-safe).
 *  - Coverage fields reconcile (discovered ≥ completed; errored = discovered − completed).
 *  - FAIL-SOFT: an R2 or D1 throw is captured in `result.errors`, never re-thrown.
 *
 * R2 + D1 are hand-rolled fakes (no CF). Pure-function helpers (normalizeDomain, deriveCoverage,
 * fingerprintCrawl, buildFullSiteMarkdown) are asserted directly.
 */

import {
  persistCrawl,
  normalizeDomain,
  crawlR2Prefix,
  deriveCoverage,
  fingerprintCrawl,
  buildFullSiteMarkdown,
  type CrawlPersistenceEnv,
  type PersistCrawlInput,
} from '../persistence';
import { CrawlManifestSchema, type CrawlJob, type CrawlPage, type CrawlLink } from '../schemas';

const CRAWL_ID = '7b0f3c2a-1d4e-4a6b-8c9d-0e1f2a3b4c5d';
const PAGE_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PAGE_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

/** A fake R2 bucket that records every put(key, body, opts). */
function fakeBucket(opts: { throwOn?: string } = {}) {
  const puts: Array<{ key: string; body: string; contentType?: string }> = [];
  return {
    puts,
    SITES_BUCKET: {
      async put(key: string, body: unknown, options?: { httpMetadata?: { contentType?: string } }) {
        if (opts.throwOn && key.includes(opts.throwOn)) throw new Error('r2 boom');
        puts.push({
          key,
          body: typeof body === 'string' ? body : '[binary]',
          contentType: options?.httpMetadata?.contentType,
        });
        return undefined;
      },
    } as CrawlPersistenceEnv['SITES_BUCKET'],
  };
}

/** A fake D1 database that records each prepared statement + its bound params. */
function fakeDb(opts: { throw?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (opts.throw) throw new Error('d1 boom');
              calls.push({ sql, params });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { calls, DB };
}

function env(bucket = fakeBucket(), db = fakeDb()): {
  e: CrawlPersistenceEnv;
  puts: ReturnType<typeof fakeBucket>['puts'];
  calls: ReturnType<typeof fakeDb>['calls'];
} {
  return {
    e: { SITES_BUCKET: bucket.SITES_BUCKET, DB: db.DB },
    puts: bucket.puts,
    calls: db.calls,
  };
}

function job(overrides: Partial<CrawlJob> = {}): CrawlJob {
  return {
    id: CRAWL_ID,
    status: 'completed',
    url: 'https://www.Example.com/',
    createdAt: '2026-10-04T00:00:00.000Z',
    pagesDiscovered: 2,
    pagesCompleted: 2,
    ...overrides,
  } as CrawlJob;
}

function page(id: string, path: string): CrawlPage {
  const url = `https://example.com${path}`;
  return {
    id,
    discoveredUrl: url,
    requestedUrl: url,
    finalUrl: url,
    markdown: `# ${url}\n\nSome body copy for ${path}.`,
    metadata: {},
    contentHash: 'deadbeef',
  };
}

function input(overrides: Partial<PersistCrawlInput> = {}): PersistCrawlInput {
  return {
    job: job(),
    pages: [page(PAGE_A, '/'), page(PAGE_B, '/about')],
    links: [{ from: 'https://example.com/', to: 'https://example.com/about', kind: 'internal' } as CrawlLink],
    orgId: 'org1',
    request: { url: 'https://www.example.com/', mode: 'auto' } as PersistCrawlInput['request'],
    ...overrides,
  };
}

describe('pure helpers', () => {
  it('normalizeDomain lowercases + strips www + drops port', () => {
    expect(normalizeDomain('https://www.Example.com:443/about')).toBe('example.com');
    expect(normalizeDomain('https://sub.example.co.uk/')).toBe('sub.example.co.uk');
    expect(normalizeDomain('not a url')).toBe('unknown');
  });

  it('crawlR2Prefix is deterministic + trailing-slashed', () => {
    expect(crawlR2Prefix('example.com', CRAWL_ID)).toBe(`crawls/example.com/${CRAWL_ID}/`);
  });

  it('buildFullSiteMarkdown delimits pages by finalUrl + a horizontal rule', () => {
    const doc = buildFullSiteMarkdown([page(PAGE_A, '/'), page(PAGE_B, '/about')]);
    expect(doc).toContain('## https://example.com/');
    expect(doc).toContain('## https://example.com/about');
    expect(doc).toContain('\n\n---\n\n');
  });

  it('deriveCoverage reconciles discovered/completed/errored', () => {
    const cov = deriveCoverage(job({ pagesDiscovered: 5 }), [page(PAGE_A, '/'), page(PAGE_B, '/about')]);
    expect(cov.completed).toBe(2);
    expect(cov.discovered).toBe(5); // max(job.discovered, completed)
    expect(cov.errored).toBe(3); // discovered − completed
    expect(cov.status).toBe('complete'); // job status 'completed'
  });

  it('deriveCoverage rolls an in-flight job up to partial, not complete', () => {
    const cov = deriveCoverage(job({ status: 'running', pagesDiscovered: 0 }), [page(PAGE_A, '/')]);
    expect(cov.discovered).toBe(1); // completed floors discovered
    expect(cov.status).toBe('partial');
  });

  it('fingerprintCrawl is stable for identical inputs + differs on config change', () => {
    const base = { url: 'https://example.com/', mode: 'auto' } as PersistCrawlInput['request'];
    const a = fingerprintCrawl('https://example.com/', base);
    const b = fingerprintCrawl('https://example.com/', base);
    const c = fingerprintCrawl('https://example.com/', { ...base, mode: 'rendered' } as PersistCrawlInput['request']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('persistCrawl — R2 corpus', () => {
  it('writes manifest.json / links.json / full-site.md + one md per page under the domain prefix', async () => {
    const { e, puts } = env();
    const res = await persistCrawl(e, input());

    expect(res.ok).toBe(true);
    const prefix = `crawls/example.com/${CRAWL_ID}/`;
    const keys = puts.map((p) => p.key);
    expect(keys).toContain(`${prefix}manifest.json`);
    expect(keys).toContain(`${prefix}links.json`);
    expect(keys).toContain(`${prefix}full-site.md`);
    expect(keys).toContain(`${prefix}pages/${PAGE_A}.md`);
    expect(keys).toContain(`${prefix}pages/${PAGE_B}.md`);
    expect(keys).toHaveLength(5); // manifest + links + full-site + 2 pages
    expect(res.r2Prefix).toBe(prefix);
  });

  it('manifest body is a valid CrawlManifest with the corpus keys + coverage counts', async () => {
    const { e, puts } = env();
    await persistCrawl(e, input());
    const manifestPut = puts.find((p) => p.key.endsWith('manifest.json'));
    expect(manifestPut).toBeDefined();
    expect(manifestPut?.contentType).toBe('application/json');
    const manifest = CrawlManifestSchema.parse(JSON.parse(manifestPut!.body));
    expect(manifest.crawlId).toBe(CRAWL_ID);
    expect(manifest.root).toBe('https://www.example.com/');
    expect(manifest.provider).toBe('cloudflare');
    expect(manifest.counts.completed).toBe(2);
    expect(manifest.r2Keys).toContain(`crawls/example.com/${CRAWL_ID}/full-site.md`);
    expect(manifest.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('per-page md files carry the page finalUrl heading + markdown; content-type is markdown', async () => {
    const { e, puts } = env();
    await persistCrawl(e, input());
    const pagePut = puts.find((p) => p.key.endsWith(`pages/${PAGE_A}.md`));
    expect(pagePut?.contentType).toBe('text/markdown; charset=utf-8');
    expect(pagePut?.body).toContain('# https://example.com/');
  });

  it('links.json contains the discovered edges', async () => {
    const { e, puts } = env();
    await persistCrawl(e, input());
    const linksPut = puts.find((p) => p.key.endsWith('links.json'));
    const links = JSON.parse(linksPut!.body) as CrawlLink[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: 'https://example.com/', to: 'https://example.com/about', kind: 'internal' });
  });
});

describe('persistCrawl — D1 metadata row', () => {
  it('upserts ONE row with the expected column values + ON CONFLICT DO UPDATE', async () => {
    const { e, calls } = env();
    await persistCrawl(e, input());
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain('INSERT INTO site_crawls');
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
    // Positional params: id, org_id, root_url, normalized_domain, status, mode, provider, provider_job_id, ...
    expect(params[0]).toBe(CRAWL_ID);
    expect(params[1]).toBe('org1');
    expect(params[2]).toBe('https://www.example.com/');
    expect(params[3]).toBe('example.com');
    expect(params[4]).toBe('completed'); // status
    expect(params[5]).toBe('auto'); // mode
    expect(params[6]).toBe('cloudflare'); // provider
    expect(params[7]).toBe(CRAWL_ID); // provider_job_id
    expect(params[8]).toBe(2); // pages_discovered
    expect(params[9]).toBe(2); // pages_completed
    expect(params[10]).toBe(0); // errored
    expect(params[11]).toBe('complete'); // coverage_status
  });

  it('persists previous_crawl_id + a config JSON snapshot when provided', async () => {
    const { e, calls } = env();
    await persistCrawl(
      e,
      input({
        previousCrawlId: 'prev-crawl-id',
        request: { url: 'https://www.example.com/', mode: 'rendered', depth: 3 } as PersistCrawlInput['request'],
      }),
    );
    const { params } = calls[0];
    // previous_crawl_id is the 16th positional param (index 15).
    expect(params[15]).toBe('prev-crawl-id');
    const configJson = params[16] as string; // config
    expect(typeof configJson).toBe('string');
    const config = JSON.parse(configJson);
    expect(config.mode).toBe('rendered');
    expect(config.depth).toBe(3);
  });

  it('content_bytes equals the summed markdown length', async () => {
    const { e, calls } = env();
    const pages = [page(PAGE_A, '/'), page(PAGE_B, '/about')];
    await persistCrawl(e, input({ pages }));
    const expectedBytes = pages.reduce((n, p) => n + p.markdown.length, 0);
    expect(calls[0].params[12]).toBe(expectedBytes); // content_bytes
  });
});

describe('persistCrawl — idempotent re-write', () => {
  it('re-persisting the same crawl writes the SAME R2 keys + upserts again', async () => {
    const bucket = fakeBucket();
    const db = fakeDb();
    const { e } = env(bucket, db);

    const first = await persistCrawl(e, input());
    const firstKeys = [...new Set(bucket.puts.map((p) => p.key))].sort();

    const second = await persistCrawl(e, input());
    const allKeys = [...new Set(bucket.puts.map((p) => p.key))].sort();

    // No NEW distinct keys appeared on the second run — same deterministic corpus layout.
    expect(allKeys).toEqual(firstKeys);
    // Each put happened twice (overwrite), and D1 upserted twice.
    expect(bucket.puts).toHaveLength(10); // 5 keys × 2 runs
    expect(db.calls).toHaveLength(2);
    expect(first.r2Prefix).toBe(second.r2Prefix);
    expect(first.crawlId).toBe(second.crawlId);
  });
});

describe('persistCrawl — fail-soft (never throws)', () => {
  it('captures an R2 put failure in result.errors, still writes the rest + the D1 row', async () => {
    const bucket = fakeBucket({ throwOn: 'manifest.json' });
    const db = fakeDb();
    const { e } = env(bucket, db);
    const res = await persistCrawl(e, input());
    expect(res.ok).toBe(false);
    expect(res.errors.some((x) => x.startsWith('r2:') && x.includes('manifest.json'))).toBe(true);
    // The D1 row still got written despite the R2 failure.
    expect(db.calls).toHaveLength(1);
  });

  it('captures a D1 failure in result.errors, never re-throws', async () => {
    const bucket = fakeBucket();
    const db = fakeDb({ throw: true });
    const { e } = env(bucket, db);
    const res = await persistCrawl(e, input());
    expect(res.ok).toBe(false);
    expect(res.errors.some((x) => x.startsWith('d1:'))).toBe(true);
    // R2 corpus still fully written.
    expect(bucket.puts).toHaveLength(5);
  });

  it('a null orgId is allowed (persists org_id = null)', async () => {
    const { e, calls } = env();
    const res = await persistCrawl(e, input({ orgId: null }));
    expect(res.ok).toBe(true);
    expect(calls[0].params[1]).toBeNull();
  });
});
