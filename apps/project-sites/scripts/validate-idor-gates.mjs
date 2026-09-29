#!/usr/bin/env node
/**
 * validate-idor-gates.mjs — Lane-6 security-hardening gate.
 *
 * Enumerates EVERY route handler across `src/routes/**` + `libs/features/**`
 * whose registered path carries a `:siteId` (or a `/sites/:id` / `/site/:id`)
 * path parameter, and asserts each one enforces per-site ownership before it
 * touches the site's data. This is the standing drift-guard the security
 * discovery doc (`docs/_loop-scan/discovery-security-2026-09-29.md`, item 2)
 * called for: today ZERO handlers are unguarded — the ownership-guard
 * discipline is universal — but nothing FAILS THE BUILD when a NEW
 * `:siteId` handler ships without a guard. This closes that gap.
 *
 * A handler "satisfies the gate" when its body contains ANY of:
 *
 *   1. A PRIMARY named ownership guard (the canonical set):
 *        assertSiteOwned | assertSiteOwnership | loadOwnedSite |
 *        requireOwnedSite | requireSiteMembership
 *   2. A secondary named ownership helper already proven in the codebase
 *      (each scopes its query to the caller's org — see RECOGNIZER below).
 *   3. An inline `org_id` / `user_id` SQL scope bound to `orgId` / `userId`
 *      (`WHERE … org_id = ?` / `AND org_id = ?` / `org_id !== orgId` …).
 *   4. A super-admin gate (`isSuperAdmin` / `requireSuperAdmin` /
 *      `/api/super-admin/`) — a platform-operator surface, ownership-exempt
 *      by design.
 *
 * A small ALLOWLIST exempts genuinely public / unauthenticated `:siteId`
 * surfaces (contact-form ingest, public data, container upload callbacks).
 *
 * Usage:
 *   node scripts/validate-idor-gates.mjs            # human report, exit 1 on any gap
 *   node scripts/validate-idor-gates.mjs --json     # machine envelope on stdout
 *   node scripts/validate-idor-gates.mjs --quiet     # exit code only
 *
 * Exit 0 → every :siteId handler is guarded (or allowlisted).
 * Exit 1 → one or more unguarded :siteId handlers (offenders listed).
 *
 * Node 22 native ESM — no build step. Regex-based (no TS parse) so it runs
 * fast in the lint chain; it is a DRIFT guard, not a proof of correctness.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);

const JSON_MODE = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');

// ── Directories scanned ────────────────────────────────────────────────────
const SCAN_DIRS = [path.join(ROOT, 'src', 'routes'), path.join(ROOT, 'libs', 'features')];

// ── Guard recognizers ────────────────────────────────────────────────────────
// PRIMARY: the canonical named guards the brief mandates.
const PRIMARY_GUARDS = [
  'assertSiteOwned',
  'assertSiteOwnership',
  'loadOwnedSite',
  'requireOwnedSite',
  'requireSiteMembership',
];

// The full recognizer: PRIMARY + secondary named helpers proven in-tree
// (each scopes to the caller's org) + inline org_id/user_id SQL scoping +
// super-admin gates. Matches the enforcement vocabulary the codebase already
// uses so a correctly-guarded handler is never a false offender.
const GUARD_PATTERNS = [
  new RegExp(`\\b(?:${PRIMARY_GUARDS.join('|')})\\b`),
  // Secondary named ownership helpers (org-scoped) verified across the routes.
  /\b(?:loadSiteAndAuth|assertOwner|gateOwnedSite|fetchOwnedSite|verifySiteOwnership|ownsSiteData|ownsSite|siteOwned|loadOwnedSubmission|loadOwnedEndpoint|loadAuthorizedSite|assertMembership|resolveSnapshot|restoreSnapshot|recordDnaFeedback|getDnaPreferences|listDnaFeedback)\b/,
  // Super-admin / platform-operator surfaces (ownership-exempt by design).
  /\bisSuperAdmin\b/,
  /\brequireSuperAdmin\b/,
  /\/api\/super-admin\//,
  // Inline org_id / user_id SQL scoping bound to the caller.
  // Local per-handler ownership-wrapper helpers: a route delegates its
  // ownership check to a file-local guard that returns `Response | { orgId }`
  // (or `{ block }`). These are the dominant Hono pattern in this repo — each
  // one calls assertSiteOwned / ownsSiteData / org_id-scoping internally, so a
  // handler that invokes one IS guarded. Word-bounded so `navigate(` /
  // `propagate(` never false-match. Covers the `gate*` family
  // (gate / gateAndResolve / gateAndBucket / gateResolveAndRequireTable),
  // `*Guard` (adminGuard / siteGuard), `siteOwned` / `owns*` / `resolveSiteDataDb`.
  /\b(?:gate[A-Za-z]*|[A-Za-z]*Guard|siteOwned|owns[A-Za-z]*|resolveSiteDataDb)\s*\(/,
  // Inline org_id / user_id SQL scoping bound to the caller (SELECT/UPDATE and
  // INSERT/`.bind(orgId,…)` forms — an owner-scoped write is guarded too).
  /org_id\s*(?:!==|===|!=|==)\s*/,
  /(?:!==|===|!=|==)\s*orgId\b/,
  /\b[a-z_]*org_id\s*=\s*\?/i,
  /\b[a-z_]*org_id\s*=\s*orgId\b/,
  /\buser_id\s*=\s*\?/i,
  /\buser_id\s*=\s*userId\b/,
  /\bWHERE\s+[a-z_.]*org_id/i,
  /\bAND\s+[a-z_.]*org_id/i,
  /\(\s*org_id\s*,/i, // INSERT (org_id, …) column list — owner-scoped write
  /\.bind\(\s*orgId\b/, // parameterized bind of the caller's org id
];

// ── Allowlist — genuinely public / unauthenticated :siteId surfaces ──────────
// Each entry is a RegExp matched against the route path literal. Keep this
// SMALL and justified — a new entry means "this :siteId route is intentionally
// reachable without ownership" (public ingest, callbacks). Anything else must
// be guarded, not allowlisted.
const PUBLIC_ALLOWLIST = [
  /^\/api\/contact-form\//, // public form ingest (site slug in path, no auth)
  /^\/api\/public-data\//, // explicitly-public read surface
  /^\/api\/container-upload\//, // signed internal build callback
  /^\/api\/v1\/forms\/submit/, // public forms ingest (X-Site-Slug header)
  // Org-authenticated + flag-gated, but the `:siteId` segment is NOT a
  // data-access key: these read ORG-scoped config (loadAutoPilotConfig(orgId))
  // or pure static calendar constants — no per-site row is read or written, so
  // there is no cross-site IDOR surface to guard. (social_posts.ts)
  /^\/api\/social\/:siteId\/posts\/generate$/, // returns AI drafts from org config; no site_id query
  /^\/api\/social\/:siteId\/posting-times$/, // returns static BEST_TIMES constants; siteId unused
];

// Route methods we enumerate.
const METHOD_RE = /\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
// A path carrying a per-site identifier param.
const SITE_ID_PATH_RE = /:siteId\b|\/sites?\/:id\b/;

// ── File walk ──────────────────────────────────────────────────────────────
async function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      out.push(...(await walk(full)));
    } else if (
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.d.ts') &&
      !e.name.endsWith('.test.ts') &&
      !e.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collect real ROUTE registrations (method + path + char offset) from a source
 * string, in source order. Two guards keep false matches out:
 *
 *   1. The path must start with `/` — excludes Hono context getters
 *      (`c.get('orgId')`, `c.req.param('siteId')`) which share the `.get(`
 *      shape but never carry a leading-slash path.
 *   2. The match must NOT sit inside a JSDoc / line comment — a
 *      `@see {@link app.get('/api/sites/:siteId/…')}` reference in a doc block
 *      is NOT a registration (it produced phantom "unguarded" duplicates).
 *      Heuristic: skip when the match's own line is a `*`/`//` comment line or
 *      the ~16 chars before it contain `@link` / `@see`.
 *
 * @param {string} src
 * @returns {{method:string,path:string,index:number}[]}
 */
function collectRegistrations(src) {
  const regs = [];
  for (const m of src.matchAll(METHOD_RE)) {
    if (!m[2].startsWith('/')) continue;
    const idx = m.index ?? 0;
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const linePrefix = src.slice(lineStart, idx);
    // JSDoc/comment line, or an @link/@see reference immediately before the call.
    if (/^\s*(?:\*|\/\/)/.test(linePrefix)) continue;
    if (/@(?:link|see)\b/.test(src.slice(Math.max(0, idx - 16), idx))) continue;
    regs.push({ method: m[1].toUpperCase(), path: m[2], index: idx });
  }
  return regs;
}

/**
 * Scan one file's source for unguarded :siteId handlers.
 * Exported pure so a unit test can drive it with a synthetic source string.
 *
 * @param {string} src - the file contents
 * @param {string} file - display path (for findings)
 * @returns {{file:string,line:number,method:string,path:string}[]}
 */
export function scanSource(src, file) {
  const findings = [];
  const regs = collectRegistrations(src);
  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i];
    if (!SITE_ID_PATH_RE.test(reg.path)) continue;
    if (PUBLIC_ALLOWLIST.some((re) => re.test(reg.path))) continue;
    // Handler body = from this registration to the next registration (or EOF),
    // capped so a huge trailing file doesn't leak guards from a sibling handler.
    const bodyStart = reg.index;
    const bodyEnd = i + 1 < regs.length ? regs[i + 1].index : src.length;
    const body = src.slice(bodyStart, Math.min(bodyEnd, bodyStart + 8000));
    const guarded = GUARD_PATTERNS.some((re) => re.test(body));
    if (!guarded) {
      const line = src.slice(0, reg.index).split('\n').length;
      findings.push({ file, line, method: reg.method, path: reg.path });
    }
  }
  return findings;
}

async function main() {
  const files = [];
  for (const d of SCAN_DIRS) files.push(...(await walk(d)));

  const findings = [];
  let handlerCount = 0;
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    // Count :siteId route registrations for the summary (same collector the
    // scanner uses, so the count can't drift from what's checked).
    for (const reg of collectRegistrations(src)) {
      if (SITE_ID_PATH_RE.test(reg.path)) handlerCount++;
    }
    findings.push(...scanSource(src, rel(f)));
  }

  const summary = {
    files_scanned: files.length,
    site_id_handlers: handlerCount,
    offenders: findings.length,
    exit: findings.length === 0 ? 0 : 1,
  };

  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify(
        {
          meta: {
            repo: ROOT,
            generated_at: new Date().toISOString(),
            gate: 'validate-idor-gates',
            primary_guards: PRIMARY_GUARDS,
          },
          findings,
          summary,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(summary.exit);
  }

  if (!QUIET) {
    if (findings.length === 0) {
      console.warn(
        `✓ IDOR gate: ${handlerCount} \`:siteId\` handlers across ${files.length} files — all enforce an ownership guard.`,
      );
    } else {
      console.error(
        `✗ IDOR gate: ${findings.length} \`:siteId\` handler(s) with NO ownership guard:\n`,
      );
      for (const f of findings) {
        console.error(`  ${f.file}:${f.line}  ${f.method} ${f.path}`);
      }
      console.error(
        `\nEach must call a per-site ownership guard (${PRIMARY_GUARDS.join(
          ' | ',
        )}), scope its query to the caller's org_id/user_id, or gate on super-admin. If genuinely public, add it to PUBLIC_ALLOWLIST in scripts/validate-idor-gates.mjs with a one-line justification.`,
      );
    }
  }
  process.exit(summary.exit);
}

main().catch((err) => {
  console.error('validate-idor-gates: fatal', err);
  process.exit(1);
});
