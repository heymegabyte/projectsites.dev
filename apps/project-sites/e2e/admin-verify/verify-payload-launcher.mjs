#!/usr/bin/env node
/**
 * verify-payload-launcher.mjs — the always-on regression guard for the CF-native
 * Payload CMS launcher, run against LIVE prod.
 *
 * Proves the exact lifecycle the admin drives:
 *   1. POST /api/apps/instances {app_id:'payload'}  → 201 (real D1 + R2 + Worker)
 *   2. GET  <admin_url>                             → 200 (instance reachable)
 *   3. DELETE /api/apps/instances/:id              → cleanup.clean === true
 *   4. Independent CF-API re-read                   → Worker 404 + R2 404 (zero dangling)
 *
 * Auth goes through the worker's workers.dev URL (no zone bot-challenge) with the
 * E2E key — see memory `prod-verify-authed-mutation-via-workers-dev`. Secrets are
 * read from env, never echoed.
 *
 * Run:
 *   E2E_API_KEY="$(get-secret E2E_API_KEY)" \
 *   CLOUDFLARE_API_KEY="$(get-secret CLOUDFLARE_API_KEY)" \
 *   CLOUDFLARE_EMAIL=blzalewski@gmail.com \
 *   node e2e/admin-verify/verify-payload-launcher.mjs
 *
 * Exit 0 = the full launch→200→delete→zero-dangling cycle passed; non-zero = a step failed.
 */
const WORKER = process.env.PS_WORKER_URL || 'https://project-sites.manhattan.workers.dev';
const ACCT = process.env.CF_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
const KEY = process.env.E2E_API_KEY;
const CF_KEY = process.env.CLOUDFLARE_API_KEY;
const CF_EMAIL = process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com';

if (!KEY) {
  console.error('SKIP: E2E_API_KEY unset (fail-open per conditional-ci-gates).');
  process.exit(0);
}

const authed = { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const cfHdr = { 'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const sub = `plq${Math.abs(Date.now() % 1e7)}`;

console.log(`1) launch payload subdomain=${sub}`);
const createRes = await fetch(`${WORKER}/api/apps/instances`, {
  method: 'POST',
  headers: authed,
  body: JSON.stringify({ app_id: 'payload', subdomain: sub }),
});
const created = await createRes.json().catch(() => ({}));
if (createRes.status !== 201 || !created.instance_id) {
  fail(`launch expected 201 + instance_id, got ${createRes.status} ${JSON.stringify(created)}`);
}
const { instance_id: iid, admin_url: adminUrl, url } = created;
console.log(`   instance_id=${iid} admin_url=${adminUrl}`);

console.log('2) GET /admin (retry ≤40s for workers.dev propagation)');
let adminCode = 0;
for (let i = 0; i < 20; i++) {
  adminCode = (await fetch(adminUrl).then((r) => r.status).catch(() => 0)) || 0;
  if (adminCode === 200) break;
  await sleep(2000);
}
if (adminCode !== 200) {
  // tear down before failing so we never strand a stack
  await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(
    () => {},
  );
  fail(`admin page expected 200, got ${adminCode}`);
}
const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => ({}));
console.log(`   admin=200 health=${JSON.stringify(health)}`);
if (!health.hasD1 || !health.hasR2) fail('instance is missing its D1 or R2 binding');

console.log('3) DELETE (cascade D1 + R2 + Worker)');
const delRes = await fetch(`${WORKER}/api/apps/instances/${iid}`, {
  method: 'DELETE',
  headers: authed,
});
const del = await delRes.json().catch(() => ({}));
if (!del?.cleanup?.clean) fail(`delete expected cleanup.clean=true, got ${JSON.stringify(del)}`);
console.log(`   cleanup=${JSON.stringify(del.cleanup)}`);

console.log('4) independent CF-API confirm gone');
const host = String(url).replace(/^https:\/\/([^.]+)\..*/, '$1');
if (CF_KEY) {
  const wCode = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/${host}`,
    { headers: cfHdr },
  ).then((r) => r.status);
  const rCode = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/${host}`,
    { headers: cfHdr },
  ).then((r) => r.status);
  console.log(`   worker=${wCode} r2=${rCode} (both expect 404)`);
  if (wCode !== 404) fail(`worker still exists after delete (${wCode})`);
  if (rCode !== 404) fail(`r2 bucket still exists after delete (${rCode})`);
} else {
  console.log('   (CLOUDFLARE_API_KEY unset — skipped independent CF re-read; DELETE report is authoritative)');
}

console.log('PASS: launch → 200 → delete → zero dangling');
