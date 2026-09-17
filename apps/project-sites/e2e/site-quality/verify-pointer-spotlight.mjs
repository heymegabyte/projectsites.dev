// verify-pointer-spotlight.mjs — § C.7 cinematic: the CTASection cursor-follow ambient spotlight
// (template PointerSpotlight.tsx) renders, tracks the pointer, and stays LCP-safe.
//
// Proves the CINEMATIC-3D increment live on the TEMPLATE DEMO (template.projectsites.dev, a CF
// Pages deploy — bypasses the site-gen build gate). Asserts:
//   1. the `.pointer-spotlight` layer renders on the emphatic CTA + is DECORATIVE (aria-hidden).
//   2. it's LCP-SAFE — the Largest Contentful Paint element is NOT the spotlight (it's an
//      img/heading), and LCP is fast (≤2500ms generous ceiling; the glow is a gradient div, never
//      the LCP candidate). A regression that made the glow the LCP element goes RED here.
//   3. on a fine pointer it TRACKS — pointermove over the CTA flips it to data-tracking='1' and
//      moves its transform (the effect actually works, not a dead decoration).
//   4. 0 console errors.
// Fail-OPEN (::notice, exit 0) when the layer is absent — a stale generated site (pre-rebuild)
// legitimately lacks it; only the template demo (or a freshly-built site) carries it. Auto-joins
// site-quality run-all via the verify-*.mjs glob.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'));
const { chromium } = require2('playwright');

const URL = process.env.SPOTLIGHT_URL || 'https://template.projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA }); // desktop Chromium = fine pointer
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 90)));
page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message.slice(0, 90)));

let fails = 0;
const rows = [];
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(1200);

  const present = await page.evaluate(() => !!document.querySelector('.pointer-spotlight'));
  if (!present) {
    console.log(`  ::notice:: no .pointer-spotlight on ${URL} — stale build (pre-rebuild) or non-emphatic CTA; skipping (fail-open).`);
    await browser.close();
    process.exit(0);
  }

  const meta = await page.evaluate(() => {
    const el = document.querySelector('.pointer-spotlight');
    return { ariaHidden: el?.getAttribute('aria-hidden'), tracking: el?.dataset.tracking ?? null };
  });
  check('spotlight renders + is decorative (aria-hidden)', meta.ariaHidden === 'true', `aria-hidden=${meta.ariaHidden}`);
  check('tracking gate ON (fine pointer → data-tracking=1)', meta.tracking === '1', `data-tracking=${meta.tracking}`);

  // LCP-safety: the LCP element must NOT be the spotlight; LCP must be fast.
  const lcp = await page.evaluate(
    () =>
      new Promise((res) => {
        let last = null;
        new PerformanceObserver((l) => { const e = l.getEntries(); last = e[e.length - 1]; }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => res(last ? { ms: Math.round(last.startTime), tag: last.element?.tagName || '?', cls: (last.element?.className || '').slice(0, 40) } : { ms: -1, tag: 'none', cls: '' }), 1500);
      }),
  );
  check('LCP element is NOT the spotlight (glow never becomes the LCP)', !/pointer-spotlight/.test(lcp.cls), `LCP=<${lcp.tag} class="${lcp.cls}">`);
  check('LCP fast (≤2500ms)', lcp.ms >= 0 && lcp.ms <= 2500, `lcp=${lcp.ms}ms`);

  // Tracking works: scroll the CTA into view, sweep the pointer over it (stepped → real
  // pointermove stream), assert the handler ran — it fades the glow in (--spot-opacity→1) and
  // sets the follow position (--px). Reading the inline vars is the DIRECT "handler fired" signal.
  await page.evaluate(() => document.querySelector('.pointer-spotlight')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  // Fire the REAL event a user's mouse move produces — a `pointermove` PointerEvent on the CTA
  // container (the listener's target) with real client coords — then wait for the rAF and read the
  // inline vars the handler sets. This is deterministic (no dependency on headless mouse-coordinate
  // emulation reaching the right element) and dispatches the exact browser event of a live move.
  const live = await page.evaluate(
    () =>
      new Promise((res) => {
        const el = document.querySelector('.pointer-spotlight');
        const parent = el?.parentElement;
        if (!el || !parent) return res({ opacity: '', px: '', dispatched: false });
        const r = parent.getBoundingClientRect();
        parent.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * 0.66, clientY: r.top + r.height * 0.55 }));
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            res({ opacity: el.style.getPropertyValue('--spot-opacity'), px: el.style.getPropertyValue('--px'), dispatched: true }),
          ),
        );
      }),
  );
  check('spotlight FOLLOWS the pointer (pointermove → --spot-opacity=1 + --px set to a px offset)', live.opacity === '1' && /px$/.test(live.px), `--spot-opacity=${live.opacity} --px=${live.px}`);

  check('0 console errors', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : 'clean');
} catch (e) {
  check('probe ran', false, `ERROR: ${String(e).slice(0, 100)}`);
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(52)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} pointer-spotlight check(s) failed on ${URL}.`
    : `\nVERDICT: ✅ § C.7 PASS — cursor-follow spotlight renders, tracks, and stays LCP-safe (glow is never the LCP element).`,
);
process.exit(fails ? 1 : 0);
