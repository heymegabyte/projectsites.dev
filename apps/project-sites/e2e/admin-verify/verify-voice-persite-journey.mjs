// verify-voice-persite-journey.mjs — the COMPLETE per-site AI Voice + SMS owner journey against PROD,
// the last mandated real-user flow that had no durable real-prod spec (FULL-JOURNEY TDD gap). An owner
// opens /admin/voice for a site and the surface reads four things: the immutable concierge system prompt,
// the site's phone numbers, its agent settings, and its call/SMS history. Every render gate (contract-sweep,
// admin-surf, reconcile) proves the SECTION mounts — nothing proved the per-site voice ENDPOINTS return
// their typed contract for the OWNER while refusing a FOREIGN site (the x-org-id / body-slug IDOR class:
// a voice-numbers list that leaked across orgs would expose another business's phone lines + call logs).
//
// This is a pure authed API-contract journey (Bearer + ?siteId=), so it runs on fetch — no browser needed.
// It self-discovers a real OWNED siteId from GET /api/sites, then asserts:
//   1. GET /api/voice/meta-prompt → 200 + the immutable-rules concierge prompt (the owner-visible guardrail
//      text that OVERRIDES owner-authored instructions) is present
//   2. GET /api/voice/numbers?siteId=<own>        → 200 + { numbers: [] } typed array
//   3. GET /api/voice/agent-settings?siteId=<own> → 200 + a `settings` key (null when unconfigured = honest empty)
//   4. GET /api/voice/conversations?siteId=<own>  → 200 + { items: [] } typed array
//   5. all three per-site reads REQUIRE siteId → 400 BAD_REQUEST when omitted (guards accidental cross-org listing)
//   6. IDOR (fail-CLOSED security invariant): a FOREIGN siteId must NEVER return 200-with-data — the server
//      404s "Site not found" because the site isn't owned by the caller's org. A 200 leaking another org's
//      numbers/settings/conversations is a hard fail.
//
// DELIBERATELY NOT PROBED: the mutating/paid legs — POST /numbers/purchase (buys a Twilio number, real $),
// DELETE /numbers/:id (releases a number), POST /test/sms + POST /test/call-token (send a real SMS / mint a
// real call token). A durable probe must never spend money or place a real call; the read journey is the
// safe, complete owner-facing contract.
//
// STALE/DARK discipline: without E2E_API_KEY the probe SKIPS (fail-open, ::notice) — it never manufactures a
// red on a machine with no creds. WITH the key, the contract + IDOR legs assert fail-CLOSED (a real regression).
//
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-voice-persite-journey.mjs
//        (ORIGIN overrides the default prod host)
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY || '';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const FOREIGN_SLUG = process.env.FOREIGN_SITE_SLUG || 'rainbow-grocery-san-francisco';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};
const skip = (label, detail = '') => rows.push({ ok: null, label, detail });

async function j(path) {
  const res = await fetch(`${ORIGIN}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': UA, Accept: 'application/json' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

if (!KEY) {
  skip('E2E_API_KEY unset — voice per-site journey skipped (fail-open)', 'export E2E_API_KEY to assert the contract');
} else {
  try {
    // discover a real OWNED siteId (the caller's org) — never hardcode a slug
    const sites = await j('/api/sites');
    const list = Array.isArray(sites.body?.data)
      ? sites.body.data
      : Array.isArray(sites.body?.sites)
        ? sites.body.sites
        : Array.isArray(sites.body)
          ? sites.body
          : [];
    const ownId = list[0]?.id || null;
    check('discovered a real OWNED siteId from GET /api/sites', !!ownId, ownId ? `siteId=${ownId}` : `0 sites (status ${sites.status})`);

    // ── 1. meta-prompt: immutable concierge guardrail text ───────────────────────────────
    const meta = await j('/api/voice/meta-prompt');
    const metaText = meta.body?.data?.text || '';
    check(
      'GET /api/voice/meta-prompt → 200 + immutable-rules concierge prompt present',
      meta.status === 200 && /concierge/i.test(metaText) && /immutable/i.test(metaText),
      `status=${meta.status} len=${metaText.length}`,
    );

    if (ownId) {
      // ── 2-4. per-site reads return their typed contract for the OWNER ───────────────────
      const nums = await j(`/api/voice/numbers?siteId=${ownId}`);
      check(
        'GET /api/voice/numbers?siteId=<own> → 200 + numbers[] array',
        nums.status === 200 && Array.isArray(nums.body?.numbers),
        `status=${nums.status} keys=${Object.keys(nums.body || {}).join(',')}`,
      );

      const settings = await j(`/api/voice/agent-settings?siteId=${ownId}`);
      check(
        'GET /api/voice/agent-settings?siteId=<own> → 200 + settings key (null = honest-empty)',
        settings.status === 200 && settings.body !== null && 'settings' in (settings.body || {}),
        `status=${settings.status} keys=${Object.keys(settings.body || {}).join(',')}`,
      );

      const convos = await j(`/api/voice/conversations?siteId=${ownId}`);
      check(
        'GET /api/voice/conversations?siteId=<own> → 200 + items[] array',
        convos.status === 200 && Array.isArray(convos.body?.items),
        `status=${convos.status} keys=${Object.keys(convos.body || {}).join(',')}`,
      );
    }

    // ── 5. per-site reads REQUIRE siteId (guards accidental cross-org listing) ────────────
    const bare = await Promise.all([
      j('/api/voice/numbers'),
      j('/api/voice/agent-settings'),
      j('/api/voice/conversations'),
    ]);
    check(
      'all three per-site reads 400 BAD_REQUEST without siteId (no accidental cross-org listing)',
      bare.every((r) => r.status === 400),
      bare.map((r) => r.status).join(','),
    );

    // ── 6. IDOR fail-CLOSED: a FOREIGN siteId must never return 200-with-data ─────────────
    const foreign = await j(`/api/voice/numbers?siteId=${FOREIGN_SLUG}`);
    const leaked = foreign.status === 200 && Array.isArray(foreign.body?.numbers) && foreign.body.numbers.length > 0;
    check(
      'IDOR: foreign siteId does NOT leak voice numbers (404/403, never 200-with-data)',
      !leaked && (foreign.status === 404 || foreign.status === 403),
      `status=${foreign.status} leaked=${leaked}`,
    );
  } catch (e) {
    check('voice per-site journey completed', false, 'error: ' + String(e).slice(0, 160));
  }
}

for (const r of rows) console.log(`  ${r.ok === null ? '⏭️ ' : r.ok ? '✓' : '✗'} ${r.label.padEnd(66)} ${r.detail}`);
const ran = rows.some((r) => r.ok !== null);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} voice per-site gate(s) broke on ${ORIGIN}.`
    : ran
      ? `\nVERDICT: ✅ PASS — the per-site AI Voice owner journey (meta-prompt + numbers + agent-settings + conversations) returns its typed contract for the owner and refuses a foreign site (IDOR fail-closed) on ${ORIGIN}.`
      : `\nVERDICT: ⏭️  SKIP — no E2E_API_KEY; voice per-site journey not asserted (fail-open).`,
);
process.exit(fails ? 1 : 0);
