#!/usr/bin/env node
/**
 * check-idor-handlers.mjs — HANDLER-GRANULAR IDOR detector.
 *
 * The sibling `check-idor-gates.mjs` is FILE-granular: it passes a whole file if an
 * ownership idiom appears ANYWHERE in it. In a multi-handler file (api.ts is ~11k lines,
 * search.ts ~3.5k) a SINGLE unguarded handler is invisible because the file has dozens
 * of guarded ones — exactly how two real cross-tenant IDORs shipped:
 *   - fire-17: `DELETE /api/sites/:siteId/snapshots/:snapshotId` soft-deleted `WHERE id=?`
 *     with no org check → any authed user could delete any org's snapshot.
 *   - fire-18: the whole `/api/sites/:siteId/data/*` family read/wrote/deleted `site_data`
 *     scoped only by the attacker-supplied `:siteId` path param.
 *
 * This detector splits each route file into per-handler blocks and requires an ownership
 * idiom WITHIN the body of every MUTATION handler (POST/PUT/PATCH/DELETE) that (a) takes a
 * sub-resource / site id path param AND (b) performs a DB write. Per
 * validator-precision-discipline it prefers false-negatives: a handler is cleared if it
 * contains ANY idiom from the (empirically-enumerated) OWNERSHIP set below.
 *
 * Exit 0 by default (report). Pass `--ci` to exit 1 on any finding.
 * Usage: node scripts/check-idor-handlers.mjs [--ci] [--json]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [join(APP_DIR, 'src', 'routes'), join(APP_DIR, 'libs')];

/**
 * Ownership idioms — the codebase's full gate family, enumerated across the fire-17/18
 * IDOR sweep. A mutation handler is org-safe if its body matches ANY of these.
 * (Add new shared ownership helpers here as they're introduced — keep in sync.)
 */
const OWNERSHIP = [
  // shared / per-file ownership helpers (each verifies the resource belongs to the caller's
  // org). Enumerated across the fire-17/18/19 IDOR sweep — keep in sync as new helpers land.
  /\b(?:requireOwnedSite|loadSiteAndAuth|assertSiteOwned|assertSiteOwnership|assertOwner|gateOwnedSite|siteOwned|loadInstance|loadAgent|loadOwnedSite|loadOwnedSubmission|loadAuthorizedSite|ownsSiteData|ownsSite|requireSiteMembership|siteOrgId|restoreSnapshot)\b/,
  // super-admin surfaces are cross-org BY DESIGN (not per-tenant IDOR)
  /\bisSuperAdmin\b/,
  /\brequireSuperAdmin\b/,
  /\/api\/super-admin\//,
  // direct org / user scoping in a comparison or WHERE clause
  /org_id\s*!==\s*/,
  /!==\s*orgId\b/,
  /org_id\s*!=\s*/,
  /\b[a-z_]*org_id\s*=\s*\?/i,
  /\b[a-z_]*org_id\s*=\s*orgId\b/,
  /\buser_id\s*=\s*\?/i,
  /\buser_id\s*=\s*userId\b/,
  /AND\s+[a-z_.]*org_id/i,
  /WHERE\s+[a-z_.]*org_id/i,
];

/**
 * Intentionally-PUBLIC mutation endpoints (no auth/ownership BY DESIGN) — a visitor
 * submitting a contact form to any published site is the feature, not an IDOR. Keep this
 * minimal + audited (mirrors check-idor-gates' public allowlist).
 */
const PUBLIC_PATHS = [
  /^\/api\/contact-form\//,
  /^\/api\/public-data\//,
  /^\/api\/container-upload\//,
];

/** A path param that names a specific resource an attacker can supply. */
const SUB_ID =
  /\/:(?:[a-zA-Z]+[Ii]d|id|domain|hostname|slug|table|rowId|fileId|endpointId|snapshotId|submissionId|connectionId)\b/;

/** A DB write inside the handler body (aliased helpers included). */
const WRITE =
  /\b(dbUpdate|dbInsert|dbExecute|dbUpd|dbIns|dbUpdateFn|snpInsert)\s*\(|DELETE\s+FROM\s+|UPDATE\s+[a-z_]+\s+SET/i;

/**
 * A service-DELEGATED write: a mutating handler that hands the tenant-resource write to a service
 * method with a write-verb name (e.g. `domainService.provisionFreeDomain(...)`,
 * `billingService.createSubscription(...)`) OR a bare unambiguous provision/deprovision/upsert call.
 * Without this, a handler that DELEGATES its write has no in-body {@link WRITE} and slips the guard —
 * exactly how the `POST /api/sites/:siteId/hostnames` write-authorization IDOR (AL-772) evaded this
 * detector: it called `domainService.provisionFreeDomain` with NO in-body `dbInsert`. Read-verb
 * service methods (get/list/fetch/resolve/check/find/load) do NOT match, so a mutating handler that
 * only READS via a service stays cleared (false-negative-preferring, per validator-precision).
 */
const SERVICE_WRITE =
  /\b\w+(?:Service|Svc)\.\w*(?:provision|deprovision|create|update|delete|remove|upsert|insert|save|revoke|connect|disconnect|attach|detach|register|deregister|cancel|activate|deactivate|rotate|purge|archive|restore)\w*\s*\(|\b(?:provision|deprovision|upsert)[A-Z]\w*\s*\(/;

/**
 * Classify a single MUTATION-handler body. Pure — no I/O — so it's unit-testable (mirrors
 * check-get-read-idor's `scanGetHandler`). A handler is FLAGGED when it (a) has an attacker-suppliable
 * sub-resource / site id path param, (b) is not on the public allowlist, (c) performs a DB write —
 * IN-BODY or service-DELEGATED — and (d) has NO org-ownership idiom in its body.
 * @param {string} routePath - the registered route path.
 * @param {string} body - the handler's source text.
 * @returns {{ flagged: boolean }}
 */
export function scanMutationHandler(routePath, body) {
  if (!SUB_ID.test(routePath)) return { flagged: false }; // (a) no attacker-suppliable id
  if (PUBLIC_PATHS.some((rx) => rx.test(routePath))) return { flagged: false }; // (b) public by design
  if (!WRITE.test(body) && !SERVICE_WRITE.test(body)) return { flagged: false }; // (c) no write (in-body or delegated)
  if (OWNERSHIP.some((rx) => rx.test(body))) return { flagged: false }; // (d) org-scoped
  return { flagged: true };
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (
      ent.name.endsWith('.ts') &&
      !ent.name.endsWith('.d.ts') &&
      !ent.name.endsWith('.test.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

function run() {
  const findings = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(APP_DIR, file);
      // Handler boundaries: `<router>.<method>('path', ...)` for mutating methods.
      const re = /\b[a-zA-Z][\w$]*\.(post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
      const starts = [];
      let m;
      while ((m = re.exec(text)) !== null) starts.push({ idx: m.index, method: m[1], path: m[2] });
      for (let i = 0; i < starts.length; i++) {
        const s = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1].idx : text.length;
        const body = text.slice(s.idx, Math.min(end, s.idx + 4000));
        if (scanMutationHandler(s.path, body).flagged) {
          const line = text.slice(0, s.idx).split('\n').length;
          findings.push({ file: rel, line, method: s.method.toUpperCase(), path: s.path });
        }
      }
    }
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ total: findings.length, findings }, null, 2) + '\n');
  } else if (findings.length === 0) {
    console.log(
      '✅ check-idor-handlers: clean — every sub-resource mutation handler carries a per-handler ownership gate.',
    );
  } else {
    console.log(
      `⚠️  check-idor-handlers: ${findings.length} mutation handler(s) with a sub-resource id but NO in-handler ownership gate:`,
    );
    for (const f of findings) {
      console.log(`   ${f.method.padEnd(6)} ${f.path}  (${f.file}:${f.line})`);
    }
    console.log(
      '   Fix: add requireOwnedSite / loadSiteAndAuth / an `AND org_id = ?` scope inside the handler.',
    );
  }

  process.exit(process.argv.includes('--ci') && findings.length > 0 ? 1 : 0);
}

// Only run the tree scan when invoked as a CLI (not when imported for unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
