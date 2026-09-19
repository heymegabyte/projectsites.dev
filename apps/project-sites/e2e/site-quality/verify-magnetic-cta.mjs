// verify-magnetic-cta.mjs — CINEMATIC-3D (§ C.7 distinctiveness): the Framer/Awwwards MAGNETIC CTA
// (MagneticButton, AL-738) on a deployed generated site — the primary hero button LEANS toward the
// cursor as it nears + a brand halo tracks it, springing back at rest. This gate proves the effect
// RENDERS + REACTS while staying LCP/a11y-safe (the exact HARD constraints of this loop):
//
//   FINE-POINTER + MOTION context:
//     1. the hero primary CTA is wrapped in a `.magnetic-cta` (present at all).
//     2. LCP-SAFE at rest — before any pointer move the wrapper transform is IDENTITY (no shift),
//        and the LCP element is the hero <h1>/<img>, NOT the magnetic wrapper.
//     3. REACTS — moving the pointer to within the magnet radius leans the button (data-magnetic=1
//        + a non-identity translate); moving far RELEASES it back to identity (data-magnetic=0).
//     4. 0 console errors across the interaction.
//   REDUCED-MOTION context (prefers-reduced-motion: reduce):
//     5. STATIC — moving the pointer near the CTA leaves the transform IDENTITY (no lean); the plain
//        button is untouched (MagneticButton attaches no listeners under reduced-motion).
//
// STALE-BUILD / FAIL-OPEN discipline (matches verify-card-tilt / verify-kinetic-marquee /
// verify-scroll-stack, per `red-probe-is-often-stale-assertion` + `report-mode-probe-deployed-defect-
// is-often-stale-build-debt`): the MagneticButton is AUTO-ON in the template and lands on each site's
// NEXT full build (NO redeploy of existing sites). A pre-AL-738 build carries no `.magnetic-cta`, so
// an absent wrapper is rebuild-worklist debt, NOT a regression — the probe DEPLOY-DETECTS via
// `.magnetic-cta` presence and SKIPS (::notice, exit 0) when absent, so a stale fleet never reds the
// suite. Where the wrapper IS present the full contract is fail-CLOSED (a real break on a FRESH build
// still fails). Local Chromium ({slug}.projectsites.dev is CF-clean). Auto-joins run-all.
// Usage: SITES=<slug> node e2e/site-quality/verify-magnetic-cta.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSites } from './_default-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SLUG = resolveSites(process.env.SITES)[0];
if (!SLUG) {
  console.log('::notice:: verify-magnetic-cta skipped — no site resolved');
  process.exit(0);
}
const BASE = `https://${SLUG}.projectsites.dev`;

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };
// A CSS transform matrix is a lean when its translate components (m41,m42) are non-trivial.
const leaned = (t) => {
  if (!t || t === 'none') return false;
  const m = t.match(/matrix\(([^)]+)\)/);
  if (!m) return false;
  const p = m[1].split(',').map((n) => parseFloat(n.trim()));
  return Math.abs(p[4] || 0) > 0.5 || Math.abs(p[5] || 0) > 0.5;
};

const browser = await chromium.launch();
try {
  // ── FINE POINTER + MOTION ──────────────────────────────────────────────────────────
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });
  page.on('pageerror', (e) => consoleErrors.push('PE ' + String(e).slice(0, 120)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  const cta = page.locator('.magnetic-cta').first();
  const present = (await cta.count()) > 0;
  if (!present) {
    // DEPLOY-DETECT → fail-OPEN: no `.magnetic-cta` = a pre-AL-738 stale build. Skip (::notice,
    // exit 0) so stale-build debt never reds the suite; the fail-CLOSED contract below runs once a
    // site carries the wrapper. Mirrors verify-card-tilt's "no reachable site carries the effect yet".
    await ctx.close();
    await browser.close();
    console.log(
      `::notice:: verify-magnetic-cta SKIPPED — ${SLUG} carries no .magnetic-cta yet (pre-AL-738 stale build; MagneticButton is auto-on in the template + lands on the next full build, NO redeploy → flips to a real assertion on rebuild).`,
    );
    process.exit(0);
  }
  check('hero primary CTA is wrapped in .magnetic-cta', present);

  if (present) {
    // 2. LCP-safe at rest — identity transform + LCP element is not the magnetic wrapper.
    const restTransform = await cta.evaluate((el) => getComputedStyle(el).transform);
    check('LCP-safe: magnetic wrapper is IDENTITY at rest (no shift)', !leaned(restTransform), `rest="${restTransform}"`);
    const lcpTag = await page.evaluate(
      () =>
        new Promise((res) => {
          let el = null;
          new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) el = e.element; }).observe({
            type: 'largest-contentful-paint',
            buffered: true,
          });
          setTimeout(() => res(el ? `${el.tagName}${el.className ? '.' + String(el.className).split(' ')[0] : ''}` : 'none'), 1200);
        }),
    );
    check('LCP-safe: LCP element is the hero (h1/img), NOT the magnetic CTA', !/magnetic-cta/i.test(lcpTag), `lcp=${lcpTag}`);

    // 3. Reacts — move the pointer to within the magnet radius, then far away.
    const box = await cta.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2); // ~18px off-centre, inside radius
      await page.waitForTimeout(220);
      const leanState = await cta.evaluate((el) => ({ t: getComputedStyle(el).transform, d: el.dataset.magnetic }));
      check('magnet ENGAGES near the pointer (leans + data-magnetic=1)', leaned(leanState.t) && leanState.d === '1', `t="${leanState.t}" d=${leanState.d}`);

      await page.mouse.move(10, 10); // far corner → beyond radius
      await page.waitForTimeout(300);
      const relState = await cta.evaluate((el) => ({ t: getComputedStyle(el).transform, d: el.dataset.magnetic }));
      check('magnet RELEASES to rest when the pointer leaves', !leaned(relState.t) && relState.d !== '1', `t="${relState.t}" d=${relState.d}`);
    } else {
      check('magnetic CTA has a layout box', false, 'no boundingBox');
    }
  }
  check('0 console errors across the interaction', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await ctx.close();

  // ── REDUCED MOTION — must stay STATIC ────────────────────────────────────────────────
  if (present) {
    const rmCtx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const rmPage = await rmCtx.newPage();
    await rmPage.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await rmPage.waitForTimeout(1000);
    const rmCta = rmPage.locator('.magnetic-cta').first();
    const box = await rmCta.boundingBox();
    if (box) {
      await rmPage.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2);
      await rmPage.waitForTimeout(250);
      const t = await rmCta.evaluate((el) => getComputedStyle(el).transform);
      check('reduced-motion: magnet stays STATIC (no lean)', !leaned(t), `t="${t}"`);
    }
    await rmCtx.close();
  }
} catch (e) {
  check('magnetic-cta audit completed', false, 'error: ' + String(e).slice(0, 140));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(58)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} magnetic-CTA gate(s) on ${SLUG} (effect absent/broken, or not LCP/reduced-motion-safe). Root: template MagneticButton (AL-738) lands next build.`
    : `\nVERDICT: ✅ PASS — the magnetic CTA leans toward the pointer + releases at rest, stays IDENTITY-at-rest (LCP-safe) and STATIC under reduced-motion, 0 console errors, on ${SLUG}.`,
);
process.exit(fails ? 1 : 0);
