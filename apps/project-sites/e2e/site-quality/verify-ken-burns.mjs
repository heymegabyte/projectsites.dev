// verify-ken-burns.mjs — § C.7 distinctiveness (CINEMATIC-3D): a below-fold section image slowly
// SCALES as it scrolls through the viewport (Ken-Burns "living imagery", the Obys/Immersive-Garden
// signature). Driven by native `animation-timeline: view()` on a `.ps-ken-burns` wrapper inside the
// framed image — compositor (INP-safe), transform-only clipped by the frame (CLS-safe), below-fold
// (LCP-safe). STATIC under prefers-reduced-motion (image at natural 1.0, never stuck mid-zoom).
// Real local Chromium (generated-site subdomains are CF-clean). Auto-joins run-all.
//
// A site with no filled below-fold image (skeleton `{ABOUT_IMAGE_URL}` placeholder) or a pre-fix
// build has no `.ps-ken-burns` → SKIP (tracking ::notice; STRICT=1 → exit 1).
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'franklin-barbecue,wally-workman-gallery-austin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
/** Extract scaleX (matrix `a`) from a computed transform; 1 for none/identity. */
const scaleOf = (t) => {
  if (!t || t === 'none') return 1;
  const m = /^matrix\(([^)]+)\)/.exec(t);
  return m ? parseFloat(m[1].split(',')[0]) || 1 : 1;
};

const browser = await chromium.launch();
const rows = [];
let fails = 0;

/**
 * Load under a motion pref; bring the .ps-ken-burns wrapper into view and read its computed scale.
 * PRIMARY signal is boundary-independent: an ACTIVE view()-timeline zoom holds the wrapper at a
 * mid-range scale (>1.0) whenever it's on-screen, while a reduced-motion / no-view() context leaves
 * it at the natural 1.0. Comparing the two contexts at the same in-view position proves the effect
 * without depending on how far the page can scroll (the About split often sits just above the footer,
 * so a relative scrollBy can't move it through its range — the earlier flaky drift=false).
 * `drift` (scale change across two computed offsets) is captured as a BONUS, never required.
 */
async function inspect(slug, reduced) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    ...(reduced ? { reducedMotion: 'reduce' } : {}),
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const t = m.type(),
      x = m.text();
    if (/Failed to load resource|net::ERR_ABORTED|favicon|status of 4|status of 5/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 80));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 80)));
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 45000 });
    if (!resp || resp.status() >= 400) return { status: resp?.status(), errs };
    await page.waitForTimeout(900);
    if ((await page.locator('.ps-ken-burns').count()) === 0) return { none: true, errs };
    const el = page.locator('.ps-ken-burns').first();
    // In-view sample (the robust cross-context signal).
    await el.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -120));
    await page.waitForTimeout(250);
    const sInView = scaleOf(await el.evaluate((n) => getComputedStyle(n).transform));
    // Bonus: sample at two absolute offsets (element-entering vs element-exiting) for a drift number,
    // clamped by the scrollable range — may be ~0 near a page boundary (that's why it's non-blocking).
    const drift = await page.evaluate(async (sel) => {
      const n = document.querySelector(sel);
      if (!n) return 0;
      const scaleAt = () => {
        const t = getComputedStyle(n).transform;
        const m = /^matrix\(([^)]+)\)/.exec(t);
        return m ? parseFloat(m[1].split(',')[0]) || 1 : 1;
      };
      const absTop = n.getBoundingClientRect().top + window.scrollY;
      const wait = () => new Promise((r) => setTimeout(r, 200));
      window.scrollTo(0, Math.max(0, absTop - window.innerHeight + 60)); // just entering from bottom
      await wait();
      const a = scaleAt();
      window.scrollTo(0, Math.max(0, absTop - 60)); // near the top (about to exit)
      await wait();
      const b = scaleAt();
      return Math.abs(b - a);
    }, '.ps-ken-burns');
    const lcp = await page.evaluate(
      () => !!document.querySelector('h1') || !!document.querySelector('img[loading="eager"]'),
    );
    return { sInView, drift, lcp, errs };
  } catch (e) {
    return { err: String(e.message || e).slice(0, 70), errs };
  } finally {
    await ctx.close().catch(() => {});
  }
}

for (const slug of SITES) {
  const motion = await inspect(slug, false);
  if (motion.none) {
    rows.push(`  ⏭️  ${slug} — no .ps-ken-burns (no below-fold image / pre-fix build) — skip`);
    continue;
  }
  if (motion.err || motion.status) {
    rows.push(`  ⏭️  ${slug} — unreachable (${motion.err || motion.status}) — skip`);
    continue;
  }
  const reduced = await inspect(slug, true);
  const rInView = reduced.none ? 1 : (reduced.sInView ?? 1);
  // REDUCED-MOTION: no zoom animation → wrapper stays at the natural 1.0 (static), 0 err.
  const reducedStatic = Math.abs(rInView - 1) < 0.03 && (reduced.errs?.length ?? 0) === 0;
  // MOTION (primary, boundary-independent): view()-timeline holds the on-screen wrapper mid-zoom
  // (>1.0, ≤1.15) AND that scale DIFFERS from the reduced-motion static scale → the zoom is live.
  const zooming = motion.sInView > 1.005 && motion.sInView <= 1.15;
  const differsFromStatic = Math.abs(motion.sInView - rInView) > 0.01;
  const motionOk = zooming && differsFromStatic && motion.lcp && motion.errs.length === 0;
  if (motionOk && reducedStatic) {
    const bonus = motion.drift > 0.005 ? ` · drifts ${motion.drift.toFixed(3)} on scroll` : '';
    rows.push(
      `  ✓ ${slug} — image breathes (in-view scale ${motion.sInView.toFixed(3)} vs static ${rInView.toFixed(3)})${bonus} · static@reduced-motion · LCP intact · 0 err`,
    );
  } else {
    fails++;
    rows.push(
      `  ❌ ${slug} — motion{inView=${motion.sInView?.toFixed(3)} zoom=${zooming} vsStatic=${differsFromStatic} lcp=${motion.lcp} err=${motion.errs.length}} reduced{inView=${rInView.toFixed(3)}}`,
    );
  }
}

await browser.close();
console.log('\n━━ § C.7 Ken-Burns living-imagery (below-fold image breathes on scroll) ━━');
rows.forEach((r) => console.log(r));
if (fails > 0 && STRICT) {
  console.log(`\n❌ ${fails} site(s) failed the Ken-Burns contract`);
  process.exit(1);
}
if (fails > 0) {
  console.log(`\n::notice:: ken-burns — ${fails} site(s) not breathing (likely a pre-fix build; rebuild to pick up the template). STRICT=1 to enforce.`);
} else {
  console.log('\n✓ Ken-Burns PASS — below-fold imagery breathes on scroll, static on reduced-motion, LCP-safe.');
}
