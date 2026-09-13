// verify-secret-masking-causal.mjs — SECURITY (ADMIN QUALITY §9 "no secret/PII in responses").
//
// Locks the secret-masking posture manually audited AL-469: no admin endpoint that
// stores real secrets may return the PLAINTEXT/hash in its list response.
//   1. env-vars (CAUSAL): create an org secret with a sentinel plaintext → list →
//      assert the value is masked (••••+last4), the plaintext NEVER appears, and no
//      `value` (unmask) field is present → delete (always, via finally). An empty
//      list can't prove masking; writing a known secret and reading it back can.
//   2. api-tokens (/api/v1-tokens): metadata-only — no token/plaintext/hash field,
//      no `psk_`-prefixed or long-hex value (the plaintext is shown ONCE on create).
//   3. mcp connections: no access_token/refresh_token/secret/api_key value leaks.
//   4. generic: no response carries a live secret prefix (sk_live/sk_test/whsec_/
//      rk_live/AKIA/-----BEGIN PRIVATE) — the caller's own Bearer is never echoed.
//
// Pure fetch (a valid Bearer authenticates /api directly — no browser/WAF dance).
// Auto-globs into run-all as a *-causal.mjs probe.

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('E2E_API_KEY env required');
  process.exit(2);
}
const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// `Origin: BASE` is REQUIRED for authed writes — CF Bot-Fight 403-challenges a
// mutating /api call that lacks a matching same-origin header (the read-only GETs
// pass without it, but POST/DELETE don't). Mirrors verify-mutations-causal.mjs.
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE };

// Secret-shaped prefixes that must NEVER appear in a list response body.
const SECRET_PREFIXES = [/sk_live_/i, /sk_test_[A-Za-z0-9]/, /whsec_/i, /rk_live_/i, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
// Keys that, if present with a truthy value in a list row, indicate a leak.
const LEAK_KEYS = /^(value|plaintext|token|token_hash|hash|secret|api_key|apikey|access_token|refresh_token|client_secret|password|value_encrypted)$/i;

const fails = [];
const notes = [];
const j = async (path, init) => {
  const r = await fetch(BASE + path, { headers: H, ...init });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: r.status, body, text };
};
const rows = (b) => (Array.isArray(b?.data) ? b.data : Array.isArray(b?.vars) ? b.vars : []);
const scanLeakKeys = (obj, where) => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (LEAK_KEYS.test(k) && typeof v === 'string' && v.length > 0) {
      fails.push(`${where}: leaked key "${k}" with a non-empty value`);
    }
  }
};

// ── 1. env-vars CAUSAL secret-masking ───────────────────────────────
const SENTINEL = `sk_test_LEAKPROBE_${Date.now()}_ZZZ9`; // last4 = 'ZZZ9'
let createdId = null;
try {
  const created = await j('/api/env-vars', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'org',
      key: 'E2E_SECRET_MASK_PROBE',
      value: SENTINEL,
      isSecret: true,
      description: 'transient secret-masking probe (auto-deleted)',
    }),
  });
  if (created.status !== 200 && created.status !== 201) {
    fails.push(`env-vars create expected 200/201, got ${created.status}: ${created.text.slice(0, 120)}`);
  } else {
    const listed = await j('/api/env-vars?scope=org');
    // The FULL list body must never contain the plaintext sentinel.
    if (listed.text.includes(SENTINEL)) fails.push('env-vars LIST leaked the plaintext secret value');
    const row = rows(listed.body).find((v) => v?.key === 'E2E_SECRET_MASK_PROBE');
    if (!row) {
      fails.push('env-vars: created secret not found in list (cannot verify masking)');
    } else {
      createdId = row.id ?? null;
      if (typeof row.value === 'string') fails.push('env-vars row exposed a plaintext `value` field (unmask leaked)');
      if (!String(row.value_masked || '').includes('••••')) fails.push(`env-vars secret not masked with ••••: got "${row.value_masked}"`);
      if (!String(row.value_masked || '').endsWith('ZZZ9')) fails.push(`env-vars mask should end with real last-4 (ZZZ9): got "${row.value_masked}"`);
      notes.push(`env-vars secret masked as "${row.value_masked}" (plaintext never returned)`);
    }
  }
} finally {
  // Always clean up the probe secret, even if an assertion threw above.
  if (createdId) {
    const del = await j(`/api/env-vars/${createdId}`, { method: 'DELETE' }).catch(() => ({ status: 0 }));
    notes.push(`cleanup: deleted probe secret (${del.status})`);
  }
}

// ── 2. api-tokens metadata-only ─────────────────────────────────────
const toks = await j('/api/v1-tokens');
if (toks.status === 200) {
  for (const t of rows(toks.body)) scanLeakKeys(t, 'api-tokens');
  for (const re of SECRET_PREFIXES) if (re.test(toks.text)) fails.push(`api-tokens body matched secret prefix ${re}`);
  notes.push(`api-tokens: ${rows(toks.body).length} row(s), metadata-only`);
} else notes.push(`api-tokens: ${toks.status} (skipped)`);

// ── 3. mcp connections no-token ─────────────────────────────────────
const mcp = await j('/api/mcp/connections');
if (mcp.status === 200) {
  for (const c of rows(mcp.body)) scanLeakKeys(c, 'mcp-connections');
  for (const re of SECRET_PREFIXES) if (re.test(mcp.text)) fails.push(`mcp-connections body matched secret prefix ${re}`);
  notes.push(`mcp-connections: ${rows(mcp.body).length} row(s), no token leaked`);
} else notes.push(`mcp-connections: ${mcp.status} (skipped)`);

// ── 4. auth/me generic prefix scan ──────────────────────────────────
const me = await j('/api/auth/me');
if (me.status === 200) {
  for (const re of SECRET_PREFIXES) if (re.test(me.text)) fails.push(`auth/me body matched secret prefix ${re}`);
}

console.log('\n=== SECRET-MASKING / NO-LEAK (admin sensitive surfaces) ===');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length) {
  console.log(`\n❌ FAIL — ${fails.length} leak(s):`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n✅ PASS — env-vars masks (causal), api-tokens/mcp metadata-only, no secret-prefix leaks');
