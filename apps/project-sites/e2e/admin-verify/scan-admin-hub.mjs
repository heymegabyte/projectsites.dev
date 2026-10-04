#!/usr/bin/env node
/**
 * scan-admin-hub.mjs — read EVERY rendered counter on the /admin dashboard hub as
 * brian and screenshot it, so "non-working counter values" (a counter showing 0 /
 * "not run" while the account has real data) are caught automatically — the class
 * the hand-curated endpoint reconciler missed. Ground truth for org-brian-001:
 * 1 published site, 4 snapshots, 109 pageviews, 2 media, 2 mcp, 1 voice number.
 *
 * LOCAL headless Playwright (migrated off dead Browserbase, fire-127): Browserbase credit
 * returned 402 (session create failed), so this scan SKIPPED every fire. fire-122 proved a
 * cf_clearance'd local headless browser authenticates the test-login seam fine (goto('/')
 * first → in-page fetch carries the cookie). authSeedBrian seeds ps_session with the correct
 * `createdAt` recipe (NOT `issuedAt`, which AuthService treats as expired → bounce to /signin).
 * Creds (env → get-secret): E2E_TEST_PASSWORD. Exits 0 (skip) if unset.
 */
import { launchLocalBrowser, getTestPassword, authSeedBrian } from './_local-browser.mjs';
import { mkdirSync } from 'node:fs';
const PW = getTestPassword();
if (!PW) { console.log('::notice:: scan-admin-hub skipped — E2E_TEST_PASSWORD unset'); process.exit(0); }
mkdirSync('/tmp/psvis', { recursive: true });
const browser = await launchLocalBrowser();
const errors = [];
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || (t === 'warning' && /ran into a problem|GlobalErrorHandler/i.test(m.text()))) errors.push(`[${t}] ${m.text().slice(0, 120)}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + (e.message || String(e)).slice(0, 120)));
  // Log in as brian INSIDE the browser (goto('/') for cf_clearance, then the in-page
  // test-login POST). authSeedBrian seeds ps_session with the correct `createdAt`.
  const { ok } = await authSeedBrian(page, PW);
  if (!ok) { console.log('::error:: test-login returned no token'); process.exit(4); }
  await page.evaluate(async () => { try { const rs = await navigator.serviceWorker?.getRegistrations(); await Promise.all((rs ?? []).map((x) => x.unregister())); } catch {} try { const ks = await caches?.keys(); await Promise.all((ks ?? []).map((k) => caches.delete(k))); } catch {} });
  await page.goto('https://projectsites.dev/admin', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000); // let AdminStateService load sites + counters animate

  // Extract every rolling-counter + stat number + its nearest label, plus empty-state phrases.
  const counters = await page.evaluate(() => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll('app-rolling-counter, .stat, [data-testid*="count"], .status-count, .kpi'))) {
      const num = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const label = (el.closest('li,section,.card,.status-tile,p')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
      if (num) out.push({ num, label });
    }
    const body = document.body.innerText || '';
    const emptyPhrases = ['not run', 'no traffic', 'not available', 'no data', 'never had', 'nothing yet', '—'].filter((p) => new RegExp(p, 'i').test(body));
    return { counters: out.slice(0, 40), emptyPhrases };
  });
  await page.screenshot({ path: '/tmp/psvis/admin-hub.png', fullPage: true });
  console.log(JSON.stringify({ counters: counters.counters, emptyPhrases: counters.emptyPhrases, consoleErrors: errors }, null, 2));
  console.log('screenshot → /tmp/psvis/admin-hub.png');
} finally { await browser.close(); }
