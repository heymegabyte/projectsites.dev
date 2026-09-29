/**
 * Lane 7 regression — the synthetic KNOWN-GOOD build fixture passes all 30 build validators.
 *
 * This is the "safe to flip strict" proof: a clean, complete build (the shape the
 * false-positive audit harness — `scripts/audit-validator-false-positives.mjs` — audits)
 * must produce ZERO blocking (error-severity) violations, so `validateBuild(goodBuild).ok`
 * is `true`. If a future validator change starts rejecting a legitimately-complete build,
 * this test goes RED before any org is flipped to `validator_strict`.
 *
 * The fixture lives on disk at `scripts/__fixtures__/known-good-build/` so BOTH this test
 * AND the offline `--fixture` mode of the harness exercise the exact same files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  validateBuild,
  validateMetaLengths,
  validateJsonLdCount,
  validateIndexable,
  validateImageFormat,
  validateSitemapRoutesExist,
  type BuildFile,
} from '../services/build_validators';

// Mirror build_validators.ts isText() — decode the same text set the R2 loader decodes;
// binaries carry only their byte size.
const TEXT_EXTENSIONS = [
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.xml',
  '.txt',
  '.svg',
  '.webmanifest',
];
const isTextPath = (p: string): boolean => TEXT_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e));

const FIXTURE_DIR = join(__dirname, '..', '..', 'scripts', '__fixtures__', 'known-good-build');

/** Recursively load a fixture dir into BuildFile[] (path dist-relative + /-normalized). */
function loadFixture(dir: string): BuildFile[] {
  const files: BuildFile[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, abs).split(sep).join('/');
      const size = statSync(abs).size;
      const text = isTextPath(rel) ? readFileSync(abs, 'utf8') : undefined;
      files.push({ path: rel, text, size });
    }
  };
  walk(dir);
  return files;
}

describe('known-good build fixture (Lane 7: strict-flip false-positive regression)', () => {
  const goodBuild = loadFixture(FIXTURE_DIR);

  it('loads a complete multi-page build from disk', () => {
    expect(goodBuild.length).toBeGreaterThanOrEqual(20);
    // The four routes the sitemap declares must all be present as HTML files.
    for (const route of ['index.html', 'about.html', 'services.html', 'contact.html']) {
      expect(goodBuild.some((f) => f.path === route)).toBe(true);
    }
    // Lane 7 FP fixtures on disk: a noindex shell + an oversized demo thumbnail — both must be
    // present so BOTH this test AND the harness `--fixture` mode exercise the exclusions.
    const shell = goodBuild.find((f) => f.path === '404.html');
    expect(shell?.text).toMatch(/noindex/i);
    const demo = goodBuild.find((f) => f.path === 'applied/demo-thumb.png');
    expect(demo && demo.size).toBeGreaterThan(200 * 1024); // would trip image.png_too_large if not excluded
  });

  it('validateBuild(goodBuild).ok === true — zero blocking errors across all 30 validators', () => {
    const report = validateBuild(goodBuild, { expectedBusinessName: "Vito's Mens Salon" });
    // Surface the offending codes if this ever regresses (readable failure, not a bare `false`).
    expect(report.errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('the known-good build also raises ZERO advisory warnings (a truly clean build)', () => {
    const report = validateBuild(goodBuild, { expectedBusinessName: "Vito's Mens Salon" });
    expect(report.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([]);
  });
});

/**
 * Lane 7 — strict-flip FALSE-POSITIVE exclusions. Three known-good build shapes wrongly
 * blocked builds under strict (proven by `scripts/audit-validator-false-positives.mjs` on 3
 * live sites): non-content SHELLS (404/500/offline.html) legitimately ship short/absent meta,
 * 0 JSON-LD, and an intentional `noindex`; `applied/*` demo-gallery thumbnails are demo assets,
 * not shipped page images; and a pure-SPA build serves every sitemap route from `index.html`
 * (the Worker's own soft-404 SSOT returns 200 for those — they are NOT orphans). These tests
 * lock the exclusions so the FP set can never re-open; they must TIGHTEN FPs only, never loosen
 * a real check on a real content page.
 */
describe('Lane 7: strict-flip false-positive exclusions (shells / demo assets / SPA soft-404)', () => {
  // A minimal, WCAG-noindex error shell exactly like the ones live sites ship.
  const shell404: BuildFile = {
    path: '404.html',
    size: 900,
    text: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex,follow"><title>Not found — Acme</title></head><body><h1>Page not found</h1></body></html>`,
  };
  const shell500: BuildFile = {
    path: '500.html',
    size: 900,
    text: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex,follow"><title>Something went wrong — Acme</title><meta name="description" content="An unexpected error occurred."></head><body><h1>Something went wrong</h1></body></html>`,
  };
  const shellOffline: BuildFile = {
    path: 'offline.html',
    size: 800,
    text: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Offline — Acme</title></head><body><h1>You are offline</h1></body></html>`,
  };

  it('meta-length gate does NOT flag a shell with a short/absent <title> or description', () => {
    const v = validateMetaLengths([shell404, shell500, shellOffline]);
    expect(v.map((x) => `${x.code}@${x.file}`)).toEqual([]);
  });

  it('jsonld-count gate does NOT flag a shell that ships 0 JSON-LD blocks', () => {
    const v = validateJsonLdCount([shell404, shell500, shellOffline]);
    expect(v.map((x) => `${x.code}@${x.file}`)).toEqual([]);
  });

  it('noindex-leak gate does NOT flag a shell that is intentionally noindex', () => {
    const v = validateIndexable([shell404, shell500, shellOffline]);
    expect(v.map((x) => `${x.code}@${x.file}`)).toEqual([]);
  });

  it('but a REAL content page with a short title / 0 JSON-LD / noindex still fails (no loosening)', () => {
    const badPage: BuildFile = {
      path: 'index.html',
      size: 900,
      text: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Acme</title><meta name="description" content="Too short."></head><body><h1>Home</h1></body></html>`,
    };
    const codes = [
      ...validateMetaLengths([badPage]),
      ...validateJsonLdCount([badPage]),
      ...validateIndexable([badPage]),
    ].map((x) => x.code);
    expect(codes).toContain('meta.title_length');
    expect(codes).toContain('meta.description_length');
    expect(codes).toContain('jsonld.count_below_threshold');
    expect(codes).toContain('seo.noindex_leak');
  });

  it('PNG-too-large gate does NOT flag an applied/* demo-gallery thumbnail', () => {
    const demoPng: BuildFile = { path: 'applied/anchor-plumbing.png', size: 250 * 1024 };
    const v = validateImageFormat([demoPng]);
    expect(v).toEqual([]);
  });

  it('but a real shipped page PNG > 200KB (no optimized sibling) still fails (no loosening)', () => {
    const bigPng: BuildFile = { path: 'assets/hero-banner.png', size: 250 * 1024 };
    const v = validateImageFormat([bigPng]);
    expect(v.map((x) => x.code)).toEqual(['image.png_too_large']);
  });

  it('sitemap.orphan_route does NOT fire for a pure-SPA build whose index.html serves every route', () => {
    // index.html is the ONLY content HTML; the sitemap lists extensionless routes the Worker's
    // serveSiteFromR2 soft-404 SSOT serves from the SPA shell as real 200s — never orphans.
    const spa: BuildFile[] = [
      {
        path: 'index.html',
        size: 3000,
        text: `<!DOCTYPE html><html lang="en"><head><title>Acme — Home in Austin, the local favorite</title></head><body><h1>Acme</h1></body></html>`,
      },
      {
        path: 'sitemap.xml',
        size: 400,
        text: `<?xml version="1.0"?><urlset><url><loc>https://acme.projectsites.dev/</loc><lastmod>2026-09-29</lastmod></url><url><loc>https://acme.projectsites.dev/about</loc><lastmod>2026-09-29</lastmod></url><url><loc>https://acme.projectsites.dev/gallery</loc><lastmod>2026-09-29</lastmod></url><url><loc>https://acme.projectsites.dev/blog/post-1</loc><lastmod>2026-09-29</lastmod></url></urlset>`,
      },
    ];
    const v = validateSitemapRoutesExist(spa);
    expect(v.map((x) => `${x.code}:${x.detail ?? ''}`)).toEqual([]);
  });

  it('but a sitemap route with NO SPA shell AND no dedicated page IS still an orphan (no loosening)', () => {
    // No index.html anywhere → nothing serves /about → a genuine sitemap↔build drift.
    const noShell: BuildFile[] = [
      { path: 'home.html', size: 1000, text: `<h1>Home</h1>` },
      {
        path: 'sitemap.xml',
        size: 200,
        text: `<?xml version="1.0"?><urlset><url><loc>https://acme.projectsites.dev/about</loc><lastmod>2026-09-29</lastmod></url></urlset>`,
      },
    ];
    const v = validateSitemapRoutesExist(noShell);
    expect(v.map((x) => x.code)).toContain('sitemap.orphan_route');
  });
});
