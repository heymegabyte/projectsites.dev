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
 * Same lease semantics as the Long-Trail case-owner checkpoint: a lease is
 * LIVE when its heartbeat is younger than STALE_MS (default 20 min).
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
const LOCK_PATH = resolve(__dirname, '../.claude/run-the-loop/.fire-lease.json');
const STALE_MS = parseInt(process.env.FIRE_LEASE_STALE_MS || String(20 * 60 * 1000), 10);

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
  return !!lease && Date.now() - new Date(lease.heartbeat).getTime() < STALE_MS;
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
        `BUSY: fire "${lease.fireId}" holds a live lease (heartbeat ${lease.heartbeat}). ` +
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
    console.warn(`CLAIMED: ${fireId}${lease && !isLive(lease) ? ` (reclaimed stale lease from ${lease.fireId})` : ''}`);
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
    console.warn(JSON.stringify({ lease, live: isLive(lease), stalenessMs: STALE_MS }, null, 2));
    process.exit(0);
  }
  default:
    console.error('usage: loop-fire-lock.mjs claim|heartbeat|release|status [fireId]');
    process.exit(1);
}
