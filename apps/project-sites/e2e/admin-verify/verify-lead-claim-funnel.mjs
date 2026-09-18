#!/usr/bin/env node
/**
 * verify-lead-claim-funnel.mjs — FULL JOURNEY dims 1-2: the golden-path ENTRY
 * (LEAD SCANNER → CLAIM link) headless envelope. Non-mutating, safe on prod.
 *
 * The lead scanner (`POST /api/admin/leads/scan`, admin_leads.ts) discovers real
 * businesses (Google Places, else the OSM Nominatim/Overpass fallback — Places 403 =
 * GCP billing) and CREATES lead rows + issues claim shortlinks (`claim_links`, mig 0568).
 * The claim funnel (`/api/claim/:shortlink`, claimRoutes) resolves a token back to its
 * lead so a build session can open. The happy-path scan is SIDE-EFFECTING ($ + feeds
 * Tinybird/Hatchet outreach) and requires super-admin — OUT of headless scope, same
 * shape as B.5's real-card + B.6's WebContainer legs (covered by unit tests
 * admin_leads_route.test.ts + claim_route.test.ts). What IS headless-verifiable +
 * non-mutating is the envelope:
 *
 *   SCANNER SECURITY — the scan gate (gateLeadScanner) fires BEFORE any Places/OSM call:
 *     unauth → 401 · flag-off → 404 · non-super-admin → 403 · invalid body → 400.
 *     We POST an EMPTY body as an authed non-super-admin (E2E_API_KEY = e2e-test-org),
 *     so the request is rejected at the gate (403/404) OR at body-validation (400) —
 *     NEVER 200, NEVER a real scan. Fully non-mutating by construction.
 *   CLAIM RESOLUTION — a bogus shortlink → 404 (graceful, no crash/leak) on both
 *     `/api/claim/:x` and the read-only `/api/claim/:x/profile`. If a real claim token
 *     exists in D1 (CF creds), its `/profile` resolves 200 to a real lead (businessName
 *     + buildStatus) — proving dim-2 "the link resolves to a real lead" READ-ONLY. We
 *     never hit the bare `/:token` (it 302s + STARTS a build session — a mutation).
 *
 * Fail-open: SKIP (exit 0) on unset E2E_API_KEY. The real-token leg additionally needs
 * CF creds for a D1 lookup; without them that ONE row is skipped, the rest still run.
 *
 * Run:  E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-lead-claim-funnel.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
  console.log('::notice:: verify-lead-claim-funnel skipped — E2E_API_KEY unset');
  process.exit(0);
}

const status = async (url, opts = {}) => {
  try {
    return (await fetch(url, opts)).status;
  } catch {
    return 0;
  }
};

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

  // SCANNER SECURITY — non-mutating by construction (empty body can never run a scan).
  const unauth = await status(`${API}/api/admin/leads/scan`, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json' },
    body: '{}',
  });
  rows.push({ k: 'scan unauth → 401', ok: unauth === 401, detail: `status=${unauth}` });

  const gated = await status(`${API}/api/admin/leads/scan`, {
    method: 'POST',
    headers: { ...authH, 'content-type': 'application/json' },
    body: '{}',
  });
  rows.push({
    k: 'scan authed non-super-admin + empty body → 400/403/404 (gated pre-scan, NON-MUTATING)',
    ok: [400, 403, 404].includes(gated),
    detail: `status=${gated}`,
  });

  // CLAIM RESOLUTION — a bogus/expired bare claim LINK (the URL emailed to an owner, clicked in a
  // real browser) must 302 to the FRIENDLY create funnel `/create?claim_invalid=1`, NOT dead-end on
  // a raw-JSON 404 (embarrassingly-hard). Intentional per AL-700 + claim.ts:69 (`c.redirect('/create
  // ?claim_invalid=1', 302)`) + verify-claim-flow. Assert the TARGET, not just any 302, so a
  // regression to a wrong redirect OR a resurrected dead 404 still fails. (This probe's old
  // `→ 404` assertion was STALE — it predated the friendly-redirect change; verify-claim-flow
  // already covers the correct contract.)
  const bogus = 'zzzzzzzzzz';
  let claimBogus = 0;
  let claimLoc = '';
  try {
    const r = await fetch(`${API}/api/claim/${bogus}`, { headers: { 'user-agent': UA }, redirect: 'manual' });
    claimBogus = r.status;
    claimLoc = r.headers.get('location') || '';
  } catch {
    /* network → 0 */
  }
  rows.push({
    k: 'claim bogus token → 302 to friendly /create funnel (never a dead 404)',
    ok: claimBogus === 302 && /\/create\?claim_invalid=1/.test(claimLoc),
    detail: `status=${claimBogus} location="${claimLoc}"`,
  });

  // The SPA XHR sub-route KEEPS its JSON 404 (consumed by the Angular /create page for prefill —
  // a redirect there would break it). This asymmetry (link 302s, XHR 404s) is the correct design.
  const profBogus = await status(`${API}/api/claim/${bogus}/profile`, { headers: { 'user-agent': UA } });
  rows.push({ k: 'claim bogus /profile → 404 (JSON, SPA-consumed)', ok: profBogus === 404, detail: `status=${profBogus}` });

  // HAPPY-PATH RESOLUTION (read-only) — resolve a REAL claim token via /profile (never the
  // bare /:token, which 302s + starts a session). Skip if no token / no CF creds.
  const link = d1(`SELECT token FROM claim_links ORDER BY rowid DESC LIMIT 1;`);
  if (link?.token) {
    let realOk = false, detail = '';
    try {
      const res = await fetch(`${API}/api/claim/${link.token}/profile`, { headers: { 'user-agent': UA } });
      const body = await res.json().catch(() => null);
      realOk = res.status === 200 && !!body?.data && (typeof body.data.buildStatus === 'string' || !!body.data.businessName || !!body.data.prefill || !!body.data.sessionId);
      detail = `status=${res.status} hasData=${!!body?.data}`;
    } catch (e) {
      detail = `err=${e instanceof Error ? e.message.slice(0, 40) : e}`;
    }
    rows.push({ k: 'claim REAL token /profile → 200 + resolves to a lead (read-only)', ok: realOk, detail });
  } else {
    rows.push({ k: 'claim REAL token /profile → 200', ok: true, detail: 'skipped (no claim_links row / no CF creds)', skip: true });
  }

  const hard = rows.filter((r) => !r.skip);
  const fails = hard.filter((r) => !r.ok);
  console.log('\n=== FULL JOURNEY dims 1-2: LEAD SCANNER → CLAIM funnel (envelope, non-mutating) ===');
  for (const r of rows) console.log(`  ${r.skip ? '·' : r.ok ? '✓' : '✗'} ${r.k}  [${r.detail}]`);
  console.log(
    fails.length
      ? `\nVERDICT: 🔴 FAIL — ${fails.length}/${hard.length} envelope checks failed`
      : `\nVERDICT: ✅ PASS — lead-scanner gated (auth/flag/super-admin, non-mutating) + claim funnel resolves/rejects truthfully (real scan = super-admin + $ + outreach, out-of-headless-scope, unit-tested)`,
  );
  process.exit(fails.length ? 1 : 0);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
