#!/usr/bin/env node
/**
 * Supply-chain guard: every GitHub Actions `uses:` reference in
 * `.github/workflows/*.y{,a}ml` MUST be pinned to a full 40-hex commit SHA
 * (per the supply-chain-integrity doctrine — a floating tag like `@v4` or a
 * branch like `@master` silently ingests whatever a compromised maintainer or
 * a hijacked release publishes next). A trailing `# <version>` comment is the
 * expected, readable form: `uses: actions/checkout@11d5960… # v4`.
 *
 * Exempt: local composite actions (`uses: ./…`) — no upstream ref to pin.
 *
 * Exit 0 when every non-local `uses:` is SHA-pinned; exit 1 (with the offender
 * list) otherwise. Wired as `npm run validate:action-pins`; intended for CI so
 * a re-introduced tag pin (drift) blocks the merge.
 *
 * @see rules/ai-agent-security.md § Supply chain
 * @see rules/supply-chain-integrity (SHA-pin every third-party action)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

/** Matches an optional-list `uses:` line, capturing the ref (up to `@`), the version/sha, and any trailing comment. */
const USES_RE = /^\s*(?:-\s*)?uses:\s*([^\s@#]+)@([^\s#]+)\s*(#.*)?$/;
const SHA40_RE = /^[0-9a-f]{40}$/;

/** @returns {{file:string,line:number,ref:string,version:string}[]} offending (non-SHA-pinned) uses refs */
function findUnpinned() {
  if (!existsSync(WF_DIR)) return [];
  /** @type {{file:string,line:number,ref:string,version:string}[]} */
  const offenders = [];
  const files = readdirSync(WF_DIR)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort();
  for (const f of files) {
    const lines = readFileSync(join(WF_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(USES_RE);
      if (!m) return;
      const [, ref, version] = m;
      if (ref.startsWith('./') || ref.startsWith('docker://')) return; // local/composite or container image
      if (SHA40_RE.test(version)) return; // properly pinned
      offenders.push({ file: f, line: i + 1, ref, version });
    });
  }
  return offenders;
}

const offenders = findUnpinned();
if (offenders.length === 0) {
  console.log('check-action-pins: OK — every workflow `uses:` is pinned to a 40-hex commit SHA.');
  process.exit(0);
}

console.error(
  `check-action-pins: FAIL — ${offenders.length} action reference(s) not SHA-pinned ` +
    '(a tag/branch pin auto-ingests future — possibly malicious — releases):',
);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  ${o.ref}@${o.version}  → pin to a full commit SHA (keep \`# ${o.version}\` as a comment)`);
}
console.error('\nResolve a SHA:  gh api repos/<owner>/<repo>/commits/<version> --jq .sha');
process.exit(1);
