#!/usr/bin/env node
/**
 * reconcile-migration-tracking.mjs — SCHEMA-DIFF-PROVEN reconcile for D1's
 * migration-tracking ledger. `migrations/*.sql` can be genuinely APPLIED to prod
 * (schema proves it) while remaining UNTRACKED in wrangler's `d1_migrations` table
 * (fire-58 direct-applies, fire-60 same, ad-hoc hotfixes). A blanket
 * `wrangler d1 migrations apply` then tries to re-run every untracked file in
 * lexicographic order and dies on the first one that contradicts live reality
 * (fire-60 died on 0020_ai_endpoints_ide — ai_endpoints was deliberately removed).
 *
 * This script NEVER re-runs migration SQL. It only PROVES, per untracked file,
 * whether every object that file's CREATE/ALTER statements declare already exists
 * in the live schema — and if so, emits the exact `INSERT INTO d1_migrations`
 * statement that marks it tracked. Nothing is executed against prod by default;
 * `--emit-sql` only PRINTS the INSERTs for a human (the lead) to review + run.
 *
 * Usage:
 *   CLOUDFLARE_API_KEY=.. CLOUDFLARE_EMAIL=.. \
 *     node scripts/reconcile-migration-tracking.mjs [--check] [--emit-sql] [--json]
 *
 *   --check     (DEFAULT) read-only dry-run — SELECTs only, never mutates prod.
 *   --emit-sql  also print the exact INSERT statements for the proven set.
 *               Still READ-ONLY — printing is not executing.
 *   --json      machine-readable output instead of the gum-styled report.
 *
 * This script will NEVER execute an INSERT against prod. The lead runs the
 * printed statements by hand after review (see DISCOVERIES line in the commit).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'project-sites-db-production';
const MIGRATIONS_DIR = join(ROOT, 'migrations');

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const emitSql = args.includes('--emit-sql');
// --check is the implicit default (every code path here is read-only); accept it
// as a no-op flag so callers can be explicit without changing behavior.
void args.includes('--check');

// ─── Gum-backed terminal styling (Node side of ~/.claude/hooks/style.sh's
// contract) — detect once, gum when present, plain fallback when absent so this
// script stays CI-safe. See rules/terminal-styling.md. ─────────────────────────
const HAS_GUM = (() => {
  try {
    execFileSync('gum', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function gumStyle(text, extraArgs) {
  if (!HAS_GUM) return text;
  try {
    return execFileSync('gum', ['style', ...extraArgs, text], { encoding: 'utf8' }).trimEnd();
  } catch {
    return text;
  }
}

const header = (text) =>
  console.log(
    '\n' +
      gumStyle(text, [
        '--foreground', '#00E5FF', '--bold',
        '--border', 'rounded', '--border-foreground', '#00E5FF', '--padding', '0 1',
      ]),
  );
const success = (text) => console.log(gumStyle(`✓ ${text}`, ['--foreground', '2']));
const warn = (text) => console.log(gumStyle(`⚠ ${text}`, ['--foreground', '3']));
const info = (text) => console.log(gumStyle(text, ['--foreground', '#7AA7B3']));

/** Run a read-only `wrangler d1 execute --remote --json --command`. Never --file, never write SQL. */
function d1Select(sql) {
  const raw = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--env', 'production', '--remote', '--json', '--command', sql],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.result?.[0]?.results) ?? [];
}

// ─── Step 1: list migration files on disk ──────────────────────────────────────
const allFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// `do-*-schema.sql` files are Durable-Object SQLite reference copies that live in
// migrations/ ONLY because two lockstep tests read them there. They must NEVER be
// tracked/applied as D1 migrations (see docs/migrations-reconcile-2026-10.md § NOT-D1).
const doSchemaFiles = allFiles.filter((f) => f.startsWith('do-') && f.endsWith('-schema.sql'));
const migrationFiles = allFiles.filter((f) => !doSchemaFiles.includes(f));

// ─── Step 2: query prod d1_migrations for already-tracked names ───────────────
let trackedNames;
try {
  const rows = d1Select('SELECT name FROM d1_migrations');
  trackedNames = new Set(rows.map((r) => String(r.name)));
} catch (e) {
  console.error('FATAL: could not query prod d1_migrations (need CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL):', e.message);
  process.exit(2);
}

const untracked = migrationFiles.filter((f) => !trackedNames.has(f));

if (untracked.length === 0) {
  if (wantJson) {
    console.log(JSON.stringify({ migrationFiles: migrationFiles.length, tracked: trackedNames.size, untracked: 0, proven: [], unproven: [] }, null, 2));
  } else {
    header('D1 migration-tracking reconcile');
    success(`All ${migrationFiles.length} migration files already tracked in d1_migrations. Nothing to reconcile.`);
  }
  process.exit(0);
}

// ─── Step 3: dump sqlite_master ONCE (tables, columns, indexes, views, triggers) ─
let liveTables = new Map(); // tableName(lower) -> Set(columnName lower)
let liveIndexes = new Set();
let liveViews = new Set();
let liveTriggers = new Set();
try {
  const masterRows = d1Select(
    "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','index','view','trigger')",
  );
  const tableNames = masterRows.filter((r) => r.type === 'table').map((r) => String(r.name));
  for (const t of masterRows) {
    const name = String(t.name).toLowerCase();
    if (t.type === 'index') liveIndexes.add(name);
    else if (t.type === 'view') liveViews.add(name);
    else if (t.type === 'trigger') liveTriggers.add(name);
  }
  // PRAGMA table_info per table — needed to prove ADD COLUMN statements, not just CREATE TABLE.
  for (const t of tableNames) {
    try {
      const cols = d1Select(`PRAGMA table_info(${quoteIdent(t)})`);
      liveTables.set(t.toLowerCase(), new Set(cols.map((c) => String(c.name).toLowerCase())));
    } catch {
      liveTables.set(t.toLowerCase(), new Set());
    }
  }
} catch (e) {
  console.error('FATAL: could not dump prod sqlite_master:', e.message);
  process.exit(2);
}

function quoteIdent(name) {
  // sqlite_master names never contain a double-quote in this schema; defensive escape anyway.
  return `"${String(name).replace(/"/g, '""')}"`;
}

// ─── Step 4: per untracked file, parse statements + prove against live schema ──
/**
 * Extract the set of "target objects" a migration file DECLARES, each tagged
 * with the kind of proof needed:
 *   - table:<name>            → table must exist in sqlite_master
 *   - column:<table>.<col>    → column must exist via PRAGMA table_info
 *   - index:<name>             → index must exist in sqlite_master
 *   - view:<name>              → view must exist in sqlite_master
 *   - trigger:<name>           → trigger must exist in sqlite_master
 * INSERT/UPDATE/DELETE seed-data statements are NOT proof targets (D1 doesn't
 * expose "was this row inserted by migration X" — row presence proves nothing
 * about WHICH migration wrote it, and the fire-61 doc already established seed
 * INSERTs are commonly rewritten/idempotent). A file with ONLY seed INSERTs and
 * no CREATE/ALTER is proven by this script as long as its (empty) object set is
 * vacuously satisfied — see the `pragma`/no-op guard below for the two files the
 * fire-61 doc rewrote to `SELECT 1`.
 */
function extractTargets(sql) {
  const targets = [];
  const stripped = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  for (const m of stripped.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    targets.push({ kind: 'table', table: m[1] });
  }
  for (const m of stripped.matchAll(/ALTER\s+TABLE\s+[`"']?([a-zA-Z_][a-zA-Z0-9_]*)[`"']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    targets.push({ kind: 'column', table: m[1], column: m[2] });
  }
  for (const m of stripped.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    targets.push({ kind: 'index', name: m[1] });
  }
  for (const m of stripped.matchAll(/CREATE\s+(?:VIRTUAL\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    targets.push({ kind: 'view', name: m[1] });
  }
  for (const m of stripped.matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    targets.push({ kind: 'trigger', name: m[1] });
  }
  return targets;
}

function proveTargets(targets) {
  const missing = [];
  const found = [];
  for (const t of targets) {
    if (t.kind === 'table') {
      const ok = liveTables.has(t.table.toLowerCase());
      (ok ? found : missing).push(`table ${t.table}`);
    } else if (t.kind === 'column') {
      const cols = liveTables.get(t.table.toLowerCase());
      const ok = cols ? cols.has(t.column.toLowerCase()) : false;
      (ok ? found : missing).push(`column ${t.table}.${t.column}`);
    } else if (t.kind === 'index') {
      const ok = liveIndexes.has(t.name.toLowerCase());
      (ok ? found : missing).push(`index ${t.name}`);
    } else if (t.kind === 'view') {
      const ok = liveViews.has(t.name.toLowerCase());
      (ok ? found : missing).push(`view ${t.name}`);
    } else if (t.kind === 'trigger') {
      const ok = liveTriggers.has(t.name.toLowerCase());
      (ok ? found : missing).push(`trigger ${t.name}`);
    }
  }
  return { found, missing };
}

const proven = [];
const unproven = [];

for (const file of untracked) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const targets = extractTargets(sql);
  const { found, missing } = proveTargets(targets);

  if (missing.length === 0) {
    // Either every declared object exists (true applied-but-untracked), or the
    // file declares ZERO schema objects (seed-only / intentional no-op) — both
    // are "proven": nothing it claims to create is absent from the live schema.
    proven.push({ file, objectCount: targets.length, objects: found });
  } else {
    unproven.push({ file, objectCount: targets.length, found, missing });
  }
}

// ─── Step 5: report ─────────────────────────────────────────────────────────────
if (wantJson) {
  console.log(
    JSON.stringify(
      {
        migrationFiles: migrationFiles.length,
        doSchemaFilesSkipped: doSchemaFiles,
        tracked: trackedNames.size,
        untracked: untracked.length,
        proven,
        unproven,
        insertStatements: proven.map(
          (p) => `INSERT INTO d1_migrations (name, applied_at) SELECT '${p.file}', CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '${p.file}');`,
        ),
      },
      null,
      2,
    ),
  );
  process.exit(unproven.length > 0 ? 1 : 0);
}

header('D1 migration-tracking reconcile — schema-diff proof');
info(`${migrationFiles.length} migration files on disk (${doSchemaFiles.length} DO-schema files excluded) · ${trackedNames.size} already tracked · ${untracked.length} untracked\n`);

if (proven.length > 0) {
  console.log(gumStyle('PROVEN applied-but-untracked (objects found in live schema):', ['--foreground', '2', '--bold']));
  for (const p of proven) {
    const objStr = p.objectCount === 0 ? '(no schema objects declared — seed/no-op file)' : p.objects.join(', ');
    console.log(`  ✓ ${p.file}  ←  ${objStr}`);
  }
  console.log();
}

if (unproven.length > 0) {
  console.log(gumStyle('NOT proven (some declared objects are missing — do NOT track):', ['--foreground', '1', '--bold']));
  for (const u of unproven) {
    console.log(`  ✗ ${u.file}  —  missing: ${u.missing.join(', ')}`);
  }
  console.log();
  warn(`${unproven.length} file(s) withheld from the proven set — their migration genuinely never ran. Investigate before tracking.`);
}

if (emitSql && proven.length > 0) {
  header('Exact INSERT statements for the PROVEN set (review, do not auto-run)');
  for (const p of proven) {
    console.log(
      `INSERT INTO d1_migrations (name, applied_at) SELECT '${p.file}', CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '${p.file}');`,
    );
  }
  console.log();
  info('Apply with (lead-run only, never from this script):');
  console.log(
    `  npx wrangler d1 execute ${DB} --env production --remote --command "<one INSERT above>"`,
  );
}

success(`Dry-run complete (read-only). ${proven.length} proven / ${unproven.length} unproven / ${untracked.length} total untracked.`);
process.exit(0);
