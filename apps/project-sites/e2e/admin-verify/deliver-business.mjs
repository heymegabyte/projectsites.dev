// deliver-business.mjs — GOLDEN-JOURNEY DELIVERY: build ONE real business into org-brian-001.
// Browserbase (CF-clean) → test-login as brian → real business search → create-from-search.
// Prints DELIVER_RESULT JSON (siteId, slug, status) for the poller. Creds via get-secret.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';

// PRE-FLIGHT: never spend a Browserbase session + a ~$5-15 container build when the active
// build-LLM has no credit — a dead balance silently fast-paths a degraded, fake "delivered"
// site (build-llm-402-dead-balance). Mirrors the authoritative in-workflow gate
// (src/services/build_llm_credit.ts). Exit 7 = definitively no credit → bail with the top-up
// URL. Skip with SKIP_LLM_PREFLIGHT=1 only for tests that never reach a build.
if (process.env.SKIP_LLM_PREFLIGHT !== '1') {
  const cli = new URL('../../scripts/check-build-llm-credit.mjs', import.meta.url);
  const pf = spawnSync(process.execPath, [cli.pathname], { stdio: 'inherit' });
  if (pf.status === 7) {
    console.log('::error:: build-LLM has no credit — NOT spending a build this fire. Top up, then re-run.');
    process.exit(7);
  }
}

const { BB, PROJ, PW } = resolveBrowserbaseCreds();
if (!BB || !PROJ || !PW) { console.log('::error:: missing Browserbase/E2E creds'); process.exit(2); }

// Pick a REAL, verifiable local business each fire (distinct vertical + new city preferred).
// Primary source = the Places business search; if it degrades (Places billing 403 → count 0),
// supply known-good data via BIZ_* env so the delivery still ships. Example (AL-419 delivery):
//   BIZ_QUERY="Jeni's Splendid Ice Creams Columbus OH" BIZ_NAME="Jeni's Splendid Ice Creams" \
//   BIZ_ADDRESS="714 N High St, Columbus, OH 43215" BIZ_PHONE="(614) 294-5364" \
//   BIZ_CATEGORY="ice cream shop" BIZ_WEBSITE="https://jenis.com" node e2e/admin-verify/deliver-business.mjs
const QUERY = process.env.BIZ_QUERY || process.env.BIZ_NAME || '';
const FALLBACK = {
  business_name: process.env.BIZ_NAME || '',
  business_address: process.env.BIZ_ADDRESS || null,
  business_phone: process.env.BIZ_PHONE || null,
  business_category: process.env.BIZ_CATEGORY || null,
  website: process.env.BIZ_WEBSITE || null,
};
if (!QUERY) { console.log('::error:: set BIZ_QUERY (and BIZ_* fallback fields) for the business to deliver'); process.exit(2); }

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('::error:: BB session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  const token = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }),
    });
    const j = await res.json().catch(() => ({}));
    return j?.data?.token ?? '';
  }, PW);
  if (!token) { console.log('::error:: test-login returned no token'); process.exit(4); }
  console.log('✓ authed as brian (org-brian-001)');

  // DEDUP GUARD — never rebuild a business we already have (create-from-search does NOT dedup;
  // it just appends `-N` to the slug, so 3 "Tartine Bakery" sites shipped before this was added,
  // each a wasted ~$5-15 build). Query the pre-built site search for this name/slug; if a match
  // already exists, bail (exit 6) so the loop picks a genuinely-new business.
  const wantName = (FALLBACK.business_name || QUERY).toLowerCase().trim();
  const wantSlug = wantName.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const existing = await page.evaluate(async ({ tok, q }) => {
    try {
      const r = await fetch(`/api/sites/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${tok}` } });
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j) ? j : (j.data ?? j.sites ?? j.results ?? []);
      return list.map((s) => ({ name: s.business_name || s.name || '', slug: s.slug || '', status: s.status || '' }));
    } catch { return []; }
  }, { tok: token, q: FALLBACK.business_name || QUERY });
  const dup = existing.find(
    (s) => (s.name || '').toLowerCase().trim() === wantName || (s.slug || '').startsWith(wantSlug),
  );
  if (dup) {
    console.log(`::notice:: ALREADY BUILT — "${dup.name || dup.slug}" (${dup.slug}, ${dup.status}). Pick a DIFFERENT business — not rebuilding a duplicate.`);
    process.exit(6);
  }

  // Real business search (Places proxy). Degrades gracefully → we use FALLBACK.
  const searchOut = await page.evaluate(async ({ tok, q }) => {
    try {
      const res = await fetch(`/api/search/businesses?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const j = await res.json().catch(() => ({}));
      const list = Array.isArray(j) ? j : (j.data ?? j.businesses ?? j.results ?? []);
      return { status: res.status, count: list.length, first: list[0] ?? null };
    } catch (e) { return { status: 0, count: 0, first: null, err: String(e) }; }
  }, { tok: token, q: QUERY });
  console.log(`business search: status=${searchOut.status} count=${searchOut.count}`);

  const f = searchOut.first || {};
  const body = {
    business_name: f.name || f.business_name || FALLBACK.business_name || QUERY,
    business_address: f.formatted_address || f.address || f.business_address || FALLBACK.business_address,
    google_place_id: f.place_id || f.google_place_id || undefined,
    business_phone: f.formatted_phone_number || f.phone || f.business_phone || FALLBACK.business_phone,
    business_category: f.category || f.business_category || (Array.isArray(f.types) ? f.types[0] : undefined) || FALLBACK.business_category,
    website: f.website || FALLBACK.website,
  };
  console.log('create body:', JSON.stringify(body));

  const created = await page.evaluate(async ({ tok, b }) => {
    const res = await fetch('/api/sites/create-from-search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify(b),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: j };
  }, { tok: token, b: body });

  const d = created.body?.data ?? created.body ?? {};
  const siteId = d.id || d.site_id || d.siteId;
  const slug = d.slug;
  const status = d.status;
  console.log(`create-from-search: HTTP ${created.status}`);
  if (!siteId) { console.log('::error:: no siteId in response:', JSON.stringify(created.body).slice(0, 400)); process.exit(5); }
  console.log(`DELIVER_RESULT ${JSON.stringify({ siteId, slug, status, http: created.status })}`);
} finally {
  await browser.close();
}
