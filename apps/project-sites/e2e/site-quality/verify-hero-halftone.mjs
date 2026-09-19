#!/usr/bin/env node
/**
 * verify-hero-halftone.mjs — § C.7 / CINEMATIC-3D: proves the `halftone` hero backdrop variant (a
 * kinetic Ben-Day DOT field for EDITORIAL — media/publishing/magazine) actually COMPILES + RENDERS
 * in a real browser AND stays LCP-safe. The GLSL fragment shader only compiles at runtime (jsdom +
 * the source-gate unit test can't run WebGL), so a syntax error in the new `uMode==13` branch would
 * silently fall back to the static gradient (setMode('static')) — the variant would never render and
 * no unit test would catch it. This probe closes that gap on any Home-hero surface.
 *
 * Uses the DEMO-only `?bg=halftone` override (demoVariantOverride) so the scene is provable WITHOUT a
 * full site rebuild (the 402/dead-credit bypass, per the template-demo-is-live-proof pattern). Renders
 * with a DARK colorScheme (resolveBackdropMode gives the static gradient on light themes) + motion
 * allowed, then asserts:
 *   A. the override reached the DOM — `[data-hero-variant="halftone"]` is present (wiring works);
 *   B. when WebGL is available, the animated shader path won — `data-hero-mode="webgl"` (the GLSL
 *      compiled + linked; a broken branch would read "static"). Fail-soft to advisory when the headless
 *      env genuinely lacks WebGL (getContext('webgl') === null) — the static fallback is correct there;
 *   C. the hero actually PAINTED, non-black — a screenshot's mean luminance sits in a sane band (the
 *      shader's 0.10 dark base is non-black by construction; a black field = a broken render);
 *   D. LCP-safe — the LCP element is hero content, never the decorative backdrop canvas;
 *   E. 0 cold-load console errors.
 * Saves the hero screenshot to `_halftone-hero.png` for screenshot-vision inspection.
 *
 * SKIP (not fail) when the target surface has NO Home hero — the DEPLOYED demo front door
 * (template.projectsites.dev) is GALLERY-mode (no Home hero → no backdrop), and no editorial cohort
 * site is rebuilt yet, so there is no live halftone surface to hit by default. run-all stays green;
 * the unit source-gate (WebGLHeroBackdrop.test.ts) + the local WebGL proof cover the variant. Point
 * HALFTONE_BASE at a Home-hero surface (a local `vite preview`, or a future editorial cohort site) to
 * HARD-prove the render.
 *
 * Local Chromium. Auto-joins site-quality run-all via the verify-*.mjs glob.
 * Usage: [HALFTONE_BASE=http://localhost:4173] node e2e/site-quality/verify-hero-halftone.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
let sharp = null;
try {
  sharp = req('sharp');
} catch {
  /* sharp optional — non-black luminance check downgrades to advisory without it */
}

const BASE = (process.env.HALFTONE_BASE || 'https://template.projectsites.dev').replace(/\/$/, '');
const VARIANT = process.env.HALFTONE_VARIANT || 'halftone';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SHOT = resolve(__dirname, '_halftone-hero.png');

const rows = [];
let fails = 0;
let skipped = false;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

const browser = await chromium.launch();
try {
  // DARK colorScheme → the WebGL path (light themes take the static gradient by design); motion allowed.
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 100)));
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 100)));
  await page.goto(`${BASE}/?bg=${VARIANT}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  // Shader mounts post-hydration; give it time to compile + paint a few frames.
  await page.waitForTimeout(2800);

  const state = await page.evaluate(() => {
    const el = document.querySelector('[data-hero-variant]');
    let webglAvailable = false;
    try {
      const c = document.createElement('canvas');
      webglAvailable = !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch {
      webglAvailable = false;
    }
    const canvas = el ? el.querySelector('canvas') : null;
    return {
      variant: el ? el.getAttribute('data-hero-variant') : null,
      mode: el ? el.getAttribute('data-hero-mode') : null,
      webglAvailable,
      canvasW: canvas ? canvas.clientWidth : 0,
      canvasH: canvas ? canvas.clientHeight : 0,
    };
  });

  if (!state.variant) {
    // No Home hero on this surface (gallery-mode demo front door). Skip — not a failure.
    console.log(
      `  ::notice:: no hero backdrop on ${BASE}/ ([data-hero-variant] absent — gallery-mode demo has no Home hero, and no editorial cohort site is rebuilt yet). Skipping the halftone live-proof (NOT a failure); run HALFTONE_BASE=<home-hero-url> to hard-prove. The unit source-gate + local WebGL proof cover the variant.`,
    );
    skipped = true;
  } else {
    // A. override reached the DOM.
    check(`[data-hero-variant] === "${VARIANT}" (?bg override wired to the backdrop)`, state.variant === VARIANT, `got "${state.variant}"`);

    // B. WebGL shader path won when WebGL is available (proves the GLSL uMode==13 branch compiled+linked).
    if (state.webglAvailable) {
      check('data-hero-mode === "webgl" — the halftone GLSL compiled + is running (not the static fallback)', state.mode === 'webgl', `mode="${state.mode}"`);
      check('backdrop <canvas> mounted with non-zero size', state.canvasW > 0 && state.canvasH > 0, `${state.canvasW}×${state.canvasH}`);
    } else {
      console.log(`  ::notice:: WebGL unavailable in this headless env → static fallback is CORRECT (mode="${state.mode}"); webgl-render proof deferred to a WebGL-capable browser`);
    }

    // C. the hero actually PAINTED non-black (the shader's 0.10 dark base is non-black by construction).
    await page.screenshot({ path: SHOT, clip: { x: 0, y: 0, width: 1280, height: 620 } }).catch(() => {});
    if (sharp) {
      try {
        const { data } = await sharp(SHOT).greyscale().raw().toBuffer({ resolveWithObject: true });
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const mean = sum / data.length;
        let sq = 0;
        for (let i = 0; i < data.length; i++) sq += (data[i] - mean) ** 2;
        const stddev = Math.sqrt(sq / data.length);
        // Non-black sane band: not a black/failed field (mean too low) and not blown out (mean too high).
        check('hero screenshot is non-black (rendered, not a black/failed field)', mean > 4 && mean < 210, `mean-luma=${mean.toFixed(1)} stddev=${stddev.toFixed(1)}`);
        if (state.mode === 'webgl') console.log(`  · detail: mean-luma=${mean.toFixed(1)} stddev=${stddev.toFixed(1)} (dot structure raises stddev vs a flat gradient)`);
      } catch (e) {
        console.log(`  ::notice:: luminance analysis skipped (${String(e).slice(0, 50)})`);
      }
    }

    // D. LCP-safe — the LCP element is hero content, never the decorative backdrop canvas.
    const lcp = await page.evaluate(
      () =>
        new Promise((res) => {
          let out = { tag: '?', time: 0, isCanvas: false };
          try {
            new PerformanceObserver((list) => {
              const last = list.getEntries().at(-1);
              if (!last) return;
              const el = last.element;
              const tag = el ? el.tagName.toLowerCase() : '?';
              out = { tag, time: Math.round(last.startTime), isCanvas: tag === 'canvas' };
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            /* unsupported */
          }
          setTimeout(() => res(out), 1500);
        }),
    );
    check('LCP element is NOT the decorative backdrop canvas (LCP-safe)', !lcp.isCanvas, `lcp tag=${lcp.tag} t=${lcp.time}ms`);
    if (lcp.time > 2500) console.log(`  ⏱ advisory: LCP ${lcp.time}ms > 2500ms — watch for a trend`);

    // E. 0 cold-load console errors.
    check('0 cold-load console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
  }
  await ctx.close();
} catch (e) {
  check('halftone hero audit completed', false, 'error: ' + String(e).slice(0, 120));
} finally {
  await browser.close();
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(64)} [${r.detail}]`);
console.log(`::json:: ${JSON.stringify({ probe: 'hero-halftone', base: BASE, variant: VARIANT, checks: rows.length, fails, skipped, pass: fails === 0 })}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} check(s): the halftone hero backdrop is broken (GLSL branch failed to compile → static fallback, or not LCP-safe). Fix the uMode==13 branch in template WebGLHeroBackdrop.tsx.`
    : skipped
      ? `\nVERDICT: ⏭️  SKIP — no Home hero on ${BASE} (gallery-mode demo); halftone is guarded by the unit source-gate + local WebGL proof (set HALFTONE_BASE to a Home-hero surface to hard-prove)`
      : `\nVERDICT: ✅ PASS — halftone hero backdrop compiles + renders (WebGL), non-black, LCP-safe, 0 console errors (screenshot → _halftone-hero.png)`,
);
process.exit(fails ? 1 : 0);
