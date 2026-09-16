#!/usr/bin/env node
/**
 * verify-signin-ux.mjs — the /signin CLIENT UX state machine, headless on PROD (§ B.7, FULL-FLOW).
 *
 * B.7's verify-auth-flow.mjs proves the auth MECHANICS (pure-HTTP: magic-link request/verify, OAuth
 * init/callback, /me, peek-seam-dark). But the sign-in PAGE a real prospect actually looks at — its
 * client-side state machine — was asserted only by LOCAL *.spec.ts against :4300, never rendered on
 * prod. This closes that gap: it loads the LIVE /signin (pages/auth/sign-in.component) in a real
 * browser and locks the behaviors an owner depends on:
 *
 *   1. autofocus         — the email field is focused on arrival (one fewer click; the busiest
 *                          pre-auth surface). document.activeElement === #signin-email.
 *   2. returnUrl context — /signin?returnUrl=/admin/billing shows "Sign in to continue to billing"
 *                          (AL-459 returnContext), so a bounced visitor knows WHY they landed here.
 *   3. generic subtitle  — bare /signin shows "manage your sites" (no false context).
 *   4. magic-link gating  — with no email the passwordless button is DISABLED and an inline hint
 *                          explains WHY + HOW to enable it (AL-435 — a disabled control can't tooltip,
 *                          so no silent dead-end). This is the exact state a screenshot reads as
 *                          "dim/greyed" — locked here so it can never silently un-disable OR lose
 *                          its explanatory hint on prod.
 *   5. disabled→enabled   — typing a VALID email enables the magic-link + clears the now-redundant
 *                          hint (the transition, previously unproven against prod).
 *   6. invalid-email guard — an invalid email leaves BOTH the submit + magic-link disabled.
 *   7. OAuth live         — Google + GitHub CTAs render full-opacity (contrasting the intentionally
 *                          dimmed disabled magic-link) with a real /api/auth/* href.
 *   8. hygiene            — 0 console errors; axe critical/serious (advisory unless PSVIS_AXE=1).
 *
 * /signin is a PUBLIC page (no auth, no email sent, no side effects) → this probe runs ALWAYS, with
 * NO E2E_API_KEY gate, so it guards the surface even in secret-less CI. Local Chromium (the public
 * marketing/auth shell is not CF-bot-challenged).
 *
 * Usage: node e2e/admin-verify/verify-signin-ux.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const errs = [];
let cur = 'boot';

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.type(),
      x = m.text();
    if (/Failed to load resource|net::ERR_ABORTED|favicon|status of 4|status of 5|\[PostHog\]/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(`[${cur}] ${x.slice(0, 90)}`);
  });
  page.on('pageerror', (e) => errs.push(`[${cur}][pageerror] ${(e.message || String(e)).slice(0, 90)}`));

  const EMAIL = '[data-testid="sign-in-email"]';
  const MAGIC = '[data-testid="sign-in-magic-link"]';
  const HINT = '[data-testid="sign-in-magic-hint"]';
  const SUBTITLE = '[data-testid="signin-subtitle"]';

  // ── 1. Contextual load: /signin?returnUrl=/admin/billing (a guard-bounced visitor) ──
  cur = 'returnurl-context';
  await page.goto(`${ORIGIN}/signin?returnUrl=%2Fadmin%2Fbilling`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(EMAIL, { timeout: 30000 });
  // afterNextRender autofocus fires after the first render — give it a beat, then check BEFORE any
  // interaction (typing/clicking would move focus and invalidate the autofocus assertion).
  await page.waitForTimeout(1000);
  const focusedId = await page.evaluate(() => document.activeElement?.id || '');
  check('email field is AUTOFOCUSED on arrival (one fewer click — value-add)', focusedId === 'signin-email', `activeElement=#${focusedId || '(none)'}`);

  const ctxSub = (await page.locator(SUBTITLE).textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  check('returnUrl context subtitle: "continue to billing" (AL-459)', /continue to/i.test(ctxSub) && /billing/i.test(ctxSub), `"${ctxSub.slice(0, 48)}"`);

  // ── 2. Bare /signin — generic subtitle + the magic-link DISABLED-with-reason state ──
  cur = 'bare-load';
  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(EMAIL, { timeout: 30000 });
  await page.waitForTimeout(600);

  const genericSub = (await page.locator(SUBTITLE).textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  check('generic subtitle when no returnUrl ("manage your sites")', /manage your sites/i.test(genericSub), `"${genericSub.slice(0, 48)}"`);

  const magicDisabledEmpty = await page.locator(MAGIC).isDisabled().catch(() => null);
  check('magic-link is DISABLED with no email entered (correct gate)', magicDisabledEmpty === true);
  const hintCountEmpty = await page.locator(HINT).count();
  check('inline hint explains the dimmed magic-link (AL-435 — no silent dead-end)', hintCountEmpty >= 1);

  // OAuth CTAs render full-opacity (contrasting the intentionally-dimmed disabled magic-link) + live href
  const oauth = await page.evaluate(() => {
    const g = document.querySelector('[data-testid="sign-in-google"]');
    const gh = document.querySelector('[data-testid="sign-in-github"]');
    const op = (el) => (el ? parseFloat(getComputedStyle(el).opacity) : 0);
    return {
      googleHref: g?.getAttribute('href') || '',
      googleOpacity: op(g),
      githubPresent: !!gh,
      githubHref: gh?.getAttribute('href') || '',
    };
  });
  check('Google OAuth CTA is live (→ /api/auth/google) + full-opacity', /\/api\/auth\/google/.test(oauth.googleHref) && oauth.googleOpacity >= 0.99, `op=${oauth.googleOpacity}`);
  check('GitHub OAuth CTA renders (live by default → /api/auth/github)', oauth.githubPresent && /\/api\/auth\/github/.test(oauth.githubHref));

  // ── 3. disabled→enabled transition: a VALID email enables magic-link + clears the hint ──
  cur = 'valid-email';
  await page.fill(EMAIL, 'owner@example.com');
  await page.waitForTimeout(400);
  const magicEnabled = await page.locator(MAGIC).isDisabled().catch(() => null);
  check('a VALID email ENABLES the magic-link (disabled→enabled transition)', magicEnabled === false);
  const hintCountValid = await page.locator(HINT).count();
  check('the now-redundant hint CLEARS once the email is valid', hintCountValid === 0, `${hintCountValid} hint(s)`);

  // ── 4. invalid-email guard: submit AND magic-link both stay disabled ──
  cur = 'invalid-email';
  await page.fill(EMAIL, 'not-an-email');
  await page.waitForTimeout(400);
  const submitDisabledInvalid = await page.locator('[data-testid="sign-in-submit"]').isDisabled().catch(() => null);
  const magicDisabledInvalid = await page.locator(MAGIC).isDisabled().catch(() => null);
  check('an INVALID email keeps submit + magic-link disabled (client gate holds)', submitDisabledInvalid === true && magicDisabledInvalid === true);

  check('0 console errors across the /signin UX flow', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ── 5. axe critical/serious (advisory unless PSVIS_AXE=1) ──
  cur = 'axe';
  try {
    const { default: AxeBuilder } = req('@axe-core/playwright');
    const axe = await new AxeBuilder({ page }).options({ resultTypes: ['violations'] }).analyze();
    const bad = axe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const strict = process.env.PSVIS_AXE === '1';
    check(
      `axe: 0 critical/serious violations${strict ? '' : ' (advisory)'}`,
      strict ? bad.length === 0 : true,
      bad.length ? bad.map((v) => v.id).slice(0, 4).join(',') : 'clean',
    );
  } catch (e) {
    rows.push(`  · axe scan skipped — ${String(e.message || e).slice(0, 50)}`);
  }

  await page.screenshot({ path: `${__dirname}/_signin-ux.png` }).catch(() => {});
} catch (e) {
  check('signin-ux probe completes without throwing', false, `[${cur}] ${String(e.message || e).slice(0, 100)}`);
} finally {
  await browser.close();
}

console.log('\n━━ § B.7 /signin CLIENT UX state machine (autofocus · returnUrl context · magic-link gating · OAuth) ━━');
rows.forEach((r) => console.log(r));
const ok = fails === 0;
console.log(
  ok
    ? '\n✓ SIGNIN UX PASS — the sign-in page state machine renders + behaves correctly on prod (autofocus, contextual subtitle, disabled→enabled magic-link, OAuth live), 0 console errors.'
    : `\n🔴 SIGNIN UX FAIL — ${fails} break(s) in the /signin client UX surface.`,
);
process.exit(ok ? 0 : 1);
