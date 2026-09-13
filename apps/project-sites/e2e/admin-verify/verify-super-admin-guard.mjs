#!/usr/bin/env node
/**
 * verify-super-admin-guard.mjs — SECURITY (ADMIN QUALITY §9): the platform super-admin
 * privilege BOUNDARY holds. `super-admin-probe.mjs` tests the POSITIVE path (as brian, a
 * super-admin, the surface is populated); NOTHING asserted the NEGATIVE boundary — that a
 * REGULAR authed user CANNOT reach `/api/super-admin/*` (wallets, cost-factors, coupons,
 * transactions, the 100-feature ops). A dropped `requireSuperAdmin` wildcard, or an
 * `isSuperAdmin` that fail-OPENED, would silently hand platform-wide financial + feature
 * controls to every customer — a P0 privilege-escalation no other probe catches.
 *
 * The gate is `superAdmin.use('/api/super-admin/*', requireSuperAdmin)` — a WILDCARD over
 * ALL methods, so probing a representative set of GETs (non-mutating) detects a
 * wildcard-middleware regression on the whole surface; a PATCH boundary check confirms
 * mutations are gated too (403 fires BEFORE any write → non-mutating).
 *
 * E2E_API_KEY is the e2e-test-org key — a REGULAR authed org, NOT a super-admin (memory
 * e2e-key-is-not-brians-account) — so it must 403 on every super-admin route while 200-ing a
 * normal org endpoint. Direct Node fetch works (GET /api/super-admin with Bearer is not
 * CF-bot-challenged). Skips (exit 0) when E2E_API_KEY is unset.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-super-admin-guard.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.log('::notice:: verify-super-admin-guard skipped — E2E_API_KEY unset'); process.exit(0); }
const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Representative high-value super-admin GET endpoints (money + platform controls). The wildcard
// middleware gates ALL of them uniformly — a 200 on ANY = the boundary is down.
const GETS = [
  '/api/super-admin/cost-categories',
  '/api/super-admin/wallets',
  '/api/super-admin/stats',
  '/api/super-admin/transactions',
  '/api/super-admin/services',
  '/api/super-admin/coupons',
];

async function req(path, { auth = false, method = 'GET', body } = {}) {
  const headers = { 'User-Agent': UA };
  if (auth) headers.Authorization = `Bearer ${KEY}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return res.status;
}

const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

// NON-VACUOUS GUARD: the E2E_API_KEY must be a VALID authed key (200 on a normal org endpoint),
// else every 403/401 below is a false-pass from a dead key rather than the super-admin gate.
const sanity = await req('/api/sites', { auth: true });
check('E2E_API_KEY is a valid authed regular-user key (200 on /api/sites)', sanity === 200, `/api/sites → ${sanity}`);

for (const path of GETS) {
  const authed = await req(path, { auth: true });   // regular user → MUST be 403 (super-admin gate)
  const anon = await req(path, { auth: false });     // unauth → MUST be 401 (auth gate)
  check(`regular user 403 on ${path}`, authed === 403, `authed=${authed} (want 403 — a 200 = PRIVILEGE ESCALATION)`);
  check(`unauth 401 on ${path}`, anon === 401 || anon === 403, `anon=${anon}`);
}

// MUTATION boundary (non-mutating: the 403 fires before any DB write). A regular user must not
// be able to PATCH a super-admin cost-category.
const patch = await req('/api/super-admin/cost-categories/llm_tokens', { auth: true, method: 'PATCH', body: { billable: true } });
check('regular user 403 on PATCH cost-category (mutation gated before write)', patch === 403, `patch=${patch} (want 403)`);

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(58)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} super-admin boundary break(s) — a regular user can reach platform-admin controls (P0 privilege escalation).`
    : `\nVERDICT: ✅ PASS — super-admin boundary holds: regular user 403 + unauth 401 on every /api/super-admin/* probed; key is genuinely authed (non-vacuous).`,
);
process.exit(fails ? 1 : 0);
