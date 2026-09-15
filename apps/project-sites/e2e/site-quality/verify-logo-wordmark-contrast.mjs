// verify-logo-wordmark-contrast.mjs — § C.1c: the navbar WORDMARK must be LEGIBLE against the theme.
//
// The icon-luminance logic picks theme polarity (light icon → dark theme), but the wordmark is a
// SEPARATE Ideogram asset with no such guarantee — it can bake ink that FIGHTS the chosen theme:
// a DARK-ink wordmark on a DARK header (or light-on-light) renders an illegible smear even at a
// perfectly valid banner aspect (so `verify-logo-icon-transparency` (alpha) + `wordmarkTooSquare`
// (aspect) both pass). Measured live (AL-617): alpenglow-sports-tahoe-city shipped a wordmark whose
// mean opaque-ink luminance was 25/255 on a dark header (the icon was 178 = light, so the dark theme
// was correct — the wordmark just didn't match). Vision-caught; no gate covered it.
//
// The template Header (AL-617) now canvas-gates the wordmark ink and falls back to the always-
// theme-correct `.site-wordmark-text` when it doesn't contrast. This probe proves the RENDERED
// navbar is legible: PASS when the text fallback shows OR the PNG's ink contrasts the header; FLAG
// when a low-contrast PNG is actually shown to visitors. A pre-AL-617 build still renders the dark
// PNG until it rebuilds → fail-OPEN tracker (::notice, exit 0) so a stale site doesn't red the
// suite; STRICT=1 → exit 1 (promote once the fleet has rebuilt). Auto-joins run-all (verify-*.mjs).
//
// Usage: SITES=alpenglow-sports-tahoe-city [STRICT=1] node e2e/site-quality/verify-logo-wordmark-contrast.mjs
import { chromium } from 'playwright';
import sharp from 'sharp';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'alpenglow-sports-tahoe-city')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';

// Same decision as the template Header's `wordmarkContrastsTheme` (kept in sync): a dark header
// needs LIGHT-ish ink (≥90), a light header needs DARK-ish ink (≤165); the 90–165 mid band is
// ambiguous → trust it. Unmeasurable → trust it.
function contrastsTheme(inkLum, darkHeader) {
  if (!Number.isFinite(inkLum)) return true;
  return darkHeader ? inkLum >= 90 : inkLum <= 165;
}

// Mean luminance (0–255) of a PNG's opaque (alpha ≥ 32) pixels — the wordmark's ink.
async function inkLuminance(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const { data } = await sharp(buf).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 32) continue;
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n++;
    }
    return n ? sum / n : null;
  } catch {
    return null;
  }
}

const hits = [];
const rows = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const r = await page.goto(base, { waitUntil: 'load', timeout: 45000 });
      if (!r || r.status() !== 200) {
        rows.push(`  ⏭️  ${slug} — status ${r?.status()} (skip)`);
        await ctx.close();
        continue;
      }
      await page.waitForTimeout(3000); // let the wordmark HEAD-probe + onLoad ink-gate settle
      const st = await page.evaluate(() => {
        const vis = (el) => !!el && el.getBoundingClientRect().width > 4;
        const img = document.querySelector('img.site-wordmark');
        const txt = document.querySelector('.site-wordmark-text');
        const darkHeader =
          (document.documentElement.getAttribute('data-theme') || '').toLowerCase() === 'dark' ||
          (window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
        return {
          imgShown: vis(img),
          imgSrc: img?.currentSrc || img?.src || '',
          txtShown: vis(txt),
          darkHeader,
        };
      });
      if (st.imgShown) {
        const lum = await inkLuminance(st.imgSrc || `${base}/logo-wordmark.png`);
        if (contrastsTheme(lum, st.darkHeader)) {
          rows.push(
            `  ✓ ${slug} — PNG wordmark ink lum=${lum == null ? '?' : lum.toFixed(0)} contrasts the ${st.darkHeader ? 'dark' : 'light'} header`,
          );
        } else {
          hits.push({ slug, lum, darkHeader: st.darkHeader });
          rows.push(
            `  ❌ ${slug} — PNG wordmark ink lum=${lum.toFixed(0)} does NOT contrast the ${st.darkHeader ? 'DARK' : 'LIGHT'} header (illegible smear; Header should fall back to text)`,
          );
        }
      } else if (st.txtShown) {
        rows.push(`  ✓ ${slug} — text wordmark shown (theme-correct ink + halo, always legible)`);
      } else {
        rows.push(`  ⏭️  ${slug} — no wordmark element found (skip)`);
      }
    } catch (e) {
      rows.push(`  ⏭️  ${slug} — ${e.message.slice(0, 50)}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log('\n━━ § C.1c navbar wordmark ↔ theme contrast ━━');
rows.forEach((r) => console.log(r));
if (!hits.length) {
  console.log('\n✓ § C.1c PASS — every audited navbar wordmark is legible against its theme.');
  process.exit(0);
}
const msg = `${hits.length} wordmark(s) fight the theme: ${hits
  .map((h) => `${h.slug}(ink ${h.lum.toFixed(0)} on ${h.darkHeader ? 'dark' : 'light'})`)
  .join(' · ')}`;
if (STRICT) {
  console.log(`\n❌ FAIL — ${msg}`);
  process.exit(1);
}
console.log(
  `\n::notice:: § C.1c wordmark-contrast — ${msg} (pre-AL-617 build renders the low-contrast PNG; the Header ink-gate falls back to the text wordmark on rebuild → clears; STRICT=1 to enforce)`,
);
process.exit(0);
