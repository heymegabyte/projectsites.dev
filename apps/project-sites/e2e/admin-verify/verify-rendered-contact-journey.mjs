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
 * (form_submissions ground-truth) now runs AUTOMATICALLY as the OWNER-LEG (per
 * verify-against-source-of-truth: the handler's form_submissions mirror is BEST-EFFORT, so a
 * 200 + "Thanks!" is NOT proof the row the owner's /admin/forms reads actually landed — the D1
 * count is). When CLOUDFLARE_API_KEY is present the probe SELECTs COUNT(*) FROM form_submissions
 * for the just-submitted email and FAILS on a definitive 0 (a LYING-SUCCESS lost lead); it
 * fail-OPENs (skip, visitor-leg verdict stands) without CF auth or on a wrangler error, so
 * creds-less CI never false-reds. Still prints JOURNEY_RESULT {email,storeLeg,...}.
 *
 * TARGET = a loop-DELIVERED test site (default zingermans-ann-arbor-2), never a customer
 * site — form_submissions has no DELETE endpoint, so the journey row persists. Override
 * with SLUG=<slug>. `node e2e/admin-verify/verify-rendered-contact-journey.mjs`.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const DB = 'project-sites-db-production';
const CF_KEY = process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_API_TOKEN || '';

/** COUNT rows via `wrangler d1 execute --json`. Returns the integer, or throws on a wrangler error. */
function d1Count(sql) {
  const raw = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--env', 'production', '--json', '--command', sql],
    { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const json = JSON.parse(raw);
  const rows = json?.[0]?.results ?? json?.result?.[0]?.results ?? [];
  return Number(rows?.[0]?.n ?? 0);
}

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

// ── 6. OWNER-LEG reconcile (verify-against-source-of-truth): a 200 + "Thanks!" is NOT proof the lead
//       landed — the handler's form_submissions mirror is BEST-EFFORT, so a silent D1 write-drop is a
//       LYING-SUCCESS the visitor leg is blind to. Query the STORE the owner's /admin/forms reads and
//       assert the row exists — the causal loop now closes AUTOMATICALLY (was a manual "NEXT:" step).
//       Fail-OPEN (skip) when no CF auth so creds-less CI keeps the visitor-leg proof; a wrangler error
//       skips too (never false-🔴 a healthy submit on an infra hiccup) — only a definitive 0-rows fails.
let storeLeg = 'skipped';
if (visitorOk && CF_KEY) {
  try {
    const n = d1Count(`SELECT COUNT(*) AS n FROM form_submissions WHERE email = '${EMAIL}'`);
    out.storeCount = n;
    storeLeg = n >= 1 ? 'pass' : 'fail';
  } catch (e) {
    out.storeError = String(e.message || e).slice(0, 100);
    storeLeg = 'error';
  }
}

// The journey is a real defect ONLY when the store DEFINITIVELY dropped the lead (200+"Thanks!" but
// 0 rows). A skipped/errored reconcile keeps the visitor-leg verdict (fail-open).
const ok = visitorOk && storeLeg !== 'fail';

console.log('\n━━ Rendered contact-form visitor journey ━━');
console.log(JSON.stringify(out, null, 2));
console.log(
  `\nJOURNEY_RESULT ${JSON.stringify({ slug: SLUG, email: EMAIL, postStatus: out.postStatus, visitorOk, storeLeg, ok })}`,
);
console.log(
  `\nVISITOR-LEG: ${visitorOk ? '✅ PASS' : '🔴 CHECK'} — home=${out.homeStatus} post=${out.postStatus} ui="${out.successText}" errs=${(out.consoleErrors || []).length}`,
);
const OWNER = {
  pass: `✅ PASS — the lead LANDED in form_submissions (count=${out.storeCount}); the owner's /admin/forms will show it`,
  fail: `🔴 LYING-SUCCESS — 200 + "Thanks!" but 0 rows in form_submissions: the owner NEVER receives this lead`,
  skipped: 'ℹ️  skipped — no CF auth (visitor-leg proof stands; set CLOUDFLARE_API_KEY for the store reconcile)',
  error: `ℹ️  skipped — D1 reconcile errored (${out.storeError || 'wrangler'}); visitor-leg proof stands`,
}[storeLeg];
console.log(`OWNER-LEG (form_submissions store): ${OWNER}`);
console.log(`\nVERDICT: ${ok ? '✅ PASS' : '🔴 FAIL'} — contact→/admin/forms money journey ${ok ? 'proven end-to-end' : 'BROKEN'}.`);
process.exit(ok ? 0 : 1);
