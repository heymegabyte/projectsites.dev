// verify-mobile-overflow.mjs — GENERATED-SITE QUALITY gate: a deployed site must NOT scroll
// horizontally on a phone. The PAGE (documentElement) must never be wider than the viewport at
// mobile/tablet breakpoints.
//
// WHY (the gap this closes): axe (verify-a11y) is BLIND to horizontal overflow — a section that
// runs a few px past the viewport (an un-wrapped wide table, a `w-screen`/`100vw` block that
// ignores the scrollbar, a fixed-px element, an image without `max-width:100%`, a `whitespace-
// nowrap` heading) makes the whole page scroll sideways on a phone. Most traffic is mobile, so a
// sideways-scrolling generated site is embarrassingly broken AND loses to the source it should
// beat — yet every existing probe (cwv/a11y/density/nav/hero) renders at ONE width and never
// measures cross-axis overflow. A page that scrolls horizontally is an unambiguous layout defect.
//
// Signal: `documentElement.scrollWidth > innerWidth + TOL`. This is PAGE-level overflow — an
// internal `overflow-x:auto` carousel/track does NOT trip it (its content is clipped by its own
// scroll container), so we don't false-positive on legitimate horizontal scrollers. When it trips,
// we walk the DOM for the element(s) extending past the right edge (outside any scroll container)
// so the root-fix is targetable. Fixes are ROOT-CAUSE in the TEMPLATE (the offending component's
// CSS — add `max-w-full`/`overflow-x-clip`/wrap) — never a one-off patch to one deployed site.
//
// Usage:
//   node e2e/site-quality/verify-mobile-overflow.mjs
//   SITES=franklin-barbecue node e2e/site-quality/verify-mobile-overflow.mjs
//   node e2e/site-quality/verify-mobile-overflow.mjs --strict   # tablet 768 also hard-fails

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// playwright-core via createRequire from the frontend dir (reliably hoisted after npm ci) — same
// pattern as the sibling probes (verify-no-pageerror etc.).
const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'))(
  'playwright-core',
);

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const STRICT = process.argv.includes('--strict');
const TOL = 2; // sub-pixel rounding tolerance (px)

// Phone-first breakpoints where overflow bites. 375 = iPhone SE (narrowest common), 390 = the
// modern iPhone. 768 = iPad portrait (report-only unless --strict — some intentional full-bleed
// designs are fine at tablet but never at phone).
const BREAKPOINTS = [
  { w: 375, h: 812, hard: true },
  { w: 390, h: 844, hard: true },
  { w: 768, h: 1024, hard: STRICT },
];

// Homepage + the highest-traffic sub-pages a visitor lands on. A sub-page can overflow where the
// homepage doesn't (a long address line, a wide pricing table).
const PATHS = ['/', '/contact', '/about'];

const SITES = (
  process.env.SITES ||
  'vanta-strength-austin,ironhaus-houston,vantage-digital-studio-portland,franklin-barbecue,pizzeria-bianco-phoenix'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** In-page: is the PAGE wider than the viewport, and if so what's the widest offender? */
function measureOverflow(tol) {
  const de = document.documentElement;
  const iw = window.innerWidth;
  const pageOverflow = de.scrollWidth - iw;
  if (pageOverflow <= tol) return { overflow: 0, culprit: null };

  // Find elements whose right edge extends past the viewport AND that are not clipped by an
  // ancestor scroll container (those are legitimate internal horizontal scrollers).
  const inScrollContainer = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      p = p.parentElement;
    }
    return false;
  };
  let worst = null;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const past = r.right - iw;
    if (past <= tol) continue;
    if (inScrollContainer(el)) continue;
    if (!worst || past > worst.past) {
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.');
      worst = {
        past: Math.round(past),
        sel: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : ''),
      };
    }
  }
  return { overflow: Math.round(pageOverflow), culprit: worst };
}

async function auditSite(browser, slug) {
  const findings = []; // { path, w, overflow, culprit }
  let auditable = false;
  let status = 0;
  for (const path of PATHS) {
    for (const bp of BREAKPOINTS) {
      const ctx = await browser.newContext({
        userAgent: UA,
        viewport: { width: bp.w, height: bp.h },
        deviceScaleFactor: 2,
        isMobile: true,
      });
      const page = await ctx.newPage();
      try {
        const resp = await page.goto(`https://${slug}.projectsites.dev${path}`, {
          waitUntil: 'load',
          timeout: 30000,
        });
        status = resp?.status() ?? 0;
        const title = await page.title().catch(() => '');
        // A CF challenge / non-200 shell isn't the real site — skip that (path,bp) combo.
        if (!resp || status !== 200 || /just a moment|checking your browser/i.test(title)) {
          // Skip this (path,bp) — the `finally` below closes ctx exactly once. An early close HERE
          // plus the finally = a DOUBLE-close → "Failed to find context" protocol error that is
          // uncaught → crashes the probe → stalls the whole run-all suite at mobile-overflow.
          continue;
        }
        auditable = true;
        await page.waitForTimeout(2500); // let hydration + reveal transforms settle
        const res = await page.evaluate(measureOverflow, TOL);
        if (res.overflow > TOL) {
          findings.push({ path, w: bp.w, hard: bp.hard, overflow: res.overflow, culprit: res.culprit });
        }
      } catch {
        /* nav error on one (path,bp) — a missing sub-page is nav-integrity's job, not ours */
      } finally {
        // Teardown protocol errors (a context already disposed by a crash/timeout) are benign —
        // swallow them so a flaky close never crashes the probe or stalls run-all.
        await ctx.close().catch(() => {});
      }
    }
  }
  return { slug, auditable, status, findings };
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const slug of SITES) rows.push(await auditSite(browser, slug));
await browser.close();

let hardFail = 0;
let reportOnly = 0;
console.log('\n━━ GENERATED-SITE mobile horizontal-overflow gate (a phone must never scroll sideways) ━━');
for (const r of rows) {
  if (!r.auditable) {
    console.log(`  ⚠️  ${r.slug.padEnd(34)} NOT AUDITABLE (status=${r.status}) — skip`);
    continue;
  }
  const hard = r.findings.filter((f) => f.hard);
  const soft = r.findings.filter((f) => !f.hard);
  if (hard.length) {
    hardFail++;
    const w = hard[0];
    console.log(
      `  ❌ ${r.slug.padEnd(34)} ${hard.length} overflow @phone → ${w.path}@${w.w}px +${w.overflow}px${w.culprit ? ` · culprit ${w.culprit.sel} (+${w.culprit.past}px)` : ''}`,
    );
  } else if (soft.length) {
    reportOnly++;
    const w = soft[0];
    console.log(`  ⚠️  ${r.slug.padEnd(34)} 0 @phone · ${soft.length} @tablet → ${w.path}@${w.w}px +${w.overflow}px (report)`);
  } else {
    console.log(`  ✅ ${r.slug.padEnd(34)} no horizontal overflow @375/390${STRICT ? '/768' : ''}`);
  }
  // ::json:: structured line per site for the loop's trend log.
  console.log(`::json:: ${JSON.stringify({ probe: 'mobile-overflow', slug: r.slug, auditable: r.auditable, findings: r.findings })}`);
}

console.log(
  `\nVERDICT: ${hardFail ? '🔴 FAIL' : reportOnly ? '⚠️ REPORT' : '✅ PASS'} — phone-overflow(hard)=${hardFail} · tablet(${STRICT ? 'hard' : 'report'})=${reportOnly} of ${rows.length} sites`,
);
if (hardFail)
  console.error(
    '   ↳ the page scrolls sideways on a phone — root-fix the culprit component in the TEMPLATE (max-w-full / overflow-x-clip / wrap the offending block); NEVER a one-off patch to one deployed site.',
  );
process.exit(hardFail ? 1 : 0);
