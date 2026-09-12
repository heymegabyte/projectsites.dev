// verify-reveal-safety.mjs — COMPLETION § C.3 (a11y, motion): do a DEPLOYED generated site's
// scroll-driven reveals STRAND content invisible for reduced-motion / no-`animation-timeline`
// users? The template's sections lift in via CSS scroll-driven animations (`animation-timeline:
// view()` — bento-tile-rise / reveal-on-view / process-step / kinetic-headline) whose `from`
// keyframe is `opacity: 0`. Those animations are (correctly) gated behind
// `@supports (animation-timeline: view()) and @media (prefers-reduced-motion: no-preference)`,
// with a visible base state — so reduced-motion users, Firefox (no view()-timeline), and no-JS
// loads see the content immediately.
//
// THE BLIND SPOT this closes: axe + verify-a11y run at DEFAULT motion, so a regression that ships
// an UNGATED `opacity: 0` base on a reveal (or a new reveal not covered by the reduced-motion
// reset) would strand that content INVISIBLE for reduced-motion + Firefox users — a real WCAG
// 2.3.3 / perceivability failure — and NO existing gate would catch it (the content is "there",
// just at opacity 0; render/console/axe-default-motion all stay green). This probe loads each site
// under `prefers-reduced-motion: reduce` and asserts EVERY on-screen text block has an EFFECTIVE
// opacity (self × ancestors) ≥ 0.5 — i.e. no reveal left content invisible when motion is off.
//
// Root-cause fixes (never a per-site patch): in the TEMPLATE, keep every reveal's opacity:0 INSIDE
// `@supports (animation-timeline) + @media (prefers-reduced-motion: no-preference)` (base visible),
// and/or add the selector to the `@media (prefers-reduced-motion: reduce)` reset in `index.css`.
//
// Usage: SITES=russian-river-brewing-santa-rosa node e2e/site-quality/verify-reveal-safety.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston')
  .split(',').map((s) => s.trim()).filter(Boolean);
const VIEWPORT = { width: Number(process.env.VIEWPORT) || 390, height: 844 };
const MIN_EFFECTIVE_OPACITY = 0.5; // below this a text block is effectively invisible

let fails = 0;
const rows = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    // reducedMotion:'reduce' → the `@media (prefers-reduced-motion: no-preference)` reveal blocks
    // do NOT apply, so a SAFE reveal falls back to its visible base; an UNSAFE one stays opacity:0.
    const ctx = await browser.newContext({ userAgent: UA, viewport: VIEWPORT, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
      const title = await page.title().catch(() => '');
      if (!resp || resp.status() !== 200 || /just a moment|checking your browser|attention required/i.test(title)) {
        rows.push({ slug, note: `NOT MEASURABLE (status=${resp ? resp.status() : 'none'} / challenge shell)` });
        await ctx.close();
        continue;
      }
      await page.waitForTimeout(1200);
      // Scroll the whole page — a properly-gated reveal is already visible under reduced-motion;
      // this only matters for JS/IO reveals that add a class on intersection (they must self-reset
      // to visible under reduced-motion too). Scrolling gives any such observer its chance to fire.
      await page.evaluate(async () => {
        const step = Math.floor(window.innerHeight * 0.85);
        for (let y = 0; y <= document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 300));
      });
      const stranded = await page.evaluate((MIN) => {
        const effOpacity = (el) => {
          let o = 1, cur = el;
          while (cur && cur.nodeType === 1) {
            o *= parseFloat(getComputedStyle(cur).opacity);
            if (o < 0.001) break;
            cur = cur.parentElement;
          }
          return o;
        };
        // EXCLUDE interactive collapsibles (accordion / <details> / [hidden] / aria-hidden). Their
        // content is legitimately hidden-until-opened by the USER (a click, not motion) — NOT a
        // reduced-motion reveal strand. A grid-rows accordion clips its answer to ~0 height via an
        // `overflow:hidden`/`clip` ancestor while the answer's OWN box keeps its natural height, so
        // detect the clip by the ancestor's collapsed clientHeight (the precise false-positive we hit).
        const inCollapsedDisclosure = (el) => {
          if (el.closest('details:not([open])')) return true;
          let cur = el, hops = 0;
          while (cur && cur.nodeType === 1 && hops < 8) {
            if (cur.getAttribute && (cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('hidden'))) return true;
            const s = getComputedStyle(cur);
            if ((s.overflow === 'hidden' || s.overflow === 'clip' || s.overflowY === 'hidden' || s.overflowY === 'clip') && cur.clientHeight <= 4) return true;
            cur = cur.parentElement;
            hops++;
          }
          return false;
        };
        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll('h1,h2,h3,h4,p,li,figcaption,blockquote')) {
          const txt = (el.innerText || '').trim();
          if (txt.length < 25) continue;
          if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue; // display:none / content-visibility
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue; // display:none / collapsed — not a reveal-strand
          const eo = effOpacity(el);
          if (eo < MIN && !inCollapsedDisclosure(el)) {
            const key = txt.slice(0, 30);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ eo: +eo.toFixed(3), cls: (el.className || '').toString().slice(0, 44), txt: txt.slice(0, 44) });
          }
        }
        return out;
      }, MIN_EFFECTIVE_OPACITY);
      if (stranded.length > 0) fails++;
      rows.push({ slug, stranded });
    } catch (e) {
      fails++;
      rows.push({ slug, note: `measure error: ${String(e).slice(0, 80)}` });
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`\n━━ § C.3 reveal-safety under prefers-reduced-motion @ ${VIEWPORT.width}px ━━`);
for (const r of rows) {
  if (r.note) { console.log(`  ⚠️  ${r.slug} — ${r.note}`); continue; }
  if (r.stranded.length === 0) { console.log(`  ✅ ${r.slug} — every text block visible (no reveal strands content when motion is off)`); continue; }
  console.log(`  ❌ ${r.slug} — ${r.stranded.length} text block(s) STRANDED invisible under reduced-motion:`);
  for (const s of r.stranded.slice(0, 6)) console.log(`       opacity=${s.eo} "${s.txt}" [${s.cls}]`);
}

const measurable = rows.filter((r) => !r.note);
if (measurable.length === 0) {
  console.log('\n::notice:: skipped — no site was measurable (all non-200 / challenge shells).');
  process.exit(0);
}
if (fails > 0) {
  console.error(`\n✗ § C.3 reveal-safety FAIL — ${fails} site(s) strand content invisible when motion is off (root-fix the reveal's base state / reduced-motion reset in the TEMPLATE index.css).`);
  process.exit(1);
}
console.log(`\nVERDICT: ✅ § C.3 reveal-safety PASS — ${measurable.length} deployed site(s) keep ALL content visible under prefers-reduced-motion (no scroll-reveal strands content).`);
