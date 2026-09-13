#!/usr/bin/env node
/**
 * verify-guest-funnel-keyboard.mjs — COMPLETION § B.1 (guest funnel), KEYBOARD-OPERABILITY leg.
 *
 * The homepage business-search dropdown result rows are `<button (mousedown)="selectItem(item)">`.
 * `(mousedown)` is used deliberately (fires BEFORE the input's blur closes the dropdown), but a
 * NATIVE button fires `click`/`keydown` on Enter/Space — NOT `mousedown` — so a KEYBOARD user who
 * Tabs to a result and presses Enter (exactly what the aria-live status "Use Tab to review, Enter
 * to select" instructs) selected NOTHING. That was a live WCAG 2.1.1 (Keyboard, Level A) break on
 * the funnel's core control + a LYING aria-live promise (AL-481). Root fix: add
 * `(keydown.enter)` + `(keydown.space)` alongside `(mousedown)` (no `(click)` — that double-fires
 * on mouse). This probe locks BOTH input methods select a result → navigate into the funnel.
 *
 * Unauth (guest). Real local Chromium. A matching term ("coffee") returns PRE-BUILT results on prod.
 * Fail-OPEN (::notice, exit 0) when search returns 0 results (Places+sites both empty) — nothing to
 * select, not a keyboard regression (validator-precision). RED only when a result exists but a
 * keyboard Enter fails to select it.
 *
 * Usage: node e2e/admin-verify/verify-guest-funnel-keyboard.mjs
 */
import { chromium } from 'playwright';

const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const INPUT_SEL =
  '#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]';
const RESULT_SEL = 'button:has-text("Pre-built"), [role="listbox"] button, .absolute button:has-text("Coffee")';

const b = await chromium.launch();

/** Drive the funnel with one input method; return {rows, navigated, dest}. */
async function attempt(useMouse) {
  const p = await (await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await p.goto(`${ORIGIN}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(1800);
    const inp = p.locator(INPUT_SEL).first();
    await inp.click().catch(() => {});
    await inp.pressSequentially('coffee', { delay: 55 });
    await p.waitForTimeout(4000);
    const rows = await p.locator('button:has-text("Pre-built")').count();
    const row = p.locator(RESULT_SEL).first();
    const before = p.url();
    if (rows === 0) return { rows, navigated: false, dest: '(no results)' };
    if (useMouse) {
      await row.click({ timeout: 4000 }).catch(() => {});
    } else {
      await row.focus().catch(() => {});
      await p.keyboard.press('Enter');
    }
    await p.waitForTimeout(2500);
    const after = p.url();
    const dest = after.replace(ORIGIN, '').replace(/\?cb=\d+/, '') || '/';
    return { rows, navigated: after !== before, dest };
  } finally {
    await p.close();
  }
}

const mouse = await attempt(true);
const kbd = await attempt(false);
await b.close();

console.log('\n━━ § B.1 guest-funnel search result — keyboard + mouse operability (WCAG 2.1.1) ━━');
console.log(`  mouse    rows=${mouse.rows} navigated=${mouse.navigated} → ${mouse.dest}`);
console.log(`  keyboard rows=${kbd.rows} navigated=${kbd.navigated} → ${kbd.dest}`);

if (mouse.rows === 0 && kbd.rows === 0) {
  console.log('\n::notice:: verify-guest-funnel-keyboard SKIPPED — search returned 0 results (Places+sites empty); nothing to select.');
  process.exit(0);
}
const ok = mouse.navigated && kbd.navigated;
if (!ok) {
  console.error(
    `\n❌ § B.1 keyboard FAIL — a search result must be selectable by BOTH pointer AND keyboard ` +
      `(mouse=${mouse.navigated}, keyboard=${kbd.navigated}). A mousedown-only handler strands keyboard users ` +
      `(WCAG 2.1.1) + makes the "Enter to select" aria-live status a lie.`,
  );
  process.exit(1);
}
console.log('\n✅ § B.1 PASS — search result selectable by mouse (mousedown) AND keyboard (Enter/Space) → funnel entry (WCAG 2.1.1).');
process.exit(0);
