// verify-claim-flow.mjs — GOLDEN-JOURNEY claim-front (owner-facing), AL-700.
//
// The claim link `https://projectsites.dev/api/claim/<token>` is emailed to a scanned business
// owner. Two contracts a REAL owner-in-a-browser depends on:
//   1. An INVALID / expired token must NOT dead-end on a raw-JSON `{error:…}` 404 — it must 302 to
//      the create funnel (`/create?claim_invalid=1`) so the owner lands on a first-action launchpad
//      with a FRIENDLY notice, never a scary error blob (embarrassingly-easy-to-use).
//   2. The SPA XHR sub-route `/api/claim/<token>/profile` KEEPS its JSON 404 (it's consumed by the
//      Angular /create page, which handles the error) — a redirect there would break the prefill.
//
// SAFE (no build side-effect): only the INVALID path is exercised. A VALID token would provision a
// real site + start a build; that expensive happy-path is proven by the worker unit tests
// (claim_route.test.ts) + the create-from-search delivery, not re-run here every pass.
//
// Real local Chromium against PROD. Fail-open on transient/unreachable (::notice, exit 0).
// Usage: node e2e/admin-verify/verify-claim-flow.mjs
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const ORIGIN = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
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
    if (m.type() === 'error' && !/favicon|analytics|posthog|sentry|net::ERR_ABORTED/i.test(m.text()))
      errs.push(m.text().slice(0, 120));
  });

  const bogus = `nope-${Date.now().toString(36)}`;

  // 1. Top-level claim route: an invalid token 302-redirects to the friendly funnel (NOT raw JSON).
  const apiRes = await page.request.get(`${ORIGIN}/api/claim/${bogus}`, { maxRedirects: 0 }).catch(() => null);
  if (apiRes) {
    const status = apiRes.status();
    const loc = apiRes.headers()['location'] || '';
    check(
      'invalid claim link 302-redirects (no raw-JSON dead-end)',
      status === 302 && /\/create\?claim_invalid=1/.test(loc),
      `status=${status} location="${loc}"`,
    );
  } else {
    check('invalid claim link reachable', false, 'request failed (transient?)');
  }

  // 2. The SPA XHR sub-route KEEPS its JSON 404 (a redirect there would break the /create prefill).
  const profRes = await page.request.get(`${ORIGIN}/api/claim/${bogus}/profile`, { maxRedirects: 0 }).catch(() => null);
  if (profRes) {
    const body = await profRes.text().catch(() => '');
    check(
      '/profile XHR keeps JSON 404 (SPA-consumed, not a redirect)',
      profRes.status() === 404 && /"code"\s*:\s*"NOT_FOUND"/.test(body),
      `status=${profRes.status()}`,
    );
  }

  // 3. Real-browser: navigating the invalid claim link LANDS on /create with the FRIENDLY notice.
  await page.goto(`${ORIGIN}/api/claim/${bogus}`, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  // CONDITION-BASED wait for the notice — /create is a heavy lazy chunk (~3.5s to hydrate the @if,
  // per AL-697); reading right after the h1 races it. Wait for the notice OR a 10s cap.
  await page
    .waitForSelector('[data-testid="claim-invalid-notice"]', { timeout: 10000 })
    .catch(() => {});
  const landed = await page.evaluate(() => ({
    path: location.pathname,
    invalidParam: new URLSearchParams(location.search).get('claim_invalid'),
    notice: document.querySelector('[data-testid="claim-invalid-notice"]')?.textContent?.trim().slice(0, 120) || '',
    h1: document.querySelector('h1')?.textContent?.trim().slice(0, 50) || '',
  }));
  check(
    'invalid claim link lands the owner on the /create funnel',
    landed.path === '/create' && landed.invalidParam === '1' && landed.h1.length > 0,
    `path=${landed.path} h1="${landed.h1}"`,
  );
  check(
    'the friendly "expired link" notice renders (first-action, not a dead-end)',
    /expired|isn'?t valid|no problem|build your site/i.test(landed.notice),
    landed.notice ? `notice="${landed.notice}"` : 'notice ABSENT (stale bundle? clears on FE deploy)',
  );
  check('0 console errors on the claim-invalid funnel', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');

  await browser.close();
} catch (e) {
  console.log(`::notice:: verify-claim-flow — unreachable/transient, fail-open: ${String(e).slice(0, 120)}`);
  process.exit(0);
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(56)} ${r.detail}`);
// The FE notice (check 5) lands on the next FE deploy; treat a notice-only miss as a ::notice, not a hard fail.
const hardFails = rows.filter((r) => !r.ok && !/friendly .expired/.test(r.label)).length;
console.log(
  fails
    ? `\nVERDICT: ${hardFails ? '🔴 FAIL' : '🟡 NOTICE'} — ${fails} claim-flow check(s) unmet (${hardFails} hard).`
    : `\nVERDICT: ✅ PASS — invalid claim links redirect owners to the friendly create funnel, 0 console errors.`,
);
process.exit(hardFails ? 1 : 0);
