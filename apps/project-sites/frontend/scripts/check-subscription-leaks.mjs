#!/usr/bin/env node
/**
 * check-subscription-leaks.mjs — RATCHET gate against the leaked-subscription class.
 *
 * An Angular component that `.subscribe()`s an Observable (HttpClient, a service stream, …) WITHOUT
 * `takeUntilDestroyed` (or an explicit `takeUntil`/manual unsubscribe) LEAKS: the subscription
 * outlives the component, so a late emission mutates a destroyed component's signals — a memory leak
 * and the exact class that made `billing.component` throw "object is not iterable" and DISCONNECT the
 * whole Karma suite (AL Fire 14). The fix is `.pipe(takeUntilDestroyed(this.destroyRef))`.
 *
 * This is a RATCHET, not a big-bang: the existing debt is baselined (BASELINE below); the gate FAILS
 * only if the leaky-component count RISES above it — so NO NEW leaks land while the existing ones
 * drain across future sweep fires (lower BASELINE as they're fixed). Reports the current count so
 * progress is visible. Run: `node scripts/check-subscription-leaks.mjs` (wire into the frontend lint).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The number of leaky components to allow. LOWER this as components are fixed — never raise it.
// 59 at gate creation (AL sweep Fire 15); 57 after fixing public-analytics + roadmap.
const BASELINE = 57;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.component.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const leaky = [];
for (const f of walk(ROOT)) {
  const src = readFileSync(f, 'utf-8');
  const subs = (src.match(/\.subscribe\s*\(/g) || []).length;
  if (subs === 0) continue;
  // Cleaned up if the file uses takeUntilDestroyed, an explicit takeUntil(), or a manual
  // Subscription it unsubscribes. (takeUntilDestroyed is the standard; the others are legacy-ok.)
  const guarded = /takeUntilDestroyed|takeUntil\s*\(|\.unsubscribe\s*\(/.test(src);
  if (!guarded) leaky.push({ file: f.replace(ROOT + '/', ''), subs });
}

leaky.sort((a, b) => b.subs - a.subs);
const count = leaky.length;
for (const l of leaky) console.log(`  ${String(l.subs).padStart(3)} subs · ${l.file}`);
console.log(`\nleaky components: ${count} · baseline: ${BASELINE}`);

if (count > BASELINE) {
  console.log(
    `\n🔴 FAIL — ${count - BASELINE} NEW leaked-subscription component(s) above the baseline. ` +
      `Add \`.pipe(takeUntilDestroyed(this.destroyRef))\` (inject DestroyRef) to the new component's subscriptions.`,
  );
  process.exit(1);
}
console.log(
  count < BASELINE
    ? `\n✅ PASS — leak debt DOWN ${BASELINE - count} (lower BASELINE to ${count} to lock the win).`
    : `\n✅ PASS — no new leaks (existing debt drains across sweep fires).`,
);
process.exit(0);
