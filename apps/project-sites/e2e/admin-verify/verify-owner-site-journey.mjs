#!/usr/bin/env node
/**
 * verify-owner-site-journey.mjs — the RETURNING-OWNER "manage my site" journey (§ B, FULL-FLOW).
 *
 * The FULL JOURNEY loop owns the acquisition path (guest → search → create → build → published →
 * analytics). The daily-use loop for a PAYING owner — sign in, open one of my sites, walk its detail
 * tabs — had unit-level `site-detail-tabs.spec.ts` coverage but NO durable headless-PROD probe proving
 * it end-to-end as ONE cohesive click-through. This closes that: a returning owner lands on /admin,
 * sees their real sites, CLICKS into one, and every site-detail tab renders real content (no error
 * boundary, no blank, no console error) — the exact flow an owner runs every day.
 *
 * Homepage-first + CLICK-ONLY after the seed load: seed ps_session on /admin (the auth boundary), then
 * navigate by clicking — the sites row, then each `sd-tab-*` — never a post-load goto.
 *
 * Local Chromium (the authed admin shell is NOT CF-bot-challenged). E2E_API_KEY unlocks e2e-test-org,
 * which has ≥1 seeded site. Skips (exit 0) when E2E_API_KEY is unset so forks / secret-less CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-owner-site-journey.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-owner-site-journey skipped — E2E_API_KEY unset');
  process.exit(0);
}
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(resolve(__dirname, '../../frontend/'))('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const errs = [];
let cur = 'boot';

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.type(),
      x = m.text();
    if (/Failed to load resource|net::ERR_ABORTED|favicon|status of 4|status of 5|\[PostHog\]/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(`[${cur}] ${x.slice(0, 90)}`);
  });
  page.on('pageerror', (e) => errs.push(`[${cur}][pageerror] ${(e.message || String(e)).slice(0, 90)}`));

  // ── 1. Seed the session on the auth boundary, land on the dashboard ──
  cur = 'seed';
  await page.goto(`${ORIGIN}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(
    (k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })),
    KEY,
  );
  cur = 'dashboard';
  await page.goto(`${ORIGIN}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('a[href*="/admin/sites/"]', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // ── 2. The owner sees their real sites ──
  const siteRows = page.locator('a[href*="/admin/sites/"]');
  const rowCount = await siteRows.count();
  check('returning owner sees ≥1 of their sites on the dashboard', rowCount >= 1, `${rowCount} site row(s)`);
  if (rowCount === 0) throw new Error('no sites to manage — cannot walk the journey');

  // ── 3. CLICK into a site (never goto) → the detail loads with a real business name ──
  cur = 'open-site';
  await siteRows.first().click();
  await page.waitForURL(/\/admin\/sites\/[0-9a-f-]{8,}/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const detail = await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const body = (document.body.innerText || '').slice(0, 4000);
    return {
      url: location.pathname,
      h1,
      crashed: /something went wrong|failed to load|unexpected error/i.test(body),
      // the owner's key reference: WHERE their site is live (the subdomain, shown under the H1)
      showsLiveUrl: /[a-z0-9-]+\.projectsites\.dev/i.test(body),
    };
  });
  check('clicking a site row opens its detail (URL /admin/sites/:id)', /\/admin\/sites\/[0-9a-f-]{8,}/.test(detail.url), detail.url);
  check(
    'detail renders a real business name H1 (not blank / Dashboard / error-boundary)',
    !!detail.h1 && detail.h1 !== 'Dashboard' && !detail.crashed,
    `h1="${detail.h1.slice(0, 40)}"`,
  );
  check('detail shows the owner WHERE their site is live ({slug}.projectsites.dev)', detail.showsLiveUrl);

  // ── 4. Walk EVERY site-detail tab by CLICK — each renders real content, no crash ──
  cur = 'tabs';
  const tabSel = '[data-testid^="sd-tab-"]:not([data-testid="sd-tab-strip"])';
  await page.waitForSelector(tabSel, { timeout: 15000 }).catch(() => {});
  const tabIds = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((e) => e.getAttribute('data-testid')),
    tabSel,
  );
  check('site-detail exposes a tab strip', tabIds.length >= 3, `${tabIds.length} tabs: ${tabIds.join(',')}`);
  const tabResults = [];
  for (const id of tabIds) {
    cur = id;
    const tab = page.locator(`[data-testid="${id}"]`).first();
    if (!(await tab.count())) continue;
    await tab.click().catch(() => {});
    await page.waitForTimeout(1200);
    const panel = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const txt = (main.innerText || '').trim();
      return { len: txt.length, crashed: /something went wrong|failed to load|unexpected error/i.test(txt.slice(0, 3000)) };
    });
    const ok = panel.len >= 40 && !panel.crashed;
    tabResults.push(`${id.replace('sd-tab-', '')}${ok ? '' : `✗(${panel.crashed ? 'crash' : 'len' + panel.len})`}`);
    if (!ok) fails++;
  }
  check('every site-detail tab renders real content (no crash / blank)', !tabResults.some((t) => t.includes('✗')), tabResults.join(' · '));

  // ── 5. The whole journey is console-error-free ──
  check('0 console errors across the full manage journey', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: '/tmp/owner-site-journey.png' }).catch(() => {});
} catch (e) {
  check(`journey completes without throwing`, false, `[${cur}] ${String(e.message || e).slice(0, 100)}`);
} finally {
  await browser.close();
}

console.log('\n━━ § B returning-owner MANAGE journey (dashboard → open site → walk detail tabs) ━━');
rows.forEach((r) => console.log(r));
const ok = fails === 0;
console.log(
  ok
    ? '\n✓ MANAGE JOURNEY PASS — a returning owner opens a site and every detail tab renders real content, 0 console errors.'
    : `\n🔴 MANAGE JOURNEY FAIL — ${fails} break(s) in the owner's daily manage loop.`,
);
process.exit(ok ? 0 : 1);
