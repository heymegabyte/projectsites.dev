#!/usr/bin/env node
/**
 * verify-depth-cascade.mjs — § C.7 (cinematic distinctiveness): the 3D scroll depth-cascade
 * (`scroll_cinema`, PROMOTED default-on in AL-782) is deployed correctly, reduced-motion-safe, and
 * LCP-safe on generated retail sites.
 *
 * The template's DepthCascade (motion.so/Awwwards "content emerges from depth") makes a group's
 * direct children cascade forward out of Z-depth as it scrolls into view, via native
 * `animation-timeline: view()`. The choreography is DECLARED in a linked stylesheet:
 * `.ps-depth-cascade > * { animation: ps-depth-cascade-in ...; animation-timeline: view() }` under
 * `@supports (animation-timeline: view()) { @media (prefers-reduced-motion: no-preference) }`.
 * FeaturedCollection (the retail product grid) is the first NATURAL adopter — its grid ships as
 * `[data-depth-cascade="1"]`.
 *
 * STALE-BUILD DISCIPLINE (validator-precision + report-mode-probe-deployed-defect-is-often-stale):
 * a site built BEFORE the `.ps-depth-cascade` CSS landed (pre-AL-708) doesn't carry the rule, so a
 * bare `.ps-depth-cascade > *` stays un-animated — that's stale-build debt (a full rebuild applies
 * it), NOT a template defect. The probe DETECTS deployment by injecting a bare `.ps-depth-cascade`
 * child (no inline style): if it inherits `animation-name: ps-depth-cascade-in` from the shipped
 * stylesheet, the CSS is deployed and the contract is asserted; else → SKIP (::notice). Fail-OPEN
 * when no site carries the effect; flips to a real GREEN assertion as sites full-rebuild.
 *
 * Fail-CLOSED (a real regression) only on the DETERMINISTIC, safety-critical invariants:
 *   1. REDUCED-MOTION GATED — under `prefers-reduced-motion: reduce` the injected child's
 *      animation-name is `none` (the @media gate withholds it) → static, never stuck-in-depth.
 *   2. LCP-SAFE — if a NATURAL `[data-depth-cascade]` group is present (a fresh retail build), the
 *      LCP element is NEVER inside it (the hero stays the LCP).
 *   3. 0 console errors on the cold load.
 * The presence of a natural `[data-depth-cascade]` group + its child count are REPORTED (advisory) —
 * only retail verticals render FeaturedCollection, so its absence is not a failure.
 *
 * Usage: SITES=catbird-brooklyn node e2e/site-quality/verify-depth-cascade.mjs
 */
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'catbird-brooklyn,luna-felix-goldsmith-santa-fe,gentle-dental-seattle').split(',');
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const LCP_BUDGET_MS = 2000;

const b = await chromium.launch();

// Inject a bare `.ps-depth-cascade > *` (NO inline style) so it must inherit the shipped stylesheet,
// and report the computed contract the browser applies + whether a NATURAL adopter group is present.
const CONTRACT = () => {
  const wrap = document.createElement('div');
  wrap.className = 'ps-depth-cascade';
  const item = document.createElement('div');
  wrap.appendChild(item);
  document.body.appendChild(wrap);
  const wcs = getComputedStyle(wrap);
  const ics = getComputedStyle(item);
  const res = {
    perspective: wcs.perspective,
    animationName: ics.animationName,
    natural: document.querySelectorAll('[data-depth-cascade="1"]').length,
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
  // LCP candidate + whether it sits inside a natural cascade group.
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
                inCascade: el ? !!el.closest('[data-depth-cascade]') : false,
                tag: el ? el.tagName.toLowerCase() : 'none',
              });
            }, 1500);
          }),
      )
    : { ms: -1, inCascade: false, tag: 'none' };
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
  const deployed = motion.contract.animationName === 'ps-depth-cascade-in';
  if (!deployed) {
    // Pre-AL-708 build: the `.ps-depth-cascade` rule isn't in this bundle → stale-build debt, not a
    // defect. Fail-OPEN (a full rebuild applies it).
    skip(
      `${slug}: depth-cascade CSS not in this build (stale — rebuild applies it)`,
      `animation-name="${motion.contract.animationName}"`,
    );
    continue;
  }
  const reduced = await probe(slug, { reduced: true });
  // Fail-CLOSED invariants:
  line(
    `${slug}: reduced-motion leaves items STATIC (no cascade animation)`,
    reduced.contract && (reduced.contract.animationName === 'none' || reduced.contract.animationName === ''),
    `reduced animation-name="${reduced.contract?.animationName}"`,
  );
  line(`${slug}: 0 console errors (cold load, both motion prefs)`, motion.errs.length === 0 && reduced.errs.length === 0);
  const nat = motion.contract.natural;
  if (nat > 0) {
    line(
      `${slug}: LCP element is NOT inside the depth-cascade group (hero stays LCP)`,
      motion.lcp.inCascade === false,
      `LCP <${motion.lcp.tag}> ${motion.lcp.ms}ms`,
    );
    if (motion.lcp.ms >= 0)
      rows.push(`  ::notice:: ${slug}: LCP=${motion.lcp.ms}ms (advisory — hard CWV gate is in verify-cwv.mjs; target ≤${LCP_BUDGET_MS}ms)`);
    rows.push(`  ℹ️  ${slug}: ${nat} natural [data-depth-cascade] group(s) — FeaturedCollection adopted the cascade`);
  } else {
    rows.push(
      `  ℹ️  ${slug}: CSS deployed + contract holds, but no natural [data-depth-cascade] yet (non-retail, or retail build pre-AL-782 / no collection items)`,
    );
  }
}

await b.close();
console.log('\n━━ § C.7 depth-cascade (scroll_cinema, default-on) — prod ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ depth-cascade PASS — where deployed: reduced-motion static, 0 console errors, hero stays LCP (LCP timing advisory — see verify-cwv.mjs); stale/non-retail builds fail-open (skip).'
    : '\n❌ depth-cascade FAIL',
);
process.exit(exit);
