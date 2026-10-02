#!/usr/bin/env node
// @ts-check
/**
 * reconfirm-carried-blockers.mjs — BATCH carried-blocker re-confirm (deterministic).
 *
 * WHY (fire-71 / fire-78 / fire-79 / fire-80): a fire kept burning a fix-agent re-fixing
 * a blocker a PRIOR fire had ALREADY shipped — the editor `frame-ancestors` CSP that
 * fire-60 deployed (`9077b8ebb`) lingered OPEN in the backlog ~20 fires and nearly
 * re-tempted a fix-agent in fire-79/80. The loop command §5 mandates "re-confirm CARRIED
 * findings LIVE before assigning a fix-agent," and the singular
 * `reconfirm-carried-blocker.mjs` proves ONE header per call — but a fire carries SEVERAL
 * blockers of DIFFERENT shapes (a header, a live endpoint, a shell/D1 reconcile). This is
 * the ONE command that re-confirms the WHOLE carried set at once, from a committed JSON
 * list, so a fire never assigns off a stale checkpoint.
 *
 * Sibling: `reconfirm-carried-blocker.mjs` (singular) — a single `<url> <header-substring>`
 * check. This driver reuses its realistic-UA + CF-bot-retry philosophy and generalizes it
 * to a batch across three check TYPES.
 *
 * Usage:
 *   node reconfirm-carried-blockers.mjs                 # reads e2e/carried-blockers.json
 *   node reconfirm-carried-blockers.mjs <path.json>     # explicit list
 *   node reconfirm-carried-blockers.mjs --json          # machine-readable envelope on stdout
 *   node reconfirm-carried-blockers.mjs --selftest      # no network; exercises pure logic
 *
 * JSON list shape — an array of checks, each:
 *   { "id": "editor-csp-frame-ancestors",
 *     "type": "header" | "endpoint" | "shell",
 *     "description": "human one-liner (what/why it was carried)",
 *     // header + endpoint:
 *     "url": "https://editor.projectsites.dev",
 *     "contains": "localhost:4200",      // required substring (header VALUE or body text)
 *     // endpoint only (optional):
 *     "status": 200,                      // assert this HTTP status when present
 *     // shell only:
 *     "command": "node some-check.mjs",   // run via `sh -c`; asserts exit 0 + `contains`
 *   }
 *
 * Per-check verdict:
 *   PASS      — resolved; the blocker is STALE → RETIRE it from the backlog this fire.
 *   STILL-OPEN — genuinely unresolved → a fix-agent is justified.
 *   ERROR     — ambiguous (network / bot-challenge / bad check) → escalate to a real browser.
 *
 * Exit code (uniform): 0 when EVERY check is PASS (all carried blockers resolved → nothing
 * to assign); 1 when ANY check is STILL-OPEN or ERROR (fix work or escalation remains).
 *
 * Safe-by-default: argv-validated, no deps beyond node builtins, no network in --selftest,
 * CI-safe styling (gum when present via ~/.claude/hooks/style.sh, else plain — NEVER raw echo).
 *
 * @see .claude/run-the-loop/OPERATING-PRINCIPLES.md § Carried-blocker re-confirm
 * @see apps/project-sites/scripts/reconfirm-carried-blocker.mjs (singular, single-header)
 * @see .claude/commands/run-the-loop.md §5 "Re-confirm CARRIED findings LIVE"
 * @see memory stale🚧 (re-confirm a carried blocker LIVE before assigning a fix-agent)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Mirror Chrome stable per the fetch-defaults rule (avoids WAF / CF-bot-challenge blocks).
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

/** Resolve the repo root so the default JSON path works from any cwd (main checkout OR a worktree). */
function resolveRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // Fall back to two dirs up from this script (apps/project-sites/scripts → repo root).
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  }
}

/** Default committed list of the fire's current carried blockers. */
function defaultListPath() {
  const root = resolveRepoRoot();
  return join(root, 'apps', 'project-sites', 'e2e', 'carried-blockers.json');
}

/**
 * Pure matcher for a header check — RESOLVED vs STILL-OPEN from a header map.
 * Matches <contains> (case-insensitive) first against header NAMES, then against header
 * VALUES (so CSP directives like `frame-ancestors`, which live inside the
 * `content-security-policy` value, resolve correctly).
 *
 * @param {Record<string, string>} headers  name -> value
 * @param {string} contains                 substring sought in a header NAME or VALUE
 * @returns {{ resolved: boolean, name: string|null, value: string|null }}
 */
export function evaluateHeader(headers, contains) {
  const want = String(contains).toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase().includes(want)) return { resolved: true, name, value };
  }
  for (const [name, value] of Object.entries(headers)) {
    if (String(value).toLowerCase().includes(want)) return { resolved: true, name, value };
  }
  return { resolved: false, name: null, value: null };
}

/**
 * Pure matcher for a body/text check — RESOLVED when <contains> appears AND (when given)
 * the status matches. Used by both `endpoint` and `shell` checks.
 *
 * @param {string} text                   response body OR command stdout+stderr
 * @param {string} contains               required substring
 * @param {number|null} wantStatus        required status (endpoint) or exit sentinel; null = skip
 * @param {number|null} actualStatus      observed status/exit; null = skip the comparison
 * @returns {{ resolved: boolean, statusOk: boolean, bodyOk: boolean }}
 */
export function evaluateBody(text, contains, wantStatus, actualStatus) {
  const bodyOk =
    contains === '' || String(text).toLowerCase().includes(String(contains).toLowerCase());
  const statusOk =
    wantStatus === null || actualStatus === null ? true : Number(actualStatus) === Number(wantStatus);
  return { resolved: bodyOk && statusOk, statusOk, bodyOk };
}

/**
 * Validate + normalize one raw check entry; throws on a malformed entry so a bad list fails
 * fast (this script is a build/loop tool — fail-fast in tooling per the house rule).
 * @param {unknown} raw
 * @param {number} i
 */
function normalizeCheck(raw, i) {
  if (typeof raw !== 'object' || raw === null) throw new Error(`check[${i}] is not an object`);
  const c = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof c.id === 'string' && c.id ? c.id : `check-${i}`;
  const type = c.type;
  if (type !== 'header' && type !== 'endpoint' && type !== 'shell') {
    throw new Error(`check[${id}] has invalid type: ${JSON.stringify(type)} (want header|endpoint|shell)`);
  }
  const description = typeof c.description === 'string' ? c.description : '';
  const contains = typeof c.contains === 'string' ? c.contains : '';
  if (type === 'header' || type === 'endpoint') {
    if (typeof c.url !== 'string' || !c.url) throw new Error(`check[${id}] (${type}) requires a url`);
    try {
      new URL(c.url);
    } catch {
      throw new Error(`check[${id}] has an invalid url: ${c.url}`);
    }
  }
  if (type === 'header' && !contains) throw new Error(`check[${id}] (header) requires "contains"`);
  if (type === 'shell' && (typeof c.command !== 'string' || !c.command)) {
    throw new Error(`check[${id}] (shell) requires a command`);
  }
  const status =
    typeof c.status === 'number' && Number.isFinite(c.status) ? Math.trunc(c.status) : null;
  return {
    id,
    type,
    description,
    url: typeof c.url === 'string' ? c.url : '',
    contains,
    status,
    command: typeof c.command === 'string' ? c.command : '',
  };
}

/**
 * Fetch a URL, following redirects, collecting headers + (optionally) the body.
 * Non-2xx with the full browser header-set retries ONCE UA-only (CF bot-challenge dodge,
 * per the singular script + the cf-bot-challenge memory).
 * @param {string} url
 * @param {boolean} wantBody
 * @returns {Promise<{ ok: boolean, status: number, headers: Record<string,string>, body: string }>}
 */
async function fetchUrl(url, wantBody) {
  /** @param {Record<string,string>} h */
  const doFetch = (h) => fetch(url, { method: 'GET', headers: h, redirect: 'follow' });
  /** @param {Response} res */
  const collectHeaders = (res) => {
    /** @type {Record<string, string>} */
    const headers = {};
    res.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return headers;
  };
  let res = await doFetch(REAL_HEADERS);
  if (res.status === 403 || res.status === 503) {
    res = await doFetch({ 'User-Agent': REAL_UA, Accept: REAL_HEADERS.Accept });
  }
  const body = wantBody ? await res.text() : '';
  return { ok: res.ok, status: res.status, headers: collectHeaders(res), body };
}

/**
 * Run one normalized check → a verdict object.
 * @param {ReturnType<typeof normalizeCheck>} check
 * @returns {Promise<{ id: string, verdict: 'PASS'|'STILL-OPEN'|'ERROR', detail: string }>}
 */
async function runCheck(check) {
  try {
    if (check.type === 'header') {
      const res = await fetchUrl(check.url, false);
      if (!res.ok) {
        return {
          id: check.id,
          verdict: 'ERROR',
          detail: `HTTP ${res.status} (likely a bot challenge) — escalate to a real browser`,
        };
      }
      const { resolved, name } = evaluateHeader(res.headers, check.contains);
      return {
        id: check.id,
        verdict: resolved ? 'PASS' : 'STILL-OPEN',
        detail: resolved
          ? `${name} contains "${check.contains}"`
          : `no header contains "${check.contains}" (checked ${Object.keys(res.headers).length} headers)`,
      };
    }
    if (check.type === 'endpoint') {
      const res = await fetchUrl(check.url, true);
      const { resolved, statusOk, bodyOk } = evaluateBody(
        res.body,
        check.contains,
        check.status,
        res.status,
      );
      if (resolved) {
        return {
          id: check.id,
          verdict: 'PASS',
          detail: `HTTP ${res.status}${check.contains ? ` + body contains "${check.contains}"` : ''}`,
        };
      }
      const why = [];
      if (!statusOk) why.push(`status ${res.status} ≠ ${check.status}`);
      if (!bodyOk) why.push(`body lacks "${check.contains}"`);
      return { id: check.id, verdict: 'STILL-OPEN', detail: why.join('; ') || 'unresolved' };
    }
    // shell
    let out = '';
    let exit = 0;
    try {
      out = execFileSync('sh', ['-c', check.command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch (err) {
      const e = /** @type {{ status?: number, stdout?: string|Buffer, stderr?: string|Buffer }} */ (
        err ?? {}
      );
      exit = typeof e.status === 'number' ? e.status : 1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    const { resolved } = evaluateBody(out, check.contains, 0, exit);
    return {
      id: check.id,
      verdict: resolved ? 'PASS' : 'STILL-OPEN',
      detail: resolved
        ? `exit 0${check.contains ? ` + output contains "${check.contains}"` : ''}`
        : exit !== 0
          ? `command exited ${exit}`
          : `output lacks "${check.contains}"`,
    };
  } catch (err) {
    return {
      id: check.id,
      verdict: 'ERROR',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ----------------------------------------------------------------------------- styling --- */

/**
 * Load the emdash_* gum helpers if present; otherwise a plain CI-safe fallback.
 * We shell out to style.sh for the ACTUAL styled lines (it is a bash lib) only for the
 * header + status lines; the table body is printed plainly so it stays parseable + stable.
 * @returns {{ header:(s:string)=>void, success:(s:string)=>void, warn:(s:string)=>void, error:(s:string)=>void, info:(s:string)=>void }}
 */
function loadStyle() {
  const stylePath = join(homedir(), '.claude', 'hooks', 'style.sh');
  const hasStyle = existsSync(stylePath);
  /** @param {string} fn @param {string} msg */
  const call = (fn, msg) => {
    if (!hasStyle) return false;
    try {
      // Route emdash_* output through to this process's stdout/stderr.
      execFileSync('bash', ['-c', `source ${JSON.stringify(stylePath)} && ${fn} ${JSON.stringify(msg)}`], {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  };
  return {
    header: (s) => {
      if (!call('emdash_header', s)) console.log(`\n── ${s} ──`);
    },
    success: (s) => {
      if (!call('emdash_success', s)) console.log(`✓ ${s}`);
    },
    warn: (s) => {
      if (!call('emdash_warn', s)) console.log(`⚠ ${s}`);
    },
    error: (s) => {
      if (!call('emdash_error', s)) console.error(`✗ ${s}`);
    },
    info: (s) => {
      if (!call('emdash_info', s)) console.log(s);
    },
  };
}

/** Render the verdict table (plain + stable so it's greppable). */
function printTable(results) {
  const label = {
    PASS: 'PASS (stale, retire)',
    'STILL-OPEN': 'STILL-OPEN',
    ERROR: 'ERROR',
  };
  const idWidth = Math.max(2, ...results.map((r) => r.id.length));
  for (const r of results) {
    console.log(`  ${r.id.padEnd(idWidth)}  —  ${label[r.verdict]}  —  ${r.detail}`);
  }
}

/* -------------------------------------------------------------------------- self-test --- */

function selftest() {
  let pass = true;
  /** @param {boolean} ok @param {string} msg */
  const assert = (ok, msg) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
    pass = pass && ok;
  };

  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "frame-ancestors 'self' http://localhost:4200 http://localhost:4300",
  };
  assert(evaluateHeader(headers, 'content-type').resolved === true, 'header: name match');
  const dir = evaluateHeader(headers, 'localhost:4300');
  assert(dir.resolved === true && dir.name === 'content-security-policy', 'header: CSP directive value-fallback');
  assert(evaluateHeader(headers, 'x-missing').resolved === false, 'header: absent → STILL-OPEN');

  assert(evaluateBody('{"ok":true}', 'ok', 200, 200).resolved === true, 'endpoint: body + status PASS');
  assert(evaluateBody('{"ok":true}', 'ok', 200, 404).resolved === false, 'endpoint: wrong status → STILL-OPEN');
  assert(evaluateBody('anything', '', 200, 200).resolved === true, 'endpoint: empty contains = status-only PASS');
  assert(evaluateBody('name|type', 'name', 0, 0).resolved === true, 'shell: output + exit0 PASS');
  assert(evaluateBody('boom', 'name', 0, 1).resolved === false, 'shell: nonzero exit → STILL-OPEN');

  // normalizeCheck validation.
  let threw = false;
  try {
    normalizeCheck({ id: 'x', type: 'bogus' }, 0);
  } catch {
    threw = true;
  }
  assert(threw, 'normalize: invalid type throws');
  const ok = normalizeCheck(
    { id: 'csp', type: 'header', url: 'https://editor.projectsites.dev', contains: 'localhost:4200' },
    0,
  );
  assert(ok.id === 'csp' && ok.type === 'header', 'normalize: valid header check');

  console.log(pass ? 'SELFTEST: PASS' : 'SELFTEST: FAIL');
  return pass;
}

/* ------------------------------------------------------------------------------- main --- */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }
  const asJson = argv.includes('--json');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const listPath = positional[0] ? resolve(positional[0]) : defaultListPath();
  const style = asJson ? null : loadStyle();

  if (!existsSync(listPath)) {
    const msg = `carried-blockers list not found: ${listPath}`;
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: msg, results: [] }));
    } else {
      style?.error(msg);
      style?.info('Seed it at apps/project-sites/e2e/carried-blockers.json (array of {id,type,url|command,contains}).');
    }
    process.exit(1);
  }

  /** @type {ReturnType<typeof normalizeCheck>[]} */
  let checks;
  try {
    const parsed = JSON.parse(readFileSync(listPath, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.checks) ? parsed.checks : null;
    if (!arr) throw new Error('list must be a JSON array (or { "checks": [...] })');
    checks = arr.map((c, i) => normalizeCheck(c, i));
  } catch (err) {
    const msg = `failed to parse ${listPath}: ${err instanceof Error ? err.message : String(err)}`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg, results: [] }));
    else style?.error(msg);
    process.exit(1);
  }

  const results = [];
  for (const check of checks) {
    // Serial on purpose: a handful of carried blockers; serial keeps output ordered + cheap.
    results.push(await runCheck(check));
  }

  const open = results.filter((r) => r.verdict === 'STILL-OPEN');
  const errored = results.filter((r) => r.verdict === 'ERROR');
  const passed = results.filter((r) => r.verdict === 'PASS');
  const allResolved = open.length === 0 && errored.length === 0;

  if (asJson) {
    console.log(
      JSON.stringify({
        ok: allResolved,
        list: listPath,
        summary: { total: results.length, pass: passed.length, open: open.length, error: errored.length },
        results,
      }),
    );
    process.exit(allResolved ? 0 : 1);
  }

  style?.header('Carried-blocker re-confirm (LIVE)');
  printTable(results);
  const summary = `${passed.length} stale/retire · ${open.length} still-open · ${errored.length} error (of ${results.length})`;
  if (allResolved) {
    style?.success(`All carried blockers RESOLVED — ${summary}. Retire them in the backlog; assign NO fix-agent.`);
  } else {
    if (open.length) style?.warn(`${open.length} STILL-OPEN — a fix-agent is justified for: ${open.map((r) => r.id).join(', ')}`);
    if (errored.length) style?.error(`${errored.length} ERROR — escalate to a real browser: ${errored.map((r) => r.id).join(', ')}`);
    style?.info(summary);
  }
  process.exit(allResolved ? 0 : 1);
}

main();
