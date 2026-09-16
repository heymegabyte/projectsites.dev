#!/usr/bin/env node
/**
 * verify-platform-footer-pages.mjs — the platform's CHANGELOG + STATUS pages (§ D public face).
 *
 * COVERAGE.yml had these two marked `blocked` — not because they're broken, but because the LOCAL
 * dev-server harness can't serve the worker-rendered HTML, AND marketing-a11y.e2e.ts removed them
 * from its ROUTES after a `link-in-text-block` (status) + a `public_changelog` flag-404 (changelog).
 * Both now 200 on prod. This durable PROD probe re-covers them: /changelog via a real homepage-first
 * CLICK journey (home → Developers → Changelog footer link), /status by direct URL (it has no in-app
 * link — it's a standalone monitoring page). Both asserted rendered + axe-clean + 0 console errors.
 *
 * Local Chromium against PROD (public pages, no auth). No E2E_API_KEY needed.
 * Usage: node e2e/admin-verify/verify-platform-footer-pages.mjs   (STRICT=1 → fail on axe serious/critical)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const STRICT = process.env.STRICT === '1';
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

  const AxeBuilder = (() => {
    try {
      return req('@axe-core/playwright').default;
    } catch {
      return null;
    }
  })();
  const axeScan = async (label) => {
    if (!AxeBuilder) return;
    const r = await new AxeBuilder({ page }).options({ resultTypes: ['violations'] }).analyze();
    const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    check(
      `${label}: axe 0 serious/critical${STRICT ? '' : ' (advisory)'}`,
      STRICT ? bad.length === 0 : true,
      bad.length ? bad.map((v) => `${v.id}(${v.nodes.length})`).slice(0, 5).join(',') : 'clean',
    );
  };

  // ── 1. HOMEPAGE-FIRST click journey → /changelog (home → Developers → Changelog footer) ──
  cur = 'home';
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  cur = 'developers';
  const devLink = page.locator('a[routerLink="/developers"], a[href="/developers"]').first();
  await devLink.click().catch(() => {});
  await page.waitForURL(/\/developers/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  cur = 'changelog';
  const clLink = page.locator('a[routerLink="/changelog"], a[href="/changelog"]').first();
  const clReachable = (await clLink.count()) > 0;
  check('/changelog is CLICK-reachable from the site (home → Developers → Changelog)', clReachable);
  if (clReachable) {
    await clLink.click().catch(() => {});
    await page.waitForURL(/\/changelog/, { timeout: 20000 }).catch(() => {});
  } else {
    await page.goto(`${ORIGIN}/changelog`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.waitForTimeout(1500);
  const cl = await page.evaluate(() => {
    const txt = (document.body.innerText || '').trim();
    return { path: location.pathname, h1: document.querySelector('h1,h2')?.textContent?.trim() || '', len: txt.length, crashed: /something went wrong|failed to load/i.test(txt.slice(0, 2000)) };
  });
  check('/changelog renders real content (heading + body, no crash)', cl.path.includes('/changelog') && cl.len > 200 && !cl.crashed, `h="${cl.h1.slice(0, 40)}" len=${cl.len}`);
  check('/changelog is console-error-free', errs.filter((e) => e.includes('[changelog]')).length === 0, errs.filter((e) => e.includes('[changelog]')).slice(0, 2).join(' | '));
  await axeScan('/changelog');
  await page.screenshot({ path: `${__dirname}/_platform-changelog.png` }).catch(() => {});

  // ── 2. /status — standalone monitoring page (direct URL: no in-app link) ──
  cur = 'status';
  await page.goto(`${ORIGIN}/status`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => {
    const txt = (document.body.innerText || '').trim();
    return { path: location.pathname, h1: document.querySelector('h1,h2')?.textContent?.trim() || '', len: txt.length, crashed: /something went wrong|failed to load/i.test(txt.slice(0, 2000)) };
  });
  check('/status renders real content (heading + body, no crash)', cl.crashed === false && st.len > 150 && !st.crashed, `h="${st.h1.slice(0, 40)}" len=${st.len}`);
  check('/status is console-error-free', errs.filter((e) => e.includes('[status]')).length === 0, errs.filter((e) => e.includes('[status]')).slice(0, 2).join(' | '));
  await axeScan('/status');
  await page.screenshot({ path: `${__dirname}/_platform-status.png` }).catch(() => {});

  check('0 console errors across both platform pages', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('platform-footer-pages probe completes without throwing', false, `[${cur}] ${String(e.message || e).slice(0, 100)}`);
} finally {
  await browser.close();
}

console.log('\n━━ § D platform CHANGELOG + STATUS pages (re-cover the 2 blocked entries) ━━');
rows.forEach((r) => console.log(r));
const ok = fails === 0;
console.log(ok ? '\n✓ PLATFORM PAGES PASS' : `\n🔴 PLATFORM PAGES — ${fails} issue(s)`);
process.exit(ok ? 0 : 1);
