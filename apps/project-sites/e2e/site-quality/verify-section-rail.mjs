// verify-section-rail.mjs — the Cinematic Section Rail (section_rail) contract on a DEPLOYED build.
// The Apple / Awwwards-2026 "scroll navigation" pattern, made embarrassingly-easy: a desktop-only,
// left-edge navigator AUTO-DERIVED from the page's own sections (owner never configures). Contract:
//   A. On a long page (≥4 labeled sections) with the flag on, the rail renders: <nav aria-label>
//      + a real `#anchor` dot per section + an active indicator. (flag-off / short pages → absent.)
//   B. RENDER-HONEST — no rail label is an unfilled `{TOKEN}` (site-gen fills real headings).
//   C. Clicking a dot scrolls to that section AND moves `aria-current` (jump-to-convert works).
//   D. a11y — nav has an accessible name; every item is a keyboard-focusable `#anchor`.
//   E. 0 console errors throughout.
//
// The proof surface is the TEMPLATE DEMO (template.projectsites.dev, built with VITE_SECTION_RAIL=1)
// — a delivered site only shows the rail once site-gen enables the flag on its build. Local Chromium
// against the deployed Pages build (CF-clean). Override with RAIL_BASE / RAIL_PATH for a preview.
// Root-cause fixes are in the TEMPLATE (SectionRail.tsx + `.ps-section-rail*` CSS), never a one-off.
import { chromium } from 'playwright';

const BASE = process.env.RAIL_BASE || 'https://template.projectsites.dev';
const PATH = process.env.RAIL_PATH || '/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /favicon|posthog|\/ingest|GL Driver|net::ERR_ABORTED|Failed to load resource/i;

let fails = 0;
const summary = [];
const fail = (m) => { fails++; summary.push(`  🔴 ${m}`); };
const ok = (m) => summary.push(`  ✅ ${m}`);

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 }, // desktop — the rail is lg-and-up only
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 120)); });
  page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message.slice(0, 100)));

  const url = BASE.replace(/\/$/, '') + PATH;
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  if (!resp || resp.status() !== 200) fail(`${url} not 200 (${resp?.status()})`);
  await page.waitForTimeout(1500); // past the double-rAF derive + hydration

  const rail = page.locator('[data-testid="section-rail"]');
  const present = await rail.count();
  if (!present) {
    fail(`rail absent on ${PATH} — flag not enabled on this build OR <4 real (non-token) sections`);
  } else {
    // A. structure — ≥4 real-#anchor dots + accessible nav name
    const items = page.locator('[data-testid="section-rail-item"]');
    const n = await items.count();
    const aria = await rail.getAttribute('aria-label');
    const hrefs = await items.evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''));
    const labels = await items.evaluateAll((as) =>
      as.map((a) => (a.querySelector('.ps-section-rail-label')?.textContent || '').trim()),
    );
    if (n >= 4) ok(`rail renders ${n} section dots`); else fail(`rail has only ${n} dots (<4)`);
    if (aria) ok(`nav accessible name: "${aria}"`); else fail('nav missing aria-label');
    if (hrefs.every((h) => h.startsWith('#') && h.length > 1)) ok('every dot is a real #anchor'); else fail(`dead/none anchor: ${JSON.stringify(hrefs)}`);

    // B. render-honesty — no {TOKEN} label leaked
    const leaked = labels.filter((l) => /\{[A-Z0-9_]{2,}\}/.test(l));
    if (leaked.length === 0) ok('no {TOKEN} labels (render-honest)'); else fail(`token label(s) leaked: ${JSON.stringify(leaked)}`);

    // C. jump-to-convert — click the LAST dot, assert scroll moved + active followed
    const yBefore = await page.evaluate(() => window.scrollY);
    await items.last().click();
    await page.waitForTimeout(900);
    const yAfter = await page.evaluate(() => window.scrollY);
    const activeNow = await page.locator('[data-testid="section-rail-item"][aria-current="true"]').count();
    if (yAfter > yBefore) ok(`dot click scrolled the page (${yBefore}→${yAfter})`); else fail(`dot click did not scroll (${yBefore}→${yAfter})`);
    if (activeNow === 1) ok('exactly one dot is aria-current after jump'); else fail(`${activeNow} active dots after jump (want 1)`);

    // D. keyboard focusability — the first dot is Tab-reachable + is an <a>
    const focusable = await items.first().evaluate((el) => el.tagName === 'A' && el.tabIndex >= 0);
    if (focusable) ok('dots are keyboard-focusable anchors'); else fail('dots not keyboard-focusable');
  }

  if (errs.length === 0) ok('0 console errors'); else fail(`${errs.length} console error(s): ${errs.slice(0, 2).join(' | ')}`);
  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\nCinematic Section Rail contract @ ${BASE}${PATH}:`);
for (const l of summary) console.log(l);
console.log(`\nVERDICT: ${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
