#!/usr/bin/env node
// verify-idor-cross-org.mjs — SECURITY (broken access control / IDOR): the adversarial cross-org
// regression guard, the SECURITY HARDENING loop's canonical first probe. The biggest risk class for a
// multi-tenant SaaS (the `x-org-id-idor-class` + `publish-endpoint-body-slug-write-idor` memories): every
// authed `:siteId`/`:id` handler MUST scope to the caller's SESSION org — never trust a body/header/path
// id to cross the tenant boundary. This probe authenticates as the E2E test-org (E2E_API_KEY — a DIFFERENT
// org from org-brian-001, per `e2e-key-is-not-brians-account`) and adversarially attempts to read a site
// owned by ANOTHER org, asserting the boundary holds (403/404, NEVER 200-with-data).
//
// Self-validating: a PUBLIC slug-lookup proves the target site EXISTS, so a 404 on the authed cross-org
// GET is genuinely an IDOR-block (the caller's org can't see it), not a deleted site.
//
// Gates — fail-CLOSED (IDOR is a hard security invariant, never a cosmetic/stale-build concern):
//   1. baseline — the E2E session reads its OWN sites (auth works, count > 0)
//   2. isolation — the cross-org target is genuinely NOT in the E2E session's own list
//   3. READ IDOR — cross-org GET /api/sites/:id → 403/404, NEVER 200 exposing the site record
//   4. cross-org GET /api/sites/:id/logs → 403/404 (audit-log IDOR)
//   5. cross-org GET /api/sites/:id/readiness → 403/404
//   6. header injection — x-org-id: <other org> on GET /api/sites → the session's OWN count (header
//      ignored; a leak would return the injected org's different count)
// Fail-OPEN ONLY when the configured target doesn't exist (misconfig) or E2E_API_KEY is unset — re-point
// CROSS_ORG_* and re-run. Auto-joins run-all.mjs.
//
// Usage: E2E_API_KEY=… node e2e/admin-verify/verify-idor-cross-org.mjs
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY || '';
const TARGET_SLUG = process.env.CROSS_ORG_SLUG || 'rainbow-grocery-san-francisco';
const OTHER_ORG = process.env.CROSS_ORG_ID || 'org-brian-001';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };

async function j(url, opts = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, ...(opts.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body };
}
const authed = (extra = {}) => ({ authorization: `Bearer ${KEY}`, ...extra });
const listOf = (b) => {
  const a = b?.sites || b?.data || b;
  return Array.isArray(a) ? a : a?.sites || [];
};

if (!KEY) {
  console.log('::notice:: verify-idor-cross-org SKIPPED — E2E_API_KEY unset (fail-open; set it to run the adversarial cross-org probe)');
  process.exit(0);
}

// 0. Resolve the cross-org target via the PUBLIC slug-lookup — proves it EXISTS independent of any org.
const lookup = await j(`${ORIGIN}/api/sites/lookup?slug=${encodeURIComponent(TARGET_SLUG)}`);
const targetId = lookup.body?.data?.site_id || lookup.body?.site_id || '';
const targetExists = lookup.body?.data?.exists === true || !!targetId;
if (!targetExists || !targetId) {
  console.log(`::notice:: verify-idor-cross-org SKIPPED — cross-org target "${TARGET_SLUG}" not resolvable via public lookup (fail-open; re-point CROSS_ORG_SLUG). lookup.status=${lookup.status}`);
  process.exit(0);
}

// 1. baseline — the E2E session reads its OWN sites.
const mine = await j(`${ORIGIN}/api/sites`, { headers: authed() });
const myList = listOf(mine.body);
check('baseline: E2E session authenticates + reads its OWN sites (count > 0)', mine.status === 200 && myList.length > 0, `status=${mine.status} count=${myList.length}`);

// 2. isolation — the cross-org target must NOT be in the E2E session's own list.
const ownsTarget = myList.some((s) => (s.id || '') === targetId || (s.slug || '') === TARGET_SLUG);
check('isolation: the cross-org target is NOT in the E2E session\'s own list (genuinely another org\'s)', !ownsTarget, ownsTarget ? 'target IS in my list — not cross-org, re-point CROSS_ORG_SLUG' : `target ${targetId.slice(0, 8)} absent (good)`);

// 3. READ IDOR — cross-org GET /api/sites/:id must NOT return the record.
const xread = await j(`${ORIGIN}/api/sites/${targetId}`, { headers: authed() });
const leaked = xread.status === 200 && (xread.body?.id === targetId || xread.body?.data?.id === targetId || xread.body?.site?.id === targetId);
check('READ IDOR: cross-org GET /api/sites/:id → 403/404, NEVER 200-with-record', (xread.status === 403 || xread.status === 404) && !leaked, `status=${xread.status}${leaked ? ' LEAKED-RECORD' : ''}`);

// 4. cross-org logs.
const xlogs = await j(`${ORIGIN}/api/sites/${targetId}/logs`, { headers: authed() });
check('AUDIT IDOR: cross-org GET /api/sites/:id/logs → 403/404', xlogs.status === 403 || xlogs.status === 404, `status=${xlogs.status}`);

// 5. cross-org readiness.
const xready = await j(`${ORIGIN}/api/sites/${targetId}/readiness`, { headers: authed() });
check('cross-org GET /api/sites/:id/readiness → 403/404', xready.status === 403 || xready.status === 404, `status=${xready.status}`);

// 6. header injection — x-org-id: <other org> must be IGNORED (session org wins).
const injected = await j(`${ORIGIN}/api/sites`, { headers: authed({ 'x-org-id': OTHER_ORG }) });
const injList = listOf(injected.body);
check('HEADER-INJECTION IDOR: x-org-id header is ignored (count == session baseline, no leak)', injected.status === 200 && injList.length === myList.length && !injList.some((s) => (s.id || '') === targetId), `baseline=${myList.length} injected=${injList.length}`);

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(66)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} cross-org IDOR gate(s) broke on ${ORIGIN}. A tenant boundary is leaking — the caller's org can reach another org's resource. ROOT-FIX: assertSiteOwned(session.orgId) on the handler; never trust a path/body/header id.`
    : `\nVERDICT: ✅ PASS — the tenant boundary holds: cross-org read/logs/readiness all 403/404, x-org-id injection ignored, target isolated. No IDOR on ${ORIGIN}.`,
);
process.exit(fails ? 1 : 0);
