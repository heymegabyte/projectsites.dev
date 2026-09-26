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
const { instance_id: iid, admin_url: adminUrl, url, resources = {} } = created;
console.log(`   instance_id=${iid} admin_url=${adminUrl}`);
console.log(`   resources=${JSON.stringify(resources)}`);
// WfP dispatch → a branded {slug}.(cms|app).projectsites.dev host when configured.
if (resources.dispatch_namespace && !/\.(cms|app)\.projectsites\.dev/.test(String(url))) {
  fail(`expected branded {slug}.(cms|app).projectsites.dev routing, got ${url}`);
}

console.log('2) GET /admin — poll for the REAL Payload upgrade (bootstrap → OpenNext, ≤90s)');
let adminCode = 0;
let realPayload = false;
let cssCode = 0;
for (let i = 0; i < 45; i++) {
  const res = await fetch(adminUrl).catch(() => null);
  adminCode = res?.status ?? 0;
  const body = res ? await res.text().catch(() => '') : '';
  // The bootstrap HTML says "Instance live"; the REAL Payload/Next admin references /_next/.
  realPayload = /\/_next\/(static|image)/.test(body);
  if (realPayload) {
    const css = body.match(/\/_next\/static\/css\/[a-f0-9]+\.css/);
    if (css) cssCode = await fetch(`${url}${css[0]}`).then((r) => r.status).catch(() => 0);
    break;
  }
  if (i === 0 && adminCode !== 200) {
    // even the bootstrap should 200 immediately; if not, propagation still settling
  }
  await sleep(2000);
}
console.log(`   admin=${adminCode} realPayload=${realPayload} cssAsset=${cssCode}`);
if (adminCode !== 200) {
  await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(() => {});
  fail(`admin page expected 200, got ${adminCode}`);
}
if (!realPayload) {
  await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(() => {});
  fail('real Payload admin never appeared (still bootstrap after 90s) — bundle deploy failed');
}
if (cssCode !== 200) {
  await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(() => {});
  fail(`Payload admin CSS asset expected 200, got ${cssCode} (assets-upload-session failed)`);
}
console.log('   ✓ REAL Payload login page live + assets served (200)');

// 2b) migration ground-truth: the instance's D1 must have the Payload tables.
if (CF_KEY && resources.d1_database_id) {
  let tables = [];
  for (let i = 0; i < 20; i++) {
    const q = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${resources.d1_database_id}/query`,
      {
        method: 'POST',
        headers: { ...cfHdr, 'content-type': 'application/json' },
        body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'payload%' OR name='users'" }),
      },
    ).then((r) => r.json()).catch(() => ({}));
    tables = q?.result?.[0]?.results?.map((r) => r.name) ?? [];
    if (tables.includes('users') && tables.some((t) => t.startsWith('payload'))) break;
    await sleep(3000);
  }
  console.log(`   D1 tables: ${tables.join(', ')}`);
  if (!tables.includes('users') || !tables.includes('payload_migrations')) {
    await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(() => {});
    fail(`D1 not migrated — missing payload tables (got: ${tables.join(',') || 'none'})`);
  }
  console.log('   ✓ D1 migrated (users + payload_* tables present) — login submit works');
}

// 2c) FUNCTIONAL /api/* dispatch — the exact create-first-user → login flow the
// admin drives. This is the guard that would have caught the routing regression:
// a dispatched instance's /api/* MUST reach the instance worker, not the platform
// /api router (which returns {"error":{"code":"NOT_FOUND","message":"Unknown API
// route"}} — see memory `payload-instance-api-preempted-by-platform-api-router`).
// A render-200 on /admin is NOT sufficient; the API must actually work.
{
  const email = `admin@${sub}.test`;
  const password = `Verify-${sub}-2026!`;
  const origin = new URL(url).origin;
  const reg = await fetch(`${url}/api/users/first-register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password, 'confirm-password': password }),
  });
  const regBody = await reg.json().catch(() => ({}));
  if (reg.status !== 200 || !regBody.token || !regBody.user) {
    await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(() => {});
    fail(
      `create-first-user expected 200 + token (was the platform /api router pre-empting the instance /api/*?), got ${reg.status} ${JSON.stringify(regBody)}`,
    );
  }
  const login = await fetch(`${url}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await login.json().catch(() => ({}));
  if (login.status !== 200 || !loginBody.token) {
    await fetch(`${WORKER}/api/apps/instances/${iid}`, { method: 'DELETE', headers: authed }).catch(() => {});
    fail(`login after first-register expected 200 + token, got ${login.status} ${JSON.stringify(loginBody)}`);
  }
  console.log('   ✓ create-first-user + login work (instance /api/* dispatches, not platform 404)');
}

console.log('3) DELETE (cascade D1 + R2 + Worker)');
const delRes = await fetch(`${WORKER}/api/apps/instances/${iid}`, {
  method: 'DELETE',
  headers: authed,
});
const del = await delRes.json().catch(() => ({}));
if (!del?.cleanup?.clean) fail(`delete expected cleanup.clean=true, got ${JSON.stringify(del)}`);
console.log(`   cleanup=${JSON.stringify(del.cleanup)}`);

console.log('4) independent CF-API confirm gone (worker + D1 + R2)');
if (CF_KEY && resources.worker_script_name) {
  const ns = resources.dispatch_namespace;
  // Namespace scripts GET-by-name spuriously returns 200 even when absent (fire-8 finding),
  // so confirm via the LIST endpoint (reliable). Standalone GET-by-name 404s correctly.
  let wCode;
  if (ns) {
    const list = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/dispatch/namespaces/${ns}/scripts`,
      { headers: cfHdr },
    ).then((r) => r.json()).catch(() => ({}));
    const present = (list?.result ?? []).some((s) => s.id === resources.worker_script_name);
    wCode = present ? 200 : 404;
  } else {
    wCode = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/${resources.worker_script_name}`,
      { headers: cfHdr },
    ).then((r) => r.status);
  }
  const dCode = resources.d1_database_id
    ? await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${resources.d1_database_id}`,
        { headers: cfHdr },
      ).then((r) => r.status)
    : 404;
  const rCode = resources.r2_bucket_name
    ? await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/${resources.r2_bucket_name}`,
        { headers: cfHdr },
      ).then((r) => r.status)
    : 404;
  console.log(`   worker=${wCode} d1=${dCode} r2=${rCode} (all expect 404)`);
  if (wCode !== 404) fail(`worker still exists after delete (${wCode})`);
  if (dCode !== 404) fail(`d1 still exists after delete (${dCode})`);
  if (rCode !== 404) fail(`r2 bucket still exists after delete (${rCode})`);
} else {
  console.log('   (no CF key or resource handles — DELETE cleanup report is authoritative)');
}

// Independent routing confirm: the instance is gone from the platform host.
// workers.dev edge keeps serving the last response for ~10-30s after a script delete,
// so poll for the drop (the CF-API 404s above already prove the resources are gone).
let postAdmin = 200;
for (let i = 0; i < 12; i++) {
  postAdmin = await fetch(adminUrl).then((r) => r.status).catch(() => 0);
  if (postAdmin !== 200) break;
  await sleep(5000);
}
console.log(`   admin after delete = ${postAdmin} (expect non-200, allowing edge propagation)`);
if (postAdmin === 200) fail('admin still 200 after delete + 60s — routing not torn down');

console.log('PASS: launch → 200 → delete → zero dangling');
