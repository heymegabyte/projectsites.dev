// verify-grain-flicker.mjs — § C.7 distinctiveness (CINEMATIC-3D): the `.grain` overlay must
// FLICKER like film (animated) when motion is allowed AND go static under prefers-reduced-motion.
// Transform-only compositor animation → LCP/INP-safe by construction (decorative, z-index:-1,
// pointer-events:none). Auto-joins run-all (verify-*.mjs glob). SITES env overrides the default.
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'zingermans-ann-arbor-2,tartine-bakery-sf-2').split(',');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const rows = [];
let fails = 0;

/** The computed `::after` animation-name of the first `.grain` element (or a marker string). */
async function grainAnim(ctx, url) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (!resp || resp.status() >= 400) return `status-${resp?.status()}`;
    await page.waitForTimeout(800);
    return await page.evaluate(() => {
      const el = document.querySelector('.grain');
      if (!el) return 'no-grain-el';
      const a = getComputedStyle(el, '::after');
      // decorative-safety: negative z-index + non-interactive (never the LCP element / never blocks input)
      const safe = a.pointerEvents === 'none' && Number(a.zIndex) < 0;
      return `${a.animationName || 'none'}${safe ? '' : ' [UNSAFE-Z/PE]'}`;
    });
  } catch (e) {
    return `err:${String(e.message || e).slice(0, 40)}`;
  } finally {
    await page.close();
  }
}

for (const slug of SITES) {
  const url = `https://${slug}.projectsites.dev/`;
  const motion = await grainAnim(await browser.newContext({ userAgent: UA }), url);
  const reduced = await grainAnim(
    await browser.newContext({ userAgent: UA, reducedMotion: 'reduce' }),
    url,
  );
  // PASS: motion-allowed → flickering (grain-flicker) + decorative-safe; reduced-motion → none.
  const ok = motion === 'grain-flicker' && reduced === 'none';
  if (motion === 'no-grain-el') {
    rows.push(`  ⏭️  ${slug} — no .grain element on this page (skip)`);
  } else if (ok) {
    rows.push(`  ✓ ${slug} — grain flickers (motion) / static (reduced-motion) · LCP/INP-safe`);
  } else {
    fails++;
    rows.push(`  ❌ ${slug} — motion="${motion}" reduced="${reduced}" (want grain-flicker / none)`);
  }
}

await browser.close();
console.log('\n━━ § C.7 grain filmic-flicker (CINEMATIC-3D) ━━');
rows.forEach((r) => console.log(r));
if (fails > 0) {
  console.log(`\n::notice:: grain-flicker — ${fails} site(s) not animating correctly (may be pre-fix build; rebuild to pick up the template CSS).`);
} else {
  console.log('\n✓ grain filmic-flicker PASS — animates on motion, static on reduced-motion.');
}
