#!/usr/bin/env node
/**
 * verify-mutations-causal.mjs — CAUSAL tests for admin MUTATIONS (write→read-back).
 *
 * READ reconciliation (`reconcile-surfaces.mjs`) proves the display matches the store,
 * but is BLIND to broken WRITES — and mutations are exactly where the bugs were:
 * iter 77 `ai_env_vars` CREATE 400'd for every var, iter 78 `flag_overrides` toggle was
 * a lying-success (both: `ON CONFLICT` not matching a PARTIAL index). This exercises the
 * owner mutation flows end-to-end and asserts the write actually persisted — a
 * lying-success (2xx that didn't persist) or a broken write is caught here, never by a
 * read-only check.
 *
 * Pure-API on the e2e-test-org seed site (E2E_API_KEY + `Origin` header — omitting Origin
 * trips Bot Fight). Every mutation is self-cleaning (restore / soft-revoke; the MCP row is
 * reused across runs via UNIQUE(site_id,provider) so it never accumulates). Skips (exit 0)
 * when E2E_API_KEY is unset so forks + secret-less CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-mutations-causal.mjs
 */
import { resolveE2ESite } from './_resolve-e2e-site.mjs';

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-mutations-causal skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
let SITE_ID = process.env.CAUSAL_SITE_ID || ''; // auto-resolved below when unset
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE };

const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
const unwrap = (d) => d?.data ?? d;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '🔴'} ${name} — ${detail}`);
};

try {
  // Resolve a REAL site id when CAUSAL_SITE_ID isn't passed. The old default
  // 'e2e-site-1' was a placeholder that 404s EVERY mutation → a false-red 🔴 that
  // masks a genuine pass (cost a diagnosis round-trip). Pick the org's first site
  // from /api/sites; skip gracefully (exit 0) if the org has none, so a secret-set
  // run without CAUSAL_SITE_ID never false-fails.
  if (!SITE_ID) {
    SITE_ID = (await resolveE2ESite(BASE, KEY, UA)).id;
    if (!SITE_ID) {
      console.log('::notice:: verify-mutations-causal skipped — no site on the e2e-test-org to probe');
      process.exit(0);
    }
    console.log(`(auto-resolved CAUSAL_SITE_ID=${SITE_ID})`);
  }
  // ── A. site UPDATE round-trip (PATCH persists + restores) ──────────────────
  {
    const orig = unwrap(await (await api(`/api/sites/${SITE_ID}`)).json())?.business_name ?? '';
    const probe = `MUT-PROBE-${Date.now()}`;
    const patchStatus = (await api(`/api/sites/${SITE_ID}`, { method: 'PATCH', body: JSON.stringify({ business_name: probe }) })).status;
    const after = unwrap(await (await api(`/api/sites/${SITE_ID}`)).json())?.business_name ?? '';
    // Restore regardless of outcome (never leave the seed mutated).
    await api(`/api/sites/${SITE_ID}`, { method: 'PATCH', body: JSON.stringify({ business_name: orig }) });
    const restored = unwrap(await (await api(`/api/sites/${SITE_ID}`)).json())?.business_name ?? '';
    record(
      'site-update PATCH persists + restores',
      patchStatus === 200 && after === probe && restored === orig,
      `patch=${patchStatus} persisted=${after === probe} restored=${restored === orig}`,
    );
  }

  // ── A2. Settings→General identity round-trip: business_address + business_phone ──
  // The General settings form (settings.component `saveGeneral`) PATCHes name+address+phone,
  // but the causal probe only guarded business_name. A future regression dropping
  // business_address/business_phone from the PATCH allow-list (`businessFields` in api.ts —
  // the `settings-field-removal-keeps-columns` class) would be a LYING-SUCCESS: the form
  // toasts "Saved" while the field never persists. Round-trip both to lock the multi-field save.
  {
    const g0 = unwrap(await (await api(`/api/sites/${SITE_ID}`)).json()) ?? {};
    const origAddr = g0.business_address ?? null;
    const origPhone = g0.business_phone ?? null;
    const pAddr = `ADDR-PROBE-${Date.now()}`;
    const pPhone = `PH-${Date.now()}`;
    const st = (await api(`/api/sites/${SITE_ID}`, { method: 'PATCH', body: JSON.stringify({ business_address: pAddr, business_phone: pPhone }) })).status;
    const g1 = unwrap(await (await api(`/api/sites/${SITE_ID}`)).json()) ?? {};
    const addrOk = g1.business_address === pAddr;
    const phoneOk = g1.business_phone === pPhone;
    // Restore both (null for an originally-empty field — the form sends null to clear).
    await api(`/api/sites/${SITE_ID}`, { method: 'PATCH', body: JSON.stringify({ business_address: origAddr, business_phone: origPhone }) });
    const g2 = unwrap(await (await api(`/api/sites/${SITE_ID}`)).json()) ?? {};
    const restoredOk = (g2.business_address ?? null) === origAddr && (g2.business_phone ?? null) === origPhone;
    record(
      'settings identity PATCH persists address + phone (not just name) + restores',
      st === 200 && addrOk && phoneOk && restoredOk,
      `patch=${st} addr=${addrOk} phone=${phoneOk} restored=${restoredOk}`,
    );
  }

  // ── B. MCP paste-connect → read-active → disconnect → read-revoked ─────────
  {
    const connStatus = (await api(`/api/mcp/resend/paste?site_id=${SITE_ID}`, { method: 'POST', body: JSON.stringify({ api_key: `mut-probe-${Date.now()}` }) })).status;
    const listActive = unwrap(await (await api('/api/mcp/connections')).json());
    const activeRow = (Array.isArray(listActive) ? listActive : []).find((x) => x.provider === 'resend' && x.site_id === SITE_ID);
    const isActive = activeRow?.status === 'active';

    let delStatus = 0;
    let isRevoked = false;
    if (activeRow?.id) {
      delStatus = (await api(`/api/sites/${SITE_ID}/mcp/connections/${activeRow.id}`, { method: 'DELETE' })).status;
      const listAfter = unwrap(await (await api('/api/mcp/connections')).json());
      const row = (Array.isArray(listAfter) ? listAfter : []).find((x) => x.provider === 'resend' && x.site_id === SITE_ID);
      isRevoked = row?.status === 'revoked';
    }
    record(
      'mcp connect (active) → disconnect (revoked)',
      connStatus === 200 && isActive && delStatus === 200 && isRevoked,
      `connect=${connStatus} active=${isActive} delete=${delStatus} revoked=${isRevoked}`,
    );
  }

  const ok = results.every((r) => r.ok);
  console.log(`\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} — ${results.filter((r) => r.ok).length}/${results.length} mutation flows persisted`);
  if (!ok) console.log('   ↳ a 2xx that did not persist = lying-success (the class that hit env-vars + flag_overrides).');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
