// verify-signup-flow.mjs — the COMPLETE guest sign-UP journey, the highest-value flow that was
// routed (app.routes.ts `auth/sign-up`) but UNPROBED. Proves the real user path AROUND the golden
// path: land on /signin → click "Create an account" → /auth/sign-up renders → password-based
// registration form validates live → password show/hide toggle works → back-link returns to sign-in.
//
// Nine gates, one real Chromium session (SPA shell — no CF challenge locally, so this runs
// fail-open with NO creds; /signin + /auth/sign-up are public):
//   1. /signin exposes the "Create an account" cross-link (sign-in-to-sign-up)
//   2. clicking it client-navigates to /auth/sign-up (no full reload) and mounts sign-up-page
//   3. the page renders its contract: H1 "Create your account" + name/email/password + submit
//      + Google/GitHub OAuth + back-link + the new password-visibility toggle
//   4. submit is GATED closed until name + valid email + 8-char password are all present
//   5. a bad email surfaces "Enter a valid email address." on blur
//   6. a <8-char password surfaces "Use at least 8 characters." on blur
//   7. the password toggle flips the input type password↔text (+ aria-label/aria-pressed)
//   8. the sign-up surface is axe-clean (WCAG 2.2 critical/serious == 0)
//   9. the back-link (sign-up-to-sign-in) returns the user to /signin (auth/sign-in → /signin)
// Plus a standing console-error gate across the whole journey (0 genuine JS/CSP errors).
//
// Usage: node e2e/admin-verify/verify-signup-flow.mjs   (ORIGIN overrides the default prod host)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const { default: AxeBuilder } = req('@axe-core/playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Genuine app errors only — drop third-party/analytics network noise the auth page can't control.
const BENIGN = /ResizeObserver|posthog|sentry|\/ingest|analytics|favicon|Failed to load resource.*\b(4\d\d|5\d\d)\b.*(analytics|ingest|beacon)/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !BENIGN.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => { const t = String(e); if (!BENIGN.test(t)) consoleErrors.push(t); });

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };
const sel = (id) => `[data-testid="${id}"]`;

try {
  // ── 1. /signin exposes the cross-link ────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(sel('sign-in-page'), { timeout: 30000 });
  const crossLink = page.locator(sel('sign-in-to-sign-up'));
  check('/signin exposes "Create an account" cross-link', (await crossLink.count()) > 0);

  // ── 2. click → client-nav to /auth/sign-up (no full reload) ──────────────────────────
  await page.evaluate(() => window.__ps_nav_marker = 'alive'); // survives SPA nav, dies on full reload
  await crossLink.first().click();
  await page.waitForURL('**/auth/sign-up', { timeout: 20000 });
  await page.waitForSelector(sel('sign-up-page'), { timeout: 20000 });
  const spaAlive = await page.evaluate(() => window.__ps_nav_marker === 'alive');
  check('cross-link client-navigates to /auth/sign-up (SPA, no reload)', spaAlive, `url=${new URL(page.url()).pathname}`);

  // ── 3. the sign-up page renders its full contract ────────────────────────────────────
  const contract = await page.evaluate(() => {
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const h1 = document.querySelector('#sign-up-heading');
    return {
      h1: h1 ? (h1.textContent || '').trim() : null,
      name: !!q('sign-up-name'),
      email: !!q('sign-up-email'),
      password: !!q('sign-up-password'),
      toggle: !!q('sign-up-password-toggle'),
      submit: !!q('sign-up-submit'),
      google: !!q('sign-up-google'),
      github: !!q('sign-up-github'),
      back: !!q('sign-up-to-sign-in'),
    };
  });
  check('H1 reads "Create your account"', contract.h1 === 'Create your account', `h1="${contract.h1}"`);
  check('renders name + email + password + submit',
    contract.name && contract.email && contract.password && contract.submit,
    JSON.stringify({ name: contract.name, email: contract.email, password: contract.password, submit: contract.submit }));
  check('renders Google + GitHub OAuth + back-link', contract.google && contract.github && contract.back,
    JSON.stringify({ google: contract.google, github: contract.github, back: contract.back }));

  // ── 4. submit gated closed until all fields valid ────────────────────────────────────
  check('submit disabled on empty form', await page.locator(sel('sign-up-submit')).isDisabled());

  // ── 5. bad email → error copy on blur ────────────────────────────────────────────────
  await page.fill(sel('sign-up-email'), 'notanemail');
  await page.locator(sel('sign-up-email')).blur();
  await page.waitForTimeout(150);
  const emailErr = await page.locator(sel('sign-up-email-error')).count();
  const emailErrText = emailErr ? (await page.locator(sel('sign-up-email-error')).innerText()).trim() : '';
  check('bad email surfaces "Enter a valid email address."', emailErrText === 'Enter a valid email address.', `text="${emailErrText}"`);

  // ── 6. short password → error copy on blur ───────────────────────────────────────────
  await page.fill(sel('sign-up-password'), 'short');
  await page.locator(sel('sign-up-password')).blur();
  await page.waitForTimeout(150);
  const pwErrText = (await page.locator(sel('sign-up-password-error')).count())
    ? (await page.locator(sel('sign-up-password-error')).innerText()).trim() : '';
  check('short password surfaces "Use at least 8 characters."', pwErrText === 'Use at least 8 characters.', `text="${pwErrText}"`);
  // still gated after invalid input
  check('submit still disabled while email invalid + password short', await page.locator(sel('sign-up-submit')).isDisabled());

  // valid input → submit opens
  await page.fill(sel('sign-up-name'), 'Jane Doe');
  await page.fill(sel('sign-up-email'), 'jane@example.com');
  await page.fill(sel('sign-up-password'), 'longenough1');
  await page.waitForTimeout(150);
  check('submit enables once name + valid email + 8-char password present', !(await page.locator(sel('sign-up-submit')).isDisabled()));

  // ── 7. password visibility toggle ────────────────────────────────────────────────────
  const typeBefore = await page.locator(sel('sign-up-password')).getAttribute('type');
  await page.locator(sel('sign-up-password-toggle')).click();
  await page.waitForTimeout(80);
  const typeShown = await page.locator(sel('sign-up-password')).getAttribute('type');
  const ariaShown = await page.locator(sel('sign-up-password-toggle')).getAttribute('aria-label');
  await page.locator(sel('sign-up-password-toggle')).click();
  await page.waitForTimeout(80);
  const typeHidden = await page.locator(sel('sign-up-password')).getAttribute('type');
  check('password toggle flips password→text→password (+ aria)',
    typeBefore === 'password' && typeShown === 'text' && typeHidden === 'password' && ariaShown === 'Hide password',
    `before=${typeBefore} shown=${typeShown} hidden=${typeHidden} aria="${ariaShown}"`);

  // capture a receipt of the rendered sign-up surface
  await page.screenshot({ path: resolve(__dirname, '_signup-flow.png') }).catch(() => {});

  // ── 8. axe-clean (WCAG 2.2 critical/serious) ─────────────────────────────────────────
  try {
    const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
    const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const serious = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    check('sign-up surface is axe-clean (WCAG critical/serious == 0)', serious.length === 0,
      serious.map((v) => `${v.id}(${v.nodes.length})`).join(', ') || 'clean');
  } catch (e) {
    check('axe ran', false, 'axe error: ' + String(e).slice(0, 80));
  }

  // ── 9. back-link returns to /signin (auth/sign-in redirect) ──────────────────────────
  await page.locator(sel('sign-up-to-sign-in')).click();
  await page.waitForURL('**/signin', { timeout: 20000 }).catch(() => {});
  await page.waitForSelector(sel('sign-in-page'), { timeout: 20000 }).catch(() => {});
  check('back-link returns to /signin', new URL(page.url()).pathname === '/signin', `url=${new URL(page.url()).pathname}`);
} catch (e) {
  check('sign-up journey completed', false, 'error: ' + String(e).slice(0, 160));
}

// standing console-error gate across the whole journey
check('0 console/page errors across the journey', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(58)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} sign-up-flow gate(s) broke on ${ORIGIN}.`
    : `\nVERDICT: ✅ PASS — the complete guest sign-up journey (/signin → /auth/sign-up → validate → toggle → back) works, renders its contract, and is axe-clean on ${ORIGIN}.`,
);
process.exit(fails ? 1 : 0);
