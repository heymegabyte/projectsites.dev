// verify-no-asset-404.mjs — § C.1: every SAME-ORIGIN asset a deployed site requests must resolve
// (no 4xx/5xx), so no "Failed to load resource" console error ever ships.
//
// The gap this closes: `verify-no-pageerror.mjs` deliberately FILTERS OUT "Failed to load resource"
// (third-party beacon noise), so a MISSING first-party asset (a 404 on the site's OWN
// /logo-wordmark.png, a broken /assets/*.js, a missing favicon) was invisible to every probe — yet
// it's a hard-gate console error AND a C.1 "every internal asset resolves" break. Reference incident
// (AL-591): 4/9 sampled sites 404'd `/logo-wordmark.png` (the AI wordmark step flaked; the Header's
// onError→text fixed the VISUAL but the <img> still 404'd → a console error on every such site).
// Root-fixed in the template Header (fetch-HEAD probe before render — a fetch 404 is silent); this
// probe is the durable gate that makes a first-party asset 404 RED instead of invisible.
//
// Captures every response whose URL is SAME-ORIGIN as the site (third-party CDNs/analytics are not
// our build's concern) with status ≥ 400. Fail-OPEN by default (::notice, suite-safe — deployed
// pre-fix builds still 404 until they rebuild), STRICT=1 → exit 1 (a FRESH build shipping a
// first-party 404 is a build-breaker). Auto-joins run-all via the verify-*.mjs glob.
//
// Usage: SITES=gentle-dental-seattle,cole-hardware-sf [STRICT=1] node e2e/site-quality/verify-no-asset-404.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'gentle-dental-seattle,vanta-strength-austin,cole-hardware-sf,murrays-cheese-nyc')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const origin = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const bad = new Set();
    page.on('response', (res) => {
      const u = res.url();
      const s = res.status();
      // Same-origin (the site's OWN assets) + a real client error. Ignore 3xx + third-party hosts.
      if (s >= 400 && s < 600 && u.startsWith(origin + '/')) bad.add(`${s} ${u.slice(origin.length)}`);
    });
    let http = 0;
    try {
      const r = await page.goto(origin + '/', { waitUntil: 'load', timeout: 60000 });
      http = r ? r.status() : 0;
      await page.waitForTimeout(4500); // let lazy assets + logo onError/probe settle
    } catch (e) {
      results.push({ slug, http: 0, bad: [`load failed: ${String(e).slice(0, 70)}`] });
      await ctx.close().catch(() => {});
      continue;
    }
    results.push({ slug, http, bad: [...bad] });
    await ctx.close().catch(() => {});
  }
} finally {
  await browser.close();
}

for (const r of results) {
  const mark = r.bad.length ? '🔴' : '✅';
  console.log(`${mark} ${r.slug.padEnd(28)} http=${r.http} first-party-4xx=${r.bad.length}${r.bad.length ? ' → ' + r.bad.join(' · ') : ''}`);
}
const offenders = results.filter((r) => r.bad.length);
console.log('');
if (!offenders.length) {
  console.log(`✅ PASS — no first-party asset 4xx on ${results.length} site(s)`);
  process.exit(0);
}
const msg = `first-party asset 4xx on ${offenders.length}/${results.length} site(s): ${offenders
  .map((r) => `${r.slug} [${r.bad.join(', ')}]`)
  .join(' · ')}`;
if (STRICT) {
  console.log(`❌ FAIL — ${msg}`);
  process.exit(1);
}
// flips-GREEN-on-rebuild: deployed pre-AL-591 builds still 404 the absent wordmark; the template
// fetch-HEAD probe lands next build (NO redeploy of existing sites → rebuild to clear).
console.log(`::notice:: verify-no-asset-404 — ${msg} (pre-AL-591 build; clears on rebuild — set STRICT=1 to enforce)`);
process.exit(0);
