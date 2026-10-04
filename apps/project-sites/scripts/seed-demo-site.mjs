#!/usr/bin/env node
/**
 * seed-demo-site.mjs — IDEMPOTENT seed for the full-UI demo at
 * `projectsites.projectsites.dev` (DEMO-0, Brian directive).
 *
 * Provisions a published demo site at slug `projectsites` so the dot-based
 * subdomain `projectsites.projectsites.dev` resolves + serves it — WITHOUT the
 * unpaid top-bar (a `paid`/`active` subscription suppresses it).
 *
 * WHY each step exists (traced to serving code, read before writing):
 *   - `resolveSite` (src/services/site_serving.ts) resolves a dot-subdomain by
 *     `SELECT … FROM sites WHERE slug = ? AND deleted_at IS NULL`, then serves
 *     `sites/{slug}/{current_build_version}/{path}` from R2. So a site needs a
 *     `sites` row (status 'published', a non-null `current_build_version`) AND the
 *     bundle uploaded under that exact R2 prefix.
 *   - The top bar is injected for the FREE plan. `resolveSite` derives the plan via
 *     `resolveActiveOrgPlan(db, org_id)` (src/services/build_limits.ts) =
 *     `SELECT plan FROM subscriptions WHERE org_id = ? AND status IN ('active','trialing')`.
 *     So a `subscriptions` row {plan:'paid', status:'active'} ⇒ plan 'paid' ⇒ NO top bar.
 *   - `host:projectsites.projectsites.dev` is KV-cached 60s; we DELETE that key so
 *     the new/updated resolution is picked up immediately (never wait out the TTL).
 *   - `projectsites` is NOT in RESERVED_SLUGS ({editor,storybook,www,api,admin,
 *     staging,mail,smtp}) — confirmed; the GUARD below re-checks that at runtime and
 *     refuses if the set ever changes.
 *
 * REUSES the EXACT proven mechanisms (does NOT invent a parallel path):
 *   - D1 writes via the CF D1 REST `/query` API, global-key header pair
 *     (X-Auth-Email + X-Auth-Key) — same as scripts/backfill-wfp-slot.mjs.
 *   - R2 uploads via the CF R2 REST objects API (PUT …/r2/buckets/{bucket}/objects/{key})
 *     — same as scripts/upload-to-r2.mjs (incl. its MIME map + `_manifest.json`).
 *
 * FULLY IDEMPOTENT: every D1 write is `INSERT … ON CONFLICT … DO UPDATE` keyed on a
 * STABLE id/slug/org (no duplicate rows on re-run); every R2 object is overwritten by
 * key; the KV key is deleted (absence is idempotent). Re-running converges to the same
 * state.
 *
 * EDIT-ONLY / SAFE-BY-DEFAULT: `--dry-run` prints every step + the SQL/keys WITHOUT
 * touching prod. Without `--dry-run` it mutates prod D1 + R2 + KV — the LEAD runs that
 * after review (per DEMO-0 brief). Prints each step as it goes.
 *
 * Usage:
 *   node scripts/seed-demo-site.mjs --dry-run      # print plan, touch nothing
 *   node scripts/seed-demo-site.mjs                # ACTUALLY seed prod (lead runs this)
 *   node scripts/seed-demo-site.mjs --bundle ./demo-site   # custom bundle dir
 *   node scripts/seed-demo-site.mjs --slug projectsites --version v1
 *   node scripts/seed-demo-site.mjs --help
 *
 * Exit: 0 = dry-run printed OR seed succeeded; 1 = a step failed;
 *       2 = bad usage / missing credential / reserved slug / empty bundle.
 *
 * @module scripts/seed-demo-site
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Constants (prod, per apps/project-sites/CLAUDE.md § Cloudflare resource IDs) ───
const ACCOUNT_ID = '84fa0d1b16ff8086dd958c468ce7fd59';
const D1_DATABASE_ID = 'ea3e839a-c641-4861-ae30-dfc63bff8032'; // project-sites-db-production
const R2_BUCKET = 'project-sites-production';
const KV_NAMESPACE_ID = 'd4f48d52fbe14ccd884ea6dd368568ba'; // production CACHE_KV
const CF_API = 'https://api.cloudflare.com/client/v4';
const SITES_SUFFIX = '.projectsites.dev';
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// Stable identities — idempotency keys. Re-running UPSERTS these, never duplicates.
const DEMO_ORG_ID = 'org-demo-projectsites';
const DEMO_ORG_NAME = 'ProjectSites Demo';
const DEMO_ORG_SLUG = 'demo-projectsites'; // orgs.slug CHECK: length 3..63, UNIQUE
const DEMO_SITE_ID = 'site-demo-projectsites';
const DEMO_SITE_NAME = 'ProjectSites Demo';
// A deterministic Stripe-customer sentinel for the demo sub (NOT NULL column; never a real customer).
const DEMO_STRIPE_CUSTOMER = 'cus_demo_projectsites';

// RESERVED_SLUGS mirror of src/services/site_serving.ts (keep in sync — guard re-checks).
const RESERVED_SLUGS = new Set([
  'editor',
  'storybook',
  'www',
  'api',
  'admin',
  'staging',
  'mail',
  'smtp',
]);

// MIME map mirrors scripts/upload-to-r2.mjs (single source of content-type truth).
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

// ─── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'seed-demo-site.mjs — idempotent seed for projectsites.projectsites.dev (DEMO-0).',
      '',
      'Usage: node scripts/seed-demo-site.mjs [--dry-run] [--bundle <dir>] [--slug <s>] [--version <v>]',
      '  --dry-run            print every step + SQL/keys, touch NOTHING (safe)',
      '  --bundle <dir>       bundle dir to upload (default: apps/project-sites/demo-site)',
      '  --slug <slug>        demo slug (default: projectsites)',
      '  --version <v>        build version / R2 prefix (default: v1)',
      '  --help               show this help',
      '',
      'Without --dry-run this mutates prod D1 + R2 + KV. The LEAD runs it after review.',
      'Idempotent: D1 upserts on stable id/slug/org, R2 overwrites by key, KV key deleted.',
    ].join('\n'),
  );
  process.exit(0);
}
const hasFlag = (f) => argv.includes(f);
const flagVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DRY_RUN = hasFlag('--dry-run');
const SLUG = flagVal('--slug', 'projectsites');
const VERSION = flagVal('--version', 'v1');

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default bundle = apps/project-sites/demo-site (sibling agent builds it). scripts/ is under apps/project-sites.
const BUNDLE_DIR = resolvePath(flagVal('--bundle', join(__dirname, '..', 'demo-site')));

function die(msg, code = 2) {
  console.error(`FATAL: ${msg}`);
  process.exit(code);
}
let step = 0;
function logStep(msg) {
  step += 1;
  console.log(`\n[${step}] ${DRY_RUN ? 'DRY-RUN ' : ''}${msg}`);
}

// ─── GUARD: refuse a reserved slug (serving would never resolve it as a site) ───
if (RESERVED_SLUGS.has(SLUG)) {
  die(
    `slug "${SLUG}" is in RESERVED_SLUGS — resolveSite() will NOT resolve it as a site. ` +
      `The seed is BLOCKED. (RESERVED_SLUGS: ${[...RESERVED_SLUGS].join(', ')})`,
    2,
  );
}
if (!/^[a-z0-9-]{3,63}$/.test(SLUG)) {
  die(`slug "${SLUG}" fails the sites.slug CHECK (lowercase [a-z0-9-], length 3..63).`, 2);
}

// ─── Credentials (via get-secret; never inline) ────────────────────────────────
/** Read a secret via the get-secret CLI, falling back to env. */
function getSecret(key) {
  try {
    return execFileSync('/Users/Apple/.local/bin/get-secret', [key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.env[key] || '';
  }
}
const CF_EMAIL = getSecret('CLOUDFLARE_EMAIL') || 'blzalewski@gmail.com';
const CF_KEY = getSecret('CLOUDFLARE_API_KEY');
if (!DRY_RUN && !CF_KEY) {
  die('CLOUDFLARE_API_KEY unavailable (get-secret CLOUDFLARE_API_KEY) — needed for prod writes.');
}
const CF_HEADERS = {
  'X-Auth-Email': CF_EMAIL,
  'X-Auth-Key': CF_KEY,
  'User-Agent': REAL_UA,
};

// ─── D1 helper (CF REST /query, single-statement, parameterized) ────────────────
/**
 * Execute ONE parameterized SQL statement against prod D1 via the CF REST /query API.
 * In --dry-run, prints the SQL + params and returns a stub (no network).
 */
async function d1(sql, params = []) {
  if (DRY_RUN) {
    console.log(`    SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
    if (params.length) console.log(`    params: ${JSON.stringify(params)}`);
    return { success: true, result: [{ results: [] }] };
  }
  const res = await fetch(`${CF_API}/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { ...CF_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    const errs = Array.isArray(json?.errors)
      ? json.errors.map((e) => e.message || JSON.stringify(e)).join('; ')
      : `HTTP ${res.status}`;
    die(`D1 query failed (${res.status}): ${errs}\n  SQL: ${sql}`, 1);
  }
  return json;
}

// ─── R2 helper (CF REST objects API, PUT by key) ────────────────────────────────
/** PUT one object into the prod R2 bucket. In --dry-run, prints the key + size only. */
async function r2Put(key, body, contentType) {
  if (DRY_RUN) {
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    console.log(`    R2 PUT ${key}  (${contentType}, ${size} B)`);
    return true;
  }
  const url = `${CF_API}/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(
    key,
  )}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...CF_HEADERS, 'Content-Type': contentType },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    die(`R2 PUT failed ${key}: ${res.status} ${text.slice(0, 200)}`, 1);
  }
  return true;
}

// ─── Bundle walk (mirrors upload-to-r2.mjs: skip _-prefixed / vcs / node_modules) ─
function collectFiles(dir, base = '') {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_') || entry === 'node_modules' || entry === '.git' || entry === '.claude')
      continue;
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    const st = statSync(full);
    if (st.isDirectory()) files.push(...collectFiles(full, rel));
    else if (st.isFile() && st.size > 0 && st.size < 10_000_000) files.push({ full, rel, size: st.size });
  }
  return files;
}
function mimeFor(rel) {
  return MIME_TYPES[extname(rel).toLowerCase()] || 'application/octet-stream';
}

// ─── Steps ──────────────────────────────────────────────────────────────────────
async function upsertOrg() {
  logStep(`Upsert demo org (${DEMO_ORG_ID}, slug "${DEMO_ORG_SLUG}")`);
  // orgs NOT-NULL: id, name, slug. timestamps auto-default. updated_at bumped on conflict.
  await d1(
    `INSERT INTO orgs (id, name, slug)
       VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       deleted_at = NULL`,
    [DEMO_ORG_ID, DEMO_ORG_NAME, DEMO_ORG_SLUG],
  );
}

async function upsertSubscription() {
  logStep(`Upsert PAID/active subscription for demo org (suppresses the unpaid top bar)`);
  // subscriptions: org_id is UNIQUE → conflict target. NOT-NULL: id, org_id, stripe_customer_id,
  // plan, status. plan='paid' + status='active' ⇒ resolveActiveOrgPlan → 'paid' ⇒ NO top bar.
  await d1(
    `INSERT INTO subscriptions (id, org_id, stripe_customer_id, plan, status)
       VALUES (?, ?, ?, 'paid', 'active')
     ON CONFLICT(org_id) DO UPDATE SET
       plan = 'paid',
       status = 'active',
       stripe_customer_id = excluded.stripe_customer_id,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       deleted_at = NULL`,
    [`sub-demo-projectsites`, DEMO_ORG_ID, DEMO_STRIPE_CUSTOMER],
  );
}

async function preflightSlugConflict() {
  // sites.slug is UNIQUE. If a DIFFERENT site id already holds this slug, the ON CONFLICT(id)
  // upsert below would hit a UNIQUE(slug) violation. Detect + fail loudly (never clobber a real site).
  logStep(`Preflight: ensure slug "${SLUG}" is free or owned by ${DEMO_SITE_ID}`);
  const json = await d1(
    'SELECT id FROM sites WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
    [SLUG],
  );
  if (DRY_RUN) return;
  const row = json?.result?.[0]?.results?.[0];
  if (row && row.id && row.id !== DEMO_SITE_ID) {
    die(
      `slug "${SLUG}" is already owned by a DIFFERENT site (id=${row.id}). ` +
        `Refusing to clobber it. Pick another --slug or remove that site first.`,
      1,
    );
  }
}

async function upsertSite() {
  logStep(`Upsert published site row (slug "${SLUG}", version "${VERSION}", status published)`);
  // sites NOT-NULL: id, org_id, slug, business_name, status. current_build_version drives serving.
  await d1(
    `INSERT INTO sites (id, org_id, slug, business_name, status, current_build_version)
       VALUES (?, ?, ?, ?, 'published', ?)
     ON CONFLICT(id) DO UPDATE SET
       org_id = excluded.org_id,
       slug = excluded.slug,
       business_name = excluded.business_name,
       status = 'published',
       current_build_version = excluded.current_build_version,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       deleted_at = NULL`,
    [DEMO_SITE_ID, DEMO_ORG_ID, SLUG, DEMO_SITE_NAME, VERSION],
  );
}

async function uploadBundle() {
  logStep(`Upload bundle → R2 sites/${SLUG}/${VERSION}/  (from ${BUNDLE_DIR})`);
  if (!existsSync(BUNDLE_DIR) || !statSync(BUNDLE_DIR).isDirectory()) {
    die(
      `bundle dir not found: ${BUNDLE_DIR}\n` +
        `A sibling agent builds apps/project-sites/demo-site/ — run that first, or pass --bundle <dir>.`,
      2,
    );
  }
  // If the bundle has a dist/ (Vite build output), serve that; else serve the dir itself.
  const distDir = join(BUNDLE_DIR, 'dist');
  const sourceDir =
    existsSync(distDir) && statSync(distDir).isDirectory() ? distDir : BUNDLE_DIR;
  const files = collectFiles(sourceDir);
  if (files.length === 0) {
    die(`bundle dir ${sourceDir} has no uploadable files (empty). Build the demo site first.`, 2);
  }
  if (!files.some((f) => f.rel === 'index.html')) {
    console.warn(
      `    WARN: no index.html at the bundle root — serving "/" would 404 until one exists.`,
    );
  }
  console.log(`    ${files.length} file(s) from ${sourceDir}`);
  const manifest = {
    slug: SLUG,
    current_version: VERSION,
    is_vite_project: sourceDir === distDir,
    building: false,
    uploaded_at: new Date().toISOString(),
    files: [],
  };
  for (const f of files) {
    const key = `sites/${SLUG}/${VERSION}/${f.rel}`;
    const ct = mimeFor(f.rel);
    await r2Put(key, readFileSync(f.full), ct);
    manifest.files.push({ name: f.rel, size: f.size, type: ct });
  }
  // _manifest.json mirrors upload-to-r2.mjs (resolveSite's R2 bolt-fallback + tooling read it).
  await r2Put(
    `sites/${SLUG}/${VERSION}/_manifest.json`,
    JSON.stringify(manifest, null, 2),
    'application/json',
  );
  console.log(`    uploaded ${files.length} file(s) + _manifest.json`);
}

async function invalidateKv() {
  const host = `${SLUG}${SITES_SUFFIX}`;
  const key = `host:${host}`;
  logStep(`KV invalidate ${key} (so resolveSite picks up the seed immediately, not after 60s TTL)`);
  if (DRY_RUN) {
    console.log(`    KV DELETE ${key} (namespace ${KV_NAMESPACE_ID})`);
    return;
  }
  const url = `${CF_API}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(
    key,
  )}`;
  const res = await fetch(url, { method: 'DELETE', headers: CF_HEADERS });
  // 404 = key absent = already-invalid = fine. Any other non-2xx is a real failure.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    die(`KV delete failed ${key}: ${res.status} ${text.slice(0, 200)}`, 1);
  }
  console.log(`    KV key cleared (status ${res.status})`);
}

async function main() {
  console.log(
    `seed-demo-site — slug "${SLUG}" → https://${SLUG}${SITES_SUFFIX}  ` +
      `(${DRY_RUN ? 'DRY-RUN — no changes' : 'LIVE — mutating prod'})`,
  );
  // Order: org → subscription → (preflight) site → bundle → KV.
  // Org before site (FK sites.org_id → orgs.id). Subscription before/with site (plan read on serve).
  await upsertOrg();
  await upsertSubscription();
  await preflightSlugConflict();
  await upsertSite();
  await uploadBundle();
  await invalidateKv();

  console.log(
    `\n✅ ${DRY_RUN ? 'DRY-RUN complete (nothing changed)' : 'Seed complete'} — ` +
      `${DRY_RUN ? 'would serve' : 'serving'} https://${SLUG}${SITES_SUFFIX}  (paid plan → no top bar).`,
  );
  if (!DRY_RUN) {
    console.log(
      `   Verify: curl -sS -o /dev/null -w '%{http_code}\\n' https://${SLUG}${SITES_SUFFIX}/  (expect 200)`,
    );
  }
}

main().catch((err) => {
  console.error('[seed-demo-site] Fatal:', err?.message || err);
  process.exit(1);
});
