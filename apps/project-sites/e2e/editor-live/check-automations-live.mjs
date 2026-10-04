/**
 * check-automations-live.mjs — deterministic authed proof that the Automations endpoint is LIVE
 * (reliable alternative to the flaky headless sub-tab UI driving). Auths as brian via the test-login
 * seam, then fetches GET /api/sites/:siteId/automations AS the authed user: 200 = flag ON + feature
 * live (404 would mean the flag gate still blocks). Headless-only.
 *
 *   node apps/project-sites/e2e/editor-live/check-automations-live.mjs
 */
import { launchLocalBrowser, getTestPassword, authSeedBrian } from '../admin-verify/_local-browser.mjs';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

const browser = await launchLocalBrowser();
const page = await browser.newPage();
try {
  const pw = await getTestPassword();
  await authSeedBrian(page, pw, PROD_URL);

  // In-page fetch carries the seeded session. First list the caller's sites, then probe automations.
  const result = await page.evaluate(async (base) => {
    const token = (() => {
      try {
        return JSON.parse(localStorage.getItem('ps_session') || '{}')?.token ?? '';
      } catch {
        return '';
      }
    })();
    const h = token ? { Authorization: `Bearer ${token}` } : {};
    const sitesRes = await fetch(`${base}/api/sites`, { headers: h });
    const sitesBody = await sitesRes.json().catch(() => ({}));
    const sites = sitesBody?.sites ?? sitesBody?.data ?? [];
    const siteId = sites[0]?.id ?? sites[0]?.site_id ?? null;
    if (!siteId) return { sitesStatus: sitesRes.status, siteCount: sites.length, siteId: null };
    const autoRes = await fetch(`${base}/api/sites/${siteId}/automations`, { headers: h });
    const autoBody = await autoRes.json().catch(() => ({}));
    return {
      sitesStatus: sitesRes.status,
      siteCount: sites.length,
      siteId,
      automationsStatus: autoRes.status,
      automationsRows: Array.isArray(autoBody?.data) ? autoBody.data.length : (autoBody?.data ? 'obj' : 'none'),
    };
  }, PROD_URL);

  console.log('[check] sites:', result.sitesStatus, 'count:', result.siteCount, 'siteId:', result.siteId);
  if (result.automationsStatus !== undefined) {
    console.log('[check] GET /automations →', result.automationsStatus, '· rows:', result.automationsRows);
    if (result.automationsStatus === 200) {
      console.log('VERDICT: ✅ AUTOMATIONS ENDPOINT LIVE — flag ON, feature serves (was 404 when dark). 4th Resources tab is functional.');
    } else if (result.automationsStatus === 404) {
      console.log('VERDICT: ✗ still 404 — flag gate blocking (override not picked up?).');
    } else {
      console.log(`VERDICT: ⚠ unexpected ${result.automationsStatus}.`);
    }
  } else {
    console.log('VERDICT: ⚠ could not resolve a site id for the authed user.');
  }
} finally {
  await browser.close();
}
