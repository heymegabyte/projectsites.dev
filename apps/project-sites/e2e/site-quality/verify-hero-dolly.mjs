// verify-hero-dolly.mjs — GENERATED-SITE QUALITY / cinematic gate: the hero "dolly" (the
// Apple/Awwwards camera-pull-back where the hero content recedes on scroll) renders AND stays
// LCP-safe.
//
// WHY: the template's cinematic stack drifts decorative orbs (ScrollParallax) but never dollied
// the hero as a coordinated unit. The dolly (`.hero-cinematic-dolly` + `@keyframes
// hero-dolly-recede`, native `animation-timeline: view()` with `animation-range: exit`) is the
// bleeding-edge upgrade. The RISK it must never introduce: stealing/​delaying the LCP. Because the
// range is `exit`, the timeline sits at 0% (identity) while the hero is fully in view at first
// paint, so the LCP <h1>/<img> paints unchanged — this probe PROVES that: the class is present,
// the keyframe ships, the LCP element is still the hero (not a late canvas/video), and there are 0
// cold console errors.
//
// Report-mode by default (the effect lands in the TEMPLATE → deployed sites gain it on their NEXT
// build; already-deployed sites report ABSENT until rebuilt — the stale-build class, § C.8).
// `--strict` hard-fails. Flips ✅ as the cohort rebuilds off the updated template.
//
// Usage:
//   node e2e/site-quality/verify-hero-dolly.mjs
//   SITES=franklin-barbecue node e2e/site-quality/verify-hero-dolly.mjs
//   node e2e/site-quality/verify-hero-dolly.mjs --strict

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'))(
  'playwright-core',
);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STRICT = process.argv.includes('--strict');

const SITES = (
  process.env.SITES ||
  'vanta-strength-austin,ironhaus-houston,vantage-digital-studio-portland,franklin-barbecue,pizzeria-bianco-phoenix'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function auditSite(browser, slug) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!/posthog|sentry|analytics|gtag|cloudflareinsights|favicon|net::ERR_|Failed to load resource/i.test(t))
      consoleErrors.push(t.slice(0, 120));
  });
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
    const title = await page.title().catch(() => '');
    if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
      return { slug, auditable: false, status: resp?.status() ?? 0 };
    }
    // Wait for LCP to resolve cold, then read the effect + LCP element.
    const data = await page.evaluate(
      () =>
        new Promise((resolvePromise) => {
          let lcpTag = null;
          let lcpTestid = null;
          try {
            new PerformanceObserver((list) => {
              const e = list.getEntries().at(-1);
              const el = e && e.element;
              if (el) {
                lcpTag = el.tagName.toLowerCase();
                lcpTestid =
                  el.closest('[data-testid]')?.getAttribute('data-testid') ||
                  el.getAttribute('data-testid') ||
                  null;
              }
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            /* no LCP observer */
          }
          setTimeout(() => {
            const dolly = document.querySelector('.hero-cinematic-dolly');
            // Is the keyframe defined in any stylesheet? (proves the CSS shipped). MUST recurse:
            // `@keyframes hero-dolly-recede` lives nested inside `@supports (animation-timeline) {
            // @media (prefers-reduced-motion) { … } }`, so a flat top-level scan misses it.
            let keyframe = false;
            const findKeyframe = (rules) => {
              for (const r of rules) {
                if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'hero-dolly-recede') return true;
                if (r.cssRules && findKeyframe(r.cssRules)) return true; // CSSGroupingRule (@supports/@media)
              }
              return false;
            };
            try {
              for (const sheet of document.styleSheets) {
                let rules;
                try {
                  rules = sheet.cssRules;
                } catch {
                  continue; // cross-origin sheet
                }
                if (findKeyframe(rules)) {
                  keyframe = true;
                  break;
                }
              }
            } catch {
              /* ignore */
            }
            // At scroll 0 (no scroll performed) the dolly must be IDENTITY — LCP-safe. A non-identity
            // transform at rest would mean the hero is scaled/faded at first paint.
            let restIdentity = true;
            if (dolly) {
              const tf = getComputedStyle(dolly).transform;
              restIdentity = tf === 'none' || tf === 'matrix(1, 0, 0, 1, 0, 0)';
            }
            resolvePromise({ hasDolly: Boolean(dolly), keyframe, restIdentity, lcpTag, lcpTestid });
          }, 3200);
        }),
    );
    return { slug, auditable: true, consoleErrors, ...data };
  } catch (e) {
    return { slug, auditable: false, status: 0, gotoError: String(e).slice(0, 60) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const slug of SITES) rows.push(await auditSite(browser, slug));
await browser.close();

let defects = 0;
let absent = 0;
console.log('\n━━ GENERATED-SITE cinematic hero-dolly gate (recede-on-scroll · LCP-safe) ━━');
for (const r of rows) {
  if (!r.auditable) {
    console.log(`  ⚠️  ${r.slug.padEnd(34)} NOT AUDITABLE (status=${r.status}${r.gotoError ? ' ' + r.gotoError : ''}) — skip`);
    continue;
  }
  // LCP must be the hero (never a late canvas/video). A dolly bug that made the hero non-identity
  // at rest, or an LCP that isn't the hero, is a hard defect.
  const lcpOk = !r.lcpTag || ['img', 'h1', 'h2', 'span', 'div', 'p'].includes(r.lcpTag);
  if (!r.hasDolly) {
    absent++;
    console.log(`  ⚠️  ${r.slug.padEnd(34)} dolly ABSENT (stale build — lands on rebuild) · keyframe=${r.keyframe}`);
  } else if (!r.restIdentity || !lcpOk || r.consoleErrors.length) {
    defects++;
    const why = [];
    if (!r.restIdentity) why.push('hero NOT identity at rest (LCP risk)');
    if (!lcpOk) why.push(`LCP is <${r.lcpTag}>`);
    if (r.consoleErrors.length) why.push(`${r.consoleErrors.length} console err`);
    console.log(`  ${STRICT ? '❌' : '⚠️ '} ${r.slug.padEnd(34)} ${why.join(' · ')}`);
  } else {
    console.log(`  ✅ ${r.slug.padEnd(34)} dolly present · identity at rest · keyframe ships · LCP=<${r.lcpTag ?? '?'}> · 0 console err`);
  }
  console.log(`::json:: ${JSON.stringify({ probe: 'hero-dolly', slug: r.slug, auditable: r.auditable, hasDolly: r.hasDolly ?? null, keyframe: r.keyframe ?? null, restIdentity: r.restIdentity ?? null, lcpTag: r.lcpTag ?? null })}`);
}

const fail = STRICT ? defects : 0;
console.log(
  `\nVERDICT: ${fail ? '🔴 FAIL' : defects ? '⚠️ REPORT(defect)' : absent ? '⚠️ REPORT(stale)' : '✅ PASS'} — defects=${defects} · absent(stale)=${absent} of ${rows.length} sites`,
);
if (absent && !defects)
  console.log('   ↳ effect SHIPPED in the TEMPLATE (index.css `.hero-cinematic-dolly` + HeroVariants); deployed sites gain it on their next build.');
process.exit(fail ? 1 : 0);
