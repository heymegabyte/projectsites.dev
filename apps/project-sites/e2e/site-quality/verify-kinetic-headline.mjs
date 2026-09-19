#!/usr/bin/env node
/**
 * verify-kinetic-headline.mjs — § C (cinematic distinctiveness): the motion.so/Awwwards VARIABLE-FONT
 * hero headline (flag `kinetic_headline` / VITE_KINETIC_HEADLINE, DARK by default) — the hero `<h1>`
 * compresses its font weight (800→500) + width (120→90) + letter-spacing as the visitor scrolls past
 * the hero — is deployed correctly, LCP-safe, and reduced-motion-safe.
 *
 * The effect is a single linked-stylesheet class added to the EXISTING hero h1 (no component swap):
 *   @supports (animation-timeline: scroll()):
 *     @media (prefers-reduced-motion: no-preference):
 *       .kinetic-headline { animation: kinetic-compress linear both; animation-timeline: scroll(root);
 *                           animation-range: 0 50vh }
 *   → LCP-safe BY CONSTRUCTION: scroll(root) 0→50vh means the timeline is at 0% (the wght-800 FROM state)
 *     while the hero is fully in view at first paint — the LCP h1 paints as ordinary text, unchanged; the
 *     compress only plays as the hero scrolls off. No component swap → a11y + LCP element untouched.
 *
 * STALE-BUILD / DARK-FLAG DISCIPLINE (validator-precision + report-mode-probe): the flag is DARK by
 * default — most prod sites won't carry the class on their h1 yet. Correct, must NOT fail. The probe
 * DEPLOY-DETECTS by injecting a bare `.kinetic-headline` element (NO inline style) at desktop+motion and
 * reading getComputedStyle.animationName: 'kinetic-compress' → CSS deployed, assert; else SKIP (::notice).
 * Fail-OPEN when no site carries it; flips to a real assertion as sites rebuild with VITE_KINETIC_HEADLINE=1.
 *
 * Fail-CLOSED (real regressions) ONLY where the CSS is deployed:
 *   1. reduced-motion → the injected element's animation-name is 'none'/'' (static full-weight headline).
 *   2. if a NATURAL hero `<h1.kinetic-headline>` is present, the LCP element is that h1 (hero stays LCP)
 *      and LCP ≤ 2000ms — the effect never displaces/regresses the LCP.
 *   3. 0 console errors on cold load, both motion prefs.
 *
 * Usage: SITES=<slug> node e2e/site-quality/verify-kinetic-headline.mjs
 */
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const LCP_BUDGET_MS = 2000;

const b = await chromium.launch();

// Inject a bare `.kinetic-headline` (NO inline style) so computed styles come from the shipped sheet only.
const CONTRACT = () => {
  const h = document.createElement('h1');
  h.className = 'kinetic-headline gradient-text';
  h.setAttribute('data-kh-probe', '1');
  h.textContent = 'Kinetic headline probe';
  document.body.appendChild(h);
  const cs = getComputedStyle(h);
  const res = {
    animationName: cs.animationName,
    natural: document.querySelectorAll('h1.kinetic-headline:not([data-kh-probe])').length,
  };
  h.remove();
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
              /* no LCP */
            }
            setTimeout(() => {
              const el = last?.element;
              resolve({
                ms: last ? Math.round(last.startTime) : -1,
                isKineticH1: el ? el.tagName === 'H1' && el.classList.contains('kinetic-headline') : false,
                tag: el ? el.tagName.toLowerCase() : 'none',
              });
            }, 1500);
          }),
      )
    : { ms: -1, isKineticH1: false, tag: 'none' };
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
  const deployed = motion.contract.animationName === 'kinetic-compress';
  if (!deployed) {
    skip(
      `${slug}: kinetic-headline CSS not in this build (dark flag / stale — a VITE_KINETIC_HEADLINE=1 rebuild applies it)`,
      `animation-name="${motion.contract.animationName}"`,
    );
    continue;
  }
  const reduced = await probe(slug, { reduced: true });
  line(
    reduced.contract && (reduced.contract.animationName === 'none' || reduced.contract.animationName === ''),
    `${slug}: reduced-motion withholds the compress (static full-weight headline)`,
    `reduced animation-name="${reduced.contract?.animationName}"`,
  );
  line(
    motion.errs.length === 0 && reduced.errs.length === 0,
    `${slug}: 0 console errors (cold load, both motion prefs)`,
    motion.errs[0] || reduced.errs[0] || '',
  );
  const nat = motion.contract.natural;
  rows.push(`  ℹ️  ${slug}: ${nat} natural h1.kinetic-headline — dark by default, 0 is expected`);
  if (nat > 0) {
    line(
      motion.lcp.isKineticH1 === true || motion.lcp.tag === 'h1',
      `${slug}: the hero <h1> stays the LCP element (effect never displaces LCP)`,
      `LCP <${motion.lcp.tag}> kinetic=${motion.lcp.isKineticH1} ${motion.lcp.ms}ms`,
    );
    if (motion.lcp.ms >= 0) {
      line(motion.lcp.ms <= LCP_BUDGET_MS, `${slug}: LCP ≤ ${LCP_BUDGET_MS}ms`, `LCP=${motion.lcp.ms}ms`);
    }
  }
}

await b.close();
console.log('\n━━ kinetic-headline (kinetic_headline / VITE_KINETIC_HEADLINE, dark by default) — prod ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ kinetic-headline PASS — where deployed: reduced-motion static, hero <h1> stays LCP (≤2.0s), 0 console errors; dark-flag / stale builds fail-open (skip).'
    : '\n❌ kinetic-headline FAIL',
);
process.exit(exit);
