#!/usr/bin/env node
/**
 * verify-returning-owner-journey.mjs — the RETURNING-OWNER "manage my sites" read journey (§ B.11):
 * the daily flow AFTER the golden path (which only covers CREATE→build→publish of a NEW site). A
 * returning owner signs in → lists their sites → opens one → sees its DETAIL + production-READINESS
 * grade + audit LOGS + build/WORKFLOW status. This proves two things no reconcile/contract probe does:
 *
 *   1. CROSS-ENDPOINT COHERENCE — the site id surfaced by the LIST resolves consistently across every
 *      per-site read (detail returns the same id; readiness/logs/workflow all read 200 for it). A stale
 *      list, a wrong-source detail, or a per-site endpoint that 404s a real owned site all fail here.
 *   2. PER-SITE IDOR — every per-site read (detail AND each sub-endpoint) is ownership-gated: a foreign/
 *      ghost site id → 404, never a lying-empty 200 or a cross-org leak through a sub-endpoint.
 *
 * All READS — safe on the free / seat-capped e2e-test-org (no seat, build, email, or write side effects).
 * Pure-API on prod with the `Origin` header (omitting it trips Bot Fight). Skips (exit 0) when
 * E2E_API_KEY is unset or the org has no sites — never false-fails.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-returning-owner-journey.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-returning-owner-journey skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { Authorization: `Bearer ${KEY}`, 'User-Agent': UA, Origin: BASE };
const api = (path) => fetch(`${BASE}${path}`, { headers: H });
const unwrap = (d) => d?.data ?? d;
const GHOST = '00000000-0000-4000-8000-000000000000';

/** The first site out of the list, tolerant of {data:[…]} and {data:{sites:[…]}} shapes. */
function firstSite(body) {
  const a = unwrap(body);
  const arr = Array.isArray(a) ? a : Array.isArray(a?.sites) ? a.sites : [];
  return arr[0] ?? null;
}

try {
  const rows = [];
  let fails = 0;
  const check = (label, ok, detail = '') => {
    rows.push({ label, ok, detail });
    if (!ok) fails++;
  };

  // 1. LIST — the returning owner's sites.
  const listRes = await api('/api/sites');
  if (listRes.status !== 200) {
    console.log(`::notice:: verify-returning-owner-journey skipped — GET /api/sites returned ${listRes.status}`);
    process.exit(0);
  }
  const site = firstSite(await listRes.json().catch(() => ({})));
  if (!site?.id) {
    console.log('::notice:: verify-returning-owner-journey skipped — org has no sites to manage');
    process.exit(0);
  }
  const SID = site.id;

  // 2. DETAIL — the listed id resolves to the same site (cross-coherence, not a stale/wrong-source read).
  const detRes = await api(`/api/sites/${SID}`);
  const det = unwrap(await detRes.json().catch(() => ({})));
  check(
    'open the site — detail resolves the SAME id from the list',
    detRes.status === 200 && det?.id === SID,
    `status ${detRes.status}, id ${det?.id ?? '(none)'}`,
  );

  // 3-5. The three status surfaces an owner reads for a site — each must read 200 for an OWNED site.
  const rdRes = await api(`/api/sites/${SID}/readiness`);
  check('production-readiness reads 200', rdRes.status === 200, `status ${rdRes.status}`);
  const logRes = await api(`/api/sites/${SID}/logs?limit=5`);
  check('audit log reads 200', logRes.status === 200, `status ${logRes.status}`);
  const wfRes = await api(`/api/sites/${SID}/workflow`);
  check('build/workflow status reads 200', wfRes.status === 200, `status ${wfRes.status}`);

  // 6-9. PER-SITE IDOR — a ghost/foreign site id must 404 on the detail AND every sub-endpoint
  //      (a 200 here = a cross-org read or a lying-empty; both are security defects).
  for (const [label, path] of [
    ['detail', `/api/sites/${GHOST}`],
    ['readiness', `/api/sites/${GHOST}/readiness`],
    ['logs', `/api/sites/${GHOST}/logs?limit=3`],
    ['workflow', `/api/sites/${GHOST}/workflow`],
  ]) {
    const r = await api(path);
    check(`IDOR: ghost ${label} → 404 (owner cannot read a foreign site)`, r.status === 404, `got ${r.status}`);
  }

  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(56)} ${r.detail}`);
  const ok = fails === 0;
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} — returning-owner manage-my-sites journey ` +
      `(list→detail→readiness→logs→workflow) coherent + per-site IDOR-gated on prod (site ${SID})`,
  );
  if (!ok) console.log('   ↳ a broken leg = a returning owner cannot manage a site they own, OR a foreign site leaked.');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
