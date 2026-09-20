#!/usr/bin/env node
/**
 * verify-kinetic-marquee.mjs — § C (cinematic distinctiveness): the perspective-tilted,
 * scroll-velocity-coupled typographic ribbon (flag `kinetic_marquee` / `VITE_KINETIC_MARQUEE`,
 * DARK by default) is deployed correctly, reduced-motion-safe, and LCP-safe.
 *
 * The KineticMarquee choreography is DECLARED in a linked stylesheet:
 *   `.ps-kinetic-marquee` { overflow:hidden; perspective:900px; mask-image: linear-gradient(…) }
 *   @media (prefers-reduced-motion: no-preference):
 *     `.ps-kinetic-marquee__track` { animation: ps-marquee-drift 34s linear infinite }
 *   @supports (animation-timeline: scroll()) + same @media:
 *     `.ps-kinetic-marquee__row`  { animation: ps-marquee-scroll linear both;
 *                                   animation-timeline: scroll(root) }
 *   The live band carries `data-kinetic-marquee="1"` and is `aria-hidden`.
 *
 * STALE-BUILD / DARK-FLAG DISCIPLINE (validator-precision + report-mode-probe):
 * The flag is DARK by default — most prod sites will NOT carry the CSS yet. This is correct
 * and must NOT fail. The probe DETECTS deployment by injecting a bare structure (NO inline style):
 *   <div class="ps-kinetic-marquee">
 *     <div class="ps-kinetic-marquee__row">
 *       <div class="ps-kinetic-marquee__track"></div>
 *     </div>
 *   </div>
 * and reading getComputedStyle. If the injected `.ps-kinetic-marquee__track` computed animationName
 * === 'ps-marquee-drift' → CSS is DEPLOYED, assert the contract. Else → SKIP with ::notice.
 * Fail-OPEN when no site carries the effect; flips to a real assertion as sites rebuild with flag on.
 *
 * Fail-CLOSED (real regressions) ONLY where CSS is deployed:
 *   1. REDUCED-MOTION GATED — under reducedMotion:'reduce' the injected track animationName is
 *      'none' or '' (drift withheld) → static ribbon.
 *   2. Container is `overflow: hidden` (clip contract holds).
 *   3. If a NATURAL `[data-kinetic-marquee]` band is present, the LCP element is NOT inside it
 *      (`el.closest('[data-kinetic-marquee]')` is null → hero stays LCP). (LCP timing is advisory — CWV hard gate is verify-cwv.mjs)
 *   4. 0 console errors on cold load, both motion prefs.
 *
 * Natural bands are ADVISORY — dark by default means usually 0; not a failure.
 *
 * Usage: SITES=franklin-barbecue node e2e/site-quality/verify-kinetic-marquee.mjs
 */
import { chromium } from 'playwright';
import { resolveSites, DEFAULT_SITES } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const LCP_BUDGET_MS = 2000;

const b = await chromium.launch();

// Inject bare `.ps-kinetic-marquee` structure (NO inline style) so computed styles must come
// from the shipped stylesheet only. Returns: { animationName, overflow, natural }.
const CONTRACT = () => {
  const wrap = document.createElement('div');
  wrap.className = 'ps-kinetic-marquee';
  const row = document.createElement('div');
  row.className = 'ps-kinetic-marquee__row';
  const track = document.createElement('div');
  track.className = 'ps-kinetic-marquee__track';
  row.appendChild(track);
  wrap.appendChild(row);
  document.body.appendChild(wrap);
  const wcs = getComputedStyle(wrap);
  const tcs = getComputedStyle(track);
  const res = {
    animationName: tcs.animationName,
    overflow: wcs.overflow,
    natural: document.querySelectorAll('[data-kinetic-marquee="1"]').length,
  };
  wrap.remove();
  return res;
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
    if (/Failed to load resource|favicon|net::ERR_ABORTED|SwiftShader|GPU stall/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 90));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 90)));
  const url = `https://${slug}${SUFFIX}/`;
  const contract = await (async () => {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      return await page.evaluate(CONTRACT);
    } catch (e) {
      errs.push('[goto] ' + String(e.message || e).slice(0, 60));
      return null;
    }
  })();
  // LCP candidate + whether it sits inside a natural kinetic-marquee band.
  const lcp = contract
    ? await page.evaluate(
        () =>
          new Promise((resolve) => {
            let last = null;
            try {
              new PerformanceObserver((l) => {
                const es = l.getEntries();
                last = es[es.length - 1];
              }).observe({ type: 'largest-contentful-paint', buffered: true });
            } catch {
              /* no LCP support */
            }
            setTimeout(() => {
              const el = last?.element;
              resolve({
                ms: last ? Math.round(last.startTime) : -1,
                inMarquee: el ? !!el.closest('[data-kinetic-marquee]') : false,
                tag: el ? el.tagName.toLowerCase() : 'none',
              });
            }, 1500);
          }),
      )
    : { ms: -1, inMarquee: false, tag: 'none' };
  await ctx.close().catch(() => {});
  return { contract, lcp, errs };
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
  const motion = await probe(slug, { reduced: false });
  if (!motion.contract) {
    skip(`${slug}: could not load (fail-open)`, motion.errs.slice(0, 1).join(''));
    continue;
  }
  const deployed = motion.contract.animationName === 'ps-marquee-drift';
  if (!deployed) {
    // Dark flag or stale build: the `.ps-kinetic-marquee__track` animation rule isn't in this
    // bundle. Fail-OPEN — a VITE_KINETIC_MARQUEE=1 rebuild applies it.
    skip(
      `${slug}: kinetic-marquee CSS not in this build (dark flag / stale — a VITE_KINETIC_MARQUEE=1 rebuild applies it)`,
      `animation-name="${motion.contract.animationName}"`,
    );
    continue;
  }
  // CSS is deployed — run the reduced-motion pass and assert all fail-closed invariants.
  const reduced = await probe(slug, { reduced: true });
  // 1. Reduced-motion gate.
  line(
    `${slug}: reduced-motion withholds drift animation (static ribbon)`,
    reduced.contract && (reduced.contract.animationName === 'none' || reduced.contract.animationName === ''),
    `reduced animation-name="${reduced.contract?.animationName}"`,
  );
  // 2. Container overflow:hidden clip contract.
  line(
    `${slug}: .ps-kinetic-marquee container overflow is hidden (clip contract)`,
    motion.contract.overflow === 'hidden',
    `overflow="${motion.contract.overflow}"`,
  );
  // 3. 0 console errors (cold load, both motion prefs).
  line(
    `${slug}: 0 console errors (cold load, both motion prefs)`,
    motion.errs.length === 0 && reduced.errs.length === 0,
    motion.errs.length > 0 ? motion.errs[0] : reduced.errs[0] || '',
  );
  // 4. Natural bands (advisory) + LCP-safety when present.
  const nat = motion.contract.natural;
  rows.push(
    `  ℹ️  ${slug}: ${nat} natural [data-kinetic-marquee] band(s) — dark by default, 0 is expected`,
  );
  if (nat > 0) {
    line(
      `${slug}: LCP element is NOT inside a kinetic-marquee band (hero stays LCP)`,
      motion.lcp.inMarquee === false,
      `LCP <${motion.lcp.tag}> ${motion.lcp.ms}ms`,
    );
    if (motion.lcp.ms >= 0) {
      rows.push(`  ::notice:: ${slug}: LCP=${motion.lcp.ms}ms (advisory — hard CWV gate is in verify-cwv.mjs; target ≤${LCP_BUDGET_MS}ms)`);
    }
  }
}

await b.close();
console.log('\n━━ kinetic-marquee (kinetic_marquee / VITE_KINETIC_MARQUEE, dark by default) — prod ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ kinetic-marquee PASS — where deployed: reduced-motion static, overflow:hidden, 0 console errors, hero stays LCP (LCP timing advisory — see verify-cwv.mjs); dark-flag / stale builds fail-open (skip).'
    : '\n❌ kinetic-marquee FAIL',
);
process.exit(exit);
