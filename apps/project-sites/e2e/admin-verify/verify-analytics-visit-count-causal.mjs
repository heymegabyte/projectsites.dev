#!/usr/bin/env node
/**
 * verify-analytics-visit-count-causal.mjs — CAUSAL test for Flow #27
 * (verify-against-source-of-truth § causal test: perform the action → assert the
 * DISPLAY the owner sees reflects it). The existing analytics checks are STATIC
 * reconcilers (display-vs-stored count at a point in time) — they never prove the
 * live chain "a visitor arrives → the owner's pageview number goes up". A
 * lying-empty / wrong-source / stuck-rollup analytics surface passes every static
 * check yet fails THIS one.
 *
 * What it does, purely over the public + owner API (no D1/wrangler needed):
 *   1. before = GET /api/sites/:id/analytics → traffic.pageviews (what the OWNER sees)
 *   2. perform N real-UA guest visits to {slug}.projectsites.dev/  (the edge records
 *      a `pageview` via recordPageviewFromRequest for any non-bot UA on a page path)
 *   3. after  = GET /api/sites/:id/analytics → traffic.pageviews
 *   4. assert (after - before) >= N  AND  the traffic block still shows the pageview
 *      type + "/" path — the owner-facing number MOVED because a guest arrived.
 *
 * Target is the e2e-test-org seed site (acme-bakery / e2e-site-1) unlocked by
 * E2E_API_KEY, so the N benign pageviews land on a throwaway test site (same
 * no-cleanup norm as fire-conversion.mjs / fire-contact.mjs). Skips (exit 0) when
 * E2E_API_KEY is unset so forks + secret-less CI stay green.
 *
 * NOTE: if the `analytics_rollup_read` flag is ON for this site, the display reads
 * analytics_daily (a next-day rollup) instead of the live scan, so fresh visits
 * won't move the number until tomorrow — the reconciler surfaces that as a CHECK
 * (delta 0) rather than a silent pass, which is the correct signal.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-analytics-visit-count-causal.mjs [N]
 */

import { resolveE2ESite } from "./_resolve-e2e-site.mjs";
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-analytics-visit-count-causal skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
let SITE_ID = process.env.CAUSAL_SITE_ID || '';
let SLUG = process.env.CAUSAL_SITE_SLUG || '';
// Was CAUSAL_SITE_ID explicitly overridden? The owner read is scoped to the E2E_API_KEY's
// org (e2e-test-org). A REAL delivery lands in org-brian-001, so pointing this probe at a
// brian-org site 404s (cross-org) — that must read as "wrong org for this key", NOT the
// misleading "flag off / not authed" the generic message implies. (AL-432.)
const EXPLICIT_SITE = !!(process.env.CAUSAL_SITE_ID || '').trim();
const N = Math.max(1, Number(process.argv[2] || 3));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the owner-facing per-site analytics traffic block. */
async function readTraffic() {
  const res = await fetch(`${BASE}/api/sites/${SITE_ID}/analytics`, {
    headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': UA },
  });
  if (!res.ok) {
    // A 404 on an EXPLICITLY-passed site is almost always cross-org (the site isn't in the
    // E2E_API_KEY's org), not a flag/auth problem — say so, and point at the real path
    // (brian auth via Browserbase, or a D1 visitor_events ground-truth causal check, which
    // is exact/unsampled). An auto-resolved same-org site should never 404 here, so keep the
    // flag/auth hypothesis for that case.
    if (res.status === 404 && EXPLICIT_SITE) {
      throw new Error(
        `analytics 404 — site ${SITE_ID} is not in the E2E_API_KEY org (e2e-test-org). ` +
          `Causal analytics for a real (brian-org) delivery needs brian auth (Browserbase test-login) ` +
          `or a D1 visitor_events COUNT before/after — NOT this e2e-key owner read.`,
      );
    }
    throw new Error(`analytics display ${res.status} (flag off / not authed?)`);
  }
  const j = await res.json();
  const t = j?.traffic ?? {};
  return {
    pageviews: Number(t.pageviews ?? 0),
    hasPageviewType: Array.isArray(t.byType) && t.byType.some((r) => r.type === 'pageview'),
    hasRootPath: Array.isArray(t.topPaths) && t.topPaths.some((p) => p.path === '/'),
  };
}

/** Perform one real-UA guest visit; returns HTTP status. */
async function visit(i) {
  const res = await fetch(`https://${SLUG}.projectsites.dev/?ps-causal-visit=${Date.now()}-${i}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  return res.status;
}

// Resolve a REAL site id + slug when CAUSAL_SITE_ID/SLUG aren't passed (the old
// 'e2e-site-1'/'acme-bakery' placeholders 404 every request → false-red). Skip
// gracefully if the org has none. Analytics needs BOTH: id (owner read) + slug (guest visit).
if (!SITE_ID || !SLUG) {
  const _s = await resolveE2ESite(BASE, KEY, UA);
  SITE_ID = SITE_ID || _s.id;
  SLUG = SLUG || _s.slug;
  if (!SITE_ID || !SLUG) {
    console.log('::notice:: verify-analytics-visit-count-causal skipped — no site on the e2e-test-org to probe');
    process.exit(0);
  }
  console.log(`(auto-resolved CAUSAL_SITE_ID=${SITE_ID} SLUG=${SLUG})`);
}

const summary = { site: SITE_ID, slug: SLUG, n: N };
try {
  const before = await readTraffic();
  summary.before = before.pageviews;

  const statuses = [];
  for (let i = 0; i < N; i++) statuses.push(await visit(i));
  summary.visitStatuses = statuses;

  // Let the ctx.waitUntil() edge inserts settle before re-reading.
  await sleep(6000);

  const after = await readTraffic();
  summary.after = after.pageviews;
  summary.delta = after.pageviews - before.pageviews;

  const allVisited = statuses.every((s) => s === 200);
  const moved = summary.delta >= N;
  const surfaced = after.hasPageviewType && after.hasRootPath;
  const ok = allVisited && moved && surfaced;

  console.log('\n=== analytics visit→count CAUSAL ===\n' + JSON.stringify(summary, null, 2));
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} visits=${statuses.join(',')} ` +
      `before=${summary.before} after=${summary.after} delta=${summary.delta} (want ≥${N}) ` +
      `pageviewType=${after.hasPageviewType} rootPath=${after.hasRootPath}`,
  );
  if (!ok && moved === false) {
    console.log(
      '   ↳ delta < N — either the display reads a stale rollup (analytics_rollup_read ON) ' +
        'or the visit→visitor_events ingest is broken. Investigate before trusting the number.',
    );
  }
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
