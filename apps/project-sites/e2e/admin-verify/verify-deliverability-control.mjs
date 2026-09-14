/**
 * verify-deliverability-control.mjs — § ADMIN-COMPLETENESS facet (7) EVERY CONTROL REAL, for
 * the /admin/deliverability "Check deliverability" control (a live SPF/DKIM/DMARC DNS lookup).
 *
 * That control was real but had NO durable probe — the causal-mutation probes cover WRITES;
 * this is a READ action (live DNS check) none of them exercised. This drives it as a user does
 * and asserts it is fully wired, not a stub:
 *   1. the sending-domain input BINDS + flows to the request (typed domain === request `?domain=`) —
 *      guards a "dead input" regression (a check that silently ignores the field);
 *   2. clicking "Check deliverability" flips all three SPF/DKIM/DMARC cards from "not checked yet"
 *      to a real verdict (notChecked 3 → 0) via a 200 from `/api/sites/:id/deliverability`;
 *   3. zero console errors.
 *
 * A distinct throwaway domain is used so the input-wiring assertion is unambiguous; the DNS
 * lookup returns "no record" verdicts for it, which still populates the cards (the point is the
 * control RAN + wired the field, not that the domain passes).
 *
 * Run: NODE_PATH="$PWD/frontend/node_modules" \
 *   E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-deliverability-control.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.error('E2E_API_KEY missing (get-secret E2E_API_KEY)');
  process.exit(2);
}
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const DISTINCT = 'mail.testcheck-xyz.com';

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(
  ([token]) => {
    try {
      localStorage.setItem('ps_session', JSON.stringify({ token, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }));
    } catch {
      /* opaque origin */
    }
  },
  [KEY],
);
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/google-analytics|googletagmanager|posthog|\/ingest|sentry|challenge/i.test(m.text())) errs.push(m.text().slice(0, 120));
});
let reqDomain = null;
let reqStatus = null;
page.on('response', (r) => {
  if (/\/api\/sites\/[^/]+\/deliverability\?/.test(r.url())) {
    reqDomain = decodeURIComponent(new URL(r.url()).searchParams.get('domain') || '');
    reqStatus = r.status();
  }
});

await page.goto(`${BASE}/admin/deliverability`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

const beforeNotChecked = await page.evaluate(() => (document.body.innerText.match(/not checked yet/gi) || []).length);
const input = page.getByPlaceholder(/mail\.example\.com/i).first();
const inputFound = (await input.count()) >= 1;
await input.fill(DISTINCT).catch(() => {});
const boundVal = await input.inputValue().catch(() => '');
await page.getByRole('button', { name: /check deliverability/i }).first().click().catch(() => {});
await page.waitForTimeout(7000); // live DNS lookup
const afterNotChecked = await page.evaluate(() => (document.body.innerText.match(/not checked yet/gi) || []).length);

await browser.close();

const checks = {
  inputFound,
  inputBinds: boundVal === DISTINCT,
  inputWiredToRequest: reqDomain === DISTINCT,
  requestOk: reqStatus === 200,
  // After the check runs, NO card is left "not checked yet" (all show verdicts). Robust whether
  // the section loaded fresh (before=3) or already-checked from a prior run (before=0) — the
  // inputWiredToRequest + requestOk checks above prove the CLICK actually ran a real check for
  // the typed domain (a stub button couldn't fire a 200 carrying it).
  cardsResolved: afterNotChecked === 0,
  noConsoleErrors: errs.length === 0,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ base: BASE, beforeNotChecked, afterNotChecked, reqDomain, reqStatus, checks, errs: errs.slice(0, 3), verdict: pass ? '✅ PASS' : '❌ FAIL' }, null, 2));
console.log(
  pass
    ? '✅ PASS — deliverability check control is fully real: input wired → request → SPF/DKIM/DMARC cards populate, 0 console errors'
    : '❌ FAIL — deliverability control regressed (dead input / stub button / cards did not populate)',
);
process.exit(pass ? 0 : 1);
