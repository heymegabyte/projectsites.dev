#!/usr/bin/env node
/**
 * check-get-read-idor.mjs — GET-READ cross-org IDOR detector.
 *
 * `check-idor-handlers.mjs` is MUTATION-only (post/put/patch/delete) — by design.
 * But a GET handler that reads a TENANT row by an attacker-suppliable path id
 * (`:id`/`:siteId`/…) WITHOUT an org-ownership check leaks another org's data
 * (logs, config, submissions, secrets metadata) — the READ half of the fire-17/18
 * IDOR class the mutation detector can't see. The fire-27 sweep cleared 9 GET-by-id
 * endpoints manually; this makes that a durable, tree-wide, per-handler guard so a
 * newly-added unscoped GET read can't regress invisibly in an 11k-line route file.
 *
 * A GET handler is FLAGGED when it:
 *   (a) has a resource-id path param (`:id`/`:siteId`/…), AND
 *   (b) performs a DB READ (dbQuery/dbQueryOne/.first/.all/SELECT), AND
 *   (c) is NOT on the intentionally-public allowlist, AND
 *   (d) has NO org-ownership idiom in its body (the OWNERSHIP set below).
 *
 * Per validator-precision-discipline this prefers FALSE-NEGATIVES: any ownership
 * idiom (a helper that scopes by org, an `org_id = ?` bind, a super-admin gate)
 * clears the handler.
 *
 * Exit 0 by default (report). Pass `--ci` to exit 1 on any finding.
 * Usage: node scripts/check-get-read-idor.mjs [--ci] [--json]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * Org-ownership idioms — the codebase's gate family (kept in sync with
 * check-idor-handlers.mjs, PLUS the read-side helpers that scope inside a callee:
 * getAsset(env, orgId, id) / getOrgScope(c) thread the caller's org). A GET-read
 * handler is org-safe if its body matches ANY of these.
 */
const OWNERSHIP = [
  /\b(?:requireOwnedSite|loadSiteAndAuth|assertSiteOwned|assertSiteOwnership|assertOwner|gateOwnedSite|siteOwned|loadInstance|loadAgent|loadOwnedSite|loadOwnedSubmission|loadAuthorizedSite|ownsSiteData|ownsSite|requireSiteMembership|siteOrgId|restoreSnapshot|getAsset|getOrgScope|loadOwnedEndpoint|resolveEnvVarsForAI|assertMembership|adminGuard|resolveSnapshot)\b/,
  /\bisSuperAdmin\b/,
  /\brequireSuperAdmin\b/,
  /\/api\/super-admin\//,
  /\/api\/admin\//, // admin-scoped surfaces gate at the router/middleware level
  /org_id\s*!==\s*/,
  /!==\s*orgId\b/,
  /org_id\s*!=\s*/,
  /org_id\s*===\s*/,
  /===\s*orgId\b/,
  /\b[a-z_]*org_id\s*=\s*\?/i,
  /\b[a-z_]*org_id\s*=\s*orgId\b/,
  /\buser_id\s*=\s*\?/i,
  /\buser_id\s*=\s*userId\b/,
  /AND\s+[a-z_.]*org_id/i,
  /WHERE\s+[a-z_.]*org_id/i,
];

/**
 * Intentionally-PUBLIC GET reads (no per-tenant ownership BY DESIGN): catalogs,
 * public search, health, the published-site slug surfaces (build-context/chat are
 * `@auth NONE` per iter-159 — published sites are already public), aggregate counts.
 */
const PUBLIC_PATHS = [
  /^\/api\/apps\/catalog/,
  /^\/api\/apps\/install-counts/,
  /^\/api\/sites\/by-slug\//,
  /^\/api\/search\//,
  /^\/api\/public-data\//,
  /^\/api\/feature-flags/,
  /^\/api\/templates(?:\/|$)/, // shared marketplace catalog (visibility-gated, not per-caller-org)
  /^\/sites\/:slug\/copilot\.js/, // the public copilot widget script served on the published site
  /^\/health/,
];

/** A path param that names a specific resource an attacker can supply. */
const SUB_ID =
  /\/:(?:[a-zA-Z]+[Ii]d|id|domain|hostname|slug|table|rowId|fileId|endpointId|snapshotId|submissionId|connectionId|logId|subId|wfName)\b/;

/** A DB read inside the handler body (a tenant-row SELECT the id could scope). */
const READ =
  /\b(?:dbQuery|dbQueryOne|dbQueryAll)\s*\(|\.\s*(?:first|all)\s*\(|SELECT\s+/i;

/**
 * Classify a single GET-handler body. Pure — no I/O — so it's unit-testable.
 * @param {string} routePath - the registered route path.
 * @param {string} body - the handler's source text.
 * @returns {{ flagged: boolean }}
 */
export function scanGetHandler(routePath, body) {
  if (!SUB_ID.test(routePath)) return { flagged: false }; // (a) no attacker-suppliable id
  if (PUBLIC_PATHS.some((rx) => rx.test(routePath))) return { flagged: false }; // (c) public
  if (!READ.test(body)) return { flagged: false }; // (b) no DB read → nothing to leak
  if (OWNERSHIP.some((rx) => rx.test(body))) return { flagged: false }; // (d) org-scoped
  return { flagged: true };
}

/** @returns {boolean} a real source `.ts` (not a type-decl, not a test). */
function isScannableTs(name) {
  return name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts');
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (isScannableTs(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Top-level `.ts` files sitting DIRECTLY in `dir` — no recursion (subdirs handled by {@link walk}). */
function topLevelTs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile() && isScannableTs(ent.name)) out.push(join(dir, ent.name));
  }
  return out;
}

/** Absolute path to the Worker package root (the dir ABOVE `scripts/`). */
function appDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The full set of source files this detector scans. Recursive `src/routes` + `libs` walks PLUS
 * the NON-recursive top-level `src/*.ts` (e.g. `src/index.ts`) that registers inline
 * `app.get('/api/sites/:siteId/…')` READ handlers directly on the Hono app — those escaped the
 * dir-only scan and so dodged the GET-read IDOR gate entirely (twin of the fire-83 mutation-side
 * blind-spot that `check-idor-handlers.mjs` already closed). Dedupe so a file reachable via both
 * paths is scanned once.
 * @returns {string[]} absolute file paths.
 */
export function collectScanFiles() {
  const APP_DIR = appDir();
  const SCAN_DIRS = [join(APP_DIR, 'src', 'routes'), join(APP_DIR, 'libs')];
  const SRC_TOP_LEVEL = join(APP_DIR, 'src');
  return [...new Set([...SCAN_DIRS.flatMap(walk), ...topLevelTs(SRC_TOP_LEVEL)])];
}

function run() {
  const APP_DIR = appDir();
  const findings = [];
  {
    for (const file of collectScanFiles()) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(APP_DIR, file);
      const re = /\b[a-zA-Z][\w$]*\.(get)\(\s*['"`]([^'"`]+)['"`]/g;
      const starts = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!m[2].startsWith('/')) continue; // route paths are leading-slash
        starts.push({ idx: m.index, path: m[2] });
      }
      // Handler bodies split at the NEXT registration of ANY method (a GET body ends
      // where the next get/post/put/patch/delete begins).
      const allRe = /\b[a-zA-Z][\w$]*\.(get|post|put|patch|delete)\(\s*['"`]\//g;
      const bounds = [];
      let b;
      while ((b = allRe.exec(text)) !== null) bounds.push(b.index);
      for (const s of starts) {
        const next = bounds.find((idx) => idx > s.idx);
        const end = next ?? text.length;
        const body = text.slice(s.idx, Math.min(end, s.idx + 6000));
        if (scanGetHandler(s.path, body).flagged) {
          const line = text.slice(0, s.idx).split('\n').length;
          findings.push({ file: rel, line, path: s.path });
        }
      }
    }
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ total: findings.length, findings }, null, 2) + '\n');
  } else if (findings.length === 0) {
    console.log(
      '✅ check-get-read-idor: clean — every GET-by-id tenant read carries an org-ownership gate.',
    );
  } else {
    console.log(
      `🔒 check-get-read-idor: ${findings.length} GET handler(s) read a tenant row by an attacker-suppliable id with NO org-ownership gate (cross-org read leak):`,
    );
    for (const f of findings) console.log(`   GET ${f.path}  (${f.file}:${f.line})`);
    console.log(
      "   Fix: scope the read by the caller's org (loadInstance / siteOwned / an `AND org_id = ?` bind); 404 (non-leak) on miss.",
    );
  }
  process.exit(process.argv.includes('--ci') && findings.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
