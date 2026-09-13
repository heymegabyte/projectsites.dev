#!/usr/bin/env node
/**
 * shoot-section.mjs — capture a full-page screenshot of one or more /admin sections
 * as the seeded E2E session, for VISION INSPECTION (the loop's "VISION-INSPECT the
 * screenshot → implement obvious UX/visual/copy/a11y improvements inline" directive).
 *
 * Local headless Chromium — `admin-surf-audit.mjs` proves prod `/admin` loads fine for a
 * local browser (the CF bot challenge gates public HTML + analytics ingest, NOT the authed
 * SPA shell), so no Browserbase session is needed. Session seeded from E2E_API_KEY passed
 * as a page.evaluate ARG (never inlined into committed source). Writes
 * `e2e/screenshots/admin/<slug>-<vw>.png` (full page) and prints each path to read back.
 *
 * Usage:
 *   E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/shoot-section.mjs dashboard forms billing
 *   E2E_API_KEY=… node e2e/admin-verify/shoot-section.mjs --vw=390 settings   # mobile
 *   (no slugs → a default representative set)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.error('E2E_API_KEY env required');
  process.exit(2);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const vwArg = process.argv.find((a) => a.startsWith('--vw='));
const VW = parseInt((vwArg ? vwArg.split('=')[1] : process.env.VIEWPORT) || '1280', 10);
const VH = VW <= 480 ? 844 : 900;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const slugs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SECTIONS = slugs.length ? slugs : ['dashboard', 'forms', 'billing', 'settings'];

const outDir = resolve(__dirname, '../screenshots/admin');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: VW, height: VH },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(
  (k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })),
  KEY,
);

// Settle past the rolling-counter's 2500ms below-fold fallback — a below-fold
// <app-rolling-counter> (e.g. the dashboard footer "N sites in your account") never
// receives an IntersectionObserver hit in a fullPage capture (its host stays outside
// the viewport), so it sits at its roll-from-0 value until the 2500ms fallback snaps
// it to the real number. Shooting earlier captures a transient 0, not the true state.
const SETTLE = parseInt(process.env.SETTLE_MS || '3200', 10);
for (const s of SECTIONS) {
  await page.goto(`${ORIGIN}/admin/${s}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(SETTLE);
  // Let skeletons/spinners settle so the shot shows the real state, not a loading frame.
  await page
    .waitForFunction(
      () => !document.querySelector('[aria-busy="true"], .animate-pulse, .skeleton, .loading-skeleton, [data-loading="true"]'),
      { timeout: 5000 },
    )
    .catch(() => {});
  // Fire every viewport-gated IntersectionObserver (rolling-counters, reveal-on-scroll)
  // by walking the page top→bottom, then return to top. Without this a fullPage capture
  // freezes below-fold <app-rolling-counter>s at their roll-from-0 initial — a FALSE
  // "0 sites in your account" that is NOT a product bug (verified 2026-09-06: a real
  // scroll settles the dashboard footer to the true 107). A vision-inspection tool that
  // shows phantom zeros is worse than none (validator-precision-discipline).
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight);
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1600); // let the just-triggered counters finish animating
  // Guard (validator-precision, AL-486): a slug that is NOT a real /admin route lands on the
  // branded admin-404 shell ("This admin page doesn't exist"). Shooting it looks like a BROKEN
  // section under vision-inspection — it cost a near-false "media section is broken" chase (media
  // is a drag-drop library consumed contextually, NOT a routed section). Flag it so the shot is
  // read as "not a section route", never a regression. Content sweeps (surf-audit) use a curated
  // SECTIONS list and never hit this; ad-hoc shoot-section slugs can.
  const is404 = await page
    .evaluate(() => /this admin page doesn.?t exist|error\s*404/i.test(document.body?.innerText || ''))
    .catch(() => false);
  const path = resolve(outDir, `${s}-${VW}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`shot ${s} → ${path}${is404 ? '  ::notice:: admin-404 shell (not a known section route — shot is the 404 page, NOT a broken section)' : ''}`);
}
await browser.close();
