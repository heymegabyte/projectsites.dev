// verify-signin-flow.mjs — the COMPLETE guest sign-IN journey, the sibling of verify-signup-flow.mjs
// and the closure of the "add WIRED-SUBMIT discipline to the sign-in + magic-link probes" Next. /signin
// (sign-in-page) is the live auth sign-in component: email+password submit + magic-link + Google/GitHub
// OAuth + a cross-link to sign-up. Steps 4-6 of the signup probe proved a button ENABLES; nothing proved
// a sign-in button SUBMITS to the right endpoint — a dead/wrong-wired sign-in (the ContactForm-wrong-
// endpoint class: enabled but posts nowhere / to a 404) would pass every render gate while login is
// silently broken.
//
// Nine gates, one real Chromium session (SPA shell — /signin is public, no CF challenge locally, so this
// runs fail-open with NO creds):
//   1. /signin renders its contract: H1 "Welcome back" + email/password/submit + password toggle +
//      Google/GitHub OAuth + "Email me a magic link" + the cross-link to sign-up
//   2. submit is GATED closed on the empty form
//   3. the password toggle flips the input password↔text (+ aria-label)
//   4. submit ENABLES once a valid email + 8-char password are present; magic-link ENABLES on a valid email
//   5. the sign-in surface is axe-clean (WCAG 2.2 critical/serious == 0)
//   6. WIRED SUBMIT (password) — "Sign in" actually POSTs to POST /api/auth/sign-in/email with the typed
//      email (intercepted + fulfilled 401 so NO real session is created); catches a dead/wrong-endpoint button
//   7. WIRED SUBMIT (magic-link) — "Email me a magic link" actually POSTs to POST /api/auth/sign-in/magic-link
//      with the typed email (intercepted + fulfilled 200); catches a dead magic-link button
//   8. the cross-link client-navigates to /auth/sign-up (SPA, no reload)
//   9. 0 console/page errors across the whole journey (the two intercepted auth endpoints are scoped out)
//
// Usage: node e2e/admin-verify/verify-signin-flow.mjs   (ORIGIN overrides the default prod host)
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

// Genuine app errors only — drop third-party/analytics noise + the probe's OWN intercepted auth
// endpoints (fulfilled 401/200 by design → the browser logs them as resource errors; probe test noise,
// never a site defect, scoped out by URL).
const BENIGN = /ResizeObserver|posthog|sentry|\/ingest|analytics|favicon|Failed to load resource.*\b(4\d\d|5\d\d)\b.*(analytics|ingest|beacon)/i;
const PROBE_EP = /\/api\/auth\/sign-in\/(email|magic-link)/;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (BENIGN.test(m.text()) || PROBE_EP.test(m.location()?.url || '')) return;
  consoleErrors.push(m.text());
});
page.on('pageerror', (e) => { const t = String(e); if (!BENIGN.test(t)) consoleErrors.push(t); });

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };
const sel = (id) => `[data-testid="${id}"]`;

try {
  // ── 1. /signin renders its contract ──────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(sel('sign-in-page'), { timeout: 30000 });
  const contract = await page.evaluate(() => {
    const q = (id) => !!document.querySelector(`[data-testid="${id}"]`);
    const h1 = document.querySelector('h1')?.textContent?.trim() || null;
    return {
      h1,
      email: q('sign-in-email'),
      password: q('sign-in-password'),
      toggle: q('sign-in-password-toggle'),
      submit: q('sign-in-submit'),
      google: q('sign-in-google'),
      github: q('sign-in-github'),
      magic: q('sign-in-magic-link'),
      crossLink: q('sign-in-to-sign-up'),
    };
  });
  check('H1 reads "Welcome back"', contract.h1 === 'Welcome back', `h1="${contract.h1}"`);
  check('renders email + password + submit + password toggle',
    contract.email && contract.password && contract.submit && contract.toggle,
    JSON.stringify(contract));
  check('renders Google + GitHub OAuth + magic-link + cross-link',
    contract.google && contract.github && contract.magic && contract.crossLink,
    JSON.stringify({ google: contract.google, github: contract.github, magic: contract.magic, crossLink: contract.crossLink }));

  // ── 2. submit gated closed on the empty form ─────────────────────────────────────────
  check('submit disabled on empty form', await page.locator(sel('sign-in-submit')).isDisabled());
  check('magic-link disabled on empty form', await page.locator(sel('sign-in-magic-link')).isDisabled());

  // ── 3. password visibility toggle ────────────────────────────────────────────────────
  await page.fill(sel('sign-in-password'), 'secretpw123');
  const typeBefore = await page.locator(sel('sign-in-password')).getAttribute('type');
  await page.locator(sel('sign-in-password-toggle')).click();
  await page.waitForTimeout(80);
  const typeShown = await page.locator(sel('sign-in-password')).getAttribute('type');
  await page.locator(sel('sign-in-password-toggle')).click();
  await page.waitForTimeout(80);
  const typeHidden = await page.locator(sel('sign-in-password')).getAttribute('type');
  check('password toggle flips password→text→password',
    typeBefore === 'password' && typeShown === 'text' && typeHidden === 'password',
    `before=${typeBefore} shown=${typeShown} hidden=${typeHidden}`);

  // ── 4. submit + magic-link ENABLE on valid input ─────────────────────────────────────
  await page.fill(sel('sign-in-email'), 'valid@example.com');
  await page.fill(sel('sign-in-password'), 'longenough1');
  await page.waitForTimeout(150);
  check('submit enables once valid email + password present', !(await page.locator(sel('sign-in-submit')).isDisabled()));
  check('magic-link enables once a valid email is present', !(await page.locator(sel('sign-in-magic-link')).isDisabled()));

  // capture a receipt of the rendered sign-in surface
  await page.screenshot({ path: resolve(__dirname, '_signin-flow.png') }).catch(() => {});

  // ── 5. axe-clean (WCAG 2.2 critical/serious) ─────────────────────────────────────────
  try {
    const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
    const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const serious = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    check('sign-in surface is axe-clean (WCAG critical/serious == 0)', serious.length === 0,
      serious.map((v) => `${v.id}(${v.nodes.length})`).join(', ') || 'clean');
  } catch (e) {
    check('axe ran', false, 'axe error: ' + String(e).slice(0, 80));
  }

  // ── 6. WIRED SUBMIT (password) → POST /api/auth/sign-in/email ─────────────────────────
  let pwPost = null;
  await page.route('**/api/auth/sign-in/email', async (route) => {
    const rq = route.request();
    pwPost = { url: rq.url(), method: rq.method(), body: rq.postData() || '' };
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'probe: intercepted — no session' }) });
  });
  await page.fill(sel('sign-in-email'), 'signin-wired-probe@example.com');
  await page.fill(sel('sign-in-password'), 'longenough1');
  await page.waitForTimeout(120);
  await page.locator(sel('sign-in-submit')).click();
  await page.waitForTimeout(900);
  check('Sign in SUBMITS to POST /api/auth/sign-in/email (wired, typed email present)',
    !!pwPost && pwPost.method === 'POST' &&
      /\/api\/auth\/sign-in\/email$/.test(new URL(pwPost.url).pathname) &&
      /signin-wired-probe@example\.com/.test(pwPost.body),
    pwPost ? `${pwPost.method} ${new URL(pwPost.url).pathname}` : 'no POST fired');
  await page.unroute('**/api/auth/sign-in/email').catch(() => {});

  // ── 7. WIRED SUBMIT (magic-link) → POST /api/auth/sign-in/magic-link ──────────────────
  let magicPost = null;
  await page.route('**/api/auth/sign-in/magic-link', async (route) => {
    const rq = route.request();
    magicPost = { url: rq.url(), method: rq.method(), body: rq.postData() || '' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: true }) });
  });
  await page.fill(sel('sign-in-email'), 'magic-wired-probe@example.com');
  await page.waitForTimeout(120);
  await page.locator(sel('sign-in-magic-link')).click();
  await page.waitForTimeout(900);
  check('Magic-link SUBMITS to POST /api/auth/sign-in/magic-link (wired, typed email present)',
    !!magicPost && magicPost.method === 'POST' &&
      /\/api\/auth\/sign-in\/magic-link$/.test(new URL(magicPost.url).pathname) &&
      /magic-wired-probe@example\.com/.test(magicPost.body),
    magicPost ? `${magicPost.method} ${new URL(magicPost.url).pathname}` : 'no POST fired');
  await page.unroute('**/api/auth/sign-in/magic-link').catch(() => {});

  // ── 8. cross-link → /auth/sign-up (SPA, no reload) ───────────────────────────────────
  await page.evaluate(() => (window.__ps_nav_marker = 'alive'));
  await page.locator(sel('sign-in-to-sign-up')).click();
  await page.waitForURL('**/auth/sign-up', { timeout: 20000 }).catch(() => {});
  const spaAlive = await page.evaluate(() => window.__ps_nav_marker === 'alive');
  check('cross-link client-navigates to /auth/sign-up (SPA, no reload)',
    spaAlive && /\/auth\/sign-up/.test(page.url()), `url=${new URL(page.url()).pathname}`);
} catch (e) {
  check('sign-in journey completed', false, 'error: ' + String(e).slice(0, 160));
}

// standing console-error gate across the whole journey
check('0 console/page errors across the journey', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(60)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} sign-in-flow gate(s) broke on ${ORIGIN}.`
    : `\nVERDICT: ✅ PASS — the complete guest sign-in journey (/signin → validate → toggle → BOTH submits wired → cross-link) works, renders its contract, and is axe-clean on ${ORIGIN}.`,
);
process.exit(fails ? 1 : 0);
