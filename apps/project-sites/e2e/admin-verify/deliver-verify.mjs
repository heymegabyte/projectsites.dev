// deliver-verify.mjs — verify a freshly delivered site is REAL (not a premature-terminal shell).
import { chromium } from 'playwright';
const SLUG = process.env.SLUG || 'jenis-splendid-ice-creams-columbus';
const base = `https://${SLUG}.projectsites.dev`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /google-analytics|googletagmanager|posthog|\/ingest|doubleclick|sentry|clarity|hotjar|cf-|challenge|beacon/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text().slice(0, 140)); });
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errors.push('pageerror: ' + String(e).slice(0, 140)); });
page.on('requestfailed', (req) => { const u = req.url(); if (/logo-icon|logo-wordmark|\.png|\.webp|\.jpg/i.test(u) && !IGNORE.test(u)) errors.push('reqfail: ' + u.split('/').pop()); });

const resp = await page.goto(base, { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(1500);
const status = resp?.status();

const data = await page.evaluate(() => {
  const h1 = document.querySelector('h1')?.textContent?.trim() || '';
  const title = document.title;
  const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const bodyWords = (document.body.innerText.match(/\S+/g) || []).length;
  const imgs = document.querySelectorAll('img').length;
  const jsonld = document.querySelectorAll('script[type="application/ld+json"]').length;
  // Navbar logo assets
  const icon = document.querySelector('header img[src*="logo-icon"], nav img[src*="logo-icon"], header img[alt*="logo" i]');
  const wordmark = document.querySelector('header img[src*="wordmark"], nav img[src*="wordmark"]');
  const iconInfo = icon ? { src: icon.getAttribute('src'), w: icon.naturalWidth, h: icon.naturalHeight, complete: icon.complete } : null;
  const wmInfo = wordmark ? { src: wordmark.getAttribute('src'), w: wordmark.naturalWidth, h: wordmark.naturalHeight, complete: wordmark.complete } : null;
  // e-commerce CTA scan (ice cream IS retail, so shop CTAs are expected/OK — just report)
  const t = document.body.innerText.toLowerCase();
  const shopCTAs = ['add to cart', 'shop now', 'free shipping', 'add to bag'].filter((k) => t.includes(k));
  return { h1, title, desc, bodyWords, imgs, jsonld, iconInfo, wmInfo, shopCTAs };
});

// Fetch the logo assets directly to confirm they 200 + are PNG (transparency = AL-224)
async function head(pathname) {
  try { const r = await fetch(base + pathname, { headers: { 'User-Agent': UA } }); return { status: r.status, type: r.headers.get('content-type'), len: r.headers.get('content-length') }; }
  catch (e) { return { status: 0, err: String(e) }; }
}
const iconAsset = await head('/logo-icon.png');
const wmAsset = await head('/logo-wordmark.png');

await page.screenshot({ path: '/tmp/deliver-jenis.png', fullPage: false });
await browser.close();

console.log(`\n=== DELIVERY VERIFY — ${base} ===`);
console.log(`HTTP ${status}`);
console.log(`H1: "${data.h1}"`);
console.log(`title: "${data.title}"`);
console.log(`desc(${data.desc.length}): "${data.desc.slice(0, 120)}"`);
console.log(`words=${data.bodyWords} imgs=${data.imgs} jsonld=${data.jsonld}`);
console.log(`navbar icon: ${JSON.stringify(data.iconInfo)}`);
console.log(`navbar wordmark: ${JSON.stringify(data.wmInfo)}`);
console.log(`logo-icon.png asset: ${JSON.stringify(iconAsset)}`);
console.log(`logo-wordmark.png asset: ${JSON.stringify(wmAsset)}`);
console.log(`shop CTAs (retail-OK for ice cream): ${data.shopCTAs.join(', ') || '(none)'}`);
console.log(`console errors: ${errors.length}`);
errors.forEach((e) => console.log('  ✗ ' + e));

const bizSpecific = /jeni|ice cream|scoop|columbus/i.test(data.h1);
const realBuild = status === 200 && data.bodyWords > 300 && data.imgs >= 4 && data.h1.length > 0;
console.log(`\nverdict: ${realBuild && bizSpecific && errors.length === 0 ? '✅ REAL DELIVERY (biz-specific H1, content, 0 console errors)' : realBuild ? '🟡 real build but check H1/errors' : '❌ shell/thin — investigate premature-terminal'}`);
