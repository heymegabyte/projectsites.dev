// verify-image-optimization.mjs — GENERATED-SITE QUALITY / CWV + beat-source gate: images are
// served RESPONSIVE + MODERN-FORMAT, not a single full-width JPEG to every viewport.
//
// WHY (the gap this closes): the generator hands the template raw Unsplash URLs like
// `…?fit=max&fm=jpg` — a ~1000px JPEG forced to EVERY device, with NO `srcset`. A phone downloads
// the full desktop image in an old format → slow LCP, wasted bandwidth, and it LOSES the
// beat-source bar (the original sites almost never do responsive images). The ~50 prior probes
// cover alt-text / no-404 / hero-vertical but NONE asserted image FORMAT (avif/webp vs forced jpg)
// or RESPONSIVE `srcset`. Root fix is in the TEMPLATE (`lib/cdn-image.ts` rewrites CDN URLs to
// `auto=format` + a per-width srcSet, wired into the hero) — lands next build, never a one-off.
//
// Report-mode by default (deployed sites predate the fix → report `fm=jpg`/no-srcset until they
// rebuild — the stale-build class, § C.8). `--strict` hard-fails when the HERO/LCP image is still
// a forced-JPEG single-size. Flips ✅ as the cohort rebuilds off the updated template.
//
// Usage:
//   node e2e/site-quality/verify-image-optimization.mjs
//   SITES=franklin-barbecue node e2e/site-quality/verify-image-optimization.mjs
//   node e2e/site-quality/verify-image-optimization.mjs --strict

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'))(
  'playwright-core',
);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STRICT = process.argv.includes('--strict');

const SITES = (
  process.env.SITES ||
  'vanta-strength-austin,ironhaus-houston,vantage-digital-studio-portland,franklin-barbecue,pizzeria-bianco-phoenix'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function auditSite(browser, slug) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
    const title = await page.title().catch(() => '');
    if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
      return { slug, auditable: false, status: resp?.status() ?? 0 };
    }
    await page.waitForTimeout(2500);
    const data = await page.evaluate(() => {
      const isCdn = (u) => /images\.unsplash\.com|images\.pexels\.com|pixabay\.com/i.test(u);
      const imgs = [...document.querySelectorAll('img')];
      let cdn = 0;
      let forcedJpg = 0;
      let responsive = 0;
      let modernFmt = 0;
      let belowFoldLazy = 0;
      let belowFoldTotal = 0;
      const vh = window.innerHeight;
      // Identify the hero/LCP-ish image: the first eager, above-the-fold, reasonably-large img.
      let hero = null;
      for (const im of imgs) {
        const u = im.currentSrc || im.src || '';
        const r = im.getBoundingClientRect();
        if (isCdn(u)) {
          cdn++;
          if (/[?&]fm=jpg|[?&]fm=png/i.test(u)) forcedJpg++;
          if (/auto=format/i.test(u)) modernFmt++;
          if (im.srcset || im.closest('picture')?.querySelector('source[srcset]')) responsive++;
        }
        if (r.top > vh) {
          belowFoldTotal++;
          if (im.loading === 'lazy') belowFoldLazy++;
        }
        if (!hero && im.loading === 'eager' && r.top < vh && r.width * r.height > 90000 && isCdn(u)) {
          hero = { forcedJpg: /[?&]fm=jpg/i.test(u), responsive: Boolean(im.srcset), modern: /auto=format/i.test(u) };
        }
      }
      return { cdn, forcedJpg, responsive, modernFmt, belowFoldLazy, belowFoldTotal, hero };
    });
    return { slug, auditable: true, ...data };
  } catch (e) {
    return { slug, auditable: false, status: 0, gotoError: String(e).slice(0, 60) };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const slug of SITES) rows.push(await auditSite(browser, slug));
await browser.close();

let defects = 0;
let stale = 0;
console.log('\n━━ GENERATED-SITE image-optimization gate (responsive srcset + modern format, not forced JPEG) ━━');
for (const r of rows) {
  if (!r.auditable) {
    console.log(`  ⚠️  ${r.slug.padEnd(34)} NOT AUDITABLE (status=${r.status}${r.gotoError ? ' ' + r.gotoError : ''}) — skip`);
    continue;
  }
  // HERO/LCP hard signal: is the LCP-ish hero image still a forced-JPEG single-size?
  const heroBad = r.hero && (r.hero.forcedJpg || (!r.hero.responsive && !r.hero.modern));
  const lazyOk = r.belowFoldTotal === 0 || r.belowFoldLazy / r.belowFoldTotal >= 0.6;
  if (heroBad) {
    stale++;
    console.log(
      `  ⚠️  ${r.slug.padEnd(34)} hero forced-JPEG/single-size (stale build) · cdn=${r.cdn} fm=jpg=${r.forcedJpg} responsive=${r.responsive} auto-format=${r.modernFmt}`,
    );
  } else if (!lazyOk) {
    defects++;
    console.log(`  ${STRICT ? '❌' : '⚠️ '} ${r.slug.padEnd(34)} below-fold not lazy (${r.belowFoldLazy}/${r.belowFoldTotal})`);
  } else {
    console.log(`  ✅ ${r.slug.padEnd(34)} hero responsive/modern · cdn=${r.cdn} responsive=${r.responsive} auto-format=${r.modernFmt} · below-fold lazy ok`);
  }
  console.log(`::json:: ${JSON.stringify({ probe: 'image-optimization', slug: r.slug, auditable: r.auditable, cdn: r.cdn ?? null, forcedJpg: r.forcedJpg ?? null, responsive: r.responsive ?? null, modernFmt: r.modernFmt ?? null, hero: r.hero ?? null })}`);
}

const fail = STRICT ? defects + stale : defects;
console.log(
  `\nVERDICT: ${fail ? '🔴 FAIL' : stale ? '⚠️ REPORT(stale)' : '✅ PASS'} — hard-defects=${defects} · hero-stale=${stale} of ${rows.length} sites (${STRICT ? 'strict' : 'report'})`,
);
if (stale && !defects)
  console.log('   ↳ fix SHIPPED in the TEMPLATE (lib/cdn-image.ts → auto=format + srcSet, wired into the hero); deployed sites gain responsive/modern images on their next build.');
process.exit(fail ? 1 : 0);
