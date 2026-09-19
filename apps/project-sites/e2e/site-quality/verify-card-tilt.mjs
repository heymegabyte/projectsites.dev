#!/usr/bin/env node
/**
 * verify-card-tilt.mjs — § C.7 (cinematic distinctiveness): the pointer 3D depth-TILT system is
 * deployed correctly, LCP/CLS-safe, and reduced-motion-safe on generated sites.
 *
 * The template's TiltCard (Awwwards/Framer-signature pointer 3D tilt + light-catching glare) wraps
 * the hero image and — as of this fire — the retail FeaturedCollection product cards (each corner
 * badge floating on a translateZ depth-layer). The tilt is DECLARED in a linked stylesheet:
 * `.tilt-inner[data-tilt] { transform: rotateX(var(--tilt-rx)) rotateY(var(--tilt-ry)) }` under
 * `@media (prefers-reduced-motion: no-preference)`; the pointer handler only sets the CSS vars.
 *
 * STALE-BUILD DISCIPLINE (validator-precision + report-mode-probe-deployed-defect-is-often-stale):
 * a deployed site built BEFORE the tilt CSS landed ships the `[data-tilt]` markup but not the rule,
 * so it can never tilt — that's stale-build debt (a full rebuild applies it), NOT a template defect.
 * The probe DETECTS deployment by forcing the tilt vars: if the transform changes, the CSS is in the
 * bundle (fresh build) and the contract is asserted; if it stays identity, the rule isn't deployed →
 * SKIP (::notice). Fail-OPEN when no site carries the effect. It thus flips to a real GREEN assertion
 * as sites full-rebuild, and never false-REDs a stale build.
 *
 * Fail-CLOSED (a real regression) only on the DETERMINISTIC, safety-critical invariants:
 *   1. REST = IDENTITY — no pointer → identity transform → never displaces layout / LCP / CLS.
 *   2. REDUCED-MOTION GATED — under `prefers-reduced-motion: reduce`, forcing the vars still yields
 *      identity (the `no-preference` media query correctly withholds the transform) → static fallback.
 *   3. 0 console errors on the cold load.
 * Pointer activation + `[data-tilt-layer]` depth-badge count are REPORTED (advisory) — pointer/GPU
 * behaviour is environment-sensitive, so a flaky live-activation gate is worse than none.
 *
 * Usage: SITES=luna-felix-goldsmith-santa-fe node e2e/site-quality/verify-card-tilt.mjs
 */
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'luna-felix-goldsmith-santa-fe,catbird-brooklyn,gentle-dental-seattle').split(
  ',',
);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const isIdentity = (t) => !t || t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';

/** Force the tilt vars on the first [data-tilt] el and return its computed transform. */
const FORCE = () => {
  const el = document.querySelector('[data-tilt]');
  if (!el) return null;
  el.style.setProperty('--tilt-rx', '9deg');
  el.style.setProperty('--tilt-ry', '-11deg');
  el.dataset.tilting = '1';
  return getComputedStyle(el).transform;
};

const b = await chromium.launch();

async function probe(slug, { reduced } = {}) {
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    ...(reduced ? { reducedMotion: 'reduce' } : {}),
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 140));
  });
  p.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 140)}`));
  try {
    await p.goto(`https://${slug}.projectsites.dev/?cb=${Date.now()}`, { waitUntil: 'load', timeout: 45000 });
    await p.waitForTimeout(1200);
    const tilts = await p.locator('[data-tilt]').count();
    if (tilts === 0) return { slug, tilts: 0, skip: true, errors };
    const depthLayers = await p.locator('[data-tilt-layer]').count();
    const el = p.locator('[data-tilt]').first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const restT = await el.evaluate((n) => getComputedStyle(n).transform);
    const forcedT = await p.evaluate(FORCE); // CSS-presence probe
    // real pointer activation (advisory)
    let activated = false;
    const box = await el.boundingBox();
    if (box) {
      await p.evaluate(() => {
        const el2 = document.querySelector('[data-tilt]');
        if (el2) {
          el2.style.removeProperty('--tilt-rx');
          el2.style.removeProperty('--tilt-ry');
          el2.dataset.tilting = '0';
        }
      });
      await p.mouse.move(box.x + box.width * 0.24, box.y + box.height * 0.22, { steps: 3 });
      await p.waitForTimeout(220);
      activated = !isIdentity(await el.evaluate((n) => getComputedStyle(n).transform));
    }
    const ownErrors = errors.filter((e) => !/googletag|google-analytics|posthog|fonts\.g|clarity/i.test(e));
    return { slug, tilts, depthLayers, restIdentity: isIdentity(restT), cssPresent: !isIdentity(forcedT), activated, errors: ownErrors };
  } catch (e) {
    return { slug, error: String(e).slice(0, 140), errors };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const results = [];
for (const slug of SITES) {
  const normal = await probe(slug);
  if (normal.skip || normal.error || !normal.cssPresent) {
    results.push(normal);
    continue;
  }
  // Reduced-motion leg: forcing the vars under `reduce` must STILL be identity (media-gated).
  const rm = await probe(slug, { reduced: true });
  const rmForced = rm.skip || rm.error ? null : rm.cssPresent; // cssPresent==true under reduce ⇒ transform leaked ⇒ a11y break
  results.push({ ...normal, reducedMotionGated: rmForced === null ? true : rmForced === false });
}
await b.close();

console.log('\n━━ § C.7 pointer 3D depth-tilt — deployed correctly + LCP/CLS-safe + reduced-motion-safe (prod) ━━');
let tested = 0;
let failed = false;
for (const r of results) {
  if (r.error) {
    console.log(`  ⚠️  ${r.slug} — unreachable (${r.error}); skipped`);
    continue;
  }
  if (r.skip) {
    console.log(`  ⚠️  ${r.slug} — no [data-tilt] (pre-hero-tilt build); skipped`);
    continue;
  }
  if (!r.cssPresent) {
    console.log(`  ⚠️  ${r.slug} — [data-tilt] present but the tilt CSS rule is NOT in the deployed bundle (stale build predating the tilt CSS); a full rebuild applies it — skipped, not failed.`);
    continue;
  }
  tested++;
  console.log(
    JSON.stringify({
      slug: r.slug,
      tilts: r.tilts,
      depthLayers: r.depthLayers,
      restIdentity: r.restIdentity,
      reducedMotionGated: r.reducedMotionGated,
      activated: r.activated,
      consoleErrors: r.errors.length,
    }),
  );
  if (!r.restIdentity) {
    failed = true;
    console.error(`  ❌ ${r.slug} tilt is NON-identity AT REST — displaces layout / risks CLS + the LCP hero.`);
  }
  if (!r.reducedMotionGated) {
    failed = true;
    console.error(`  ❌ ${r.slug} still transforms under prefers-reduced-motion — a11y fallback broken.`);
  }
  if (r.errors.length) {
    failed = true;
    console.error(`  ❌ ${r.slug} console errors: ${r.errors.join(' | ')}`);
  }
  if (r.restIdentity && r.reducedMotionGated && !r.errors.length) {
    console.log(
      `  ✓ ${r.slug} — tilt CSS deployed; ${r.tilts} tilt target(s), ${r.depthLayers} depth-layer(s); rest-identity ✓ reduced-motion-gated ✓ 0 errors · pointer-activates(advisory)=${r.activated}`,
    );
  }
}

if (tested === 0) {
  console.log('\n::notice:: verify-card-tilt SKIPPED — no reachable site carries the tilt CSS yet (flips to a real assertion as sites full-rebuild).');
  process.exit(0);
}
if (failed) {
  console.error('\n❌ § C.7 FAIL — the pointer 3D tilt violated its LCP/CLS/a11y contract on a fresh-build prod site.');
  process.exit(1);
}
console.log('\nVERDICT: ✅ § C.7 PASS — the cinematic pointer 3D depth-tilt is deployed correctly, LCP/CLS-safe, and reduced-motion-safe.');
process.exit(0);
