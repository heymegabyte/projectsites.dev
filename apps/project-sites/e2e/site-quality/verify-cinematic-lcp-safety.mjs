#!/usr/bin/env node
/**
 * verify-cinematic-lcp-safety.mjs — § C.7 / CINEMATIC-3D: the template ships a DENSE cinematic
 * stack (WebGL hero backdrop · IntroTeaser brand-curtain · ParticleField · magnetic CTA · scroll
 * parallax · card tilt · ken-burns · pointer spotlight · grain · pinned process reel). Each has a
 * render probe — but the ONE invariant that ALL of them must never violate, and that NO probe
 * asserted, is the loop's central hard constraint:
 *
 *   the Largest Contentful Paint element MUST be the HERO content (an <img>/<h1> in <main>) —
 *   NEVER a cinematic overlay (the full-bleed `.ps-intro` intro curtain that covers the hero on
 *   first visit) and NEVER a late-decoding `<canvas>`/`<video>` (WebGL backdrop / particle field).
 *
 * A cinematic effect that steals the LCP is the classic ttfr-north-star regression: a decorative
 * canvas or an intro overlay becomes the LCP at ~2-4s (whenever it decodes), blowing the ≤2.0s
 * budget non-deterministically. This gate makes that regression impossible to ship silently across
 * the whole fleet at once (all effects come from the shared template).
 *
 * Per site (cold, cache-clean): observe `largest-contentful-paint` (buffered), resolve the LCP
 * element's home, and assert it is HERO content — NOT `.ps-intro`, NOT a `<canvas>`/`<video>`.
 * Also records the LCP time (advisory ≤2500ms — a generous ~1.25× the 2.0s cinematic target so
 * network variance never cries wolf; a genuine >2.0s trend is visible in the JSON line).
 *
 * Local Chromium against {slug}.projectsites.dev (CF-clean). Auto-joins the globbed run-all.
 * Usage: [SITES=slug,slug] node e2e/site-quality/verify-cinematic-lcp-safety.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSites } from './_default-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SITES = resolveSites(process.env.SITES);
if (SITES.length === 0) {
  console.log('::notice:: verify-cinematic-lcp-safety skipped — no site resolved');
  process.exit(0);
}

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

const browser = await chromium.launch();
try {
  for (const slug of SITES) {
    // Cold, cache-clean context so the LCP measurement is a real first-visit paint.
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 80)));
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 80)));
    await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

    // Resolve the LCP element's "home": hero (main/h1/img) vs a cinematic overlay/canvas.
    const lcp = await page.evaluate(
      () =>
        new Promise((res) => {
          let out = { home: 'none', tag: '?', time: 0 };
          try {
            new PerformanceObserver((list) => {
              const entries = list.getEntries();
              const last = entries[entries.length - 1];
              if (!last) return;
              const el = last.element;
              const tag = el ? el.tagName.toLowerCase() : '?';
              let home = 'other';
              if (el) {
                if (el.closest('.ps-intro')) home = 'intro-overlay';
                else if (tag === 'canvas') home = 'canvas';
                else if (tag === 'video') home = 'video';
                else if (el.closest('main')) home = 'hero-main';
                else if (tag === 'h1' || tag === 'img') home = 'hero-content';
                else home = 'other';
              }
              out = { home, tag, time: Math.round(last.startTime) };
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            /* observer unsupported → resolve default */
          }
          setTimeout(() => res(out), 3000);
        }),
    );

    const safe = lcp.home === 'hero-main' || lcp.home === 'hero-content';
    check(
      `${slug} · LCP is HERO content, not a cinematic overlay/canvas`,
      safe,
      `home=${lcp.home} tag=${lcp.tag} t=${lcp.time}ms`,
    );
    // Advisory LCP-time trend (does not fail on variance; visible for regression watching).
    if (safe && lcp.time > 2500)
      console.log(`  ⏱ advisory: ${slug} LCP ${lcp.time}ms > 2500ms (cinematic target 2000ms) — watch for a trend`);
    check(`${slug} · 0 cold-load console errors`, errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
    await ctx.close().catch(() => {});
  }
} catch (e) {
  check('cinematic-lcp-safety audit completed', false, 'error: ' + String(e).slice(0, 120));
} finally {
  await browser.close();
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(58)} [${r.detail}]`);
console.log(`::json:: ${JSON.stringify({ probe: 'cinematic-lcp-safety', sites: SITES.length, checks: rows.length, fails, pass: fails === 0 })}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} check(s): a cinematic overlay/canvas stole the LCP OR a cold console error (fix in the TEMPLATE — fleet-wide)`
    : `\nVERDICT: ✅ PASS — every audited site keeps the LCP on HERO content (never the intro-curtain / WebGL canvas / particle field) + 0 cold console errors — the cinematic stack stays LCP-safe`,
);
process.exit(fails ? 1 : 0);
