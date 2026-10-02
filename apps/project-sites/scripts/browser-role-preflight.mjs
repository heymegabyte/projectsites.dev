#!/usr/bin/env node
/**
 * Browser-role execution preflight gate (deterministic).
 *
 * Standing /run-the-loop Browser roles — §1.16 Long-Trail TDD and §1.17 Deep UI
 * Explorer / Visual Intelligence — drive a REAL browser (Playwright / CF Browser
 * Run) against prod + local surfaces. They can only do that from the MAIN checkout
 * with FULLY-INSTALLED deps: fleet auto-worktrees give every agent a sparse
 * `node_modules` (memory `wtBRO` / fire-64), which silently breaks the browser
 * harness. This script codifies that contract so both roles run the SAME check
 * every fire instead of each re-discovering the breakage.
 *
 * Checks (relative to the git repo root, resolved via `git rev-parse`):
 *   - `node_modules/`                      — root workspace deps installed
 *   - `apps/project-sites/node_modules/`   — worker deps installed
 *   - `apps/project-sites/.dev.vars`       — local secrets for wrangler/harness
 * Plus: a stderr WARN when the cwd is under `.claude/worktrees/` (browser roles
 * must run in the MAIN checkout).
 *
 * Exit 0 + `OK: browser-role env ready` when all present.
 * Exit 1 + `BLOCKED: <exact missing prerequisite>` on the first missing one.
 *
 * CI-safe: no prompts, never hangs, no external deps. Styling via
 * `~/.claude/hooks/style.sh` `emdash_*` helpers when present, else plain console.
 *
 * @see .claude/run-the-loop/OPERATING-PRINCIPLES.md § Browser-role execution contract
 * @see memory wtBRO (fleet auto-worktree breaks standing browser roles)
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Resolve the repo root so the gate works from any cwd (main checkout OR a worktree). */
function resolveRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Style helpers: source `~/.claude/hooks/style.sh` and shell out to the `emdash_*`
 * functions when it exists, else fall back to plain console. Each call is a tiny
 * `bash -c` so the CI-safe gum/plain fallback inside style.sh is honored.
 */
function makeLog() {
  const stylePath = join(homedir(), '.claude', 'hooks', 'style.sh');
  if (!existsSync(stylePath)) {
    return {
      success: (m) => console.log(`✓ ${m}`),
      error: (m) => console.error(`✗ ${m}`),
      warn: (m) => console.error(`⚠ ${m}`),
      info: (m) => console.log(m),
    };
  }
  const emit = (fn, msg) => {
    try {
      execFileSync('bash', ['-c', `source "${stylePath}" && ${fn} "$1"`, '--', msg], {
        stdio: 'inherit',
      });
    } catch {
      // style.sh failed — never let presentation break the gate's exit code.
      (fn === 'emdash_error' || fn === 'emdash_warn' ? console.error : console.log)(msg);
    }
  };
  return {
    success: (m) => emit('emdash_success', m),
    error: (m) => emit('emdash_error', m),
    warn: (m) => emit('emdash_warn', m),
    info: (m) => emit('emdash_info', m),
  };
}

const log = makeLog();

const repoRoot = resolveRepoRoot();
if (!repoRoot) {
  log.error('BLOCKED: not inside a git repository (git rev-parse --show-toplevel failed)');
  process.exit(1);
}

// WARN (non-fatal) when running from a worktree — browser roles belong in MAIN.
const cwd = process.cwd();
if (cwd.includes(`${join('.claude', 'worktrees')}`)) {
  log.warn(
    'WARN: cwd is under .claude/worktrees/ — browser roles must run in the MAIN checkout ' +
      '(fleet auto-worktrees give sparse node_modules; memory wtBRO / fire-64).',
  );
}

/** Required prerequisites, repo-root-relative, checked in order. */
const REQUIRED = [
  { path: 'node_modules', label: 'node_modules/ (run `npm install --legacy-peer-deps` at repo root)' },
  {
    path: join('apps', 'project-sites', 'node_modules'),
    label: 'apps/project-sites/node_modules/ (run `npm install --legacy-peer-deps` in apps/project-sites)',
  },
  {
    path: join('apps', 'project-sites', '.dev.vars'),
    label: 'apps/project-sites/.dev.vars (local secrets for wrangler/browser harness)',
  },
];

for (const req of REQUIRED) {
  if (!existsSync(join(repoRoot, req.path))) {
    log.error(`BLOCKED: ${req.label}`);
    process.exit(1);
  }
}

log.success(`OK: browser-role env ready (${repoRoot})`);
process.exit(0);
