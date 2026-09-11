#!/usr/bin/env node
/**
 * vision-capture.mjs — a MANUAL vision-inspection aid (NOT a pass/fail gate) for the ADMIN
 * INTEGRITY loop's recurring "VISION-INSPECT the screenshot" step. Seeds ps_session from
 * E2E_API_KEY (from ENV, never inline), navigates each requested /admin section in a real local
 * Chromium (playwright-core, same resolution as admin-surf-audit), and writes a full-page PNG per
 * section to `e2e/screenshots/admin-verify/vision/` (gitignored) for a human / AI-vision read.
 *
 * WHY IT SCROLLS FIRST (the artifact this kills): `<app-rolling-counter>` starts at 0 and only
 * rolls to its real value when its IntersectionObserver fires (element enters the viewport) or a
 * ~2.5s fallback snaps it. A naive full-page screenshot renders BELOW-FOLD counters WITHOUT
 * firing the viewport observer, so a below-fold stat (e.g. the dashboard footer "N sites in your
 * account") captures a phantom "0" that NO real user ever sees (they only see it once it scrolls
 * into view → it rolls to the truth, e.g. "108 sites"). AL-187 nearly chased that phantom; this
 * probe scrolls the page top→bottom in viewport steps to fire every observer, settles, then
 * captures — so the PNG shows what a user actually sees. Cross-ref memory
 * `rolling-counter-fullpage-capture-shows-phantom-zero`.
 *
 * Fail-open (conditional-ci-gates): skips (exit 0) when E2E_API_KEY is unset. Read-only surfing.
 *
 * Usage:
 *   E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/vision-capture.mjs
 *   E2E_API_KEY=… node e2e/admin-verify/vision-capture.mjs billing,social,voice   # subset
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright-core');

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: vision-capture skipped — E2E_API_KEY unset');
  process.exit(0);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const VW = parseInt(process.env.VIEWPORT || '1280', 10);
const VH = VW <= 480 ? 844 : 900;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const OUT = resolve(__dirname, '../screenshots/admin-verify/vision');
mkdirSync(OUT, { recursive: true });

const SECTIONS = (
  process.argv[2] ||
  'dashboard,billing,analytics,social,voice,domains,deliverability,site-features,logs,forms,snapshots,audit'
).split(',');

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: VW, height: VH },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => {
  localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }));
}, KEY);

/**
 * Wait for a section's async content to SETTLE before screenshotting — otherwise a
 * data-heavy section (e.g. the dashboard loading 100+ sites) captures its "Loading
 * Dashboard…" spinner instead of real content, silently compromising the vision
 * review. Bounded + fail-open: network-quiets, then waits for the "Loading …"
 * spinner text to clear; if either lingers past its budget we fall through and
 * capture anyway (never hang the run). Found 2026-09-11: the fixed 1600ms wait
 * screenshotted the dashboard mid-load.
 */
async function waitForSettled() {
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const t = document.body?.innerText || '';
        // Admin loading states read "Loading <Section>…" / "Loading <Section>...".
        return !/\bLoading\b[^\n]{0,40}(…|\.\.\.)/.test(t);
      },
      { timeout: 12000 },
    )
    .catch(() => {});
}

/** Scroll top→bottom in viewport steps so every IntersectionObserver-gated counter fires + rolls. */
async function fireObservers() {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.9;
    const max = document.body.scrollHeight;
    for (let y = 0; y <= max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900); // let counters settle at their real values
}

for (const s of SECTIONS) {
  try {
    await page.goto(`${ORIGIN}/admin/${s}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSettled();
    await page.waitForTimeout(500); // small floor so late paints (chart animations) land
    await fireObservers();
    const file = resolve(OUT, `${s}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const h = await page.evaluate(() => document.querySelector('h1,h2')?.textContent?.trim()?.slice(0, 48) || '(none)');
    console.log(`  ✓ ${s.padEnd(14)} → screenshots/admin-verify/vision/${s}.png  [${h}]`);
  } catch (e) {
    console.log(`  ✗ ${s.padEnd(14)} — ${String(e).slice(0, 80)}`);
  }
}
await browser.close();
console.log(`\nCaptured ${SECTIONS.length} section(s) → ${OUT} (gitignored). Read the PNGs for AI-vision review.`);
