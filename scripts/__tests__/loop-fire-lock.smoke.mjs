#!/usr/bin/env node
/**
 * loop-fire-lock.smoke.mjs — self-contained smoke test for the fire-lease mutex.
 *
 * NOT jest: the repo's jest roots live under apps/project-sites; this script is
 * repo-root and runs via `node scripts/__tests__/loop-fire-lock.smoke.mjs`.
 *
 * Uses a TEMP lease via FIRE_LEASE_PATH (os.tmpdir()), so it NEVER touches the
 * live `.claude/run-the-loop/.fire-lease.json`. Exercises the real lifecycle
 * (claim → status → heartbeat → release) through the actual CLI via execFileSync,
 * asserting exit codes + on-disk lease state. Exit 1 + a clear message on any
 * failed assertion; exit 0 + a success line on pass. Cleans up the temp file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_SCRIPT = resolve(__dirname, '../loop-fire-lock.mjs');
const LEASE_PATH = join(mkdtempSync(join(tmpdir(), 'fire-lock-smoke-')), '.fire-lease.json');
const ENV = { ...process.env, FIRE_LEASE_PATH: LEASE_PATH };

let failed = false;

/** Run the lock CLI; returns { code, stdout } (never throws on nonzero exit). */
function run(cmd, id) {
  const args = [LOCK_SCRIPT, cmd];
  if (id !== undefined) args.push(id);
  try {
    const stdout = execFileSync('node', args, { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 1, stdout: String(err.stdout || '') };
  }
}

function assert(cond, msg) {
  if (cond) {
    console.log(`  ok   — ${msg}`);
  } else {
    console.error(`  FAIL — ${msg}`);
    failed = true;
  }
}

function cleanup() {
  try {
    if (existsSync(LEASE_PATH)) unlinkSync(LEASE_PATH);
  } catch {
    /* best-effort temp cleanup */
  }
}

console.log(`loop-fire-lock smoke test · temp lease: ${LEASE_PATH}`);

try {
  // Clean slate.
  cleanup();
  assert(!existsSync(LEASE_PATH), 'starts with no lease file');

  // 1. claim writes the lease + exits 0.
  const claim = run('claim', 'fire-smoke-1');
  assert(claim.code === 0, 'claim <id> exits 0');
  assert(existsSync(LEASE_PATH), 'claim writes the lease file');

  // 2. status exits 0 while a lease is held.
  const status = run('status');
  assert(status.code === 0, 'status exits 0');

  // 3. a SECOND claim with a DIFFERENT id while the first is live exits 3 (BUSY).
  const busy = run('claim', 'fire-smoke-2');
  assert(busy.code === 3, 'second claim (different id, live lease) exits 3 (BUSY)');
  assert(existsSync(LEASE_PATH), 'BUSY claim does not remove the live lease');

  // 4. heartbeat by the owner exits 0 + keeps the lease.
  const heartbeat = run('heartbeat', 'fire-smoke-1');
  assert(heartbeat.code === 0, 'heartbeat (owner) exits 0');
  assert(existsSync(LEASE_PATH), 'heartbeat keeps the lease file');

  // 5. release by a NON-owner id is a no-op (lease survives, exit 0).
  const releaseWrong = run('release', 'fire-smoke-2');
  assert(releaseWrong.code === 0, 'release (non-owner) exits 0');
  assert(existsSync(LEASE_PATH), 'release (non-owner) is a no-op — lease survives');

  // 6. release by the OWNER unlinks the lease (existsSync false after) + exit 0.
  const release = run('release', 'fire-smoke-1');
  assert(release.code === 0, 'release (owner) exits 0');
  assert(!existsSync(LEASE_PATH), 'release (owner) UNLINKS the lease file');
} finally {
  cleanup();
}

if (failed) {
  console.error('\nloop-fire-lock smoke test: FAILED');
  process.exit(1);
}
console.log('\nloop-fire-lock smoke test: PASSED');
process.exit(0);
