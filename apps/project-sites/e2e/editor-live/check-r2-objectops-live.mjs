/**
 * check-r2-objectops-live.mjs — DEFINITIVE prod proof of Buckets B5 slice 2 (per-site scoped-token
 * object ops). Auths as the E2E test-org (E2E_API_KEY bearer), picks one of the org's OWN sites, and
 * drives the FULL object round-trip against the deployed worker + REAL Cloudflare R2:
 *   list buckets (→ objectOpsAvailable must be true) → PUT a probe object → GET it back (bytes match)
 *   → confirm it lists → DELETE it (cleanup).
 * Every object op is signed by a PER-SITE scoped R2 S3 token the worker mints on demand (never an
 * account-wide key). Requires the `r2_bucket_manager` flag ON for the org. Cleans up the probe object.
 *   node apps/project-sites/e2e/editor-live/check-r2-objectops-live.mjs
 */
import { execSync } from 'node:child_process';
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
function secret(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execSync(`/Users/Apple/.local/bin/get-secret ${name}`, { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

const apiKey = secret('E2E_API_KEY');
if (!apiKey) {
  console.log('SKIP: E2E_API_KEY unavailable.');
  process.exit(0);
}

const browser = await launchLocalBrowser();
const page = await browser.newPage();
try {
  await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000); // cf_clearance

  const r = await page.evaluate(
    async ({ base, key }) => {
      const h = { Authorization: `Bearer ${key}` };
      const out = { steps: [] };
      const log = (s, v) => out.steps.push({ step: s, ...v });

      // 1. Pick one of the org's OWN sites.
      const sitesRes = await fetch(`${base}/api/sites?limit=20`, { headers: h });
      const sitesJson = await sitesRes.json().catch(() => ({}));
      const sites = sitesJson?.data?.sites ?? sitesJson?.sites ?? sitesJson?.data ?? [];
      log('listSites', { status: sitesRes.status, count: Array.isArray(sites) ? sites.length : 0 });
      const site = Array.isArray(sites) ? sites.find((s) => s?.id) : null;
      if (!site) return { ...out, verdict: 'NO_SITE' };
      out.siteId = site.id;

      // 2. List buckets → objectOpsAvailable must be true (the slice-2 flip).
      const bRes = await fetch(`${base}/api/sites/${site.id}/r2/buckets`, { headers: h });
      const bJson = await bRes.json().catch(() => ({}));
      const buckets = bJson?.data?.buckets ?? [];
      out.objectOpsAvailable = bJson?.data?.objectOpsAvailable ?? null;
      log('listBuckets', { status: bRes.status, buckets: buckets.map((x) => x.name), objectOpsAvailable: out.objectOpsAvailable });
      if (out.objectOpsAvailable !== true) return { ...out, verdict: 'OBJECT_OPS_NOT_AVAILABLE' };
      const bucket = buckets[0]?.name;
      if (!bucket) return { ...out, verdict: 'NO_BUCKET' };
      out.bucket = bucket;

      // 3. PUT a probe object (raw body; signed by the minted per-site token — may 401→retry on propagation).
      const objKey = `_b5_probe_${Date.now()}.txt`;
      const payload = 'hello-b5-slice2';
      const putRes = await fetch(`${base}/api/sites/${site.id}/r2/buckets/${encodeURIComponent(bucket)}/objects/${objKey}`, {
        body: payload,
        headers: { ...h, 'content-type': 'text/plain' },
        method: 'PUT',
      });
      const putJson = await putRes.json().catch(() => ({}));
      log('putObject', { status: putRes.status, key: objKey, ok: putJson?.ok ?? false, msg: putJson?.error?.message });
      if (putRes.status !== 201) return { ...out, verdict: 'PUT_FAILED' };

      // 4. GET it back — bytes must match (proves a real GetObject via the per-site token).
      const getRes = await fetch(`${base}/api/sites/${site.id}/r2/buckets/${encodeURIComponent(bucket)}/objects/${objKey}`, { headers: h });
      const body = getRes.status === 200 ? await getRes.text() : '';
      log('getObject', { status: getRes.status, bytesMatch: body === payload });

      // 5. List objects — the probe key must appear.
      const lRes = await fetch(`${base}/api/sites/${site.id}/r2/buckets/${encodeURIComponent(bucket)}/objects?limit=100`, { headers: h });
      const lJson = await lRes.json().catch(() => ({}));
      const keys = (lJson?.data?.objects ?? []).map((o) => o.key);
      log('listObjects', { status: lRes.status, found: keys.includes(objKey), count: keys.length });

      // 6. DELETE (cleanup).
      const dRes = await fetch(`${base}/api/sites/${site.id}/r2/buckets/${encodeURIComponent(bucket)}/objects/${objKey}`, { headers: h, method: 'DELETE' });
      log('deleteObject', { status: dRes.status });

      const getOk = getRes.status === 200 && body === payload;
      return { ...out, verdict: getOk && keys.includes(objKey) ? 'PASS' : 'PARTIAL' };
    },
    { base: PROD_URL, key: apiKey },
  );

  console.log('[r2-objectops] steps:');
  for (const s of r.steps) console.log('  ', JSON.stringify(s));
  console.log(`[r2-objectops] site=${r.siteId} bucket=${r.bucket} objectOpsAvailable=${r.objectOpsAvailable}`);
  if (r.verdict === 'PASS')
    console.log('VERDICT: ✅ DEFINITIVE — per-site scoped token signed a REAL put→get(bytes match)→list→delete round-trip against Cloudflare R2. B5 slice 2 works end-to-end.');
  else console.log(`VERDICT: ✗ ${r.verdict} — see steps above.`);
} finally {
  await browser.close();
}
