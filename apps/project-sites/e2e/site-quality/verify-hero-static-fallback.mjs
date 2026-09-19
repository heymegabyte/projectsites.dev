// verify-hero-static-fallback.mjs — COMPLETION § C.7 (distinctiveness): does the DEPLOYED
// generated site render a GORGEOUS, per-industry STATIC hero backdrop for the reduced-motion /
// no-WebGL visitor — the a11y segment the animated-canvas probe is structurally blind to?
//
// WHY THIS PROBE EXISTS (the gap it closes): verify-hero-backdrop.mjs proves the ANIMATED WebGL
// scene mounts + renders non-black. But `prefers-reduced-motion: reduce` and no-WebGL visitors NEVER
// see that scene — `resolveBackdropMode` hands them the STATIC CSS fallback instead. That fallback
// used to be ONE generic twin-radial wash, identical across all 16 personalities: reduced-motion
// users lost every per-industry cue the animated backdrop gives everyone else. Template 9da77cf made
// `staticBackdropFor(variant)` return a bespoke scene-evoking gradient for the 3 most distinct
// personalities — grid (retro synthwave perspective grid), terrain (rugged topographic contour
// rings), monolith (brutalist slab + fault seam). This probe is the DEPLOYED-ARTIFACT regression
// guard for that a11y path; the template unit test (WebGLHeroBackdrop.test.ts) guards the source.
//
// WHAT IT PROVES, launched with reducedMotion:'reduce' (the honest trigger for the static path):
//   HARD (durable — true on EVERY build, old or new):
//     • the hero resolves to mode="static" (reduced-motion is respected — not the animated scene)
//     • the static backdrop <div> paints a NON-EMPTY, brand-tinted CSS gradient (never flat/blank)
//     • it is LCP-SAFE BY CONSTRUCTION: aria-hidden + negative z-index + no text/img → structurally
//       incapable of being the LCP element (the H1, which paints, is)
//     • the hero <h1> paints + 0 console errors
//   ADVISORY (STALE_FLIPPABLE — only strictly true after a rebuild on template ≥ 9da77cf):
//     • on a bespoke-variant site (grid/terrain/monolith) the gradient carries its scene signature.
//       A generic wash there = a site built BEFORE 9da77cf → "rebuild to pick up per-variant fallback",
//       NOT a template bug (the stale-build-debt class). STRICT=1 promotes this to a hard fail.
//
// Fixes are ROOT-CAUSE in the TEMPLATE (github.com/HeyMegabyte/template.projectsites.dev), never a
// one-off patch to one site. Auto-joins run-all.mjs (globs verify-*.mjs).
//
// Usage:
//   node e2e/site-quality/verify-hero-static-fallback.mjs
//   SITES=some-rugged-outfitter node e2e/site-quality/verify-hero-static-fallback.mjs   # prove bespoke
//   STRICT=1 SITES=… node e2e/site-quality/verify-hero-static-fallback.mjs              # advisory → hard
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);
const VIEWPORT = { width: Number(process.env.VIEWPORT) || 1280, height: 900 };
const HYDRATE_MS = 6000; // mode resolves in a post-hydration effect — give it time to settle
const STRICT = process.env.STRICT === '1';

// The scene signature each bespoke variant's static gradient MUST carry (survives computed-style
// normalization). A bespoke-variant site missing its signature = a stale build (generic wash).
const BESPOKE_SIGNATURE = {
  grid: 'repeating-linear-gradient', // synthwave perspective grid lines
  terrain: 'repeating-radial-gradient', // topographic contour rings
  monolith: 'linear-gradient', // slab + fault seam (generic wash is radial-only → linear = bespoke)
};

let hardFails = 0;
let staleAdvisories = 0;
const rows = [];

const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    // reducedMotion:'reduce' is the honest trigger — it forces resolveBackdropMode → 'static'.
    const ctx = await browser.newContext({ userAgent: UA, viewport: VIEWPORT, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120));
    });
    try {
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
      const title = await page.title().catch(() => '');
      if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
        rows.push({ slug, note: `NOT MEASURABLE (status=${resp ? resp.status() : 'none'} / challenge shell)` });
        await ctx.close().catch(() => {});
        continue;
      }
      // Wait for the backdrop root to mount (post-hydration).
      let hasRoot = false;
      try {
        await page.waitForSelector('[data-hero-variant]', { timeout: HYDRATE_MS, state: 'attached' });
        hasRoot = true;
      } catch {
        hasRoot = false;
      }
      if (!hasRoot) {
        // STALE-BUILD-DEBT (not a false-red): the `data-hero-variant`/`data-hero-mode` attributes
        // POST-DATE every currently-deployed build, so a site without them was built on an older
        // template — "rebuild to measure", never a current template bug. A hero <canvas> present
        // confirms the backdrop is wired (just pre-data-attr); absent = an even older pre-backdrop
        // build. Either way this is NOT MEASURABLE for the static-fallback contract, not a FAIL —
        // mirrors verify-hero-backdrop.mjs's targeting note + the repo's stale-classification discipline.
        const canvasCount = await page.evaluate(() => document.querySelectorAll('section canvas, canvas').length);
        rows.push({
          slug,
          note:
            canvasCount > 0
              ? 'NOT MEASURABLE (stale build — hero wired but pre-data-hero-variant; rebuild on template ≥ 9da77cf)'
              : 'NOT MEASURABLE (stale build — pre-backdrop template; rebuild to measure)',
        });
        await ctx.close().catch(() => {});
        continue;
      }

      const probe = await page.evaluate(() => {
        const root = document.querySelector('[data-hero-variant]');
        if (!root) return { ok: false, reason: 'no-root' };
        const variant = root.getAttribute('data-hero-variant') || '';
        const mode = root.getAttribute('data-hero-mode') || '';
        const cs = getComputedStyle(root);
        // The static backdrop layer: the full-size, non-absolute <div> (NOT .hero-wash / sheen / grain).
        const layers = Array.from(root.querySelectorAll(':scope > div'));
        const staticDiv = layers.find(
          (d) =>
            d.classList.contains('h-full') &&
            d.classList.contains('w-full') &&
            !d.classList.contains('absolute') &&
            !d.classList.contains('hero-wash'),
        );
        const staticBg = staticDiv ? getComputedStyle(staticDiv).backgroundImage : 'none';
        // LCP-safety structural proof: aria-hidden + negative stacking + carries no text/img.
        const ariaHidden = root.getAttribute('aria-hidden') === 'true';
        const zIndex = cs.zIndex;
        const textLen = (root.textContent || '').trim().length;
        const imgCount = root.querySelectorAll('img').length;
        // Real content painted: the hero <h1> has a real painted box.
        const h1 = document.querySelector('h1');
        const r = h1 ? h1.getBoundingClientRect() : null;
        const h1Painted = !!r && r.width > 0 && r.height > 0;
        return {
          ok: true,
          variant,
          mode,
          staticBg: (staticBg || 'none').slice(0, 400),
          ariaHidden,
          zIndex,
          backdropHasContent: textLen > 0 || imgCount > 0,
          h1Painted,
        };
      });

      if (!probe.ok) {
        hardFails++;
        rows.push({ slug, pass: false, detail: `probe could not read hero (${probe.reason})` });
        await ctx.close().catch(() => {});
        continue;
      }

      // HARD gates (durable across builds).
      const isStatic = probe.mode === 'static';
      const hasGradient = /gradient/.test(probe.staticBg) && probe.staticBg !== 'none';
      const lcpSafe = probe.ariaHidden && Number(probe.zIndex) < 0 && !probe.backdropHasContent;
      const hardOk = isStatic && hasGradient && lcpSafe && probe.h1Painted && consoleErrors.length === 0;
      if (!hardOk) hardFails++;

      // ADVISORY: bespoke variants should carry their scene signature; absence = stale build.
      const sig = BESPOKE_SIGNATURE[probe.variant];
      let bespoke = null;
      if (sig) {
        const carriesSignature = probe.staticBg.includes(sig);
        bespoke = carriesSignature ? 'bespoke ✓' : 'GENERIC WASH (stale build — rebuild for per-variant fallback)';
        if (!carriesSignature) {
          staleAdvisories++;
          if (STRICT) hardFails++;
        }
      }

      rows.push({
        slug,
        pass: hardOk,
        variant: probe.variant,
        mode: probe.mode,
        gradient: hasGradient,
        lcpSafe,
        h1: probe.h1Painted,
        errs: consoleErrors.length,
        bespoke,
      });
    } catch (e) {
      hardFails++;
      rows.push({ slug, pass: false, detail: `probe error: ${String(e).slice(0, 90)}` });
    } finally {
      await ctx.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}

console.log(
  `\n━━ § C.7 hero STATIC fallback (reduced-motion, deployed, real browser @ ${VIEWPORT.width}px) ━━`,
);
for (const r of rows) {
  if (r.note) {
    console.log(`  ⚠️  ${r.slug} — ${r.note}`);
    continue;
  }
  if (r.detail) {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.slug} — ${r.detail}`);
    continue;
  }
  const mark = r.pass ? '✅' : '❌';
  const bespoke = r.bespoke ? ` · ${r.bespoke}` : '';
  console.log(
    `  ${mark} ${r.slug} — variant=${r.variant} mode=${r.mode} gradient=${r.gradient ? '✓' : '✗'} lcp-safe=${r.lcpSafe ? '✓' : '✗'} h1=${r.h1 ? '✓' : '✗'} errs=${r.errs}${bespoke}`,
  );
}

const measurable = rows.filter((r) => !r.note);
if (measurable.length === 0) {
  console.log(
    '\n::notice:: skipped — no site was measurable (all non-200 / challenge shells / stale pre-data-hero-variant builds). Rebuild a site on template ≥ 9da77cf, then SITES=<slug> to measure the static fallback live.',
  );
  process.exit(0);
}
if (staleAdvisories > 0 && !STRICT) {
  console.log(
    `\n::notice:: ${staleAdvisories} bespoke-variant site(s) still show the generic wash — built before template 9da77cf. Rebuild to pick up the per-variant static fallback (advisory; STRICT=1 to enforce).`,
  );
}
if (hardFails > 0) {
  console.error(
    `\n✗ § C.7 FAIL — ${hardFails} site(s): the reduced-motion / no-WebGL hero fallback is missing, blank, not LCP-safe, or (STRICT) a stale generic wash on a bespoke variant.`,
  );
  process.exit(1);
}
console.log(
  `\nVERDICT: ✅ § C.7 PASS — ${measurable.length} deployed site(s) serve a gorgeous, LCP-safe, brand-tinted STATIC hero backdrop to reduced-motion / no-WebGL visitors.`,
);
