#!/usr/bin/env node
/**
 * deploy-payload-instance.mjs — deploy the REAL Payload OpenNext bundle to a CF
 * Worker via the raw multipart script-upload API (NOT the wrangler/opennext CLI).
 *
 * This is the REFERENCE IMPLEMENTATION for the runtime uploader that
 * `cloudflare_provisioner.provisionPayloadStack` will run inside the platform
 * Worker (swap the fs reads for `env.SITES_BUCKET.get(...)` + `fflate` unzip; the
 * CF API calls are identical). Proven here with real evidence first (fire-6 pattern).
 *
 * Steps:
 *   1. (optional) assets-upload-session → upload the 84 static assets → completion JWT.
 *   2. Multipart script upload: worker.js (main_module) + 3 binary modules + metadata
 *      (compat, bindings D1/R2/ASSETS/PAYLOAD_SECRET, assets JWT).
 *
 * Usage:
 *   node scripts/deploy-payload-instance.mjs \
 *     --bundle /tmp/payload-bundle \                 # dir with worker.js + hash-named modules
 *     --assets infra/payload-d1/.open-next/assets \  # (optional) static assets
 *     --name payload-test-xxxx --d1 <uuid> --r2 <bucket> --secret <hex> \
 *     [--namespace project-sites-endpoints]          # WfP dispatch (else standalone)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const A = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : d;
};
const ACCT = process.env.CF_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
const EMAIL = process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com';
const KEY = process.env.CLOUDFLARE_API_KEY;
const H = { 'X-Auth-Email': EMAIL, 'X-Auth-Key': KEY };
const BASE = 'https://api.cloudflare.com/client/v4';

const BUNDLE = A('bundle', '/tmp/payload-bundle');
const ASSETS = A('assets', '');
const NAME = A('name');
const D1 = A('d1');
const R2 = A('r2');
const SECRET = A('secret', 'devsecret');
const NS = A('namespace', '');

if (!NAME || !D1 || !R2) {
  console.error('need --name --d1 --r2');
  process.exit(2);
}
const scriptBase = NS
  ? `${BASE}/accounts/${ACCT}/workers/dispatch/namespaces/${NS}/scripts/${NAME}`
  : `${BASE}/accounts/${ACCT}/workers/scripts/${NAME}`;

const hash32 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 32);
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** Upload static assets via the assets-upload-session; return the completion JWT (or null). */
async function uploadAssets() {
  if (!ASSETS) return null;
  const files = walk(ASSETS);
  const manifest = {};
  const byHash = {};
  for (const f of files) {
    const rel = '/' + relative(ASSETS, f).split('\\').join('/');
    const buf = readFileSync(f);
    const h = hash32(buf);
    manifest[rel] = { hash: h, size: buf.length };
    byHash[h] = { buf, ct: rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : 'application/octet-stream' };
  }
  const start = await fetch(`${scriptBase}/assets-upload-session`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  const startJson = await start.json();
  if (!startJson.success) throw new Error('assets-upload-session: ' + JSON.stringify(startJson.errors));
  let jwt = startJson.result?.jwt;
  const buckets = startJson.result?.buckets ?? [];
  console.log(`  assets-upload-session: ${Object.keys(manifest).length} files, ${buckets.length} bucket(s) to upload`);
  for (const bucket of buckets) {
    const form = new FormData();
    for (const h of bucket) {
      const { buf, ct } = byHash[h];
      form.append(h, new Blob([buf.toString('base64')], { type: ct }), h);
    }
    const up = await fetch(`${BASE}/accounts/${ACCT}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    const upJson = await up.json();
    if (!upJson.success) throw new Error('assets upload: ' + JSON.stringify(upJson.errors));
    if (upJson.result?.jwt) jwt = upJson.result.jwt; // completion token on last bucket
  }
  return jwt;
}

/** Multipart script upload: main worker.js + hash-named modules + bindings. */
async function uploadScript(assetsJwt) {
  const modules = readdirSync(BUNDLE).filter((f) => f !== 'worker.js' && !f.endsWith('.map') && f !== 'README.md' && statSync(join(BUNDLE, f)).isFile());
  const bindings = [
    { type: 'd1', name: 'D1', id: D1 },
    { type: 'r2_bucket', name: 'R2', bucket_name: R2 },
    { type: 'plain_text', name: 'PAYLOAD_SECRET', text: SECRET },
  ];
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2025-08-15',
    compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    bindings,
  };
  if (assetsJwt) {
    bindings.push({ type: 'assets', name: 'ASSETS' });
    metadata.assets = { jwt: assetsJwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } };
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([readFileSync(join(BUNDLE, 'worker.js'))], { type: 'application/javascript+module' }), 'worker.js');
  for (const m of modules) {
    const ct = m.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    form.append(m, new Blob([readFileSync(join(BUNDLE, m))], { type: ct }), m);
  }
  const res = await fetch(scriptBase, { method: 'PUT', headers: H, body: form });
  const json = await res.json();
  if (!json.success) throw new Error('script upload: ' + JSON.stringify(json.errors));
  return true;
}

const jwt = await uploadAssets();
await uploadScript(jwt);
if (!NS) {
  // standalone: enable workers.dev so we can GET /admin directly
  await fetch(`${scriptBase}/subdomain`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
}
console.log(JSON.stringify({ deployed: NAME, namespace: NS || null, assets: jwt ? 'uploaded' : 'skipped' }));
