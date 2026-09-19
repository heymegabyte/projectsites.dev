#!/usr/bin/env node
// verify-mcp-connect-flow.mjs — FULL-JOURNEY TDD: the "MCP connect → active" acquisition journey, a
// mandated flow that had only a thin probe. A site owner connecting a per-site integration (Mailchimp /
// Stripe / GitHub / Slack / Notion / Resend / …) must ALWAYS get a coherent next step — an OAuth
// authorize URL when the provider's OAuth is configured, else the PASTE-KEY fallback (`mode:"paste_key"`
// + a real `post_to` + human instructions) — NEVER a broken popup / 500 / dead 501 (the documented
// `mcp-oauth-first` graceful-degradation invariant + `backend-captcha-gate-without-frontend-token`-class
// dead-end guard). This journey drives the acquisition path AS the E2E session, per provider, and asserts
// the contract holds for every one, plus the `site_id`-required guard and the live connections surface.
//
// Gates (fail-CLOSED — a broken connect step strands the owner mid-integration):
//   0. baseline — the E2E session resolves a site it OWNS (auth + a real per-site target)
//   1. site_id GUARD — GET /api/mcp/:provider/connect with NO site_id → 400 (never a 500/blank)
//   2. per provider — GET connect?site_id=… → 200 with a COHERENT spec:
//        · data.provider === the requested provider
//        · data.mode ∈ {oauth, paste_key}
//        · oauth → data.authorize_url is an https URL
//        · paste_key → data.post_to is `/api/mcp/<provider>/paste?state=…`, data.state present,
//          data.instructions non-empty  (a real next step, not a dead end)
//   3. the connections SURFACE — GET /api/mcp/connections → 200 (the "active" list renders)
// Fail-OPEN only when E2E_API_KEY is unset or the session owns no site (misconfig). Auto-joins run-all.
//
// Usage: E2E_API_KEY=… node e2e/admin-verify/verify-mcp-connect-flow.mjs
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY || '';
const PROVIDERS = (process.env.MCP_PROVIDERS || 'github,slack,notion,resend,mailchimp,stripe,hubspot').split(',').map((s) => s.trim()).filter(Boolean);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };

async function jget(path, opts = {}) {
  const r = await fetch(`${ORIGIN}${path}`, { headers: { 'user-agent': UA, ...(opts.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body };
}
const authed = { authorization: `Bearer ${KEY}` };

if (!KEY) {
  console.log('::notice:: verify-mcp-connect-flow SKIPPED — E2E_API_KEY unset (fail-open)');
  process.exit(0);
}

// 0. baseline — resolve a site the session owns.
const mine = await jget('/api/sites', { headers: authed });
const list = (() => { const a = mine.body?.sites || mine.body?.data || mine.body; return Array.isArray(a) ? a : a?.sites || []; })();
const siteId = list[0]?.id || '';
check('baseline: E2E session resolves a site it owns (per-site MCP target)', mine.status === 200 && !!siteId, `status=${mine.status} count=${list.length}`);
if (!siteId) {
  console.log('::notice:: verify-mcp-connect-flow SKIPPED — session owns no site (fail-open)');
  process.exit(0);
}

// 1. site_id guard — connect without site_id must 400, never 500/blank.
const noSite = await jget('/api/mcp/github/connect', { headers: authed });
check('site_id GUARD: connect with no site_id → 400 (not 500/blank)', noSite.status === 400, `status=${noSite.status}`);

// 2. per provider — the connect spec is coherent + a real next step (OAuth URL or paste-key fallback).
for (const p of PROVIDERS) {
  const r = await jget(`/api/mcp/${p}/connect?site_id=${encodeURIComponent(siteId)}`, { headers: authed });
  const d = r.body?.data || r.body || {};
  const mode = d.mode;
  // A coherent connect is a 200 in one of the two modes. The next-step contract is MODE-SPECIFIC:
  //   · oauth (provider's OAuth is configured — e.g. mailchimp/stripe/hubspot) → a valid https
  //     authorize_url whose state the callback verifies (the provider identity is encoded in the URL).
  //   · paste_key (OAuth absent — the fallback, e.g. github/slack/notion/resend) → provider + a real
  //     `/api/mcp/<provider>/paste?state=…` post_to + a one-time state + human instructions.
  let ok = r.status === 200 && (mode === 'oauth' || mode === 'paste_key');
  let why = `status=${r.status} mode=${mode}`;
  if (ok && mode === 'oauth') {
    ok = typeof d.authorize_url === 'string' && /^https:\/\//.test(d.authorize_url) && /[?&]state=/.test(d.authorize_url);
    why += ok ? ' oauth authorize_url✓ (state-bound)' : ` bad-authorize_url="${String(d.authorize_url).slice(0, 40)}"`;
  } else if (ok && mode === 'paste_key') {
    const provOk = d.provider === p;
    const postOk = typeof d.post_to === 'string' && new RegExp(`^/api/mcp/${p}/paste\\?state=`).test(d.post_to);
    const stateOk = typeof d.state === 'string' && d.state.length >= 8;
    const instrOk = typeof d.instructions === 'string' && d.instructions.trim().length > 0;
    ok = provOk && postOk && stateOk && instrOk;
    why += ` paste_key provider=${provOk ? '✓' : `"${d.provider}"`} post_to=${postOk ? '✓' : `"${d.post_to}"`} state=${stateOk ? '✓' : '✗'} instr=${instrOk ? '✓' : '✗'}`;
  }
  check(`${p}: connect → coherent next step (OAuth URL or paste-key fallback), never a broken popup`, ok, why);
}

// 3. the connections "active" surface renders.
const conns = await jget('/api/mcp/connections', { headers: authed });
check('connections SURFACE: GET /api/mcp/connections → 200 (the active-integrations list renders)', conns.status === 200, `status=${conns.status}`);

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(72)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} MCP-connect gate(s) broke on ${ORIGIN}. A site owner would be stranded mid-integration (a connect step returned no coherent next action).`
    : `\nVERDICT: ✅ PASS — MCP connect always yields a coherent next step (OAuth URL or paste-key fallback) for every provider, guards missing site_id, and the connections surface renders. No dead-end / broken popup on ${ORIGIN}.`,
);
process.exit(fails ? 1 : 0);
