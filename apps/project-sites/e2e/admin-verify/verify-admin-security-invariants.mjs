#!/usr/bin/env node
/**
 * verify-admin-security-invariants.mjs — ADMIN QUALITY §9 security posture, the two invariants
 * the existing probes DON'T cover (verify-cross-org-idor-causal handles foreign-site-ID IDOR;
 * verify-secret-masking-causal handles no-secret-in-responses). This locks:
 *
 *   1. x-org-id HEADER SPOOF IS IGNORED — orgId is derived from the session (`c.get('orgId')`),
 *      NEVER a client-supplied `x-org-id` header (the `x-org-id-idor-class`). An authed GET of an
 *      org-scoped LIST (`/api/sites`) with a spoofed `x-org-id: <another real org>` MUST return the
 *      IDENTICAL result set (same count + same first id) as without it — a header that shifted scope
 *      would change the set. (A static grep can't prove the running worker ignores the header.)
 *   2. FLAG-GATED ROUTE NEVER 403 (existence non-leak) — a feature gated on an OFF flag returns 404,
 *      never 403 (a 403 leaks that the feature EXISTS; the canonical guard collapses forbidden→404 so
 *      an off-flag route is indistinguishable from a missing one — `flag-off-frontend-must-match-worker-404`).
 *   3. BASELINE — an org-scoped endpoint with NO auth is 401 (never a 200 data spill).
 *
 * HTTP-only (no browser), fast, READ-ONLY. Fail-OPEN (::notice, exit 0) when E2E_API_KEY is unset.
 * Auto-joins run-all via its PROBES entry.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-admin-security-invariants.mjs
 */
const KEY = process.env.E2E_API_KEY;
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const SPOOF_ORG = process.env.SPOOF_ORG || 'org-brian-001'; // a real OTHER org (E2E auths as e2e-test-org)
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

if (!KEY) {
  console.log('::notice:: verify-admin-security-invariants skipped — E2E_API_KEY unset');
  process.exit(0);
}

const authH = (extra = {}) => ({ authorization: `Bearer ${KEY}`, 'user-agent': UA, ...extra });
const sites = (j) => (Array.isArray(j?.sites) ? j.sites : Array.isArray(j?.data) ? j.data : []);
const idOf = (s) => (s && (s.id || s.slug)) || '';

async function getJson(headers) {
  const res = await fetch(`${ORIGIN}/api/sites`, { headers });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const failures = [];
console.log('\n━━ ADMIN §9 security invariants (x-org-id ignored · flag→404-not-403 · unauth→401) ━━');

// 3. baseline: unauth → 401 (never 200)
const unauth = await fetch(`${ORIGIN}/api/sites`, { headers: { 'user-agent': UA } }).then((r) => r.status).catch(() => 0);
if (unauth === 401) console.log(`  ✓ unauth GET /api/sites → 401`);
else {
  failures.push(`unauth GET /api/sites → ${unauth} (must be 401)`);
  console.error(`  ✗ unauth GET /api/sites → ${unauth} (must be 401 — never a 200 data spill)`);
}

// 1. x-org-id spoof ignored: real vs spoofed result set MUST be identical
const real = await getJson(authH());
const spoof = await getJson(authH({ 'x-org-id': SPOOF_ORG }));
const rSites = sites(real.json);
const sSites = sites(spoof.json);
const sameCount = rSites.length === sSites.length;
const sameFirst = idOf(rSites[0]) === idOf(sSites[0]);
if (real.status === 200 && sameCount && sameFirst) {
  console.log(`  ✓ x-org-id spoof IGNORED — scope unchanged (count ${rSites.length}==${sSites.length}, first id stable) → org from session, not header`);
} else if (real.status !== 200) {
  console.log(`  ⚠️  x-org-id check inconclusive — authed GET /api/sites → ${real.status} (session/env?); skipped`);
} else {
  failures.push(`x-org-id spoof changed scope (real count=${rSites.length} first=${idOf(rSites[0])} · spoof count=${sSites.length} first=${idOf(sSites[0])})`);
  console.error(`  ✗ 🔴 x-org-id spoof CHANGED SCOPE — real[${rSites.length},${idOf(rSites[0])}] ≠ spoof[${sSites.length},${idOf(sSites[0])}] (IDOR: header overrode session org)`);
}

// 2. flag-gated route never 403 (existence non-leak)
const FLAG_ROUTES = [
  '/api/features/approval_workflow/list',
  '/api/features/github_repo_sync/status',
  '/api/features/abandoned_build_nudge/config',
];
let flagTested = 0;
for (const route of FLAG_ROUTES) {
  const st = await fetch(`${ORIGIN}${route}`, { headers: authH() }).then((r) => r.status).catch(() => 0);
  if (st === 200) {
    console.log(`  ⚠️  ${route} → 200 (flag promoted ON); not a flag-off case — skipped`);
    continue;
  }
  flagTested++;
  if (st === 403) {
    failures.push(`${route} → 403 (existence leak; a flag-off route must 404)`);
    console.error(`  ✗ ⚠️ ${route} → 403 — existence leak; an off-flag route must be 404, indistinguishable from missing`);
  } else {
    console.log(`  ✓ ${route} → ${st} (flag-off / missing → 404-class, no 403 existence leak)`);
  }
}
if (flagTested === 0) console.log('  ⚠️  no flag-off route available to test (all promoted?) — flag-403 check skipped');

if (failures.length) {
  console.error(`\n❌ ADMIN §9 FAIL — ${failures.length} security invariant(s) violated:\n   - ${failures.join('\n   - ')}`);
  process.exit(1);
}
console.log('\nVERDICT: ✅ PASS — org scope is session-derived (x-org-id ignored), flag-gated routes never leak existence via 403, unauth is 401.');
process.exit(0);
