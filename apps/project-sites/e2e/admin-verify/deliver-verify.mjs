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
page.on('requestfailed', (req) => {
  const u = req.url();
  // net::ERR_ABORTED is a CANCELED request, not a broken asset — the template's Header
  // probes /logo-wordmark.png with a fetch() then aborts it, falling back to the HTML text
  // wordmark (the asset itself 200s, validated separately by pngInfo). Counting the abort as
  // a console error was a FALSE POSITIVE that dragged real deliveries to 🟡 (validator-precision).
  if (req.failure()?.errorText === 'net::ERR_ABORTED') return;
  if (/logo-icon|logo-wordmark|\.png|\.webp|\.jpg/i.test(u) && !IGNORE.test(u))
    errors.push('reqfail: ' + u.split('/').pop());
});

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
  // e-commerce CTA scan — shop/cart language is on-brand for a RETAIL vertical (shop/store),
  // a wrong-vertical defect on non-retail (per commerceModeFor). Just report; classify by eye.
  const t = document.body.innerText.toLowerCase();
  const shopCTAs = ['add to cart', 'shop now', 'free shipping', 'add to bag'].filter((k) => t.includes(k));
  return { h1, title, desc, bodyWords, imgs, jsonld, iconInfo, wmInfo, shopCTAs };
});

// Fetch the logo assets directly: confirm they 200 AND actually carry an ALPHA channel (AL-224).
// A PNG's colour-type byte sits at offset 25 (in the IHDR chunk): 6=RGBA / 4=grey+alpha are
// transparent (GOOD); 2=RGB / 0=grey are OPAQUE (a boxed logo — the AL-224 defect); 3=palette is
// ambiguous (alpha only via a tRNS chunk). content-type alone is a NO-OP check — an opaque PNG is
// still `image/png` — so we read the byte to verify transparency for real.
async function pngInfo(pathname) {
  try {
    const r = await fetch(base + pathname, { headers: { 'User-Agent': UA } });
    if (!r.ok) return { status: r.status, type: r.headers.get('content-type') };
    const buf = new Uint8Array(await r.arrayBuffer());
    const isPng =
      buf.length > 25 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const colorType = isPng ? buf[25] : null;
    const hasAlpha = colorType === 6 || colorType === 4; // definite alpha; 3=palette is ambiguous
    return { status: r.status, type: r.headers.get('content-type'), len: buf.length, colorType, hasAlpha };
  } catch (e) {
    return { status: 0, err: String(e) };
  }
}
const iconAsset = await pngInfo('/logo-icon.png');
const wmAsset = await pngInfo('/logo-wordmark.png');
// AL-224 verdict: the navbar icon MUST carry alpha (transparent), never an opaque box.
const iconTransparent = iconAsset.status === 200 ? iconAsset.hasAlpha === true : null;

// Name the artifact per-SLUG in the repo (was hardcoded /tmp/deliver-jenis.png — a Jeni's
// leftover that mislabeled + overwrote every later delivery's screenshot).
await page.screenshot({ path: `e2e/admin-verify/_deliver-verify-${SLUG}.png`, fullPage: false }).catch(() => {});
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
console.log(
  `logo transparency (AL-224): icon colorType=${iconAsset.colorType} ${
    iconTransparent === null
      ? '(no icon asset)'
      : iconTransparent
        ? '✓ transparent (has alpha)'
        : '✗ OPAQUE — boxed logo, AL-224 regression'
  }`,
);
console.log(`shop/cart CTAs (on-brand for RETAIL, wrong-vertical otherwise): ${data.shopCTAs.join(', ') || '(none)'}`);
console.log(`console errors: ${errors.length}`);
errors.forEach((e) => console.log('  ✗ ' + e));

// Business-specific check: derive expected tokens from the SLUG (e.g.
// "gruhn-guitars-nashville" → gruhn/guitars/nashville) and require the H1 OR <title> to
// carry at least one — a generic pack-default H1 would carry none. Business-agnostic, so
// this tool works for EVERY delivery (was hardcoded to Jeni's terms → false 🟡 on all others).
const slugTokens = SLUG.split('-').filter((t) => t.length >= 4);
const hay = `${data.h1} ${data.title}`.toLowerCase();
const bizSpecific = slugTokens.some((t) => hay.includes(t));
const realBuild = status === 200 && data.bodyWords > 300 && data.imgs >= 4 && data.h1.length > 0;
// Opaque navbar logo is a real AL-224 defect even on an otherwise-perfect build — surface it in
// the verdict so a delivery is never called ✅ while shipping a boxed logo.
const logoOk = iconTransparent !== false; // null (no asset) or true both acceptable here
console.log(
  `\nverdict: ${
    realBuild && bizSpecific && errors.length === 0 && logoOk
      ? '✅ REAL DELIVERY (biz-specific H1, content, 0 console errors, transparent logo)'
      : realBuild && !logoOk
        ? '🟡 real build but OPAQUE LOGO (AL-224) — fix logo transparency'
        : realBuild
          ? '🟡 real build but check H1/errors'
          : '❌ shell/thin — investigate premature-terminal'
  }`,
);
