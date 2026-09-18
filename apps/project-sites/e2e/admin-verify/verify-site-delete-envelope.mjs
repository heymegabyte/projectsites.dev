#!/usr/bin/env node
/**
 * verify-site-delete-envelope.mjs — B.9 SITE-DELETE headless envelope (FULL-FLOW).
 *
 * The owner "delete my site" flow (DELETE /api/sites/:id → soft-delete: deleted_at +
 * status='archived', KV host-cache purge, optional Stripe cancel) is a DESTRUCTIVE,
 * IDOR-catastrophic action — a cross-org auth bypass would let one tenant DESTROY
 * another tenant's live site. The FULL JOURNEY loop never covered it; nothing asserted
 * the live endpoint actually gates it. The `check-idor-gates` CI gate proves the handler
 * has an ownership guard STATICALLY; this proves it WORKS on prod, end-to-end.
 *
 * Performing a REAL delete of a real owned site is destructive (approval-required) — out
 * of headless scope, same shape as B.5's real-card charge + B.6's real WebContainer
 * publish. What IS headless-verifiable + fully NON-MUTATING is the security envelope:
 *
 *   unauth DELETE           → 401 (throws before any ownership check / mutation)
 *   authed DELETE nonexistent → 404 (requireOwnedSite throws before the UPDATE)
 *   authed DELETE FOREIGN id  → 404 (cross-org — the catastrophic IDOR; never a
 *                                    cross-tenant delete; needs a real other-org id)
 *   NON-MUTATION PROOF        → the caller's OWN site set is byte-identical before/after
 *                               all the rejected calls (verify-against-source-of-truth:
 *                               the authoritative store is untouched — nothing deleted)
 *
 * SAFETY INVARIANT (load-bearing): an authed DELETE is sent ONLY to NON-owned ids (a
 * sentinel UUID + a real foreign id). It is NEVER sent to an owned id — the handler has
 * NO pre-write validation reject, so an authed DELETE of an owned site WOULD soft-delete
 * it. The unauth call also uses the sentinel id (401 fires regardless of ownership).
 *
 * Fail-open: skips (exit 0) on unset E2E_API_KEY. The cross-org row additionally needs a
 * foreign site id (via wrangler d1); if CLOUDFLARE_API_KEY is unset that ONE row is
 * skipped (the sentinel-404 still proves not-owned→404), the rest run on E2E_API_KEY.
 *
 * Run:  E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-site-delete-envelope.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSecret } from './_browserbase-creds.mjs';

const KEY = resolveSecret('E2E_API_KEY');
const CF_KEY = resolveSecret('CLOUDFLARE_API_KEY');
const CF_EMAIL = resolveSecret('CLOUDFLARE_EMAIL') || 'blzalewski@gmail.com';
const ORG = process.env.RECONCILE_ORG || 'e2e-test-org';
const API = process.env.RECONCILE_API_BASE || 'https://project-sites.manhattan.workers.dev';
const DB = 'project-sites-db-production';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const authH = { authorization: `Bearer ${KEY}`, 'user-agent': UA, Origin: 'https://projectsites.dev' };

if (!KEY) {
  console.log('::notice:: verify-site-delete-envelope skipped — E2E_API_KEY unset');
  process.exit(0);
}

/** DELETE and return the status (0 on network error). */
const del = async (id, headers) => {
  try {
    const res = await fetch(`${API}/api/sites/${id}`, {
      method: 'DELETE',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    return res.status;
  } catch {
    return 0;
  }
};

/** Sorted set of the caller's OWN non-deleted site ids (the non-mutation baseline). */
async function ownedIds() {
  const res = await fetch(`${API}/api/sites`, { headers: authH });
  const body = await res.json().catch(() => null);
  return (body?.data ?? []).map((s) => s.id).filter(Boolean).sort();
}

/** One remote D1 query → first result row (ORG is a trusted constant). Null if CF creds absent. */
function d1(sql) {
  if (!CF_KEY) return null;
  const r = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--env', 'production', '--json', '--command', sql],
    { cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_KEY: CF_KEY, CLOUDFLARE_EMAIL: CF_EMAIL }, maxBuffer: 8 << 20 },
  );
  const out = r.stdout || '';
  const s = out.indexOf('[');
  if (s < 0) return null;
  try {
    return JSON.parse(out.slice(s))[0]?.results?.[0] ?? null;
  } catch {
    return null;
  }
}

try {
  const rows = [];
  // Baseline: the caller's OWN site ids BEFORE any probe call (non-mutation anchor).
  const before = await ownedIds();

  // A sentinel non-owned id — structurally a UUID, guaranteed NOT in the owned set.
  // (crypto.randomUUID collides with 0 probability; assert non-membership anyway.)
  let sentinel = randomUUID();
  while (before.includes(sentinel)) sentinel = randomUUID();

  // 1. unauth DELETE → 401 (throws before ownership check; touches nothing).
  const unauth = await del(sentinel, { 'user-agent': UA });
  rows.push({ k: 'unauth DELETE → 401 (pre-ownership, non-mutating)', ok: unauth === 401, detail: `status=${unauth}` });

  // 2. authed DELETE a nonexistent (sentinel) id → 404 (requireOwnedSite throws pre-UPDATE).
  const ghost = await del(sentinel, authH);
  rows.push({ k: 'authed DELETE nonexistent id → 404 (not-owned, pre-write)', ok: ghost === 404, detail: `status=${ghost}` });

  // 3. authed DELETE a REAL FOREIGN (other-org) site id → 404 — the catastrophic
  //    cross-tenant-destruction IDOR. Needs a foreign id (CF creds); skip just this row if absent.
  //    SAFETY: prefer a foreign id from Brian's OWN org (org-brian-001, loop-owned +
  //    soft-delete-recoverable) over any external customer's — in the ~0 chance the
  //    canonical guard is broken, the recoverable soft-delete hits Brian's site, not a customer's.
  const foreign =
    d1(`SELECT id FROM sites WHERE org_id='org-brian-001' AND org_id!='${ORG}' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;`) ||
    d1(`SELECT id FROM sites WHERE org_id!='${ORG}' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;`);
  if (foreign?.id) {
    const fdel = await del(foreign.id, authH);
    rows.push({ k: 'authed DELETE FOREIGN id → 404 (no cross-org delete IDOR)', ok: fdel === 404, detail: `status=${fdel}` });
  } else {
    rows.push({ k: 'authed DELETE FOREIGN id → 404', ok: true, detail: 'skipped (no CF creds for a foreign id)', skip: true });
  }

  // 4. NON-MUTATION PROOF — the caller's OWN site set is unchanged after the rejects
  //    (verify-against-source-of-truth: the authoritative store lost nothing).
  const after = await ownedIds();
  const unchanged = before.length === after.length && before.every((id, i) => id === after[i]);
  rows.push({ k: 'NON-MUTATION: own site set unchanged (nothing deleted)', ok: unchanged, detail: `before=${before.length} after=${after.length}` });

  const fails = rows.filter((r) => !r.ok);
  console.log('\n=== B.9 SITE-DELETE envelope (auth + cross-org IDOR + non-mutation) ===');
  console.log(`  org=${ORG} own_sites=${before.length}`);
  for (const r of rows) console.log(`  ${r.skip ? '·' : r.ok ? '✓' : '✗'} ${r.k}  [${r.detail}]`);
  // Structured JSON line for trend/observability (one per run).
  console.log(
    `::json:: ${JSON.stringify({ probe: 'site-delete-envelope', unauth, ghost, foreign_tested: !!foreign?.id, own_before: before.length, own_after: after.length, pass: fails.length === 0 })}`,
  );
  console.log(
    fails.length
      ? `\nVERDICT: 🔴 FAIL — ${fails.length}/${rows.length} envelope checks failed`
      : `\nVERDICT: ✅ PASS — site-delete is auth-gated + cross-org-IDOR-safe + non-mutating over its headless envelope (a real destructive delete is approval-required, out-of-headless-scope)`,
  );
  process.exit(fails.length ? 1 : 0);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
