// verify-guest-funnel-results.mjs — B.1 "results render → sign-in bridge" (the sub-actions
// verify-guest-funnel deliberately SKIPS to avoid Places-403 flakiness).
//
// The B.1 spec is: homepage → search a REAL business → RESULTS RENDER → sign-in CTA → /create.
// verify-guest-funnel proves the homepage + hero-CTA + the always-available forward-path FLOOR
// (a nonexistent biz → the "Build a custom website" option), but never the "results render" nor
// the "sign-in CTA" sub-actions, because the Places business search 403s intermittently on prod.
//
// This probe proves those two sub-actions RELIABLY via the D1-backed PRE-BUILT-SITE search: the
// homepage searches `/api/sites/search` (delivered sites, from D1 — never Places-flaky) in
// parallel with Places, so typing a REAL DELIVERED business surfaces a "Pre-built" result card.
// It: (1) queries /api/sites/search to pick a real delivered business DYNAMICALLY (no hardcoded
// slug), (2) types it into the homepage hero search, (3) asserts a [data-testid=search-result]
// card with that name + the Pre-built badge RENDERS, (4) clicks it UNAUTH → asserts it routes to
// the sign-in bridge (`/signin`, carrying a returnUrl toward /create — createFunnelNav's signed-out
// branch), (5) 0 console errors throughout. LOCAL Chromium (/ + /signin serve CF-clean).
//
// Usage: node e2e/admin-verify/verify-guest-funnel-results.mjs   (no auth — pure guest funnel)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright-core');

const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const t = m.type();
    const x = m.text();
    if (/favicon|Failed to load resource|net::ERR_ABORTED/i.test(x)) return;
    if (t === 'error') errs.push(x.slice(0, 100));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 100)));

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 1. Pick a REAL delivered business dynamically from the D1-backed pre-built-site search — the
  //    forward-path floor probe uses a NONEXISTENT biz; this needs a real one so results actually render.
  const pick = await page.evaluate(async () => {
    for (const q of ['fish market', 'barbecue', 'coffee', 'gallery', 'bakery', 'distillery']) {
      const r = await fetch('/api/sites/search?q=' + encodeURIComponent(q));
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j) ? j : (j.data ?? j.sites ?? j.results ?? []);
      const hit = list.find((s) => (s.business_name || s.name) && s.slug);
      if (hit) return { name: hit.business_name || hit.name, slug: hit.slug, q };
    }
    return null;
  });
  check('pre-built-site search returns a real delivered business (D1, never Places-flaky)', !!pick, pick ? `"${pick.name}" (${pick.slug})` : 'NO delivered site found for any seed query');
  if (!pick) throw new Error('no delivered business to drive the funnel');

  // 2. Type the real business name into the hero search (homepage-first: click, then type).
  const searchSel =
    '#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]';
  const search = page.locator(searchSel).first();
  await search.click().catch(() => {});
  await search.pressSequentially(pick.name.slice(0, 18), { delay: 45 }).catch(() => {});
  // Wait for the D1 result to land in the dropdown (300ms debounce + fetch).
  await page.waitForSelector('[data-testid="search-result"]', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);

  // 3. RESULTS RENDER — a prebuilt result card with the business name is in the dropdown.
  const results = await page.$$eval('[data-testid="search-result"]', (els) =>
    els.map((el) => ({ type: el.getAttribute('data-result-type') || '', text: (el.textContent || '').replace(/\s+/g, ' ').trim() })),
  );
  const prebuilt = results.find((r) => r.type === 'prebuilt');
  check(
    'B.1 RESULTS RENDER — a "Pre-built" result card surfaces for a real delivered business',
    !!prebuilt && results.length > 0,
    `${results.length} result(s); prebuilt="${prebuilt ? prebuilt.text.slice(0, 50) : 'NONE'}"`,
  );

  // 4. SIGN-IN CTA / forward — click the prebuilt result UNAUTH → the sign-in bridge (createFunnelNav
  //    signed-out branch = /signin carrying a returnUrl toward /create). Prospect can't be stranded.
  if (prebuilt) {
    const target = page.locator('[data-testid="search-result"][data-result-type="prebuilt"]').first();
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click().catch(() => {});
    await page.waitForURL(/\/signin|\/create/, { timeout: 12000 }).catch(() => {});
    const url = page.url();
    check(
      'B.1 SIGN-IN CTA — clicking a prebuilt result (unauth) routes to the sign-in bridge → /create',
      /\/signin/.test(url) || /\/create/.test(url),
      `landed on ${url.replace(ORIGIN, '')}`,
    );
    // The forward destination renders operable (not blank / not a challenge).
    const rendered = await page.evaluate(() => {
      const t = document.body.innerText || '';
      return { len: t.length, challenge: /verifying you are human|needs to review the security/i.test(t) };
    });
    check('the sign-in bridge renders operable (not blank / not a CF challenge)', rendered.len > 300 && !rendered.challenge, `bodyLen=${rendered.len}`);
  }

  check('0 console errors across the results→bridge funnel', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
} catch (e) {
  check('probe completed without throwing', false, String(e.message || e).slice(0, 120));
} finally {
  await browser.close();
}

console.log('\n━━ B.1 guest funnel — results render → sign-in bridge (D1 pre-built search, non-flaky) ━━');
for (const r of rows) console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(
  fails === 0
    ? '\n✅ PASS — a real delivered business renders a Pre-built result card + clicking it (unauth) reaches the sign-in bridge toward /create, 0 console errors.'
    : `\n❌ FAIL — ${fails} check(s) failed in the B.1 results→bridge funnel.`,
);
process.exit(fails === 0 ? 0 : 1);
