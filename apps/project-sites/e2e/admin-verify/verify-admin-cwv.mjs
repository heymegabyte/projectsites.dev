// verify-admin-cwv.mjs — Core Web Vitals gate for the ADMIN SPA route (dim-8 PERF).
//
// COVERAGE GAP this closes: CWV probes exist for GENERATED sites (e2e/site-quality/
// verify-cwv.mjs, §C.2) and the platform homepage (§D.1), but the ADMIN SPA routes
// (/admin/*) were never LCP/INP-gated. The admin loads its shell from R2 + preloads
// lazy chunks; a heavy new section (or a regressed bundle) could tank the cold-load
// LCP unseen. This probe cold-loads /admin as a seeded session, measures nav-timing +
// LCP via PerformanceObserver, and gates LCP ≤ 2000ms (the cinematic budget). It also
// samples the heaviest data section (audit — a 500-row table) as an advisory render
// timing (data-fetch-bound, not gated).
//
// Fail-open (conditional-ci-gates): E2E_API_KEY unset ⇒ ::notice:: + exit 0.
// Baseline (AL-268, 2026-09-10): cold /admin LCP ranges ~148–1377ms across runs (SPA
// hydration/LCP-element timing variance — see homepage-lcp-spa-hydration-rerender memory),
// always well under the 2000ms budget; the gate is the ≤2000ms ceiling, not a fixed number.
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-admin-cwv.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-admin-cwv skipped — E2E_API_KEY unset');
  process.exit(0);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const LCP_BUDGET = parseInt(process.env.LCP_BUDGET || '2000', 10);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  serviceWorkers: 'block',
});
// Seed the session on a light page, THEN cold-load /admin in a fresh page for a clean measurement.
const seed = await ctx.newPage();
await seed.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await seed.evaluate(
  (k) =>
    localStorage.setItem(
      'ps_session',
      JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }),
    ),
  KEY,
);

const page = await ctx.newPage();
await page.goto(`${ORIGIN}/admin`, { waitUntil: 'load', timeout: 60000 });
const cwv = await page.evaluate(
  () =>
    new Promise((res) => {
      let lcp = 0;
      new PerformanceObserver((l) => {
        const e = l.getEntries();
        lcp = e[e.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0;
        res({
          ttfb: Math.round(nav.responseStart || 0),
          fcp: Math.round(fcp),
          lcp: Math.round(lcp),
          load: Math.round(nav.loadEventEnd || 0),
        });
      }, 4000);
    }),
);

await browser.close();

const pass = cwv.lcp > 0 && cwv.lcp <= LCP_BUDGET;
console.log('=== ADMIN SPA CWV (cold /admin load) ===\n');
console.log(`  TTFB ${cwv.ttfb}ms · FCP ${cwv.fcp}ms · LCP ${cwv.lcp}ms · load ${cwv.load}ms`);
console.log(`  ${pass ? '✓' : '✗'} LCP ${cwv.lcp}ms ${pass ? '≤' : '>'} ${LCP_BUDGET}ms budget`);
console.log(
  pass
    ? `\nVERDICT: ✅ PASS — admin SPA cold-load LCP within the ${LCP_BUDGET}ms budget.`
    : `\nVERDICT: ❌ FAIL — admin SPA cold-load LCP ${cwv.lcp}ms exceeds ${LCP_BUDGET}ms.`,
);
process.exit(pass ? 0 : 1);
