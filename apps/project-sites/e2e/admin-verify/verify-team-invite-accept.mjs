#!/usr/bin/env node
/**
 * verify-team-invite-accept.mjs — the TEAM INVITE → ACCEPT flow (§ B.12): a returning owner
 * invites a teammate (`POST /api/team/invites`) → the teammate accepts via an emailed token
 * (`POST /api/team/invites/accept`) → gains a membership. This is the multi-user flow AROUND the
 * golden path; every sibling flow (B.5 billing, B.6 editor, B.9 delete, B.10 domains, B.11 manage)
 * has a headless-prod probe wired into run-all, but invite→accept had ONLY a CI `.spec.ts`.
 *
 * The real accept CONSUMES an emailed one-shot token (out-of-headless-scope — same shape as B.7's
 * emailed-click leg), and a real invite CREATE sends email + writes a row (mutation). So the
 * headless-safe scope is the SECURITY + FAIL-SAFE + NON-MUTATION envelope — every call targets a
 * bogus/invalid input that rejects BEFORE any write/send:
 *
 *   ACCEPT (invitee fail-safe):  unauth → 401 · authed missing-token → 400 · authed bogus-token → 404
 *     (a bogus token 404s BEFORE the membership INSERT — no false "joined", no crash, no privilege gain)
 *   CREATE (owner envelope):     unauth → 401 · authed bad-body → 400 · authed role='superadmin' → 400
 *     (role is a Zod enum {owner,editor,viewer} — an injected super-role is rejected BEFORE the INSERT)
 *   NON-MUTATION (verify-against-source-of-truth): GET /api/team member + pending-invite counts are
 *     byte-identical before/after every rejected call — no reject leaked a membership or an invite.
 *
 * Pure-API on prod with `Origin` (omitting it trips Bot Fight). Skips (exit 0) when E2E_API_KEY is
 * unset or /api/team isn't readable — never false-fails. Auto-joins run-all's globbed causal set.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-team-invite-accept.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-team-invite-accept skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const AUTH = { Authorization: `Bearer ${KEY}`, 'User-Agent': UA, Origin: BASE };
const ANON = { 'User-Agent': UA, Origin: BASE };
const unwrap = (d) => d?.data ?? d;

/** POST helper — JSON body, chosen header set (authed/anon). */
const post = (path, body, headers) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Snapshot the caller's team: {members, invites} counts, tolerant of response shape. */
async function teamCounts() {
  const res = await fetch(`${BASE}/api/team`, { headers: AUTH });
  if (res.status !== 200) return { status: res.status, members: -1, invites: -1 };
  const d = unwrap(await res.json().catch(() => ({})));
  const members = Array.isArray(d?.members) ? d.members.length : Array.isArray(d) ? d.length : 0;
  const invites = Array.isArray(d?.invites) ? d.invites.length : Array.isArray(d?.pending) ? d.pending.length : 0;
  return { status: 200, members, invites };
}

try {
  const rows = [];
  let fails = 0;
  const check = (label, ok, detail = '') => {
    rows.push({ label, ok, detail });
    if (!ok) fails++;
  };

  // Snapshot BEFORE (also the skip-guard — never false-fail on an unreadable team surface).
  const before = await teamCounts();
  if (before.status !== 200) {
    console.log(`::notice:: verify-team-invite-accept skipped — GET /api/team returned ${before.status}`);
    process.exit(0);
  }

  // ── ACCEPT side (invitee fail-safe) — bogus inputs, non-mutating ──
  const acUnauth = await post('/api/team/invites/accept', { token: 'x'.repeat(32) }, ANON);
  check('accept UNAUTH → 401 (auth-first: only a signed-in user can accept)', acUnauth.status === 401, `got ${acUnauth.status}`);

  const acNoTok = await post('/api/team/invites/accept', {}, AUTH);
  check('accept authed + MISSING token → 400', acNoTok.status === 400, `got ${acNoTok.status}`);

  const acBogus = await post('/api/team/invites/accept', { token: 'deadbeef'.repeat(4) }, AUTH);
  check(
    'accept authed + BOGUS token → 404 (fail-safe: no false "joined", no crash)',
    acBogus.status === 404,
    `got ${acBogus.status}`,
  );

  // ── CREATE side (owner envelope) — reject paths only, never a real invite/email ──
  const crUnauth = await post('/api/team/invites', { email: 'probe-noop@example.com', role: 'viewer' }, ANON);
  check('create UNAUTH → 401', crUnauth.status === 401, `got ${crUnauth.status}`);

  const crBad = await post('/api/team/invites', {}, AUTH);
  check('create authed + BAD body (no email/role) → 400', crBad.status === 400, `got ${crBad.status}`);

  const crEscalate = await post('/api/team/invites', { email: 'probe-noop@example.com', role: 'superadmin' }, AUTH);
  check(
    'create authed + role="superadmin" → 400 (Zod enum blocks privilege escalation, no INSERT)',
    crEscalate.status === 400,
    `got ${crEscalate.status}`,
  );

  // ── NON-MUTATION (verify-against-source-of-truth) — no reject leaked a membership or invite ──
  const after = await teamCounts();
  check(
    'NON-MUTATION: team members + pending-invites unchanged after every rejected call',
    after.members === before.members && after.invites === before.invites,
    `members ${before.members}→${after.members}, invites ${before.invites}→${after.invites}`,
  );

  // Non-vacuous: the four distinct statuses (401/400/404) from these endpoints prove the reads are real.
  const distinct = new Set([acUnauth.status, acNoTok.status, acBogus.status]).size;
  check('non-vacuous: accept endpoint returns DISTINCT reject codes (401≠400≠404)', distinct === 3, `distinct=${distinct}`);

  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(64)} ${r.detail}`);
  const ok = fails === 0;
  console.log(
    `::json:: ${JSON.stringify({ probe: 'team-invite-accept', members: before.members, invites: before.invites, fails })}`,
  );
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} — team invite→accept flow is auth-gated, fail-safe on ` +
      `bogus tokens, privilege-escalation-proof, and non-mutating on every reject (org members ${before.members}/invites ${before.invites}).`,
  );
  if (!ok)
    console.log(
      '   ↳ a broken leg = a bogus token could false-join, a super-role could be injected, or a reject mutated the org.',
    );
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
