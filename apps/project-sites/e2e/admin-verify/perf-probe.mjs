// Authed admin perf probe — LCP/FCP + resource weights. Seeds ps_session from E2E_API_KEY.
// Local Playwright (reaches the authed SPA fine); domcontentloaded (networkidle hangs).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// playwright-core via createRequire from the frontend dir — reliably hoisted after `npm ci`;
// bare `import from 'playwright'` throws MODULE_NOT_FOUND when unhoisted (AL-144). Matches admin-surf-audit.mjs.
const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'))(
  'playwright-core',
);
const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.error('E2E_API_KEY required'); process.exit(2); }
const ORIGIN = 'https://projectsites.dev';
const PATHS = process.env.PATHS ? process.env.PATHS.split(',') : ['/admin', '/admin/sites', '/admin/analytics'];
const br = await chromium.launch();
const ctx = await br.newContext();
const page = await ctx.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);
for (const path of PATHS) {
  await page.goto(ORIGIN + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  const m = await page.evaluate(() => new Promise((resolve) => {
    let lcp = 0;
    try { new PerformanceObserver((l) => { const e = l.getEntries(); lcp = e[e.length - 1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* */ }
    setTimeout(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const fcp = (performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint') || {}).startTime || 0;
      const res = performance.getEntriesByType('resource');
      const js = res.filter((r) => r.name.endsWith('.js')).reduce((a, r) => a + (r.transferSize || 0), 0);
      const top = res.map((r) => ({ u: r.name.split('/').pop().slice(0, 42), kb: Math.round((r.transferSize || 0) / 1024), ms: Math.round(r.duration) })).sort((a, b) => b.kb - a.kb).slice(0, 6);
      resolve({ lcp: Math.round(lcp), fcp: Math.round(fcp), dcl: Math.round(nav.domContentLoadedEventEnd || 0), jsKB: Math.round(js / 1024), top });
    }, 500);
  }));
  console.log(`\n${path}  LCP=${m.lcp}ms FCP=${m.fcp}ms DCL=${m.dcl}ms jsTransfer=${m.jsKB}KB  LCP≤2000? ${m.lcp > 0 && m.lcp <= 2000 ? 'YES ✓' : 'NO'}`);
  console.log('  top resources:', JSON.stringify(m.top));
}
await br.close();
