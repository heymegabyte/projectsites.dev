#!/usr/bin/env node
/**
 * verify-billing-nav-clickpath.mjs — FULL-JOURNEY: the dashboard → BILLING nav CLICK-PATH.
 *
 * WHY (the gap this closes): `verify-billing-checkout.mjs` proves the embedded Stripe checkout
 * MOUNTS, but it `page.goto('/admin/billing')` — teleporting PAST the nav. So the actual path a
 * paying owner takes (dashboard → open account menu → click "Billing & credits") was never proven:
 * a dead nav link or a full-page-reload regression on the #1 revenue surface would slip through.
 * This navigates by CLICKS ONLY (no goto after the authed entry) and additionally asserts the nav
 * was a client-side SPA transition (a sentinel set on the dashboard survives → no full reload).
 *
 * Sub-actions covered: account-menu toggle (aria-expanded), the menu's Billing routerLink, the SPA
 * route change to /admin/billing, the billing surface rendering real content (not an error boundary),
 * 0 console errors. Complements (does not replace) the checkout-mount probe.
 *
 * LOCAL CHROMIUM (the authed admin shell is NOT CF-bot-challenged). Seeds ps_session from E2E_API_KEY
 * (from ENV, never inline). Fail-open (exit 0) when E2E_API_KEY is unset so forks / secret-less CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-billing-nav-clickpath.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-billing-nav-clickpath skipped — E2E_API_KEY unset');
  process.exit(0);
}
const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /Failed to load resource|analytics|ingest|posthog|challenge|cf-|doubleclick|sentry|beacon|gtm|stripe\.com|js\.stripe|m\.stripe|r\.stripe|hcaptcha/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 120)); });
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errs.push('pageerror: ' + String(e).slice(0, 120)); });

const step = (ok, label, detail = '') => console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
let exitCode = 1;
try {
  // Authed entry: seed the session on the marketing shell, then enter the app at its dashboard "home"
  // (the marketing / has no admin link for a freshly-seeded session). This is the ONLY goto.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const avatar = page.locator('[data-testid="user-avatar-btn"]').first();
  await avatar.waitFor({ state: 'visible', timeout: 20000 });
  step(true, 'dashboard shell renders with the account-menu trigger', await page.evaluate(() => `path=${location.pathname}`));

  // SPA sentinel: a full page reload wipes this; a client-side route change preserves it.
  await page.evaluate(() => { window.__psNavSentinel = 'clickpath-' + Date.now(); });
  const sentinelBefore = await page.evaluate(() => window.__psNavSentinel);

  // Open the account menu (proves the toggle + aria-expanded), then click "Billing & credits".
  await avatar.click();
  const menu = page.locator('[data-testid="user-menu"]').first();
  await menu.waitFor({ state: 'visible', timeout: 6000 });
  const expanded = await avatar.getAttribute('aria-expanded');
  step(expanded === 'true', 'account menu opens (aria-expanded)', `aria-expanded=${expanded}`);

  const billingLink = page.locator('[data-testid="user-menu-billing"]').first();
  await billingLink.waitFor({ state: 'visible', timeout: 6000 });
  await billingLink.click();

  // The route must change to /admin/billing via SPA — no goto, no full reload.
  await page.waitForURL(/\/admin\/billing(?:$|[/?#])/, { timeout: 10000 });
  const landedPath = await page.evaluate(() => location.pathname);
  step(true, 'clicking "Billing & credits" routes to /admin/billing', `path=${landedPath}`);

  const sentinelAfter = await page.evaluate(() => window.__psNavSentinel);
  const spaNav = sentinelAfter === sentinelBefore && !!sentinelBefore;
  step(spaNav, 'nav was a client-side SPA transition (no full reload)', spaNav ? 'sentinel survived' : 'sentinel LOST → full reload regression');

  // The billing surface renders REAL content, not an error boundary / blank shell.
  await page.waitForTimeout(2000);
  const surface = await page.evaluate(() => {
    const bodyLen = document.body.innerText.trim().length;
    const crashed = /something went wrong|error boundary|failed to load/i.test(document.body.innerText);
    const t = document.body.innerText.toLowerCase();
    const billingish = /billing|plan|credit|subscription|invoice|upgrade/.test(t);
    return { bodyLen, crashed, billingish };
  });
  step(surface.bodyLen > 400 && !surface.crashed && surface.billingish, 'billing surface renders real content (no crash/blank)', `bodyLen=${surface.bodyLen} billingish=${surface.billingish} crashed=${surface.crashed}`);
  step(errs.length === 0, '0 console errors across the nav journey', errs.length ? errs.slice(0, 2).join(' | ') : 'clean');

  const ok = expanded === 'true' && landedPath.startsWith('/admin/billing') && spaNav && surface.bodyLen > 400 && !surface.crashed && surface.billingish && errs.length === 0;
  console.log(`\nVERDICT: ${ok ? '✅ PASS — dashboard → account menu → Billing click-path is a live SPA nav to a real billing surface, 0 console errors.' : '🔴 FAIL — the dashboard→billing click-path broke (dead link / full reload / crashed surface / console errors).'}`);
  exitCode = ok ? 0 : 1;
} catch (e) {
  console.log(`::notice:: verify-billing-nav-clickpath — ${String(e).slice(0, 160)}`);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
