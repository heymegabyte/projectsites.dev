// verify-image-render.mjs — § C.13: every visible <img> a deployed site ships must actually RENDER
// (decode to real pixels), not paint a broken-image icon.
//
// The gap this closes: `verify-no-asset-404.mjs` catches an image whose request 404s, but a broken
// image also ships when a src returns a 200 that ISN'T a decodable image — a stock-API rate-limit
// placeholder, a wrong content-type (HTML error body served as image/*), a CORS-tainted decode, or a
// truncated/corrupt file. Those all paint the browser's broken-image glyph to the visitor while every
// request is "200 OK" → invisible to the 404 probe. The definitive signal is
// `img.complete && img.naturalWidth === 0` on an <img> that HAS a src: the load settled but zero
// pixels decoded. That's strictly worse than the source and the first thing a visitor notices.
//
// Scrolls the page top→bottom→top first so `loading="lazy"` images actually fetch (an un-triggered
// lazy image is `complete === false`, NOT broken — we never flag those). Only VISIBLE images with a
// non-blank src are judged; explicit 1×1 tracking pixels and `aria-hidden` decorations are excluded.
//
// Fail-OPEN by default (::notice — deployed pre-fix builds may carry a flaked stock URL until they
// rebuild); STRICT=1 → exit 1 (a FRESH build shipping a broken image is a build-breaker). Auto-joins
// run-all via the verify-*.mjs glob.
//
// Usage: SITES=franklin-barbecue-austin,koval-distillery-chicago [STRICT=1] node e2e/site-quality/verify-image-render.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'koval-distillery-chicago,pizzeria-bianco-phoenix,murrays-cheese-nyc,cole-hardware-sf')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';

/** In-page: scroll to trigger lazy loads, wait for decode, then return the broken visible <img>s. */
const COLLECT_BROKEN = async () => {
  // Trigger every loading="lazy" image by walking the scroll height, then return to top.
  await new Promise((resolve) => {
    let y = 0;
    const step = () => {
      window.scrollTo(0, y);
      y += Math.round(window.innerHeight * 0.8);
      if (y < document.body.scrollHeight) {
        setTimeout(step, 120);
      } else {
        window.scrollTo(0, 0);
        setTimeout(resolve, 400);
      }
    };
    step();
  });
  // Give freshly-triggered images a beat to finish decoding.
  await new Promise((r) => setTimeout(r, 1200));

  const broken = [];
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) continue; // no-src lazy placeholders + inline data URIs
    if (img.getAttribute('aria-hidden') === 'true') continue; // decorative
    // Visible = laid out on the page (offsetParent set) and not a 1×1 tracking pixel.
    const rect = img.getBoundingClientRect();
    const visible = img.offsetParent !== null || rect.width > 2 || rect.height > 2;
    if (!visible) continue;
    if (img.getAttribute('width') === '1' && img.getAttribute('height') === '1') continue;
    // A LAZY image that never entered the viewport is complete===false → still loading, NOT broken.
    if (!img.complete) continue;
    if (img.naturalWidth === 0) {
      broken.push({
        src: src.length > 90 ? src.slice(0, 90) + '…' : src,
        alt: (img.getAttribute('alt') || '').slice(0, 40),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }
  }
  return broken;
};

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const origin = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    let http = 0;
    try {
      const r = await page.goto(origin + '/', { waitUntil: 'load', timeout: 60000 });
      http = r ? r.status() : 0;
      const broken = await page.evaluate(COLLECT_BROKEN);
      const total = await page.evaluate(() => document.querySelectorAll('img').length);
      results.push({ slug, http, total, broken });
    } catch (e) {
      results.push({ slug, http: 0, total: 0, broken: [{ src: `load failed: ${String(e).slice(0, 60)}`, alt: '', w: 0, h: 0 }] });
    }
    await ctx.close().catch(() => {});
  }
} finally {
  await browser.close();
}

for (const r of results) {
  const mark = r.broken.length ? '🔴' : '✅';
  console.log(
    `${mark} ${r.slug.padEnd(30)} http=${r.http} imgs=${r.total} broken=${r.broken.length}` +
      (r.broken.length ? '\n     ' + r.broken.map((b) => `[${b.w}×${b.h}] ${b.src} (alt:"${b.alt}")`).join('\n     ') : ''),
  );
}
const offenders = results.filter((r) => r.broken.length);
console.log('');
if (!offenders.length) {
  console.log(`✅ PASS — every visible <img> renders on ${results.length} site(s)`);
  process.exit(0);
}
const msg = `broken images on ${offenders.length}/${results.length} site(s): ${offenders
  .map((r) => `${r.slug} (${r.broken.length})`)
  .join(' · ')}`;
if (STRICT) {
  console.log(`❌ FAIL — ${msg}`);
  process.exit(1);
}
console.log(`::notice:: verify-image-render — ${msg} (a broken src may be a flaked stock URL on a pre-fix build; clears on rebuild — set STRICT=1 to enforce)`);
process.exit(0);
