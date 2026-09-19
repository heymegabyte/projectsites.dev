// verify-hero-tilt.mjs — § C.7 distinctiveness (CINEMATIC-3D): the hero photo card carries a
// pointer-driven 3D TILT (Awwwards/Framer/motion.so-signature depth) that is IDENTITY at rest
// (so the eager hero <img> stays the LCP), tilts toward the pointer with a light-catching glare on
// a fine-pointer + motion-allowed device, and stays STATIC under prefers-reduced-motion. Real
// Chromium (generated-site subdomains are CF-clean for headless). Auto-joins run-all.
//
// A site with no hero photo (HeroCenter / centered HeroSplit) or a pre-fix build has no [data-tilt]
// → SKIP (not a fail). Tracking-mode by default (::notice, suite-safe); STRICT=1 → exit 1.
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'wally-workman-gallery-austin,zingermans-ann-arbor-2').split(',').map((s) => s.trim()).filter(Boolean);
const STRICT = process.env.STRICT === '1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IDENTITY = (t) => t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)/.test(t);

const browser = await chromium.launch();
const rows = [];
let fails = 0;

/** Load a site under the given motion pref, hover the hero card, read the transform. */
async function inspect(slug, reduced) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, ...(reduced ? { reducedMotion: 'reduce' } : {}) });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const t = m.type(), x = m.text();
    if (/Failed to load resource|net::ERR_ABORTED|favicon/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 90));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 90)));
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 45000 });
    if (!resp || resp.status() >= 400) return { status: resp?.status(), errs };
    await page.waitForTimeout(1200);
    const card = page.locator('[data-tilt]').first();
    if ((await card.count()) === 0) return { none: true, errs };
    const rest = await card.evaluate((el) => getComputedStyle(el).transform);
    const bx = await card.boundingBox();
    if (bx) {
      await page.mouse.move(bx.x + bx.width * 0.8, bx.y + bx.height * 0.28);
      await page.waitForTimeout(180);
      await page.mouse.move(bx.x + bx.width * 0.82, bx.y + bx.height * 0.3);
      await page.waitForTimeout(200);
    }
    const moved = await card.evaluate((el) => ({
      transform: getComputedStyle(el).transform,
      glare: !!el.querySelector('.tilt-glare'),
      imgLcp: !!el.querySelector('img[loading="eager"]'),
    }));
    return { rest, moved, errs };
  } catch (e) {
    return { err: String(e.message || e).slice(0, 80), errs };
  } finally {
    await ctx.close().catch(() => {});
  }
}

for (const slug of SITES) {
  const motion = await inspect(slug, false);
  if (motion.none) {
    rows.push(`  ⏭️  ${slug} — no [data-tilt] hero card (no hero photo / pre-tilt build) — skip`);
    continue;
  }
  if (motion.err || motion.status) {
    rows.push(`  ⏭️  ${slug} — unreachable (${motion.err || motion.status}) — skip`);
    continue;
  }
  const reduced = await inspect(slug, true);
  // PASS: motion → identity at rest + NON-identity after move + glare + img-LCP + 0 err;
  //       reduced-motion → identity even after move (static) + 0 err.
  const motionOk =
    IDENTITY(motion.rest) && !IDENTITY(motion.moved.transform) && motion.moved.glare && motion.moved.imgLcp && motion.errs.length === 0;
  const reducedOk = reduced.none || (IDENTITY(reduced.rest) && IDENTITY(reduced.moved.transform) && reduced.errs.length === 0);
  if (motionOk && reducedOk) {
    rows.push(`  ✓ ${slug} — tilts on pointer (${motion.moved.transform.slice(0, 24)}…) + glare · static under reduced-motion · img=LCP · 0 err`);
  } else {
    fails++;
    rows.push(`  ❌ ${slug} — motion{rest=${IDENTITY(motion.rest)}=id moved=${motion.moved.transform.slice(0, 18)} glare=${motion.moved.glare} img=${motion.moved.imgLcp} err=${motion.errs.length}} reduced{moved=${reduced.moved?.transform?.slice(0, 18)} err=${reduced.errs?.length}}`);
  }
}

await browser.close();
console.log('\n━━ § C.7 hero pointer 3D-tilt (CINEMATIC-3D) ━━');
rows.forEach((r) => console.log(r));
if (fails > 0 && STRICT) {
  console.log(`\n❌ ${fails} site(s) failed the tilt contract`);
  process.exit(1);
}
if (fails > 0) {
  console.log(`\n::notice:: hero-tilt — ${fails} site(s) not tilting (likely a pre-fix build; rebuild to pick up the template TiltCard). Set STRICT=1 to enforce.`);
} else {
  console.log('\n✓ hero 3D-tilt PASS — depth on pointer, static on reduced-motion, LCP-safe.');
}
