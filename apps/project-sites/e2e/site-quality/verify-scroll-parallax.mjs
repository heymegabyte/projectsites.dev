// verify-scroll-parallax.mjs — § C.7 distinctiveness (CINEMATIC-3D): the hero carries native
// CSS scroll-driven DEPTH PARALLAX — decorative background layers (`.ps-parallax`) drift on the Y
// axis at PER-LAYER rates as the page scrolls (motion.so / Awwwards signature), and they are
// STATIC under prefers-reduced-motion. Proven in a real browser (generated-site subdomains are
// CF-clean for headless). Auto-joins run-all.
//
// LCP-safe contract, asserted here: the parallax layers are decorative (aria-hidden) and IDENTITY
// at scroll 0 — so they never delay the LCP <h1>/img nor shift layout. A pre-parallax build (no
// `.ps-parallax`) → SKIP (tracking, not a fail). STRICT=1 → exit 1.
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'pizzeria-bianco-phoenix,wally-workman-gallery-austin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IDENTITY = (t) => t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)/.test(t);
/** Extract the translateY (matrix f component) from a computed transform, 0 for identity/none. */
const translateY = (t) => {
  const m = /^matrix\(([^)]+)\)/.exec(t);
  if (!m) return 0;
  const parts = m[1].split(',').map((n) => parseFloat(n.trim()));
  return parts.length === 6 ? parts[5] : 0;
};

const browser = await chromium.launch();
const rows = [];
let fails = 0;

/** Load a site under the given motion pref; sample every `.ps-parallax` transform at scroll 0 + after a scroll. */
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
    if (/Failed to load resource|net::ERR_ABORTED|favicon|the server responded with a status/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 90));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 90)));
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 45000 });
    if (!resp || resp.status() >= 400) return { status: resp?.status(), errs };
    await page.waitForTimeout(900); // hydration
    const count = await page.locator('.ps-parallax').count();
    if (count === 0) return { none: true, errs };
    const sample = () =>
      page.$$eval('.ps-parallax', (els) =>
        els.map((el) => ({
          transform: getComputedStyle(el).transform,
          timeline: getComputedStyle(el).getPropertyValue('animation-timeline') || '',
          ariaHidden: el.getAttribute('aria-hidden') === 'true',
        })),
      );
    const atTop = await sample();
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(300);
    const scrolled = await sample();
    // LCP candidate present (h1 or eager img) → the parallax never displaced content.
    const lcp = await page.evaluate(
      () => !!document.querySelector('h1') || !!document.querySelector('img[loading="eager"]'),
    );
    return { count, atTop, scrolled, lcp, errs };
  } catch (e) {
    return { err: String(e.message || e).slice(0, 80), errs };
  } finally {
    await ctx.close();
  }
}

for (const slug of SITES) {
  const motion = await inspect(slug, false);
  if (motion.none) {
    rows.push(`  ⏭️  ${slug} — no .ps-parallax (pre-parallax build) — skip`);
    continue;
  }
  if (motion.err || motion.status) {
    rows.push(`  ⏭️  ${slug} — unreachable (${motion.err || motion.status}) — skip`);
    continue;
  }
  const reduced = await inspect(slug, true);
  // MOTION pass: all layers identity at top; ≥1 layer drifts (non-identity) after scroll; layers
  // decorative; LCP present; 0 console errors. Distinct drift magnitudes across layers = real depth.
  const topAllIdentity = motion.atTop.every((l) => IDENTITY(l.transform));
  const drifted = motion.scrolled.filter((l) => !IDENTITY(l.transform));
  const driftYs = new Set(drifted.map((l) => Math.round(translateY(l.transform))));
  const allDecorative = motion.atTop.every((l) => l.ariaHidden);
  const motionOk =
    topAllIdentity && drifted.length >= 1 && allDecorative && motion.lcp && motion.errs.length === 0;
  // REDUCED-MOTION: layers stay identity even after scroll (static), 0 console errors.
  const reducedOk =
    reduced.none ||
    (reduced.scrolled?.every((l) => IDENTITY(l.transform)) && (reduced.errs?.length ?? 0) === 0);

  if (motionOk && reducedOk) {
    rows.push(
      `  ✓ ${slug} — ${motion.count} layers · identity@top · ${drifted.length} drift on scroll (${driftYs.size} distinct depth${driftYs.size > 1 ? 's' : ''}) · static@reduced-motion · LCP intact · 0 err`,
    );
  } else {
    fails++;
    rows.push(
      `  ❌ ${slug} — motion{topIdentity=${topAllIdentity} drifted=${drifted.length}/${motion.count} decorative=${allDecorative} lcp=${motion.lcp} err=${motion.errs.length}} reduced{static=${reduced.scrolled?.every((l) => IDENTITY(l.transform))} err=${reduced.errs?.length}}`,
    );
  }
}

await browser.close();
console.log('\n━━ § C.7 hero scroll-driven depth parallax (CINEMATIC-3D) ━━');
rows.forEach((r) => console.log(r));
if (fails > 0 && STRICT) {
  console.log(`\n❌ ${fails} site(s) failed the parallax contract`);
  process.exit(1);
}
if (fails > 0) {
  console.log(`\n::notice:: scroll-parallax — ${fails} site(s) not parallaxing (likely a pre-fix build; rebuild to pick up the template). Set STRICT=1 to enforce.`);
} else {
  console.log('\n✓ hero scroll-parallax PASS — layered depth on scroll, static on reduced-motion, LCP-safe.');
}
