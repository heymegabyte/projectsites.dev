#!/usr/bin/env node
/** verify-perpage-cwv-live.mjs — confirms the DEPLOYED getWebVitalsSummary returns the
 * webVitals block INCLUDING the per-page slowestPages drilldown (now carrying per-path
 * fcpP75/ttfbP75) WITHOUT error, as the real owner (brian), against prod. Values may be
 * honestly absent (a page below the 5-sample floor for a metric) — this proves the new
 * code PATH executes live + the contract shape, not that samples exist.
 * Creds (get-secret): BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, E2E_TEST_PASSWORD. */
import { chromium } from '@playwright/test';
const BB = process.env.BROWSERBASE_API_KEY,
  PROJ = process.env.BROWSERBASE_PROJECT_ID,
  PW = process.env.E2E_TEST_PASSWORD;
const SITE = process.argv[2] || 'site-megabytespace-001';
if (!BB || !PROJ || !PW) {
  console.log('::notice:: skipped — creds unset');
  process.exit(0);
}
const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST',
  headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 300 }),
});
if (!r.ok) {
  console.log('session create failed', r.status);
  process.exit(3);
}
const { id } = await r.json();
const browser = await chromium.connectOverCDP(
  `wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`,
);
try {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const out = await page.evaluate(
    async ({ pw, site }) => {
      const login = await fetch('/api/auth/test-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }),
      });
      const lj = await login.json().catch(() => ({}));
      const token = lj?.data?.token;
      if (!token) return { loginStatus: login.status, error: 'no token' };
      const summary = await (
        await fetch(`/api/sites/${site}/analytics?windowDays=30`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
        .json()
        .catch(() => null);
      const wv = summary?.traffic?.webVitals;
      return {
        loginStatus: login.status,
        webVitals_present: !!wv,
        // The proof the new per-path code ran: slowestPages is an array (each row may or
        // may not carry fcpP75/ttfbP75 depending on that page's sample count — honest).
        slowestPages_isArray: Array.isArray(wv?.slowestPages),
        slowestPages_count: wv?.slowestPages?.length ?? null,
        slowestPages_keys: (wv?.slowestPages ?? []).map((p) => Object.keys(p)),
        slowestPages_sample: (wv?.slowestPages ?? [])[0] ?? null,
        site_fcp: wv?.fcp ?? null,
        site_ttfb: wv?.ttfb ?? null,
      };
    },
    { pw: PW, site: SITE },
  );
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
