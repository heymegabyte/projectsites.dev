#!/usr/bin/env node
/**
 * verify-wfp-serving.mjs — WfP-vs-R2 serving gate (fire-82).
 *
 * Every published-site response now carries `x-ps-serve: wfp|r2` (set in
 * `src/services/site_serving.ts` — `wfp` on the Workers-for-Platforms dispatch
 * branch, `r2` on the byte-identical R2 fail-soft). WfP is the canonical default,
 * yet a site can silently fall back to R2 (no live WfP slot / dispatch 5xx) and
 * still 200 cleanly — the loop had NO deterministic check catching that split.
 * This fetches each host with a realistic Chrome UA, reads `x-ps-serve`, and
 * prints host · status · marker (wfp/r2/MISSING).
 *
 * Exit 0 always by default (report-only). `--strict` exits 1 if ANY host is
 * MISSING the header (it should ALWAYS be present on a published site after
 * fire-82) OR is served from `r2` when WfP was expected (the silent-fallback
 * class we discovered on lonemountainglobal.projectsites.dev).
 *
 * Usage:
 *   node scripts/verify-wfp-serving.mjs [host ...]   # report (defaults below)
 *   node scripts/verify-wfp-serving.mjs --strict      # exit 1 on MISSING/fallback
 *   node scripts/verify-wfp-serving.mjs --help
 *
 * The apex `projectsites.dev` serves marketing from R2 — it is expected-R2, not
 * a WfP site, so it is exempt from the strict fallback check (reported only).
 */

// Mirror current Chrome stable per rules/fetch-defaults.md (avoid CF bot-challenge).
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

// Default hosts: a known published WfP site + the apex (expected-R2 marketing).
const DEFAULT_HOSTS = ['lonemountainglobal.projectsites.dev', 'projectsites.dev'];
// Hosts that legitimately serve from R2 (not WfP) — exempt from strict fallback fail.
const EXPECTED_R2 = new Set(['projectsites.dev', 'www.projectsites.dev']);

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'verify-wfp-serving.mjs — WfP-vs-R2 serving gate (reads x-ps-serve on prod).',
      '',
      'Usage: node scripts/verify-wfp-serving.mjs [--strict] [host ...]',
      '  host…     published-site hostnames (default: ' + DEFAULT_HOSTS.join(', ') + ')',
      '  --strict  exit 1 if any host is MISSING the header or is a silent R2 fallback',
      '  --help    show this help',
    ].join('\n'),
  );
  process.exit(0);
}

const STRICT = args.includes('--strict');
const hosts = args.filter((a) => !a.startsWith('-'));
const targets = hosts.length ? hosts : DEFAULT_HOSTS;

/** Fetch one host, return { host, status, marker }. marker: 'wfp'|'r2'|'MISSING'|'ERR'. */
async function probe(host) {
  const url = host.startsWith('http') ? host : `https://${host}/`;
  try {
    const res = await fetch(url, { headers: REAL_HEADERS, redirect: 'follow' });
    const marker = res.headers.get('x-ps-serve') ?? 'MISSING';
    return { host, status: String(res.status), marker };
  } catch (err) {
    return { host, status: 'ERR', marker: `ERR:${err?.cause?.code || err?.name || 'fetch'}` };
  }
}

const results = await Promise.all(targets.map(probe));

const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(4, ...results.map((r) => r.host.length));
console.log(`${pad('HOST', w)}  STATUS  X-PS-SERVE`);
console.log(`${'-'.repeat(w)}  ------  ----------`);
for (const r of results) console.log(`${pad(r.host, w)}  ${pad(r.status, 6)}  ${r.marker}`);

// Strict classification: MISSING on any host, or a WfP-expected host served by r2.
const missing = results.filter((r) => r.marker === 'MISSING');
const fellBack = results.filter((r) => r.marker === 'r2' && !EXPECTED_R2.has(r.host));
if (missing.length) {
  console.log(`\n⚠ ${missing.length} host(s) MISSING x-ps-serve (expected on every published site after fire-82): ${missing.map((r) => r.host).join(', ')}`);
}
if (fellBack.length) {
  console.log(`\n⚠ ${fellBack.length} host(s) silently served from R2 despite WfP being canonical: ${fellBack.map((r) => r.host).join(', ')}`);
}
if (!missing.length && !fellBack.length) console.log('\n✓ every host carries x-ps-serve; no silent R2 fallback.');

process.exit(STRICT && (missing.length || fellBack.length) ? 1 : 0);
