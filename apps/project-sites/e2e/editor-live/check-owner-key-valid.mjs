/**
 * check-owner-key-valid.mjs — DEFINITIVE prod proof that the OWNER-FACING scoped R2 key (Buckets B5
 * slice 4) is a VALID, USABLE, LEAST-PRIVILEGE, REVOCABLE credential. The route tests prove the HTTP
 * contract; this proves the thing that actually matters: the `{accessKeyId, secretAccessKey}` the
 * endpoint hands a site owner can really sign S3 requests against Cloudflare R2 — and ONLY against the
 * site's OWN buckets — and stops working the instant it's revoked.
 *
 * Auth recipe (from `check-r2-objectops-live.mjs`): E2E_API_KEY bearer + a cf_clearance'd LOCAL headless
 * Chromium so IN-PAGE `fetch` to the SAME-ORIGIN API carries the clearance cookie (a node/curl POST 403s).
 * The owner-key mint + bucket-address lookups run IN-PAGE for that reason. The SigV4 S3 requests, however,
 * target a DIFFERENT origin (`{acct}.r2.cloudflarestorage.com`) that sends no CORS headers — an in-page
 * cross-origin fetch fails before it gets a status ("Failed to fetch"). So the signing + S3 round-trips
 * run in NODE (global fetch + Web Crypto; no CORS restriction), using the creds the page handed back.
 *
 * Flow:
 *   1. auth as the owning org (E2E_API_KEY) + pick one of its OWN sites with a bucket   [in-page]
 *   2. POST /api/sites/:siteId/r2/keys → capture {accessKeyId, secretAccessKey}           [in-page]
 *   3. SigV4-sign ListObjectsV2 on the site's OWN bucket with THOSE creds → 200 = VALID    [node]
 *   4. SigV4-sign ListObjectsV2 on a FORBIDDEN shared platform bucket → 403 = SCOPED       [node]
 *   5. DELETE /api/sites/:siteId/r2/keys [in-page] → re-sign OWN bucket → 403 = REVOKED    [node]
 *
 * Honest by construction: if the auth seam / test site / creds are unavailable it BLOCKS (exit non-zero)
 * and says exactly what's missing — it never fakes a pass. Requires the `r2_bucket_manager` flag ON.
 *   node apps/project-sites/e2e/editor-live/check-owner-key-valid.mjs
 */
import { execSync } from 'node:child_process';
import { webcrypto as nodeCrypto } from 'node:crypto';
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const subtle = nodeCrypto.subtle;

function secret(name) {
  if (process.env[name]) return process.env[name];
  try {
    return (
      execSync(`/Users/Apple/.local/bin/get-secret ${name}`, { encoding: 'utf8', timeout: 5000 }).trim() ||
      null
    );
  } catch {
    return null;
  }
}

/** Exit honestly with a BLOCK verdict — the auth seam / test data wasn't available (NOT a pass). */
function block(reason) {
  console.log(`VERDICT: ⛔ BLOCKED — ${reason}`);
  console.log('(cannot prove credential validity without authenticated access to an owned site)');
  process.exitCode = 1;
}

// ── AWS SigV4 (region 'auto', service 's3') over Web Crypto — runs in NODE (cross-origin S3, no CORS) ──
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (data) =>
  hex(await subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(keyBytes, msg) {
  const k = await subtle.importKey('raw', keyBytes, { hash: 'SHA-256', name: 'HMAC' }, false, ['sign']);
  return subtle.sign('HMAC', k, enc.encode(msg));
}
/** Sign + send ONE ListObjectsV2 GET to R2 with the given creds. Returns the HTTP status (0 on net error). */
async function signedList(endpoint, bucket, creds) {
  const url = new URL(`${endpoint}/${bucket}`);
  const query = 'list-type=2&max-keys=1';
  url.search = query;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;
  const payloadHash = await sha256Hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  try {
    const res = await fetch(url.toString(), {
      headers: { authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate },
      method: 'GET',
    });
    return res.status;
  } catch {
    return 0; // network/DNS error — distinct from an HTTP status
  }
}
/** Retry a signed list until it reaches one of `wantStatuses` (fresh R2 tokens take seconds to propagate). */
async function signUntil(endpoint, bucket, creds, wantStatuses, tries = 5) {
  let status = 0;
  for (let i = 0; i < tries; i++) {
    status = await signedList(endpoint, bucket, creds);
    if (wantStatuses.includes(status)) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return status;
}

const apiKey = secret('E2E_API_KEY');
if (!apiKey) {
  block('E2E_API_KEY unavailable (env + get-secret both empty) — no authenticated owner identity.');
  process.exit(process.exitCode);
}

const browser = await launchLocalBrowser();
const page = await browser.newPage();
try {
  await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000); // CF managed-challenge solve → cf_clearance cookie

  // ── Phase 1 (IN-PAGE): auth → pick a site → resolve its bucket + endpoint → mint the owner key ──
  const setup = await page.evaluate(
    async ({ base, key }) => {
      const h = { Authorization: `Bearer ${key}` };
      const out = { steps: [] };
      const log = (s, v) => out.steps.push({ step: s, ...v });

      const sitesRes = await fetch(`${base}/api/sites?limit=20`, { headers: h });
      const sitesJson = await sitesRes.json().catch(() => ({}));
      const sites = sitesJson?.data?.sites ?? sitesJson?.sites ?? sitesJson?.data ?? [];
      log('listSites', { status: sitesRes.status, count: Array.isArray(sites) ? sites.length : 0 });
      if (sitesRes.status === 401) return { ...out, verdict: 'AUTH_401' };
      const site = Array.isArray(sites) ? sites.find((s) => s?.id) : null;
      if (!site) return { ...out, verdict: 'NO_SITE' };
      out.siteId = site.id;

      const bRes = await fetch(`${base}/api/sites/${site.id}/r2/buckets`, { headers: h });
      const bJson = await bRes.json().catch(() => ({}));
      const buckets = bJson?.data?.buckets ?? [];
      log('listBuckets', { status: bRes.status, buckets: buckets.map((x) => x.name) });
      if (bRes.status === 404) return { ...out, verdict: 'FLAG_DARK' };
      const bucketObj = buckets.find((x) => x?.address?.bucketName) ?? buckets[0];
      out.ownBucket = bucketObj?.address?.bucketName;
      out.endpoint = bucketObj?.address?.s3Endpoint;
      if (!out.ownBucket || !out.endpoint || out.endpoint.includes('<account-id>'))
        return { ...out, verdict: 'NO_BUCKET_OR_ENDPOINT' };

      const mkRes = await fetch(`${base}/api/sites/${site.id}/r2/keys`, { headers: h, method: 'POST' });
      const mkJson = await mkRes.json().catch(() => ({}));
      out.accessKeyId = mkJson?.data?.accessKeyId;
      out.secretAccessKey = mkJson?.data?.secretAccessKey;
      log('createKey', { status: mkRes.status, gotSecret: Boolean(out.secretAccessKey), reused: mkRes.status === 200 });
      if (mkRes.status === 503) return { ...out, verdict: 'NEEDS_CF_CREDS' };
      // A reused (masked) key carries no secret — rotate to force a fresh show-once secret we can sign with.
      if (!out.secretAccessKey) {
        const rotRes = await fetch(`${base}/api/sites/${site.id}/r2/keys/rotate`, { headers: h, method: 'POST' });
        const rotJson = await rotRes.json().catch(() => ({}));
        out.accessKeyId = rotJson?.data?.accessKeyId;
        out.secretAccessKey = rotJson?.data?.secretAccessKey;
        log('rotateForSecret', { status: rotRes.status, gotSecret: Boolean(out.secretAccessKey) });
      }
      if (!out.accessKeyId || !out.secretAccessKey) return { ...out, verdict: 'NO_SECRET_MINTED' };
      return { ...out, verdict: 'MINTED' };
    },
    { base: PROD_URL, key: apiKey },
  );

  for (const s of setup.steps) console.log('  ', JSON.stringify(s));

  if (setup.verdict !== 'MINTED') {
    const map = {
      AUTH_401: 'E2E_API_KEY did not authenticate (GET /api/sites → 401) — not the right key or expired.',
      FLAG_DARK: 'r2_bucket_manager flag is OFF for this org (buckets route 404) — enable it to test the owner key.',
      NEEDS_CF_CREDS: 'key mint returned 503 (no Cloudflare credentials server-side) — cannot mint a real CF token.',
      NO_SITE: 'the authenticated org owns no sites — nothing to mint an owner key against.',
      NO_BUCKET_OR_ENDPOINT: "could not resolve the site's own bucket + account S3 endpoint from the address bundle.",
      NO_SECRET_MINTED: 'POST /r2/keys (and rotate) returned no secretAccessKey — nothing to sign with.',
    };
    block(map[setup.verdict] ?? `unexpected setup state (${setup.verdict}).`);
    throw new Error('__handled__');
  }

  const creds = { accessKeyId: setup.accessKeyId, secretAccessKey: setup.secretAccessKey };
  const { endpoint, ownBucket, siteId } = setup;
  console.log(`[owner-key-valid] site=${siteId} ownBucket=${ownBucket} endpoint=${endpoint}`);

  // ── Phase 2 (NODE): sign real R2 S3 requests with the owner creds (cross-origin; no CORS wall) ──
  // 3. VALIDITY — 200 ListObjectsV2 on the site's OWN bucket proves the creds are real + usable.
  const validStatus = await signUntil(endpoint, ownBucket, creds, [200]);
  console.log('  ', JSON.stringify({ step: 'signOwnBucket', status: validStatus, valid: validStatus === 200 }));

  // 4. SCOPING (least privilege) — the SAME creds on a FORBIDDEN shared platform bucket must be DENIED (403).
  const FORBIDDEN = ['project-sites-production', 'project-sites-assets', 'project-sites'];
  let scopeStatus = 0;
  let forbiddenTried = '';
  for (const fb of FORBIDDEN) {
    forbiddenTried = fb;
    scopeStatus = await signedList(endpoint, fb, creds);
    if (scopeStatus === 403) break; // AccessDenied = the least-privilege signal we want
  }
  console.log('  ', JSON.stringify({ step: 'signForbiddenBucket', bucket: forbiddenTried, status: scopeStatus, scoped: scopeStatus === 403 }));

  // 5. REVOCATION — delete the key [in-page], then re-sign the OWN bucket → must now be DENIED (401/403).
  const delStatus = await page.evaluate(
    async ({ base, key, id }) => {
      const res = await fetch(`${base}/api/sites/${id}/r2/keys`, {
        headers: { Authorization: `Bearer ${key}` },
        method: 'DELETE',
      });
      return res.status;
    },
    { base: PROD_URL, id: siteId, key: apiKey },
  );
  console.log('  ', JSON.stringify({ step: 'revokeKey', status: delStatus }));
  const afterRevoke = await signUntil(endpoint, ownBucket, creds, [401, 403]);
  console.log('  ', JSON.stringify({ step: 'signAfterRevoke', status: afterRevoke, revoked: afterRevoke === 401 || afterRevoke === 403 }));

  const valid = validStatus === 200;
  const scoped = scopeStatus === 403;
  const revoked = afterRevoke === 401 || afterRevoke === 403;

  if (valid && scoped && revoked) {
    console.log(
      `VERDICT: ✅ DEFINITIVE — owner key is VALID (ListObjectsV2 200 on own bucket), SCOPED (403 on shared '${forbiddenTried}'), and REVOKED (${afterRevoke} after DELETE). The scoped R2 key works end-to-end + least-privilege + revocable.`,
    );
  } else {
    console.log(
      `VERDICT: ✗ PARTIAL — valid=${valid}(${validStatus}) scoped=${scoped}(${scopeStatus} on '${forbiddenTried}') revoked=${revoked}(${afterRevoke}). See steps above.`,
    );
    process.exitCode = 1;
  }
} catch (err) {
  if (!(err instanceof Error && err.message === '__handled__')) {
    block(`threw: ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  await browser.close();
}
