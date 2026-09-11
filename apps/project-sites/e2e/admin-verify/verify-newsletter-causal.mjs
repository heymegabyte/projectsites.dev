#!/usr/bin/env node
/**
 * verify-newsletter-causal.mjs — CAUSAL test for the native newsletter-subscriber
 * flow (verify-against-source-of-truth § causal test: perform the action → assert
 * the DISPLAY the owner sees moves). Guards the iter-72 fix: `POST
 * /api/newsletter/subscribe` was a 404 (route never mounted) and the /admin
 * analytics "Newsletter" tile had no live writer (structurally 0). This proves the
 * live chain "a guest subscribes → the owner's Newsletter total goes up".
 *
 * Pure-API (the subscribe endpoint 202/200s a real-UA POST WITH an Origin header —
 * omitting Origin trips Bot Fight Mode, which a real browser never does):
 *   1. before = GET /api/sites/:id/analytics → newsletter.total
 *   2. POST /api/newsletter/subscribe {siteId, email:<unique>}  (unique email so the
 *      UNIQUE(site_id,email) INSERT OR IGNORE actually inserts, not a dedup no-op)
 *   3. after  = GET /api/sites/:id/analytics → newsletter.total
 *   4. assert POST 200 {subscribed:true} · Δtotal ≥ 1 · confirmed UNCHANGED
 *      (double-opt-in: a fresh subscribe is confirmed=0 until the opt-in click)
 *
 * Targets the e2e-test-org seed site (acme-bakery / e2e-site-1) unlocked by
 * E2E_API_KEY. `newsletter.total` is an all-time COUNT, so each run adds one benign
 * subscriber row to the seed site (no cleanup — fire-*.mjs norm). Skips (exit 0)
 * when E2E_API_KEY is unset so forks + secret-less CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-newsletter-causal.mjs
 */

import { resolveE2ESite } from "./_resolve-e2e-site.mjs";
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-newsletter-causal skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
let SITE_ID = process.env.CAUSAL_SITE_ID || '';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Owner-facing newsletter tile. */
async function readNewsletter() {
  const res = await fetch(`${BASE}/api/sites/${SITE_ID}/analytics`, {
    headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`analytics display ${res.status} (flag off / not authed?)`);
  const n = (await res.json())?.newsletter ?? {};
  return { total: Number(n.total ?? 0), confirmed: Number(n.confirmed ?? 0) };
}

// Resolve a REAL site id when CAUSAL_SITE_ID isn't passed (the old 'e2e-site-1'
// placeholder 404s every request → false-red). Skip gracefully if the org has none.
if (!SITE_ID) {
  SITE_ID = (await resolveE2ESite(BASE, KEY, UA)).id;
  if (!SITE_ID) {
    console.log('::notice:: verify-newsletter-causal skipped — no site on the e2e-test-org to probe');
    process.exit(0);
  }
  console.log(`(auto-resolved CAUSAL_SITE_ID=${SITE_ID})`);
}

const summary = { site: SITE_ID };
try {
  const before = await readNewsletter();

  const email = `causal-newsletter-${Date.now()}@example.com`;
  const post = await fetch(`${BASE}/api/newsletter/subscribe`, {
    method: 'POST',
    // Origin is REQUIRED — without it Bot Fight Mode 403s (a real browser always sends it).
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE },
    body: JSON.stringify({ siteId: SITE_ID, email }),
  });
  const postBody = await post.json().catch(() => ({}));
  summary.subscribe = { status: post.status, subscribed: postBody?.data?.subscribed === true, email };

  await sleep(4000); // let the ctx.waitUntil() insert settle

  const after = await readNewsletter();
  summary.total = { before: before.total, after: after.total, delta: after.total - before.total };
  summary.confirmed = { before: before.confirmed, after: after.confirmed };

  const subscribeOk =
    post.status === 200 &&
    summary.subscribe.subscribed &&
    summary.total.delta >= 1 &&
    after.confirmed === before.confirmed; // double-opt-in: NOT auto-confirmed

  // UNSUBSCRIBE leg — exercises the compliance endpoint (the `unsubscribed` column
  // previously had NO writer) AND self-cleans this run's test subscriber, so
  // `causal-newsletter-*` rows never pile up as LIVE (unsubscribed=0) subscribers.
  const unsub = await fetch(`${BASE}/api/newsletter/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE },
    body: JSON.stringify({ siteId: SITE_ID, email }),
  });
  const unsubBody = await unsub.json().catch(() => ({}));
  summary.unsubscribe = { status: unsub.status, removed: unsubBody?.data?.removed ?? 0 };
  // Idempotent endpoint, but THIS email was just subscribed (unsubscribed=0) → must flip 1 row.
  const unsubscribeOk = unsub.status === 200 && (unsubBody?.data?.removed ?? 0) >= 1;

  const ok = subscribeOk && unsubscribeOk;

  console.log('\n=== newsletter subscribe→unsubscribe CAUSAL ===\n' + JSON.stringify(summary, null, 2));
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} ` +
      `post=${post.status} subscribed=${summary.subscribe.subscribed} ` +
      `total Δ=${summary.total.delta} (want ≥1) ` +
      `confirmed=${before.confirmed}→${after.confirmed} (want unchanged — double-opt-in) ` +
      `unsubscribe=${summary.unsubscribe.status} removed=${summary.unsubscribe.removed} (want ≥1)`,
  );
  if (!ok) {
    console.log(
      '   ↳ Δtotal 0 → subscribe route regressed (404?) / tile lost its writer; OR ' +
        'unsubscribe removed=0 → the `unsubscribed`-column writer regressed (compliance + ' +
        'self-clean path broken).',
    );
  }
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
