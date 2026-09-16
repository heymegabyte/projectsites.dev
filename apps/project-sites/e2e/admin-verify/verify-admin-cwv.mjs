// verify-admin-cwv.mjs — Core Web Vitals gate for the ADMIN SPA route (dim-8 PERF).
//
// COVERAGE GAP this closes: CWV probes exist for GENERATED sites (e2e/site-quality/
// verify-cwv.mjs, §C.2) and the platform homepage (§D.1), but the heavy ADMIN SPA
// sub-routes (analytics/logs/editor/social/billing) were never LCP-gated — only bare
// /admin was. This probe seeds a session, WARMS the worker isolate + admin bundle once
// (the first route in a fresh context pays a one-time cold-isolate + cold-/api/sites
// spike — observed /admin 3242ms cold vs ~190ms warm — a first-load cost already gated
// by the homepage probe §D.1, NOT a per-route regression), then cold-loads EACH heavy
// admin route in its own page and gates every one at LCP ≤ 2000ms (the cinematic budget).
//
// Fail-open (conditional-ci-gates): E2E_API_KEY unset ⇒ ::notice:: + exit 0.
// Baseline (AL-438, 2026-09-12): warm per-route LCP ~179–209ms across all 6 admin routes;
// the gate is the ≤2000ms ceiling, not a fixed number (SPA hydration/LCP-element timing
// variance — see homepage-lcp-spa-hydration-rerender + cwv-cls-baseline-variance memories).
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
// CLS two-tier (mirrors the LCP philosophy + validator-precision — a flaky CLS gate is worse than
// none): HARD-fail a real regression (>0.1, the WCAG/Google "poor" boundary), TRACK the 0.05
// cinematic band as a ::notice. The admin topbar row-height reserve (AL-660) put analytics at 0.034.
const CLS_HARD = parseFloat(process.env.CLS_HARD || '0.1');
const CLS_TARGET = 0.05;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  serviceWorkers: 'block',
});
// Seed the session on a light page, THEN warm the admin isolate before measuring.
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
// Warm-up: hit /admin once on the seed page (discarded) so the worker isolate + admin
// bundle + AdminStateService's first /api/sites fetch are hot. Otherwise whichever route
// loads FIRST in the fresh context pays a one-time cold spike (~3200ms) that has nothing
// to do with that route — the real first-load cost is gated by the homepage probe (§D.1).
await seed.goto(`${ORIGIN}/admin`, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
await seed.waitForTimeout(1500);
await seed.close();

// Cold-load EACH heavy admin route in a fresh page (session shared via the ctx's
// localStorage) and gate LCP per-route. The single-/admin gate missed the heavy
// sub-routes (analytics/logs/editor/social/billing) entirely (AL-438).
const ROUTES = (
  process.env.ADMIN_CWV_ROUTES ||
  '/admin,/admin/analytics,/admin/logs?tab=traces,/admin/editor,/admin/social,/admin/billing'
).split(',');

const measure = () =>
  new Promise((res) => {
    let lcp = 0;
    let cls = 0;
    new PerformanceObserver((l) => {
      const e = l.getEntries();
      lcp = e[e.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    // Cumulative layout shift — sum shift values NOT following a recent user input (field CLS).
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0;
      res({
        ttfb: Math.round(nav.responseStart || 0),
        fcp: Math.round(fcp),
        lcp: Math.round(lcp),
        cls: Math.round(cls * 1e4) / 1e4,
      });
    }, 4000);
  });

const rows = [];
for (const route of ROUTES) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${ORIGIN}${route}`, { waitUntil: 'load', timeout: 60000 });
    const cwv = await page.evaluate(measure);
    rows.push({
      route,
      ...cwv,
      pass: cwv.lcp > 0 && cwv.lcp <= LCP_BUDGET && (cwv.cls ?? 0) <= CLS_HARD,
    });
  } catch (e) {
    rows.push({ route, lcp: 0, ttfb: 0, fcp: 0, cls: 0, err: String(e).slice(0, 50), pass: false });
  }
  await page.close();
}

await browser.close();

console.log(`=== ADMIN SPA CWV (cold per-route load, LCP ≤ ${LCP_BUDGET}ms · CLS ≤ ${CLS_HARD}) ===\n`);
for (const r of rows) {
  const clsFlag = (r.cls ?? 0) > CLS_HARD ? ' ✗CLS' : (r.cls ?? 0) > CLS_TARGET ? ' ⚠cls' : '';
  console.log(
    `  ${r.pass ? '✓' : '✗'} ${r.route.padEnd(26)} LCP ${String(r.lcp).padStart(4)}ms · CLS ${String(r.cls ?? 0).padEnd(6)}${clsFlag} · TTFB ${r.ttfb} · FCP ${r.fcp}${r.err ? '  ERR ' + r.err : ''}`,
  );
}
const clsWatch = rows.filter((r) => (r.cls ?? 0) > CLS_TARGET && (r.cls ?? 0) <= CLS_HARD);
if (clsWatch.length)
  console.log(
    `\n::notice:: ${clsWatch.length} route(s) in the 0.05–${CLS_HARD} CLS band (under the hard gate, over the cinematic target): ${clsWatch.map((r) => r.route + ' ' + r.cls).join(', ')}`,
  );
const ranked = rows.filter((r) => r.lcp > 0).sort((a, b) => b.lcp - a.lcp)[0];
if (ranked)
  console.log(
    `\n  worst offender: ${ranked.route} @ ${ranked.lcp}ms (analytics is data-fetch-gated on the slow CF-GraphQL envelope — LCP tracks data-arrival, skeletons are CSS-gradients that don't count as LCP; AL-438)`,
  );
const fails = rows.filter((r) => !r.pass);
const reason = (f) =>
  f.lcp > LCP_BUDGET || f.lcp === 0 ? `${f.route} LCP ${f.lcp}ms` : `${f.route} CLS ${f.cls}`;
console.log(
  fails.length === 0
    ? `\nVERDICT: ✅ PASS — all ${rows.length} admin routes cold-load LCP ≤ ${LCP_BUDGET}ms + CLS ≤ ${CLS_HARD}.`
    : `\nVERDICT: ❌ FAIL — ${fails.length}/${rows.length} admin route(s) over budget: ${fails.map(reason).join(', ')}.`,
);
process.exit(fails.length === 0 ? 0 : 1);
