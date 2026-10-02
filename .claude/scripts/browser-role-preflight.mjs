#!/usr/bin/env node
/**
 * browser-role-preflight.mjs — execution-contract gate for the STANDING browser roles
 * (fire-86 / D-85-b). Roles 16 (Long-Trail TDD) and 17 (Deep UI Explorer) MUST run from
 * the MAIN checkout with installed node_modules + local secrets, or they silently BLOCK
 * when auto-placed into sparse fleet worktrees that lack node_modules.
 *
 * Checks (fail-fast, prints the EXACT missing prerequisite + fix, exits 1):
 *   (a) CWD is the MAIN checkout — NOT a sparse fleet worktree (path has /.claude/worktrees/)
 *   (b) node_modules/ AND apps/project-sites/node_modules/ both exist
 *   (c) apps/project-sites/.dev.vars exists
 *
 * Pure Node, zero deps (emdash styling is bash-only). Exit 0 = contract satisfied.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OK = '\x1b[32m';
const ERR = '\x1b[31m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

const root = resolve(process.cwd());

/** Emit a BLOCKED failure with the exact fix and exit non-zero. */
function fail(check, problem, fix) {
  console.error(`${ERR}✖ browser-role preflight BLOCKED${RST} — ${check}`);
  console.error(`  ${problem}`);
  console.error(`  ${DIM}fix:${RST} ${fix}`);
  process.exit(1);
}

// (a) MAIN-checkout contract — a sparse worktree lives under .claude/worktrees/ and
//     lacks the installed deps the local stack needs.
if (root.includes('/.claude/worktrees/')) {
  fail(
    'check (a) MAIN checkout',
    `CWD is a sparse fleet worktree: ${root}`,
    'run from the MAIN checkout (repo root, NOT under .claude/worktrees/)',
  );
}

// (b) root + worker node_modules must both exist to boot the local stack.
const rootModules = join(root, 'node_modules');
const workerModules = join(root, 'apps', 'project-sites', 'node_modules');
if (!existsSync(rootModules)) {
  fail(
    'check (b) root node_modules',
    `missing: ${rootModules}`,
    'npm install --legacy-peer-deps (repo root)',
  );
}
if (!existsSync(workerModules)) {
  fail(
    'check (b) worker node_modules',
    `missing: ${workerModules}`,
    'cd apps/project-sites && npm install --legacy-peer-deps',
  );
}

// (c) local secrets for the worker dev stack.
const devVars = join(root, 'apps', 'project-sites', '.dev.vars');
if (!existsSync(devVars)) {
  fail(
    'check (c) worker .dev.vars',
    `missing: ${devVars}`,
    'create apps/project-sites/.dev.vars (populate local worker secrets)',
  );
}

console.log(`${OK}✔ browser-role preflight OK${RST} — MAIN checkout, deps installed, .dev.vars present`);
console.log(`  ${DIM}${root}${RST}`);
process.exit(0);
