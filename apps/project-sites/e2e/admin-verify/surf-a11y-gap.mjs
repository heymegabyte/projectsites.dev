// Authed admin a11y surf of the sections NOT covered by admin-a11y-critical*.spec.ts
// (analytics + a few controls). Seeds ps_session from E2E_API_KEY (env, never inline).
// Gotchas honored: newContext (AxeBuilder), domcontentloaded (networkidle hangs on served sites).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// playwright-core + @axe-core/playwright via createRequire from the frontend dir — reliably
// hoisted after `npm ci`; bare `import from 'playwright'` throws MODULE_NOT_FOUND when unhoisted
// (AL-144). Matches admin-surf-audit.mjs exactly.
const require2 = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'));
const { chromium } = require2('playwright-core');
const AxeBuilder = require2('@axe-core/playwright').default;

const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.error('E2E_API_KEY env required'); process.exit(2); }
const ORIGIN = 'https://projectsites.dev';
const SECTIONS = process.env.SECTIONS ? process.env.SECTIONS.split(',') : ['analytics', 'settings', 'domains', 'feature-flags'];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });

await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => {
  localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }));
}, KEY);

for (const s of SECTIONS) {
  errs.length = 0;
  try {
    await page.goto(`${ORIGIN}/admin/${s}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const finalUrl = page.url().replace(ORIGIN, '');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const v = results.violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, ex: (x.nodes[0]?.target || []).join(' ') }));
    console.log(`\n/admin/${s}  → landed ${finalUrl}`);
    console.log('  axe violations:', v.length ? JSON.stringify(v) : 'NONE ✓');
    console.log('  console errors:', errs.length, errs.slice(0, 2).join(' | '));
  } catch (e) {
    console.log(`\n/admin/${s}  → ERROR ${String(e.message || e).slice(0, 100)}`);
  }
}
await browser.close();
