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
 * Also (NON-fatal, fire-81): resolve `CF_BROWSER_RUN_TOKEN` from EITHER
 * `apps/project-sites/.dev.vars` OR `get-secret CF_BROWSER_RUN_TOKEN`. Role 17
 * (Deep UI Explorer) drives CF Browser Run over CDP with this token; when it is
 * absent the role silently falls back to a non-CF path yet still reports a GREEN
 * preflight — an HONESTY gap. We print whether CF coverage is AVAILABLE (never the
 * token value itself) so role 17 knows up-front to expect CF vs FALLBACK/BLOCKED.
 * Missing from BOTH sources → a stderr WARN, exit still 0 (deps remain OK for the
 * role-16 local Long-Trail path).
 *
 * Exit 0 + `OK: browser-role env ready` when all REQUIRED present (the token is
 * ADVISORY — it gates role-17 CF coverage, not role-16 local readiness).
 * Exit 1 + `BLOCKED: <exact missing prerequisite>` on the first missing one.
 *
 * CI-safe: no prompts, never hangs, no external deps. Styling via
 * `~/.claude/hooks/style.sh` `emdash_*` helpers when present, else plain console.
 *
 * @see .claude/run-the-loop/OPERATING-PRINCIPLES.md § Browser-role execution contract
 * @see memory wtBRO (fleet auto-worktree breaks standing browser roles)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Is `CF_BROWSER_RUN_TOKEN` resolvable from EITHER `.dev.vars` OR `get-secret`?
 * Returns the SOURCE (`dev.vars` | `get-secret`) when found, else `null`. NEVER
 * returns or logs the token value. Fail-soft: any read/spawn error is treated as
 * "not found from that source" (a missing `get-secret` binary must not throw).
 *
 * @param {string} repoRoot
 * @returns {'dev.vars' | 'get-secret' | null}
 */
function resolveCfBrowserRunTokenSource(repoRoot) {
  const KEY = 'CF_BROWSER_RUN_TOKEN';
  // Source 1 — .dev.vars (KEY=value lines; a non-empty value after `=` counts).
  try {
    const devVarsPath = join(repoRoot, 'apps', 'project-sites', '.dev.vars');
    if (existsSync(devVarsPath)) {
      const line = readFileSync(devVarsPath, 'utf8')
        .split(/\r?\n/)
        .find((l) => l.replace(/^\s*(export\s+)?/, '').startsWith(`${KEY}=`));
      if (line) {
        const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
        if (value.length > 0) return 'dev.vars';
      }
    }
  } catch {
    // ignore — fall through to get-secret
  }
  // Source 2 — get-secret (authoritative secret store; absent binary → not found).
  try {
    const getSecret = join(homedir(), '.local', 'bin', 'get-secret');
    if (existsSync(getSecret)) {
      const out = execFileSync(getSecret, [KEY], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out && out.trim().length > 0) return 'get-secret';
    }
  } catch {
    // ignore — get-secret exits non-zero / missing when the secret isn't set
  }
  return null;
}

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

// ADVISORY (non-fatal): CF Browser Run token gates role-17 CF coverage only.
const tokenSource = resolveCfBrowserRunTokenSource(repoRoot);
if (tokenSource) {
  log.info(`CF Browser Run token available (source: ${tokenSource}) — role 17 CF coverage enabled`);
} else {
  log.warn(
    'CF Browser Run token not found — role 17 CF coverage unavailable (FALLBACK/BLOCKED only)',
  );
}

log.success(`OK: browser-role env ready (${repoRoot})`);
process.exit(0);
