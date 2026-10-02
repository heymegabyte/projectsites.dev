#!/usr/bin/env node
// loop-recent-fires.mjs — deterministic recency helper for the run-the-loop operator.
//
// WHY: the LEDGER's recent-fire section is NOT reliably sorted — fire headers appear
// out of chronological order, so eyeballing it gives a STALE recency read (fire-88
// orientation reported "last 5 = 73-77" when git showed work through fire-87). This
// mis-calls category starvation + journey variation. Run this instead of eyeballing.
//
// Prints, newest-first, the last N (default 8) `fire-NN` headers from LEDGER.md with
// their one-line summaries, AND the distinct `fire-NN` tokens seen in `git log` so a
// LEDGER-vs-git recency mismatch is visible at a glance.
//
// Usage:  node scripts/loop-recent-fires.mjs [--n <N>] [--json]

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LEDGER = join(REPO, '.claude', 'run-the-loop', 'LEDGER.md');
const FIRE_HEADER = /^#{1,3}\s*fire-(\d+)\b(.*)$/;

function parseArgs(argv) {
  let n = 8;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--n') {
      const v = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(v) && v > 0) n = v;
    } else if (a.startsWith('--n=')) {
      const v = Number.parseInt(a.slice('--n='.length), 10);
      if (Number.isFinite(v) && v > 0) n = v;
    }
  }
  return { n, json };
}

/** Last N fire headers from LEDGER.md, newest-first by numeric fire id (deduped). */
function ledgerFires(n) {
  let text = '';
  try {
    text = readFileSync(LEDGER, 'utf8');
  } catch {
    return []; // missing/unreadable LEDGER → empty, never throw
  }
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(FIRE_HEADER);
    if (!m) continue;
    const id = Number.parseInt(m[1], 10);
    // One-line summary: strip leading separators/parens noise, trim to a sane width.
    const summary = m[2].replace(/^\s*[—–\-:(]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    // Keep the first (usually richest) occurrence per id.
    if (!seen.has(id)) seen.set(id, summary);
  }
  return [...seen.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, n)
    .map(([id, summary]) => ({ id: `fire-${id}`, summary }));
}

/** Distinct fire-NN tokens from recent git history, newest-first. */
function gitFires(limit = 40) {
  try {
    const out = execFileSync('git', ['log', '--oneline', `-${limit}`], {
      cwd: REPO,
      encoding: 'utf8',
    });
    const order = [];
    const seen = new Set();
    for (const tok of out.match(/fire-\d+/g) ?? []) {
      if (!seen.has(tok)) {
        seen.add(tok);
        order.push(tok);
      }
    }
    return order;
  } catch {
    return [];
  }
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const { n, json } = parseArgs(process.argv.slice(2));
const fires = ledgerFires(n);
const git = gitFires(40);

if (json) {
  process.stdout.write(
    JSON.stringify(
      {
        meta: { repo: 'projectsites.dev', generated_at: new Date().toISOString(), git_sha: gitSha() },
        fires,
        git_recent_fires: git.slice(0, n),
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write(`Last ${fires.length} LEDGER fires (newest-first):\n`);
  for (const f of fires) process.stdout.write(`  ${f.id}  ${f.summary}\n`);
  process.stdout.write(`\ngit log recent fire tokens (newest-first): ${git.slice(0, n).join(', ') || '(none)'}\n`);
  const ledgerTop = fires[0]?.id ?? '(none)';
  const gitTop = git[0] ?? '(none)';
  if (ledgerTop !== gitTop) {
    process.stdout.write(`\n⚠ RECENCY MISMATCH: LEDGER top=${ledgerTop} but git top=${gitTop} — trust git.\n`);
  }
}
