/**
 * check-durable-preview-live.mjs — deterministic AUTHED proof that the durable_preview
 * (SourceControl Production-publish) flag is live. Reads the caller's first site, then hits
 * the READ-ONLY GET /api/sites/:id/releases: 200 = flag ON + feature serves (404 = dark).
 * Read-only (never promotes a real site). Headless-only. Mirror of check-automations-live.mjs.
 *
 *   node apps/project-sites/e2e/editor-live/check-durable-preview-live.mjs
 */
import { launchLocalBrowser, getTestPassword, authSeedBrian } from '../admin-verify/_local-browser.mjs';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

const browser = await launchLocalBrowser();
const page = await browser.newPage();
try {
  const pw = await getTestPassword();
  await authSeedBrian(page, pw, PROD_URL);

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
    const relRes = await fetch(`${base}/api/sites/${siteId}/releases`, { headers: h });
    const relBody = await relRes.json().catch(() => ({}));
    return {
      sitesStatus: sitesRes.status,
      siteCount: sites.length,
      siteId,
      releasesStatus: relRes.status,
      releaseCount: Array.isArray(relBody?.data) ? relBody.data.length : (Array.isArray(relBody?.releases) ? relBody.releases.length : 'n/a'),
    };
  }, PROD_URL);

  console.log('[check] sites:', result.sitesStatus, 'count:', result.siteCount, 'siteId:', result.siteId);
  if (result.releasesStatus !== undefined) {
    console.log('[check] GET /releases →', result.releasesStatus, '· releases:', result.releaseCount);
    if (result.releasesStatus === 200) {
      console.log('VERDICT: ✅ DURABLE_PREVIEW LIVE — flag ON, SourceControl Production-publish serves (was 404 when dark).');
    } else if (result.releasesStatus === 404) {
      console.log('VERDICT: ✗ still 404 — flag gate blocking.');
    } else {
      console.log(`VERDICT: ⚠ unexpected ${result.releasesStatus}.`);
    }
  } else {
    console.log('VERDICT: ⚠ could not resolve a site id for the authed user.');
  }
} finally {
  await browser.close();
}
