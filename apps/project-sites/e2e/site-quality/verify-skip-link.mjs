// verify-skip-link.mjs — GENERATED-SITE QUALITY gate (§ C keyboard-bypass, WCAG 2.4.1 Bypass Blocks, Level A):
// a deployed site must ship a WORKING skip-to-content link so a keyboard / screen-reader visitor can
// jump past the whole nav on every page instead of tabbing through it repeatedly.
//
// WHY axe doesn't fully cover this: axe's `bypass`/`skip-link` rules are best-practice (not in the AA
// violation set verify-a11y hard-fails on) and famously flaky on client-rendered SPAs — a site could
// ship with the SkipLink removed from Layout, or the `#main` target renamed, and no existing probe
// (verify-a11y included) would catch the regression. This closes that gap with an explicit contract.
//
// The contract (all must hold, post-hydration — the link + <main> are client-rendered, absent from the
// prerender shell, so a REAL browser + hydration wait is required):
//   1. a skip link exists and targets the main landmark (`href="#main"`),
//   2. exactly ONE <main> landmark (duplicate/absent landmarks break screen-reader navigation),
//   3. the <main> target is programmatically focusable (`tabindex="-1"`) so the skip actually moves focus,
//   4. the link is sr-only UNTIL focused, then REVEALS a real, visible box (a permanently-clipped link is
//      a dead control — a keyboard user can focus it but never sees where they are).
// Reported (soft): the skip link is the FIRST focusable element in tab order (so it's reachable on the
// very first Tab). Root home is the TEMPLATE `SkipLink.tsx` + `Layout.tsx` — fleet-wide, never a one-off.
//
// The skip link is CORE SHELL (in Layout on every build), so this should be ✅ on prod today, independent
// of build freshness. Report-mode by default; `--strict` hard-fails (post-rebuild / regression gating).
//
// Usage:
//   node e2e/site-quality/verify-skip-link.mjs
//   SITES=harborline-coffee-roasters-boston node e2e/site-quality/verify-skip-link.mjs --strict

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
  'harborline-coffee-roasters-boston,vanta-strength-austin,franklin-barbecue,pizzeria-bianco-phoenix'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** In-page: measure the skip-link → main-landmark bypass contract. */
function readSkipLink() {
  const anchors = [...document.querySelectorAll('a[href]')];
  const skip =
    anchors.find((a) => /#main$/.test(a.getAttribute('href') || '')) ||
    anchors.find((a) => /skip to (the )?(main )?content/i.test((a.textContent || '').trim()));
  const mains = [...document.querySelectorAll('main')];
  const main = document.getElementById('main') || mains[0] || null;

  // Every genuinely tab-focusable element in DOM order (sr-only links ARE focusable; keep them).
  const focusables = [
    ...document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ];

  let revealedOnFocus = false;
  let hiddenClipped = false;
  if (skip) {
    const before = skip.getBoundingClientRect();
    // sr-only pattern clips to ~1px; treat <=4px in either axis (unfocused) as properly hidden.
    hiddenClipped = before.width <= 4 || before.height <= 4;
    skip.focus();
    const after = skip.getBoundingClientRect();
    // focus:not-sr-only must paint a real, on-screen box.
    revealedOnFocus =
      after.width > 20 && after.height > 12 && after.top >= 0 && after.left >= 0 && after.top < window.innerHeight;
    skip.blur();
  }

  return {
    hasSkip: !!skip,
    skipHref: skip ? skip.getAttribute('href') : null,
    skipText: skip ? (skip.textContent || '').trim().slice(0, 40) : null,
    skipIsFirstFocusable: !!skip && focusables[0] === skip,
    mainCount: mains.length,
    hasMainTarget: !!main,
    mainId: main ? main.id || null : null,
    mainFocusable: !!main && main.getAttribute('tabindex') === '-1',
    hiddenClipped,
    revealedOnFocus,
  };
}

async function auditSite(browser, slug) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
    const title = await page.title().catch(() => '');
    if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
      return { slug, auditable: false, status: resp ? resp.status() : 0 };
    }
    await page.waitForTimeout(3000); // Layout + SkipLink + <main> hydrate client-side.
    const r = await page.evaluate(readSkipLink);
    return { slug, auditable: true, ...r };
  } catch (e) {
    return { slug, auditable: false, status: 0, gotoError: String(e).slice(0, 60) };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const slug of SITES) rows.push(await auditSite(browser, slug));
await browser.close();

/** The hard contract (§1-4 above). skipIsFirstFocusable is reported, not hard-failed. */
function defectsOf(r) {
  const d = [];
  if (!r.hasSkip) d.push('no skip link');
  else {
    if (r.skipHref !== '#main') d.push(`skip href="${r.skipHref}" (want #main)`);
    if (!r.revealedOnFocus) d.push('link never reveals on focus (dead sr-only)');
    if (!r.hiddenClipped) d.push('link visible when NOT focused (not sr-only)');
  }
  if (r.mainCount !== 1) d.push(`main landmarks=${r.mainCount} (want 1)`);
  if (!r.mainFocusable) d.push('<main> not tabindex=-1 (skip cannot move focus)');
  return d;
}

let defects = 0;
console.log('\n━━ GENERATED-SITE skip-to-content gate (WCAG 2.4.1 · keyboard bypass) ━━');
for (const r of rows) {
  if (!r.auditable) {
    console.log(`  ⚠️  ${r.slug.padEnd(34)} NOT AUDITABLE (status=${r.status}${r.gotoError ? ' ' + r.gotoError : ''}) — skip`);
    continue;
  }
  const d = defectsOf(r);
  if (d.length) {
    defects++;
    console.log(`  ${STRICT ? '❌' : '⚠️ '} ${r.slug.padEnd(34)} ${d.join(' · ')}`);
  } else {
    console.log(
      `  ✅ ${r.slug.padEnd(34)} skip→${r.skipHref} · 1 <main> focusable · reveals on focus${r.skipIsFirstFocusable ? ' · first-focusable' : ' (not first-focusable)'}`,
    );
  }
  console.log(`::json:: ${JSON.stringify({ probe: 'skip-link', ...r })}`);
}

const fail = STRICT ? defects : 0;
console.log(
  `\nVERDICT: ${fail ? '🔴 FAIL' : defects ? '⚠️ REPORT' : '✅ PASS'} — skip-link-defects=${defects} of ${rows.length} sites (${STRICT ? 'strict/hard' : 'report'})`,
);
if (defects && !STRICT)
  console.log('   ↳ root home is the TEMPLATE (SkipLink.tsx + Layout.tsx <main id="main" tabindex="-1">); a defect = the shell regressed, fix there.');
process.exit(fail ? 1 : 0);
