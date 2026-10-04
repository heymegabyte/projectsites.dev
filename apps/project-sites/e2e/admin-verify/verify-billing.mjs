#!/usr/bin/env node
/**
 * verify-billing.mjs — focused live re-verify (as brian) to distinguish a real billing
 * regression from a rolling-counter mid-animation scan flake. TECHNICAL: authed
 * GET /billing/subscription + /billing/entitlements return the real paid plan + entitlements.
 * VISUAL: /admin/billing entitlement counters read their SETTLED values (long wait).
 * Creds (get-secret): E2E_TEST_PASSWORD.
 */
import { launchLocalBrowser, getTestPassword, authSeedBrian } from './_local-browser.mjs';
const PW = getTestPassword();
if (!PW) { console.log('::notice:: skipped — E2E_TEST_PASSWORD unset'); process.exit(0); }
const browser = await launchLocalBrowser();
const errs = [];
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('console', (m) => { const t = m.type(), x = m.text(); if (/Failed to load resource/i.test(x)) return; if (t === 'error' || (t === 'warning' && /ran into a problem|GlobalErrorHandler|Unhandled|NG0/i.test(x))) errs.push(`[${t}] ${x.slice(0, 120)}`); });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + (e.message || String(e)).slice(0, 120)));
  await authSeedBrian(page, PW);
  // Defeat any stale service-worker cache so we verify the FRESH deployed bundle.
  await page.evaluate(async () => { try { const rs = await navigator.serviceWorker?.getRegistrations(); await Promise.all((rs ?? []).map((x) => x.unregister())); } catch {} try { const ks = await caches?.keys(); await Promise.all((ks ?? []).map((k) => caches.delete(k))); } catch {} });

  const api = await page.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('ps_session') || '{}').token;
    const h = { Authorization: `Bearer ${tok}` };
    const sub = await (await fetch('/api/billing/subscription', { headers: h })).json().catch(() => ({}));
    const ent = await (await fetch('/api/billing/entitlements', { headers: h })).json().catch(() => ({}));
    return { sub: sub?.data ?? sub, ent: ent?.data ?? ent };
  });
  console.log('\n=== TECHNICAL — billing APIs (as brian) ===');
  console.log(JSON.stringify(api, null, 2));

  await page.goto('https://projectsites.dev/admin/billing', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(9000); // long settle — let rolling-counters finish animating
  const readVis = () => page.evaluate(() => {
    const txt = (t) => { const el = document.querySelector(`[data-testid="${t}"]`); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20) : 'ABSENT'; };
    return {
      entPanelPresent: !!document.querySelector('[data-testid="entitlement-custom_domains"],[data-testid="entitlement-seats"],[data-testid="entitlement-analytics"]'),
      custom_domains: txt('entitlement-custom_domains'), seats: txt('entitlement-seats'), analytics: txt('entitlement-analytics'),
      tabs: Array.from(document.querySelectorAll('[role="tab"], .tab, button.seg')).map((t) => (t.textContent || '').trim()).filter(Boolean).slice(0, 8),
      bodyHasPlan: /custom domains|team seats|entitlement/i.test(document.body.innerText || ''),
    };
  });
  let vis = await readVis();
  // If the entitlement panel isn't present, try clicking a Plan/Overview tab then re-read.
  if (!vis.entPanelPresent) {
    for (const label of ['Plan', 'Overview', 'Subscription']) {
      try { const b = page.locator(`[role="tab"]:has-text("${label}"), button:has-text("${label}")`).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(4000); vis = await readVis(); if (vis.entPanelPresent) { vis.clickedTab = label; break; } } } catch {}
    }
  }
  await page.screenshot({ path: '/tmp/psvis/billing.png', fullPage: false });
  console.log('\n=== VISUAL — /admin/billing (9s settle) ===');
  console.log(JSON.stringify(vis, null, 2));
  console.log('\n=== CONSOLE ERRORS ===\n' + (errs.length ? errs.join('\n') : '(none)'));
  const planPaid = /paid/i.test(JSON.stringify(api.sub));
  const ok = planPaid && vis.entPanelPresent && /10/.test(vis.custom_domains) && /10/.test(vis.seats) && errs.length === 0;
  console.log(`\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} plan=${planPaid ? 'paid' : '??'} entPanel=${vis.entPanelPresent} cards=[cd:${vis.custom_domains}|seats:${vis.seats}|analytics:${vis.analytics}]${vis.clickedTab ? ' tab:' + vis.clickedTab : ''} errs=${errs.length}`);
} finally { await browser.close(); }
