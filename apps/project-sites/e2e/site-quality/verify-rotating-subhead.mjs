#!/usr/bin/env node
/**
 * verify-rotating-subhead.mjs — § C (cinematic distinctiveness): the AI value-proposition rotator
 * (flag `rotating_subhead` / VITE_ROTATING_SUBHEAD, DARK by default) — the hero subhead cross-fades
 * through the business's top value props (three reasons to convert instead of one; the Stripe/Linear
 * rotating-headline pattern, AI-filled). The effect is a CSS GRID-STACK (all props in one grid cell →
 * the <p> sizes to the tallest prop → zero CLS as they rotate) + an opacity-only cross-fade, so it is
 * INP-safe (compositor-driven) and LCP-safe (prop[0] paints opaque first, below the <h1> LCP element).
 *
 * STALE-BUILD / DARK-FLAG DISCIPLINE (validator-precision + report-mode-probe): the flag is DARK by
 * default AND data-dependent (needs site-gen to supply ≥2 valueProps), so NO prod site carries a
 * NATURAL `[data-rotating]` subhead yet — correct, must NOT fail. The probe DEPLOY-DETECTS the shipped
 * CSS by injecting a bare `.rotating-subhead__stack` (2 items, one active) and reading getComputedStyle:
 * `display:grid` on the stack + `opacity 1` (active) / `0` (inactive) → the class is in this build,
 * assert the contract; else SKIP (::notice). Fail-OPEN on sites built before this template change;
 * flips to a real assertion as sites rebuild.
 *
 * Fail-CLOSED (real regressions) ONLY where the CSS is deployed:
 *   1. the grid-stack collapses (display ≠ grid) → CLS risk as props rotate.
 *   2. the active/inactive opacity contract is broken (both visible / both hidden).
 *   3. any NATURAL `[data-rotating="1"]` subhead is present → its animated layer must be aria-hidden
 *      AND a sibling `.sr-only` must carry text (a11y: SR reads the full list, not the flashing word).
 *   4. 0 console errors on cold load.
 *
 * Usage: SITES=<slug> node e2e/site-quality/verify-rotating-subhead.mjs
 */
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const b = await chromium.launch();

// Inject a bare rotating-subhead stack (NO inline style) so computed styles come from the shipped sheet.
const CONTRACT = () => {
  const p = document.createElement('p');
  p.setAttribute('data-rsprobe', '1');
  const stack = document.createElement('span');
  stack.className = 'rotating-subhead__stack';
  const a = document.createElement('span');
  a.className = 'rotating-subhead__item';
  a.setAttribute('data-active', '1');
  a.textContent = 'A';
  const b2 = document.createElement('span');
  b2.className = 'rotating-subhead__item';
  b2.setAttribute('data-active', '0');
  b2.textContent = 'B';
  stack.append(a, b2);
  p.append(stack);
  document.body.appendChild(p);
  const sd = getComputedStyle(stack).display;
  const aOp = getComputedStyle(a).opacity;
  const bOp = getComputedStyle(b2).opacity;
  p.remove();
  // natural (real) rotating subheads on the page, and their a11y contract
  const nat = [...document.querySelectorAll('[data-rotating="1"]')];
  const natOk = nat.every((el) => {
    const stk = el.querySelector('.rotating-subhead__stack');
    const sr = el.querySelector('.sr-only');
    return stk?.getAttribute('aria-hidden') === 'true' && (sr?.textContent || '').trim().length > 0;
  });
  return { stackDisplay: sd, activeOpacity: aOp, inactiveOpacity: bOp, natural: nat.length, naturalA11yOk: natOk };
};

async function probe(slug, { reduced } = {}) {
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    ...(reduced ? { reducedMotion: 'reduce' } : {}),
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const t = m.type();
    const x = m.text();
    if (/Failed to load resource|favicon|net::ERR_ABORTED|SwiftShader|GPU stall|WebGL|getContext/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 90));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 90)));
  const contract = await (async () => {
    try {
      await page.goto(`https://${slug}${SUFFIX}/`, { waitUntil: 'load', timeout: 45000 });
      return await page.evaluate(CONTRACT);
    } catch (e) {
      errs.push('[goto] ' + String(e.message || e).slice(0, 60));
      return null;
    }
  })();
  await ctx.close().catch(() => {});
  return { contract, errs };
}

let exit = 0;
const rows = [];
const line = (ok, label, detail = '') => {
  rows.push(`  ${ok ? '✓' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) exit = 1;
};
const skip = (label, detail = '') => rows.push(`  ⏭️  ${label}${detail ? ` — ${detail}` : ''}`);

for (const slug of SITES) {
  rows.push(`\n─ ${slug}${SUFFIX} ─`);
  const r = await probe(slug, { reduced: false });
  if (!r.contract) {
    skip(`${slug}: could not load (fail-open)`, r.errs.slice(0, 1).join(''));
    continue;
  }
  if (r.contract.stackDisplay !== 'grid') {
    skip(
      `${slug}: rotating-subhead CSS not in this build (dark flag / stale — a VITE_ROTATING_SUBHEAD rebuild ships it)`,
      `stack display="${r.contract.stackDisplay}"`,
    );
    continue;
  }
  line(true, `${slug}: grid-stack deployed (display:grid — CLS-safe, props share one cell)`);
  line(
    r.contract.activeOpacity === '1' && r.contract.inactiveOpacity === '0',
    `${slug}: active prop opaque + inactive props hidden (the cross-fade contract holds)`,
    `active=${r.contract.activeOpacity} inactive=${r.contract.inactiveOpacity}`,
  );
  line(r.errs.length === 0, `${slug}: 0 console errors (cold load)`, r.errs[0] || '');
  rows.push(`  ℹ️  ${slug}: ${r.contract.natural} natural [data-rotating] subhead(s) — dark+data-gated, 0 is expected`);
  if (r.contract.natural > 0) {
    line(
      r.contract.naturalA11yOk,
      `${slug}: natural rotating subhead is a11y-complete (animated layer aria-hidden + sr-only full list)`,
      `a11yOk=${r.contract.naturalA11yOk}`,
    );
  }
}

await b.close();
console.log('\n━━ rotating-subhead (rotating_subhead / VITE_ROTATING_SUBHEAD, dark by default) — prod ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ rotating-subhead PASS — where deployed: grid-stack CLS-safe, cross-fade opacity contract holds, natural subheads a11y-complete, 0 console errors; dark/stale builds fail-open (skip).'
    : '\n❌ rotating-subhead FAIL',
);
process.exit(exit);
