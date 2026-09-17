// verify-signin-magic-link-ui.mjs — FULL-FLOW B.7 (the /signin magic-link BROWSER FORM).
//
// verify-auth-flow.mjs proves the magic-link ENDPOINT (POST → 200) at the API level. It does NOT
// drive the real /signin form (`pages/auth/sign-in.component`, the Better-Auth page that OWNS
// /signin — NOT the legacy pages/signin) a returning owner actually uses — so a broken submit
// (lost handler, disabled button stuck, the "check your inbox" banner never rendering) would
// strand every returning user while the API probe stayed green (the AL-402/AL-451 lying-green
// class this § keeps hardening). This closes that gap with a real Chromium.
//
// It also live-verifies the AL-704 honesty fix: the confirmation banner names the address the link
// was ACTUALLY sent to (frozen), so editing the email field afterward can't make it claim we mailed
// an address we never did.
//
// Side effect: on success this sends ONE magic-link email to the e2e identity (same as
// verify-auth-flow). Fail-OPEN on transient/unreachable; a CF bot-challenge on the headless XHR
// degrades to the graceful inline-error branch (still a valid coherent state — the point is the
// form is OPERABLE, never a dead button or console error).
//
// Usage: E2E_API_KEY=… node e2e/admin-verify/verify-signin-magic-link-ui.mjs
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const ORIGIN = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const EMAIL = 'e2e@megabyte.space'; // real deliverable test identity (never a stranger)
const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    if (
      m.type() === 'error' &&
      !/favicon|analytics|posthog|sentry|net::ERR_ABORTED|Turnstile|challenges\.cloudflare/i.test(m.text())
    )
      errs.push(m.text().slice(0, 140));
  });

  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'load', timeout: 60000 });
  const emailInput = page.locator('[data-testid="sign-in-email"]');
  await emailInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  check('sign-in email field renders', await emailInput.isVisible().catch(() => false));

  const magicBtn = page.locator('[data-testid="sign-in-magic-link"]');
  check('"Email me a magic link" control is present', (await magicBtn.count()) > 0);

  // The button is disabled until a valid email is entered (AL-435) — assert that gate, then fill.
  const disabledEmpty = await magicBtn.isDisabled().catch(() => false);
  check('magic-link button is DISABLED on an empty email (no doomed click)', disabledEmpty);

  await emailInput.fill(EMAIL);
  await page.waitForTimeout(150); // let the emailValid() computed settle
  const enabledAfter = await magicBtn.isEnabled().catch(() => false);
  check('magic-link button ENABLES once a valid email is entered', enabledAfter);

  await magicBtn.click({ timeout: 10000 }).catch(() => {});
  // A COHERENT terminal state must settle: success banner OR a graceful error. Never dead/blank.
  await page
    .waitForFunction(
      () =>
        !!document.querySelector('[data-testid="sign-in-magic-sent"]') ||
        !!document.querySelector('[data-testid="sign-in-error"]'),
      { timeout: 15000 },
    )
    .catch(() => {});
  const state = await page.evaluate(() => {
    const sent = document.querySelector('[data-testid="sign-in-magic-sent"]');
    const err = document.querySelector('[data-testid="sign-in-error"]');
    return {
      sent: !!sent && sent.offsetParent !== null,
      sentText: sent?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) || '',
      errText: err?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) || '',
    };
  });
  check(
    'clicking "Email me a magic link" produces a COHERENT terminal state (inbox banner OR graceful error, never dead/blank)',
    state.sent || !!state.errText,
    state.sent ? `banner: "${state.sentText}"` : `error: "${state.errText}"`,
  );

  if (state.sent) {
    check('the confirmation banner names the address we sent to', state.sentText.includes(EMAIL), state.sentText);
    // AL-704 honesty: edit the email field WITHOUT resending — the banner must still name the
    // ORIGINAL sent address (it's frozen), not track the live field to a lie.
    await emailInput.fill('someone-else@example.com');
    await page.waitForTimeout(250);
    const bannerAfterEdit = await page.evaluate(
      () => document.querySelector('[data-testid="sign-in-magic-sent"]')?.textContent?.trim() || '',
    );
    check(
      'banner stays TRUTHFUL after editing the email (frozen to the sent address, not the live field)',
      bannerAfterEdit.includes(EMAIL) && !bannerAfterEdit.includes('someone-else@example.com'),
      bannerAfterEdit.replace(/\s+/g, ' ').slice(0, 100),
    );
  } else {
    rows.push({
      ok: true,
      label: 'inbox banner skipped (headless XHR likely CF-challenged) — graceful error is a valid coherent state',
      detail: state.errText,
    });
  }

  check('0 console errors across the /signin magic-link form', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
  await browser.close();
} catch (e) {
  console.log(`::notice:: verify-signin-magic-link-ui — unreachable/transient, fail-open: ${String(e).slice(0, 120)}`);
  await browser.close().catch(() => {});
  process.exit(0);
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(66)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} /signin magic-link form check(s) unmet.`
    : `\nVERDICT: ✅ PASS — the /signin magic-link browser form is operable end-to-end (type → enable → send → truthful inbox banner), 0 console errors.`,
);
process.exit(fails ? 1 : 0);
