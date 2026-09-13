// verify-create-wizard.mjs — B.1 (deeper): the /create WIZARD STEP-PROGRESSION a prospect walks
// AFTER funnel entry. verify-guest-funnel.mjs proves the funnel gets a guest TO /create and that the
// wizard RENDERS — but it stops there. A dead step control, a step that won't advance, or a broken
// terminal "Create site" would strand a prospect MID-WIZARD (past entry), invisible to a render-only
// check. This drives the real 3-step walk (1 Business → 2 Details → 3 Brand assets → Create site) as
// an UNAUTH guest, headless on PROD, asserting each step is reachable + the terminal routes to the
// sign-in bridge (the conversion point). No site is created (a guest "Create site" gates to /signin).
//
// LOCAL Chromium (the /create SPA serves with no CF challenge). Fail-open on the Places-degraded bits
// (address autocomplete 403s on prod — not a wizard defect). Usage: node e2e/admin-verify/verify-create-wizard.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /analytics|posthog|ingest|cf-|challenge|beacon|gtm|doubleclick|sentry|clarity|hotjar|places|maps|Failed to load resource.*(analytics|ingest|posthog|maps|places)/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 110)); });
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errs.push('pageerror: ' + String(e).slice(0, 110)); });

const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

/** Read the wizard's current step: the ACTIVE step-circle number + the section eyebrow heading. */
const readStep = () => page.evaluate(() => {
  // Active step circle: aria-current, or an active/selected class, or the cyan-filled circle.
  const circles = [...document.querySelectorAll('button, [role="tab"], [class*="step" i]')]
    .map((e) => (e.textContent || '').trim()).filter((t) => /^[123]\b|^[123]$/.test(t));
  const active = document.querySelector('[aria-current="step"], [aria-current="true"], [aria-selected="true"], .step-active, [class*="active" i][class*="step" i]');
  const eyebrow = [...document.querySelectorAll('p,span,div,h2,h3')]
    .map((e) => (e.textContent || '').trim())
    .find((t) => /^(business information|details|additional details|brand assets|brand & assets|your details)/i.test(t)) || '';
  return { activeText: (active?.textContent || '').trim().slice(0, 20), eyebrow: eyebrow.slice(0, 40), circles: circles.slice(0, 3) };
});

/** Click a step control by its visible label (the "2 Details" / "3 Brand assets" tab). */
async function gotoStep(labelRe) {
  const tab = page.locator('button, [role="tab"]').filter({ hasText: labelRe }).first();
  if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(900); return true; }
  return false;
}

try {
  await page.goto(`${ORIGIN}/create`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2800);

  // STEP 1 — Business: the required fields render + are fillable.
  const nameInput = page.locator('input[placeholder*="Vito" i], input[placeholder*="business name" i]').first();
  const addrInput = page.locator('input[placeholder*="Beverwyck" i], input[placeholder*="address" i]').first();
  const step1Ok = (await nameInput.count()) > 0 && (await addrInput.count()) > 0;
  check('step 1 (Business) renders required Name + Address', step1Ok, step1Ok ? 'name + address present' : 'missing step-1 inputs');
  if (step1Ok) {
    await nameInput.fill('Aurora Test Bakery').catch(() => {});
    await addrInput.fill('123 Main St, Austin, TX 78701').catch(() => {});
    await page.waitForTimeout(400);
  }
  const s1 = await readStep();

  // ADVANCE → STEP 2 (Details). Click the "2 Details" step control; assert the step actually changed.
  const wentToDetails = await gotoStep(/details/i);
  const s2 = await readStep();
  const onStep2 = /details/i.test(s2.eyebrow) || /details/i.test(s2.activeText) || s2.eyebrow !== s1.eyebrow;
  check('advances to step 2 (Details) via the step control', wentToDetails && onStep2,
    `clicked=${wentToDetails} eyebrow="${s2.eyebrow}" active="${s2.activeText}"`);

  // ADVANCE → STEP 3 (Brand assets).
  const wentToBrand = await gotoStep(/brand|assets/i);
  const s3 = await readStep();
  const onStep3 = /brand|assets/i.test(s3.eyebrow) || /brand|assets/i.test(s3.activeText) || (wentToBrand && s3.eyebrow !== s2.eyebrow);
  check('advances to step 3 (Brand assets) via the step control', wentToBrand && onStep3,
    `clicked=${wentToBrand} eyebrow="${s3.eyebrow}" active="${s3.activeText}"`);

  // TERMINAL — "Create site" is present + enabled (the wizard's conversion action).
  const createBtn = page.locator('button', { hasText: /^create site$|create (my )?site|build (my )?site/i }).first();
  const createVisible = await createBtn.isVisible().catch(() => false);
  const createEnabled = createVisible && !(await createBtn.isDisabled().catch(() => true));
  check('terminal "Create site" button present + enabled', createEnabled,
    createVisible ? (createEnabled ? 'present + enabled' : 'present but DISABLED') : 'NO Create-site button');

  // GUEST CONVERSION BRIDGE — clicking "Create site" UNAUTH must route to the sign-in bridge
  // (NOT silently fail / not create a site). This is the funnel's terminal conversion point.
  if (createEnabled) {
    await createBtn.click().catch(() => {});
    await page.waitForTimeout(2500);
    const dest = await page.evaluate(() => ({ url: location.pathname + location.search, body: (document.body.innerText || '').slice(0, 400) }));
    const bridged = /\/signin|\/sign-in|\/login/.test(dest.url) || /sign in|sign up|create an account|log in/i.test(dest.body);
    check('guest "Create site" bridges to sign-in (conversion terminal, no silent dead-end)', bridged,
      `dest="${dest.url}"${bridged ? '' : ' (no sign-in bridge — prospect stranded at the finish line)'}`);
  }

  check('0 console errors across the wizard walk', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');
} catch (e) {
  check('wizard walk completed', false, 'error: ' + String(e).slice(0, 110));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(52)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} /create-wizard break(s) (a prospect can't complete the wizard → lost conversion).`
    : `\nVERDICT: ✅ PASS — /create wizard walkable end-to-end (step 1→2→3 → Create site → sign-in bridge), 0 console errors.`,
);
process.exit(fails ? 1 : 0);
