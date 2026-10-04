#!/usr/bin/env node
/**
 * super-admin-probe.mjs — TECHNICAL LIVE verification (P0.54) that the
 * super-admin cost-category surface is POPULATED for brian and that the worker
 * contracts the FE fixes target are real. NON-MUTATING: the two PATCH probes
 * send INVALID shapes that Zod rejects BEFORE any write (400), so nothing in
 * prod billing config changes.
 *
 * Proves:
 *  1. GET /api/super-admin/cost-categories → 200 + a non-empty categories array
 *     (real data in brian's operator view, not an empty/stub state).
 *  2. PATCH {billable: 1} (NUMBER) → 400 — the old dead-toggle bug is real; the
 *     worker `patchCategorySchema.billable` is z.boolean(). The FE now sends a
 *     boolean (super-admin.component.ts toggleBillable).
 *  3. PATCH {markup_factor: 99} (out of range) → 400 — the worker clamps 0.5–5;
 *     the FE now guards this range before calling (saveFactor).
 *
 * LOCAL headless Playwright (migrated off dead Browserbase, fire-127): Browserbase credit
 * returned 402 (session create failed), so this probe SKIPPED every fire. fire-122 proved a
 * cf_clearance'd local headless browser authenticates the test-login seam fine (goto('/')
 * first → the in-page fetch carries the cookie; a node/curl POST 403s). This probe makes its
 * OWN token-based API calls (no ps_session seeding needed), so it keeps its inline login that
 * returns the token — only the Browserbase plumbing is swapped for the shared helper.
 * Creds (env → get-secret): E2E_TEST_PASSWORD. Exits 0 (skip) if unset.
 */
import { launchLocalBrowser, getTestPassword } from './_local-browser.mjs';

const PW = getTestPassword();
if (!PW) {
  console.log('::notice:: super-admin-probe skipped — E2E_TEST_PASSWORD unset');
  process.exit(0);
}

const browser = await launchLocalBrowser();
let exitCode = 0;
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);

  const login = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, token: j?.data?.token ?? null };
  }, PW);
  if (!login.token) { console.log(JSON.stringify({ ok: false, stage: 'login', login })); process.exit(4); }
  const token = login.token;

  const call = (method, path, body) => page.evaluate(async ({ path, method, body, token }) => {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, { path, method, body, token });

  const list = await call('GET', '/api/super-admin/cost-categories', null);
  const cats = Array.isArray(list.body?.categories) ? list.body.categories : [];
  const slug = cats[0]?.slug ?? 'llm_tokens';

  // Non-mutating: both are Zod-rejected (400) before any DB write.
  const numBillable = await call('PATCH', `/api/super-admin/cost-categories/${slug}`, { billable: 1 });
  const badFactor = await call('PATCH', `/api/super-admin/cost-categories/${slug}`, { markup_factor: 99 });

  const report = {
    ok: list.status === 200 && cats.length > 0 && numBillable.status === 400 && badFactor.status === 400,
    listStatus: list.status,
    categoryCount: cats.length,
    firstSlug: slug,
    numberBillableStatus: numBillable.status, // expect 400 (z.boolean() rejects number)
    outOfRangeFactorStatus: badFactor.status, // expect 400 (0.5–5 clamp)
  };
  console.log(JSON.stringify(report, null, 2));
  exitCode = report.ok ? 0 : 5;
} finally {
  await browser.close();
}
process.exit(exitCode);
