#!/usr/bin/env node
/**
 * wfp-serving-census.mjs — WfP-vs-R2 serving BACKFILL census (fire-83).
 *
 * The sibling `verify-wfp-serving.mjs` (fire-82) is a pass/fail GATE over a small
 * default host set. THIS script is the measurable BACKFILL progress tracker for the
 * money-path: given a (possibly large) list of published-site hostnames, it probes
 * each `x-ps-serve` header and prints a RED/GREEN census so each fire can SEE the
 * count of pre-WfP (silent-R2-fallback) sites shrink toward zero.
 *
 * Every published-site response carries `x-ps-serve: wfp|r2` (set in
 * `src/services/site_serving.ts` — `wfp` on the Workers-for-Platforms dispatch
 * branch, `r2` on the byte-identical R2 fail-soft). WfP is the canonical default;
 * a site on `r2` has NO live WfP prod dispatch slot and is a backfill lead.
 *
 * Output columns: HOST · STATUS · X-PS-SERVE (wfp|r2|MISSING|ERR) · VERDICT.
 * VERDICT: GREEN (wfp, or an EXPECTED_R2 apex) / RED (r2 fallback or MISSING on a
 * non-apex published site) / ERR (fetch failed).
 *
 * Exit 0 by default (report-only — safe in any loop fire). `--strict` exits 1 if ANY
 * non-apex site is not `wfp` (RED or ERR), making it a CI-wireable regression gate
 * once backfill reaches zero.
 *
 * Usage:
 *   node scripts/wfp-serving-census.mjs [host ...]     # census (defaults below)
 *   node scripts/wfp-serving-census.mjs --strict        # exit 1 if any non-apex ≠ wfp
 *   node scripts/wfp-serving-census.mjs --json           # machine-readable rows + summary
 *   node scripts/wfp-serving-census.mjs --file hosts.txt # one hostname per line (# comments ok)
 *   node scripts/wfp-serving-census.mjs --help
 *
 * Self-test (manual): a published site on the R2 fallback MUST print a RED r2 row and,
 * with --strict, exit 1:
 *   node scripts/wfp-serving-census.mjs lonemountainglobal.projectsites.dev
 *   → ...  200  r2  RED   (silent R2 fallback — needs WfP backfill)
 *   node scripts/wfp-serving-census.mjs --strict lonemountainglobal.projectsites.dev; echo $?  → 1
 * The apex is reported GREEN (expected-R2 marketing), never RED:
 *   node scripts/wfp-serving-census.mjs projectsites.dev  → ...  200  r2  GREEN (apex marketing — expected R2)
 */

import { readFileSync } from 'node:fs';

// Mirror current Chrome stable per rules/fetch-defaults.md (avoid CF bot-challenge).
// Copied from the sibling scripts/verify-wfp-serving.mjs REAL_UA + REAL_HEADERS block.
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const REAL_HEADERS = {
  'User-Agent': REAL_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Upgrade-Insecure-Requests': '1',
};

// Default census set: the known silent-R2-fallback lead + the apex (expected-R2 marketing).
// Extend by passing hosts as args or a --file list as more published sites are enumerated.
const DEFAULT_HOSTS = ['lonemountainglobal.projectsites.dev', 'projectsites.dev'];
// Hosts that legitimately serve from R2 (apex marketing route) — never traverse the
// per-site serving path that stamps x-ps-serve, so they are GREEN, never a backfill lead.
const EXPECTED_R2 = new Set(['projectsites.dev', 'www.projectsites.dev']);

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'wfp-serving-census.mjs — WfP-vs-R2 serving backfill census (reads x-ps-serve on prod).',
      '',
      'Usage: node scripts/wfp-serving-census.mjs [--strict] [--json] [--file <path>] [host ...]',
      '  host…          published-site hostnames (default: ' + DEFAULT_HOSTS.join(', ') + ')',
      '  --file <path>  read hostnames from a file (one per line; # comments + blanks ignored)',
      '  --strict       exit 1 if ANY non-apex site is not wfp (RED or ERR)',
      '  --json         emit machine-readable { rows, summary } JSON on stdout',
      '  --help         show this help',
      '',
      'VERDICT: GREEN = wfp (or an expected-R2 apex) · RED = r2 fallback / MISSING on a',
      'published site · ERR = fetch failed. Each RED non-apex row is a WfP backfill lead',
      '(flip it with: node scripts/backfill-wfp-slot.mjs <slug>).',
    ].join('\n'),
  );
  process.exit(0);
}

const STRICT = args.includes('--strict');
const JSON_OUT = args.includes('--json');

/** Collect hosts from positional args + an optional --file list. */
function collectHosts() {
  const fileIdx = args.indexOf('--file');
  let fromFile = [];
  if (fileIdx !== -1) {
    const path = args[fileIdx + 1];
    if (!path || path.startsWith('-')) {
      console.error('--file requires a path argument');
      process.exit(2);
    }
    fromFile = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }
  // Positional (non-flag) args, excluding the --file value itself (only when --file is present;
  // otherwise fileIdx is -1 and `fileIdx + 1 === 0` would wrongly drop the FIRST host).
  const fileValIdx = fileIdx === -1 ? -1 : fileIdx + 1;
  const positional = args.filter((a, i) => !a.startsWith('-') && i !== fileValIdx);
  const hosts = [...positional, ...fromFile];
  return hosts.length ? hosts : DEFAULT_HOSTS;
}

const targets = collectHosts();

/**
 * Fetch one host, return { host, status, marker, verdict }.
 * marker: 'wfp' | 'r2' | 'MISSING' | 'ERR'. verdict: 'GREEN' | 'RED' | 'ERR'.
 */
async function probe(host) {
  const url = host.startsWith('http') ? host : `https://${host}/`;
  const isApex = EXPECTED_R2.has(host.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  try {
    const res = await fetch(url, { headers: REAL_HEADERS, redirect: 'follow' });
    const marker = res.headers.get('x-ps-serve') ?? 'MISSING';
    let verdict;
    if (isApex) verdict = 'GREEN'; // apex marketing is legitimately R2/header-free
    else if (marker === 'wfp') verdict = 'GREEN';
    else verdict = 'RED'; // r2 fallback or MISSING on a published site = backfill lead
    return { host, status: String(res.status), marker, verdict };
  } catch (err) {
    return { host, status: 'ERR', marker: `ERR:${err?.cause?.code || err?.name || 'fetch'}`, verdict: 'ERR' };
  }
}

const rows = await Promise.all(targets.map(probe));

// Non-apex rows that are not GREEN are the backfill leads this gate measures.
const leads = rows.filter((r) => r.verdict !== 'GREEN');
const greenCount = rows.length - leads.length;
const summary = {
  total: rows.length,
  green: greenCount,
  red: rows.filter((r) => r.verdict === 'RED').length,
  err: rows.filter((r) => r.verdict === 'ERR').length,
  leads: leads.map((r) => r.host),
};

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, summary }, null, 2));
  process.exit(STRICT && leads.length ? 1 : 0);
}

const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(4, ...rows.map((r) => r.host.length));
console.log(`${pad('HOST', w)}  STATUS  ${pad('X-PS-SERVE', 10)}  VERDICT`);
console.log(`${'-'.repeat(w)}  ------  ----------  -------`);
for (const r of rows) {
  const note =
    r.verdict === 'GREEN' && EXPECTED_R2.has(r.host)
      ? '  (apex marketing — expected R2)'
      : r.verdict === 'RED' && r.marker === 'r2'
        ? '  (silent R2 fallback — needs WfP backfill)'
        : r.verdict === 'RED' && r.marker === 'MISSING'
          ? '  (no x-ps-serve — not served via per-site path)'
          : '';
  console.log(`${pad(r.host, w)}  ${pad(r.status, 6)}  ${pad(r.marker, 10)}  ${r.verdict}${note}`);
}

console.log(
  `\nCENSUS: ${summary.green}/${summary.total} GREEN · ${summary.red} RED · ${summary.err} ERR`,
);
if (leads.length) {
  console.log(
    `⚠ ${leads.length} site(s) need WfP backfill: ${summary.leads.join(', ')}` +
      `\n  → flip each: node scripts/backfill-wfp-slot.mjs <slug>`,
  );
} else {
  console.log('✓ every non-apex site serves x-ps-serve: wfp — backfill complete.');
}

process.exit(STRICT && leads.length ? 1 : 0);
