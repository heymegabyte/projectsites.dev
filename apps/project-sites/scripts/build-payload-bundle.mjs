#!/usr/bin/env node
/**
 * build-payload-bundle.mjs — assemble the deployable Payload-on-CF artifact.
 *
 * The real Payload CMS is a Next 16 + OpenNext app: `.open-next/worker.js` is a 2 KB
 * entry that imports ~1829 modules — a Worker CANNOT esbuild that at request time. So
 * the runtime launcher deploys a PRE-BUNDLED single-file worker: `wrangler deploy
 * --dry-run --outdir` runs esbuild once and emits the final `worker.js` (~3.5 MB gzip)
 * plus a few binary/wasm modules. This script stages that output + the 84 static
 * assets + a manifest into ONE zip, which is stored in R2 (`payload-bundle/<ver>.zip`)
 * and read + uploaded per-instance by `cloudflare_provisioner` (assets-upload-session
 * + multipart script upload with the instance's D1/R2 bindings).
 *
 * Usage:
 *   node scripts/build-payload-bundle.mjs \
 *     --outdir /tmp/payload-bundle \                     # wrangler dry-run output
 *     --assets infra/payload-d1/.open-next/assets \      # OpenNext static assets
 *     --wrangler infra/payload-d1/wrangler.jsonc \       # compat_date + flags source
 *     --out /tmp/payload-bundle-v1.zip
 *
 * Produce the dry-run outdir first:
 *   (cd infra/payload-d1 && npx wrangler deploy --dry-run --outdir /tmp/payload-bundle)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const OUTDIR = arg('outdir', '/tmp/payload-bundle');
const ASSETS = arg('assets', 'infra/payload-d1/.open-next/assets');
const WRANGLER = arg('wrangler', 'infra/payload-d1/wrangler.jsonc');
const MIGRATIONS = arg('migrations', 'infra/payload-d1/src/migrations');
const OUT = arg('out', '/tmp/payload-bundle-v1.zip');

/**
 * Extract the raw DDL from Payload's `.ts` migrations (each statement is a
 * `db.run(sql`…`)` in `up()`). Template-literal backticks are escaped as \` — mask
 * them, match the sql template, restore. Concatenated in `index.ts` order so a fresh
 * D1 can be migrated via the D1 REST API at launch (no `payload migrate` CLI at runtime).
 */
function extractMigrationSql(dir) {
  const BT = '@@BT@@';
  const order = readFileSync(join(dir, 'index.ts'), 'utf8');
  // migration names in array order
  const names = [...order.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  const stmts = [];
  for (const name of names) {
    const raw = readFileSync(join(dir, `${name}.ts`), 'utf8');
    const up = raw.slice(
      raw.indexOf('export async function up'),
      raw.indexOf('export async function down'),
    );
    const masked = up.split('\\`').join(BT);
    const re = /sql`([\s\S]*?)`/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const sql = m[1].split(BT).join('`').trim().replace(/;\s*$/, '');
      if (sql) stmts.push(sql);
    }
  }
  return stmts.join(';\n') + ';\n';
}

/** Parse compat_date + flags out of the JSONC (strip // and block comments). */
function readCompat(path) {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1'); // strip JSONC trailing commas
  const json = JSON.parse(raw);
  return {
    compatibility_date: json.compatibility_date,
    compatibility_flags: json.compatibility_flags ?? [],
  };
}

/** Module content-type by extension — drives the multipart script-upload part type. */
function moduleType(file) {
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'application/javascript+module';
  return 'application/octet-stream';
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push(p);
  }
  return acc;
}

/** CF assets-upload-session hash: 32-hex (sha256 truncated to 16 bytes). */
function assetHash(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

const compat = readCompat(WRANGLER);
const stage = mkdtempSync(join(tmpdir(), 'payload-stage-'));
mkdirSync(join(stage, 'modules'), { recursive: true });
mkdirSync(join(stage, 'assets'), { recursive: true });

// 1. Main module + extra worker modules (everything in the outdir except the map/README).
cpSync(join(OUTDIR, 'worker.js'), join(stage, 'worker.js'));
const modules = [];
for (const f of readdirSync(OUTDIR)) {
  if (f === 'worker.js' || f === 'worker.js.map' || f === 'README.md') continue;
  if (statSync(join(OUTDIR, f)).isDirectory()) continue;
  cpSync(join(OUTDIR, f), join(stage, 'modules', f));
  modules.push({ name: f, type: moduleType(f) });
}

// 2. Static assets (served by the ASSETS binding) + their content hashes.
const assetFiles = walk(ASSETS);
const assetManifest = {};
for (const f of assetFiles) {
  const relPath = relative(ASSETS, f);
  const rel = '/' + relPath.split('\\').join('/');
  const buf = readFileSync(f);
  const dest = join(stage, 'assets', relPath);
  mkdirSync(join(dest, '..'), { recursive: true });
  cpSync(f, dest);
  assetManifest[rel] = { hash: assetHash(buf), size: buf.length };
}

// 3. Migration DDL — applied to each fresh D1 via D1 REST at launch (login-submit needs the tables).
const migrationSql = extractMigrationSql(MIGRATIONS);
writeFileSync(join(stage, 'migration.sql'), migrationSql);

// 4. Manifest — everything the runtime uploader needs, no re-derivation.
const manifest = {
  version: 'v1',
  main_module: 'worker.js',
  compatibility_date: compat.compatibility_date,
  compatibility_flags: compat.compatibility_flags,
  modules,
  assets: assetManifest,
  asset_count: assetFiles.length,
  has_migration: migrationSql.length > 0,
  built_from: 'infra/payload-d1 (Next 16 + OpenNext + Payload 3.82, webpack bundle)',
};
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 4. Zip the staging dir into ONE artifact for R2.
rmSync(OUT, { force: true });
execFileSync('zip', ['-r', '-q', OUT, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });

const size = statSync(OUT).size;
console.log(
  JSON.stringify(
    {
      out: OUT,
      zip_bytes: size,
      main_module: manifest.main_module,
      modules: modules.map((m) => `${m.name} (${m.type})`),
      asset_count: manifest.asset_count,
      compatibility_date: manifest.compatibility_date,
      compatibility_flags: manifest.compatibility_flags,
    },
    null,
    2,
  ),
);
console.log(`\nStore in R2:\n  npx wrangler r2 object put project-sites-production/payload-bundle/v1.zip --file ${OUT} --remote`);
