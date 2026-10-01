jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
}));

import { dbQuery, dbQueryOne } from '../services/db.js';
import { resolveSite, serveSiteFromR2 } from '../services/site_serving.js';
import { DOMAINS } from '@project-sites/shared';

const mockQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const createMockKV = () => ({
  get: jest.fn().mockResolvedValue(null),
  put: jest.fn().mockResolvedValue(undefined),
});

const createMockR2Object = (content: string) => ({
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  }),
  text: jest.fn().mockResolvedValue(content),
  arrayBuffer: jest.fn().mockResolvedValue(new TextEncoder().encode(content).buffer),
});

const createMockR2 = () => ({
  get: jest.fn().mockResolvedValue(null),
  put: jest.fn(),
});

const createMockEnv = () => ({
  CACHE_KV: createMockKV(),
  SITES_BUCKET: createMockR2(),
  DB: {} as D1Database,
});

const createMockDb = () => ({}) as D1Database;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_HTML = '<html><body><h1>Hello</h1></body></html>';

const makeSite = (overrides: Record<string, unknown> = {}) => ({
  site_id: 'site-001',
  slug: 'my-site',
  org_id: 'org-001',
  current_build_version: 'v1',
  plan: 'free',
  ...overrides,
});

// ---------------------------------------------------------------------------
// resolveSite
// ---------------------------------------------------------------------------

describe('resolveSite', () => {
  let env: ReturnType<typeof createMockEnv>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    jest.clearAllMocks();
    env = createMockEnv();
    db = createMockDb();
  });

  it('returns cached result from KV when available', async () => {
    const cached = makeSite();
    (env.CACHE_KV.get as jest.Mock).mockResolvedValue(cached);

    const result = await resolveSite(env as any, db, 'my-site.projectsites.dev');

    expect(result).toEqual(cached);
    expect(env.CACHE_KV.get).toHaveBeenCalledWith('host:my-site.projectsites.dev', 'json');
    // Should NOT have queried the database
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('extracts slug from dash-based hostname and looks up site in DB', async () => {
    mockQueryOne
      // sites table query
      .mockResolvedValueOnce({
        id: 'site-001',
        slug: 'cool-biz',
        org_id: 'org-001',
        current_build_version: 'v2',
      })
      // subscriptions query
      .mockResolvedValueOnce({ plan: 'paid', status: 'active' });

    const result = await resolveSite(env as any, db, `cool-biz${DOMAINS.SITES_SUFFIX}`);

    expect(result).toEqual({
      site_id: 'site-001',
      slug: 'cool-biz',
      org_id: 'org-001',
      current_build_version: 'v2',
      plan: 'paid',
    });
  });

  it('looks up site by slug in DB', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'site-abc',
        slug: 'test-slug',
        org_id: 'org-abc',
        current_build_version: 'v5',
      })
      .mockResolvedValueOnce(null); // no subscription

    const result = await resolveSite(env as any, db, `test-slug${DOMAINS.SITES_SUFFIX}`);

    expect(result).not.toBeNull();
    expect(result!.slug).toBe('test-slug');
    expect(result!.site_id).toBe('site-abc');
  });

  it('looks up custom domain in hostnames table', async () => {
    mockQueryOne
      // hostnames table
      .mockResolvedValueOnce({ site_id: 'site-custom', org_id: 'org-custom' })
      // sites table
      .mockResolvedValueOnce({ slug: 'custom-slug', current_build_version: 'v3' })
      // subscriptions
      .mockResolvedValueOnce({ plan: 'paid', status: 'active' });

    const result = await resolveSite(env as any, db, 'www.custom-domain.com');

    expect(result).toEqual({
      site_id: 'site-custom',
      slug: 'custom-slug',
      org_id: 'org-custom',
      current_build_version: 'v3',
      plan: 'paid',
    });
  });

  it('returns plan=paid when subscription is paid and active', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'site-p',
        slug: 'paid-site',
        org_id: 'org-p',
        current_build_version: 'v1',
      })
      .mockResolvedValueOnce({ plan: 'paid', status: 'active' });

    const result = await resolveSite(env as any, db, `paid-site${DOMAINS.SITES_SUFFIX}`);

    expect(result!.plan).toBe('paid');
  });

  it('returns plan=free when no subscription exists', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'site-f',
        slug: 'free-site',
        org_id: 'org-f',
        current_build_version: 'v1',
      })
      .mockResolvedValueOnce(null);

    const result = await resolveSite(env as any, db, `free-site${DOMAINS.SITES_SUFFIX}`);

    expect(result!.plan).toBe('free');
  });

  it('returns plan=free when subscription is past_due/canceled (excluded by SSOT SQL)', async () => {
    // resolveSite delegates plan resolution to resolveActiveOrgPlan, whose SQL
    // filters `status IN ('active', 'trialing')` — a canceled sub matches no row,
    // so the sub-query mock returns null (as the real query would) → free.
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'site-i',
        slug: 'inactive-site',
        org_id: 'org-i',
        current_build_version: 'v1',
      })
      .mockResolvedValueOnce(null);

    const result = await resolveSite(env as any, db, `inactive-site${DOMAINS.SITES_SUFFIX}`);

    expect(result!.plan).toBe('free');
  });

  it('returns plan=paid when subscription is paid and TRIALING (trialing is entitled)', async () => {
    // Trialing-drift fix: the SSOT SQL includes `trialing`, so a paid trial returns a
    // `{ plan: 'paid' }` row → served as paid (no top-bar). Was wrongly 'free' under
    // the old active-only gate.
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'site-t',
        slug: 'trial-site',
        org_id: 'org-t',
        current_build_version: 'v1',
      })
      .mockResolvedValueOnce({ plan: 'paid' });

    const result = await resolveSite(env as any, db, `trial-site${DOMAINS.SITES_SUFFIX}`);

    expect(result!.plan).toBe('paid');
  });

  it('returns null when site not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await resolveSite(env as any, db, `nonexistent${DOMAINS.SITES_SUFFIX}`);

    expect(result).toBeNull();
  });

  it('caches resolved site in KV with 60-second TTL', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'site-c',
        slug: 'cached-site',
        org_id: 'org-c',
        current_build_version: 'v1',
      })
      .mockResolvedValueOnce({ plan: 'paid', status: 'active' });

    await resolveSite(env as any, db, `cached-site${DOMAINS.SITES_SUFFIX}`);

    expect(env.CACHE_KV.put).toHaveBeenCalledWith(
      `host:cached-site${DOMAINS.SITES_SUFFIX}`,
      expect.any(String),
      { expirationTtl: 60 },
    );

    // Verify the cached value is correct JSON
    const cachedJson = JSON.parse((env.CACHE_KV.put as jest.Mock).mock.calls[0][1]);
    expect(cachedJson.slug).toBe('cached-site');
    expect(cachedJson.plan).toBe('paid');
  });

  it('returns null for unknown custom domain', async () => {
    // hostnames lookup returns null
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await resolveSite(env as any, db, 'unknown.example.com');

    expect(result).toBeNull();
    expect(env.CACHE_KV.put).not.toHaveBeenCalled();
  });

  it('handles DB query errors gracefully', async () => {
    // dbQueryOne returns null on error (it catches internally)
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await resolveSite(env as any, db, `broken${DOMAINS.SITES_SUFFIX}`);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serveSiteFromR2
// ---------------------------------------------------------------------------

describe('serveSiteFromR2', () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    jest.clearAllMocks();
    env = createMockEnv();
  });

  it('returns file from R2 with correct content type for .html', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/page.html');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('returns file from R2 with correct content type for .css', async () => {
    const cssContent = 'body { color: red; }';
    const r2Obj = createMockR2Object(cssContent);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/styles.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/css');
  });

  it('returns file from R2 with correct content type for .js', async () => {
    const jsContent = 'console.log("hello");';
    const r2Obj = createMockR2Object(jsContent);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/app.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/javascript');
  });

  it('returns file from R2 with correct content type for .png', async () => {
    const r2Obj = createMockR2Object('PNG_BINARY_DATA');
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/logo.png');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
  });

  it('falls back to index.html for paths without extensions (SPA)', async () => {
    const indexHtml = createMockR2Object(SAMPLE_HTML);
    // serveSiteFromR2 tries several R2 keys before SPA fallback:
    // 1. /sites/.../about/team        (primary)
    // 2. /sites/.../about/team/index.html (directory index)
    // 3. /sites/.../about/team.html   (.html extension)
    // 4. /sites/.../about-team.html   (flat-name fallback)
    // 5. /sites/.../index.html        (SPA catch-all) <-- this is the match
    (env.SITES_BUCKET.get as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(indexHtml);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/about/team');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    // The SPA catch-all fetches index.html (a later sitemap.xml lookup for the
    // soft-404 route check may be the final call, so assert "was called", not "last").
    expect(env.SITES_BUCKET.get).toHaveBeenCalledWith(`sites/my-site/v1/index.html`);
  });

  it('returns 404 when file not found', async () => {
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(null);

    const site = makeSite();
    const response = await serveSiteFromR2(env as any, site, '/missing.css');

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe('Not Found');
  });

  it('returns 404 when SPA fallback also not found', async () => {
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const site = makeSite();
    const response = await serveSiteFromR2(env as any, site, '/dashboard');

    expect(response.status).toBe(404);
  });

  // The upgrade bar's presentation now lives in the unified client script
  // (`/app.js`), gated on the `data-paid` attribute. Serve-path assertion is:
  // every site gets the app.js script tag injected; unpaid carries
  // data-paid="false" (client renders the bar), paid carries data-paid="true"
  // (client renders nothing). The server no longer emits the `ps-bar` HTML.
  it('injects the unified app.js script (data-paid="false") for unpaid site HTML', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'free' });
    const response = await serveSiteFromR2(env as any, site, '/index.html');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`https://${DOMAINS.SITES_BASE}/app.js`);
    expect(html).toContain('data-paid="false"');
    expect(html).toContain('<h1>Hello</h1>');
    // Script is injected before </body>, after the opening <body>.
    const bodyIndex = html.indexOf('<body>');
    const scriptIndex = html.indexOf('/app.js');
    expect(scriptIndex).toBeGreaterThan(bodyIndex);
    // The server no longer renders the conversion-flow bar HTML itself.
    expect(html).not.toContain('ps-bar-inner');
  });

  it('injects the unified app.js script with data-paid="true" for paid site HTML', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/index.html');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`https://${DOMAINS.SITES_BASE}/app.js`);
    expect(body).toContain('data-paid="true"');
    // No server-rendered bar HTML for a paid site.
    expect(body).not.toContain('ps-bar-inner');
    expect(body).not.toContain('ProjectSites Conversion Flow');
  });

  it('does NOT inject top bar for non-HTML responses (CSS, JS)', async () => {
    const cssContent = 'body { margin: 0; }';
    const r2Obj = createMockR2Object(cssContent);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'free' });
    const response = await serveSiteFromR2(env as any, site, '/styles.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/css');
  });

  // fire-66: the unpaid promo top-bar (rendered client-side by /app.js from
  // data-paid="false") MUST appear ONLY on real published 200 content — NEVER on
  // a soft-404 / error HTML response. The server-side hook is the injected
  // `<script …/app.js data-paid="false">` tag, so gating its injection off
  // non-200 responses gates the bar. These two cases lock that contract: a 404
  // soft-404 shell carries NO app.js tag; a 200 content page for the same unpaid
  // site STILL does.
  it('does NOT inject the app.js upgrade-bar tag on a soft-404 (unknown route) for an unpaid site', async () => {
    // A sitemap that does NOT list /about-us → the SPA-fallback shell is served
    // with a 404 status (soft-404 guard). No app.js tag → no unpaid bar on the
    // error surface.
    const sitemapXml =
      '<?xml version="1.0"?><urlset><url><loc>https://my-site.example/</loc></url>' +
      '<url><loc>https://my-site.example/contact</loc></url></urlset>';
    (env.SITES_BUCKET.get as jest.Mock).mockImplementation(async (key: string) => {
      // SPA catch-all only (the version-root index.html) — NOT the /about-us/index.html
      // directory-index probe, which must miss so the soft-404 path is exercised.
      if (key === 'sites/my-site/v1/index.html') return createMockR2Object(SAMPLE_HTML);
      if (key === 'sites/my-site/v1/sitemap.xml') return createMockR2Object(sitemapXml);
      return null; // every primary / dir-index / .html / flat-name lookup misses
    });

    const site = makeSite({ plan: 'free' });
    const response = await serveSiteFromR2(env as any, site, '/about-us');

    expect(response.status).toBe(404);
    const html = await response.text();
    // The shell still renders (SPA can show its own 404 view)…
    expect(html).toContain('<h1>Hello</h1>');
    // …but the unpaid upgrade bar's server hook is absent on the error surface.
    expect(html).not.toContain(`https://${DOMAINS.SITES_BASE}/app.js`);
    expect(html).not.toContain('data-paid="false"');
    expect(html).not.toContain('data-paid');
  });

  it('STILL injects the app.js upgrade-bar tag on a 200 content page for the same unpaid site', async () => {
    // A sitemap that DOES list /about-us → served with a 200 status → the unpaid
    // bar's server hook is present, exactly as on any real content page.
    const sitemapXml =
      '<?xml version="1.0"?><urlset><url><loc>https://my-site.example/</loc></url>' +
      '<url><loc>https://my-site.example/about-us</loc></url></urlset>';
    (env.SITES_BUCKET.get as jest.Mock).mockImplementation(async (key: string) => {
      if (key.endsWith('/index.html')) return createMockR2Object(SAMPLE_HTML);
      if (key.endsWith('/sitemap.xml')) return createMockR2Object(sitemapXml);
      return null;
    });

    const site = makeSite({ plan: 'free' });
    const response = await serveSiteFromR2(env as any, site, '/about-us');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`https://${DOMAINS.SITES_BASE}/app.js`);
    expect(html).toContain('data-paid="false"');
  });

  it('serves index.html for root path /', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/');

    expect(response.status).toBe(200);
    expect(env.SITES_BUCKET.get).toHaveBeenCalledWith('sites/my-site/v1/index.html');
  });

  it('constructs correct R2 path with slug and version', async () => {
    const r2Obj = createMockR2Object('data');
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ slug: 'acme-corp', current_build_version: 'v42' });
    await serveSiteFromR2(env as any, site, '/assets/logo.svg');

    expect(env.SITES_BUCKET.get).toHaveBeenCalledWith('sites/acme-corp/v42/assets/logo.svg');
  });

  it('returns building page when current_build_version is null', async () => {
    const site = makeSite({ current_build_version: null });
    const response = await serveSiteFromR2(env as any, site, '/file.txt');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Building');
    expect(html).toContain(site.slug);
    // Should NOT have queried R2 — building page is self-contained
    expect(env.SITES_BUCKET.get).not.toHaveBeenCalled();
  });

  it('sets cache-control and X-Site-Slug headers', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ slug: 'header-test', plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/page.html');

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(response.headers.get('X-Site-Slug')).toBe('header-test');
  });

  it('returns correct content type for .json files', async () => {
    const r2Obj = createMockR2Object('{"key":"value"}');
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/data.json');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('returns application/octet-stream for unknown file extensions', async () => {
    const r2Obj = createMockR2Object('binary data');
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/archive.xyz');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('injects app.js with the correct data-slug for unpaid HTML', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ slug: 'joe-pizza', plan: 'free' });
    const response = await serveSiteFromR2(env as any, site, '/index.html');

    const html = await response.text();
    // The upgrade URL (slug=…) is now built client-side inside app.js from the
    // injected data-slug; the server passes the slug via the attribute.
    expect(html).toContain('data-slug="joe-pizza"');
    expect(html).toContain(`https://${DOMAINS.SITES_BASE}/app.js`);
  });

  it('injects app.js for SPA fallback on unpaid sites', async () => {
    const indexHtml = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(indexHtml);

    const site = makeSite({ plan: 'free' });
    const response = await serveSiteFromR2(env as any, site, '/some/route');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('/app.js');
    expect(html).toContain('data-paid="false"');
  });

  // Conversion-correctness pair to the unpaid cases above: a PAID site must NOT
  // get the upgrade bar. The bar now lives in app.js gated on data-paid, so the
  // paid contract is: app.js is injected with data-paid="true" (client renders
  // no bar) and the server emits no ps-bar HTML. Locks the paid branch so a
  // regression can't start nagging paying customers.
  it('injects app.js with data-paid="true" (no bar) for a PAID site', async () => {
    const r2Obj = createMockR2Object(SAMPLE_HTML);
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(r2Obj);

    const site = makeSite({ slug: 'paid-biz', plan: 'paid' });
    const response = await serveSiteFromR2(env as any, site, '/index.html');

    const html = await response.text();
    expect(html).toContain('data-slug="paid-biz"');
    expect(html).toContain('data-paid="true"');
    expect(html).not.toContain('ps-bar-inner');
  });
});

// ─── Served-site analytics policy: GA4+GTM only, never PostHog/Sentry ─────
//
// Business-portfolio sites must never expose end users to third-party
// surveillance (PostHog) or error-tracker SDKs (Sentry). Worker-internal
// telemetry still uses POSTHOG_API_KEY, but those keys must
// never reach client HTML. PWA meta + standard favicon link tags are
// always injected so site.webmanifest icon paths resolve cleanly.
describe('serveSiteFromR2 — served-site analytics policy', () => {
  const HTML_WITH_HEAD = '<html><head><title>X</title></head><body><h1>H</h1></body></html>';

  const makeEnv = (overrides: Record<string, unknown> = {}) => ({
    CACHE_KV: createMockKV(),
    SITES_BUCKET: createMockR2(),
    DB: {} as D1Database,
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  it('NEVER injects PostHog snippet — even when POSTHOG_PUBLIC_KEY is a phc_* key', async () => {
    const env = makeEnv({
      POSTHOG_PUBLIC_KEY: 'phc_publicProjectKey123',
      POSTHOG_API_KEY: 'phc_publicProjectKey123',
    });
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).not.toContain('posthog.init');
    expect(html).not.toContain('phc_publicProjectKey123');
    expect(html).not.toContain('us.i.posthog.com');
  });

  it('NEVER leaks a personal PostHog key (phx_*) into served HTML', async () => {
    const env = makeEnv({
      POSTHOG_PUBLIC_KEY: 'phx_uEgqlh3OGKL0FPN5DEkNDQ3rVWKL73BPIdPeX9OGlwaraGk',
      POSTHOG_API_KEY: 'phx_uEgqlh3OGKL0FPN5DEkNDQ3rVWKL73BPIdPeX9OGlwaraGk',
    });
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).not.toContain('phx_');
    expect(html).not.toContain('posthog');
  });

  it('NEVER injects any third-party error-tracking snippet', async () => {
    const env = makeEnv({});
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).not.toContain('sentry-cdn.com');
    expect(html).not.toContain('Sentry.init');
    expect(html).not.toContain('abc123@o12345');
  });

  it('always injects mobile-web-app-capable + apple-mobile-web-app-capable meta tags', async () => {
    const env = makeEnv({});
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).toMatch(/<meta\s+name="mobile-web-app-capable"\s+content="yes"/);
    expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/);
  });

  it('always injects standard real-favicon-generator link tags', async () => {
    const env = makeEnv({});
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/favicon-16x16.png"');
    expect(html).toContain('href="/favicon-32x32.png"');
    expect(html).toContain('href="/android-chrome-192x192.png"');
    expect(html).toContain('href="/android-chrome-512x512.png"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('href="/site.webmanifest"');
  });

  it('still injects GA4 snippet when GA4_MEASUREMENT_ID is set', async () => {
    const env = makeEnv({ GA4_MEASUREMENT_ID: 'G-ABCDEF1234' });
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).toContain('G-ABCDEF1234');
    expect(html).toContain('googletagmanager.com/gtag/js');
  });

  it('always injects anti-FOUC snippet that gates body visibility on font load', async () => {
    const env = makeEnv({});
    (env.SITES_BUCKET.get as jest.Mock).mockResolvedValue(createMockR2Object(HTML_WITH_HEAD));

    const response = await serveSiteFromR2(env as any, makeSite({ plan: 'paid' }), '/index.html');
    const html = await response.text();

    expect(html).toContain('id="ps-anti-fouc"');
    // #40 — Speculation Rules injected before </head> for instant multi-page nav.
    expect(html).toContain('type="speculationrules"');
    expect(html).toContain('"prefetch"');
    expect(html).toMatch(/"eagerness"\s*:\s*"moderate"/);
    expect(html).toMatch(/html:not\(\.ps-fonts-ready\)\s*body\s*\{\s*opacity\s*:\s*0/);
    expect(html).toContain('document.fonts.ready');
    expect(html).toContain("classList.add('ps-fonts-ready')");
    // Perf regression guard (perf loop #14): the body-reveal safety-net must stay
    // SHORT (≤300ms) — a long net (e.g. the old 1500ms) on top of the
    // render-blocking CSS pinned the body hidden ~2.5s on 3G, the dominant FCP
    // blocker. Reveal still prefers document.fonts.ready; the net is only a backstop.
    expect(html).toContain('setTimeout(r,300)');
    expect(html).not.toContain('setTimeout(r,1500)');
  });
});
