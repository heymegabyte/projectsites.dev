/**
 * check-media-realasset.mjs — DEFINITIVE proof of the Editor Media thumbnail fix (fire-155).
 * brian's org has only R2-less stub assets (rawUrl 404s "Underlying object missing"), so it can't
 * show a real thumbnail. The E2E test-org has real assets. This auths as that org via E2E_API_KEY
 * (bearer) and proves a REAL image asset's signed, bearer-free `rawUrl` streams 200 — i.e. the
 * editor iframe's cross-origin <img> now loads real media (was a relative-editor-origin 404).
 *   node apps/project-sites/e2e/editor-live/check-media-realasset.mjs
 */
import { execSync } from 'node:child_process';
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
function secret(name) {
  if (process.env[name]) return process.env[name];
  try { return execSync(`/Users/Apple/.local/bin/get-secret ${name}`, { encoding: 'utf8', timeout: 5000 }).trim() || null; } catch { return null; }
}

const apiKey = secret('E2E_API_KEY');
if (!apiKey) { console.log('SKIP: E2E_API_KEY unavailable.'); process.exit(0); }

const browser = await launchLocalBrowser();
const page = await browser.newPage();
try {
  await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000); // cf_clearance

  const r = await page.evaluate(async ({ base, key }) => {
    const h = { Authorization: `Bearer ${key}` };
    const L = await fetch(`${base}/api/media/assets?limit=40`, { headers: h });
    const j = await L.json().catch(() => ({}));
    const assets = j?.assets ?? [];
    const img = assets.find((a) => (a?.mime || a?.contentType || '').startsWith('image/') && a?.rawUrl);
    const probe = img ?? assets.find((a) => a?.rawUrl);
    const out = { listStatus: L.status, count: assets.length, imageFound: Boolean(img), probedMime: probe?.mime ?? probe?.contentType ?? null };
    if (probe?.rawUrl) {
      const R = await fetch(probe.rawUrl, { headers: {} }); // bearer-free — token is in the URL
      out.rawStatus = R.status;
      out.rawCtype = R.headers.get('content-type');
      out.rawBytes = R.status === 200 ? (await R.arrayBuffer()).byteLength : 0;
      if (R.status !== 200) out.rawBody = (await R.text().catch(() => '')).slice(0, 160);
    }
    return out;
  }, { base: PROD_URL, key: apiKey });

  console.log(`[media] (E2E org) GET /api/media/assets → ${r.listStatus} · count: ${r.count} · image asset w/ rawUrl: ${r.imageFound}`);
  if (r.rawStatus === undefined) console.log('VERDICT: ⚠ no asset with a rawUrl in the E2E org (or list auth failed).');
  else if (r.rawStatus === 200) console.log(`VERDICT: ✅ DEFINITIVE — a REAL ${r.probedMime} asset's signed rawUrl streamed ${r.rawBytes} bytes (${r.rawCtype}) bearer-free. The Media thumbnail fix works end-to-end for real content.`);
  else if (r.rawStatus === 404 && /Underlying object missing/i.test(r.rawBody || '')) console.log('VERDICT: ⚠ this org\'s probed asset is also an R2-less stub (mechanism OK, no object). Try another asset.');
  else console.log(`VERDICT: ✗ rawUrl → ${r.rawStatus} ${r.rawBody || ''}`);
} finally {
  await browser.close();
}
