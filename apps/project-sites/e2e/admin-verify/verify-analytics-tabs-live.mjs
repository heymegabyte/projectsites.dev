// verify-analytics-tabs-live.mjs — ADMIN COMPLETENESS facet-7 (EVERY CONTROL REAL) for the
// most control-dense admin section: /admin/analytics. Its 8 top tabs (Overview / Live Events /
// Activation Funnel / By Section / Forms / Visitor Funnel / Site Health / Social) are the primary
// "is every control real?" surface — a DEAD tab (one that doesn't switch aria-selected or doesn't
// actually render a different panel) is a whole MISSING analytics view that renders/contract gates
// don't catch (the section loads fine; only the tab is inert). This drives every tab in a real
// browser as brian and asserts each one: (a) becomes aria-selected, (b) actually swaps the panel
// content (not a no-op showing the prior tab), and (c) never throws a console error on select.
//
// Real Chromium, ps_session seeded from E2E_API_KEY (from ENV). Skips (exit 0) when E2E_API_KEY is
// unset so forks / secret-less CI stay green. Usage:
//   E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-analytics-tabs-live.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.log('::notice:: verify-analytics-tabs-live skipped — E2E_API_KEY unset'); process.exit(0); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// Third-party beacon + CF challenge noise are not tab defects.
const IGNORE = /analytics|posthog|ingest|cf-|challenge|beacon|gtm|doubleclick|sentry|clarity|hotjar|Failed to load resource.*(analytics|ingest|posthog)/i;

// The 8 tabs by stable data-testid (from analytics.component role="tab" strip).
const TABS = [
  { testid: 'analytics-tab-overview', label: 'Overview' },
  { testid: 'analytics-tab-live', label: 'Live Events' },
  { testid: 'analytics-tab-funnel', label: 'Activation Funnel' },
  { testid: 'analytics-tab-sections', label: 'By Section' },
  { testid: 'analytics-tab-forms', label: 'Forms' },
  { testid: 'analytics-tab-visitor', label: 'Visitor Funnel' },
  { testid: 'analytics-tab-health', label: 'Site Health' },
  { testid: 'analytics-tab-social', label: 'Social' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 100)); });
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errs.push('pageerror: ' + String(e).slice(0, 100)); });

const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

// The tab panel: the section's live-content region below the tab strip. We hash its text to detect
// a real content swap between tabs (a dead tab keeps the prior tab's content verbatim).
const panelText = () =>
  page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    return (main.innerText || '').replace(/Refreshing in \d+s|Retrying in \d+s|\d{1,2}:\d{2}:\d{2}\s?(AM|PM)?/gi, '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  });

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);
  await page.goto(`${ORIGIN}/admin/analytics`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="analytics-tab-overview"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const seenText = [];
  for (const t of TABS) {
    const el = page.locator(`[data-testid="${t.testid}"]`).first();
    if (!(await el.isVisible().catch(() => false))) {
      check(`${t.label} tab present + operable`, false, 'tab control NOT found/visible (missing view)');
      continue;
    }
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900); // let the panel swap + any lazy fetch settle
    const selected = await el.getAttribute('aria-selected').catch(() => null);
    const txt = await panelText();
    // Content must differ from EVERY previously-seen tab (a dead tab echoes a prior panel verbatim).
    const dup = seenText.find((s) => s.txt === txt);
    const contentSwapped = !dup;
    seenText.push({ label: t.label, txt });
    check(
      `${t.label} tab is real (aria-selected + own panel content)`,
      selected === 'true' && contentSwapped && txt.length > 0,
      `aria-selected=${selected} content=${txt.length}c${dup ? ` DUP-of:${dup.label}` : ''}`,
    );
  }
  check('no console error across all 8 tab switches', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');
} catch (e) {
  check('probe ran', false, String(e).slice(0, 120));
} finally {
  await browser.close();
}

console.log('\n━━ facet-7 · /admin/analytics — every top tab is a real, distinct, crash-free view ━━');
rows.forEach((r) => console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}  ${r.detail}`));
console.log(
  fails === 0
    ? `\nVERDICT: ✅ PASS — all 8 analytics tabs switch to a real distinct panel, aria-selected, 0 console errors (no dead control).`
    : `\nVERDICT: 🔴 ${fails} check(s) failed — a dead / inert / crashing analytics tab (facet-7 gap). Build the real behavior.`,
);
process.exit(fails === 0 ? 0 : 1);
