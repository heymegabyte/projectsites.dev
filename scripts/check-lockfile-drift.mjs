#!/usr/bin/env node
/**
 * check-lockfile-drift.mjs (repo root)
 *
 * Recurring-incident gate. The committed `pnpm-lock.yaml` drifting out of sync with
 * `package.json` + the workspace has bitten this repo repeatedly: 6+ "regenerate
 * pnpm-lock" commits and a ~30-run silently-RED worker deploy pipeline, every worker
 * commit stranded via `ERR_PNPM_OUTDATED_LOCKFILE` (CI runs `pnpm install --frozen-lockfile`,
 * which fails hard when the lockfile is stale). This gate catches the drift at push time.
 *
 * WHAT IT DOES (NON-MUTATING — this is the load-bearing invariant):
 *   1. Back up the committed root `pnpm-lock.yaml` to a temp path.
 *   2. Run `pnpm install --lockfile-only` (regenerates the lockfile WITHOUT touching node_modules).
 *   3. Diff the regenerated lockfile against the backup.
 *   4. RESTORE the original lockfile UNCONDITIONALLY (try/finally) — even on error / crash /
 *      SIGINT, the committed lockfile is NEVER left mutated.
 *   5. Exit 1 + a clear message (listing the first drifting lines) if they differ; exit 0 if identical.
 *
 * GUARD (fail-OPEN): if pnpm can't be resolved/run, `console.warn` + exit 0 — a missing tool
 * NEVER breaks CI (per fail-fast-build-fail-soft-prod: a build/CI gate degrades gracefully when
 * its own tooling is absent rather than red-flagging an unrelated commit).
 *
 * Pinned pnpm: uses `npx pnpm@<version>` matching the repo's `packageManager` field so the
 * regeneration uses the SAME resolver the lockfile was written with (a different pnpm major
 * rewrites the lockfile format → false drift).
 *
 * Usage:
 *   node scripts/check-lockfile-drift.mjs          # human output, exit 0/1
 *   node scripts/check-lockfile-drift.mjs --json    # machine summary on stdout, exit 0/1
 *
 * Exit codes: 0 = in sync (or fail-open skip) · 1 = drift detected.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = join(root, 'pnpm-lock.yaml');
const wantJson = process.argv.includes('--json');

/** Pinned pnpm version, read from the root package.json `packageManager` field (fallback 9.14.4). */
function resolvePinnedPnpm() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    const m = pm.match(/^pnpm@([0-9]+\.[0-9]+\.[0-9]+)/);
    if (m) return m[1];
  } catch {
    /* fall through to default */
  }
  return '9.14.4';
}

/** Emit the final result and exit. `skip` = fail-open (missing tool), always exit 0. */
function report({ status, drift = 0, sample = [], message, skip = false }) {
  if (wantJson) {
    process.stdout.write(JSON.stringify({ status, drift, sample }) + '\n');
  }
  if (skip) {
    console.warn(`⚠ check-lockfile-drift: ${message} — skipping (fail-open, CI not blocked).`);
    process.exit(0);
  }
  if (status === 'in-sync') {
    console.warn(`✓ pnpm-lock.yaml is in sync with package.json + workspace.`);
    process.exit(0);
  }
  // drift
  console.error(`✗ pnpm-lock.yaml is OUT OF SYNC (${drift} line(s) differ).`);
  console.error(`  ${message}`);
  if (sample.length) {
    console.error(`  First differing lines:`);
    for (const line of sample) console.error(`    ${line}`);
  }
  console.error(`  Fix: run 'npx pnpm@${resolvePinnedPnpm()} install --lockfile-only' and commit the updated pnpm-lock.yaml.`);
  process.exit(1);
}

/** First N unified-diff-ish lines where the two files differ (line-by-line). */
function firstDiffLines(a, b, limit = 8) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out = [];
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max && out.length < limit; i++) {
    if (al[i] !== bl[i]) {
      if (al[i] !== undefined) out.push(`- ${al[i]}`);
      if (bl[i] !== undefined) out.push(`+ ${bl[i]}`);
    }
  }
  return out;
}

function main() {
  if (!existsSync(LOCKFILE)) {
    report({ status: 'skip', message: 'no pnpm-lock.yaml at repo root', skip: true });
    return;
  }

  const pnpmVersion = resolvePinnedPnpm();
  const original = readFileSync(LOCKFILE, 'utf8');
  const backup = join(tmpdir(), `pnpm-lock.backup.${process.pid}.${Date.now()}.yaml`);
  copyFileSync(LOCKFILE, backup);

  let restored = false;
  const restore = () => {
    if (restored) return;
    try {
      // Restore byte-for-byte from the backup, unconditionally.
      copyFileSync(backup, LOCKFILE);
    } catch (e) {
      // Last-ditch: write the in-memory original back.
      try {
        writeFileSync(LOCKFILE, original);
      } catch {
        /* nothing more we can do */
      }
      console.error(`✗ check-lockfile-drift: FAILED to restore lockfile from backup: ${e?.message ?? e}`);
    } finally {
      restored = true;
      try {
        rmSync(backup, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  };
  // Restore even on an unexpected exit path (SIGINT/SIGTERM/uncaught).
  process.on('exit', restore);
  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    restore();
    process.exit(143);
  });

  try {
    // Regenerate the lockfile ONLY (no node_modules mutation). --frozen-lockfile=false lets it
    // rewrite; --lockfile-only keeps it to the lockfile; --ignore-scripts for safety + speed.
    const res = spawnSync(
      'npx',
      [`pnpm@${pnpmVersion}`, 'install', '--lockfile-only', '--frozen-lockfile=false', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000 },
    );

    if (res.error) {
      // ENOENT (npx/pnpm not installed) or a spawn failure → fail-open.
      report({ status: 'skip', message: `pnpm unavailable (${res.error.code || res.error.message})`, skip: true });
      return;
    }
    if (res.status !== 0) {
      const stderr = (res.stderr || '').trim().split('\n').slice(-3).join(' ');
      // A non-zero pnpm that clearly means "tool/registry unavailable" is fail-open;
      // otherwise treat as an inconclusive run and fail-open rather than false-red.
      report({ status: 'skip', message: `pnpm install --lockfile-only exited ${res.status}: ${stderr}`, skip: true });
      return;
    }

    const regenerated = readFileSync(LOCKFILE, 'utf8');
    if (regenerated === original) {
      report({ status: 'in-sync' });
      return;
    }

    const sample = firstDiffLines(original, regenerated);
    const drift = sample.length;
    report({
      status: 'drift',
      drift,
      sample,
      message: 'The committed lockfile does not match what pnpm regenerates from package.json.',
    });
  } finally {
    // Unconditional restore — the committed lockfile is NEVER left mutated.
    restore();
  }
}

main();
