import {
  validateAssetExistence,
  validateImageFormat,
  validateOgImage,
  validateAppleTouchIcon,
  validateMetaLengths,
  validateUniquePageTitles,
  validateJsonLdCount,
  validateH1InShell,
  validateNoDevSourceModules,
  validateColorScheme,
  validateCanonical,
  validateSitemapLastmod,
  validateSitemapRoutesExist,
  validateBannedWords,
  validateHeroNotPackDefault,
  validateJsBundleSize,
  validateLightboxPresence,
  validateThemeFontLoader,
  validateRequiredFiles,
  validateRouteCount,
  validateContactPath,
  validateImageWeightBudget,
  validateJsonLdStructure,
  validateNoBrandPlaceholders,
  validateBrandNameMatch,
  repairDoubleDotCanonical,
  repairDanglingEmDash,
  finalizeSeoInvariants,
  validateConversionFraming,
  validateBuild,
  type BuildFile,
} from '../services/build_validators';

describe('validateConversionFraming (AL-421: no full-service reservation framing on a quick-serve site)', () => {
  const shell = (h1: string, title: string) =>
    file('index.html', `<html><head><title>${title}</title></head><body><h1>${h1}</h1></body></html>`);

  it('FLAGS reservation framing on a quick-serve site (the Jeni\'s/Tartine misframe)', () => {
    const v = validateConversionFraming([
      shell('Quality ice cream shop Columbus counts on', "Jeni's Splendid Ice Creams — ice cream"),
      file('assets/index-abc.js', 'const t="Reservations welcome";const u="Book a table online";'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('conversion.reservation_on_quickserve');
    expect(v[0].severity).toBe('warn'); // report-mode, never blocks
  });

  it('does NOT flag the CORRECT quick-serve copy "no reservation needed"', () => {
    const v = validateConversionFraming([
      shell('Columbus ice cream shop', 'Ice Cream Shop'),
      file('assets/index-abc.js', 'const a="Walk right up — no reservation needed";const b="Walk-ins welcome";'),
    ]);
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a FULL-SERVICE restaurant that legitimately takes reservations (no quickserve signal)', () => {
    const v = validateConversionFraming([
      shell("Austin's steakhouse", 'Ember & Oak Steakhouse — fine dining'),
      file('assets/index-abc.js', 'const t="Reserve a table";const u="Reservations welcome";'),
    ]);
    expect(v).toHaveLength(0); // steakhouse is hospitality, reservations are correct
  });

  it('does NOT flag a quick-serve site with clean quick-serve framing', () => {
    const v = validateConversionFraming([
      shell('Columbus coffee shop', 'Bean Counter — coffee shop'),
      file('assets/index-abc.js', 'const t="Order online for pickup";const u="See our menu";'),
    ]);
    expect(v).toHaveLength(0);
  });
});

const html = (body: string, head = '') => `<!DOCTYPE html>
<html lang="en">
<head>
<title>Acme Bakery — Hand-Rolled Sourdough in Brooklyn NY</title>
<meta name="description" content="Hand-rolled sourdough, French pastries, and farm-to-table breakfasts. Order online for pickup or delivery throughout Brooklyn neighborhoods today.">
<meta name="color-scheme" content="dark light">
${head}
<script type="application/ld+json">{"@type":"WebSite"}</script>
<script type="application/ld+json">{"@type":"Organization"}</script>
<script type="application/ld+json">{"@type":"WebPage"}</script>
<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
</head>
<body>
<h1>Acme Bakery</h1>
${body}
</body>
</html>`;

const file = (path: string, text?: string, size?: number): BuildFile => ({
  path,
  text,
  size: size ?? text?.length ?? 0,
});

const completeBuild = (
  overrides: Partial<{ html: string; sitemap: string; bundleJs: string }> = {},
): BuildFile[] => [
  file('index.html', overrides.html ?? html('<img src="/hero.jpg" alt="Hero">')),
  file('hero.jpg', undefined, 50000),
  file('og-image.png', undefined, 80000),
  file('apple-touch-icon.png', undefined, 5000),
  file('favicon.ico', undefined, 1000),
  file('favicon-16x16.png', undefined, 500),
  file('favicon-32x32.png', undefined, 800),
  file('site.webmanifest', '{}'),
  file('robots.txt', 'User-agent: *'),
  file('llms.txt', '# Acme\n> AI-search directive'),
  file('humans.txt', 'Team: Acme'),
  file(
    'sitemap.xml',
    overrides.sitemap ??
      '<urlset><url><loc>https://acme.test/</loc><lastmod>2026-01-01</lastmod></url></urlset>',
  ),
  file('browserconfig.xml', '<?xml version="1.0"?><browserconfig/>'),
  file('.well-known/security.txt', 'Contact: mailto:security@acme.test'),
  file(
    'assets/index-abc.js',
    overrides.bundleJs ??
      'const x = "data-zoomable"; const y = "data-gallery"; l.id = "ps-theme-fonts";',
  ),
];

describe('validateAssetExistence', () => {
  it('flags missing internal references', () => {
    const files = [file('index.html', html('<img src="/missing.png" alt="x">'))];
    const v = validateAssetExistence(files);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('asset.missing');
  });

  it('passes when referenced files exist', () => {
    const files = [
      file('index.html', html('<img src="/hero.jpg" alt="x">')),
      file('hero.jpg', undefined, 1000),
    ];
    expect(validateAssetExistence(files)).toEqual([]);
  });

  it('warns on non-allowlisted external host', () => {
    const files = [file('index.html', html('<img src="https://evil.example/x.png" alt="x">'))];
    const v = validateAssetExistence(files);
    expect(v[0].code).toBe('asset.external_host_not_allowed');
  });

  it('allows allowlisted external hosts', () => {
    const files = [
      file('index.html', html('<img src="https://images.unsplash.com/p.jpg" alt="x">')),
    ];
    expect(validateAssetExistence(files)).toEqual([]);
  });
});

describe('validateImageFormat', () => {
  it('flags PNG > 200KB', () => {
    const v = validateImageFormat([file('hero.png', undefined, 300 * 1024)]);
    expect(v[0].code).toBe('image.png_too_large');
  });

  it('exempts favicon paths', () => {
    expect(validateImageFormat([file('apple-touch-icon.png', undefined, 300 * 1024)])).toEqual([]);
  });

  it('passes small PNGs', () => {
    expect(validateImageFormat([file('logo.png', undefined, 50 * 1024)])).toEqual([]);
  });
});

describe('validateOgImage', () => {
  it('flags missing og-image', () => {
    expect(validateOgImage([])[0].code).toBe('og.missing');
  });

  it('flags og-image > 100KB', () => {
    const v = validateOgImage([file('og-image.png', undefined, 200 * 1024)]);
    expect(v[0].code).toBe('og.too_large');
  });

  it('passes branded og-image ≤ 100KB', () => {
    expect(validateOgImage([file('og-image.png', undefined, 50 * 1024)])).toEqual([]);
  });
});

describe('validateAppleTouchIcon', () => {
  it('flags missing icon', () => {
    expect(validateAppleTouchIcon([])[0].code).toBe('icon.apple_touch_missing');
  });

  it('passes when present', () => {
    expect(validateAppleTouchIcon([file('apple-touch-icon.png', undefined, 5000)])).toEqual([]);
  });
});

describe('validateMetaLengths', () => {
  it('flags short title', () => {
    const f = [
      file(
        'index.html',
        '<!DOCTYPE html><html><head><title>Short</title><meta name="description" content="' +
          'x'.repeat(140) +
          '"></head><body></body></html>',
      ),
    ];
    const v = validateMetaLengths(f);
    expect(v.some((x) => x.code === 'meta.title_length')).toBe(true);
  });

  it('flags short description', () => {
    const f = [
      file(
        'index.html',
        '<!DOCTYPE html><html><head><title>' +
          'x'.repeat(55) +
          '</title><meta name="description" content="too short"></head><body></body></html>',
      ),
    ];
    const v = validateMetaLengths(f);
    expect(v.some((x) => x.code === 'meta.description_length')).toBe(true);
  });

  it('passes valid lengths', () => {
    expect(validateMetaLengths([file('index.html', html(''))])).toEqual([]);
  });

  it('does NOT flag a valid description whose content contains an apostrophe', () => {
    // A double-quoted content value with an apostrophe (possessive) is valid
    // HTML. The old /content=["']([^"']*)["']/ capture stopped at the FIRST
    // apostrophe OR quote — not the actual delimiter — so `content="Vito's ..."`
    // truncated to "Vito" (len 4) → a FALSE meta.description_length violation.
    // Every possessive/contraction hits this; the canonical test biz is "Vito's".
    const desc = "Vito's " + 'a'.repeat(125); // 132 chars, apostrophe at index 4, within 120-156
    expect(desc.length).toBe(132);
    const f = [
      file(
        'index.html',
        '<!DOCTYPE html><html><head><title>' +
          'x'.repeat(55) +
          `</title><meta name="description" content="${desc}"></head><body></body></html>`,
      ),
    ];
    const v = validateMetaLengths(f);
    expect(v.some((x) => x.code === 'meta.description_length')).toBe(false);
  });
});

describe('validateUniquePageTitles', () => {
  const page = (title: string, desc: string) =>
    `<!DOCTYPE html><html lang="en"><head><title>${title}</title>` +
    `<meta name="description" content="${desc}"></head><body><h1>${title}</h1></body></html>`;
  const HOME_TITLE = 'Megabyte Space — Coworking & Maker Space Phoenix AZ';
  const HOME_DESC =
    'Phoenix premier tech coworking and maker space with hot desks, private offices, 3D printers, and a builder community shipping products.';

  it('flags an ERROR when ≥2 pages share the identical <title> (homepage-title-on-every-page defect)', () => {
    const files = [
      file('index.html', page(HOME_TITLE, HOME_DESC)),
      file(
        'about.html',
        page(
          HOME_TITLE,
          'About our story — how the space grew from a garage into a maker community.',
        ),
      ),
      file(
        'services.html',
        page(
          HOME_TITLE,
          'Our services — hot desks, private offices, meeting rooms, and 24/7 fabrication access.',
        ),
      ),
    ];
    const v = validateUniquePageTitles(files);
    const dup = v.find((x) => x.code === 'meta.title_duplicate');
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('error');
    expect(dup?.message).toContain('3 pages');
    expect(dup?.file).toContain('index.html');
    expect(dup?.file).toContain('about.html');
  });

  it('flags a WARN (not error) when ≥2 pages share the identical meta description but titles differ', () => {
    const files = [
      file('index.html', page('Home — Megabyte Space Phoenix Coworking Maker', HOME_DESC)),
      file('about.html', page('About — Megabyte Space Phoenix Coworking Maker', HOME_DESC)),
    ];
    const v = validateUniquePageTitles(files);
    expect(v.find((x) => x.code === 'meta.description_duplicate')?.severity).toBe('warn');
    expect(v.find((x) => x.code === 'meta.title_duplicate')).toBeUndefined();
  });

  it('passes when every page has a unique title + description', () => {
    const files = [
      file('index.html', page('Home — Megabyte Space Phoenix Coworking', HOME_DESC)),
      file(
        'about.html',
        page(
          'About — Ten Years Building a Maker Community',
          'How the space grew from a garage into the city largest maker community. Meet the team and the mission.',
        ),
      ),
    ];
    expect(validateUniquePageTitles(files)).toEqual([]);
  });

  it('is a no-op for a single-page build (no cross-page collision possible)', () => {
    expect(validateUniquePageTitles([file('index.html', page(HOME_TITLE, HOME_DESC))])).toEqual([]);
  });

  it('normalizes case + whitespace so near-identical duplicate titles still trip', () => {
    const files = [
      file('index.html', page('Megabyte Space — Coworking', HOME_DESC)),
      file(
        'about.html',
        page(
          '  MEGABYTE   SPACE — Coworking  ',
          'A wholly different description long enough to never collide with the homepage description text.',
        ),
      ),
    ];
    expect(validateUniquePageTitles(files).some((x) => x.code === 'meta.title_duplicate')).toBe(
      true,
    );
  });
});

describe('validateJsonLdCount', () => {
  it('flags fewer than 4 blocks', () => {
    const partial =
      '<!DOCTYPE html><html><head><title>' +
      'x'.repeat(55) +
      '</title><meta name="description" content="' +
      'x'.repeat(140) +
      '"><script type="application/ld+json">{}</script></head><body><h1>x</h1></body></html>';
    const v = validateJsonLdCount([file('index.html', partial)]);
    expect(v[0].code).toBe('jsonld.count_below_threshold');
  });

  it('passes when 4+ blocks present', () => {
    expect(validateJsonLdCount([file('index.html', html(''))])).toEqual([]);
  });
});

describe('validateH1InShell', () => {
  it('flags missing h1', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><head><title>x</title></head><body><h2>nope</h2></body></html>',
    );
    expect(validateH1InShell([f])[0].code).toBe('html.h1_count');
  });

  it('flags multiple h1s', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><head><title>x</title></head><body><h1>a</h1><h1>b</h1></body></html>',
    );
    expect(validateH1InShell([f])[0].code).toBe('html.h1_count');
  });

  it('ignores h1 inside script tags', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><head><title>x</title></head><body><h1>real</h1><script>const s = "<h1>fake</h1>"</script></body></html>',
    );
    expect(validateH1InShell([f])).toEqual([]);
  });
});

describe('validateHeroNotPackDefault', () => {
  const shell = (h1: string): string =>
    `<!DOCTYPE html><html><head><title>x</title></head><body><h1>${h1}</h1></body></html>`;

  it('flags an <h1> that is the un-customized industry content-pack default (warn)', () => {
    const f = file('index.html', shell('Fresh flavors, made from scratch'));
    const v = validateHeroNotPackDefault([f]);
    expect(v[0].code).toBe('copy.generic_pack_hero');
    expect(v[0].severity).toBe('warn');
  });

  it('matches case/whitespace-insensitively (still the generic default)', () => {
    const f = file('index.html', shell('  GET STRONGER,   one session  at a time '));
    expect(validateHeroNotPackDefault([f])[0].code).toBe('copy.generic_pack_hero');
  });

  it('passes a business-specific hero (the customized happy path)', () => {
    const f = file(
      'index.html',
      shell('Harborline: small-batch harbor roasts, roasted daily in Boston'),
    );
    expect(validateHeroNotPackDefault([f])).toEqual([]);
  });
});

describe('validateNoDevSourceModules', () => {
  it('flags an unbuilt Vite index.html referencing /src/main.tsx (renders blank — the class that shipped megabytespace)', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><body><h1>Site</h1><script type="module" src="/src/main.tsx"></script></body></html>',
    );
    const v = validateNoDevSourceModules([f]);
    expect(v[0].code).toBe('html.dev_source_module');
    expect(v[0].severity).toBe('error');
    expect(v[0].detail).toBe('/src/main.tsx');
  });

  it('flags /src/main.ts and a bare /main.jsx dev entry too (browsers cannot execute TS/JSX)', () => {
    expect(
      validateNoDevSourceModules([
        file('index.html', '<script type="module" src="/src/main.ts"></script>'),
      ])[0].code,
    ).toBe('html.dev_source_module');
    expect(
      validateNoDevSourceModules([file('a.html', '<script src="/main.jsx"></script>')])[0].code,
    ).toBe('html.dev_source_module');
  });

  it('passes a correctly-built site referencing a hashed /assets/*.js bundle', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><body><h1>Site</h1><script type="module" src="/assets/index-a1b2c3.js"></script></body></html>',
    );
    expect(validateNoDevSourceModules([f])).toEqual([]);
  });

  it('ignores non-HTML files (a bundled .js may legitimately contain /src/ sourcemap refs)', () => {
    expect(
      validateNoDevSourceModules([file('assets/main-abc.js', 'import x from "/src/y.tsx";')]),
    ).toEqual([]);
  });

  it('validateBuild surfaces the dev-source-module violation as an error', () => {
    const report = validateBuild([
      file('index.html', '<script type="module" src="/src/main.tsx"></script>'),
    ]);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'html.dev_source_module')).toBe(true);
  });
});

describe('validateColorScheme', () => {
  it('warns when missing', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>',
    );
    expect(validateColorScheme([f])[0].code).toBe('meta.color_scheme_missing');
  });

  it('passes when present', () => {
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><head><meta name="color-scheme" content="dark"><title>x</title></head><body></body></html>',
    );
    expect(validateColorScheme([f])).toEqual([]);
  });

  it('passes when the color-scheme meta lists content BEFORE name (attribute order)', () => {
    // HTML attribute order is arbitrary — `<meta content="dark light" name="color-scheme">`
    // is valid + present. The old /<meta\s+name=["']color-scheme["']/ required name to
    // be the FIRST attribute → false meta.color_scheme_missing (same attribute-order
    // class as the metaDescLength apostrophe bug fixed iter 53).
    const f = file(
      'index.html',
      '<!DOCTYPE html><html><head><meta content="dark light" name="color-scheme"><title>x</title></head><body></body></html>',
    );
    expect(validateColorScheme([f])).toEqual([]);
  });
});

describe('validateSitemapLastmod', () => {
  it('flags url without lastmod', () => {
    const f = [file('sitemap.xml', '<urlset><url><loc>https://x.test/</loc></url></urlset>')];
    expect(validateSitemapLastmod(f)[0].code).toBe('sitemap.missing_lastmod');
  });

  it('flags missing sitemap', () => {
    expect(validateSitemapLastmod([])[0].code).toBe('sitemap.missing');
  });

  it('passes when every url has lastmod', () => {
    const f = [
      file(
        'sitemap.xml',
        '<urlset><url><loc>https://x.test/</loc><lastmod>2026-01-01</lastmod></url></urlset>',
      ),
    ];
    expect(validateSitemapLastmod(f)).toEqual([]);
  });
});

describe('validateSitemapRoutesExist', () => {
  const sm = (paths: string[]) =>
    `<urlset>${paths
      .map((p) => `<url><loc>https://acme.test${p}</loc><lastmod>2026-01-01</lastmod></url>`)
      .join('')}</urlset>`;

  it('flags a sitemap route with no page (SPA soft-404 → duplicate homepage content)', () => {
    const files = [
      file('sitemap.xml', sm(['/', '/about', '/services'])),
      file('index.html', '<html><title>Home</title></html>'),
      file('about.html', '<html><title>About</title></html>'),
      // NO services page → the SPA fallback serves the homepage shell at /services.
    ];
    const v = validateSitemapRoutesExist(files);
    const orphan = v.find((x) => x.code === 'sitemap.orphan_route');
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe('error');
    expect(orphan?.detail).toBe('/services');
    // The pages that DO exist are not flagged.
    expect(v.filter((x) => x.code === 'sitemap.orphan_route')).toHaveLength(1);
  });

  it('passes when every sitemap route has a page (all 3 resolution conventions)', () => {
    const files = [
      file('sitemap.xml', sm(['/', '/about', '/services/', '/blog/launch'])),
      file('index.html', '<html></html>'), //         /            → index.html
      file('about.html', '<html></html>'), //         /about        → about.html
      file('services/index.html', '<html></html>'), //  /services/  → services/index.html
      file('blog-launch.html', '<html></html>'), //   /blog/launch → flat blog-launch.html fallback
    ];
    expect(validateSitemapRoutesExist(files)).toEqual([]);
  });

  it('is a no-op when there is no sitemap (validateSitemapLastmod owns that error)', () => {
    expect(validateSitemapRoutesExist([file('index.html', '<html></html>')])).toEqual([]);
  });

  it('dedupes so a route listed twice is flagged once', () => {
    const files = [
      file('sitemap.xml', sm(['/ghost', '/ghost'])),
      file('index.html', '<html></html>'),
    ];
    expect(
      validateSitemapRoutesExist(files).filter((x) => x.code === 'sitemap.orphan_route'),
    ).toHaveLength(1);
  });
});

describe('validateBannedWords', () => {
  it('flags banned slop words', () => {
    const f = file('index.html', html('<p>Our limitless cutting-edge platform.</p>'));
    const v = validateBannedWords([f]);
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.map((x) => x.code)).toContain('copy.banned_word');
  });

  it('passes clean copy', () => {
    expect(
      validateBannedWords([file('index.html', html('<p>Hand-rolled sourdough since 1992.</p>'))]),
    ).toEqual([]);
  });
});

describe('validateJsBundleSize', () => {
  it('flags huge chunks', () => {
    const v = validateJsBundleSize([file('assets/big.js', 'x', 800 * 1024)]);
    expect(v[0].code).toBe('js.chunk_too_large');
  });

  it('passes small chunks', () => {
    expect(validateJsBundleSize([file('assets/small.js', 'x', 100 * 1024)])).toEqual([]);
  });
});

describe('validateLightboxPresence', () => {
  it('flags missing markers', () => {
    const v = validateLightboxPresence([file('assets/i.js', 'const x = 1;')]);
    expect(v.map((x) => x.code)).toEqual(
      expect.arrayContaining(['lightbox.zoomable_missing', 'lightbox.gallery_missing']),
    );
  });

  it('passes when both markers present', () => {
    const v = validateLightboxPresence([file('assets/i.js', '"data-zoomable" + "data-gallery"')]);
    expect(v).toEqual([]);
  });
});

describe('validateThemeFontLoader', () => {
  it('flags a bundle missing the theme-font loader (headings would fall back to system-ui)', () => {
    const v = validateThemeFontLoader([file('assets/i.js', 'const x = "applyBrand";')]);
    expect(v.map((x) => x.code)).toEqual(['theme.font_loader_missing']);
  });

  it('passes when the ps-theme-fonts marker ships (injectThemeFonts present)', () => {
    const v = validateThemeFontLoader([
      file('assets/i.js', 'l.id="ps-theme-fonts";l.rel="stylesheet"'),
    ]);
    expect(v).toEqual([]);
  });

  it('is a no-op when there are no JS files to inspect', () => {
    expect(validateThemeFontLoader([file('index.html', '<h1>x</h1>')])).toEqual([]);
  });
});

describe('validateRequiredFiles', () => {
  it('flags missing required files', () => {
    const v = validateRequiredFiles([file('index.html', '')]);
    expect(v.length).toBeGreaterThan(5);
    expect(v[0].code).toBe('manifest.required_file_missing');
  });

  // C.4 regression: llms.txt (the AI-search/GEO crawler directive, skill-16 §5) is a
  // build-breaking required file — a template regression dropping it must fail the build,
  // not silently de-list the site from AI crawlers.
  it('requires llms.txt (present in the full set → not flagged; absent → flagged)', () => {
    const full = validateRequiredFiles(completeBuild());
    expect(full.some((v) => v.message.includes('llms.txt'))).toBe(false);

    const withoutLlms = completeBuild().filter((f) => f.path !== 'llms.txt');
    const v = validateRequiredFiles(withoutLlms);
    expect(v.some((x) => x.message === 'Required file missing: llms.txt')).toBe(true);
  });
});

describe('validateRouteCount', () => {
  const route = (path: string) => file(path, '<html></html>');

  it('skips check for thin sources (<4 routes)', () => {
    const v = validateRouteCount([route('index.html')], 1);
    expect(v).toEqual([]);
  });

  it('flags undersized rebuild against rich source', () => {
    const v = validateRouteCount(
      [route('index.html'), route('about.html'), route('services.html'), route('contact.html')],
      80,
    );
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('route.count_below_source_count');
    expect(v[0].severity).toBe('error');
    expect(v[0].message).toContain('80');
  });

  it('passes when built count meets source count', () => {
    const files = Array.from({ length: 12 }, (_, i) => route(`page-${i}.html`));
    const v = validateRouteCount(files, 12);
    expect(v).toEqual([]);
  });

  it('clamps source count at 1000 ceiling', () => {
    const files = Array.from({ length: 1000 }, (_, i) => route(`page-${i}.html`));
    const v = validateRouteCount(files, 5000);
    expect(v).toEqual([]);
  });

  it('ignores 404/500/offline error pages', () => {
    const v = validateRouteCount(
      [
        route('index.html'),
        route('about.html'),
        route('services.html'),
        route('contact.html'),
        route('404.html'),
        route('500.html'),
        route('offline.html'),
      ],
      4,
    );
    expect(v).toEqual([]);
  });
});

describe('validateBuild (integration)', () => {
  it('passes a complete build', () => {
    const report = validateBuild(completeBuild());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('aggregates errors across gates', () => {
    const broken = completeBuild({
      html: '<!DOCTYPE html><html><head><title>too short</title><meta name="description" content="also too short"></head><body></body></html>',
      sitemap: '<urlset><url><loc>https://x.test/</loc></url></urlset>',
      bundleJs: 'const x = 1;',
    });
    const report = validateBuild(broken);
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(3);
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain('meta.title_length');
    expect(codes).toContain('meta.description_length');
    expect(codes).toContain('jsonld.count_below_threshold');
    expect(codes).toContain('html.h1_count');
    expect(codes).toContain('sitemap.missing_lastmod');
    expect(codes).toContain('lightbox.zoomable_missing');
    expect(codes).toContain('lightbox.gallery_missing');
  });
});

describe('validateCanonical — per-route self-referencing canonical (no site-wide collapse)', () => {
  it('warns when an HTML route has no <link rel="canonical">', () => {
    // The default html() helper injects no canonical.
    const out = validateCanonical([file('index.html', html('<p>Home</p>'))]);
    const codes = out.map((v) => v.code);
    expect(codes).toContain('meta.canonical_missing');
  });

  it('flags the collapse: two routes sharing one canonical (the njsk canonical=/ bug)', () => {
    const head = '<link rel="canonical" href="https://acme.projectsites.dev/">';
    const out = validateCanonical([
      file('index.html', html('<p>Home</p>', head)),
      file('about.html', html('<p>About</p>', head)),
    ]);
    const collapsed = out.filter((v) => v.code === 'meta.canonical_collapsed');
    // Both route files must be flagged, at error severity.
    expect(collapsed.length).toBe(2);
    expect(collapsed.every((v) => v.severity === 'error')).toBe(true);
  });

  it('passes when each route self-references a distinct canonical', () => {
    const out = validateCanonical([
      file(
        'index.html',
        html('<p>Home</p>', '<link rel="canonical" href="https://acme.projectsites.dev/">'),
      ),
      file(
        'about.html',
        html('<p>About</p>', '<link rel="canonical" href="https://acme.projectsites.dev/about">'),
      ),
    ]);
    expect(out.length).toBe(0);
  });

  it('does not flag collapse on a single-page site with a canonical', () => {
    const out = validateCanonical([
      file(
        'index.html',
        html('<p>Home</p>', '<link rel="canonical" href="https://acme.projectsites.dev/">'),
      ),
    ]);
    expect(out.filter((v) => v.code === 'meta.canonical_collapsed').length).toBe(0);
    expect(out.filter((v) => v.code === 'meta.canonical_missing').length).toBe(0);
  });

  it('matches rel/href in either attribute order', () => {
    const out = validateCanonical([
      file(
        'index.html',
        html('<p>Home</p>', '<link href="https://acme.projectsites.dev/" rel="canonical">'),
      ),
    ]);
    expect(out.length).toBe(0);
  });

  it('ignores non-route HTML (offline/404) in the collapse check', () => {
    const head = '<link rel="canonical" href="https://acme.projectsites.dev/">';
    const out = validateCanonical([
      file('index.html', html('<p>Home</p>', head)),
      file('offline.html', html('<p>Offline</p>', head)),
      file('404.html', html('<p>Missing</p>', head)),
    ]);
    // Only index.html is a route → no collapse, no missing.
    expect(out.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateContactPath — conversion-path integrity (fire-56, P0-REV Quality×5)
// A generated business site with NO way to contact/act converts $0 for the
// owner → the owner sees no ROI → churns. Site-level warn (report mode).
// ---------------------------------------------------------------------------
describe('validateContactPath', () => {
  it('warns when the whole site has no contact/conversion affordance', () => {
    const out = validateContactPath([
      file('index.html', html('<p>We make great bread.</p>')),
      file('about.html', html('<p>Our story since 1990.</p>')),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].code).toBe('conversion.contact_path_missing');
    expect(out[0].severity).toBe('warn');
  });

  it('passes when a tel: link exists somewhere on the site', () => {
    const out = validateContactPath([
      file('index.html', html('<p>Call us</p>')),
      file('contact.html', html('<a href="tel:+15551234567">Call</a>')),
    ]);
    expect(out.length).toBe(0);
  });

  it('passes when a mailto: link exists', () => {
    const out = validateContactPath([
      file('index.html', html('<a href="mailto:hi@acme.com">Email</a>')),
    ]);
    expect(out.length).toBe(0);
  });

  it('passes when a <form> exists (contact form)', () => {
    const out = validateContactPath([
      file('index.html', html('<form action="/api/contact"><input name="email"></form>')),
    ]);
    expect(out.length).toBe(0);
  });

  it('passes when a booking/contact link exists (calendly / /book / /contact)', () => {
    const out = validateContactPath([
      file('index.html', html('<a href="https://calendly.com/acme">Book</a>')),
    ]);
    expect(out.length).toBe(0);
  });

  it('ignores non-route shells (404/500/offline) when judging affordance presence', () => {
    // The only affordance is on a 404 shell → still counts as "site has none".
    const out = validateContactPath([
      file('index.html', html('<p>Home</p>')),
      file('404.html', html('<a href="tel:+15551234567">Call</a>')),
    ]);
    expect(out.length).toBe(1);
  });

  it('returns [] when there is no route HTML at all (nothing to judge)', () => {
    expect(validateContactPath([file('styles.css', 'body{}')])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateImageWeightBudget — per-route CWV/LCP weight (fire-57, P0-REV)
// Many individually-OK images summing to a heavy page → high LCP → lower
// conversion. Warn (report mode), per route. Budget 500KB/route.
// ---------------------------------------------------------------------------
describe('validateImageWeightBudget', () => {
  const img = (p: string, kb: number) => file(p, undefined, kb * 1024);

  it('warns when a route exceeds the 500KB image budget', () => {
    const out = validateImageWeightBudget([
      file('index.html', html('<img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg">')),
      img('a.jpg', 250),
      img('b.jpg', 250),
      img('c.jpg', 100),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].code).toBe('image.route_weight_over_budget');
    expect(out[0].severity).toBe('warn');
    expect(out[0].file).toBe('index.html');
  });

  it('passes a route within budget', () => {
    const out = validateImageWeightBudget([
      file('index.html', html('<img src="/a.jpg"><img src="/b.jpg">')),
      img('a.jpg', 150),
      img('b.jpg', 150),
    ]);
    expect(out).toEqual([]);
  });

  it('counts a repeated image only once', () => {
    const out = validateImageWeightBudget([
      file('index.html', html('<img src="/hero.jpg"><img src="/hero.jpg"><img src="/hero.jpg">')),
      img('hero.jpg', 300), // 300KB once, not 900KB
    ]);
    expect(out).toEqual([]);
  });

  it('ignores external + non-image refs', () => {
    const out = validateImageWeightBudget([
      file(
        'index.html',
        html('<img src="https://images.unsplash.com/x.jpg"><script src="/big.js"></script>'),
      ),
      img('big.js', 900), // a .js is not an image
    ]);
    expect(out).toEqual([]);
  });

  it('excludes non-route shells (404/500/offline)', () => {
    const out = validateImageWeightBudget([
      file('404.html', html('<img src="/a.jpg">')),
      img('a.jpg', 800),
    ]);
    expect(out).toEqual([]);
  });

  it('flags each over-budget route independently', () => {
    const out = validateImageWeightBudget([
      file('index.html', html('<img src="/a.jpg">')),
      file('gallery.html', html('<img src="/b.jpg">')),
      img('a.jpg', 600),
      img('b.jpg', 700),
    ]);
    expect(out.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateJsonLdStructure — structural integrity (fire-74, drift-guard)
// Counts ≠ validity: 4 empty/malformed blocks pass the count gate but fail
// Rich Results. Parse each block; require @context + @type. Warn/report-mode.
// ---------------------------------------------------------------------------
describe('validateJsonLdStructure', () => {
  const page = (blocks: string) =>
    file('index.html', `<!DOCTYPE html><html><head>${blocks}</head><body><h1>x</h1></body></html>`);
  const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

  it('passes a well-formed block (@context + @type)', () => {
    const out = validateJsonLdStructure([
      page(ld('{"@context":"https://schema.org","@type":"WebSite","name":"Acme"}')),
    ]);
    expect(out).toEqual([]);
  });

  it('flags an empty block', () => {
    const out = validateJsonLdStructure([page(ld(''))]);
    expect(out.length).toBe(1);
    expect(out[0].code).toBe('jsonld.malformed');
  });

  it('flags a malformed (non-JSON) block', () => {
    const out = validateJsonLdStructure([page(ld('{not valid json'))]);
    expect(out[0].code).toBe('jsonld.malformed');
  });

  it('flags a block missing @context', () => {
    const out = validateJsonLdStructure([page(ld('{"@type":"WebSite"}'))]);
    expect(out.some((v) => v.code === 'jsonld.missing_required_field')).toBe(true);
  });

  it('flags a block missing @type', () => {
    const out = validateJsonLdStructure([page(ld('{"@context":"https://schema.org"}'))]);
    expect(out.some((v) => v.code === 'jsonld.missing_required_field')).toBe(true);
  });

  it('accepts an @graph container where each node has @type', () => {
    const out = validateJsonLdStructure([
      page(
        ld(
          '{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Organization"}]}',
        ),
      ),
    ]);
    expect(out).toEqual([]);
  });

  it('accepts a top-level array of typed nodes', () => {
    const out = validateJsonLdStructure([
      page(ld('[{"@context":"https://schema.org","@type":"WebSite"},{"@type":"WebPage"}]')),
    ]);
    expect(out).toEqual([]);
  });

  it('ignores HTML with no JSON-LD blocks at all', () => {
    expect(validateJsonLdStructure([page('')])).toEqual([]);
  });
});

describe('validateNoBrandPlaceholders (2026-08-19 leak class)', () => {
  it('flags the template placeholder tokens as ERROR', () => {
    const files = [
      {
        path: 'index.html',
        size: 100,
        text: '<title>{BUSINESS_NAME} — {BUSINESS_TAGLINE}</title>',
      },
    ];
    const v = validateNoBrandPlaceholders(files);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => x.severity === 'error')).toBe(true);
    expect(v.some((x) => x.code === 'brand.placeholder_leak')).toBe(true);
  });

  it('flags the generic "Business" title fallback as ERROR', () => {
    const files = [
      { path: 'index.html', size: 100, text: '<title>Business — Small-Batch Bakery</title>' },
    ];
    const v = validateNoBrandPlaceholders(files);
    expect(v.some((x) => x.code === 'brand.generic_name')).toBe(true);
  });

  it('passes a real brand title clean', () => {
    const files = [
      { path: 'index.html', size: 100, text: '<title>Cedar Ridge Bakeshop — Fresh Daily</title>' },
    ];
    expect(validateNoBrandPlaceholders(files)).toEqual([]);
  });
});

describe('validateBrandNameMatch (invented-name class, 2026-08-19)', () => {
  const files = [
    {
      path: 'index.html',
      size: 100,
      text: '<title>Artisan Sourdough Bakery & Seasonal Pies | Business</title>',
    },
  ];

  it('flags a title that does NOT contain the expected business name', () => {
    const v = validateBrandNameMatch(files, 'Cedar Ridge Bakeshop');
    expect(v.some((x) => x.code === 'brand.name_mismatch')).toBe(true);
    expect(v[0].severity).toBe('error');
  });

  it('accepts a title containing the name verbatim', () => {
    const ok = validateBrandNameMatch(
      [
        {
          path: 'index.html',
          size: 100,
          text: '<title>Cedar Ridge Bakeshop — Fresh Daily</title>',
        },
      ],
      'Cedar Ridge Bakeshop',
    );
    expect(ok).toEqual([]);
  });

  it('accepts a title STARTING with the name (page-title pattern)', () => {
    const ok = validateBrandNameMatch(
      [{ path: 'menu.html', size: 100, text: '<title>Cedar Ridge Bakeshop — Menu</title>' }],
      'Cedar Ridge Bakeshop',
    );
    expect(ok).toEqual([]);
  });

  it('is a no-op without an expected name (backward compatible)', () => {
    expect(validateBrandNameMatch(files)).toEqual([]);
  });
});

describe('repairDoubleDotCanonical', () => {
  it('repairs ..projectsites.dev in canonical + OG url + inline text, preserving text', () => {
    const input: BuildFile[] = [
      {
        path: 'index.html',
        size: 200,
        text: '<link rel="canonical" href="https://urban-fitness..projectsites.dev/" />',
      },
      {
        path: 'assets/index-Bx1a.js',
        size: 300,
        text: '{"url":"https://urban-fitness..projectsites.dev/assets/hero.webp"}',
      },
      {
        path: 'sitemap.xml',
        size: 150,
        text: '<loc>https://urban-fitness..projectsites.dev/</loc>',
      },
      { path: 'favicon.png', size: 400, text: undefined },
    ];
    const [fixed, repaired] = repairDoubleDotCanonical(input);
    expect(repaired).toBe(3);
    expect(fixed[0]?.text).toBe(
      '<link rel="canonical" href="https://urban-fitness.projectsites.dev/" />',
    );
    expect(fixed[1]?.text).toContain('urban-fitness.projectsites.dev');
    expect(fixed[2]?.text).toBe('<loc>https://urban-fitness.projectsites.dev/</loc>');
    expect(fixed[3]?.text).toBeUndefined(); // binary untouched
    expect(input[0]?.text).toContain('..projectsites.dev'); // input not mutated
  });

  it('returns 0 repaired when clean', () => {
    const [, repaired] = repairDoubleDotCanonical([
      {
        path: 'index.html',
        size: 100,
        text: '<link rel="canonical" href="https://x.projectsites.dev/" />',
      },
    ]);
    expect(repaired).toBe(0);
  });
});

describe('repairDanglingEmDash', () => {
  it('collapses the dangling em-dash in <title> + <h1> when the tagline is empty', () => {
    const [fixed, n] = repairDanglingEmDash([
      {
        path: 'index.html',
        size: 200,
        text: '<title>Cedar Ridge Bakeshop — </title><h1>Cedar Ridge Bakeshop —</h1>',
      },
    ]);
    expect(n).toBe(1);
    expect(fixed[0]?.text).toBe('<title>Cedar Ridge Bakeshop</title><h1>Cedar Ridge Bakeshop</h1>');
  });

  it('leaves a REAL tagline untouched', () => {
    const [, n] = repairDanglingEmDash([
      { path: 'index.html', size: 100, text: '<title>Acme — Fresh Daily</title>' },
    ]);
    expect(n).toBe(0);
  });

  it('does not mutate the input', () => {
    const input = [{ path: 'index.html', size: 50, text: '<title>X — </title>' }];
    const [fixed] = repairDanglingEmDash(input);
    expect(fixed[0]?.text).toBe('<title>X</title>');
    expect(input[0]?.text).toBe('<title>X — </title>');
  });
});

describe('validateBrandNameMatch (short-brand sub-page titles — the SEO cap)', () => {
  const shortBrandOk = [
    {
      path: 'faq.html',
      size: 100,
      text: '<title>Cedar Ridge FAQ | Sourdough, Pies & Baking Answers</title>',
    },
    {
      path: 'pricing.html',
      size: 100,
      text: '<title>Cedar Ridge Pricing | Bakery Boxes & Subscriptions</title>',
    },
  ];

  it('accepts a sub-page title using the brand SHORT name (first word) — the SEO title cap forbids the full name everywhere', () => {
    const v = validateBrandNameMatch(shortBrandOk, 'Cedar Ridge Bakeshop');
    expect(v.filter((x) => x.code === 'brand.name_mismatch')).toEqual([]);
  });

  it('STILL flags a sub-page title with a DIFFERENT first word (invented short brand)', () => {
    const bad = [
      { path: 'faq.html', size: 100, text: '<title>Huckleberry FAQ | Baking Answers</title>' },
    ];
    const v = validateBrandNameMatch(bad, 'Cedar Ridge Bakeshop');
    expect(v.some((x) => x.code === 'brand.name_mismatch')).toBe(true);
  });

  it('STILL requires the FULL name on the homepage (index.html) — the invented-name guard stays hard there', () => {
    const bad = [
      {
        path: 'index.html',
        size: 100,
        text: '<title>Huckleberry Season at Cedar Ridge | Bakery in Bozeman</title>',
      },
    ];
    const v = validateBrandNameMatch(bad, 'Cedar Ridge Bakeshop');
    expect(v.some((x) => x.code === 'brand.name_mismatch')).toBe(true);
  });

  it('accepts the homepage title carrying the FULL name (verbatim or prefix)', () => {
    const ok = [
      {
        path: 'index.html',
        size: 100,
        text: '<title>Cedar Ridge Bakeshop | Artisan Sourdough & Pies</title>',
      },
    ];
    expect(validateBrandNameMatch(ok, 'Cedar Ridge Bakeshop')).toEqual([]);
  });
});

describe('finalizeSeoInvariants (C.1 structured-data + meta backstop)', () => {
  const ctx = {
    businessName: 'Vanta Strength Club',
    hostname: 'https://vanta-strength-austin.projectsites.dev',
  };

  // Mirrors the real prod shell (verified 2026-09-07): ZERO real JSON-LD blocks — only the
  // "open-now" widget's querySelector('script[type="application/ld+json"]') decoy string — plus
  // a sub-120-char description and a `\'` JS-string escape leaking into meta content.
  const prodLikeShell = `<!DOCTYPE html><html lang="en"><head>
<title>Vanta Strength Club — Train Hard, Get Strong</title>
<meta name="description" content="Houston\\'s dependable choice for strength training. Get stronger, one session at a time">
<meta name="color-scheme" content="dark light">
<link rel="canonical" href="https://vanta-strength-austin.projectsites.dev/">
<meta property="og:title" content="Vanta Strength Club — Train Hard, Get Strong">
<meta property="og:description" content="Houston\\'s dependable choice for strength training. Get stronger, one session at a time">
<meta property="og:url" content="https://vanta-strength-austin.projectsites.dev/">
<meta property="og:image" content="https://vanta-strength-austin.projectsites.dev/og-image.png">
<meta name="twitter:description" content="Houston\\'s dependable choice for strength training. Get stronger, one session at a time">
</head><body>
<h1>Get stronger, one session at a time</h1>
<script>(function(){var msg='it\\'s open';var blocks=document.querySelectorAll('script[type="application/ld+json"]');return msg;})();</script>
</body></html>`;

  const run = () =>
    finalizeSeoInvariants(
      [{ path: 'index.html', size: prodLikeShell.length, text: prodLikeShell }],
      ctx,
    );

  it('injects the 4 standard JSON-LD blocks when the shell has ZERO real ones (widget decoy excluded)', () => {
    const [files, report] = run();
    expect(report.jsonLdInjected).toBe(4);
    const out = files[0].text as string;
    const real = [
      ...out.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi),
    ].map((m) => JSON.parse(m[1]));
    expect(real).toHaveLength(4);
    expect(real.map((n) => n['@type']).sort()).toEqual([
      'BreadcrumbList',
      'Organization',
      'WebPage',
      'WebSite',
    ]);
    // Accurate + shell-sourced: name stripped of the tagline, real canonical origin.
    expect(real.find((n) => n['@type'] === 'Organization').name).toBe('Vanta Strength Club');
    expect(real.find((n) => n['@type'] === 'WebSite').url).toBe(
      'https://vanta-strength-austin.projectsites.dev/',
    );
  });

  it("repairs an invalid `\\'` in meta content but NEVER inside <script> bodies", () => {
    const [files, report] = run();
    const out = files[0].text as string;
    expect(report.escapesRepaired).toBeGreaterThanOrEqual(1);
    expect(out).toContain("Houston's dependable"); // meta unescaped
    expect(out).not.toContain("Houston\\'s"); // no backslash-apostrophe left in the meta
    expect(out).toContain("var msg='it\\'s open'"); // JS body left untouched
  });

  it('expands a sub-120-char description into the 120-156 window across meta/og/twitter', () => {
    const [files, report] = run();
    const out = files[0].text as string;
    expect(report.descExpanded).toBe(1);
    const desc = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(out)?.[1] ?? '';
    expect(desc.length).toBeGreaterThanOrEqual(120);
    expect(desc.length).toBeLessThanOrEqual(156);
    expect(out).toContain(`property="og:description" content="${desc}"`);
    expect(out).toContain(`name="twitter:description" content="${desc}"`);
  });

  it('is a NO-OP (same file reference) when the shell already satisfies the invariants', () => {
    const good = completeBuild()[0]; // html() ships 4 blocks + in-range title/desc
    const [files, report] = finalizeSeoInvariants([good], {
      businessName: 'Acme Bakery',
      hostname: 'https://acme.projectsites.dev',
    });
    expect(report).toEqual({
      jsonLdInjected: 0,
      escapesRepaired: 0,
      descExpanded: 0,
      titleClamped: 0,
    });
    expect(files[0]).toBe(good);
  });

  it('clamps an over-long (>60) title at a word boundary', () => {
    const longTitle =
      'Vanta Strength Club — The Absolute Best Premier Elite Strength And Conditioning Gym In Austin Texas';
    const shell = `<head><title>${longTitle}</title><meta name="description" content="A perfectly sized meta description that already sits comfortably within the required one-hundred-twenty to one-fifty-six character window for search."><script type="application/ld+json">{"@type":"WebSite"}</script><script type="application/ld+json">{"@type":"Organization"}</script><script type="application/ld+json">{"@type":"WebPage"}</script><script type="application/ld+json">{"@type":"BreadcrumbList"}</script></head><body><h1>x</h1></body>`;
    const [files, report] = finalizeSeoInvariants(
      [{ path: 'index.html', size: shell.length, text: shell }],
      ctx,
    );
    expect(report.titleClamped).toBe(1);
    const t = /<title>([^<]*)<\/title>/i.exec(files[0].text as string)?.[1] ?? '';
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.length).toBeGreaterThan(40);
  });

  it('excludes 404/500/offline shells from finalization', () => {
    const [files, report] = finalizeSeoInvariants(
      [{ path: '404.html', size: prodLikeShell.length, text: prodLikeShell }],
      ctx,
    );
    expect(report.jsonLdInjected).toBe(0);
    expect(files[0].text).toBe(prodLikeShell);
  });
});
