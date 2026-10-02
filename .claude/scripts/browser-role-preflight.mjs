#!/usr/bin/env node
/**
 * browser-role-preflight.mjs — thin shim (D-85-b / fire-86).
 *
 * The CANONICAL browser-role preflight lives at
 * `apps/project-sites/scripts/browser-role-preflight.mjs` (richer: git-rev-parse
 * root resolution, CF_BROWSER_RUN_TOKEN honesty check for role 17, emdash styling).
 * This path exists only because the D-85-b brief referenced `.claude/scripts/…`;
 * rather than ship a thinner duplicate, it DELEGATES to the canonical script so the
 * two can never diverge (per the recycle-proven-code / interconnectedness rule).
 *
 * Roles 16/17 may invoke EITHER path; both run the one real contract. Exit code +
 * stdout/stderr are passed through unchanged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// .claude/scripts/ -> repo root is two levels up.
const repoRoot = resolve(here, '..', '..');
const canonical = join(repoRoot, 'apps', 'project-sites', 'scripts', 'browser-role-preflight.mjs');

if (!existsSync(canonical)) {
  console.error('\x1b[31m✖ browser-role preflight BLOCKED\x1b[0m — canonical script missing');
  console.error(`  expected: ${canonical}`);
  console.error('  fix: run from the MAIN checkout (canonical preflight lives under apps/project-sites/scripts/)');
  process.exit(1);
}

const r = spawnSync(process.execPath, [canonical, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
