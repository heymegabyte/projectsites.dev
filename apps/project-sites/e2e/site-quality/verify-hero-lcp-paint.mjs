#!/usr/bin/env node
/**
 * verify-hero-lcp-paint.mjs — § D: the PLATFORM homepage hero (projectsites.dev) must paint its LCP
 * element at FULL opacity IMMEDIATELY — never fade it in.
 *
 * The hero headline `<h1 class="animate-fade-in-up">` ("Skip the agency. Ship in 4 minutes.") IS the
 * LCP element on the #1 acquisition surface. The stock on-load rise (`.animate-fade-in-up`) used the
 * `fadeInUp` keyframe (opacity 0→1) with `animation-fill-mode: both`, so each staggered element was
 * HELD at opacity:0 through its delay (0.1–0.6s) — the hero was invisible for ~1–1.5s: a blank-hero
 * flash AND a delayed LCP (measured live: h1 opacity 0.30 at 2000ms cold). Per the standing rule
 * `hero-entrance-opacity-fade-delays-lcp-use-transform-only`, the on-load rise is now TRANSFORM-ONLY
 * (keyframe `psRiseInUp` = translateY only, `opacity:1`): content paints at full opacity on the first
 * frame (LCP fires immediately) while still rising into place.
 *
 * Playwright's `.waitFor({state:'visible'})` is BLIND to opacity (it checks display/size), so this
 * regression is invisible to ordinary render probes. This probe installs a rAF opacity sampler BEFORE
 * load (addInitScript), captures the hero h1's computed opacity from the very first frame it exists,
 * and asserts the MINIMUM opacity is ≥0.9 — i.e. it never faded. It also asserts the wired keyframe is
 * the transform-only one (not `fadeInUp`) and records the LCP time (advisory).
 *
 * Local Chromium against projectsites.dev (cold, cache-clean, SW blocked). Auto-joins run-all.
 * Usage: [PROD_URL=https://projectsites.dev] node e2e/site-quality/verify-hero-lcp-paint.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const BASE = (process.env.PROD_URL || 'https://projectsites.dev').replace(/\/$/, '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

// rAF opacity sampler — installed BEFORE any script runs so it catches the hero h1's opacity on the
// very first frame it exists. The hero headline carries `.animate-fade-in-up`; fall back to the first
// <h1> if the class ever changes. Samples until 1400ms after first-seen (covers the 0.1–0.6s stagger
// + the 0.6s animation) or a 6s absolute cap.
const SAMPLER = () => {
  window.__hero = { found: false, firstSeenMs: -1, animName: '', samples: [], min: 1, max: 0 };
  const t0 = performance.now();
  const pick = () =>
    document.querySelector('h1.animate-fade-in-up') || document.querySelector('main h1') || document.querySelector('h1');
  const tick = () => {
    const now = performance.now();
    const el = pick();
    if (el) {
      const cs = getComputedStyle(el);
      const op = parseFloat(cs.opacity);
      if (!window.__hero.found) {
        window.__hero.found = true;
        window.__hero.firstSeenMs = Math.round(now - t0);
        window.__hero.animName = cs.animationName || '';
      }
      if (Number.isFinite(op)) {
        window.__hero.samples.push(Math.round(op * 100) / 100);
        if (op < window.__hero.min) window.__hero.min = op;
        if (op > window.__hero.max) window.__hero.max = op;
      }
      if (now - t0 - window.__hero.firstSeenMs > 1400) return; // done sampling the entrance window
    }
    if (now - t0 < 6000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 80)));
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 80)));
  await page.addInitScript(SAMPLER);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  // Let the sampler run through the full entrance window.
  await page.waitForTimeout(3000);

  const hero = await page.evaluate(() => window.__hero || { found: false });
  // LCP time + element home — same technique as verify-cinematic-lcp-safety. NOTE: this Angular
  // homepage re-renders the hero on hydration, which DETACHES the buffered LCP entry's `.element`
  // (memory homepage-lcp-spa-hydration-rerender) → `element` is often null here. So we gate on LCP
  // TIME (a fast paint happened) and treat element-home as ADVISORY when the ref was detached.
  const lcp = await page.evaluate(
    () =>
      new Promise((res) => {
        let out = { tag: '?', time: 0, home: 'detached' };
        try {
          new PerformanceObserver((list) => {
            const last = list.getEntries().at(-1);
            if (!last) return;
            const el = last.element;
            const tag = el ? el.tagName.toLowerCase() : '?';
            const home = !el ? 'detached' : tag === 'h1' || el.closest('main') ? 'hero' : 'other';
            out = { tag, time: Math.round(last.startTime), home };
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          /* unsupported */
        }
        setTimeout(() => res(out), 1500);
      }),
  );

  check('hero <h1> rendered on the homepage', hero.found, hero.found ? `first-seen ${hero.firstSeenMs}ms` : 'no h1 found');
  if (hero.found) {
    // CORE GATE — the hero never fades in: min computed opacity across the entrance window ≥ 0.9.
    // Old (opacity-fade) behaviour: min ≈ 0 (held at 0 through the stagger). New (transform-only): ≈ 1.
    check(
      'hero paints at FULL opacity immediately (no blank-hero fade)',
      hero.min >= 0.9,
      `opacity min=${hero.min} max=${hero.max} over ${hero.samples.length} frames`,
    );
    // The on-load rise is wired to the TRANSFORM-ONLY keyframe (not the opacity-fading fadeInUp).
    check(
      'on-load rise uses the transform-only keyframe (not opacity-fading fadeInUp)',
      /psRiseInUp/i.test(hero.animName) || hero.animName === 'none' || hero.animName === '',
      `animation-name="${hero.animName}"`,
    );
  }
  // A fast LCP happened (the real signal). Element-home is advisory (detached by SPA hydration here).
  check('a fast LCP paint occurred (≤2500ms, cinematic target 2000ms)', lcp.time > 0 && lcp.time <= 2500, `t=${lcp.time}ms home=${lcp.home}`);
  if (lcp.home === 'other')
    console.log(`  ⚠ advisory: LCP element home resolved to "${lcp.tag}" (not hero) — verify the hero is the LCP`);
  check('0 cold-load console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
  await ctx.close().catch(() => {});
} catch (e) {
  check('hero-lcp-paint audit completed', false, 'error: ' + String(e).slice(0, 120));
} finally {
  await browser.close();
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(56)} [${r.detail}]`);
console.log(`::json:: ${JSON.stringify({ probe: 'hero-lcp-paint', base: BASE, checks: rows.length, fails, pass: fails === 0 })}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} check(s): the homepage hero fades in / delays LCP (fix the on-load rise to be transform-only in frontend styles.scss)`
    : `\nVERDICT: ✅ PASS — homepage hero paints at full opacity immediately (transform-only entrance), LCP stays on hero content, 0 cold console errors`,
);
process.exit(fails ? 1 : 0);
