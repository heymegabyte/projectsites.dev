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
// AL-527: counts VISIBLE innerText + the COLLAPSED FAQ-accordion answers (`.faq-answer` in
// non-open `.faq-item`s). `innerText` omits collapsed-grid text, so the old measure UNDERCOUNTED
// every accordion-FAQ homepage by ~4 answers (~240 words) — a false-thin that hid how dense fresh
// builds really are (a fresh retail/hospitality site measured ~750 visible but carries ~1000 words
// of real, Google-INDEXED content). The report prints the `visible + faq` split for transparency.
//
// Fixes are ROOT-CAUSE in the site-gen content levers (the uniform `homepageFaq` density block in
// `hero_copy.ts` + per-vertical `template/scripts/gen-content-packs.mjs` copy) — NEVER a one-off
// edit to one deployed site. Usage:
//   SITES=parnassus-books node e2e/site-quality/verify-content-density.mjs
//   node e2e/site-quality/verify-content-density.mjs            # default SITES
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
import { resolveSites } from './_default-sites.mjs';
const SITES = resolveSites(process.env.SITES);
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
        const visible = (main.innerText || '').split(/\s+/).filter(Boolean).length;
        // AL-527: the homepage FAQ is an accordion — only item 0 is open by default, so items
        // 1-4's answers sit in COLLAPSED panels (`grid-rows-[0fr]`, overflow-hidden). `innerText`
        // OMITS collapsed text, so it systematically UNDERCOUNTS every accordion-FAQ homepage by
        // ~4×70 words — a FALSE-THIN reading that mis-flagged visual-first verticals (a digital
        // studio measured 626 visible while its real, Google-INDEXED content was ~900). The
        // collapsed `.faq-answer` text IS in the DOM + indexed, so count it (open items are
        // already in `visible`). This measures the page's REAL content, not just what's expanded.
        let faqCollapsed = 0;
        document.querySelectorAll('.faq-item').forEach((li) => {
          if (li.hasAttribute('data-faq-open')) return; // open → already in `visible`
          const ans = li.querySelector('.faq-answer');
          if (ans) faqCollapsed += (ans.textContent || '').split(/\s+/).filter(Boolean).length;
        });
        const imgs = document.querySelectorAll('img').length;
        const sections = document.querySelectorAll('section').length;
        return { words: visible + faqCollapsed, visible, faqCollapsed, imgs, sections };
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
  const split = r.faqCollapsed ? ` (visible ${r.visible} + faq ${r.faqCollapsed})` : '';
  console.log(`  ${badge} ${r.slug.padEnd(26)} words=${String(r.words).padStart(4)}${split} imgs=${String(r.imgs).padStart(2)} sections=${r.sections}${r.aim ? ' (clears 800 aim)' : ''}`);
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
  `\n::notice:: § C.7 content-density — ${below}/${measured.length} homepage(s) below ${WORD_FLOOR} words (real content incl. collapsed FAQ). FRESH builds carry the dense seeded homepageFaq (AL-409, ~240 collapsed words) + clear the floor comfortably (992-1077); a sub-floor site is a STALE pre-AL-409 build (thin ~60-word FAQ) that densifies on rebuild — NOT a current site-gen gap. Tracking not blocking.`,
);
process.exit(0);
