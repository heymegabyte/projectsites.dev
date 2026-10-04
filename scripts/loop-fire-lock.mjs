#!/usr/bin/env node
/**
 * loop-fire-lock.mjs — mutual exclusion for /run-the-loop fires.
 *
 * The scheduler fires /run-the-loop 4×/hour; a fire routinely outlives the
 * 15-minute interval. Without a mutex, two fires overlap → duplicate browser
 * sessions, conflicting commits, double deploys. This lease serializes fires:
 * the NEXT scheduled fire either waits/coalesces (exit 3 = "live fire running,
 * skip this tick") or reclaims a STALE lease (prior lead died mid-fire).
 *
 * A lease is LIVE when its heartbeat is younger than STALE_MS (default 20 min)
 * AND it was claimed less than MAX_AGE_MS ago (default 90 min). The age ceiling
 * defeats the ZOMBIE-HEARTBEAT DEADLOCK: a dead lead's detached
 * `while true; heartbeat; sleep` loop can refresh the heartbeat forever and
 * wedge every future tick into coalescing — but it CANNOT hold the lease past
 * MAX_AGE_MS (fire-66 reclaimed exactly such a zombie: owner PID dead, lease
 * fresh). DOCTRINE: heartbeat INLINE per phase — NEVER background a detached
 * heartbeat loop; it outlives its fire. This cap is the backstop, not the cure.
 *
 * Usage (from repo root; the loop command runs claim FIRST, release LAST):
 *   node scripts/loop-fire-lock.mjs claim <fireId>    # exit 0 claimed · 3 busy
 *   node scripts/loop-fire-lock.mjs heartbeat <fireId># refresh (no-op if not owner)
 *   node scripts/loop-fire-lock.mjs release <fireId>  # clear own lease
 *   node scripts/loop-fire-lock.mjs status            # print lease JSON
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Lease path is CWD-proof (resolved from __dirname). FIRE_LEASE_PATH overrides it
// so tests exercise a temp lease and never touch the live one; identical behavior unset.
const LOCK_PATH = process.env.FIRE_LEASE_PATH
  ? resolve(process.env.FIRE_LEASE_PATH)
  : resolve(__dirname, '../.claude/run-the-loop/.fire-lease.json');
const STALE_MS = parseInt(process.env.FIRE_LEASE_STALE_MS || String(20 * 60 * 1000), 10);
// Hard ceiling on how long ANY single lease can be held, independent of
// heartbeat freshness — the zombie-heartbeat backstop (see header).
const MAX_AGE_MS = parseInt(process.env.FIRE_LEASE_MAX_AGE_MS || String(90 * 60 * 1000), 10);

const [, , cmd, fireId] = process.argv;

function readLease() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null; // corrupt lease = no lease
  }
}

function isLive(lease) {
  if (!lease) return false;
  const now = Date.now();
  const heartbeatFresh = now - new Date(lease.heartbeat).getTime() < STALE_MS;
  const withinMaxAge = now - new Date(lease.claimedAt).getTime() < MAX_AGE_MS;
  return heartbeatFresh && withinMaxAge;
}

/** Whole minutes since an ISO timestamp — human-readable lease age for coalesce decisions. */
function ageMin(ts) {
  return Math.round((Date.now() - new Date(ts).getTime()) / 60000);
}

function write(lease) {
  writeFileSync(LOCK_PATH, JSON.stringify(lease, null, 2));
}

switch (cmd) {
  case 'claim': {
    if (!fireId) {
      console.error('usage: loop-fire-lock.mjs claim <fireId>');
      process.exit(1);
    }
    const lease = readLease();
    if (isLive(lease) && lease.fireId !== fireId) {
      console.warn(
        `BUSY: fire "${lease.fireId}" holds a live lease ` +
          `(heartbeat ${ageMin(lease.heartbeat)}m ago, stale at ${Math.round(STALE_MS / 60000)}m; ` +
          `claimed ${ageMin(lease.claimedAt)}m ago, max ${Math.round(MAX_AGE_MS / 60000)}m). ` +
          'Coalesce: skip this tick; the running fire advances the same backlog.',
      );
      process.exit(3);
    }
    write({
      fireId,
      pid: process.pid,
      claimedAt: lease?.fireId === fireId ? lease.claimedAt : new Date().toISOString(),
      heartbeat: new Date().toISOString(),
      reclaimedFrom: lease && !isLive(lease) ? lease.fireId : undefined,
    });
    console.warn(
      `CLAIMED: ${fireId}` +
        (lease && !isLive(lease)
          ? ` (reclaimed STALE lease from ${lease.fireId} — heartbeat ${ageMin(lease.heartbeat)}m ago)`
          : ''),
    );
    process.exit(0);
  }
  case 'heartbeat': {
    const lease = readLease();
    if (lease?.fireId === fireId) {
      write({ ...lease, heartbeat: new Date().toISOString() });
      console.warn(`HEARTBEAT: ${fireId}`);
    } else {
      console.warn(`NOT-OWNER: lease held by ${lease?.fireId || 'nobody'}`);
    }
    process.exit(0);
  }
  case 'release': {
    const lease = readLease();
    if (lease?.fireId === fireId) {
      unlinkSync(LOCK_PATH);
      console.warn(`RELEASED: ${fireId}`);
    } else {
      console.warn(`NOT-OWNER (no-op): lease held by ${lease?.fireId || 'nobody'}`);
    }
    process.exit(0);
  }
  case 'status': {
    const lease = readLease();
    const ageMs = lease ? Date.now() - new Date(lease.claimedAt).getTime() : null;
    console.warn(
      JSON.stringify(
        { lease, live: isLive(lease), ageMs, stalenessMs: STALE_MS, maxAgeMs: MAX_AGE_MS },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  default:
    console.error('usage: loop-fire-lock.mjs claim|heartbeat|release|status [fireId]');
    process.exit(1);
}
