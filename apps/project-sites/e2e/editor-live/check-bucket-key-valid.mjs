/**
 * check-bucket-key-valid.mjs — DEFINITIVE prod proof that a PER-BUCKET owner-facing scoped R2 key
 * (Buckets B4) is a VALID, LEAST-PRIVILEGE, REVOCABLE credential scoped to exactly ONE of the site's
 * buckets. The route tests prove the HTTP contract; this proves what matters: the
 * `{accessKeyId, secretAccessKey}` the per-bucket endpoint hands an owner can really sign S3 requests
 * against Cloudflare R2 — and ONLY against THAT ONE bucket (not the site's other buckets, not the shared
 * platform buckets) — and stops working the instant it's revoked.
 *
 * Auth: ALL API calls (list sites / list buckets / mint / delete) go to the workers.dev origin
 * `https://project-sites.manhattan.workers.dev` with the `E2E_API_KEY` bearer. workers.dev is
 * CF-challenge-FREE (proven this session), so a plain node `fetch` with the bearer authenticates — unlike
 * the editor origin (`projectsites.dev`), whose in-page fetches get CF-bot-challenged (listSites 404). The
 * SigV4 S3 requests target a DIFFERENT origin (`{acct}.r2.cloudflarestorage.com`) and also run in node
 * (global fetch + Web Crypto; no CORS wall).
 *
 * Flow:
 *   1. auth as the owning org (E2E_API_KEY) + pick one of its OWN sites with ≥1 bucket   [workers.dev]
 *   2. POST .../r2/buckets/:bucket/keys → capture {accessKeyId, secretAccessKey}           [workers.dev]
 *   3. SigV4-sign ListObjectsV2 on THAT bucket with THOSE creds → 200 = VALID               [node → R2]
 *   4. SigV4-sign ListObjectsV2 on a DIFFERENT owned bucket (or shared platform) → 403 = SCOPED [node → R2]
 *   5. DELETE .../r2/buckets/:bucket/keys [workers.dev] → re-sign THAT bucket → 401/403 = REVOKED [node → R2]
 *
 * Honest by construction: if the auth seam / test site / a second bucket / creds are unavailable it
 * BLOCKS (exit non-zero) and says exactly what's missing — it never fakes a pass. Requires the
 * `r2_bucket_manager` flag ON.
 *   node apps/project-sites/e2e/editor-live/check-bucket-key-valid.mjs
 */
import { execSync } from 'node:child_process';
import { webcrypto as nodeCrypto } from 'node:crypto';

const API_ORIGIN = process.env.PS_WORKERS_DEV ?? 'https://project-sites.manhattan.workers.dev';
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
  console.log('(cannot prove per-bucket credential validity without an authenticated owned site + 2 buckets)');
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

// ── workers.dev API helper (bearer; challenge-free) ──────────────────────────────────────────────────
const apiKey = secret('E2E_API_KEY');
if (!apiKey) {
  block('E2E_API_KEY unavailable (env + get-secret both empty) — no authenticated owner identity.');
  process.exit(process.exitCode);
}
const H = { Authorization: `Bearer ${apiKey}` };
async function api(path, init = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  return { json, status: res.status };
}

async function main() {
  // 1. Pick an owned site.
  const sitesRes = await api('/api/sites?limit=20');
  if (sitesRes.status === 401) return block('E2E_API_KEY did not authenticate (GET /api/sites → 401).');
  const sites = sitesRes.json?.data?.sites ?? sitesRes.json?.sites ?? sitesRes.json?.data ?? [];
  const site = Array.isArray(sites) ? sites.find((s) => s?.id) : null;
  console.log('  ', JSON.stringify({ step: 'listSites', status: sitesRes.status, count: Array.isArray(sites) ? sites.length : 0 }));
  if (!site) return block('the authenticated org owns no sites — nothing to mint a per-bucket key against.');
  const siteId = site.id;

  // 2. List the site's OWN buckets. Need ≥1 for validity, ≥2 to prove cross-bucket scoping cleanly.
  const bRes = await api(`/api/sites/${siteId}/r2/buckets`);
  if (bRes.status === 404) return block('r2_bucket_manager / r2_buckets flag OFF (buckets route 404) — enable to test.');
  const buckets = (bRes.json?.data?.buckets ?? []).filter((x) => x?.name && x?.address?.bucketName);
  console.log('  ', JSON.stringify({ step: 'listBuckets', status: bRes.status, buckets: buckets.map((x) => x.name) }));
  if (buckets.length === 0) return block("the site has no resolvable buckets — nothing to scope a per-bucket key to.");

  const target = buckets[0];
  const endpoint = target.address.s3Endpoint;
  if (!endpoint || endpoint.includes('<account-id>'))
    return block("could not resolve the account S3 endpoint from the bucket address bundle.");
  const targetReal = target.address.bucketName;
  // A DIFFERENT bucket to prove scoping: a second OWNED bucket if present, else a shared platform bucket.
  const otherOwned = buckets[1];
  const otherBucket = otherOwned ? otherOwned.address.bucketName : 'project-sites-production';
  const otherLabel = otherOwned ? `owned '${otherOwned.name}'` : `shared '${otherBucket}'`;

  // 3. Mint the PER-BUCKET owner key for the target bucket (encode the display name in the path).
  const mkRes = await api(`/api/sites/${siteId}/r2/buckets/${encodeURIComponent(target.name)}/keys`, { method: 'POST' });
  console.log('  ', JSON.stringify({ step: 'createBucketKey', status: mkRes.status, gotSecret: Boolean(mkRes.json?.data?.secretAccessKey) }));
  if (mkRes.status === 503) return block('per-bucket key mint returned 503 (no Cloudflare credentials server-side).');
  let creds = { accessKeyId: mkRes.json?.data?.accessKeyId, secretAccessKey: mkRes.json?.data?.secretAccessKey };
  // A reused (masked) key carries no secret — rotate to force a fresh show-once secret we can sign with.
  if (!creds.secretAccessKey) {
    const rot = await api(`/api/sites/${siteId}/r2/buckets/${encodeURIComponent(target.name)}/keys/rotate`, { method: 'POST' });
    creds = { accessKeyId: rot.json?.data?.accessKeyId, secretAccessKey: rot.json?.data?.secretAccessKey };
    console.log('  ', JSON.stringify({ step: 'rotateForSecret', status: rot.status, gotSecret: Boolean(creds.secretAccessKey) }));
  }
  if (!creds.accessKeyId || !creds.secretAccessKey)
    return block('POST (and rotate) returned no secretAccessKey — nothing to sign with.');

  console.log(`[bucket-key-valid] site=${siteId} targetBucket=${targetReal} other=${otherBucket} endpoint=${endpoint}`);

  // 4. VALIDITY — 200 ListObjectsV2 on THE TARGET bucket proves the creds are real + usable.
  const validStatus = await signUntil(endpoint, targetReal, creds, [200]);
  console.log('  ', JSON.stringify({ step: 'signTargetBucket', status: validStatus, valid: validStatus === 200 }));

  // 5. SCOPING (least privilege) — the SAME creds on a DIFFERENT bucket must be DENIED (403).
  const scopeStatus = await signedList(endpoint, otherBucket, creds);
  console.log('  ', JSON.stringify({ step: 'signOtherBucket', bucket: otherBucket, status: scopeStatus, scoped: scopeStatus === 403 }));

  // 6. REVOCATION — delete the per-bucket key, then re-sign the target → must now be DENIED (401/403).
  const delRes = await api(`/api/sites/${siteId}/r2/buckets/${encodeURIComponent(target.name)}/keys`, { method: 'DELETE' });
  console.log('  ', JSON.stringify({ step: 'revokeBucketKey', status: delRes.status, revoked: delRes.json?.data?.revoked }));
  const afterRevoke = await signUntil(endpoint, targetReal, creds, [401, 403]);
  console.log('  ', JSON.stringify({ step: 'signAfterRevoke', status: afterRevoke, revoked: afterRevoke === 401 || afterRevoke === 403 }));

  const valid = validStatus === 200;
  const scoped = scopeStatus === 403;
  const revoked = afterRevoke === 401 || afterRevoke === 403;

  if (valid && scoped && revoked) {
    console.log(
      `VERDICT: ✅ DEFINITIVE — per-bucket key is VALID (ListObjectsV2 200 on '${targetReal}'), SCOPED (403 on ${otherLabel}), and REVOKED (${afterRevoke} after DELETE). The per-bucket R2 key works end-to-end + least-privilege + revocable.`,
    );
  } else {
    console.log(
      `VERDICT: ✗ PARTIAL — valid=${valid}(${validStatus}) scoped=${scoped}(${scopeStatus} on ${otherLabel}) revoked=${revoked}(${afterRevoke}). See steps above.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => block(`threw: ${err instanceof Error ? err.message : String(err)}`));
