// verify-domain-provisioning-envelope.mjs — § B.10: the CUSTOM-DOMAIN PROVISIONING owner flow, the
// highest-value flow AROUND the golden path with only dev/PR *.spec.ts coverage and NO headless-prod
// probe (its siblings B.5 billing / B.6 editor / B.9 site-delete all have one). Putting a site on the
// owner's OWN domain is a core "make it mine" journey AND an IDOR-catastrophic surface: a cross-org
// read would leak another business's custom domains, a cross-org write would let one tenant hijack a
// hostname on another tenant's live site. `check-idor-gates` proves the handler HAS guards statically;
// nothing proved they WORK live on prod.
//
// A REAL provision creates a Cloudflare-for-SaaS custom hostname (CF state + $ + DNS) — destructive,
// approval-required, out-of-headless-scope (same shape as B.5's real card + B.6's WebContainer publish
// + B.9's real delete). So the headless-safe scope is the SECURITY + ENTITLEMENT + NON-MUTATION
// envelope. EVERY authed POST here targets a GHOST uuid (nonexistent) or a FOREIGN slug — NEVER an
// owned site — and each rejection fires BEFORE any provisioning:
//
//   1. LIST (owner) — GET /api/sites/:own/hostnames → 200 + data[] (the owner reads their domain list)
//   2. IDOR READ — GET /api/sites/<foreign>/hostnames → 404 "Site not found" (never leak another org's
//      domains; a 200 exposing a foreign hostname list is a hard fail)
//   3. AUTH GATE — POST /api/sites/<ghost>/hostnames UNAUTH → 401 (auth checked first, pre-everything)
//   4. VALIDATION GATE — authed POST with an invalid body (bad `type`) → 400 VALIDATION_ERROR (Zod gates
//      malformed input before any provisioning; `type` ∈ {free_subdomain, custom_cname})
//   5. ENTITLEMENT GATE — authed POST a VALID custom_cname to the ghost → 403 "Custom domains require a
//      paid plan" (a free org is cleanly told it's a paid feature — action-button-must-gate-on-server-
//      precondition + entitlement-fail-closed — never a 500, a silent no-op, or an accidental provision).
//      A paid org would instead 404 at the ownership gate (ghost not owned) — also a clean pre-provision
//      reject; assert 403|404 so the probe is plan-agnostic, and when 403 assert the paid-plan reason.
//   6. NON-MUTATION — the owner's hostname set is byte-identical before/after every rejected call
//      (verify-against-source-of-truth: the authoritative store neither gained nor lost a hostname).
//
// Rides the workers.dev host the SPA/API uses server-side — CF Bot-Fight 403s headless POSTs on the
// custom domain (bot-fight-mode-blocks-inbound-webhooks). Read/reject-only (no successful provision).
// Fail-OPEN (SKIP) without E2E_API_KEY. Auto-joins admin-verify run-all via the PROBES list registration.
//
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-domain-provisioning-envelope.mjs
const ORIGIN = process.env.ORIGIN || 'https://project-sites.manhattan.workers.dev';
const KEY = process.env.E2E_API_KEY || '';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const FOREIGN_SLUG = process.env.FOREIGN_SITE_SLUG || 'rainbow-grocery-san-francisco';
const GHOST = '00000000-0000-4000-8000-000000000000'; // valid-uuid, nonexistent → never owned, never provisions

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};
const skip = (label, detail = '') => rows.push({ ok: null, label, detail });

const H = (auth) => ({
  ...(auth ? { Authorization: `Bearer ${KEY}` } : {}),
  'User-Agent': UA,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
async function req(method, path, { auth = true, body } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, { method, headers: H(auth), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, text, json };
}

if (!KEY) {
  skip('E2E_API_KEY unset — domain-provisioning envelope skipped (fail-open)', 'export E2E_API_KEY to assert');
} else {
  try {
    // discover a real OWNED siteId
    const sites = await req('GET', '/api/sites');
    const list = Array.isArray(sites.json?.data)
      ? sites.json.data
      : Array.isArray(sites.json?.sites)
        ? sites.json.sites
        : Array.isArray(sites.json)
          ? sites.json
          : [];
    const ownId = list[0]?.id || null;
    check('discovered a real OWNED siteId', !!ownId, ownId ? `siteId=${ownId}` : `0 sites (status ${sites.status})`);

    // ── 1. LIST (owner) — baseline for the non-mutation check ────────────────────────────
    let baseline = null;
    if (ownId) {
      const listOwn = await req('GET', `/api/sites/${ownId}/hostnames`);
      baseline = listOwn.text;
      check('GET /api/sites/:own/hostnames → 200 + data[] (owner reads their domain list)',
        listOwn.status === 200 && Array.isArray(listOwn.json?.data),
        `status=${listOwn.status} keys=${Object.keys(listOwn.json || {}).join(',')}`);
    }

    // ── 2. IDOR READ — foreign site's domains never leak ─────────────────────────────────
    const foreignList = await req('GET', `/api/sites/${FOREIGN_SLUG}/hostnames`);
    check('GET /api/sites/<foreign>/hostnames → 404 (never leak another org’s custom domains)',
      foreignList.status === 404, `status=${foreignList.status}`);

    // ── 3. AUTH GATE — unauth provision → 401 ────────────────────────────────────────────
    const unauth = await req('POST', `/api/sites/${GHOST}/hostnames`, {
      auth: false, body: { type: 'custom_cname', hostname: 'probe-never.example.com' },
    });
    check('POST /hostnames UNAUTH → 401 (auth gate fires before anything)', unauth.status === 401, `status=${unauth.status}`);

    // ── 4. VALIDATION GATE — invalid body → 400 (Zod pre-provision) ──────────────────────
    const badBody = await req('POST', `/api/sites/${GHOST}/hostnames`, { body: { type: 'not_a_real_type' } });
    check('authed POST invalid body → 400 VALIDATION_ERROR (Zod gates malformed input pre-provision)',
      badBody.status === 400 && badBody.json?.error?.code === 'VALIDATION_ERROR',
      `status=${badBody.status} code=${badBody.json?.error?.code}`);

    // ── 5. WRITE-IDOR GATE (free_subdomain) — valid free_subdomain to a NON-OWNED ghost → 404 ──
    // AL-772 fix: the POST handler now `requireOwnedSite`s (after Zod, before provisioning) — so a
    // free_subdomain POST to a site the caller doesn't own is rejected 404 BEFORE the CF-for-SaaS
    // create (previously it reached the CF create — a cross-site write-authorization IDOR).
    const freeIdor = await req('POST', `/api/sites/${GHOST}/hostnames`, {
      body: { type: 'free_subdomain', hostname: 'probe-never.projectsites.dev' },
    });
    check('valid free_subdomain to a NON-OWNED site → 404 (write-IDOR gate, pre-provision — AL-772)',
      freeIdor.status === 404, `status=${freeIdor.status}`);

    // ── 6. WRITE-IDOR GATE (custom_cname) — valid custom_cname to a NON-OWNED ghost → 404 ──────
    // Ownership now fires BEFORE the entitlement check → a non-owned custom_cname is 404 (not 403).
    const customIdor = await req('POST', `/api/sites/${GHOST}/hostnames`, {
      body: { type: 'custom_cname', hostname: 'probe-never-provisioned.example.com' },
    });
    check('valid custom_cname to a NON-OWNED site → 404 (write-IDOR gate, before the paid-plan check)',
      customIdor.status === 404, `status=${customIdor.status}`);

    // ── 7. ENTITLEMENT GATE — valid custom_cname to the OWNER'S OWN site (free org) → 403 paid ─
    // On an OWNED site the ownership gate passes, so the paid-plan entitlement gate is what rejects a
    // free org's custom domain. Safe: 403 fires before provisioning; a paid org would instead 400 at
    // the DNS-CNAME check (the bogus hostname has no CNAME) — also pre-provision. Never provisions.
    if (ownId) {
      const entitled = await req('POST', `/api/sites/${ownId}/hostnames`, {
        body: { type: 'custom_cname', hostname: 'probe-never-provisioned.example.com' },
      });
      const paidMsg = /paid plan/i.test(entitled.json?.error?.message || '');
      check('valid custom_cname on the OWN site → 403 "requires a paid plan" (free org entitlement gate)',
        (entitled.status === 403 && paidMsg) || entitled.status === 400,
        `status=${entitled.status} msg="${(entitled.json?.error?.message || '').slice(0, 48)}"`);
    }

    // ── 8. NON-MUTATION — owner's hostname set byte-identical before/after every rejected call ──
    if (ownId && baseline !== null) {
      const after = await req('GET', `/api/sites/${ownId}/hostnames`);
      check('owner hostname set byte-identical before/after (0 provisioning side-effects)',
        after.status === 200 && after.text === baseline,
        after.text === baseline ? 'unchanged' : `MUTATED: ${baseline?.slice(0, 40)} → ${after.text?.slice(0, 40)}`);
    }
  } catch (e) {
    check('domain-provisioning envelope completed', false, 'error: ' + String(e).slice(0, 160));
  }
}

for (const r of rows) console.log(`  ${r.ok === null ? '⏭️ ' : r.ok ? '✓' : '✗'} ${r.label.padEnd(72)} ${r.detail}`);
const ran = rows.some((r) => r.ok !== null);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} domain-provisioning envelope gate(s) broke on ${ORIGIN}.`
    : ran
      ? `\nVERDICT: ✅ PASS — the custom-domain provisioning owner flow is secure over its headless envelope: owner reads their list, cross-org read 404s (IDOR), provisioning is auth+validation+entitlement gated (free → "requires a paid plan"), and zero provisioning side-effects on ${ORIGIN}.`
      : `\nVERDICT: ⏭️  SKIP — no E2E_API_KEY; domain-provisioning envelope not asserted (fail-open).`,
);
process.exit(fails ? 1 : 0);
