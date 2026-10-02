#!/usr/bin/env node
/**
 * validate-gp-register.mjs — integrity gate for .claude/run-the-loop/gp-register.json
 * (the machine-readable GP-01..52 register required by MASTER-PROMPT.md §GP-1,
 * REV-2026-10-02-awos-master).
 *
 * Checks:
 *  - exactly 52 entries, ids GP-01..GP-52, unique + sequential
 *  - required fields present with legal enum values
 *  - every maps_to crosswalk resolves to a gp-NN present in GOLDEN-PATHS.md
 *  - every wlk ref is within WLK-01..WLK-45
 *
 * Exit 0 green · exit 1 any violation. Zero deps. Run from repo root:
 *   node scripts/validate-gp-register.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registerPath = resolve(root, '.claude/run-the-loop/gp-register.json');
const registryPath = resolve(root, '.claude/run-the-loop/GOLDEN-PATHS.md');

const STATUSES = new Set(['implemented', 'partial', 'planned', 'verify']);
const PRIORITIES = new Set(['P0', 'P1', 'P2']);
const REQUIRED_FIELDS = ['id', 'title', 'priority', 'gated', 'status', 'maps_to', 'wlk', 'note'];

const errors = [];
let register;
try {
  register = JSON.parse(readFileSync(registerPath, 'utf8'));
} catch (err) {
  console.error(`RED gp-register: unreadable/unparsable ${registerPath}: ${err.message}`);
  process.exit(1);
}
const registry = readFileSync(registryPath, 'utf8');

if (!register.revision || !/^REV-\d{4}-\d{2}-\d{2}-/.test(register.revision)) {
  errors.push(`revision missing or malformed: ${register.revision}`);
}
const paths = Array.isArray(register.paths) ? register.paths : [];
if (paths.length !== 52) errors.push(`expected 52 paths, found ${paths.length}`);

const seen = new Set();
paths.forEach((p, i) => {
  const want = `GP-${String(i + 1).padStart(2, '0')}`;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in p)) errors.push(`${p.id ?? `index ${i}`}: missing field "${f}"`);
  }
  if (p.id !== want) errors.push(`index ${i}: id ${p.id} out of sequence (expected ${want})`);
  if (seen.has(p.id)) errors.push(`duplicate id ${p.id}`);
  seen.add(p.id);
  if (!PRIORITIES.has(p.priority)) errors.push(`${p.id}: bad priority "${p.priority}"`);
  if (typeof p.gated !== 'boolean') errors.push(`${p.id}: gated must be boolean`);
  if (!STATUSES.has(p.status)) errors.push(`${p.id}: bad status "${p.status}"`);
  if (!p.title || p.title.length < 8) errors.push(`${p.id}: title missing/too short`);
  for (const m of p.maps_to ?? []) {
    const prefix = /^gp-\d{2}/.exec(m)?.[0];
    if (!prefix) errors.push(`${p.id}: maps_to "${m}" lacks gp-NN prefix`);
    else if (!registry.includes(prefix)) errors.push(`${p.id}: maps_to "${m}" → ${prefix} not found in GOLDEN-PATHS.md`);
  }
  for (const w of p.wlk ?? []) {
    const n = /^WLK-(\d{2})$/.exec(w)?.[1];
    if (!n || Number(n) < 1 || Number(n) > 45) errors.push(`${p.id}: wlk ref "${w}" outside WLK-01..45`);
  }
});

const counts = { implemented: 0, partial: 0, planned: 0, verify: 0 };
for (const p of paths) if (counts[p.status] !== undefined) counts[p.status] += 1;

if (errors.length) {
  console.error(`RED gp-register: ${errors.length} violation(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `GREEN gp-register: 52/52 paths valid (${register.revision}) — ` +
    `implemented ${counts.implemented} · partial ${counts.partial} · planned ${counts.planned} · verify ${counts.verify}`,
);
