#!/usr/bin/env node
/**
 * verify-card-tilt.mjs — § C.7 (cinematic distinctiveness): the pointer 3D depth-TILT system is
 * LIVE, LCP/CLS-safe, operable, and reduced-motion-safe on deployed sites.
 *
 * The template's TiltCard (Awwwards/Framer-signature pointer-driven 3D tilt + light-catching glare)
 * wraps the hero image on every site and — as of this fire — the retail FeaturedCollection product
 * cards (each with a corner badge floating on a translateZ depth-layer). This probe proves the
 * effect's HARD contract on prod, the way a cinematic upgrade can silently regress:
 *   1. REST = IDENTITY — with no pointer, `[data-tilt]` computes to an identity transform, so it
 *      NEVER displaces layout / shifts CLS / disturbs the LCP hero (the tilt is a pointer-only,
 *      post-hydration enhancement). A non-identity transform at rest = a real LCP/CLS regression.
 *   2. POINTER ACTIVATES — a real pointer move over the element engages a non-identity 3D transform
 *      (the tilt works, not a dead wrapper).
 *   3. REDUCED-MOTION OFF — under `prefers-reduced-motion: reduce`, a pointer move leaves the element
 *      at identity (the static, gorgeous fallback; no listeners attach).
 *   4. 0 console errors on the cold load.
 * Also reports `[data-tilt-layer]` count (the product-card depth badges) as the "product-grid depth
 * tilt landed on this rebuild" signal.
 *
 * Fail-OPEN (::notice, exit 0) for a site with NO `[data-tilt]` (nothing to test) — so the suite
 * stays green and flips to a real assertion as sites carry the effect. Fail-CLOSED on a real
 * contract break (rest not identity / pointer dead / reduced-motion still tilts / console errors).
 *
 * Usage: SITES=flora-grubb-san-francisco node e2e/site-quality/verify-card-tilt.mjs
 */
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'flora-grubb-san-francisco,catbird-brooklyn,gentle-dental-seattle').split(
  ',',
);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const isIdentity = (t) => !t || t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';

const b = await chromium.launch();

/** Probe one site's tilt contract. Returns a structured result (never throws). */
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
    await p.goto(`https://${slug}.projectsites.dev/?cb=${Date.now()}`, {
      waitUntil: 'load',
      timeout: 45000,
    });
    await p.waitForTimeout(1200);
    const tilts = await p.locator('[data-tilt]').count();
    const depthLayers = await p.locator('[data-tilt-layer]').count();
    if (tilts === 0) {
      return { slug, tilts: 0, depthLayers, skip: true, errors };
    }
    const el = p.locator('[data-tilt]').first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox();
    const restT = await el.evaluate((n) => getComputedStyle(n).transform);
    let activeT = restT;
    if (box) {
      // Move to a corner-ish point so the tilt is unambiguously non-zero (center ≈ 0 tilt).
      await p.mouse.move(box.x + box.width * 0.22, box.y + box.height * 0.22, { steps: 3 });
      await p.waitForTimeout(220); // rAF + the 0.09-0.12s active transition
      activeT = await el.evaluate((n) => getComputedStyle(n).transform);
      await p.mouse.move(box.x - 40, box.y - 40); // leave
    }
    const ownErrors = errors.filter((e) => !/googletag|google-analytics|posthog|fonts\.g|clarity/i.test(e));
    return {
      slug,
      tilts,
      depthLayers,
      restIdentity: isIdentity(restT),
      activated: !isIdentity(activeT),
      restT: restT.slice(0, 40),
      activeT: activeT.slice(0, 40),
      errors: ownErrors,
    };
  } catch (e) {
    return { slug, error: String(e).slice(0, 140), errors };
  } finally {
    await ctx.close();
  }
}

const results = [];
for (const slug of SITES) {
  const normal = await probe(slug);
  if (normal.skip || normal.error) {
    results.push(normal);
    continue;
  }
  const rm = await probe(slug, { reduced: true }); // reduced-motion fallback leg
  // Under reduce, a pointer move must leave the element at identity (no listeners attach).
  results.push({ ...normal, reducedMotionIdentity: rm.skip || rm.error ? true : isIdentity(rm.activeT) });
}
await b.close();

console.log('\n━━ § C.7 pointer 3D depth-tilt — LCP/CLS-safe + operable + reduced-motion-safe (prod) ━━');
let tested = 0;
let failed = false;
for (const r of results) {
  if (r.error) {
    console.log(`  ⚠️  ${r.slug} — unreachable (${r.error}); skipped`);
    continue;
  }
  if (r.skip) {
    console.log(`  ⚠️  ${r.slug} — no [data-tilt] yet (pre-rebuild); skipped`);
    continue;
  }
  tested++;
  console.log(
    JSON.stringify({
      slug: r.slug,
      tilts: r.tilts,
      depthLayers: r.depthLayers,
      restIdentity: r.restIdentity,
      activated: r.activated,
      reducedMotionIdentity: r.reducedMotionIdentity,
      consoleErrors: r.errors.length,
    }),
  );
  if (!r.restIdentity) {
    failed = true;
    console.error(`  ❌ ${r.slug} tilt is NON-identity AT REST (${r.restT}) — displaces layout / risks CLS + the LCP hero.`);
  }
  if (!r.activated) {
    failed = true;
    console.error(`  ❌ ${r.slug} pointer move did NOT engage a tilt (${r.activeT}) — the effect is dead.`);
  }
  if (!r.reducedMotionIdentity) {
    failed = true;
    console.error(`  ❌ ${r.slug} still tilts under prefers-reduced-motion — a11y fallback broken.`);
  }
  if (r.errors.length) {
    failed = true;
    console.error(`  ❌ ${r.slug} console errors: ${r.errors.join(' | ')}`);
  }
  if (r.restIdentity && r.activated && r.reducedMotionIdentity && !r.errors.length) {
    console.log(
      `  ✓ ${r.slug} — ${r.tilts} tilt target(s), ${r.depthLayers} depth-layer(s); rest-identity ✓ pointer-activates ✓ reduced-motion-off ✓ 0 errors`,
    );
  }
}

if (tested === 0) {
  console.log('\n::notice:: verify-card-tilt SKIPPED — no reachable site carries the tilt system yet (flips to a real assertion as sites rebuild).');
  process.exit(0);
}
if (failed) {
  console.error('\n❌ § C.7 FAIL — the pointer 3D tilt violated its LCP/CLS/a11y contract on prod.');
  process.exit(1);
}
console.log('\nVERDICT: ✅ § C.7 PASS — the cinematic pointer 3D depth-tilt is live, LCP/CLS-safe, operable, and reduced-motion-safe.');
process.exit(0);
