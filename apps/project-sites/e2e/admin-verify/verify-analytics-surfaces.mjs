#!/usr/bin/env node
/** verify-analytics-surfaces.mjs — DISPLAY reconciliation for the analytics OVERVIEW
 * (visitor_events fallback) + LIVE tab (/api/analytics-data). Logs in as brian
 * (real browser, Browserbase) and fetches, for the megabytespace site:
 *   - /api/sites/:id/analytics        (owner summary — traffic.pageviews should be >0)
 *   - /api/analytics-data?siteId=:id  (LIVE tab events feed)
 *   - /api/sites/:id/multi-url-analytics?range=30d (CF-zone — empty for subdomains)
 * Reconcile: overview shows real pv (fallback works); live feed shows real events
 * (once repointed off the dead analytics_events table). Exits 0 (skip) if creds unset.
 *
 * LOCAL headless Playwright (migrated off dead Browserbase, fire-127): Browserbase credit
 * returned 402 (session create failed), so this probe SKIPPED every fire. fire-122 proved a
 * cf_clearance'd local headless browser authenticates the test-login seam fine (goto('/')
 * first → the in-page fetch carries the cookie; a node/curl POST 403s). This probe makes its
 * OWN token-based API calls inside one page.evaluate (no ps_session seeding), so it keeps its
 * inline login — only the Browserbase plumbing is swapped for the shared helper.
 * Creds (env → get-secret): E2E_TEST_PASSWORD. */
import { launchLocalBrowser, getTestPassword } from './_local-browser.mjs';
const PW = getTestPassword();
const SITE = process.argv[2] || 'site-megabytespace-001';
if (!PW) { console.log('::notice:: verify-analytics-surfaces skipped — E2E_TEST_PASSWORD unset'); process.exit(0); }
const browser = await launchLocalBrowser();
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const out = await page.evaluate(async ({ pw, site }) => {
    const login = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const lj = await login.json().catch(() => ({}));
    const token = lj?.data?.token;
    if (!token) return { loginStatus: login.status, error: 'no token' };
    const h = { Authorization: `Bearer ${token}` };
    const summary = await (await fetch(`/api/sites/${site}/analytics?windowDays=30`, { headers: h })).json().catch(() => null);
    const live = await (await fetch(`/api/analytics-data?siteId=${site}&limit=100`, { headers: h })).json().catch(() => null);
    const cf = await (await fetch(`/api/sites/${site}/multi-url-analytics?range=30d`, { headers: h })).json().catch(() => null);
    return {
      loginStatus: login.status,
      overview_traffic: summary?.traffic ? { pageviews: summary.traffic.pageviews, uniqueSessions: summary.traffic.uniqueSessions, conversions: summary.traffic.conversions } : summary,
      overview_contacts: summary?.contacts ? { total: summary.contacts.total, newInWindow: summary.contacts.newInWindow, bySource: summary.contacts.bySource } : null,
      live_feed: live ? { count: live.count, note: live.note, first: (live.events || [])[0] ?? null } : live,
      cf_zone: cf ? { any_real_data: cf.data?.any_real_data ?? cf.any_real_data, pageviews: cf.data?.pageviews ?? cf.pageviews } : cf,
    };
  }, { pw: PW, site: SITE });
  console.log(JSON.stringify(out, null, 2));
} finally { await browser.close(); }
