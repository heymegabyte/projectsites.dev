#!/usr/bin/env node
/**
 * visual-sweep.mjs — real-browser VISUAL verification of admin sections
 * (P0-ADMIN mandate step 4: screenshot + AI-vision ≥9/10 + no console errors +
 * no failed requests, in brian@megabyte.space's real account via Browserbase).
 *
 * Logs in as brian (test-login), captures a full screenshot of each section to
 * `/tmp/psvis/<name>.png`, and prints a per-section report of h1 / main text
 * length / console errors / failed requests (google-analytics beacons filtered
 * — they fail in automation by design and are not app bugs).
 *
 * ⚠️ CRITICAL GOTCHA (cost a whole fire, 2026-08-02): `AuthService.email`
 * reads `session.identifier` (services/auth.service.ts) — NOT `session.email`.
 * Seed `ps_session` with `{ token, identifier }`. If you seed `email`,
 * `auth.email()` is empty and `sysAdminGuard` bounces brian OFF the operator
 * sections (feature-flags, system-services, leads) to `/admin/site-features`,
 * so you screenshot the WRONG (owner) view and think the operator view is broken.
 *
 * Creds (get-secret): BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID,
 * E2E_TEST_PASSWORD. Exits 0 (skip) if any is unset — never fail-closed.
 *
 * Usage:
 *   node e2e/admin-verify/visual-sweep.mjs                 # default section set
 *   node e2e/admin-verify/visual-sweep.mjs /admin/analytics /admin/social  # custom
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { waitForCaptureSettle } from './_capture-helpers.mjs';
// Optional axe-core a11y (PSVIS_AXE=1) — the ONLY way to verify the super-admin
// sections' a11y (they 403 for the e2e-org E2E harness, so they can't be axe'd there).
let AxeBuilder = null;
try { ({ default: AxeBuilder } = await import('@axe-core/playwright')); } catch { /* axe optional */ }

const BB = process.env.BROWSERBASE_API_KEY;
const PROJ = process.env.BROWSERBASE_PROJECT_ID;
const PW = process.env.E2E_TEST_PASSWORD;
if (!BB || !PROJ || !PW) {
  console.log('::notice:: visual-sweep skipped — BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID / E2E_TEST_PASSWORD unset');
  process.exit(0);
}

const OUT = '/tmp/psvis';
mkdirSync(OUT, { recursive: true });
const DEFAULT = ['/admin', '/admin/analytics', '/admin/feature-flags', '/admin/system-services', '/admin/site-features', '/admin/social', '/admin/media', '/admin/seo', '/admin/domains', '/admin/settings'];
const paths = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
// Sanitize slashes so nested routes (sites/:id/copilot) screenshot to a flat file.
const nameOf = (p) => (p.replace(/^\/admin\/?/, '') || 'dashboard').replace(/\//g, '_');

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
const report = {};
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  // Viewport is configurable (PSVIS_WIDTH/PSVIS_HEIGHT) so the same sweep verifies
  // AI-vision quality at ANY breakpoint (mandate: ≥9/10 at all 6 breakpoints), not
  // just desktop. Default 1440×900.
  await page.setViewportSize({
    width: Number(process.env.PSVIS_WIDTH) || 1440,
    height: Number(process.env.PSVIS_HEIGHT) || 900,
  });
  let current = 'boot';
  const errors = {}, failed = {};
  // Capture console.error AND the console.warning that GlobalErrorHandler emits
  // for a caught render crash — a section swallowed by the error boundary logs
  // via console.warning, NOT console.error, so a console.error-only sweep reports
  // errors:[] on a fully CRASHED section (cost a fire, 2026-08-03: Voice was dark
  // yet the sweep said 0 errors). Also capture uncaught pageerror.
  page.on('console', (m) => {
    const t = m.type(), txt = m.text();
    if (t === 'error' || (t === 'warning' && /Unhandled error|GlobalErrorHandler|ran into a problem/i.test(txt))) {
      (errors[current] ??= []).push(`[${t}] ${txt.slice(0, 160)}`);
    }
  });
  page.on('pageerror', (e) => { (errors[current] ??= []).push(`[pageerror] ${(e.message || String(e)).slice(0, 160)}`); });
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('google-analytics') && !res.url().includes('/g/collect')) {
      (failed[current] ??= []).push(res.status() + ' ' + res.url().replace('https://projectsites.dev', '').slice(0, 90));
    }
  });

  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  const login = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const j = await res.json().catch(() => ({}));
    const d = j?.data;
    if (d?.token) {
      // AuthService.email reads session.identifier — seed THAT (not `email`).
      try { localStorage.setItem('ps_session', JSON.stringify({ token: d.token, identifier: d.email ?? 'brian@megabyte.space', issuedAt: Date.now() })); } catch { /* private mode */ }
    }
    return { status: res.status, email: d?.email ?? null };
  }, PW);
  report._login = login;
  // Kill the PWA service worker + caches so the sweep renders the FRESHLY-DEPLOYED
  // bundle, not a stale SW-cached one. A fresh Browserbase session can still serve a
  // prior-deploy SW cache right after a deploy → a false "still broken" render even
  // though R2 has the fix (cost 2 verify cycles, 2026-08-03 snapshots-diff).
  await page.evaluate(async () => {
    try {
      if (navigator.serviceWorker) {
        const rs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map((x) => x.unregister()));
      }
      if (window.caches) {
        const ks = await caches.keys();
        await Promise.all(ks.map((k) => caches.delete(k)));
      }
    } catch { /* ignore — SW/cache API unavailable */ }
  });
  // Reload so AuthService hydrates the seeded session before the guards run.
  await page.goto('https://projectsites.dev/admin', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Site-scoped sections (/admin/snapshots, /admin/forms, /admin/settings, …) show a
  // "select a site" prompt until AdminStateService.selectedSite() is non-null — and it
  // has NO persistence, so it resets on every full page.goto (this loop navigates that
  // way). Therefore the site MUST be selected PER-SECTION, after the goto + before the
  // screenshot, so the section renders POPULATED for brian. Gated on PSVIS_SELECT_SITE=1.
  const selectSiteOnPage = async () => {
    try {
      const sw = page.locator('button[aria-label="Select site"]');
      if ((await sw.count()) === 0) return null;
      await sw.click();
      const opt = page.locator('button[role="option"]').first();
      await opt.waitFor({ state: 'visible', timeout: 5000 });
      const picked = (await opt.innerText().catch(() => '')).slice(0, 50);
      await opt.click();
      await page.waitForTimeout(2500); // let the section re-render with the selected site
      return picked || 'first-option';
    } catch {
      return 'select-failed';
    }
  };

  for (const p of paths) {
    const name = nameOf(p);
    current = name;
    try {
      await page.goto('https://projectsites.dev' + p, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5500);
      if (process.env.PSVIS_SELECT_SITE) {
        const picked = await selectSiteOnPage();
        if (picked) (report._selectedSite ??= {})[name] = picked;
      }
      // Let lazy widgets/skeletons settle so the shot shows the REAL state, not a loading
      // frame — was a fixed 5500ms only, which could capture a mid-flight skeleton (AL-551).
      await waitForCaptureSettle(page);
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
      const info = await page.evaluate(() => {
        // The section error boundary renders "This section ran into a problem" on
        // a caught render crash — detect it so a crashed section is flagged even
        // when it logged no console.error (it went through GlobalErrorHandler).
        const bodyText = document.body.innerText || '';
        return {
          url: location.pathname,
          h1: (document.querySelector('h1')?.innerText || '').slice(0, 60),
          mainLen: (document.querySelector('main')?.innerText || bodyText).trim().length,
          crashed: /ran into a problem/i.test(bodyText),
        };
      });
      report[name] = { ...info, errors: errors[name] ?? [], failed: (failed[name] ?? []).slice(0, 6) };
      if (process.env.PSVIS_AXE && AxeBuilder) {
        try {
          const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
          const crit = r.violations.filter((v) => v.impact === 'critical').map((v) => `${v.id}×${v.nodes.length}`);
          report[name].axeCritical = crit.length ? crit : 'none';
        } catch (e) {
          report[name].axeCritical = 'axe-failed: ' + String(e).slice(0, 60);
        }
      }
    } catch (e) {
      report[name] = { shot: 'FAIL', error: String(e).slice(0, 120) };
    }
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nScreenshots → ${OUT}/*.png — Read each + AI-vision score (populated? layout? brand? ≥9/10?).`);
} finally {
  await browser.close();
}
