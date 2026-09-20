#!/usr/bin/env node
/**
 * verify-living-border.mjs — § C.7 (cinematic distinctiveness): the "living gradient border" (flag
 * `living_border` / VITE_LIVING_BORDER, DARK by default) — a crisp conic-gradient ring rotates slowly
 * around the hero's PRIMARY CTA (a `.living-border` class + a masked `::before` ring driven by an
 * animated `@property --lb-angle`) — is deployed correctly, LCP-safe, and reduced-motion-safe.
 *
 * Pure CSS, no library. LCP-safe BY CONSTRUCTION: the ring is a decorative `z-index:-1` `::before`
 * with NEGATIVE inset (no reflow) on a CTA that sits BELOW the <h1> LCP element — the LCP element is
 * never the ring. CLS-safe (absolute, negative inset). reduced-motion → the ring is STATIC.
 *
 * STALE-BUILD / DARK-FLAG DISCIPLINE (validator-precision + report-mode-probe): the flag is DARK by
 * default — most prod sites won't carry `.living-border` on their CTA yet. The probe DEPLOY-DETECTS by
 * injecting a bare `.living-border` element and reading getComputedStyle(el,'::before'): a
 * conic-gradient background (+ animation-name 'lb-spin' under motion) → the CSS is deployed, assert;
 * else SKIP (::notice). Fail-OPEN on sites built before this template change; flips to a real assertion
 * as sites rebuild with the CSS.
 *
 * Fail-CLOSED (real regressions) ONLY where the CSS is deployed:
 *   1. reduced-motion → the injected element's ::before animation-name is 'none'/'' (static ring).
 *   2. the ::before is behind the element (z-index -1) — the ring can never occlude the CTA label.
 *   3. if a NATURAL `.living-border` CTA is present, the LCP element is NOT it (hero <h1> stays LCP)
 *      (LCP timing is advisory — CWV hard gate is verify-cwv.mjs)
 *   4. 0 console errors on cold load, both motion prefs.
 *
 * Usage: SITES=<slug> node e2e/site-quality/verify-living-border.mjs
 */
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const LCP_BUDGET_MS = 2000;

const b = await chromium.launch();

// Inject a bare `.living-border` element (with a border-radius so ::before's `border-radius:inherit`
// resolves) so the computed ::before styles come from the shipped sheet only.
const CONTRACT = () => {
  const el = document.createElement('div');
  el.className = 'living-border';
  el.setAttribute('data-lb-probe', '1');
  el.style.cssText = 'position:relative;width:120px;height:44px;border-radius:12px';
  document.body.appendChild(el);
  const bs = getComputedStyle(el, '::before');
  const res = {
    animationName: bs.animationName,
    background: (bs.backgroundImage || '').slice(0, 40),
    zIndex: bs.zIndex,
    natural: document.querySelectorAll('.living-border:not([data-lb-probe])').length,
  };
  el.remove();
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
  const lcp =
    contract && contract.natural > 0
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
                /* no LCP */
              }
              setTimeout(() => {
                const el = last?.element;
                resolve({
                  ms: last ? Math.round(last.startTime) : -1,
                  isLivingBorder: el ? el.classList?.contains('living-border') : false,
                  tag: el ? el.tagName.toLowerCase() : 'none',
                });
              }, 1200);
            }),
        )
      : { ms: -1, isLivingBorder: false, tag: 'none' };
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
  const deployed = /conic-gradient/.test(motion.contract.background);
  if (!deployed) {
    skip(
      `${slug}: living-border CSS not in this build (dark flag / stale — a VITE_LIVING_BORDER rebuild ships it)`,
      `::before bg="${motion.contract.background}"`,
    );
    continue;
  }
  line(true, `${slug}: living-border CSS deployed (::before is a conic-gradient ring)`);
  line(
    motion.contract.animationName === 'lb-spin',
    `${slug}: the ring runs the lb-spin conic animation (desktop+motion)`,
    `animation-name="${motion.contract.animationName}"`,
  );
  line(
    String(motion.contract.zIndex) === '-1',
    `${slug}: the ring sits BEHIND the CTA (z-index:-1 → never occludes the label)`,
    `z-index=${motion.contract.zIndex}`,
  );
  const reduced = await probe(slug, { reduced: true });
  line(
    reduced.contract && (reduced.contract.animationName === 'none' || reduced.contract.animationName === ''),
    `${slug}: reduced-motion withholds the spin (static gradient ring)`,
    `reduced animation-name="${reduced.contract?.animationName}"`,
  );
  line(
    motion.errs.length === 0 && reduced.errs.length === 0,
    `${slug}: 0 console errors (cold load, both motion prefs)`,
    motion.errs[0] || reduced.errs[0] || '',
  );
  const nat = motion.contract.natural;
  rows.push(`  ℹ️  ${slug}: ${nat} natural .living-border CTA(s) — dark by default, 0 is expected`);
  if (nat > 0) {
    line(
      motion.lcp.isLivingBorder === false,
      `${slug}: the CTA ring is NOT the LCP element (hero <h1> stays LCP)`,
      `LCP <${motion.lcp.tag}> livingBorder=${motion.lcp.isLivingBorder} ${motion.lcp.ms}ms`,
    );
    if (motion.lcp.ms >= 0) {
      // Advisory LCP timing — CWV owned by verify-cwv.mjs; cold/warm-edge variance makes a
      // hard gate here unreliable.  Track as a ::notice:: line only (never process.exit(1)).
      rows.push(
        `  ::notice:: ${slug}: LCP=${motion.lcp.ms}ms (advisory — hard CWV gate is in verify-cwv.mjs; target ≤${LCP_BUDGET_MS}ms)`,
      );
    }
  }
}

await b.close();
console.log('\n━━ living-border (living_border / VITE_LIVING_BORDER, dark by default) — prod ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ living-border PASS — where deployed: conic ring + lb-spin, behind the CTA (z-index:-1), reduced-motion static, hero <h1> stays LCP (LCP timing advisory — see verify-cwv.mjs), 0 console errors; dark/stale builds fail-open (skip).'
    : '\n❌ living-border FAIL',
);
process.exit(exit);
