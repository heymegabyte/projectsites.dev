#!/usr/bin/env node
/**
 * reconcile-surfaces.mjs — the LYING-EMPTY / WRONG-SOURCE detector.
 *
 * How the analytics "never had any traffic" bug slipped past ~30 render-integrity
 * verification fires: every prior check proved "the UI renders what its endpoint
 * returns, with 0 console errors" — but NEVER "the endpoint returns what the
 * AUTHORITATIVE STORE actually contains." A page showing an empty state passes
 * every render check yet is WRONG when real records exist in a different store.
 *
 * This harness closes that gap. For every admin surface that displays stored data,
 * it compares the DISPLAY endpoint's output (fetched AS brian, in a real browser so
 * CF Bot Management doesn't 403 the call) against the D1 GROUND-TRUTH count for
 * brian's account (measured separately via `wrangler d1 execute`). A divergence
 * where ground-truth > 0 but the endpoint returns 0/empty is a LYING-EMPTY bug.
 *
 * SILENT-CAP detector (AL-219, closing the AL-216 blind spot): the row-count vs
 * hardcoded-`gt` check is BLIND to a silent-cap — for the audit surface `gt:50` ==
 * shows 50 == "OK" while the store truly holds 14,279 rows (the `gt` is itself the
 * cap). For surfaces marked `paged: true`, we now ALSO read the endpoint's OWN claimed
 * total (`meta.total`/`total`) + page limit and flag: 🔴 IMPOSSIBLE-TOTAL (claims fewer
 * than it shows) or 🟠 SILENT-CAP-RISK (returns a full page but exposes NO total, so the
 * UI can imply "this is all"). An honest endpoint that exposes its total passes + the
 * true total is reported in the row (precision: the refinement only tightens an
 * already-passing paged surface, never false-flags a total-exposing endpoint).
 *
 * ⚠️ IDENTITY (non-obvious, cost a phantom chase AL-325): THIS probe logs in AS BRIAN
 * (`test-login`, org-brian-001) → its counts are BRIAN's org. The sibling
 * `reconcile-counts.mjs` auths with E2E_API_KEY (org `e2e-test-org`) → a DIFFERENT org
 * (109 sites, not 12). Don't cross-count the two: a brian-org number (sites 12) checked
 * against an e2e-test-org D1 sweep (sites 109) reads as a fake undercount. Both are honest.
 *
 * Ground truth (org-brian-001, snapshot 2026-09-11 — GROWS per golden delivery, so these
 * are a historical reference, NOT an exact-match assertion; the gt values below use floors /
 * `mode:'populated'` + the API's own exposed total, and the sibling `reconcile-counts.mjs` is
 * the LIVE automated `wrangler d1 execute` sweep — run it for the current true store):
 *   sites 12 (was 1 on 2026-08-06; +11 via golden deliveries) · media_assets 2 ·
 *   site_snapshots 4 · audit_logs 1129+ · voice_numbers 1 · mcp_connections 2 ·
 *   memberships 1 · ai_env_vars 3 · app_instances 3 · social_accounts 3 ·
 *   subscriptions 1 · notifications 5 (user-brian-001) ·
 *   (api_tokens/hostnames/form_submissions/webhook_endpoints/domain_purchases = 0 = honest-empty)
 *   AL-039 re-sweep: app_instances/social/subscriptions/notifications GREW data since 2026-08-06
 *   and are NOW reconciled below (were the static blind spot). The form-CRM `leads` table has
 *   6 SEED rows on site-megabytespace-001 but NO worker endpoint reads it → unwired, NOT a
 *   lying-empty (no surface claims it); tracked as a completeness item, not reconciled here.
 *
 * NOT reconciled here on purpose (verified 2026-09-05):
 *   - forms/submissions: this SITE's form_submissions is honest-empty (0), and the
 *     count is a GROWING metric on sites that DO have data (each contact submit adds a
 *     row) — a hardcoded `gt` would drift. Forms is reconciled DYNAMICALLY by
 *     `verify-forms-causal.mjs` (submit → read-back → assert uiShows) instead — the
 *     right tool for a growing count. Ground-truthed both cases: vanta 0(D1)==0(UI),
 *     northstar 18(D1)==18(API)==uiShows. So forms IS covered, just not as a static row.
 *
 * Creds (get-secret): BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, E2E_TEST_PASSWORD.
 * Exits 0 (skip) if any unset. Usage: node e2e/admin-verify/reconcile-surfaces.mjs
 */
import { chromium } from '@playwright/test';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';

const { BB, PROJ, PW } = resolveBrowserbaseCreds();
if (!BB || !PROJ || !PW) {
  console.log('::notice:: reconcile-surfaces skipped — BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID / E2E_TEST_PASSWORD unset');
  process.exit(0);
}

const SITE = 'site-megabytespace-001';

// Each surface: the DISPLAY endpoint the admin UI actually calls, the D1 ground-truth
// count for brian, and how to pull the displayed count from the JSON envelope.
// `extract` returns a number (rows displayed) from the parsed response body.
// `mode: 'populated'` — for WINDOWED / SUBSET surfaces whose exact count legitimately
// drifts (a hardcoded gt goes stale → recurring FALSE 🟠 PARTIALs that erode the
// finder's trust, per validator-precision-discipline). Verify populated (display > 0),
// NOT an exact count. The all-time total is reconciled by its own stable surface.
// Confirmed 2026-08-08 vs live D1: per-site /analytics `pageviews` is a WINDOWED metric
// (D1 visitor_events all-time=131, the endpoint shows the window); per-site logs is
// TARGET_ID-scoped (D1 audit_logs target_id=site = 22, endpoint correctly returns all 22
// — the old gt=200 was stale). Both were false PARTIALs, not product bugs.
const SURFACES = [
  { name: 'sites', endpoint: '/api/sites', gt: 1, paged: true, total: (d) => d?.meta?.total ?? d?.total, pageLimit: (d) => d?.meta?.limit ?? d?.limit, extract: (d) => arr(d, 'data', 'sites').length },
  { name: 'analytics (CORRECT /sites/:id/analytics)', endpoint: `/api/sites/${SITE}/analytics`, gt: 1, mode: 'populated', extract: (d) => num(d?.traffic ?? d, 'pageviews') },
  // NOTE (2026-09-05): there is NO dedicated "network-analytics" endpoint. The admin
  // analytics OVERVIEW (`/admin/analytics`) derives its headline `total_requests`
  // CLIENT-SIDE from the per-site `/api/sites/:id/analytics` `pageviews` (the
  // 'analytics (CORRECT …)' row above reconciles it healthy — 2256 vs D1). The old
  // `/api/network-analytics` row checked an endpoint that never existed → a permanent
  // ❌ HTTP 404 false-red (gt=1 shows=NaN) that poisoned EVERY reconcile run. Removed
  // per validator-precision-discipline (fix the validator, not the code). The org-wide
  // `/api/analytics/overview` route DOES exist but (a) has zero UI consumers and (b)
  // reads sampled Analytics-Engine admin-visit counts (`total_visits`) that can
  // legitimately read 0 — reconciling it 'populated' would just re-introduce a flaky
  // false-red, so it is intentionally NOT a reconciled display surface.
  { name: 'media', endpoint: '/api/media/assets', gt: 2, extract: (d) => arr(d, 'data', 'assets', 'items').length },
  { name: 'snapshots', endpoint: `/api/sites/${SITE}/snapshots`, gt: 4, extract: (d) => arr(d, 'data', 'snapshots').length },
  { name: 'audit (per-site logs)', endpoint: `/api/sites/${SITE}/logs?limit=200`, gt: 1, mode: 'populated', extract: (d) => arr(d, 'data', 'logs').length },
  { name: 'audit (org audit-logs)', endpoint: '/api/audit-logs?limit=50', gt: 50, paged: true, total: (d) => d?.meta?.total ?? d?.total, pageLimit: (d) => d?.meta?.limit ?? d?.limit ?? 50, extract: (d) => arr(d, 'data', 'logs').length },
  { name: 'voice numbers', endpoint: `/api/voice/numbers?siteId=${SITE}`, gt: 1, extract: (d) => arr(d, 'numbers', 'data').length },
  { name: 'mcp connections', endpoint: '/api/mcp/connections', gt: 2, extract: (d) => arr(d, 'data', 'connections').length },
  // team: brian is always ≥1 member (the owner) — a `{data:{members:[]}}` display is
  // lying-empty. env-vars: brian has 3 encrypted org vars (`{vars:[]}` envelope); mutable,
  // so verify POPULATED (>0), not an exact count (avoids stale-gt false PARTIALs).
  { name: 'team members', endpoint: '/api/team', gt: 1, extract: (d) => arr(d?.data, 'members').length },
  { name: 'env vars', endpoint: '/api/env-vars', gt: 3, mode: 'populated', extract: (d) => arr(d, 'vars').length },
  // AL-039 (2026-09-05): closed the static-reconcile blind spot. A D1 ground-truth sweep on
  // brian's org found FOUR data-bearing admin surfaces NOT previously reconciled — all
  // verified display==store at the time (apps 3, social 3, sub 1, notifications 5). They're
  // MUTABLE/GROWING counts, so verify POPULATED (>0) not an exact gt (avoids stale-gt false
  // PARTIALs per validator-precision-discipline). Guards each against a lying-empty regression.
  { name: 'apps (app_instances)', endpoint: '/api/apps/instances', gt: 3, mode: 'populated', extract: (d) => arr(d, 'instances', 'data').length },
  { name: 'social accounts', endpoint: '/api/social/accounts', gt: 3, mode: 'populated', extract: (d) => arr(d, 'data', 'accounts').length },
  { name: 'notifications', endpoint: '/api/notifications', gt: 5, mode: 'populated', extract: (d) => arr(d, 'data', 'notifications', 'items').length },
  // billing subscription is a SINGLE-object surface (not a list): populated == a subscription
  // object is present (brian's is the `sub_smoke_brian` seed — expired period is honest seed data,
  // per AL-015 — but the endpoint must still RETURN it; a `{}`/null body would be lying-empty).
  { name: 'billing subscription', endpoint: '/api/billing/subscription', gt: 1, mode: 'populated', extract: (d) => { const x = d?.data ?? d; return x && (x.status || x.plan || x.subscription || x.stripe_subscription_id || x.id) ? 1 : 0; } },
];

// --- tiny envelope helpers (kept inline; no external deps) ---
function arr(d, ...keys) {
  if (Array.isArray(d)) return d;
  for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
  return [];
}
function num(d, k) {
  const v = d?.[k];
  return typeof v === 'number' ? v : Number(v ?? NaN);
}

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  // Log in as brian INSIDE the browser (CF-clean) and keep the token for authed fetches.
  const token = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }),
    });
    const j = await res.json().catch(() => ({}));
    return j?.data?.token ?? '';
  }, PW);
  if (!token) { console.log('::error:: test-login returned no token'); process.exit(4); }

  const report = [];
  for (const s of SURFACES) {
    const res = await page.evaluate(async ({ endpoint, tok }) => {
      try {
        const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${tok}` } });
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* non-json */ }
        return { status: r.status, body, raw: text.slice(0, 120) };
      } catch (e) { return { status: 0, error: String(e).slice(0, 100) }; }
    }, { endpoint: s.endpoint, tok: token });

    let display = 'n/a';
    try { display = res.body != null ? s.extract(res.body) : 'no-json'; } catch { display = 'extract-err'; }
    const displayN = typeof display === 'number' && !Number.isNaN(display) ? display : 0;
    // Paged-surface TRUE total (silent-cap detector — AL-219, closing the AL-216 blind spot):
    // the row-count check above is BLIND to a silent-cap because its `gt` is itself capped
    // (audit gt=50 == shows 50 == "OK" while the store truly holds 14,279). A list that
    // returns a FULL PAGE but exposes NO total lets the UI imply "this is all" when there's
    // more. Pull the endpoint's OWN claimed total (`meta.total`/`total`) + page limit.
    let totalN = null, limitN = null;
    if (s.paged && res.body != null) {
      try { const t = s.total?.(res.body); totalN = typeof t === 'number' && !Number.isNaN(t) ? t : null; } catch { totalN = null; }
      try { const l = s.pageLimit?.(res.body); limitN = typeof l === 'number' && !Number.isNaN(l) ? l : null; } catch { limitN = null; }
    }
    let verdict;
    // A 404 usually means the surface-map endpoint is stale/renamed (a PROBE bug),
    // not a product data divergence — label it so a stale map never masquerades as a
    // lying-empty data bug (validator-precision-discipline). A REAL route regressing
    // to 404 still surfaces (⚠️ stays in the divergence list), just correctly attributed.
    if (res.status === 404) verdict = '⚠️ HTTP 404 (endpoint missing / surface-map stale?)';
    else if (res.status >= 400 || res.status === 0) verdict = `❌ HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
    // Windowed/subset surfaces: the only failure is lying-empty (shows 0 while data
    // exists). Any populated value is correct — the exact count drifts by design.
    else if (s.mode === 'populated') verdict = displayN > 0 ? `✅ OK (populated: ${displayN})` : '🔴 LYING-EMPTY (data exists, shows 0)';
    else if (s.gt > 0 && displayN === 0) verdict = '🔴 LYING-EMPTY (gt>0, shows 0)';
    else if (s.gt > 0 && displayN < s.gt * 0.5) verdict = `🟠 PARTIAL (gt=${s.gt}, shows ${displayN})`;
    else verdict = '✅ OK';
    // Silent-cap refinement — ONLY tightens an already-passing paged surface (precision:
    // fires on the exact silent-cap signature, never on an honest total-exposing endpoint).
    if (s.paged && !verdict.startsWith('❌') && !verdict.startsWith('⚠️') && !verdict.startsWith('🔴')) {
      if (totalN != null && totalN < displayN) verdict = `🔴 IMPOSSIBLE-TOTAL (claims ${totalN} < shows ${displayN})`;
      else if (totalN == null && limitN != null && displayN >= limitN) verdict = `🟠 SILENT-CAP-RISK (full page ${displayN}, no total exposed → UI may imply this is all)`;
      else if (totalN != null) verdict = `${verdict} · total ${totalN} exposed`;
    }
    report.push({ surface: s.name, endpoint: s.endpoint, groundTruth: s.gt, display, total: totalN, status: res.status, verdict });
  }
  console.log('\n=== ADMIN DATA RECONCILIATION (display vs D1 ground truth, as brian) ===\n');
  for (const row of report) {
    console.log(`${row.verdict.padEnd(34)} ${String(row.surface).padEnd(42)} gt=${String(row.groundTruth).padEnd(5)} shows=${row.display}${row.total != null ? ` total=${row.total}` : ''}`);
  }
  const bugs = report.filter((r) => r.verdict.startsWith('🔴') || r.verdict.startsWith('🟠') || r.verdict.startsWith('❌') || r.verdict.startsWith('⚠️'));
  console.log(`\n${bugs.length} divergence(s) found:`);
  for (const b of bugs) console.log(`  - ${b.surface}: ${b.verdict} → ${b.endpoint}`);
  console.log(JSON.stringify(report, null, 0));
} finally {
  await browser.close();
}
