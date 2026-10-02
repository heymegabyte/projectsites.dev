#!/usr/bin/env node
// @ts-check
/**
 * reconfirm-carried-blocker.mjs — deterministic carried-blocker re-confirm helper.
 *
 * WHY (fire-79): the case-001 checkpoint claimed the editor `frame-ancestors` blocker
 * was LIVE when it had been RESOLVED fire-72; the lead had to hand-curl prod to find it
 * stale. Per OPERATING-PRINCIPLES § Convergence discipline + the adversarial-review
 * "re-confirm carried findings LIVE" rule, every fire must re-confirm a carried blocker
 * against prod BEFORE assigning a fix agent. This makes that check one deterministic call.
 *
 * Usage:
 *   node reconfirm-carried-blocker.mjs <url> <header-substring> [--contains <needle>]
 *   node reconfirm-carried-blocker.mjs --selftest
 *
 * Semantics:
 *   - Fetches <url> with a realistic Chrome UA (per fetch-defaults), reads response headers.
 *   - Resolves a target header by matching <header-substring> (case-insensitive) first against
 *     header NAMES, then — if no name matches — against header VALUES. The value fallback is
 *     what makes CSP *directives* work: `frame-ancestors` is not a header, it lives inside the
 *     `content-security-policy` VALUE, so matching only names would false-negative. (fire-79.)
 *   - With --contains <needle>: asserts the matched header's VALUE contains <needle>.
 *     Without --contains: asserts the header (by name OR value) is merely PRESENT.
 *
 * Exit codes:
 *   0  RESOLVED      — header present (and value contains the needle when given).
 *   1  STILL-BLOCKED — header missing, or value missing the needle.
 *   2  ERROR         — bad args / network / non-OK fetch failure.
 *
 * Safe-by-default: argv-validated, no network in --selftest, no deps beyond node builtins.
 */

// Mirror Chrome stable per the fetch-defaults rule (avoids WAF/bot-challenge blocks).
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const REAL_HEADERS = {
  'User-Agent': REAL_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Upgrade-Insecure-Requests': '1',
};

const USAGE =
  'Usage: reconfirm-carried-blocker.mjs <url> <header-substring> [--contains <needle>]\n' +
  '       reconfirm-carried-blocker.mjs --selftest';

/**
 * Pure matcher — decides RESOLVED vs STILL-BLOCKED from a header map.
 * Separated from I/O so --selftest can exercise it deterministically.
 *
 * <header-substring> is matched (case-insensitive) first against header NAMES; if no name
 * matches, it is matched against header VALUES (so CSP directives like `frame-ancestors`,
 * which live inside the `content-security-policy` value, resolve correctly). The VALUE of the
 * matched header is then tested against <needle> when one is supplied.
 *
 * @param {Record<string, string>} headers  name -> value
 * @param {string} headerSubstring          substring to match within a header NAME or VALUE
 * @param {string|null} needle              required substring of the header VALUE, or null = presence-only
 * @returns {{ resolved: boolean, name: string|null, value: string|null }}
 */
export function evaluateHeader(headers, headerSubstring, needle) {
  const want = String(headerSubstring).toLowerCase();
  let matchedName = null;
  let matchedValue = null;
  // Pass 1 — match by header name (the "is this header present" case).
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase().includes(want)) {
      matchedName = name;
      matchedValue = value;
      break;
    }
  }
  // Pass 2 — fall back to matching by header value (the CSP-directive case).
  if (matchedName === null) {
    for (const [name, value] of Object.entries(headers)) {
      if (String(value).toLowerCase().includes(want)) {
        matchedName = name;
        matchedValue = value;
        break;
      }
    }
  }
  if (matchedName === null) {
    return { resolved: false, name: null, value: null };
  }
  if (needle === null) {
    return { resolved: true, name: matchedName, value: matchedValue };
  }
  const resolved = String(matchedValue).toLowerCase().includes(String(needle).toLowerCase());
  return { resolved, name: matchedName, value: matchedValue };
}

/**
 * Parse argv (excluding node + script path) into a validated shape.
 * @param {string[]} argv
 * @returns {{ selftest: true } | { selftest: false, url: string, headerSubstring: string, needle: string|null }}
 */
function parseArgs(argv) {
  if (argv.includes('--selftest')) return { selftest: true };
  /** @type {string[]} */
  const positional = [];
  let needle = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--contains') {
      needle = argv[i + 1] ?? null;
      i++;
      if (needle === null) throw new Error('--contains requires a value');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 2) throw new Error('missing <url> and/or <header-substring>');
  const [url, headerSubstring] = positional;
  try {
    // Validate the URL shape early (fail fast with usage, not a fetch stack trace).
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  return { selftest: false, url, headerSubstring, needle };
}

/**
 * Fetch the URL and collect its response headers into a plain object.
 *
 * Non-2xx is treated as AMBIGUOUS, not "blocker is back": a 403/503 is usually a CF bot
 * challenge whose challenge-page headers would false-report STILL-BLOCKED (the real app
 * headers never load). On a 403/503 with the full browser-header set we retry ONCE with a
 * minimal UA-only set — the full `Sec-Fetch-*` navigate signature trips CF's challenge on
 * some hosts while a plainer UA passes (per fetch-defaults § escalation + the
 * cf-bot-challenge memory). Still non-2xx after the retry → caller surfaces ERROR (exit 2).
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, headers: Record<string, string> }>}
 */
async function fetchHeaders(url) {
  /** @param {Record<string,string>} h */
  const doFetch = (h) => fetch(url, { method: 'GET', headers: h, redirect: 'follow' });
  /** @param {Response} res */
  const collect = (res) => {
    /** @type {Record<string, string>} */
    const headers = {};
    res.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return headers;
  };

  let res = await doFetch(REAL_HEADERS);
  // CF bot-challenge responses (403/503) with the full header set → retry UA-only.
  if ((res.status === 403 || res.status === 503)) {
    res = await doFetch({ 'User-Agent': REAL_UA, Accept: REAL_HEADERS.Accept });
  }
  return { ok: res.ok, status: res.status, headers: collect(res) };
}

/** Deterministic self-test of the pure matcher against a stable public header name. */
function selftest() {
  let pass = true;
  const fixture = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "frame-ancestors 'self' http://localhost:4200",
  };

  // 1. Known-good: presence-only match on a header that exists.
  const good = evaluateHeader(fixture, 'content-type', null);
  const goodOk = good.resolved === true;
  console.log(`${goodOk ? 'PASS' : 'FAIL'} present: content-type found=${good.resolved}`);
  pass = pass && goodOk;

  // 2. Known-good: value-needle match.
  const needleGood = evaluateHeader(fixture, 'content-security-policy', 'localhost:4200');
  const needleGoodOk = needleGood.resolved === true;
  console.log(
    `${needleGoodOk ? 'PASS' : 'FAIL'} needle-hit: csp contains localhost:4200=${needleGood.resolved}`,
  );
  pass = pass && needleGoodOk;

  // 3. Known-bad: header absent.
  const missing = evaluateHeader(fixture, 'x-does-not-exist', null);
  const missingOk = missing.resolved === false;
  console.log(`${missingOk ? 'PASS' : 'FAIL'} absent: x-does-not-exist missing=${!missing.resolved}`);
  pass = pass && missingOk;

  // 4. Known-bad: header present but value lacks the needle.
  const needleBad = evaluateHeader(fixture, 'content-security-policy', 'frame-src');
  const needleBadOk = needleBad.resolved === false;
  console.log(
    `${needleBadOk ? 'PASS' : 'FAIL'} needle-miss: csp lacks frame-src=${!needleBad.resolved}`,
  );
  pass = pass && needleBadOk;

  // 5. Value-fallback: a CSP directive (not a header name) matched inside the header value,
  //    then needle-checked — this is the exact frame-ancestors/localhost:4200 shape (fire-79).
  const directive = evaluateHeader(fixture, 'frame-ancestors', 'localhost:4200');
  const directiveOk = directive.resolved === true && directive.name === 'content-security-policy';
  console.log(
    `${directiveOk ? 'PASS' : 'FAIL'} value-fallback: frame-ancestors+localhost:4200 in csp=${directive.resolved}`,
  );
  pass = pass && directiveOk;

  console.log(pass ? 'SELFTEST: PASS' : 'SELFTEST: FAIL');
  return pass;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (args.selftest) {
    process.exit(selftest() ? 0 : 1);
  }

  const { url, headerSubstring, needle } = args;
  let result;
  try {
    result = await fetchHeaders(url);
  } catch (err) {
    console.log(`ERROR: fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // Non-2xx is ambiguous (likely a CF bot challenge) — never read challenge-page headers as a
  // confident "blocker is back". Surface ERROR so the lead escalates (real browser) vs. assigns a fix.
  if (!result.ok) {
    console.log(
      `ERROR: ${url} returned HTTP ${result.status} (likely a bot challenge) — cannot confirm; escalate to a real browser`,
    );
    process.exit(2);
  }

  const { resolved, name, value } = evaluateHeader(result.headers, headerSubstring, needle);
  const label = needle === null ? `header "${headerSubstring}"` : `"${needle}"`;
  if (resolved) {
    const shown = name ?? headerSubstring;
    console.log(`RESOLVED: ${shown} contains ${needle === null ? '(present)' : `"${needle}"`}`);
    if (value && needle !== null) console.log(`  ${name}: ${value}`);
    process.exit(0);
  }
  console.log(`STILL-BLOCKED: ${name ?? headerSubstring} missing ${label}`);
  if (value) console.log(`  ${name}: ${value}`);
  process.exit(1);
}

main();
