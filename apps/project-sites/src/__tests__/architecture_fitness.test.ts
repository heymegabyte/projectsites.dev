/**
 * Architecture fitness functions (convergence spec §8 / §2 — the infra LAW).
 *
 * @remarks
 * Fails the build if a forbidden vendor enters the worker source tree. Scoped to
 * UNAMBIGUOUS forbidden references (per `validator-precision-discipline` — prefer
 * false negatives over false positives): Polar billing, Trigger.dev jobs, and a
 * Fly.io-hosted Hatchet config. None exist in the repo today, so these tests pass
 * now and guard against future drift toward the removed stack.
 *
 * Intentionally NOT enforced here (too false-positive-prone — handled by review):
 * `megabyte.space` (the doctrine ALLOWS internal `mcp.megabyte.space` /
 * `skyvern.megabyte.space` behind CF Access) and `posthog` (legitimate server-side
 * on product/admin surfaces; forbidden only on hosted CUSTOMER sites).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eventIdempotencyKey, EVENT_TYPES, MAX_OUTBOX_ATTEMPTS } from '../services/event_bus.js';
import { EXCLUDED_VENDORS } from '../platform/service-registry.js';

const SRC = join(__dirname, '..');

/** Recursively collect every .ts source file under src/, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts'))
      out.push(full);
  }
  return out;
}

/** Lines matching a forbidden pattern, with `file:line` context (migration-note lines excluded). */
function violations(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      // Allow references inside an explicit migration/removal note.
      if (/migrat|removed|forbidden|do not use|deprecated|escape hatch/i.test(line)) return;
      hits.push(`${file.replace(SRC, 'src')}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return hits;
}

describe('architecture fitness — forbidden vendors (convergence LAW §2)', () => {
  it('has no Polar billing references (Stripe-only billing)', () => {
    expect(violations(/@polar-sh|polar\.sh|from ['"]@polar/i)).toEqual([]);
  });

  it('has no Trigger.dev references (Cloudflare Workflows / Hatchet only)', () => {
    expect(violations(/@trigger\.dev|trigger\.dev\/sdk|from ['"]@trigger/i)).toEqual([]);
  });

  it('has no Fly.io-hosted Hatchet config (Hatchet Cloud only)', () => {
    // A Hatchet host pointed at fly.dev/fly.io = the forbidden self-host.
    expect(violations(/hatchet[^\n]*fly\.(io|dev)|fly\.(io|dev)[^\n]*hatchet/i)).toEqual([]);
  });

  it('has no forbidden managed app-platform deploy targets (CF-first LAW)', () => {
    // Importing these vendor SDKs = drift off the Cloudflare + Neon/Upstash/Fly base.
    expect(violations(/from ['"]@vercel\/|from ['"]@supabase\/|from ['"]@aws-sdk\//)).toEqual([]);
  });
});

describe('architecture fitness — exclude-list lockstep (single source of truth, §4)', () => {
  it('the CI gate scans for EVERY vendor the registry declares excluded', () => {
    // The gate script carries its OWN RULES list it scans source with; the
    // registry's EXCLUDED_VENDORS is the SSOT. A vendor in the registry but
    // missing a gate rule = a §4 vendor that scans clean SILENTLY (the gate
    // never looks for it). This locks the two in lockstep so the manual sync
    // the gate header admits to can never drift again. (Found speakeasy/knock/
    // braintrust missing + a polar/polar.sh key mismatch when first wired.)
    const gate = readFileSync(join(SRC, '../scripts/check-architecture-fitness.mjs'), 'utf8');
    const missing = EXCLUDED_VENDORS.filter((v) => !gate.includes(`vendor: '${v}'`));
    expect(missing).toEqual([]);
  });
});

describe('architecture fitness — reliability invariants (idempotency + DLQ, convergence spec §8)', () => {
  /** Source files whose text matches a pattern, as `src/…` paths. */
  function filesMatching(pattern: RegExp): string[] {
    return sourceFiles(SRC)
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC, 'src'));
  }

  it('defines the event idempotency-key helper exactly once (one canonical dedupe path)', () => {
    // Duplicate idempotency-key logic = two sources of truth for at-least-once dedupe → drift.
    expect(filesMatching(/export function eventIdempotencyKey\b/)).toEqual([
      'src/services/event_bus.ts',
    ]);
  });

  it('keeps the outbox retry cap a bounded positive integer (never 0 = no retry, never unbounded)', () => {
    // 0 would never retry; an unbounded/huge cap would never dead-letter — both break delivery.
    expect(Number.isInteger(MAX_OUTBOX_ATTEMPTS)).toBe(true);
    expect(MAX_OUTBOX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MAX_OUTBOX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it('wires the dead-letter escape hatch (the DLQ table is written somewhere in the tree)', () => {
    // If no source writes dead_letter_events, exhausted events vanish silently instead of dead-lettering.
    expect(filesMatching(/INSERT INTO dead_letter_events\b/i).length).toBeGreaterThanOrEqual(1);
  });

  it('eventIdempotencyKey is deterministic and scope-collision-resistant', () => {
    const type = EVENT_TYPES[0];
    const a = eventIdempotencyKey(type, 'site-1');
    const b = eventIdempotencyKey(type, 'site-1');
    const c = eventIdempotencyKey(type, 'site-2');
    expect(a).toBe(b); // same inputs → same key (at-least-once dedupe holds)
    expect(a).not.toBe(c); // distinct scope → distinct key (no cross-site collision)
    expect(() => eventIdempotencyKey(type)).toThrow(RangeError); // empty scope is a programming error, not a silent collision
  });
});

describe('architecture fitness — optional-vendor adapters stay env-gated + fail-soft (infra LAW)', () => {
  const readSrc = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

  it('hatchet adapter is Hatchet Cloud — server_url rides in the JWT, never a Fly host (LAW: Hatchet=Cloud not Fly)', () => {
    expect(readSrc('services/hatchet.ts')).not.toMatch(/fly\.(io|dev)/i);
  });
});
