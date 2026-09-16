#!/usr/bin/env node
/**
 * check-orphan-flag-gates.mjs — drift guard for the orphan-flag-gate bug class.
 *
 * A route/service that calls `isFlagOn(env, 'X')` / `requireFlag('X')` for a flag
 * key `X` that is ABSENT from `FLAG_REGISTRY` (registry.ts) is permanently dead:
 * the resolver returns false for an unknown key, so the handler 404s forever and
 * the feature can never be enabled (no registry entry → no admin toggle, no
 * override target). This silently killed `public_api` (fixed 2026-08-16) and
 * `approval_workflow`/`github_repo_sync`/`abandoned_build_nudge`/`research_cache`
 * (fixed this pass) — all masked by graceful "not enabled" UI.
 *
 * Rule: every flag key gated in worker src MUST exist in FLAG_REGISTRY.
 * Exit 1 (with the offending key + call sites) on any violation.
 *
 * Usage: node scripts/check-orphan-flag-gates.mjs   (run from apps/project-sites)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';
const REGISTRY = 'src/modules/feature_flags/registry.ts';

/** Recursively collect .ts files under a dir, skipping tests + node_modules. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...walk(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

// 1. Keys defined in the registry (the runtime source of truth).
const regSrc = readFileSync(REGISTRY, 'utf8');
const registryKeys = new Set([...regSrc.matchAll(/key:\s*'([a-z_0-9]+)'/g)].map((m) => m[1]));

// 2. Keys gated in worker src (the observed call shapes).
const GATE_PATTERNS = [
  /isFlagOn\(\s*(?:c\.)?env,\s*'([a-z_0-9]+)'/g, // isFlagOn(env,'x') / isFlagOn(c.env,'x')
  /requireFlag\(\s*'([a-z_0-9]+)'/g, // requireFlag('x')  (flag-first)
  /requireFlag\(\s*[a-zA-Z_.]+,\s*'([a-z_0-9]+)'/g, // requireFlag(c,'x') (ctx-first)
];
/**
 * Blank out `//` line comments and block comments (incl. JSDoc) so a gate-shaped
 * call inside an `@example` / `// Before:` comment is never mistaken for a LIVE gate
 * — validator-precision-discipline §1 (regex too greedy: don't scan comments). A JSDoc
 * example in `middleware/require_org.ts` (`isFlagOn(c.env, 'k', …)`) tripped this as a
 * phantom orphan flag `k`, failing this gate for 5 commits. Newlines + tabs are PRESERVED
 * so reported line numbers stay exact. Strings are not comment-aware, but a stray `//`
 * inside a string only risks a false NEGATIVE (a missed gate), never a false positive —
 * the discipline's preferred failure direction.
 */
function stripComments(src) {
  let out = '';
  let state = 'code'; // 'code' | 'line' | 'block'
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    const blank = c === '\n' ? '\n' : c === '\t' ? '\t' : ' ';
    if (state === 'code') {
      if (c === '/' && d === '/') {
        out += '  ';
        i++;
        state = 'line';
      } else if (c === '/' && d === '*') {
        out += '  ';
        i++;
        state = 'block';
      } else out += c;
    } else if (state === 'line') {
      if (c === '\n') {
        out += '\n';
        state = 'code';
      } else out += blank;
    } else {
      if (c === '*' && d === '/') {
        out += '  ';
        i++;
        state = 'code';
      } else out += blank;
    }
  }
  return out;
}

const gated = new Map(); // key -> [callsites]
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const scan = stripComments(text); // gate-shaped calls in comments are NOT live gates
  for (const re of GATE_PATTERNS) {
    for (const m of scan.matchAll(re)) {
      const key = m[1];
      const lineNo = scan.slice(0, m.index).split('\n').length;
      if (!gated.has(key)) gated.set(key, []);
      gated.get(key).push(`${file}:${lineNo}  ${lines[lineNo - 1]?.trim().slice(0, 90)}`);
    }
  }
}

// 3. Report gated keys absent from the registry.
const orphans = [...gated.keys()].filter((k) => !registryKeys.has(k)).sort();
if (orphans.length === 0) {
  console.log(`✅ check-orphan-flag-gates: ${gated.size} gated flags, all present in FLAG_REGISTRY.`);
  process.exit(0);
}
console.error(`❌ check-orphan-flag-gates: ${orphans.length} flag(s) gated but ABSENT from FLAG_REGISTRY (permanently dead routes):\n`);
for (const k of orphans) {
  console.error(`  ⚠️  ${k}`);
  for (const site of gated.get(k)) console.error(`        ${site}`);
}
console.error(`\nFix: add the flag to ${REGISTRY} (if the feature is live/built-ahead) OR remove the dead gate/route (if the feature was retired).`);
process.exit(1);
