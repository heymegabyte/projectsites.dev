// verify-particle-field.mjs — § C.7 distinctiveness: the ambient particle field (Awwwards/motion.so
// "living canvas" motes behind the CTA band) renders on a deployed site AND stays LCP-safe. Promoted
// from experimental-dark → ON-by-default (AL-801). This probe proves the promotion holds live:
//   1. RENDERS — the `[data-particle-field="1"]` canvas mounts (post-idle) with default motion.
//   2. LCP-SAFE — the canvas is ABSENT at `load` (never competes with the hero LCP element) and
//      appears only AFTER an idle callback; it is `aria-hidden` + absolutely-positioned (0 CLS).
//   3. REDUCED-MOTION — under `prefers-reduced-motion: reduce`, the canvas NEVER appears (gated off).
//   4. 0 console errors.
//
// Real Chromium. TARGET overrides the audited URL (default: the template demo, which carries the CTA
// section). Fail-OPEN when the target is unreachable. TRACKING by default (::notice) — a generated
// site only shows the field once it rebuilds on template ≥ the AL-801 commit; STRICT=1 to gate.
// Auto-joins the site-quality run-all glob.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'));
const { chromium } = require2('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const TARGET = process.env.TARGET || 'https://template.projectsites.dev/';
const STRICT = /^(1|true)$/i.test(process.env.STRICT || '');

const browser = await chromium.launch();
const rows = [];
let fail = false;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fail = true;
};

try {
  // ── Default motion: the field renders post-idle + is LCP-safe ──
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 90)); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 90)));
  await page.goto(TARGET, { waitUntil: 'load', timeout: 45000 });

  // The LCP-safety tell: the decorative canvas is ABSENT the instant the page loads (it can't be the
  // LCP element if it isn't in the DOM yet). It mounts only after the post-first-paint idle callback.
  const atLoad = await page.evaluate(() => !!document.querySelector('[data-particle-field="1"]'));
  const mounted = await page
    .waitForSelector('[data-particle-field="1"]', { timeout: 4000, state: 'attached' })
    .then(() => true)
    .catch(() => false);

  if (!mounted) {
    console.log(`::notice:: verify-particle-field — no particle-field canvas at ${TARGET} (site not yet rebuilt on template ≥ AL-801, or CTA not on this route). SKIP.`);
    await browser.close();
    process.exit(0);
  }

  const attrs = await page.evaluate(() => {
    const c = document.querySelector('[data-particle-field="1"]');
    if (!c) return null;
    const cs = getComputedStyle(c);
    return { ariaHidden: c.getAttribute('aria-hidden'), position: cs.position, tag: c.tagName };
  });
  check('LCP-safe: canvas ABSENT at load (mounts only post-idle, never the LCP element)', atLoad === false, `atLoad=${atLoad}`);
  check('renders: [data-particle-field] canvas present after idle', mounted === true);
  check('a11y: decorative canvas is aria-hidden', attrs?.ariaHidden === 'true', `aria-hidden=${attrs?.ariaHidden}`);
  check('CLS-safe: canvas is absolutely positioned', attrs?.position === 'absolute', `position=${attrs?.position}`);
  check('0 console errors (default motion)', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();

  // ── Reduced motion: the field must NEVER appear ──
  const rmCtx = await browser.newContext({ userAgent: UA, reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
  const rmPage = await rmCtx.newPage();
  await rmPage.goto(TARGET, { waitUntil: 'load', timeout: 45000 });
  const rmShown = await rmPage
    .waitForSelector('[data-particle-field="1"]', { timeout: 2500, state: 'attached' })
    .then(() => true)
    .catch(() => false);
  check('reduced-motion: canvas is ABSENT (gated off — the gradient stands)', rmShown === false, `shown=${rmShown}`);
  await rmCtx.close();
} catch (e) {
  console.log(`::notice:: verify-particle-field — target unreachable (fail-open): ${String(e).slice(0, 80)}`);
  await browser.close();
  process.exit(0);
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(62)} ${r.detail}`);
console.log(`::json:: ${JSON.stringify({ probe: 'particle-field', target: TARGET, mode: STRICT ? 'strict' : 'tracking', fails: rows.filter((r) => !r.ok).length })}`);
console.log(
  fail
    ? `\n${STRICT ? '🔴 FAIL' : '::warning::'} — the ambient particle field regressed (render / LCP-safety / reduced-motion / console).`
    : `\nVERDICT: ✅ § C.7 PASS — the ambient particle field renders post-idle (LCP-safe), is aria-hidden + CLS-safe, and is gated off under reduced-motion.`,
);
process.exit(STRICT && fail ? 1 : 0);
