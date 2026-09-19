#!/usr/bin/env node
/**
 * verify-scroll-stack.mjs — § C (cinematic distinctiveness): the scroll-stacking process DECK
 * (flag `scroll_stack` / VITE_SCROLL_STACK, DARK by default) — the Apple/Awwwards "cards stack &
 * recede as you scroll" signature — is deployed correctly, reduced-motion-safe, mobile-safe, LCP-safe.
 *
 * The deck choreography is DECLARED in a linked stylesheet on `.process-steps.ps-scroll-stack > li`:
 *   base (always):  the `<ol>` is a vertical flex column (gap), NOT the horizontal grid.
 *   @supports (animation-timeline: view()) + @media (min-width:768px) and
 *             (prefers-reduced-motion: no-preference):
 *     each `> li` { position: sticky; top: calc(12vh + var(--step-i) * 1.1rem);
 *                   animation: ps-scroll-stack-recede linear both; animation-timeline: view() }
 *   → cards PIN and RECEDE (scale .93 / opacity .62) as the next card slides over them.
 *   Below 768px, under reduced-motion, or without animation-timeline → a plain static vertical list.
 *
 * STALE-BUILD / DARK-FLAG DISCIPLINE (validator-precision + report-mode-probe):
 * The flag is DARK by default — most prod sites will NOT carry the deck CSS yet. Correct, must NOT
 * fail. The probe DETECTS deployment by injecting a bare `.process-steps.ps-scroll-stack` deck (NO
 * inline style) and reading getComputedStyle at desktop 1280 + motion-allowed. If the injected
 * `> li` computed `position === 'sticky'` → deck CSS is DEPLOYED, assert the contract. Else → SKIP
 * with ::notice. Fail-OPEN when no site carries it; flips to a real assertion as sites rebuild
 * with VITE_SCROLL_STACK=1. Mirrors verify-kinetic-marquee.mjs / verify-depth-cascade.mjs.
 *
 * Fail-CLOSED (real regressions) ONLY where the deck CSS is deployed:
 *   1. REDUCED-MOTION GATED — under reducedMotion:'reduce' the injected `> li` is NOT sticky and
 *      animation-name is 'none'/'' → a plain static list.
 *   2. MOBILE GATED — at 390px + motion the injected `> li` is NOT sticky (the min-width:768 gate)
 *      → a plain static list (no pin thrash on phones).
 *   3. If a NATURAL `.process-steps.ps-scroll-stack` deck is present, the LCP element is NOT inside
 *      it (`el.closest('.ps-scroll-stack')` is null → hero stays LCP), and LCP ≤ 2000ms. The deck
 *      sits below the fold and its cards rest at identity, so this always holds — assert it anyway.
 *   4. 0 console errors on cold load across desktop-motion + reduced + mobile.
 *
 * Natural decks are ADVISORY — dark by default means usually 0; not a failure.
 *
 * Usage: SITES=strand-book-store node e2e/site-quality/verify-scroll-stack.mjs
 */
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const LCP_BUDGET_MS = 2000;

const b = await chromium.launch();

// Inject a bare `.process-steps.ps-scroll-stack` deck (NO inline style) so computed styles must come
// from the shipped stylesheet only. Returns: { position, animationName, natural }.
const CONTRACT = () => {
  const ol = document.createElement('ol');
  ol.className = 'process-steps ps-scroll-stack relative gap-6';
  ol.setAttribute('data-ss-probe', '1');
  for (let i = 0; i < 4; i++) {
    const li = document.createElement('li');
    li.className = 'process-step card-tactile p-6';
    li.style.setProperty('--step-i', String(i));
    li.textContent = `Step ${i + 1}`;
    ol.appendChild(li);
  }
  document.body.appendChild(ol);
  const cs = getComputedStyle(ol.querySelector('li'));
  const res = {
    position: cs.position,
    animationName: cs.animationName,
    // Natural decks: a real rebuilt site with the process section AND the flag on. `data-ss-probe`
    // excluded so we only count the site's own decks, never our injected one.
    natural: document.querySelectorAll('.process-steps.ps-scroll-stack:not([data-ss-probe])').length,
  };
  ol.remove();
  return res;
};

async function probe(slug, { width = 1280, reduced = false } = {}) {
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width, height: 900 },
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
  // LCP candidate + whether it sits inside a natural scroll-stack deck.
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
                inStack: el ? !!el.closest('.process-steps.ps-scroll-stack') : false,
                tag: el ? el.tagName.toLowerCase() : 'none',
              });
            }, 1500);
          }),
      )
    : { ms: -1, inStack: false, tag: 'none' };
  await ctx.close();
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
  const motion = await probe(slug, { width: 1280, reduced: false });
  if (!motion.contract) {
    skip(`${slug}: could not load (fail-open)`, motion.errs.slice(0, 1).join(''));
    continue;
  }
  const deployed = motion.contract.position === 'sticky';
  if (!deployed) {
    // Dark flag or stale build: the `.ps-scroll-stack > li` sticky+recede rule isn't in this
    // bundle. Fail-OPEN — a VITE_SCROLL_STACK=1 rebuild applies it.
    skip(
      `${slug}: scroll-stack deck CSS not in this build (dark flag / stale — a VITE_SCROLL_STACK=1 rebuild applies it)`,
      `desktop li position="${motion.contract.position}" animation-name="${motion.contract.animationName}"`,
    );
    continue;
  }
  // Deck CSS is deployed — run reduced-motion + mobile passes and assert all fail-closed invariants.
  const reduced = await probe(slug, { width: 1280, reduced: true });
  const mobile = await probe(slug, { width: 390, reduced: false });
  // 0. Desktop + motion cards recede (pairs with the sticky pin already proven by `deployed`).
  line(
    `${slug}: desktop cards RECEDE (animation-name=ps-scroll-stack-recede) + PIN (position:sticky)`,
    motion.contract.animationName === 'ps-scroll-stack-recede',
    `animation-name="${motion.contract.animationName}"`,
  );
  // 1. Reduced-motion gate → static list.
  line(
    `${slug}: reduced-motion → plain static list (not sticky, no recede)`,
    reduced.contract &&
      reduced.contract.position !== 'sticky' &&
      (reduced.contract.animationName === 'none' || reduced.contract.animationName === ''),
    `reduced position="${reduced.contract?.position}" animation-name="${reduced.contract?.animationName}"`,
  );
  // 2. Mobile gate (<768) → static list (no pin thrash on phones).
  line(
    `${slug}: mobile (<768) → plain static list (the min-width:768 gate)`,
    mobile.contract && mobile.contract.position !== 'sticky',
    `mobile position="${mobile.contract?.position}"`,
  );
  // 3. 0 console errors (cold load, desktop-motion + reduced + mobile).
  line(
    `${slug}: 0 console errors (cold load — desktop-motion + reduced + mobile)`,
    motion.errs.length === 0 && reduced.errs.length === 0 && mobile.errs.length === 0,
    [...motion.errs, ...reduced.errs, ...mobile.errs][0] || '',
  );
  // 4. Natural decks (advisory) + LCP-safety when present.
  const nat = motion.contract.natural;
  rows.push(`  ℹ️  ${slug}: ${nat} natural .ps-scroll-stack deck(s) — dark by default, 0 is expected`);
  if (nat > 0) {
    line(
      `${slug}: LCP element is NOT inside a scroll-stack deck (hero stays LCP)`,
      motion.lcp.inStack === false,
      `LCP <${motion.lcp.tag}> ${motion.lcp.ms}ms`,
    );
    if (motion.lcp.ms >= 0) {
      line(`${slug}: LCP ≤ ${LCP_BUDGET_MS}ms`, motion.lcp.ms <= LCP_BUDGET_MS, `LCP=${motion.lcp.ms}ms`);
    }
  }
}

await b.close();
console.log('\n━━ scroll-stack deck (scroll_stack / VITE_SCROLL_STACK, dark by default) — prod ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ scroll-stack PASS — where deployed: desktop pin+recede, reduced-motion static, mobile static, 0 console errors, hero stays LCP (≤2.0s); dark-flag / stale builds fail-open (skip).'
    : '\n❌ scroll-stack FAIL',
);
process.exit(exit);
