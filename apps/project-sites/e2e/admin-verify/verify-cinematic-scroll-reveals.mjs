#!/usr/bin/env node
/**
 * verify-cinematic-scroll-reveals.mjs — BLEEDING-EDGE (flag: cinematic_scroll_reveals).
 *
 * Proves the native CSS scroll-driven cinematic reveal layer on the marketing homepage
 * (`animation-timeline: view()`, off the main thread) is deployed + correct + SAFE. The
 * flag is dark by default on prod, so the flag-ON path is proven by FORCING the host
 * class in a real browser (the flag merely toggles that class) — no prod flag flip needed.
 *
 * Three assertions, matching the triple gate the CSS ships with:
 *   1. FLAG-OFF (prod default) — homepage renders, `.reveal` sections exist, the host does
 *      NOT carry `.cinematic-scroll`, and no `.reveal` has a cinematic `animation-name`
 *      (the JS `appReveal` baseline owns reveals). 0 console errors. This is the graceful
 *      dark path the Charter mandates for every flagged feature.
 *   2. NATIVE-CSS CONTRACT (force flag-on) — add `.cinematic-scroll` to the <app-homepage>
 *      host; a `.reveal` section then computes `animation-name: ps-cinematic-reveal` AND a
 *      non-`none` `animation-timeline` (proving the @supports-gated native scroll timeline
 *      is live in a scroll-timeline browser — Chromium 115+).
 *   3. REDUCED-MOTION SAFETY — emulate `prefers-reduced-motion: reduce`, force the class;
 *      NO `.reveal` gets the cinematic animation (the `@media (no-preference)` gate excludes
 *      it) → reduced-motion users never see scroll-driven motion.
 *
 * Local Chromium against https://projectsites.dev (public marketing page — no auth).
 * Auto-joins run-all via the verify-*.mjs glob. Fail-open never applies (no creds needed).
 * Run:  node e2e/admin-verify/verify-cinematic-scroll-reveals.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const URL = process.env.HOMEPAGE_URL || 'https://projectsites.dev/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
};

const browser = await chromium.launch();
try {
  // ── 1. FLAG-OFF (prod default): graceful, JS-reveal baseline, no cinematic CSS applied ──
  {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(500);
    const off = await page.evaluate(() => {
      const host = document.querySelector('app-homepage');
      const reveals = Array.from(document.querySelectorAll('app-homepage .reveal'));
      const anyCinematic = reveals.some((el) =>
        /ps-cinematic-reveal/.test(getComputedStyle(el).animationName || ''),
      );
      return {
        hostFound: !!host,
        hostHasClass: !!host && host.classList.contains('cinematic-scroll'),
        revealCount: reveals.length,
        anyCinematic,
      };
    });
    check('flag-OFF: homepage host + `.reveal` sections render', off.hostFound && off.revealCount > 0, `host=${off.hostFound} reveals=${off.revealCount}`);
    check('flag-OFF: host has NO `.cinematic-scroll` (dark by default)', !off.hostHasClass, `hasClass=${off.hostHasClass}`);
    check('flag-OFF: NO `.reveal` runs the cinematic animation (JS baseline owns reveals)', !off.anyCinematic, `anyCinematic=${off.anyCinematic}`);
    check('flag-OFF: 0 console errors on the homepage', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'clean');
    await ctx.close();
  }

  // ── 2. NATIVE-CSS CONTRACT: force flag-on → native scroll-timeline reveal is live ──
  {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(400);
    const on = await page.evaluate(() => {
      const host = document.querySelector('app-homepage');
      if (!host) return { ok: false };
      host.classList.add('cinematic-scroll'); // simulate flag-on (the flag only adds this class)
      const supports = CSS.supports('animation-timeline: view()');
      const reveals = Array.from(document.querySelectorAll('app-homepage .reveal'));
      // Find a reveal that isn't in the initial viewport (its cinematic animation applies).
      const sample = reveals.find((el) => {
        const cs = getComputedStyle(el);
        return /ps-cinematic-reveal/.test(cs.animationName || '');
      });
      const cs = sample ? getComputedStyle(sample) : null;
      return {
        ok: true,
        supports,
        revealCount: reveals.length,
        cinematicApplied: !!sample,
        animationName: cs?.animationName || 'none',
        animationTimeline: cs?.animationTimeline || 'auto',
      };
    });
    check('native: browser supports `animation-timeline: view()` (Chromium 115+)', on.supports === true, `supports=${on.supports}`);
    check('native: flag-on → a `.reveal` computes `animation-name: ps-cinematic-reveal`', on.cinematicApplied === true, `name=${on.animationName}`);
    check('native: that reveal binds a scroll timeline (not `auto`)', on.animationTimeline !== 'auto' && on.animationTimeline !== 'none', `timeline=${on.animationTimeline}`);
    await ctx.close();
  }

  // ── 3. REDUCED-MOTION SAFETY: force flag-on under reduce → NO cinematic animation ──
  {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(400);
    const rm = await page.evaluate(() => {
      const host = document.querySelector('app-homepage');
      if (host) host.classList.add('cinematic-scroll');
      const reveals = Array.from(document.querySelectorAll('app-homepage .reveal'));
      const anyCinematic = reveals.some((el) => /ps-cinematic-reveal/.test(getComputedStyle(el).animationName || ''));
      return { anyCinematic, revealCount: reveals.length };
    });
    check('reduced-motion: flag-on but NO `.reveal` runs the cinematic animation', rm.anyCinematic === false, `anyCinematic=${rm.anyCinematic} reveals=${rm.revealCount}`);
  }
} catch (e) {
  check('cinematic-scroll audit completed', false, 'error: ' + String(e).slice(0, 140));
} finally {
  await browser.close();
}

const fails = rows.filter((r) => !r.ok);
for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(66)} [${r.detail}]`);
console.log(`::json:: ${JSON.stringify({ probe: 'cinematic-scroll-reveals', checks: rows.length, fails: fails.length, pass: fails.length === 0 })}`);
console.log(
  fails.length
    ? `\nVERDICT: 🔴 FAIL — ${fails.length}/${rows.length} cinematic-scroll checks failed`
    : `\nVERDICT: ✅ PASS — native scroll-driven cinematic reveals are deployed + @supports/reduced-motion-gated + dark by default (flag: cinematic_scroll_reveals)`,
);
process.exit(fails.length ? 1 : 0);
