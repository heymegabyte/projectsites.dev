/**
 * import_crawler — one-click site-import URL discovery crawler.
 *
 * Exercises the discovery chain (sitemap → robots → wayback → homepage BFS),
 * dedupe + provenance priority, normalization, same-origin filtering, the
 * timeout-wrapper resilience, R2 persistence, and the rebuild estimator.
 * Every outbound fetch is mocked via `global.fetch` — never a real network call.
 *
 * Coverage map:
 *   1. constants            — REAL_BROWSER_UA + REAL_BROWSER_HEADERS shape,
 *   2. crawlSiteForImport   — sitemap leaf + nested-index walk, robots Sitemap:
 *      lines, wayback CDX fallback (only when live count < 5), homepage BFS
 *      (title + theme-color + href extraction, mailto/tel/javascript skip,
 *      cross-origin + dupe filtering), seed homepage always present, final
 *      dedupe by provenance priority, by_source tally, network/non-200 resilience,
 *      utm/fbclid/gclid stripping, fragment drop, R2 put + R2-failure swallow,
 *   3. estimateRebuildMinutes — base floor, linear growth, 60-minute clamp, 0 input.
 *
 * ts-jest: GLOBAL `jest` (no @jest/globals import). All fetch/R2 I/O mocked; no real APIs.
 */
import {
  crawlSiteForImport,
  estimateRebuildMinutes,
  safeFetch,
  REAL_BROWSER_UA,
  REAL_BROWSER_HEADERS,
  type CrawlReport,
} from '../services/import_crawler.js';
import type { Env } from '../types/env.js';

/** Build a text/200 Response. */
const okText = (body: string): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  }) as unknown as Response;

/** Build a non-ok Response. */
const notOk = (status = 404): Response =>
  ({ ok: false, status, text: async () => '', json: async () => ({}) }) as unknown as Response;

/** Build a JSON/200 Response (Wayback CDX rows). */
const okJson = (data: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }) as unknown as Response;

/** Mock R2 bucket whose `put` we can assert on / make throw. */
const makeBucket = (throwOnPut = false) => {
  const put = jest.fn(async () => {
    if (throwOnPut) throw new Error('R2 down');
    return {};
  });
  return { put };
};

const makeEnv = (bucket: { put: jest.Mock }): Env => ({ SITES_BUCKET: bucket }) as unknown as Env;

const SITEMAP_XML = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/services</loc></url>
  <url><loc>https://example.com/contact</loc></url>
  <url><loc>https://example.com/blog</loc></url>
  <url><loc>https://example.com/team</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sub-sitemap.xml</loc></sitemap>
</sitemapindex>`;

const SUB_SITEMAP = `<?xml version="1.0"?>
<urlset><url><loc>https://example.com/nested-page</loc></url></urlset>`;

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/**
 * Route fetch calls by URL substring → Response. Unmatched URLs return a 404.
 * Lets each test declare only the endpoints it cares about.
 */
function routeFetch(routes: Array<[string, Response]>): void {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [needle, res] of routes) {
      if (String(url).includes(needle)) return res;
    }
    return notOk();
  });
}

// ─── constants ───────────────────────────────────────────────────
describe('constants', () => {
  it('REAL_BROWSER_UA is a Chrome-stable desktop UA', () => {
    expect(REAL_BROWSER_UA).toMatch(/Chrome\/\d+/);
    expect(REAL_BROWSER_UA).toMatch(/Macintosh/);
  });

  it('REAL_BROWSER_HEADERS carries UA + the Sec-Fetch companion set', () => {
    expect(REAL_BROWSER_HEADERS['User-Agent']).toBe(REAL_BROWSER_UA);
    expect(REAL_BROWSER_HEADERS['Sec-Fetch-Mode']).toBe('navigate');
    expect(REAL_BROWSER_HEADERS['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(REAL_BROWSER_HEADERS['Upgrade-Insecure-Requests']).toBe('1');
  });
});

// ─── crawlSiteForImport: sitemap path ────────────────────────────
describe('crawlSiteForImport — sitemap discovery', () => {
  it('discovers sitemap leaves, always seeds the homepage, and persists to R2', async () => {
    routeFetch([
      ['/sitemap.xml', okText(SITEMAP_XML)],
      ['example.com/', okText('<html><head><title>Home</title></head><body></body></html>')],
    ]);
    const bucket = makeBucket();
    const report = await crawlSiteForImport('https://example.com/start', 'imp-1', makeEnv(bucket));

    expect(report.source_url).toBe('https://example.com/start');
    expect(report.base_origin).toBe('https://example.com');
    // 5 sitemap urls + seeded homepage (homepage not in sitemap list).
    expect(report.total_urls).toBe(6);
    expect(report.urls.some((u) => u.url === 'https://example.com/')).toBe(true);
    expect(report.urls.some((u) => u.path === '/about' && u.source === 'sitemap')).toBe(true);
    expect(report.by_source.sitemap).toBeGreaterThanOrEqual(5);
    // R2 persisted under the import id.
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.put.mock.calls[0][0]).toBe('imports/imp-1/_url_inventory.json');
  });

  it('uses the realistic browser UA on every outbound fetch', async () => {
    routeFetch([['/sitemap.xml', okText(SITEMAP_XML)]]);
    await crawlSiteForImport('https://example.com', 'imp-ua', makeEnv(makeBucket()));
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['User-Agent']).toBe(REAL_BROWSER_UA);
  });

  it('walks one level of nested <sitemapindex> references', async () => {
    routeFetch([
      ['/sitemap.xml', okText(SITEMAP_INDEX)],
      ['/sub-sitemap.xml', okText(SUB_SITEMAP)],
      ['example.com/', okText('<html></html>')],
    ]);
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-nested',
      makeEnv(makeBucket()),
    );
    expect(report.urls.some((u) => u.path === '/nested-page')).toBe(true);
  });

  it('strips utm/fbclid/gclid trackers and drops the fragment during normalization', async () => {
    const dirty = `<urlset><url><loc>https://example.com/page?utm_source=x&fbclid=y&keep=1#frag</loc></url></urlset>`;
    routeFetch([
      ['/sitemap.xml', okText(dirty)],
      ['example.com/', okText('<html></html>')],
    ]);
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-clean',
      makeEnv(makeBucket()),
    );
    const page = report.urls.find((u) => u.path === '/page');
    expect(page).toBeDefined();
    expect(page!.url).not.toContain('utm_source');
    expect(page!.url).not.toContain('fbclid');
    expect(page!.url).not.toContain('#frag');
    expect(page!.url).toContain('keep=1');
  });

  it('filters cross-origin sitemap entries', async () => {
    const xml = `<urlset>
      <url><loc>https://example.com/good</loc></url>
      <url><loc>https://evil.com/bad</loc></url>
    </urlset>`;
    routeFetch([
      ['/sitemap.xml', okText(xml)],
      ['example.com/', okText('<html></html>')],
    ]);
    const report = await crawlSiteForImport('https://example.com', 'imp-xo', makeEnv(makeBucket()));
    expect(report.urls.some((u) => u.url.includes('example.com/good'))).toBe(true);
    expect(report.urls.some((u) => u.url.includes('evil.com'))).toBe(false);
  });
});

// ─── crawlSiteForImport: robots path ─────────────────────────────
describe('crawlSiteForImport — robots.txt fallback', () => {
  it('parses Sitemap: directives from robots.txt and tags them as robots provenance', async () => {
    const robots = `User-agent: *\nDisallow:\nSitemap: https://example.com/custom-sitemap.xml\n`;
    const customSm = `<urlset><url><loc>https://example.com/from-robots</loc></url></urlset>`;
    routeFetch([
      ['/robots.txt', okText(robots)],
      ['/custom-sitemap.xml', okText(customSm)],
      ['example.com/', okText('<html></html>')],
      // /sitemap.xml etc return 404 via default fall-through
    ]);
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-robots',
      makeEnv(makeBucket()),
    );
    const row = report.urls.find((u) => u.path === '/from-robots');
    expect(row).toBeDefined();
    expect(row!.source).toBe('robots');
    expect(report.by_source.robots).toBeGreaterThanOrEqual(1);
  });

  it('caps robots-sourced leaves at 2000 — an attacker robots.txt with a huge sitemap can not blow up the crawl (AL-779)', async () => {
    // robots.txt → one Sitemap: → a crafted 2500-<loc> XML. Before the cap the uncapped fromRobots
    // pushed all 2500 into robotsUrls (concatenated raw into the report + persisted to R2); now it
    // stops at 2000 like its fromSitemap sibling. crawlSiteForImport has no downstream total cap, so
    // this asserts the fromRobots cap itself (old code → 2500).
    const robots = `User-agent: *\nSitemap: https://example.com/huge-sitemap.xml\n`;
    const hugeSm =
      '<urlset>' +
      Array.from({ length: 2500 }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`).join('') +
      '</urlset>';
    routeFetch([
      ['/robots.txt', okText(robots)],
      ['/huge-sitemap.xml', okText(hugeSm)],
      ['example.com/', okText('<html></html>')],
      // /sitemap.xml 404s via fall-through → fromSitemap empty → robots is the only leaf source
    ]);
    const report = await crawlSiteForImport('https://example.com', 'imp-huge', makeEnv(makeBucket()));
    expect(report.by_source.robots).toBe(2000); // was 2500 (uncapped) before AL-779
  });
});

// ─── crawlSiteForImport: wayback fallback ────────────────────────
describe('crawlSiteForImport — Wayback CDX fallback', () => {
  it('hits Wayback only when live discovery yields < 5 URLs and tags wayback provenance', async () => {
    const cdxRows = [
      ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode'], // header row, skipped
      ['k1', '2020', 'https://example.com/archived-1', 'text/html', '200'],
      ['k2', '2021', 'https://example.com/archived-2', 'text/html', '200'],
    ];
    routeFetch([
      ['web.archive.org', okJson(cdxRows)],
      ['example.com/', okText('<html></html>')],
      // no sitemap, no robots → live count is 0 → wayback fires
    ]);
    const report = await crawlSiteForImport('https://example.com', 'imp-wb', makeEnv(makeBucket()));
    expect(report.urls.some((u) => u.path === '/archived-1' && u.source === 'wayback')).toBe(true);
    expect(report.by_source.wayback).toBe(2);
  });

  it('does NOT hit Wayback when the sitemap already yields ≥ 5 URLs', async () => {
    routeFetch([
      ['/sitemap.xml', okText(SITEMAP_XML)], // 5 leaves
      ['example.com/', okText('<html></html>')],
    ]);
    await crawlSiteForImport('https://example.com', 'imp-nowb', makeEnv(makeBucket()));
    const hitWayback = fetchMock.mock.calls.some((c) => String(c[0]).includes('web.archive.org'));
    expect(hitWayback).toBe(false);
  });

  it('survives malformed (non-array) Wayback JSON without throwing', async () => {
    routeFetch([
      ['web.archive.org', okJson({ not: 'an array' })],
      ['example.com/', okText('<html></html>')],
    ]);
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-wbbad',
      makeEnv(makeBucket()),
    );
    expect(report.by_source.wayback).toBe(0);
    // still ships the seeded homepage
    expect(report.total_urls).toBeGreaterThanOrEqual(1);
  });

  it('survives Wayback returning invalid JSON (json() throws)', async () => {
    const throwingJson = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
      text: async () => '',
    } as unknown as Response;
    routeFetch([
      ['web.archive.org', throwingJson],
      ['example.com/', okText('<html></html>')],
    ]);
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-wbthrow',
      makeEnv(makeBucket()),
    );
    expect(report.by_source.wayback).toBe(0);
  });
});

// ─── crawlSiteForImport: homepage BFS ────────────────────────────
describe('crawlSiteForImport — homepage HTML BFS', () => {
  it('extracts title, theme-color, and same-origin hrefs while skipping mailto/tel/js + cross-origin', async () => {
    const homepage = `<html><head>
      <title>  My Homepage  </title>
      <meta name="theme-color" content="#0a0a1a">
      </head><body>
      <a href="/page-a">A</a>
      <a href="https://example.com/page-b">B</a>
      <a href="mailto:hi@example.com">mail</a>
      <a href="tel:+15551234567">tel</a>
      <a href="javascript:void(0)">js</a>
      <a href="https://evil.com/x">x-origin</a>
      </body></html>`;
    routeFetch([['example.com', okText(homepage)]]); // sitemap/robots also match example.com → HTML parse yields no <url>/<loc>, so only BFS surfaces links
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-bfs',
      makeEnv(makeBucket()),
    );
    expect(report.homepage_title).toBe('My Homepage');
    expect(report.theme_color).toBe('#0a0a1a');
    expect(report.urls.some((u) => u.path === '/page-a' && u.source === 'html_bfs')).toBe(true);
    expect(report.urls.some((u) => u.path === '/page-b')).toBe(true);
    expect(report.urls.some((u) => u.url.includes('mailto'))).toBe(false);
    expect(report.urls.some((u) => u.url.includes('tel:'))).toBe(false);
    expect(report.urls.some((u) => u.url.includes('evil.com'))).toBe(false);
  });

  it('returns null title + theme_color when the homepage fetch is non-200', async () => {
    // Everything 404s → homepage BFS returns nulls, only seeded homepage remains.
    fetchMock.mockResolvedValue(notOk());
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-empty',
      makeEnv(makeBucket()),
    );
    expect(report.homepage_title).toBeNull();
    expect(report.theme_color).toBeNull();
    expect(report.total_urls).toBe(1); // just the seed
    expect(report.urls[0].path).toBe('/');
  });
});

// ─── crawlSiteForImport: resilience + dedupe ─────────────────────
describe('crawlSiteForImport — resilience & dedupe', () => {
  it('swallows total network failure and still returns the seeded homepage report', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-net',
      makeEnv(makeBucket()),
    );
    expect(report.total_urls).toBe(1);
    expect(report.urls[0].url).toBe('https://example.com/');
  });

  it('dedupes a URL surfaced by both sitemap and BFS, keeping sitemap provenance', async () => {
    const sm = `<urlset><url><loc>https://example.com/shared</loc></url></urlset>`;
    const homepage = `<html><body><a href="/shared">dup</a></body></html>`;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/sitemap.xml')) return okText(sm);
      if (u === 'https://example.com' || u === 'https://example.com/') return okText(homepage);
      return notOk();
    });
    const report = await crawlSiteForImport(
      'https://example.com',
      'imp-dedup',
      makeEnv(makeBucket()),
    );
    const shared = report.urls.filter((u) => u.path === '/shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe('sitemap'); // priority wins over html_bfs
  });

  it('swallows an R2 put failure and still returns the report', async () => {
    routeFetch([
      ['/sitemap.xml', okText(SITEMAP_XML)],
      ['example.com/', okText('<html></html>')],
    ]);
    const bucket = makeBucket(true); // put throws
    const report = await crawlSiteForImport('https://example.com', 'imp-r2fail', makeEnv(bucket));
    expect(report.total_urls).toBeGreaterThan(0);
    expect(bucket.put).toHaveBeenCalled();
  });

  it('produces a complete CrawlReport shape', async () => {
    routeFetch([
      ['/sitemap.xml', okText(SITEMAP_XML)],
      ['example.com/', okText('<html><title>T</title></html>')],
    ]);
    const report: CrawlReport = await crawlSiteForImport(
      'https://example.com',
      'imp-shape',
      makeEnv(makeBucket()),
    );
    expect(report).toMatchObject({
      source_url: 'https://example.com',
      base_origin: 'https://example.com',
      by_source: expect.objectContaining({
        sitemap: expect.any(Number),
        robots: 0,
        wayback: 0,
        html_bfs: 0,
      }),
    });
    expect(typeof report.discovered_at).toBe('string');
    expect(Array.isArray(report.urls)).toBe(true);
    report.urls.forEach((u) => {
      expect(u).toMatchObject({
        url: expect.any(String),
        path: expect.any(String),
        classification: 'keep',
      });
    });
  });
});

// ─── estimateRebuildMinutes ──────────────────────────────────────
describe('estimateRebuildMinutes', () => {
  it('returns the 4-minute base floor for zero URLs', () => {
    expect(estimateRebuildMinutes(0)).toBe(4);
  });

  it('grows linearly with URL count (6s per URL)', () => {
    // 10 urls * 6s = 60s = 1 min → 4 + 1 = 5
    expect(estimateRebuildMinutes(10)).toBe(5);
    // 50 urls * 6s = 300s = 5 min → 4 + 5 = 9
    expect(estimateRebuildMinutes(50)).toBe(9);
  });

  it('clamps at 60 minutes for huge crawls', () => {
    expect(estimateRebuildMinutes(100_000)).toBe(60);
  });
});

describe('safeFetch — SSRF redirect-hop guard (gap-audit #2)', () => {
  const redirectTo = (loc: string, status = 302): Response =>
    ({
      status,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? loc : null) },
    }) as unknown as Response;

  it('refuses a redirect that points at an internal/metadata host', async () => {
    // public seed → 302 → 169.254.169.254 (cloud metadata). Must NOT be followed.
    fetchMock.mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'));
    const res = await safeFetch('https://example.com/');
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // stopped at the redirect, never hit the internal target
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a redirect to another PUBLIC host', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://cdn.example.net/final'))
      .mockResolvedValueOnce(okText('<html>ok</html>'));
    const res = await safeFetch('https://example.com/');
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an internal SEED before any fetch (pre-redirect guard)', async () => {
    const res = await safeFetch('http://localhost:8080/admin');
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops after 5 redirect hops (redirect-loop SSRF)', async () => {
    fetchMock.mockResolvedValue(redirectTo('https://example.com/next'));
    const res = await safeFetch('https://example.com/');
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
