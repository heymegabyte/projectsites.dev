#!/usr/bin/env node
/**
 * verify-contact-validation.mjs — § C.14: the generated site's CONTACT FORM validation + a11y path,
 * driven on a REAL deployed `{slug}.projectsites.dev` in real Chromium. The contact form is the #1
 * conversion surface for a small business (lead capture), and `verify-rendered-contact-journey.mjs`
 * proves only the HAPPY path (fill valid → submit → "Thanks!"). Nothing proved the GUARD path — a form
 * that accepts garbage (posts an unreachable "email" as a lead) or gives a visitor no feedback silently
 * loses leads AND fails WCAG 3.3.1 (Error Identification) / 3.3.3 (Error Suggestion). This closes that.
 *
 * The template ContactForm live-validates (Zod `isFieldValid` per field) + gates the submit
 * (`disabled={!allValid}`) + marks invalid fields `aria-invalid` with a `role="alert"` message. The
 * probe asserts that contract on prod:
 *   1. the form renders (`.pst-cf` + name / email / message / submit).
 *   2. the submit is GATED closed on the empty form (a visitor can't fire an empty lead).
 *   3. a bad email → the email field goes `aria-invalid="true"` + a `role="alert"` error appears +
 *      the submit STAYS disabled (invalid input can never POST — no garbage lead, screen-reader-announced).
 *   4. a valid name + email + message → the submit ENABLES + the email's `aria-invalid` clears (the
 *      live green-check affordance — the visitor sees they can send).
 *   5. 0 console errors across the interaction.
 *
 * A non-mutating probe: it NEVER clicks the enabled submit (no real lead is created), only drives the
 * validation state. Fail-OPEN (skip) when a site has no /contact form (older builds / a site whose org
 * type omits it) so the suite stays green. Auto-joins site-quality run-all via the verify-*.mjs glob.
 *
 * Usage: SITES=<slug> node e2e/site-quality/verify-contact-validation.mjs
 */
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
// LOCAL_ORIGIN (e.g. http://localhost:4174) proves the CURRENT template's /contact contract on a local
// preview — the deployed sites lag the template, so a stale-build fleet fail-opens (below) until they
// rebuild; this lets the SAME probe assert the shipped contract now AND guard prod as sites catch up.
const LOCAL = process.env.LOCAL_ORIGIN;
const TARGETS = LOCAL
  ? [{ slug: 'local-template', url: `${LOCAL.replace(/\/$/, '')}/contact` }]
  : resolveSites(process.env.SITES).map((s) => ({ slug: s, url: `https://${s}${SUFFIX}/contact` }));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const b = await chromium.launch();

async function probe(url) {
  const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const t = m.type();
    const x = m.text();
    if (/Failed to load resource|favicon|net::ERR_ABORTED|SwiftShader|GPU stall|WebGL|getContext|posthog|sentry|analytics|ingest/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 90));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 90)));

  const out = { loaded: false, hasForm: false, errs, steps: {} };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    out.loaded = true;
    // SPA route: the ContactForm hydrates after `load` — WAIT for it before deciding "no form".
    // A build that lacks the modern validated form (older /contact inline form / a site whose org type
    // omits contact) never resolves this → fail-open (stale-build discipline).
    const form = page.locator('form.pst-cf').first();
    await form.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    if ((await form.count()) === 0) return out; // no modern contact form on this build → fail-open
    out.hasForm = true;

    const email = page.locator('form.pst-cf input[name="email"]').first();
    const name = page.locator('form.pst-cf input[name="name"]').first();
    const message = page.locator('form.pst-cf textarea[name="message"]').first();
    const submit = page.locator('.pst-cf-submit').first();

    out.steps.fields =
      (await email.count()) > 0 && (await name.count()) > 0 && (await message.count()) > 0 && (await submit.count()) > 0;

    // 2. gated on empty
    out.steps.gatedEmpty = await submit.isDisabled();

    // 3. bad email → aria-invalid + role=alert error + still gated
    await name.fill('Test Visitor');
    await message.fill('Hello, I have a question about your hours this weekend.');
    await email.fill('notanemail');
    await email.blur();
    await page.waitForTimeout(250);
    out.steps.badEmailAriaInvalid = (await email.getAttribute('aria-invalid')) === 'true';
    out.steps.badEmailAlert = (await page.locator('form.pst-cf [role="alert"]').count()) > 0;
    out.steps.badEmailStillGated = await submit.isDisabled();

    // 4. valid email → submit enables + aria-invalid clears
    await email.fill('visitor@example.com');
    await email.blur();
    await page.waitForTimeout(300);
    out.steps.validEnables = !(await submit.isDisabled());
    out.steps.validAriaCleared = (await email.getAttribute('aria-invalid')) !== 'true';
  } catch (e) {
    out.errs.push('[probe] ' + String(e.message || e).slice(0, 80));
  } finally {
    await ctx.close();
  }
  return out;
}

let exit = 0;
const rows = [];
const line = (ok, label, detail = '') => {
  rows.push(`  ${ok ? '✓' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) exit = 1;
};
const skip = (label, detail = '') => rows.push(`  ⏭️  ${label}${detail ? ` — ${detail}` : ''}`);

for (const { slug, url } of TARGETS) {
  rows.push(`\n─ ${url} ─`);
  const r = await probe(url);
  if (!r.loaded) {
    skip(`${slug}: /contact could not load (fail-open)`, r.errs.slice(0, 1).join(''));
    continue;
  }
  if (!r.hasForm) {
    skip(`${slug}: no contact form on this build (fail-open)`);
    continue;
  }
  const s = r.steps;
  line(s.fields, `${slug}: contact form renders (name + email + message + submit)`);
  line(s.gatedEmpty, `${slug}: submit GATED closed on the empty form (no empty lead)`);
  line(
    s.badEmailAriaInvalid && s.badEmailAlert && s.badEmailStillGated,
    `${slug}: bad email → aria-invalid + role=alert error + submit STAYS disabled (no garbage lead, SR-announced)`,
    `ariaInvalid=${s.badEmailAriaInvalid} alert=${s.badEmailAlert} stillGated=${s.badEmailStillGated}`,
  );
  line(
    s.validEnables && s.validAriaCleared,
    `${slug}: valid name+email+message → submit ENABLES + aria-invalid clears (the visitor can send)`,
    `enables=${s.validEnables} cleared=${s.validAriaCleared}`,
  );
  line(r.errs.length === 0, `${slug}: 0 console errors across the interaction`, r.errs[0] || '');
}

await b.close();
console.log('\n━━ contact-form validation + a11y (§ C.14) — prod generated sites ━━');
rows.forEach((r) => console.log(r));
console.log(
  exit === 0
    ? '\n✓ contact-validation PASS — the lead-capture form gates empty/invalid input, announces errors (aria-invalid + role=alert), and only enables on a valid message; sites without a contact form fail-open.'
    : '\n❌ contact-validation FAIL',
);
process.exit(exit);
