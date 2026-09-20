import {
  buildBaselineJsonLd,
  applyServedRouteJsonLd,
  upgradeLocalBusinessType,
} from '../services/site_serving.js';

/** Parse the JSON bodies out of the concatenated <script type=ld+json> tags. */
function parseBlocks(htmlOrFragment: string): Array<Record<string, unknown>> {
  const bodies =
    htmlOrFragment.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ||
    [];
  return bodies
    .map((tag) =>
      tag
        .replace(/<script[^>]*>/i, '')
        .replace(/<\/script>/i, '')
        .trim(),
    )
    .filter((body) => body.length > 0) // skip the empty "decoy" reader tag
    .map((body) => JSON.parse(body));
}

describe('site_serving — buildBaselineJsonLd', () => {
  it('emits 4 separate, valid JSON-LD blocks for a sub-route', () => {
    const frag = buildBaselineJsonLd('Acme Gym', 'https://acme.projectsites.dev', '/about');
    const blocks = parseBlocks(frag);
    expect(blocks).toHaveLength(4);
    const byType = Object.fromEntries(blocks.map((b) => [b['@type'], b]));
    expect(Object.keys(byType).sort()).toEqual([
      'BreadcrumbList',
      'Organization',
      'WebPage',
      'WebSite',
    ]);
    expect(byType.WebSite.url).toBe('https://acme.projectsites.dev/');
    expect(byType.WebPage.url).toBe('https://acme.projectsites.dev/about');
    expect(byType.WebPage.name).toBe('About — Acme Gym');
    expect((byType.WebPage.isPartOf as Record<string, unknown>).url).toBe(
      'https://acme.projectsites.dev/',
    );
    const crumbs = byType.BreadcrumbList.itemListElement as Array<Record<string, unknown>>;
    expect(crumbs.map((c) => c.name)).toEqual(['Home', 'About']);
    expect(crumbs[1].item).toBe('https://acme.projectsites.dev/about');
    for (const b of blocks) expect(b['@context']).toBe('https://schema.org');
  });

  it('homepage: WebPage name = brand, single Home breadcrumb', () => {
    const blocks = parseBlocks(
      buildBaselineJsonLd('Acme Gym', 'https://acme.projectsites.dev', '/'),
    );
    const wp = blocks.find((b) => b['@type'] === 'WebPage')!;
    expect(wp.name).toBe('Acme Gym');
    expect(wp.url).toBe('https://acme.projectsites.dev/');
    const bl = blocks.find((b) => b['@type'] === 'BreadcrumbList')!;
    expect(bl.itemListElement as unknown[]).toHaveLength(1);
  });

  it('nested route → multi-level breadcrumb', () => {
    const blocks = parseBlocks(
      buildBaselineJsonLd('Acme', 'https://a.dev', '/services/personal-training'),
    );
    const bl = blocks.find((b) => b['@type'] === 'BreadcrumbList')!;
    const crumbs = bl.itemListElement as Array<Record<string, unknown>>;
    expect(crumbs.map((c) => c.name)).toEqual(['Home', 'Services', 'Personal Training']);
    expect(crumbs[2].item).toBe('https://a.dev/services/personal-training');
  });

  it('brand with & / quotes stays valid JSON (injection-safe)', () => {
    const blocks = parseBlocks(buildBaselineJsonLd('Ember & Oak "Co"', 'https://e.dev', '/'));
    expect(blocks.find((b) => b['@type'] === 'WebSite')!.name).toBe('Ember & Oak "Co"');
  });
});

describe('site_serving — applyServedRouteJsonLd', () => {
  const shell = (extraHead = '') =>
    `<html><head><title>Acme Gym — Train Hard</title><link rel="canonical" href="https://acme.projectsites.dev/">${extraHead}</head><body>x</body></html>`;

  it('injects 4 blocks when the shell has NO real JSON-LD (only the empty decoy)', () => {
    const out = applyServedRouteJsonLd(
      shell('<script type="application/ld+json"></script>'),
      '/about',
    );
    const blocks = parseBlocks(out);
    expect(blocks.filter((b) => b['@type']).length).toBe(4);
    expect(blocks.find((b) => b['@type'] === 'WebPage')!.url).toBe(
      'https://acme.projectsites.dev/about',
    );
    // brand recovered from the PRISTINE homepage title (pre-separator)
    expect(blocks.find((b) => b['@type'] === 'WebSite')!.name).toBe('Acme Gym');
  });

  // A rebuilt site's build-time JSON-LD: route-agnostic WebSite + Organization, plus a
  // HOMEPAGE-baked WebPage + BreadcrumbList (the single-shell SPA clobber).
  const buildTimeShell = (path = '') =>
    shell(
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Acme Gym","url":"https://acme.projectsites.dev/"}</script>' +
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Gym","url":"https://acme.projectsites.dev/"}</script>' +
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Acme Gym — Home","url":"https://acme.projectsites.dev/"}</script>' +
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://acme.projectsites.dev/"}]}</script>' +
        path,
    );

  it('SUB-ROUTE de-clobbers a homepage-baked WebPage/BreadcrumbList → per-route (keeps WebSite+Org)', () => {
    const out = applyServedRouteJsonLd(buildTimeShell(), '/about');
    const blocks = parseBlocks(out);
    // exactly ONE WebPage, now pointing at the SERVED route (not the homepage)
    const webpages = blocks.filter((b) => b['@type'] === 'WebPage');
    expect(webpages).toHaveLength(1);
    expect(webpages[0].url).toBe('https://acme.projectsites.dev/about');
    // breadcrumb now Home › About (not just Home)
    const bl = blocks.find((b) => b['@type'] === 'BreadcrumbList')!;
    expect((bl.itemListElement as Array<Record<string, unknown>>).map((c) => c.name)).toEqual([
      'Home',
      'About',
    ]);
    // route-agnostic blocks preserved (not duplicated)
    expect(blocks.filter((b) => b['@type'] === 'WebSite')).toHaveLength(1);
    expect(blocks.filter((b) => b['@type'] === 'Organization')).toHaveLength(1);
  });

  it('HOMEPAGE with build-time JSON-LD is a NO-OP (its WebPage/Bc are already correct)', () => {
    const h = buildTimeShell();
    expect(applyServedRouteJsonLd(h, '/')).toBe(h);
  });

  it('no-op without a canonical/og:url origin to anchor absolute URLs', () => {
    const noCanon = '<html><head><title>Acme — X</title></head><body>x</body></html>';
    expect(applyServedRouteJsonLd(noCanon, '/about')).toBe(noCanon);
  });
});

describe('site_serving — upgradeLocalBusinessType (serve-time subtype, AL-841)', () => {
  const lb =
    '<script type="application/ld+json">{"@type":"LocalBusiness","name":"Strand"}</script>';

  it('upgrades a generic LocalBusiness to its schema.org subtype from business_category', () => {
    expect(upgradeLocalBusinessType(lb, 'bookstore')).toContain('"@type":"BookStore"');
    expect(upgradeLocalBusinessType(lb, 'bookstore')).not.toContain('"@type":"LocalBusiness"');
  });

  it('maps several real categories to their subtypes', () => {
    expect(upgradeLocalBusinessType(lb, 'italian restaurant')).toContain('"@type":"Restaurant"');
    expect(upgradeLocalBusinessType(lb, 'flower shop')).toContain('"@type":"Florist"');
    expect(upgradeLocalBusinessType(lb, 'jewelry store')).toContain('"@type":"JewelryStore"');
  });

  it('no-op when the category has no more-specific subtype (stays generic LocalBusiness)', () => {
    expect(upgradeLocalBusinessType(lb, 'consulting')).toBe(lb);
  });

  it('no-op on a null/empty category', () => {
    expect(upgradeLocalBusinessType(lb, null)).toBe(lb);
    expect(upgradeLocalBusinessType(lb, '')).toBe(lb);
  });

  it('no-op when there is no generic LocalBusiness literal (non-local site or already subtyped)', () => {
    const already = '<script>{"@type":"Restaurant","name":"x"}</script>';
    expect(upgradeLocalBusinessType(already, 'restaurant')).toBe(already);
    const saas = '<script>{"@type":"WebSite","name":"x"}</script>';
    expect(upgradeLocalBusinessType(saas, 'bookstore')).toBe(saas);
  });

  it('never touches sibling @type literals (PostalAddress/WebSite stay)', () => {
    const mixed = '<script>{"@type":"LocalBusiness","address":{"@type":"PostalAddress"}}</script>';
    const out = upgradeLocalBusinessType(mixed, 'bookstore');
    expect(out).toContain('"@type":"BookStore"');
    expect(out).toContain('"@type":"PostalAddress"');
  });

  it('handles a space after the colon ("@type": "LocalBusiness")', () => {
    const spaced = '<script>{"@type": "LocalBusiness","name":"x"}</script>';
    expect(upgradeLocalBusinessType(spaced, 'bookstore')).toContain('"BookStore"');
  });
});
