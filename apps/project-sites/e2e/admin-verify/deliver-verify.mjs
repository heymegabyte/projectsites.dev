// deliver-verify.mjs — verify a freshly delivered site is REAL (not a premature-terminal shell).
import { chromium } from 'playwright';
const SLUG = process.env.SLUG || 'jenis-splendid-ice-creams-columbus';
const base = `https://${SLUG}.projectsites.dev`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /google-analytics|googletagmanager|posthog|\/ingest|doubleclick|sentry|clarity|hotjar|cf-|challenge|beacon/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = []; // REAL JS/page console errors (not the URL-less browser echo of an asset 4xx)
const assetFails = []; // {name,status,url} for non-OK asset responses — has the URL, so classifiable
const RESOURCE_ECHO = /Failed to load resource/i;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (IGNORE.test(t)) return;
  // The browser logs a URL-LESS "Failed to load resource: … 404" for every asset 4xx. We capture
  // that same failure WITH its URL via the 'response' listener below, where it can be CLASSIFIED
  // (a legacy pre-AL-591 /logo-wordmark.png <img> 404 is stale-build-debt, not a live regression).
  // Dropping the opaque echo here stops one real cause being counted as an unexplained console error.
  if (RESOURCE_ECHO.test(t)) return;
  errors.push(t.slice(0, 140));
});
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errors.push('pageerror: ' + String(e).slice(0, 140)); });
page.on('response', (r) => {
  if (r.status() < 400) return;
  const u = r.url();
  if (IGNORE.test(u)) return;
  if (!/\.(png|webp|jpe?g|svg|css|js|woff2?|ico)(\?|$)/i.test(u)) return; // asset requests only
  assetFails.push({ name: u.split('/').pop().split('?')[0], status: r.status(), url: u });
});
page.on('requestfailed', (req) => {
  const u = req.url();
  // net::ERR_ABORTED is a CANCELED request, not a broken asset — the CURRENT template Header
  // HEAD-probes /logo-wordmark.png with a fetch() then aborts it, falling back to the HTML text
  // wordmark (AL-591). Counting the abort was a FALSE POSITIVE that dragged real deliveries to 🟡.
  if (req.failure()?.errorText === 'net::ERR_ABORTED') return;
  if (/logo-icon|logo-wordmark|\.png|\.webp|\.jpg/i.test(u) && !IGNORE.test(u))
    assetFails.push({ name: u.split('/').pop().split('?')[0], status: 'FAIL', url: u });
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
// AL-224 applies to the WORDMARK too — a boxed opaque wordmark over the transparent-nav hero is
// the same defect the icon check guards against. The verifier fetched wmAsset all along but never
// gated its transparency, so a transparent-icon + OPAQUE-wordmark delivery passed ✅ (a real hole).
// Gate both. null (HTML text wordmark → /logo-wordmark.png 404s) is acceptable, exactly like the icon.
const wmTransparent = wmAsset.status === 200 ? wmAsset.hasAlpha === true : null;

// AL-835/AL-841 subtype: a LOCAL business should serve a PRECISE schema.org subtype
// (ClothingStore/Restaurant/MusicStore/…) in its RAW served HTML — baked by the generator
// (AL-835 localBusinessSubtypeFor) or upgraded at serve-time (AL-841 applyServedLocalBusinessSubtype).
// Fetch the served HTML (what crawlers + Google Rich Results read, NOT the client DOM) and extract
// the LocalBusiness-family @type. Report-only — a soft SEO-enrichment signal, never a hard-fail (a
// generic LocalBusiness still validates as a local business; non-local verticals have none).
async function servedLocalBusinessType() {
  try {
    const r = await fetch(base + '/', { headers: { 'User-Agent': UA } });
    const html = await r.text();
    const LOCAL =
      /"@type":\s*"(LocalBusiness|Restaurant|Store|BookStore|MusicStore|Florist|JewelryStore|GroceryStore|HardwareStore|ShoeStore|ClothingStore|FurnitureStore|PetStore|ToyStore|ElectronicsStore|SportingGoodsStore|FoodEstablishment|CafeOrCoffeeShop|BarOrPub|Bakery|HealthAndBeautyBusiness|ProfessionalService|HomeAndConstructionBusiness|AutomotiveBusiness|MedicalBusiness|LodgingBusiness|EntertainmentBusiness)"/g;
    const found = [...html.matchAll(LOCAL)].map((m) => m[1]);
    const precise = found.find((t) => t !== 'LocalBusiness') || null;
    return { any: found[0] || null, precise, generic: found.includes('LocalBusiness') && !precise };
  } catch (e) {
    return { any: null, precise: null, generic: false, err: String(e) };
  }
}
const lbServed = await servedLocalBusinessType();

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
console.log(
  `logo transparency (AL-224): wordmark colorType=${wmAsset.colorType} ${
    wmTransparent === null
      ? '(no wordmark asset — HTML text wordmark)'
      : wmTransparent
        ? '✓ transparent (has alpha)'
        : '✗ OPAQUE — boxed wordmark, AL-224 regression'
  }`,
);
console.log(
  `LocalBusiness @type (served HTML, AL-835/AL-841): ${
    lbServed.precise
      ? `${lbServed.precise} ✓ precise subtype`
      : lbServed.generic
        ? 'LocalBusiness (generic — AL-841 serve-time upgrade should apply the subtype)'
        : lbServed.any || '(no LocalBusiness-family type — non-local vertical)'
  }`,
);
console.log(`shop/cart CTAs (on-brand for RETAIL, wrong-vertical otherwise): ${data.shopCTAs.join(', ') || '(none)'}`);
// Classify asset failures. A pre-AL-591 shell renders <img src="/logo-wordmark.png"> with NO
// HEAD-guard, which 404s on the large fraction of sites that never generated a wordmark. That 404
// is STALE BUILD DEBT — the template's Header was fixed (AL-591 HEAD-probes first, so new shells
// never request it) → it clears on REBUILD and is NOT a live template regression. Every OTHER
// asset 4xx (logo-icon, hero image, css/js) IS a real defect. Distinguishing the two stops the
// probe crying "regression" on legacy shells while still catching genuine breakage.
const staleWordmark404 = assetFails.filter((a) => /logo-wordmark\.png/.test(a.url) && a.status === 404);
const realAssetFails = assetFails.filter((a) => !(/logo-wordmark\.png/.test(a.url) && a.status === 404));
const isStaleShell = staleWordmark404.length > 0 && wmAsset.status === 404;
const hardErrors = errors.length + realAssetFails.length;
console.log(`console errors (real JS): ${errors.length}`);
errors.forEach((e) => console.log('  ✗ ' + e));
console.log(`asset failures: ${assetFails.length}${assetFails.length ? ' → ' + assetFails.map((a) => `${a.name}:${a.status}`).join(', ') : ''}`);
if (isStaleShell)
  console.log(`  ⓘ /logo-wordmark.png 404 = STALE SHELL (pre-AL-591 wordmark <img>) — REBUILD to clear; template already fixed, NOT a regression`);
if (realAssetFails.length) realAssetFails.forEach((a) => console.log(`  ✗ REAL asset fail: ${a.name} (${a.status})`));

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
// null (no asset) or true both acceptable; gate icon AND wordmark — a boxed opaque EITHER is AL-224.
const logoOk = iconTransparent !== false && wmTransparent !== false;
const opaqueParts = [iconTransparent === false ? 'ICON' : '', wmTransparent === false ? 'WORDMARK' : ''].filter(Boolean).join(' + ');
// A stale shell still emits a real /logo-wordmark.png 404 to visitors — so it's a 🟡 WARN (with the
// precise "rebuild to clear" reason), never ✅ PASS. It is NOT a regression (template is fixed), so
// it must not read as a hard failure either. Excluding it from `pass` keeps that middle ground.
const pass = realBuild && bizSpecific && hardErrors === 0 && logoOk && !isStaleShell;
console.log(
  `\nverdict: ${
    pass
      ? '✅ REAL DELIVERY (biz-specific H1, content, 0 hard errors, transparent logo + wordmark)'
      : realBuild && !logoOk
        ? `🟡 real build but OPAQUE ${opaqueParts} (AL-224) — fix logo transparency`
        : realBuild && hardErrors === 0 && isStaleShell
          ? '🟡 STALE SHELL — real build, 0 hard errors, only a pre-AL-591 /logo-wordmark.png 404 (REBUILD to clear; template already fixed, do NOT treat as a regression)'
          : realBuild
            ? '🟡 real build but check H1 / real errors'
            : '❌ shell/thin — investigate premature-terminal'
  }`,
);
// Structured, machine-readable verdict so the delivery loop can parse PASS/WARN/FAIL programmatically
// (the prose above stays for humans). Composable — a wrapper can grep DELIVER_VERIFY_RESULT.
console.log(
  `\nDELIVER_VERIFY_RESULT ${JSON.stringify({
    slug: SLUG,
    status,
    h1: data.h1,
    words: data.bodyWords,
    imgs: data.imgs,
    jsonld: data.jsonld,
    iconTransparent,
    wmTransparent,
    localBusinessType: lbServed.precise || lbServed.any,
    consoleErrors: errors.length,
    assetFails: assetFails.length,
    realAssetFails: realAssetFails.length,
    hardErrors,
    staleShell: isStaleShell,
    bizSpecific,
    realBuild,
    verdict: pass ? 'PASS' : realBuild ? 'WARN' : 'FAIL',
  })}`,
);
