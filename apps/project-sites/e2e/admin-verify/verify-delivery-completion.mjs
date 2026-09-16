// verify-delivery-completion.mjs — GOLDEN-JOURNEY public-render contract for a freshly DELIVERED
// site. Closes the gap verify-delivered-site-propagation.mjs leaves (it proves analytics/sites/
// snapshots/audit/forms propagate to the ADMIN, but never opens the PUBLIC site in a browser):
//
//   1. RENDER — https://{slug}.projectsites.dev/ loads 200, the CLIENT-hydrated <h1> is non-empty
//      and not a raw unfilled `{TOKEN}`, and there are ZERO console errors.
//   2. LOGO + WORDMARK TRANSPARENCY (AL-224) — the navbar icon mark AND the wordmark render
//      (naturalWidth>0) AND their image files are genuinely TRANSPARENT: SVG (transparent by
//      nature) or PNG/WebP carrying an alpha channel — never an opaque rectangle behind a logo.
//
// Generated-site subdomains are CF-clean for LOCAL headless Playwright (no Browserbase needed) —
// per `generated-site-subdomains-cf-clean-for-local-headless`. Tracking-mode by default
// (::notice, suite-safe); STRICT=1 → exit 1 on any failure.
//
// Usage: DELIVERED_SLUG=pizzeria-bianco-phoenix node e2e/admin-verify/verify-delivery-completion.mjs
import { chromium } from 'playwright';

const SLUG = process.env.DELIVERED_SLUG || '';
if (!SLUG) {
  console.log('::error:: set DELIVERED_SLUG');
  process.exit(2);
}
const STRICT = process.env.STRICT === '1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * Fetch an image and decide whether it is transparent.
 * SVG → true (vector, transparent by nature). PNG → color-type byte (IHDR offset 25) is 6 (RGBA)
 * or 4 (gray+alpha), OR a `tRNS` chunk exists. WebP → VP8L (lossless) alpha bit / extended-format
 * alpha flag. Anything else (JPEG, opaque PNG type 2/0 with no tRNS) → false.
 */
async function isTransparent(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return { ok: false, reason: `img ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = new Uint8Array(await res.arrayBuffer());
    if (ct.includes('svg') || url.toLowerCase().endsWith('.svg')) return { ok: true, fmt: 'svg' };
    // PNG: signature 89 50 4E 47; IHDR color type at byte 25; tRNS chunk anywhere.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const colorType = buf[25];
      const hasAlphaChannel = colorType === 6 || colorType === 4;
      const ascii = String.fromCharCode(...buf.slice(0, Math.min(buf.length, 4096)));
      const hasTRNS = ascii.includes('tRNS');
      return { ok: hasAlphaChannel || hasTRNS, fmt: `png(type=${colorType}${hasTRNS ? '+tRNS' : ''})` };
    }
    // WebP: "RIFF"...."WEBP"; VP8X extended has alpha flag (byte 20 bit 4); VP8L lossless byte 21 & 0x10.
    if (ascii4(buf, 0) === 'RIFF' && ascii4(buf, 8) === 'WEBP') {
      const fourcc = ascii4(buf, 12);
      if (fourcc === 'VP8X') return { ok: (buf[20] & 0x10) !== 0, fmt: 'webp(vp8x)' };
      if (fourcc === 'VP8L') return { ok: (buf[21] & 0x10) !== 0, fmt: 'webp(vp8l)' };
      return { ok: false, fmt: 'webp(vp8)' }; // lossy VP8 has no alpha
    }
    return { ok: false, fmt: ct || 'unknown' };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 60) };
  }
}
function ascii4(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => {
  const t = m.type(),
    x = m.text();
  if (/Failed to load resource|net::ERR_ABORTED|favicon|the server responded with a status/i.test(x)) return;
  if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 100));
});
page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 100)));

const out = { slug: SLUG };
try {
  const resp = await page.goto(`https://${SLUG}.projectsites.dev/`, { waitUntil: 'load', timeout: 45000 });
  out.status = resp?.status();
  await page.waitForTimeout(1500); // hydration

  out.h1 = (await page.locator('h1').first().textContent().catch(() => ''))?.trim() || '';
  // navbar images: the header's <img> elements (icon mark + wordmark). Grab src + naturalWidth.
  out.navImgs = await page.evaluate(() => {
    const header = document.querySelector('header') || document.querySelector('nav')?.closest('*') || document.body;
    return Array.from(header.querySelectorAll('img'))
      .map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        w: img.naturalWidth,
        h: img.naturalHeight,
      }))
      .filter((i) => i.src && !/favicon/i.test(i.src));
  });
  await page.screenshot({ path: `e2e/admin-verify/_delivery-${SLUG}.png` }).catch(() => {});
} catch (e) {
  out.err = String(e.message || e).slice(0, 100);
} finally {
  await browser.close();
}

// Evaluate transparency of each navbar image.
out.transparency = [];
for (const img of out.navImgs || []) {
  const t = await isTransparent(img.src);
  out.transparency.push({ src: img.src.replace(/^https?:\/\/[^/]+/, ''), rendered: img.w > 0, ...t });
}

const renderOk =
  out.status === 200 &&
  out.h1.length > 3 &&
  !/^\{.*\}$/.test(out.h1) &&
  !out.h1.includes('{') &&
  errs.length === 0 &&
  !out.err;
const imgsRendered = (out.navImgs || []).length > 0 && (out.navImgs || []).every((i) => i.w > 0);
const allTransparent = out.transparency.length > 0 && out.transparency.every((t) => t.ok);

console.log('\n=== DELIVERY COMPLETION — public render + logo transparency (' + SLUG + ') ===');
console.log(JSON.stringify({ ...out, consoleErrors: errs }, null, 2));
console.log(
  `\nrender=${renderOk ? '✅' : '❌'} (status ${out.status}, h1 "${out.h1}", ${errs.length} console err) · ` +
    `navImgs=${imgsRendered ? '✅' : '❌'} (${(out.navImgs || []).length}) · ` +
    `transparent=${allTransparent ? '✅' : '❌'}`,
);

const pass = renderOk && imgsRendered && allTransparent;
if (pass) {
  console.log('\n✅ DELIVERY PASS — live 200, business H1, 0 console errors, navbar logo+wordmark render TRANSPARENT.');
} else if (STRICT) {
  console.log('\n❌ DELIVERY FAIL (STRICT)');
  process.exit(1);
} else {
  console.log('\n::notice:: delivery-completion — some checks not green (tracking). STRICT=1 to enforce.');
}
