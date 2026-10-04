#!/usr/bin/env node
/**
 * check-contrast-muted.mjs — bans the AA-failing "opacity-on-muted-token" text color across the
 * admin sections. `color: color-mix(in oklch, var(--ps-ink…) N%, transparent)` composites the ink
 * over the dark admin bg (#060610); at N ≤ 49 the result is < 4.5:1 → WCAG AA 1.4.3 FAIL (45% = 4.18:1).
 *
 * fire-132 swept 27 admin cards (≤48% → 78%/82% var(--ps-bg) solid, ≥11:1). This gate (CONTRAST-GATE,
 * fire-133) locks that in so the class can't silently return as new admin cards are added. Fix any hit
 * by mixing with a SOLID bg instead of transparent: `… 78%, var(--ps-bg, #060610)` (not `…, transparent`).
 *
 * Scoped to `src/app/pages/admin` — those surfaces are all over the dark admin bg, so the solid-mix fix
 * is always correct. Marketing/super-admin surfaces have varied bg context → triaged separately
 * (BACKLOG CONTRAST-SWEEP-2), NOT gated here. Memory: [[tailwind-opacity-on-muted-token-fails-aa-contrast]].
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src/app/pages/admin', import.meta.url).pathname;
const CWD = new URL('..', import.meta.url).pathname;
// TEXT `color:` only (NOT border-color/background-color/outline-color — WCAG 1.4.3 contrast is for
// text; low-opacity borders/tints are intentional + fine). Negative lookbehind for `-`/word char so
// `border-color:` etc. never match. Flags `color: color-mix(in oklch, var(--ps-ink…) <N≤49>%, transparent)`.
const BANNED = /(?<![-\w])color:\s*color-mix\(\s*in oklch,\s*var\(--ps-ink[^)]*\)\s*(\d{1,2})%\s*,\s*transparent\s*\)/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|scss|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    let m;
    BANNED.lastIndex = 0;
    while ((m = BANNED.exec(line)) !== null) {
      const pct = parseInt(m[1], 10);
      if (pct <= 49) hits.push({ file: relative(CWD, file), line: i + 1, pct, text: line.trim().slice(0, 100) });
    }
  });
}

if (hits.length) {
  console.error('\n❌ check-contrast-muted: AA-failing opacity-on-muted-token text color(s) found in admin:');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  (${h.pct}% ink over transparent → < 4.5:1)`);
    console.error(`     ${h.text}`);
  }
  console.error(
    `\n  Fix: mix with a SOLID bg, not transparent — e.g. \`color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610))\` (≥11:1 AA).`,
  );
  console.error(`  (CONTRAST-GATE, fire-133 — see memory tailwind-opacity-on-muted-token-fails-aa-contrast)\n`);
  process.exit(1);
}

console.warn('✅ check-contrast-muted: 0 AA-failing opacity-on-muted-token text colors in admin.');
process.exit(0);
