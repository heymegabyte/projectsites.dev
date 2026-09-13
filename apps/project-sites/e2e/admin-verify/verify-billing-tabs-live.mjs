// verify-billing-tabs-live.mjs — ADMIN COMPLETENESS facet-7 (EVERY CONTROL REAL) for the
// REVENUE-critical /admin/billing section. Its 6 tabs (Subscription / Add-ons / Wallet /
// Usage-Metering / Agency-Connect / Affiliates) are the primary "is every control real?" surface —
// a DEAD tab (doesn't switch / doesn't render its own panel) is a whole missing billing view, and
// a 4xx on tab-load (the exact class the analytics Activation-Funnel tab shipped — AL-458: 3× /api/
// admin 403s leaking console errors to every user) is invisible to render/contract gates. This
// drives every billing tab as brian in a real browser and asserts each: (a) becomes aria-selected,
// (b) swaps to its own distinct panel, (c) never throws a console error OR a non-ingest API 4xx.
//
// Real Chromium, ps_session seeded from E2E_API_KEY (from ENV). Skips (exit 0) when unset so
// forks / secret-less CI stay green. Usage:
//   E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-billing-tabs-live.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.log('::notice:: verify-billing-tabs-live skipped — E2E_API_KEY unset'); process.exit(0); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /analytics|posthog|ingest|cf-|challenge|beacon|gtm|doubleclick|sentry|clarity|hotjar|Failed to load resource.*(analytics|ingest|posthog)/i;

const TABS = [
  { testid: 'billing-tab-subscription', label: 'Subscription' },
  { testid: 'billing-tab-addons', label: 'Add-ons' },
  { testid: 'billing-tab-wallet', label: 'Wallet' },
  { testid: 'billing-tab-usage', label: 'Usage / Metering' },
  { testid: 'billing-tab-agency', label: 'Agency / Connect' },
  { testid: 'billing-tab-affiliates', label: 'Affiliates' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
const api4xx = [];
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 100)); });
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errs.push('pageerror: ' + String(e).slice(0, 100)); });
page.on('response', (r) => { if (r.status() >= 400 && /\/api\//.test(r.url()) && !IGNORE.test(r.url())) api4xx.push(`${r.status()} ${r.url().replace(ORIGIN, '').slice(0, 60)}`); });

const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };
const panelText = () =>
  page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    return (main.innerText || '').replace(/\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?/gi, '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  });

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);
  await page.goto(`${ORIGIN}/admin/billing`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="billing-tab-subscription"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const seen = [];
  for (const t of TABS) {
    const el = page.locator(`[data-testid="${t.testid}"]`).first();
    if (!(await el.isVisible().catch(() => false))) {
      check(`${t.label} tab present + operable`, false, 'tab control NOT found/visible (missing billing view)');
      continue;
    }
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900);
    const selected = await el.getAttribute('aria-selected').catch(() => null);
    const txt = await panelText();
    const dup = seen.find((s) => s.txt === txt);
    seen.push({ label: t.label, txt });
    check(
      `${t.label} tab is real (aria-selected + own panel content)`,
      selected === 'true' && !dup && txt.length > 0,
      `aria-selected=${selected} content=${txt.length}c${dup ? ` DUP-of:${dup.label}` : ''}`,
    );
  }
  check('no console error across all 6 billing tab switches', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');
  check('no non-ingest API 4xx across all 6 billing tab switches (revenue-critical)', api4xx.length === 0, api4xx.length ? api4xx.slice(0, 3).join(' | ') : 'clean');
} catch (e) {
  check('probe ran', false, String(e).slice(0, 120));
} finally {
  await browser.close();
}

console.log('\n━━ facet-7 · /admin/billing — every tab is a real, distinct, crash-free, 4xx-free view ━━');
rows.forEach((r) => console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}  ${r.detail}`));
console.log(
  fails === 0
    ? `\nVERDICT: ✅ PASS — all 6 billing tabs switch to a real distinct panel, aria-selected, 0 console errors, 0 API 4xx.`
    : `\nVERDICT: 🔴 ${fails} check(s) failed — a dead / inert / erroring billing tab (facet-7 gap on the revenue section).`,
);
process.exit(fails === 0 ? 0 : 1);
