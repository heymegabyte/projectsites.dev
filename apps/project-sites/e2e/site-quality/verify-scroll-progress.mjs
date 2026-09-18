// verify-scroll-progress.mjs — BLEEDING-EDGE / CINEMATIC + CWV gate: the native scroll-driven
// reading-progress bar (template <ScrollProgress>, idea #161) renders on a DEPLOYED generated site,
// is driven by native `animation-timeline: scroll(root)` (ZERO JS → INP-safe), stays LCP-safe
// (invisible scaleX(0) at first paint), and actually FILLS as the visitor scrolls.
//
// WHY (the gap this closes): the scroll-progress bar is a 2026-showcased pattern (Awwwards/Codrops:
// native CSS scroll-timeline progress indicators, zero-JS, INP-safe) and it's SHIPPED in the
// template — but NOTHING guarded it. A refactor that drops `<ScrollProgress/>` from Layout, breaks
// the `animation-timeline: scroll(root)` binding, or regresses it to a JS scroll-listener (the exact
// INP liability the native version replaced) would ship silently — render/console/axe all stay green
// because the bar is decorative + aria-hidden. This probe reconciles the bar against its intended
// behavior: present + fixed + aria-hidden + native-scroll-driven + LCP-safe-at-top + grows-on-scroll.
//
// Root-cause fixes live in the TEMPLATE (src/components/ScrollProgress.tsx + `.scroll-progress` in
// index.css) — never a per-site patch; deployed sites gain/repair it on their next build.
//
// Report-mode by default (a site predating idea #161 has no bar → reported stale, not failed).
// `--strict` hard-fails when a bar that IS present is JS-driven / not LCP-safe / doesn't fill.
// Auto-joins site-quality run-all via the verify-*.mjs glob.
//
// Usage:
//   node e2e/site-quality/verify-scroll-progress.mjs
//   SITES=franklin-barbecue node e2e/site-quality/verify-scroll-progress.mjs --strict
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STRICT = process.argv.includes('--strict');
const SITES = resolveSites(process.env.SITES);

/** scaleX component of a computed transform matrix (matrix(a,b,c,d,e,f) → a). 'none' → 1. */
function scaleXOf(transform) {
  if (!transform || transform === 'none') return 1;
  const m = transform.match(/matrix\(([^)]+)\)/);
  if (!m) return 1;
  return parseFloat(m[1].split(',')[0]);
}

const browser = await chromium.launch({ headless: true });
const rows = [];
let defects = 0;
let stale = 0;
try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
      const title = await page.title().catch(() => '');
      if (!resp || resp.status() !== 200 || /just a moment|checking your browser|attention required/i.test(title)) {
        rows.push({ slug, note: `NOT AUDITABLE (status=${resp?.status() ?? 0})` });
        await ctx.close();
        continue;
      }
      await page.waitForTimeout(1200);
      // At scroll-top: read presence + how the bar is driven + its at-rest fill (LCP-safety).
      const atTop = await page.evaluate(() => {
        const el = document.querySelector('.scroll-progress');
        if (!el) return { present: false };
        const cs = getComputedStyle(el);
        return {
          present: true,
          position: cs.position,
          ariaHidden: el.getAttribute('aria-hidden'),
          top: cs.top,
          animationName: cs.animationName, // 'scroll-progress-grow' when the native anim is wired
          animationTimeline: cs.animationTimeline || cs.getPropertyValue('animation-timeline') || '',
          transform: cs.transform,
        };
      });
      if (!atTop.present) {
        stale++;
        rows.push({ slug, note: 'no .scroll-progress bar (stale build predating idea #161) — rebuild to gain it' });
        await ctx.close();
        continue;
      }

      // Scroll to the bottom and let the scroll-timeline settle, then re-read the fill.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
      const atBottom = await page.evaluate(() => {
        const el = document.querySelector('.scroll-progress');
        return el ? getComputedStyle(el).transform : 'none';
      });

      const sxTop = scaleXOf(atTop.transform);
      const sxBottom = scaleXOf(atBottom);
      // Native + zero-JS: the fill is a CSS animation named scroll-progress-grow (the animation-timeline
      // is what drives it; some Chromium builds report it only on the shorthand, so accept either signal).
      const nativeDriven =
        atTop.animationName?.includes('scroll-progress-grow') || /scroll/i.test(atTop.animationTimeline);
      const fixed = atTop.position === 'fixed';
      const ariaHidden = atTop.ariaHidden === 'true';
      const lcpSafe = sxTop <= 0.05; // invisible at first paint → zero LCP weight
      const fills = sxBottom - sxTop >= 0.3; // the scroll-timeline actually advances the bar

      const bad = [];
      if (!fixed) bad.push(`position=${atTop.position}(≠fixed)`);
      if (!ariaHidden) bad.push('not aria-hidden');
      if (!nativeDriven) bad.push(`not native-scroll-driven (anim=${atTop.animationName} timeline=${atTop.animationTimeline || 'n/a'}) — JS-listener regression?`);
      if (!lcpSafe) bad.push(`scaleX@top=${sxTop.toFixed(3)} (>0.05 — visible at first paint, LCP risk)`);
      if (!fills) bad.push(`scaleX ${sxTop.toFixed(2)}→${sxBottom.toFixed(2)} (bar doesn't fill on scroll)`);

      if (bad.length) defects++;
      rows.push({ slug, ok: bad.length === 0, sxTop, sxBottom, nativeDriven, fixed, ariaHidden, bad });
    } catch (e) {
      rows.push({ slug, note: `measure error: ${String(e).slice(0, 70)}` });
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.log('\n━━ scroll-progress bar — native scroll-timeline, LCP-safe, fills on scroll (idea #161) ━━');
for (const r of rows) {
  if (r.note) { console.log(`  ⚠️  ${r.slug.padEnd(34)} ${r.note}`); continue; }
  console.log(
    `  ${r.ok ? '✅' : STRICT ? '❌' : '⚠️ '} ${r.slug.padEnd(34)} scaleX ${r.sxTop.toFixed(3)}→${r.sxBottom.toFixed(3)} · native=${r.nativeDriven} fixed=${r.fixed} aria-hidden=${r.ariaHidden}${r.bad?.length ? ' · ' + r.bad.join('; ') : ''}`,
  );
  console.log(`::json:: ${JSON.stringify({ probe: 'scroll-progress', slug: r.slug, ok: r.ok, sxTop: r.sxTop, sxBottom: r.sxBottom, nativeDriven: r.nativeDriven })}`);
}

const auditable = rows.filter((r) => !r.note);
if (auditable.length === 0) {
  console.log('\n::notice:: skipped — no site auditable (all non-200 / challenge shells).');
  process.exit(0);
}
const fail = STRICT ? defects : 0;
console.log(
  `\nVERDICT: ${fail ? '🔴 FAIL' : defects ? '⚠️ REPORT' : stale ? '⚠️ REPORT(stale)' : '✅ PASS'} — ${auditable.length - defects - stale}/${auditable.length} bars native+LCP-safe+filling · defects=${defects} · stale=${stale} (${STRICT ? 'strict' : 'report'})`,
);
if (defects && !STRICT)
  console.log('   ↳ fix at ROOT in the TEMPLATE (ScrollProgress.tsx + `.scroll-progress` in index.css); deployed sites repair on next build.');
process.exit(fail ? 1 : 0);
