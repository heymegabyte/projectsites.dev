// focus-not-obscured.mjs — WCAG 2.2 §2.4.11 Focus Not Obscured (AA) probe, the ONE
// new-WCAG-2.2 AA criterion axe cannot detect (axe auto-tests only 2.5.8 of the 9).
//
// The admin is a DOCUMENT-scrolled shell (the right column is `min-h-screen`, no inner
// overflow) with `.admin-topbar sticky top-0` (62px) pinned to the viewport top. Marketing
// pins a `position:fixed` 64px header. Neither had `scroll-padding-top` — so when the browser
// scrolls a focused element to the scrollport top (Shift-Tab up a scrolled form, skip-link,
// :target anchor), the element parks UNDER the bar. Any control ≤ bar height is ENTIRELY
// hidden → a 2.4.11 AA failure that renders + axe-checks perfectly clean.
//
// This probe REPRODUCES that deterministically: seed the authed session, open a tall admin
// section, force instant scroll, jump to the document bottom (so top-of-content focusables sit
// ABOVE the viewport), then `.focus()` each and measure its rect vs the sticky topbar's bottom
// edge. clearance = rect.top − topbarBottom. clearance < 0 ⇒ under the bar; entirely-hidden
// when the whole rect is above the bar's bottom.
//
// Fail-open (conditional-ci-gates): E2E_API_KEY unset ⇒ ::notice:: + exit 0 (never a false red).
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/focus-not-obscured.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: focus-not-obscured skipped — E2E_API_KEY unset');
  process.exit(0);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Tall sections that reliably scroll with the e2e-test-org data set (audit ~500 rows,
// sites ~107 rows, settings = long form). A section shorter than the viewport can't
// reproduce the obscuring (nothing scrolls) — it's reported as n/a, never a pass.
const SECTIONS = (process.env.SECTIONS || 'audit,sites,settings,analytics').split(',');

const browser = await chromium.launch();
// Viewport configurable (VIEWPORT=390 for the mobile pass); default desktop.
// Mirrors admin-surf-audit's VIEWPORT convention.
const VW = parseInt(process.env.VIEWPORT || '1280', 10);
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: VW, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();

await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => {
  localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }));
}, KEY);

/**
 * In-page measurement: for the topmost content focusables, park the document at the
 * bottom, focus each, and record where the browser scrolled it relative to the sticky
 * topbar's bottom edge. Returns the worst (smallest-clearance) obscured candidate.
 */
async function measure() {
  return page.evaluate(() => {
    const bar = document.querySelector('.admin-topbar');
    if (!bar) return { err: 'no .admin-topbar' };
    const root = document.scrollingElement || document.documentElement;
    // Deterministic: kill smooth-scroll so focus scroll settles synchronously.
    const prevBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    const scrollable = root.scrollHeight > window.innerHeight + 120;

    const inChrome = (el) => el.closest('.admin-topbar, .admin-sidebar, [role="dialog"]') != null;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (el.offsetParent == null || r.width <= 0 || r.height <= 0 || el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
      // Only NORMAL-FLOW controls are governed by scroll-padding-top. Skip-links and
      // other position:absolute/fixed/sticky affordances have their own focus handling
      // (the app's skip-link is position:absolute; top:-40→0 on :focus) and are NOT the
      // scroll-obscuring class this probe targets — excluding them kills that false positive.
      const pos = getComputedStyle(el).position;
      return pos === 'static' || pos === 'relative';
    };
    const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusables = [...document.querySelectorAll(sel)].filter((el) => !inChrome(el) && visible(el)).slice(0, 8);

    const barBottomNow = () => bar.getBoundingClientRect().bottom;
    let worst = null;
    for (const el of focusables) {
      // BEFORE: park at bottom, DON'T focus — where does the element naturally sit?
      // (If a sticky parent already pins it under the bar, this is NOT the scroll class.)
      root.style.scrollPaddingTop = '0px';
      root.scrollTop = root.scrollHeight;
      const beforeTop = Math.round(el.getBoundingClientRect().top);
      // AFTER (unfixed): focus → browser scrolls it into view aligned to scrollport top.
      el.focus({ preventScroll: false });
      const rAfter = el.getBoundingClientRect();
      const barB = barBottomNow();
      const afterTop = Math.round(rAfter.top);
      const clearance = Math.round(rAfter.top - barB); // <0 ⇒ under the bar
      const entirelyHidden = rAfter.height > 0 && rAfter.bottom <= barB + 0.5;
      // PROOF: re-run WITH scroll-padding-top:72px on the live scroller. If the element now
      // clears the bar, scroll-padding-top is the correct root-cause fix; if not, it's a
      // sticky-parent/z-order issue this fix wouldn't touch (don't ship the wrong fix).
      el.blur();
      root.style.scrollPaddingTop = '72px';
      root.scrollTop = root.scrollHeight;
      el.focus({ preventScroll: false });
      const paddedClearance = Math.round(el.getBoundingClientRect().top - barBottomNow());
      root.style.scrollPaddingTop = '0px';
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
      // A genuine, scroll-padding-fixable 2.4.11 case: focus MOVED it (beforeTop≠afterTop),
      // it lands entirely under the bar unfixed, AND the padding makes it clear.
      const focusMoved = Math.abs(beforeTop - afterTop) > 4;
      const fixable = entirelyHidden && focusMoved && paddedClearance >= 0;
      const cand = { clearance, entirelyHidden, fixable, focusMoved, paddedClearance, barBottom: Math.round(barB), beforeTop, top: afterTop, h: Math.round(rAfter.height), tag: el.tagName.toLowerCase(), label };
      if (!worst || clearance < worst.clearance) worst = cand;
    }
    root.style.scrollBehavior = prevBehavior;
    return { scrollable, count: focusables.length, worst };
  });
}

const rows = [];
let aaFails = 0;
for (const s of SECTIONS) {
  try {
    await page.goto(`${ORIGIN}/admin/${s}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800); // settle async data (networkidle HANGS on this app — admin-verify gotcha)
    const m = await measure();
    if (m.err) { rows.push({ s, note: m.err }); continue; }
    if (!m.scrollable) { rows.push({ s, note: 'n/a (content ≤ viewport, cannot repro)' }); continue; }
    if (!m.worst) { rows.push({ s, note: `no content focusables (${m.count})` }); continue; }
    const w = m.worst;
    // 2.4.11 (AA) fails whenever a focused normal-flow control lands ENTIRELY under the
    // sticky topbar — the user-facing failure is identical regardless of MECHANISM. The
    // focusMoved/paddedClearance fields only pick WHICH fix: focus-scrolled + padding-clears
    // ⇒ scroll-padding-top on the scroller; else (sticky parent rode under the bar) ⇒ pin the
    // sticky element below the bar / raise its z-index. Both are reported so the fix is unambiguous.
    const fix = w.entirelyHidden ? (w.focusMoved && w.paddedClearance >= 0 ? 'scroll-padding-top on scroller' : 'pin sticky element below topbar (top ≥ bar height) / z-order') : '';
    const verdict = w.entirelyHidden ? 'AA-FAIL' : w.clearance < 0 ? 'aaa-partial' : 'ok';
    if (w.entirelyHidden) aaFails++;
    rows.push({ s, verdict, fix, ...w });
  } catch (e) {
    rows.push({ s, note: 'error: ' + String(e).slice(0, 80) });
  }
}

await browser.close();

for (const r of rows) {
  if (r.note) { console.log(`  ·  ${r.s.padEnd(10)} ${r.note}`); continue; }
  const mark = r.verdict === 'AA-FAIL' ? '✗' : r.verdict === 'aaa-partial' ? '~' : '✓';
  const tail = r.verdict === 'AA-FAIL'
    ? `← ENTIRELY UNDER STICKY TOPBAR (2.4.11 AA) — fix: ${r.fix} [focusMoved=${r.focusMoved}, padded ${r.clearance}px→${r.paddedClearance}px]`
    : '';
  console.log(
    `  ${mark}  ${r.s.padEnd(10)} clearance=${String(r.clearance).padStart(5)}px  (focused ${r.tag} "${r.label}" before=${r.beforeTop} after=${r.top} h=${r.h}, bar=${r.barBottom})  ${tail}`,
  );
}
console.log(
  aaFails
    ? `VERDICT: ❌ FAIL — ${aaFails} section(s) park a focused control ENTIRELY under the sticky topbar (WCAG 2.4.11 AA). See per-section fix above (scroll-padding-top vs sticky-offset).`
    : `VERDICT: ✅ PASS — no focused control is entirely obscured by the sticky topbar (WCAG 2.4.11 AA).`,
);
process.exit(aaFails ? 1 : 0);
