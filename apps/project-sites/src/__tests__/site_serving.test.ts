import {
  generateTopBar,
  serveSiteFromR2,
  asyncifyRenderBlockingFonts,
  absolutizeSocialImages,
  applyServedRouteCanonical,
  applyServedRouteTitle,
  parseSitemapRoutes,
  injectAppShellHero,
  isServedSiteCookieless,
  generateNoCookiesBadge,
  generateOpenNowBadge,
  injectSectionInstrumentation,
} from '../services/site_serving';
import type { Env } from '../types/env';
import { DOMAINS, BRAND } from '@project-sites/shared';

describe('injectSectionInstrumentation (AN26 #112)', () => {
  it('derives data-ps-section from an existing section id (semantic + sanitized)', () => {
    const out = injectSectionInstrumentation('<section id="Services">x</section>');
    expect(out).toBe('<section data-ps-section="services" id="Services">x</section>');
  });

  it('falls back to a deterministic 1-based index when no id is present', () => {
    const out = injectSectionInstrumentation('<section>a</section><section>b</section>');
    expect(out).toContain('data-ps-section="section-1"');
    expect(out).toContain('data-ps-section="section-2"');
  });

  it('is idempotent — never double-stamps an already-instrumented section', () => {
    const once = injectSectionInstrumentation('<section id="hero">h</section>');
    expect(injectSectionInstrumentation(once)).toBe(once);
  });

  it('preserves other attributes + classes on the tag', () => {
    const out = injectSectionInstrumentation('<section class="cta" id="pricing-plans">p</section>');
    expect(out).toContain('data-ps-section="pricing-plans"');
    expect(out).toContain('class="cta"');
    expect(out).toContain('id="pricing-plans"');
  });

  it('leaves non-section markup untouched', () => {
    const html = '<div id="services">x</div><p>y</p>';
    expect(injectSectionInstrumentation(html)).toBe(html);
  });
});

describe('open-now badge (#60)', () => {
  const b = generateOpenNowBadge();

  it('reads the page’s own LocalBusiness JSON-LD openingHours client-side', () => {
    expect(b).toContain('script[type="application/ld+json"]');
    expect(b).toContain('.openingHours');
  });

  it('is fail-safe — renders nothing when there are no hours OR nothing parses', () => {
    expect(b).toContain('if(!hours.length)return');
    expect(b).toContain('if(!parsed)return');
  });

  it('computes open/closed with a day-range + time-range parse and a next-open label', () => {
    expect(b).toContain('Open now');
    expect(b).toContain("'Closed · opens '");
    expect(b).toContain('var inDay='); // day-range (with wrap) check
    expect(b).toContain("el.id='ps-opennow'");
  });

  it('is print-hidden + dark-mode aware + fully try/catch-guarded', () => {
    expect(b).toContain('@media print');
    expect(b).toContain('prefers-color-scheme:dark');
    expect(b).toContain('}catch(_){}})();');
  });
});

describe('cookieless privacy badge (AN38 #129)', () => {
  const envWith = (o: Partial<Env>): Env => o as unknown as Env;

  it('isServedSiteCookieless is true when neither GA4 nor GTM is configured', () => {
    expect(isServedSiteCookieless(envWith({}))).toBe(true);
    expect(isServedSiteCookieless(undefined)).toBe(true);
  });

  it('isServedSiteCookieless is false when GA4 or GTM IS configured (those set cookies)', () => {
    expect(isServedSiteCookieless(envWith({ GA4_MEASUREMENT_ID: 'G-XXXX' }))).toBe(false);
    expect(isServedSiteCookieless(envWith({ GTM_CONTAINER_ID: 'GTM-XXXX' }))).toBe(false);
  });

  it('the badge is accessible, links to ProjectSites, and prints nothing (print + dark)', () => {
    const b = generateNoCookiesBadge();
    expect(b).toContain('No cookies · GDPR');
    expect(b).toContain('aria-label=');
    expect(b).toContain(`href="https://${DOMAINS.SITES_BASE}"`);
    expect(b).toContain('rel="noopener"');
    expect(b).toContain('@media print');
    expect(b).toContain('prefers-color-scheme:dark');
    // Sits below the free-tier conversion bar (z 99998), never above it.
    expect(b).toContain('z-index:99990');
  });
});

describe('asyncifyRenderBlockingFonts', () => {
  const GF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';

  it('makes a render-blocking Google-Fonts stylesheet non-blocking', () => {
    const out = asyncifyRenderBlockingFonts(`<link href="${GF}" rel="stylesheet">`);
    expect(out).toContain('media="print"');
    expect(out).toContain(`onload="this.media='all'"`);
    expect(out).toContain(GF);
  });

  it('handles rel before href ordering', () => {
    const out = asyncifyRenderBlockingFonts(`<link rel="stylesheet" href="${GF}">`);
    expect(out).toContain('media="print"');
  });

  it('is idempotent — does not double-apply to an already-async link', () => {
    const once = asyncifyRenderBlockingFonts(`<link href="${GF}" rel="stylesheet">`);
    const twice = asyncifyRenderBlockingFonts(once);
    expect(twice).toBe(once);
    expect((twice.match(/media="print"/g) ?? []).length).toBe(1);
  });

  it('leaves non-Google-Fonts stylesheets render-blocking', () => {
    const link = '<link href="/assets/index-abc.css" rel="stylesheet">';
    expect(asyncifyRenderBlockingFonts(link)).toBe(link);
  });

  it('leaves a Google-Fonts preconnect/preload link untouched', () => {
    const pre = `<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>`;
    expect(asyncifyRenderBlockingFonts(pre)).toBe(pre);
  });

  it('transforms every blocking font link when multiple are present', () => {
    const a = 'https://fonts.googleapis.com/css2?family=Inter&display=swap';
    const b = 'https://fonts.googleapis.com/css2?family=Space+Grotesk&display=swap';
    const out = asyncifyRenderBlockingFonts(
      `<link href="${a}" rel="stylesheet"><link href="${b}" rel="stylesheet">`,
    );
    expect((out.match(/media="print"/g) ?? []).length).toBe(2);
  });
});

// og:image MUST be absolute — Facebook/LinkedIn/Slack/Discord fetch OG tags out
// of page context and cannot resolve a root-relative content URL, so a relative
// og:image kills link previews on every generated site. The serving layer
// resolves it against the page's own og:url / canonical origin.
describe('absolutizeSocialImages', () => {
  const OGURL = '<meta property="og:url" content="https://megabyte.space/">';
  const CANON = '<link rel="canonical" href="https://megabyte.space/">';

  it('rewrites a root-relative og:image to absolute using og:url origin', () => {
    const html = `<head>${OGURL}<meta property="og:image" content="/og-image.png"></head>`;
    const out = absolutizeSocialImages(html);
    expect(out).toContain('content="https://megabyte.space/og-image.png"');
    expect(out).not.toContain('content="/og-image.png"');
  });

  it('falls back to the canonical origin when og:url is absent', () => {
    const html = `<head>${CANON}<meta property="og:image" content="/assets/og.jpg"></head>`;
    expect(absolutizeSocialImages(html)).toContain(
      'content="https://megabyte.space/assets/og.jpg"',
    );
  });

  it('also absolutizes a relative twitter:image and og:image:secure_url', () => {
    const html = `<head>${OGURL}<meta name="twitter:image" content="/t.png"><meta property="og:image:secure_url" content="/s.png"></head>`;
    const out = absolutizeSocialImages(html);
    expect(out).toContain('content="https://megabyte.space/t.png"');
    expect(out).toContain('content="https://megabyte.space/s.png"');
  });

  it('leaves an already-absolute og:image untouched', () => {
    const abs = '<meta property="og:image" content="https://cdn.example.com/x.png">';
    const html = `<head>${OGURL}${abs}</head>`;
    expect(absolutizeSocialImages(html)).toContain(abs);
  });

  it('does not touch a protocol-relative (//) image URL', () => {
    const html = `<head>${OGURL}<meta property="og:image" content="//cdn.example.com/x.png"></head>`;
    expect(absolutizeSocialImages(html)).toContain('content="//cdn.example.com/x.png"');
  });

  it('returns HTML unchanged when no og:url or canonical base exists', () => {
    const html = '<head><meta property="og:image" content="/og-image.png"></head>';
    expect(absolutizeSocialImages(html)).toBe(html);
  });

  it('handles content-before-property attribute ordering', () => {
    const html = `<head>${OGURL}<meta content="/og-image.png" property="og:image"></head>`;
    expect(absolutizeSocialImages(html)).toContain('https://megabyte.space/og-image.png');
  });
});

describe('applyServedRouteCanonical (SPA sub-page de-index fix)', () => {
  const CANON = '<link rel="canonical" href="https://megabyte.space/">';
  const OGURL = '<meta property="og:url" content="https://megabyte.space/">';

  it('rewrites a HOMEPAGE canonical + og:url to the served sub-route (was de-indexing every sub-page)', () => {
    const out = applyServedRouteCanonical(`<head>${CANON}${OGURL}</head>`, '/about');
    expect(out).toContain('<link rel="canonical" href="https://megabyte.space/about">');
    expect(out).toContain('content="https://megabyte.space/about"');
    // The homepage canonical that de-indexed the sub-page must be GONE.
    expect(out).not.toContain('href="https://megabyte.space/"');
  });

  it('leaves the HOMEPAGE (root path) canonical untouched', () => {
    const html = `<head>${CANON}${OGURL}</head>`;
    expect(applyServedRouteCanonical(html, '/')).toBe(html);
  });

  it('trailing-slash tolerant — /about/ canonicalizes to /about (no trailing slash)', () => {
    const out = applyServedRouteCanonical(`<head>${CANON}</head>`, '/about/');
    expect(out).toContain('href="https://megabyte.space/about"');
  });

  it('RESPECTS an intentional non-home canonical (per-page/syndication) — never clobbers it', () => {
    const perPage = '<link rel="canonical" href="https://megabyte.space/original-article">';
    const html = `<head>${perPage}</head>`;
    expect(applyServedRouteCanonical(html, '/blog/repost')).toBe(html);
  });

  it('derives the origin from og:url when no canonical link is present', () => {
    const out = applyServedRouteCanonical(`<head>${OGURL}</head>`, '/services');
    expect(out).toContain('content="https://megabyte.space/services"');
  });

  it('returns HTML verbatim when there is no absolute canonical/og:url to anchor to', () => {
    const html = '<head><title>x</title></head>';
    expect(applyServedRouteCanonical(html, '/about')).toBe(html);
  });

  it('preserves other attributes on the canonical + og:url tags', () => {
    const out = applyServedRouteCanonical(
      `<head><link rel="canonical" href="https://megabyte.space/" data-x="1"><meta property="og:url" content="https://megabyte.space/" data-y="2"></head>`,
      '/pricing',
    );
    expect(out).toContain('data-x="1"');
    expect(out).toContain('data-y="2"');
    expect(out).toContain('href="https://megabyte.space/pricing"');
  });
});

describe('applyServedRouteTitle (SPA per-route <title> for the non-JS crawl)', () => {
  const T = (t: string) => `<head><title>${t}</title></head>`;
  // The homepage title the SPA bakes into EVERY route's shell (& is entity-encoded).
  const HOME = 'Ironside Strength &amp; Conditioning — Train Hard, Get Strong';

  it('derives a distinct per-route title from the path segment + brand (was the homepage title on every route)', () => {
    const out = applyServedRouteTitle(T(HOME), '/services');
    expect(out).toContain('<title>Services — Ironside Strength &amp; Conditioning</title>');
  });

  it('title-cases + de-hyphenates multi-word segments', () => {
    const out = applyServedRouteTitle(T(HOME), '/case-studies');
    expect(out).toContain('<title>Case Studies — Ironside Strength &amp; Conditioning</title>');
  });

  it('uses the LAST segment for nested routes (blog posts)', () => {
    const out = applyServedRouteTitle(T(HOME), '/blog/local-seo-checklist-2026');
    expect(out).toContain(
      '<title>Local Seo Checklist 2026 — Ironside Strength &amp; Conditioning</title>',
    );
  });

  it('leaves the HOMEPAGE title untouched', () => {
    const html = T(HOME);
    expect(applyServedRouteTitle(html, '/')).toBe(html);
  });

  it('preserves an existing HTML entity in the brand (never double-encodes &amp;)', () => {
    const out = applyServedRouteTitle(T(HOME), '/team');
    expect(out).toContain('Ironside Strength &amp; Conditioning');
    expect(out).not.toContain('&amp;amp;');
  });

  it('mirrors the title’s own separator (pipe)', () => {
    const out = applyServedRouteTitle(T('Acme Co | Widgets'), '/about');
    expect(out).toContain('<title>About | Acme Co</title>');
  });

  // A 404 (unknown route) must NOT reflect the arbitrary URL slug as the page title —
  // `/buy-cheap-widgets-spam` → "Buy Cheap Widgets Spam — Brand" is a reflected-content
  // smell + a broken 404. With isNotFound, the title is a fixed "Page not found — {brand}".
  it('on a 404 route, emits "Page not found — {brand}" — NEVER the reflected URL slug', () => {
    const out = applyServedRouteTitle(T(HOME), '/buy-cheap-widgets-spam', true);
    expect(out).toContain('<title>Page not found — Ironside Strength &amp; Conditioning</title>');
    expect(out).not.toContain('Buy Cheap Widgets Spam');
  });

  it('the 404 not-found title also flows to og:title / twitter:title (no reflected slug in social meta)', () => {
    const html =
      `<head><title>${HOME}</title>` +
      `<meta property="og:title" content="${HOME}">` +
      `<meta name="twitter:title" content="${HOME}"></head>`;
    const out = applyServedRouteTitle(html, '/spam-slug-xyz', true);
    expect(out).toContain('content="Page not found — Ironside Strength &amp; Conditioning"');
    expect(out).not.toContain('Spam Slug Xyz');
  });

  it('a KNOWN route (isNotFound=false, default) still title-cases its segment — no regression', () => {
    expect(applyServedRouteTitle(T(HOME), '/services')).toContain('<title>Services — Ironside Strength &amp; Conditioning</title>');
  });

  it('falls back to the whole title as brand when there is no separator', () => {
    const out = applyServedRouteTitle(T('Acme Co'), '/pricing');
    expect(out).toContain('<title>Pricing — Acme Co</title>');
  });

  it('returns HTML verbatim when there is no <title>', () => {
    const html = '<head><meta charset="utf-8"></head>';
    expect(applyServedRouteTitle(html, '/about')).toBe(html);
  });

  it('trailing-slash tolerant', () => {
    const out = applyServedRouteTitle(T(HOME), '/services/');
    expect(out).toContain('<title>Services — Ironside Strength &amp; Conditioning</title>');
  });

  const HEAD = (t: string) =>
    `<head><title>${t}</title><meta property="og:title" content="${t}"><meta name="twitter:title" content="${t}"></head>`;

  it('mirrors the derived title to og:title + twitter:title (fixes homepage social title on sub-pages)', () => {
    const out = applyServedRouteTitle(HEAD(HOME), '/services');
    expect(out).toContain(
      '<meta property="og:title" content="Services — Ironside Strength &amp; Conditioning">',
    );
    expect(out).toContain(
      '<meta name="twitter:title" content="Services — Ironside Strength &amp; Conditioning">',
    );
  });

  it('respects a deliberate per-page og:title (only rewrites the baked homepage value)', () => {
    const html = `<head><title>${HOME}</title><meta property="og:title" content="Bespoke Services OG"></head>`;
    const out = applyServedRouteTitle(html, '/services');
    expect(out).toContain('content="Bespoke Services OG"');
    expect(out).not.toContain('content="Services — Ironside');
  });

  it('tolerates content-before-property attribute order', () => {
    const html = `<head><title>${HOME}</title><meta content="${HOME}" property="og:title"></head>`;
    const out = applyServedRouteTitle(html, '/team');
    expect(out).toContain('Team — Ironside Strength &amp; Conditioning');
  });
});

describe('parseSitemapRoutes', () => {
  it('extracts normalized pathnames from <loc> entries', () => {
    const xml = `<urlset>
      <url><loc>https://x.com/</loc></url>
      <url><loc>https://x.com/about</loc></url>
      <url><loc>https://x.com/blog/post-1</loc></url>
    </urlset>`;
    const routes = parseSitemapRoutes(xml);
    expect(routes.has('/')).toBe(true);
    expect(routes.has('/about')).toBe(true);
    expect(routes.has('/blog/post-1')).toBe(true);
    expect(routes.size).toBe(3);
  });

  it('normalizes trailing slashes (except root)', () => {
    const routes = parseSitemapRoutes('<loc>https://x.com/services/</loc>');
    expect(routes.has('/services')).toBe(true);
    expect(routes.has('/services/')).toBe(false);
  });

  it('returns an empty set for XML with no <loc> entries', () => {
    expect(parseSitemapRoutes('<urlset></urlset>').size).toBe(0);
  });

  it('ignores malformed loc values without throwing', () => {
    const routes = parseSitemapRoutes('<loc>not a url</loc><loc>https://x.com/ok</loc>');
    expect(routes.has('/ok')).toBe(true);
  });
});

describe('generateTopBar', () => {
  it('generates valid HTML with CTA', () => {
    // generateTopBar delegates to generateConversionFlow; the CTA copy is
    // "Register Now" + a "$50" price (was "Claim"/"$50/mo" before the
    // Conversion-Flow-v2 rename in 586b4169c).
    const html = generateTopBar('my-biz');
    expect(html).toContain('ps-bar');
    expect(html).toContain('Register Now');
    expect(html).toContain('$50');
  });

  it('includes edit link with slug', () => {
    const html = generateTopBar('joe-pizza');
    expect(html).toContain('slug=joe-pizza');
  });

  it('includes a dismiss button', () => {
    const html = generateTopBar('test');
    expect(html).toContain('&times;');
    expect(html).toContain('Dismiss');
  });

  it('has bar inner layout', () => {
    const html = generateTopBar('test');
    expect(html).toContain('ps-bar-inner');
  });

  it('links to the main domain', () => {
    const html = generateTopBar('test');
    expect(html).toContain(`https://${DOMAINS.SITES_BASE}`);
  });

  it('shows a viewer "Build your own" CTA with preview attribution (S24)', () => {
    const html = generateTopBar('test');
    // The brand backlink doubles as an anonymous-viewer "build your own" CTA.
    expect(html).toContain('Build your own');
    expect(html).toContain(`https://${DOMAINS.SITES_BASE}/?ref=preview`);
    expect(html).toContain('aria-label="Build your own free site on ProjectSites"');
    expect(html).toContain('id="ps-bar-build"');
  });

  it('encodes slug in URL parameters to prevent XSS', () => {
    const html = generateTopBar('a"onmouseover="alert(1)');
    // The slug is encoded in the edit URL query parameter
    expect(html).toContain(encodeURIComponent('a"onmouseover="alert(1)'));
  });

  it('has correct z-index for overlay', () => {
    const html = generateTopBar('test');
    expect(html).toContain('z-index:99998');
  });

  it('is wrapped in HTML comments for identification', () => {
    const html = generateTopBar('test');
    expect(html).toContain('<!-- ProjectSites Conversion Flow v2 -->');
    expect(html).toContain('<!-- End ProjectSites Conversion Flow -->');
  });

  it('generates non-empty HTML for various slugs', () => {
    const slugs = ['a-b-c', 'my-business-123', 'test'];
    for (const slug of slugs) {
      const html = generateTopBar(slug);
      expect(html.length).toBeGreaterThan(100);
    }
  });

  it('uses fixed positioning at bottom', () => {
    const html = generateTopBar('test');
    expect(html).toContain('position:fixed');
    expect(html).toContain('bottom:0');
  });
});

// The ownership modal is the revenue-critical upgrade path injected into EVERY
// free/branch-preview site. It shipped as a <div> soup with no dialog semantics,
// no Escape-to-close, and no focus management — a real a11y/UX defect (WCAG 2.1.2
// keyboard, 2.4.3 focus order, 4.1.2 name/role/value) on every visitor's screen.
describe('generateTopBar — ownership modal accessibility', () => {
  it('marks the modal as an accessible dialog (role + aria-modal + labelledby)', () => {
    const html = generateTopBar('test');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // aria-labelledby must point at a real element id in the same markup.
    expect(html).toContain('aria-labelledby="ps-modal-title"');
    expect(html).toContain('id="ps-modal-title"');
  });

  it('advertises the dialog on the trigger button (aria-haspopup)', () => {
    const html = generateTopBar('test');
    expect(html).toMatch(
      /id="ps-claim-btn"[^>]*aria-haspopup="dialog"|aria-haspopup="dialog"[^>]*id="ps-claim-btn"/,
    );
  });

  it('closes on the Escape key (keyboard-dismissible, not mouse-only)', () => {
    const html = generateTopBar('test');
    expect(html).toContain("addEventListener('keydown'");
    expect(html).toMatch(/key===['"]Escape['"]/);
  });

  it('manages focus — captures the trigger on open and restores it on close', () => {
    const html = generateTopBar('test');
    // Trigger element captured so focus can return to it after close.
    expect(html).toContain('document.activeElement');
    // Focus is moved (into the modal on open, back to trigger on close).
    expect(html).toContain('.focus()');
  });

  it('traps Tab within the modal (no focus escape to the page behind)', () => {
    const html = generateTopBar('test');
    // A Tab handler that cycles first<->last focusable inside the modal.
    expect(html).toMatch(/key===['"]Tab['"]/);
    expect(html).toContain('shiftKey');
  });

  it('the injected conversion-flow script is syntactically valid JS (parse gate)', () => {
    // String-presence tests can pass while the injected IIFE has a syntax error that
    // silently breaks the ENTIRE modal at runtime. new Function() parses (does not run)
    // the script body and throws SyntaxError on any unbalanced brace / bad token.
    const html = generateTopBar('test');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) {
      expect(() => new Function(body)).not.toThrow();
    }
  });
});

describe('serveSiteFromR2', () => {
  function createMockEnv(files: Record<string, string> = {}, opts: { status?: string } = {}) {
    return {
      SITES_BUCKET: {
        get: jest.fn(async (key: string) => {
          const content = files[key];
          if (!content) return null;
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(content));
              controller.close();
            },
          });
          return {
            body: stream,
            text: async () => content,
            key,
            httpMetadata: { contentType: 'text/html' },
            size: content.length,
          };
        }),
      },
      CACHE_KV: {
        get: jest.fn(async () => null),
        put: jest.fn(async () => {}),
        delete: jest.fn(async () => {}),
      },
      // DB stub for the version-less fallback's status read (dbQueryOne →
      // prepare→bind→all→{results}). Only wired when a test provides `status`;
      // otherwise DB is absent and the fallback safely defaults to "building".
      ...(opts.status !== undefined
        ? {
            DB: {
              prepare: () => ({
                bind: () => ({ all: async () => ({ results: [{ status: opts.status }] }) }),
              }),
            },
          }
        : {}),
    } as unknown as import('../types/env').Env;
  }

  const baseSite = {
    site_id: 'test-id',
    slug: 'my-biz',
    current_build_version: 'v1',
    plan: 'free',
  };

  it('returns text/html Content-Type for root path /', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Hello</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('does NOT download root path as application/octet-stream', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Test</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/');
    expect(response.headers.get('Content-Type')).not.toBe('application/octet-stream');
  });

  it('returns text/css for .css files', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/style.css': 'body { color: red; }',
    });

    const response = await serveSiteFromR2(env, baseSite, '/style.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/css');
  });

  it('returns application/javascript for .js files', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/app.js': 'console.log("hello")',
    });

    const response = await serveSiteFromR2(env, baseSite, '/app.js');
    expect(response.headers.get('Content-Type')).toBe('application/javascript');
  });

  it('returns 404 for non-existent files', async () => {
    const env = createMockEnv({});

    const response = await serveSiteFromR2(env, baseSite, '/missing.txt');
    expect(response.status).toBe(404);
  });

  it('falls back to index.html for extensionless SPA routes', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>SPA</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/about');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  // ── Soft-404 guard: SPA fallback returns 404 for paths not in the sitemap ──
  // Generated sites are pure SPAs — the SAME index.html is served for every
  // extensionless path. Without this, junk URLs return 200 and get indexed.
  describe('soft-404 (SPA fallback status from sitemap)', () => {
    const SITEMAP = `<?xml version="1.0"?><urlset>
      <url><loc>https://my-biz.example/</loc></url>
      <url><loc>https://my-biz.example/about</loc></url>
      <url><loc>https://my-biz.example/services</loc></url>
    </urlset>`;

    it('returns 404 for an extensionless path NOT in the sitemap (still serves the shell)', async () => {
      const env = createMockEnv({
        'sites/my-biz/v1/index.html': '<html><body>SPA</body></html>',
        'sites/my-biz/v1/sitemap.xml': SITEMAP,
      });
      const response = await serveSiteFromR2(env, baseSite, '/this-does-not-exist-xyz');
      expect(response.status).toBe(404);
      // shell still served so the SPA's own 404 view can render
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toContain('SPA');
    });

    it('returns 200 for a real route that IS in the sitemap', async () => {
      const env = createMockEnv({
        'sites/my-biz/v1/index.html': '<html><body>SPA</body></html>',
        'sites/my-biz/v1/sitemap.xml': SITEMAP,
      });
      const response = await serveSiteFromR2(env, baseSite, '/about');
      expect(response.status).toBe(200);
    });

    it('matches a sitemap route regardless of trailing slash', async () => {
      const env = createMockEnv({
        'sites/my-biz/v1/index.html': '<html><body>SPA</body></html>',
        'sites/my-biz/v1/sitemap.xml': SITEMAP,
      });
      const response = await serveSiteFromR2(env, baseSite, '/services/');
      expect(response.status).toBe(200);
    });

    it('fails OPEN (200) when the site has no sitemap — never wrongly 404 a real route', async () => {
      const env = createMockEnv({
        'sites/my-biz/v1/index.html': '<html><body>SPA</body></html>',
      });
      const response = await serveSiteFromR2(env, baseSite, '/anything');
      expect(response.status).toBe(200);
    });
  });

  // The upgrade bar moved into the unified client script (`/app.js`), gated on
  // the injected data-paid attribute. Free → app.js injected with
  // data-paid="false" (client renders the bar); paid → data-paid="true" (no bar).
  // The server no longer emits the ps-bar conversion-flow HTML for either plan.
  it('injects app.js with data-paid="false" for free plan HTML', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Content</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/');
    const html = await response.text();
    expect(html).toContain('/app.js');
    expect(html).toContain('data-paid="false"');
    expect(html).not.toContain('ps-bar-inner');
  });

  it('injects app.js with data-paid="true" (no bar) for paid plan HTML', async () => {
    const paidSite = { ...baseSite, plan: 'paid' };
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Content</body></html>',
    });

    const response = await serveSiteFromR2(env, paidSite, '/');
    const body = await response.text();
    expect(body).toContain('/app.js');
    expect(body).toContain('data-paid="true"');
    expect(body).not.toContain('ps-bar-inner');
  });

  // ── Building placeholder (no build artifact yet) — MUST NOT be indexed ──
  // A site with current_build_version === null serves a branded "Building..."
  // page for its entire ~40-min build window. Without noindex, Googlebot
  // crawling that window indexes "Building your website" as the site's content.
  describe('building placeholder (current_build_version === null)', () => {
    const buildingSite = { ...baseSite, current_build_version: null };
    // A genuinely IN-PROGRESS build (status generating/building/…) → the "Building…"
    // page with auto-refresh. (DB absent also defaults here — safe.)
    const inProgress = () => createMockEnv({}, { status: 'generating' });

    it('serves the branded building page with a 200 (keeps the auto-refresh UX)', async () => {
      const response = await serveSiteFromR2(inProgress(), buildingSite, '/');
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html;charset=utf-8');
      expect(await response.text()).toContain('Building your website');
    });

    it('carries a robots noindex meta tag so the placeholder is never indexed', async () => {
      const response = await serveSiteFromR2(inProgress(), buildingSite, '/');
      const html = await response.text();
      expect(html).toMatch(/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i);
    });

    it('carries an X-Robots-Tag: noindex response header (belt-and-suspenders)', async () => {
      const response = await serveSiteFromR2(inProgress(), buildingSite, '/');
      expect(response.headers.get('X-Robots-Tag')).toMatch(/noindex/i);
    });

    it('DB read failing (no DB) still defaults to the Building page (fail-soft)', async () => {
      const response = await serveSiteFromR2(createMockEnv({}), buildingSite, '/');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Building your website');
    });
  });

  // ── Terminal-but-no-content: a FAILED build (status='error') or a published site
  // whose R2 content is missing must NOT loop "Building your website… auto-refreshes
  // every 15s" forever — that misleads the visitor into thinking it's still working.
  // Show an honest "not available" page (noindex, no infinite refresh) instead.
  describe('terminal state without content (status-aware fallback)', () => {
    const versionless = { ...baseSite, current_build_version: null };

    it("status='error' (build failed) → honest error page, NOT 'Building your website'", async () => {
      const response = await serveSiteFromR2(
        createMockEnv({}, { status: 'error' }),
        versionless,
        '/',
      );
      const html = await response.text();
      expect(html).not.toContain('Building your website');
      expect(html).toMatch(/not available|didn't finish|couldn.t be|went wrong|try again/i);
    });

    it("status='error' page is noindex and does NOT auto-refresh forever", async () => {
      const response = await serveSiteFromR2(
        createMockEnv({}, { status: 'error' }),
        versionless,
        '/',
      );
      const html = await response.text();
      expect(response.headers.get('X-Robots-Tag')).toMatch(/noindex/i);
      expect(html).not.toMatch(/http-equiv=["']refresh["']/i); // no infinite 15s reload loop
    });

    it("status='published' but no version (inconsistent) → error page, NOT 'Building'", async () => {
      const response = await serveSiteFromR2(
        createMockEnv({}, { status: 'published' }),
        versionless,
        '/',
      );
      expect(await response.text()).not.toContain('Building your website');
    });
  });

  it('blocks access to _meta/ paths', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/_meta/chat.json': '{}',
    });

    const response = await serveSiteFromR2(env, baseSite, '/_meta/chat.json');
    expect(response.status).toBe(404);
  });

  it('blocks access to _manifest.json', async () => {
    const env = createMockEnv({});

    const response = await serveSiteFromR2(env, baseSite, '/_manifest.json');
    expect(response.status).toBe(404);
  });

  it('sets caching headers', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Cached</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/');
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(response.headers.get('X-Site-Slug')).toBe('my-biz');
  });
});

describe('injectAppShellHero', () => {
  const ROOT = '<div id="root"></div>';
  const page = (head: string, body = ROOT) =>
    `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;

  it('injects a static hero into an empty #root from og:title + description', () => {
    const out = injectAppShellHero(
      page(
        '<meta property="og:title" content="Where Makers Build the Future"><meta name="description" content="We ship gorgeous software.">',
      ),
    );
    expect(out).toContain('data-app-shell="hero"');
    expect(out).toContain('<h1');
    expect(out).toContain('Where Makers Build the Future');
    expect(out).toContain('We ship gorgeous software.');
    // root is no longer empty
    expect(out).not.toContain('<div id="root"></div>');
  });

  it('falls back to <title> first segment when og:title is absent', () => {
    const out = injectAppShellHero(page('<title>Acme Bakery | Fresh bread daily</title>'));
    expect(out).toContain('>Acme Bakery</h1>');
    expect(out).not.toContain('Fresh bread daily</h1>'); // brand tail stripped
  });

  it('drives background from theme-color and picks readable text (light theme → dark text)', () => {
    const out = injectAppShellHero(
      page('<meta name="theme-color" content="#ffffff"><title>Lone Mountain</title>'),
    );
    expect(out).toContain('background:#ffffff');
    expect(out).toContain('color:#0b0b0f'); // dark text on a light theme
  });

  it('uses light text on a dark theme-color', () => {
    const out = injectAppShellHero(
      page('<meta name="theme-color" content="#0a0a0f"><title>Night Co</title>'),
    );
    expect(out).toContain('color:#f5f5f7');
  });

  it('rejects a non-hex theme-color (style-injection guard) and uses the default bg', () => {
    const out = injectAppShellHero(
      page('<meta name="theme-color" content="red;}body{display:none"><title>Evil</title>'),
    );
    expect(out).toContain('background:#0a0a0f');
    // The raw value never reaches the injected hero's style (only the inert head meta keeps it).
    expect(out).not.toContain('background:red');
  });

  it('escapes HTML in the headline (XSS guard)', () => {
    const out = injectAppShellHero(page('<title>&lt;img src=x onerror=alert(1)&gt; Co</title>'));
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt; Co');
  });

  it('is a no-op when #root already has content', () => {
    const populated = page(
      '<title>Has Content</title>',
      '<div id="root"><nav>real app</nav></div>',
    );
    expect(injectAppShellHero(populated)).toBe(populated);
  });

  it('is a no-op when there is no #root', () => {
    const noRoot =
      '<!DOCTYPE html><html><head><title>X</title></head><body><main>static</main></body></html>';
    expect(injectAppShellHero(noRoot)).toBe(noRoot);
  });

  it('is a no-op when no headline can be derived', () => {
    const out = injectAppShellHero('<html><head></head><body><div id="root"></div></body></html>');
    expect(out).toContain('<div id="root"></div>'); // unchanged
  });
});
