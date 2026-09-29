#!/usr/bin/env node
/**
 * Lane 7 — Validator false-positive AUDIT HARNESS.
 *
 * MUST run GREEN before flipping any org to `validator_strict`. Runs the 13 (30 total)
 * build validators from `src/services/build_validators.ts` against KNOWN-GOOD builds and
 * reports, per error CODE, which invariants would BLOCK a build in strict mode — i.e. the
 * candidate false-positives that the strict flip would wrongly reject.
 *
 * A build is "false-positive-clean" when `validateBuild(files).errors.length === 0`. Any
 * error-severity violation on a KNOWN-GOOD build is a false positive (exit non-zero).
 *
 * Modes (mutually exclusive):
 *   --fixture <dir>   OFFLINE. Load every file under <dir> recursively as the build's
 *                     file map, run validateBuild, print a per-CODE report.
 *   --slugs a,b,c     LIVE (needs CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL). Pull each
 *                     published site's built files from R2 `sites/{slug}/{version}/`
 *                     via the CF REST API and audit them; report per-validator how many
 *                     of the N sites each invariant would BLOCK.
 *   --help            Print usage.
 *
 * READ-ONLY against R2 — this NEVER mutates a published site. It only lists + GETs objects.
 *
 * Node ≥23 imports the `.ts` validator directly (`--experimental-strip-types`, on by
 * default in Node 23+). Run: `node scripts/audit-validator-false-positives.mjs --help`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── styled terminal output (gum-backed via style.sh, plain fallback / JSON-safe) ──────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c('1', s);
const cyan = (s) => c('36', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
/** All human/report output goes to STDERR so `--json` (future) keeps stdout clean. */
const say = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VALIDATOR_TS = join(HERE, '..', 'src', 'services', 'build_validators.ts');

// Text extensions mirror build_validators.ts isText() so we decode the same set the real
// R2 loader (loadBuildFromR2) decodes — binary files carry only their byte size.
const TEXT_EXTENSIONS = [
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.svg', '.webmanifest',
];
const isTextPath = (p) => TEXT_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e));

const USAGE = `
${bold('audit-validator-false-positives')} — Lane 7 strict-mode readiness gate

${bold('Usage')}
  node scripts/audit-validator-false-positives.mjs --fixture <dir>
  node scripts/audit-validator-false-positives.mjs --slugs <a,b,c> [--version <v>]
  node scripts/audit-validator-false-positives.mjs --help

${bold('Modes')}
  --fixture <dir>   Offline. Audit every file under <dir> as one build's file map.
  --slugs a,b,c     Live (needs CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL). Pull each
                    published site from R2 sites/{slug}/{version}/ and audit it.
  --version <v>     R2 version segment for --slugs (default: resolve _manifest.json,
                    else "current"). Applies to every slug.
  --bucket <name>   R2 bucket (default: project-sites-production).

${bold('Exit')}
  0  every audited KNOWN-GOOD build has ZERO blocking (error) violations.
  1  at least one build has a blocking error → a strict-flip false positive.
  2  usage / setup error (bad args, missing creds for --slugs, load failure).

${bold('Reads')}  ${dim('src/services/build_validators.ts')} (validateBuild)
${bold('R2')}     READ-ONLY — lists + GETs objects, never writes.
`;

function parseArgs(argv) {
  const out = { help: false, fixture: null, slugs: null, version: null, bucket: 'project-sites-production' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--slugs') out.slugs = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--bucket') out.bucket = argv[++i];
  }
  return out;
}

/**
 * Load the REAL `validateBuild` from build_validators.ts. esbuild-transpiles the `.ts` to ESM
 * (handles TS parameter properties Node's strip-only loader rejects) and imports via a data: URL.
 * Returns the function, or null (after logging) on failure.
 */
async function importValidateBuild() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    say(red('Failed to load esbuild (a dev dep) — run `npm install --legacy-peer-deps` first.'));
    return null;
  }
  let src;
  try {
    src = await readFile(VALIDATOR_TS, 'utf8');
  } catch (err) {
    say(red(`Failed to read ${VALIDATOR_TS}: ${err.message}`));
    return null;
  }
  try {
    const { code } = await esbuild.transform(src, {
      loader: 'ts',
      format: 'esm',
      target: 'es2022',
    });
    // The validator imports two sibling modules (theme_style.js / hero_copy.js) whose helpers
    // (commerceModeFor / heroCtasFor / trustBadgesFor) are used ONLY by scrubNonRetailCommerceCopy
    // — NEVER by validateBuild or any of its 30 validators. A data: URL module can't resolve those
    // relative specifiers, so REMOVE both imports and inject inert stubs ONCE at the top (injecting
    // per-line would duplicate the `const`s → SyntaxError). validateBuild is self-contained; the
    // stubs are never invoked in this audit path.
    const stubs =
      'const commerceModeFor = () => "general"; const heroCtasFor = () => ({ primary: "", secondary: "" }); const trustBadgesFor = () => ["", ""];\n';
    const standalone =
      stubs +
      code.replace(
        /^\s*import\s+\{[^}]*\}\s+from\s+["']\.\/(?:theme_style|hero_copy)\.js["'];?\s*$/gm,
        '',
      );
    const dataUrl = `data:text/javascript;base64,${Buffer.from(standalone, 'utf8').toString('base64')}`;
    const mod = await import(dataUrl);
    if (typeof mod.validateBuild !== 'function') {
      say(red('build_validators.ts did not export validateBuild.'));
      return null;
    }
    return mod.validateBuild;
  } catch (err) {
    say(red(`Failed to transpile/import build_validators.ts: ${err.message}`));
    return null;
  }
}

/** Recursively walk <dir>, returning BuildFile[] { path (dist-relative, /-normalized), text?, size }. */
async function loadFixtureDir(dir) {
  const root = dir;
  const files = [];
  async function walk(cur) {
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, abs).split(sep).join('/');
      const st = await stat(abs);
      let text;
      if (isTextPath(rel) && st.size < 1.5 * 1024 * 1024) {
        try {
          text = await readFile(abs, 'utf8');
        } catch {
          /* keep as binary */
        }
      }
      files.push({ path: rel, text, size: st.size });
    }
  }
  await walk(root);
  return files;
}

// ── CF REST R2 (read-only) — no R2Bucket binding available in a Node script ────────────────────
function cfHeaders() {
  const key = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com';
  if (!key) return null;
  return { 'X-Auth-Email': email, 'X-Auth-Key': key };
}
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/** List object keys under a prefix via the CF R2 REST API (paginated). READ-ONLY. */
async function r2List(bucket, prefix, headers) {
  const keys = [];
  let cursor;
  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects`,
    );
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('per_page', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { ...headers, 'User-Agent': REAL_UA } });
    if (!res.ok) throw new Error(`R2 list ${bucket} ${prefix} → HTTP ${res.status}`);
    const body = await res.json();
    for (const o of body.result ?? []) keys.push({ key: o.key, size: o.size ?? 0 });
    cursor = body.result_info?.cursor || undefined;
    if (!body.result_info?.is_truncated) cursor = undefined;
  } while (cursor);
  return keys;
}

/** GET one object's raw body via CF R2 REST. READ-ONLY. */
async function r2Get(bucket, key, headers) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { ...headers, 'User-Agent': REAL_UA } });
  if (!res.ok) throw new Error(`R2 get ${key} → HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Resolve the active version segment for a slug. Prod stores it in D1
 * `sites.current_build_version` (a timestamped path we can't read without a D1 binding), so this
 * creds-only harness resolves from R2 instead: prefer the top-level `sites/{slug}/_manifest.json`
 * `current_version`, else LIST `sites/{slug}/` and take the NEWEST timestamped version segment
 * (the `YYYY-MM-DDT…Z` dirs `site_serving` serves from). Falls back to 'current' if nothing found.
 */
async function resolveVersion(bucket, slug, headers) {
  try {
    const buf = await r2Get(bucket, `sites/${slug}/_manifest.json`, headers);
    const manifest = JSON.parse(new TextDecoder().decode(buf));
    const v = manifest.current_version || manifest.version || manifest.current;
    if (v) return v;
  } catch {
    /* no top-level manifest — fall through to prefix listing */
  }
  // List the slug prefix; collect the immediate child segments, keep timestamped versions.
  const objs = await r2List(bucket, `sites/${slug}/`, headers);
  const versions = new Set();
  for (const { key } of objs) {
    const seg = key.slice(`sites/${slug}/`.length).split('/')[0];
    // A version dir is an ISO-ish timestamp (2026-09-11T18-53-09-608Z). Exclude branches/_manifest/assets.
    if (/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(seg)) versions.add(seg);
  }
  if (versions.size === 0) return 'current';
  // Newest wins — timestamps sort lexicographically in chronological order.
  return [...versions].sort().at(-1);
}

/** Pull all files under sites/{slug}/{version}/ into BuildFile[] (text decoded, binaries size-only). */
async function loadSiteFromR2(bucket, slug, version, headers) {
  const prefix = `sites/${slug}/${version}/`;
  const objs = await r2List(bucket, prefix, headers);
  const decoder = new TextDecoder();
  const files = [];
  for (const { key, size } of objs) {
    const rel = key.startsWith(prefix) ? key.slice(prefix.length).replace(/^\/+/, '') : key;
    if (!rel) continue;
    let text;
    if (isTextPath(rel) && size < 1.5 * 1024 * 1024) {
      try {
        text = decoder.decode(await r2Get(bucket, key, headers));
      } catch {
        /* binary / fetch miss */
      }
    }
    files.push({ path: rel, size, text });
  }
  return files;
}

/** Print a per-CODE breakdown of one report; return { blocking, warning } counts. */
function reportOneBuild(label, report) {
  const errs = report.errors;
  const warns = report.warnings;
  const byCode = (list) => {
    const m = new Map();
    for (const v of list) m.set(v.code, (m.get(v.code) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  say('');
  say(bold(`── ${label} ──`));
  say(`  ${report.summary}`);
  if (errs.length === 0) {
    say(`  ${green('✔ 0 blocking errors')} — passes strict mode (no false positive)`);
  } else {
    say(`  ${red('✗ BLOCKING (would REJECT under strict):')}`);
    for (const [code, n] of byCode(errs)) {
      const sample = errs.find((e) => e.code === code);
      say(`    ${red('●')} ${bold(code)} ×${n}  ${dim((sample?.file ?? '').slice(0, 48))}`);
      say(`        ${dim((sample?.message ?? '').slice(0, 120))}`);
    }
  }
  if (warns.length > 0) {
    say(`  ${yellow('▲ advisory (warn, never blocks):')} ${byCode(warns).map(([code, n]) => `${code}×${n}`).join(', ')}`);
  }
  return { blocking: errs.length, warning: warns.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.fixture && !args.slugs)) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  if (args.fixture && args.slugs) {
    say(red('Error: pass EITHER --fixture OR --slugs, not both.'));
    process.exit(2);
  }

  // Import the real validator. Node's built-in TS loader is strip-ONLY and rejects
  // build_validators.ts's parameter property (BuildValidationStrictError). Transpile with
  // esbuild (a dev dep) → import via data: URL, so the harness always exercises the REAL
  // validateBuild regardless of the Node version's TS-loader quirks.
  const validateBuild = await importValidateBuild();
  if (!validateBuild) process.exit(2);

  say(cyan(bold('Validator false-positive audit — Lane 7 strict-mode readiness')));

  // Aggregate per-CODE blocking counts across ALL audited builds (the "which invariants would
  // BLOCK across N known-good sites" candidate-false-positive map). Counts BUILDS-blocked, not raw
  // violations: a code that fires 21× in ONE build still counts as blocking 1 build, so the
  // "blocks N/M" ratio reads as "this invariant would reject N of the M known-good sites".
  const blockingByCode = new Map();
  const bumpBlocking = (report) => {
    for (const code of new Set(report.errors.map((v) => v.code))) {
      blockingByCode.set(code, (blockingByCode.get(code) ?? 0) + 1);
    }
  };

  let auditedBuilds = 0;
  let buildsWithBlocking = 0;

  if (args.fixture) {
    let files;
    try {
      files = await loadFixtureDir(args.fixture);
    } catch (err) {
      say(red(`Failed to load fixture dir "${args.fixture}": ${err.message}`));
      process.exit(2);
    }
    if (files.length === 0) {
      say(red(`Fixture dir "${args.fixture}" is empty.`));
      process.exit(2);
    }
    say(dim(`  fixture: ${args.fixture} (${files.length} files)`));
    const report = validateBuild(files);
    const { blocking } = reportOneBuild(`fixture: ${args.fixture}`, report);
    bumpBlocking(report);
    auditedBuilds = 1;
    if (blocking > 0) buildsWithBlocking = 1;
  } else {
    const headers = cfHeaders();
    if (!headers) {
      say(red('Error: --slugs needs CLOUDFLARE_API_KEY (+ CLOUDFLARE_EMAIL) in the env.'));
      say(dim('  Live run needs R2 creds. Use --fixture <dir> for an offline audit.'));
      process.exit(2);
    }
    say(dim(`  bucket: ${args.bucket} · account: ${CF_ACCOUNT_ID}`));
    for (const slug of args.slugs) {
      let files;
      let version = args.version;
      try {
        if (!version) version = await resolveVersion(args.bucket, slug, headers);
        files = await loadSiteFromR2(args.bucket, slug, version, headers);
      } catch (err) {
        say(red(`  ${slug}: R2 load failed — ${err.message}`));
        continue;
      }
      if (files.length === 0) {
        say(yellow(`  ${slug}@${version}: no files under sites/${slug}/${version}/ — skipped`));
        continue;
      }
      const report = validateBuild(files);
      const { blocking } = reportOneBuild(`${slug}@${version} (${files.length} files)`, report);
      bumpBlocking(report);
      auditedBuilds++;
      if (blocking > 0) buildsWithBlocking++;
    }
    if (auditedBuilds === 0) {
      say(red('No sites loaded — nothing audited.'));
      process.exit(2);
    }
  }

  // Candidate-false-positive map: per invariant, how many known-good builds it would BLOCK.
  say('');
  say(bold('══ Candidate false-positives (blocking codes across audited known-good builds) ══'));
  if (blockingByCode.size === 0) {
    say(`  ${green(`✔ ZERO blocking codes across ${auditedBuilds} known-good build(s).`)}`);
    say(`  ${green('  Strict mode would reject none of them — safe to flip an org to validator_strict.')}`);
  } else {
    const rows = [...blockingByCode.entries()].sort((a, b) => b[1] - a[1]);
    for (const [code, n] of rows) {
      say(`  ${red('●')} ${bold(code)} — blocks ${red(`${n}/${auditedBuilds}`)} known-good build(s)`);
    }
    say('');
    say(`  ${red(`✗ ${buildsWithBlocking}/${auditedBuilds} known-good build(s) would be WRONGLY REJECTED under strict.`)}`);
    say(`  ${dim('  Loosen the threshold / add an exclusion for each code above BEFORE flipping strict.')}`);
  }

  say('');
  say(dim(`  audited=${auditedBuilds} withBlocking=${buildsWithBlocking} distinctBlockingCodes=${blockingByCode.size}`));
  process.exit(buildsWithBlocking > 0 ? 1 : 0);
}

main().catch((err) => {
  say(red(`Unexpected error: ${err?.stack || err}`));
  process.exit(2);
});
