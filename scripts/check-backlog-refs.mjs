#!/usr/bin/env node
/**
 * check-backlog-refs.mjs — advisory scan of BACKLOG.md file references.
 *
 * Loop-improvement (fire-73): a scout marked two items READY-NOW citing files
 * that did not exist (`scripts/backfill-wfp-slots.mjs`, a `dead-toggle` gate).
 * A READY verdict against a phantom file wastes a fan-out agent. This lists every
 * concrete repo path the backlog cites and whether it resolves, so the orient
 * phase sees MISSING refs at a glance before assigning work.
 *
 * ADVISORY by default (exit 0). `--ci` exits 1 when any cited path is missing.
 * Usage: node scripts/check-backlog-refs.mjs [--ci] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKLOG = join(REPO_ROOT, '.claude', 'run-the-loop', 'BACKLOG.md');

// Repo-relative paths with a code/doc extension. Anchored to a dir-ish prefix so
// bare words like `README` or `main.ts` fragments don't generate noise.
const PATH_RE =
  /(?:^|[\s`([📍→])((?:apps|src|scripts|bin|frontend|app|packages|libs|e2e|docs|\.claude|\.github)\/[A-Za-z0-9._/-]+\.(?:mjs|cjs|js|ts|tsx|sql|json|sh|md|yml|yaml|scss|css))/g;

function main() {
  const ci = process.argv.includes('--ci');
  const asJson = process.argv.includes('--json');

  if (!existsSync(BACKLOG)) {
    console.error(`check-backlog-refs: BACKLOG not found at ${BACKLOG}`);
    process.exit(ci ? 1 : 0);
  }

  const text = readFileSync(BACKLOG, 'utf8');
  const cited = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    cited.add(m[1].replace(/[.,:)`]+$/, ''));
  }

  // Backlog paths are written relative to the repo root OR the worker package
  // (`apps/project-sites/`). A `.ts` cite often means a `.tsx` file. A path is
  // present if it resolves under ANY base with EITHER extension — precision over
  // recall so a noisy report doesn't get ignored (validator-precision-discipline).
  const BASES = [REPO_ROOT, join(REPO_ROOT, 'apps', 'project-sites')];
  const resolves = (p) => {
    const variants = [p];
    if (p.endsWith('.ts')) variants.push(p + 'x');
    if (p.endsWith('.tsx')) variants.push(p.slice(0, -1));
    return BASES.some((b) => variants.some((v) => existsSync(join(b, v))));
  };

  const rows = [...cited].sort().map((p) => ({ path: p, exists: resolves(p) }));
  const missing = rows.filter((r) => !r.exists);

  if (asJson) {
    console.log(JSON.stringify({ total: rows.length, missing: missing.map((r) => r.path) }, null, 2));
  } else {
    console.log(`check-backlog-refs: ${rows.length} cited paths · ${missing.length} MISSING`);
    for (const r of missing) {
      console.log(`  MISSING  ${r.path}`);
    }
    if (missing.length) {
      console.log(
        '\nℹ A MISSING path cited as an existing artifact is a stale READY verdict —\n' +
          '  re-confirm (test -f) before assigning a fix-agent, or re-scope the item to "needs authoring".',
      );
    }
  }

  process.exit(ci && missing.length ? 1 : 0);
}

main();
