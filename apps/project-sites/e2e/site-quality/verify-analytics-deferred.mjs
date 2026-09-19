// verify-analytics-deferred.mjs — § C.2 (CWV/perf) regression guard for the serve-time analytics
// deferral. `site_serving.ts` injects GTM + GA4, but DEFERS their gtm.js/gtag.js DOWNLOAD off the
// critical path (requestIdleCallback + first-interaction gating) — the code comment records this was
// "the #1 TBT contributor (Lighthouse: TBT 3.68s, Perf 32) on every served site". That ~565KB of
// analytics JS (GTM container + gtag.js, each ~120-170KB) executing during load would tank the
// Lighthouse Perf score below C.2's ≥75 floor. The deferral is a big, easy-to-silently-break
// optimization (a refactor that drops the requestIdleCallback wrapper, or reverts to an eager
// `<script async src=…googletagmanager…>`, brings the TBT hit back to EVERY generated site) — and
// until now it had ZERO regression coverage.
//
// This guard asserts, on the DEPLOYED site:
//   1. STATIC: the served HTML contains NO eager analytics loader — no `<script … src="…
//      googletagmanager.com/(gtm|gtag)…">` in the markup (the un-deferred pattern). The loaders must
//      be JS-injected, never a static blocking/async tag in <head>.
//   2. PATTERN: the deferral scaffolding IS present — requestIdleCallback gating + the __gtmL/__ga4L
//      one-shot guards + the interaction listeners (pointerdown/keydown/scroll/touchstart).
//   3. LIVE (advisory): the deferral's PURPOSE is a fast first paint despite ~565KB of analytics.
//      We measure cold FCP and assert ≤3000ms — a reverted deferral (analytics blocking paint)
//      pushes cold FCP into the 3.5-5s "TBT 3.68s" range this catches, while a healthy cold FCP
//      (~1.5-2.5s) passes without flaking. (Advisory; the static+pattern checks are the hard gate.)
//
// Local Chromium ({slug}.projectsites.dev is CF-clean). Auto-joins run-all via the verify-*.mjs glob.
// Usage: SITES=<slug> node e2e/site-quality/verify-analytics-deferred.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSites } from './_default-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SITES = resolveSites(process.env.SITES);
if (SITES.length === 0) {
  console.log('::notice:: verify-analytics-deferred skipped — no site resolved');
  process.exit(0);
}

// An EAGER analytics loader baked into the markup — the regression this guards against. Matches a
// static `<script … src="…googletagmanager.com/gtm.js|gtag/js…">` (async or not). The deferral
// pattern instead JS-injects the loader inside a requestIdleCallback, so the raw HTML has NO such tag.
const EAGER_LOADER = /<script[^>]+src=["'][^"']*googletagmanager\.com\/(gtm\.js|gtag\/js)[^"']*["']/i;

const browser = await chromium.launch();
const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const html = await fetch(`${base}/?cb=${Date.now()}`, { headers: { 'User-Agent': UA } })
      .then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (!html) { check(`${slug} · homepage reachable`, false, 'fetch failed'); continue; }

    // The site may legitimately ship NO analytics (env unset) — then there's nothing to defer, which
    // is trivially "not on the critical path". Only assert the deferral when GTM/GA4 is present.
    const hasAnalytics = /googletagmanager|gtag\(|dataLayer/.test(html);
    if (!hasAnalytics) { check(`${slug} · no analytics injected (nothing to defer)`, true, 'skip'); continue; }

    // 1. STATIC — no eager loader baked into the markup.
    check(`${slug} · no EAGER analytics <script src> in markup (must be JS-injected)`, !EAGER_LOADER.test(html),
      EAGER_LOADER.test(html) ? 'FOUND a static googletagmanager loader — deferral reverted' : 'clean');

    // 2. PATTERN — the deferral scaffolding is present for BOTH GTM + GA4.
    const idle = (html.match(/requestIdleCallback/g) || []).length;
    const guards = /__gtmL/.test(html) && /__ga4L/.test(html);
    const interaction = /pointerdown|touchstart/.test(html) && /addEventListener/.test(html);
    check(`${slug} · deferral scaffolding present (requestIdleCallback ×${idle} + __gtmL/__ga4L + interaction gate)`,
      idle >= 2 && guards && interaction, `idle=${idle} guards=${guards} interaction=${interaction}`);

    // 2b. STATIC — the sibling serve-time perf transform: Google-Fonts stylesheets are asyncified
    // (`asyncifyRenderBlockingFonts` → media="print" onload). A blocking font <link> in <head>
    // delays FCP by a cross-origin RTT + stalls the anti-FOUC gate. Same "easy-to-silently-break
    // serve-time optimization, zero regression guard" class as the analytics deferral.
    const fontLinks = (html.match(/<link\b[^>]*>/gi) || []).filter(
      (t) => /fonts\.googleapis\.com\/css2/.test(t) && /rel=["']?stylesheet/i.test(t));
    const blockingFonts = fontLinks.filter((t) => !/media=["']?print/i.test(t));
    check(`${slug} · Google-Fonts stylesheets asyncified (media=print, never render-blocking)`,
      blockingFonts.length === 0,
      blockingFonts.length ? `${blockingFonts.length} BLOCKING font link(s) — asyncify reverted` : `${fontLinks.length} font link(s), all async`);

    // 3. LIVE (advisory) — first paint stays fast despite the heavy (deferred) analytics.
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    // First-contentful-paint from the paint timeline (ms since navigation start). Wait for the
    // entry to register (the paint fires shortly after DCL); poll up to ~3s.
    const fcp = await page.waitForFunction(() => {
      const e = performance.getEntriesByName('first-contentful-paint')[0];
      return e ? Math.round(e.startTime) : false;
    }, { timeout: 3000 }).then((h) => h.jsonValue()).catch(() => null);
    check(`${slug} · first paint stays fast despite deferred analytics (cold FCP ≤ 3000ms, advisory)`,
      fcp === null || fcp <= 3000, fcp === null ? 'FCP unavailable' : `FCP=${fcp}ms`);
    await ctx.close().catch(() => {});
  }
} catch (e) {
  check('analytics-deferred audit completed', false, 'error: ' + String(e).slice(0, 120));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(72)} ${r.detail}`);
// The advisory live-timing check (label 3) never hard-fails — CI-runner jitter can fire idle early;
// the STATIC + PATTERN checks are the authoritative gate (a real un-defer reverts those).
const hardFails = rows.filter((r) => !r.ok && !/advisory/.test(r.label)).length;
console.log(
  fails === 0
    ? '\n✅ PASS — serve-time analytics stays deferred off the critical path (no eager loader, requestIdleCallback + interaction gating intact) — the C.2 TBT optimization holds.'
    : `\n${hardFails ? '❌ FAIL' : '🟡 NOTICE'} — ${fails} check(s) unmet (${hardFails} hard) — a reverted analytics deferral re-adds ~565KB/≈TBT-3.68s to every served site.`,
);
process.exit(hardFails ? 1 : 0);
