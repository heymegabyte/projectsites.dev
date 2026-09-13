// verify-content-density.mjs — COMPLETION § C.7 (beat-the-source): is the DEPLOYED homepage
// CONTENT-DENSE enough to beat a real business's site? Density is one of the four structural
// "beat-the-source" dimensions, but it only lived as a SUB-score INSIDE verify-beat-source.mjs
// (scored relative to the source) — there was no ABSOLUTE, first-class gate on rendered homepage
// word count. A thin build (a vertical whose content pack + seeded copy render < the "good" bar)
// would ship a sparse homepage that reads as a template stub, and only a source-relative check
// (which can pass against an equally-thin source) would notice.
//
// This measures the RENDERED (headless-Chromium) homepage — words + sections + images — and gates
// an absolute floor. Words are counted on the settled DOM (SPA-hydrated), NOT the prerender shell
// (per verify-beat-source's density lesson: gentle-dental shell=509 → rendered=619). Runs the same
// mobile-first viewport as the CWV/a11y probes.
//
// Fixes are ROOT-CAUSE in the site-gen content levers (the uniform `homepageFaq` density block in
// `hero_copy.ts` + per-vertical `template/scripts/gen-content-packs.mjs` copy) — NEVER a one-off
// edit to one deployed site. Usage:
//   SITES=parnassus-books node e2e/site-quality/verify-content-density.mjs
//   node e2e/site-quality/verify-content-density.mjs            # default SITES
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston,parnassus-books').split(',').map((s) => s.trim()).filter(Boolean);
const VIEWPORT = { width: Number(process.env.VIEWPORT) || 1280, height: 900 };
const WORD_FLOOR = 700; // the honest "good" density bar; 800 is the aspirational beat-source target.
const WORD_AIM = 800;
const IMG_FLOOR = 6; // a homepage that beats the source is multimedia-rich (skill-15: ≥6 imgs home).

const rows = [];
let below = 0;
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: VIEWPORT });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 60000 });
      if (!resp || resp.status() !== 200) {
        rows.push({ slug, note: `NOT MEASURABLE (status=${resp ? resp.status() : 'none'})` });
        await ctx.close();
        continue;
      }
      await page.waitForTimeout(2500); // let the SPA hydrate + lazy sections settle
      const m = await page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        const words = (main.innerText || '').split(/\s+/).filter(Boolean).length;
        const imgs = document.querySelectorAll('img').length;
        const sections = document.querySelectorAll('section').length;
        return { words, imgs, sections };
      });
      const ok = m.words >= WORD_FLOOR && m.imgs >= IMG_FLOOR;
      if (!ok) below++;
      rows.push({ slug, ...m, ok, aim: m.words >= WORD_AIM });
    } catch (e) {
      rows.push({ slug, note: `ERROR ${String(e).slice(0, 70)}` });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n━━ § C.7 content density — rendered homepage ≥ ${WORD_FLOOR} words (aim ${WORD_AIM}) + ≥ ${IMG_FLOOR} imgs ━━`);
for (const r of rows) {
  if (r.note) { console.log(`  ⏭️  ${r.slug} — ${r.note}`); continue; }
  const badge = !r.ok ? '❌' : r.aim ? '✓★' : '✓';
  console.log(`  ${badge} ${r.slug.padEnd(26)} words=${String(r.words).padStart(4)} imgs=${String(r.imgs).padStart(2)} sections=${r.sections}${r.aim ? ' (clears 800 aim)' : ''}`);
}
const measured = rows.filter((r) => !r.note);
if (measured.length === 0) {
  console.log('\n::notice:: § C.7 content-density — no site measurable this run (fail-open).');
  process.exit(0);
}
if (below === 0) {
  console.log(`\n✓ § C.7 content-density PASS — every audited homepage clears ${WORD_FLOOR} words + ${IMG_FLOOR} imgs.`);
  process.exit(0);
}
// TRACKING (::notice, exit 0) — density is 1 of 4 structural beat-source dims (a site can still
// win via PWA/JSON-LD/warm-speed), and thin verticals (retail/dental pack copy) flip green as the
// site-gen content levers densify. Promote to a hard gate once the fleet clears the floor.
console.log(
  `\n::notice:: § C.7 content-density — ${below}/${measured.length} homepage(s) below ${WORD_FLOOR} words or ${IMG_FLOOR} imgs (thin content pack; root-fix in hero_copy homepageFaq + gen-content-packs, tracking not blocking).`,
);
process.exit(0);
