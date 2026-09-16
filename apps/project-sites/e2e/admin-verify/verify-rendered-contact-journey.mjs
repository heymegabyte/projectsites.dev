#!/usr/bin/env node
/**
 * verify-rendered-contact-journey.mjs — the REAL visitor contact journey through the
 * RENDERED generated-site form (app.js hijack → POST /api/contact-form/:slug), which
 * `verify-forms-causal.mjs` does NOT exercise (it scripts the OTHER ingest endpoint
 * /api/v1/forms/submit). Homepage-first, navigate by CLICKS only:
 *   subdomain home → click "Contact" → fill name/email/message → click Send →
 *   assert app.js success UI ("Thanks! …") + the POST /api/contact-form/<slug> → 200
 *   + 0 console errors.
 *
 * Generated-site subdomains are CF-clean for headless (public, crawlable) — no
 * Browserbase needed; runs on LOCAL chromium (free). The owner-visible reconcile
 * (form_submissions ground-truth) is a SEPARATE D1 step (per verify-against-source-of-truth:
 * the handler's form_submissions mirror is BEST-EFFORT, so a 200 is not proof the row
 * the owner's /admin/forms reads actually landed — the D1 count is). This probe prints
 * JOURNEY_RESULT {email,...} so the caller can `SELECT … WHERE email = <that>`.
 *
 * TARGET = a loop-DELIVERED test site (default zingermans-ann-arbor-2), never a customer
 * site — form_submissions has no DELETE endpoint, so the journey row persists. Override
 * with SLUG=<slug>. `node e2e/admin-verify/verify-rendered-contact-journey.mjs`.
 */
import { chromium } from 'playwright';

const SLUG = process.env.SLUG || 'zingermans-ann-arbor-2';
const BASE = `https://${SLUG}.projectsites.dev`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const EMAIL = `journey-contact-${Date.now()}@example.com`;
const NAME = 'Journey Contact Probe';
const MESSAGE = 'End-to-end rendered-form journey — a real visitor submission through app.js to /api/contact-form.';

const browser = await chromium.launch();
const out = { slug: SLUG, email: EMAIL };
const errs = [];
let postStatus = 0;
let cur = 'boot';
try {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.type(), x = m.text();
    if (/Failed to load resource|net::ERR_ABORTED/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(`[${cur}] ${x.slice(0, 120)}`);
  });
  page.on('pageerror', (e) => errs.push(`[${cur}][pageerror] ${(e.message || String(e)).slice(0, 120)}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/contact-form/')) postStatus = r.status();
  });

  // ── 1. Land on the subdomain home (the visitor's entry) ──
  cur = 'home';
  const resp = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  out.homeStatus = resp?.status();
  await page.waitForTimeout(2000);

  // ── 2. Navigate to Contact by CLICK (no goto) — SPA nav; app.js's capture-phase
  //       document listener still hijacks the late-rendered form. ──
  cur = 'nav-contact';
  const contactLink = page.locator('a[href="/contact"], a[href$="/contact"], nav a', { hasText: /contact/i }).first();
  if (await contactLink.count()) {
    await contactLink.click();
    await page.waitForTimeout(1800);
    out.nav = 'clicked Contact';
  } else {
    // Fallback: single-page site — scroll to the contact section on home.
    await page.evaluate(() => document.querySelector('#contact, [id*="contact"]')?.scrollIntoView());
    out.nav = 'scrolled to #contact (no nav link)';
  }

  // ── 3. Fill the RENDERED form via real typing ──
  cur = 'fill';
  const form = page.locator('form').filter({ has: page.locator('textarea') }).first();
  await form.waitFor({ state: 'visible', timeout: 8000 });
  const nameInput = form.locator('#contact-name, input[name="name"], input[name="fullName"], input[type="text"]').first();
  const emailInput = form.locator('#contact-email, input[type="email"], input[name="email"]').first();
  const messageInput = form.locator('#contact-message, textarea').first();
  if (await nameInput.count()) await nameInput.fill(NAME);
  await emailInput.fill(EMAIL);
  await messageInput.fill(MESSAGE);

  // ── 4. Submit by CLICK ──
  cur = 'submit';
  const submitBtn = form.locator('#contact-submit-btn, button[type="submit"], button', { hasText: /send|submit|message/i }).first();
  await submitBtn.click();

  // ── 5. Assert the app.js success UI + the POST result ──
  cur = 'verify';
  const status = form.locator('#contact-msg, [data-ps-status], .form-status, [role="status"]').first();
  let successText = '';
  // app.js sets "Sending…" FIRST, then swaps to the final "Thanks! Your message has
  // been sent." only after the POST resolves — poll for the FINAL state, never the
  // transient (reading too early captures "Sending…" and false-🔴 a healthy submit).
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const t = (await status.innerText().catch(() => '')).trim();
    if (t) successText = t;
    if (/thank|sent|received|touch/i.test(t)) break;
  }

  out.postStatus = postStatus;
  out.successText = successText.slice(0, 80);
  out.consoleErrors = errs;
  await page.screenshot({ path: '/tmp/rendered-contact-journey.png' }).catch(() => {});
} catch (e) {
  out.error = `[${cur}] ${String(e.message || e).slice(0, 140)}`;
} finally {
  await browser.close();
}

const visitorOk =
  out.homeStatus === 200 &&
  out.postStatus === 200 &&
  /thank|sent|received|touch/i.test(out.successText || '') &&
  (out.consoleErrors || []).length === 0 &&
  !out.error;

console.log('\n━━ Rendered contact-form visitor journey ━━');
console.log(JSON.stringify(out, null, 2));
console.log(`\nJOURNEY_RESULT ${JSON.stringify({ slug: SLUG, email: EMAIL, postStatus: out.postStatus, ok: visitorOk })}`);
console.log(
  `\nVISITOR-LEG: ${visitorOk ? '✅ PASS' : '🔴 CHECK'} — home=${out.homeStatus} post=${out.postStatus} ui="${out.successText}" errs=${(out.consoleErrors || []).length}`,
);
console.log('NEXT: reconcile the owner surface → SELECT … FROM form_submissions WHERE email = ' + EMAIL);
process.exit(visitorOk ? 0 : 1);
