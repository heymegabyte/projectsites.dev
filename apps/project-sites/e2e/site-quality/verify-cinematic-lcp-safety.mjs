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
 * MEASUREMENT (AL-840): the FINAL/SETTLED LCP element is what matters — LCP only ever grows to
 * LARGER paint candidates, so a full-bleed WebGL `<canvas>` (huge, paints early ~1s) is a valid
 * MID-FLIGHT candidate that the hero content overtakes once it paints (~2.1s on strand). A probe
 * that samples LCP at a FIXED 3s races that overtake: when the hero paint slips past the sample
 * window (normal network variance — strand's real hero LCP sits at ~2.1-2.3s, right against 3s),
 * the mid-flight canvas is falsely recorded as "the LCP" → a false "canvas stole the LCP". So we
 * wait for `load` THEN a quiet-settle (no new LCP entry for 900ms, hard cap 9s) to read the
 * SETTLED LCP, and re-audit any failing site ONCE in a fresh cold context — only a STABLE failure
 * (fails both reads) counts. The invariant stays strict: the settled LCP MUST be hero content.
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

/**
 * Audit one site in a fresh cold context. Returns the SETTLED LCP home/tag/time + cold console
 * errors. `home` ∈ {hero-main, hero-content, intro-overlay, canvas, video, other, none}.
 */
async function auditSite(browser, slug) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 80)));
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 80)));
  try {
    await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    // Let late-painting hero <img>/canvas candidates land before we finalize LCP.
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});

    // Resolve the SETTLED LCP element's "home": read the LAST (largest) LCP entry after LCP has
    // been quiet for 900ms — never a fixed mid-flight sample. LCP is monotonic in size, so the
    // last entry once it stops growing is the final, largest paint = the settled hero.
    const lcp = await page.evaluate(
      () =>
        new Promise((res) => {
          let out = { home: 'none', tag: '?', time: 0 };
          let seen = false;
          let lastChange = performance.now();
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
              seen = true;
              lastChange = performance.now();
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            return res(out); // observer unsupported → resolve default
          }
          // Finalize when the LCP has stopped growing (quiet ≥900ms after the last entry) OR at a
          // 9s hard cap so a genuinely slow/broken page still resolves rather than hanging.
          const start = performance.now();
          const tick = () => {
            const quietFor = performance.now() - lastChange;
            const elapsed = performance.now() - start;
            if ((seen && quietFor >= 900) || elapsed >= 9000) return res(out);
            setTimeout(tick, 120);
          };
          setTimeout(tick, 120);
        }),
    );
    return { ...lcp, errs };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const browser = await chromium.launch();
try {
  for (const slug of SITES) {
    let r = await auditSite(browser, slug);
    let safe = r.home === 'hero-main' || r.home === 'hero-content';
    let retried = false;
    // A single race-prone/transient read never fails the gate: re-audit once in a fresh cold
    // context. Only a STABLE failure (hero not the settled LCP twice, or errors twice) counts.
    if (!safe || r.errs.length > 0) {
      retried = true;
      const r2 = await auditSite(browser, slug);
      const safe2 = r2.home === 'hero-main' || r2.home === 'hero-content';
      // Keep the healthier read: prefer the pass on the safety check, and the clean console read.
      if (safe2) {
        r = { ...r2, errs: r2.errs.length <= r.errs.length ? r2.errs : r.errs };
        safe = true;
      } else {
        r = { ...r2, errs: r2.errs.length <= r.errs.length ? r2.errs : r.errs };
        safe = false;
      }
    }
    const tag = retried ? ' (settled, re-audited)' : ' (settled)';
    check(
      `${slug} · LCP is HERO content, not a cinematic overlay/canvas`,
      safe,
      `home=${r.home} tag=${r.tag} t=${r.time}ms${tag}`,
    );
    // Advisory LCP-time trend (does not fail on variance; visible for regression watching).
    if (safe && r.time > 2500)
      console.log(`  ⏱ advisory: ${slug} LCP ${r.time}ms > 2500ms (cinematic target 2000ms) — watch for a trend`);
    check(`${slug} · 0 cold-load console errors`, r.errs.length === 0, r.errs.slice(0, 2).join(' | ') || 'clean');
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
    ? `\nVERDICT: 🔴 FAIL — ${fails} check(s): a cinematic overlay/canvas is the SETTLED LCP OR a stable cold console error (fix in the TEMPLATE — fleet-wide)`
    : `\nVERDICT: ✅ PASS — every audited site keeps the SETTLED LCP on HERO content (never the intro-curtain / WebGL canvas / particle field) + 0 cold console errors — the cinematic stack stays LCP-safe`,
);
process.exit(fails ? 1 : 0);
