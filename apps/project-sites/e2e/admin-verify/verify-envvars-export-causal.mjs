#!/usr/bin/env node
/**
 * verify-envvars-export-causal.mjs — CAUSAL journey for the AI env-var `.env` EXPORT
 * (create a var → download the dotenv → assert the var ROUND-TRIPS into the export body →
 * delete → confirm gone from a re-export) on the real e2e-test-org.
 *
 * WHY (closes the AL-710 gap): the `.env` export is a RAW `fetch()` in
 * `env-vars-manager.component.ts` that bypasses ApiService — it read a DEAD
 * `localStorage.getItem('session_token')` key (never written since the token moved to
 * `ps_session`), so it sent `Bearer null` → the Bearer-only worker 401'd EVERY export
 * (a shipped-broken "doomed control"). AL-710 fixed it to `auth.getToken()`, unit-tested the
 * knowledge-upload sibling, and did a one-off prod auth-accept check — but the EXPORT itself
 * had NO end-to-end journey. This is it: it proves the owner actually GETS their vars
 * (display == store on the dotenv TEXT, not just a list count), that the endpoint is
 * Bearer-gated (bogus token → 401, the exact failure the dead key caused), and that a
 * deleted var disappears from the export. `verify-envvars-causal` covers CRUD; this covers
 * the distinct EXPORT/download path AL-710 fixed.
 *
 * Pure-API with E2E_API_KEY + `Origin` (omitting Origin trips Bot Fight). Org-scoped, so no
 * site needed. Self-cleaning. Skips (exit 0) when E2E_API_KEY is unset so forks + secret-less
 * CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-envvars-export-causal.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-envvars-export-causal skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE };
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
const listVars = (d) => (Array.isArray(d) ? d : (d?.vars ?? d?.data ?? []));
const EXPORT_PATH = '/api/env-vars/export?scope=org&include_values=1';

const results = [];
const record = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? '✅' : '🔴'} ${name} — ${detail}`);
};

const probeKey = `CAUSAL_EXPORT_${Date.now()}`;
const probeVal = `exportval-${Date.now()}`;
let createdId = '';

try {
  // 1) CREATE — org-scoped env var with a known value we can grep for in the dotenv.
  const createRes = await api('/api/env-vars', {
    method: 'POST',
    body: JSON.stringify({ scope: 'org', key: probeKey, value: probeVal }),
  });
  const createBody = await createRes.json().catch(() => ({}));
  createdId = createBody?.var?.id ?? createBody?.data?.id ?? createBody?.id ?? '';
  if (!createdId) {
    const found = listVars(await (await api('/api/env-vars')).json()).find((v) => v?.key === probeKey);
    createdId = found?.id ?? '';
  }
  record('create env-var', createRes.status >= 200 && createRes.status < 300, `POST → ${createRes.status}`);

  // 2) EXPORT (the AL-710-fixed path) — 200 + text/plain + the created var ROUND-TRIPS into
  //    the dotenv body (display == store on the actual downloaded TEXT, the causal core).
  const expRes = await api(EXPORT_PATH);
  const ct = expRes.headers.get('content-type') || '';
  const body = await expRes.text();
  const isText = /text\/plain/i.test(ct);
  const roundTrips = body.includes(`${probeKey}=`) && body.includes(probeVal);
  record(
    'export returns the owner dotenv (200 + text/plain)',
    expRes.status === 200 && isText,
    `GET → ${expRes.status} ct="${ct.split(';')[0]}"`,
  );
  record(
    'created var round-trips into the export body (display == store)',
    roundTrips,
    roundTrips ? `"${probeKey}=${probeVal}" present in dotenv` : `"${probeKey}" MISSING from export → lying/empty export`,
  );

  // 3) AUTH GATE (the exact AL-710 failure mode) — a bogus Bearer must be REJECTED. The old
  //    dead-key `Bearer null` produced this 401 for real owners; the fix sends a valid Bearer.
  const bogus = await fetch(`${BASE}${EXPORT_PATH}`, {
    headers: { Authorization: 'Bearer deadbeef-not-a-token', 'User-Agent': UA, Origin: BASE },
  });
  record(
    'export is Bearer-gated (bogus token → 401/403, never a plaintext leak)',
    bogus.status === 401 || bogus.status === 403,
    `bogus GET → ${bogus.status}`,
  );

  // 4) DELETE → CONFIRM-GONE from a re-export (the value must not linger in the dotenv).
  if (createdId) {
    const delStatus = (await api(`/api/env-vars/${createdId}`, { method: 'DELETE' })).status;
    record('delete env-var', delStatus >= 200 && delStatus < 300, `DELETE → ${delStatus}`);
    const body2 = await (await api(EXPORT_PATH)).text();
    const gone = !body2.includes(`${probeKey}=`) && !body2.includes(probeVal);
    record('deleted var gone from re-export', gone, gone ? 'value absent after delete' : 'value STILL in export → dropped delete');
  } else {
    record('delete env-var', false, 'no id to delete (create/read-back failed)');
    record('deleted var gone from re-export', false, 'skipped — nothing created');
  }

  // Safety sweep: remove any stale CAUSAL_EXPORT_ rows from an interrupted run.
  for (const v of listVars(await (await api('/api/env-vars')).json())) {
    if (v?.key?.startsWith('CAUSAL_EXPORT_') && v.id) await api(`/api/env-vars/${v.id}`, { method: 'DELETE' }).catch(() => {});
  }

  const ok = results.length === 6 && results.every(Boolean);
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS — env-var export authenticates (AL-710), returns the owner dotenv, round-trips the var, gates bogus tokens, and drops deleted vars' : '🔴 FAIL — the export lied, leaked, or a mutation dropped'}`,
  );
  process.exit(ok ? 0 : 1);
} catch (e) {
  if (createdId) await api(`/api/env-vars/${createdId}`, { method: 'DELETE' }).catch(() => {});
  console.log(`🔴 verify-envvars-export-causal threw: ${String(e).slice(0, 140)}`);
  process.exit(1);
}
