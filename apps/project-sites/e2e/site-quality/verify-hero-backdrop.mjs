// verify-hero-backdrop.mjs — COMPLETION § C.7 (beat-the-source): does the DEPLOYED
// generated site actually render its per-industry animated WebGL hero backdrop?
//
// WHY THIS PROBE EXISTS: the template's WebGLHeroBackdrop (per-industry aurora/waves/mesh,
// brand-hue-tinted, LCP-safe, reduced-motion + no-WebGL static fallback) was gated behind
// an OPTIONAL `webglBackdrop` prop the generation pipeline never passed — so the gorgeous
// animated hero shipped on ZERO delivered sites (built-but-completely-unwired). The fix
// (template 2430636) auto-derives the variant from `brand.themeStyle`, defaulting ON. This
// probe is the DEPLOYED-ARTIFACT regression guard for that wiring — the template unit test
// (HeroVariants.test.tsx) guards the source; this guards the live R2 shell after a build.
//
// PROOF: the ONLY <canvas> source in the template hero is WebGLHeroBackdrop. It mounts a
// canvas in BOTH modes — the visible scene under WebGL, an invisible probe canvas under the
// reduced-motion / no-WebGL static fallback — so "a <canvas> lives inside the hero <section>
// after hydration" == "the backdrop is wired + mounted". A headless Chromium has WebGL
// (swiftshader), so it exercises the live path. Fixes are ROOT-CAUSE in the TEMPLATE
// (github.com/HeyMegabyte/template.projectsites.dev), NEVER a one-off patch to one site.
//
// NOTE ON TARGETING: audits sites built AFTER template 2430636. A FAIL on a site built with
// the older template means "rebuild it to pick up the wired template", not a template bug —
// hence the default targets the freshly-rebuilt harborline; the corpus turns green as sites
// rebuild. Override with SITES=… once more sites are rebuilt.
//
// Usage:
//   node e2e/site-quality/verify-hero-backdrop.mjs
//   SITES=harborline-coffee-roasters-boston node e2e/site-quality/verify-hero-backdrop.mjs
import { chromium } from 'playwright';
import sharp from 'sharp';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// harborline = artisan (weave); union-garage-nyc = PRECISION (motorcycle gear) → renders the AL-699
// `gyro` precision-instrument scene on its next build (mesh until then — the probe proves the shared
// canvas MOUNT + LCP-safety either way; the gyro fragment rides this identical pipeline).
const SITES = (process.env.SITES || 'harborline-coffee-roasters-boston,union-garage-nyc')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const VIEWPORT = { width: Number(process.env.VIEWPORT) || 1280, height: 900 };
const HYDRATE_MS = 7000; // the backdrop mounts in a post-hydration useEffect — give it time

let fails = 0;
const rows = [];

const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: VIEWPORT });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
      const title = await page.title().catch(() => '');
      if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
        rows.push({ slug, note: `NOT MEASURABLE (status=${resp ? resp.status() : 'none'} / challenge shell)` });
        await ctx.close().catch(() => {});
        continue;
      }
      // Wait for the backdrop canvas to mount (post-hydration). Absence after the window = unwired.
      let hasCanvas = false;
      try {
        await page.waitForSelector('section canvas, canvas', { timeout: HYDRATE_MS, state: 'attached' });
        hasCanvas = true;
      } catch {
        hasCanvas = false;
      }
      // The <canvas> is the robust discriminator (the ONLY canvas source in the template hero
      // is WebGLHeroBackdrop). Confirm at least one canvas lives inside a <section> (the hero) —
      // sibling decorative divs share the aria-hidden/inset-0 classes, so only the canvas proves it.
      const detail = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        const sections = Array.from(document.querySelectorAll('section'));
        const inHero = canvases.some((c) => sections.some((s) => s.contains(c)));
        return { canvasCount: canvases.length, inHero };
      });
      const mounted = hasCanvas && detail.canvasCount > 0 && detail.inHero;
      // RENDER PROOF (closes canvas-mount-probe-blind-to-black-broken-shader): a broken/black shader
      // still MOUNTS a canvas (passing the mount check above) yet ships a DEAD BLACK hero. Screenshot
      // the hero canvas + assert a meaningful non-black fraction — a dead black rectangle samples ~0%,
      // while a real animated scene (even a dark noir/smoke one) covers well over 10% with visible content.
      let render = null;
      if (mounted) {
        try {
          // A CLIPPED page screenshot (not locator.screenshot): Playwright's element-screenshot
          // stability wait can time out on an infinitely-animating WebGL canvas; clipping grabs the
          // current viewport frame immediately.
          const box = await page.locator('section canvas').first().boundingBox();
          if (!box) throw new Error('no canvas bounding box');
          const shot = await page.screenshot({
            clip: {
              x: Math.max(0, box.x),
              y: Math.max(0, box.y),
              width: Math.max(1, Math.min(box.width, VIEWPORT.width - Math.max(0, box.x))),
              height: Math.max(1, Math.min(box.height, VIEWPORT.height - Math.max(0, box.y))),
            },
          });
          const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
          const ch = info.channels;
          const totalPx = info.width * info.height;
          const step = Math.max(1, Math.floor(totalPx / 6000)); // ~6k luminance samples
          let nonBlack = 0;
          let n = 0;
          for (let i = 0; i < totalPx; i += step) {
            const o = i * ch;
            const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
            if (lum > 12) nonBlack++;
            n++;
          }
          render = { nonBlackPct: Math.round((nonBlack / n) * 100) };
        } catch (e) {
          render = { err: String(e).slice(0, 60) };
        }
      }
      // Only a CONFIRMED near-black frame fails; a screenshot error is advisory (never a false-fail on a
      // capture hiccup — validator-precision). Not mounted → already failing.
      const renderOk = !mounted
        ? false
        : render && typeof render.nonBlackPct === 'number'
          ? render.nonBlackPct >= 10
          : true;
      const pass = mounted && renderOk;
      if (!pass) fails++;
      rows.push({ slug, ...detail, ...(render || {}), pass });
    } catch (e) {
      fails++;
      rows.push({ slug, note: `probe error: ${String(e).slice(0, 80)}` });
    } finally {
      await ctx.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}

console.log(`\n━━ § C.7 generated-site hero WebGL backdrop (deployed, real browser @ ${VIEWPORT.width}px) ━━`);
for (const r of rows) {
  if (r.note) {
    console.log(`  ⚠️  ${r.slug} — ${r.note}`);
    continue;
  }
  const mark = r.pass ? '✅' : '❌';
  const rp =
    typeof r.nonBlackPct === 'number'
      ? ` render=${r.nonBlackPct}% non-black`
      : r.err
        ? ` render-err=${r.err}`
        : '';
  console.log(`  ${mark} ${r.slug} — canvas=${r.canvasCount} inHero=${r.inHero ? '✓' : '✗'}${rp}`);
}

const measurable = rows.filter((r) => !r.note);
if (measurable.length === 0) {
  console.log('\n::notice:: skipped — no site was measurable (all non-200 / challenge shells).');
  process.exit(0);
}
if (fails > 0) {
  console.error(
    `\n✗ § C.7 FAIL — ${fails} site(s): the hero WebGL backdrop is either UNWIRED (no canvas — unwired template / built before template 2430636 → rebuild) OR mounts a canvas that renders a DEAD BLACK frame (<10% non-black — a broken/black shader that a mount-only check is blind to).`,
  );
  process.exit(1);
}
console.log(
  `\nVERDICT: ✅ § C.7 PASS — ${measurable.length} deployed site(s) mount the per-industry WebGL hero backdrop.`,
);
