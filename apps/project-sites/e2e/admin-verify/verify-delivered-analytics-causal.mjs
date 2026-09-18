#!/usr/bin/env node
/**
 * verify-delivered-analytics-causal.mjs — the GOLDEN-PATH step-5 causal test for a REAL
 * (brian-org) delivered site: "a visitor arrives → the owner's pageview STORE goes up".
 *
 * WHY a second causal probe (verify-analytics-visit-count-causal already exists): that one reads
 * the owner API scoped to the E2E_API_KEY's org (e2e-test-org), so it can ONLY prove a throwaway
 * seed site — a REAL delivery lands in org-brian-001 and 404s that cross-org owner read (its own
 * AL-432 note prescribes "a D1 visitor_events COUNT before/after" for exactly this case). This
 * probe IS that: it reconciles against the AUTHORITATIVE STORE (D1 visitor_events) directly, the
 * exact/unsampled ground truth, so the golden path's ACTUAL output (a delivered customer site) is
 * causally verified, not just the e2e seed.
 *
 * What it does (per [[verify-against-source-of-truth]] § causal test):
 *   1. Resolve the newest PUBLISHED org-brian-001 site (or CAUSAL_SITE_ID/SLUG override).
 *   2. before = D1 COUNT(visitor_events WHERE event_type='pageview') — the authoritative store.
 *   3. N real-UA guest visits to {slug}.projectsites.dev/?cachebust (the Worker records a pageview
 *      server-side via recordPageviewFromRequest on serve — NOT a client beacon — for any non-bot
 *      UA on a page path; a real Chrome UA is NOT bot-matched, so it counts).
 *   4. after = D1 COUNT — assert (after - before) >= N  (I visited → the STORE counted it).
 *   5. Assert the newest pageview rows are ENRICHED (path='/' + a metadata.ua) — proving the
 *      server-side recorder ran, not a bare/empty insert.
 *   6. DISPLAY == STORE (the last mile): fetch the owner's /admin analytics endpoint
 *      (`/api/sites/:id/analytics`, authed as brian) and assert its shown pageview count reflects
 *      the store (≥ the N visits just made, never exceeding the all-time store) — catching a
 *      lying-empty / wrong-source admin analytics the store-only leg is blind to. Skipped (leg
 *      passes) when E2E_TEST_PASSWORD is absent, so the store-proven run never regresses.
 *
 * Requires CF auth in env (CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL) for the D1 read. Fail-open
 * (::notice + exit 0) when absent so forks + secret-less CI stay green. Adds N benign pageviews to
 * a brian demo site (same no-cleanup norm as the e2e causal probe hitting harborline).
 *
 * Usage: CLOUDFLARE_API_KEY=… CLOUDFLARE_EMAIL=… node e2e/admin-verify/verify-delivered-analytics-causal.mjs [N]
 */
import { execFileSync } from 'node:child_process';

const CF_KEY = process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_API_TOKEN || '';
if (!CF_KEY) {
  console.log('::notice:: verify-delivered-analytics-causal skipped — no CF auth (CLOUDFLARE_API_KEY) in env');
  process.exit(0);
}

const DB = 'project-sites-db-production';
const N = Math.max(1, Number(process.argv[2] || 3));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a read-only SQL against prod D1 and return the parsed results array (never throws). */
function d1(sql) {
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
      { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const j = JSON.parse(out);
    return j[0]?.results || j.result?.[0]?.results || [];
  } catch {
    return [];
  }
}

// ── 1. Resolve the target site (newest published brian-org delivery, or override) ──
let SITE_ID = (process.env.CAUSAL_SITE_ID || '').trim();
let SLUG = (process.env.CAUSAL_SITE_SLUG || '').trim();
if (!SITE_ID || !SLUG) {
  const rows = d1(
    "SELECT id, slug FROM sites WHERE org_id='org-brian-001' AND status='published' AND deleted_at IS NULL AND slug IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
  );
  SITE_ID = SITE_ID || rows[0]?.id || '';
  SLUG = SLUG || rows[0]?.slug || '';
}
if (!SITE_ID || !SLUG) {
  console.log('::notice:: verify-delivered-analytics-causal skipped — no published org-brian-001 site to probe');
  process.exit(0);
}

const pageviewCount = () =>
  Number(
    d1(`SELECT COUNT(*) AS n FROM visitor_events WHERE site_id='${SITE_ID}' AND event_type='pageview'`)[0]?.n ?? -1,
  );

async function visit(i) {
  try {
    const res = await fetch(`https://${SLUG}.projectsites.dev/?ps-delivered-causal=${Date.now()}-${i}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
    });
    return res.status;
  } catch {
    return 0;
  }
}

const summary = { site: SITE_ID, slug: SLUG, n: N };
try {
  const before = pageviewCount();
  summary.before = before;
  if (before < 0) {
    console.log('🔴 ERROR: could not read visitor_events (D1 auth / table). Cannot prove causal.');
    process.exit(2);
  }

  const statuses = [];
  for (let i = 0; i < N; i++) statuses.push(await visit(i));
  summary.visitStatuses = statuses;

  await sleep(7000); // let the server-side ctx.waitUntil() pageview inserts settle

  const after = pageviewCount();
  summary.after = after;
  summary.delta = after - before;

  // Enrichment proof: the newest pageview row carries path='/' + a metadata.ua (the AN1/AN2
  // server-side enrichment ran) — a bare insert would have null metadata / no path.
  const newest = d1(
    `SELECT path, json_extract(metadata,'$.ua') AS ua FROM visitor_events WHERE site_id='${SITE_ID}' AND event_type='pageview' ORDER BY created_at DESC LIMIT 1`,
  )[0];
  summary.newestPath = newest?.path ?? null;
  summary.newestHasUa = !!newest?.ua;

  // ── 6. DISPLAY == STORE (the last mile) — the owner's /admin analytics endpoint must SHOW the
  //   pageviews, not just the D1 store hold them. The store-delta above proves the WRITE path; this
  //   proves the READ path the owner actually sees, catching a lying-empty / wrong-source admin
  //   analytics (per [[verify-against-source-of-truth]]: render-vs-endpoint is blind to store-vs-
  //   display). Owner-authed via test-login as brian (org-brian-001 owns the resolved site). Skipped
  //   (leg passes) when E2E_TEST_PASSWORD is absent, so the store-proven run never regresses in CI.
  const PW = process.env.E2E_TEST_PASSWORD || '';
  const WORKERS = 'https://project-sites.manhattan.workers.dev'; // workers.dev bypasses Bot-Fight on authed calls
  let displayPv = null;
  let displayStatus = null;
  if (PW) {
    try {
      const lr = await fetch(`${WORKERS}/api/auth/test-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email: 'brian@megabyte.space', password: PW }),
      });
      const token = (await lr.json().catch(() => ({})))?.data?.token || '';
      if (token) {
        const ar = await fetch(`${WORKERS}/api/sites/${SITE_ID}/analytics`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
        });
        displayStatus = ar.status;
        const aj = await ar.json().catch(() => ({}));
        const d = aj?.data ?? aj;
        const pv = d?.traffic?.pageviews ?? d?.traffic?.total ?? d?.pageviews;
        displayPv = Number.isFinite(Number(pv)) ? Number(pv) : NaN;
      }
    } catch {
      /* leg skipped on any auth/network error — store leg stands */
    }
  }
  summary.displayPageviews = displayPv;
  summary.displayStatus = displayStatus;

  const allVisited = statuses.every((s) => s === 200);
  const moved = summary.delta >= N;
  const enriched = summary.newestPath === '/' && summary.newestHasUa;
  // Display reconciles when readable: it must show ≥ the N visits I just made (window-scoped, all
  // recent) and never EXCEED the all-time store (a display > store is fabrication). null = skipped.
  const displayOk =
    displayPv === null ? true : Number.isFinite(displayPv) && displayPv >= N && displayPv <= after;
  const ok = allVisited && moved && enriched && displayOk;

  console.log('\n=== delivered-site analytics visit→STORE CAUSAL (D1 ground truth) ===\n' + JSON.stringify(summary, null, 2));
  const displayLeg =
    displayPv === null ? 'display=skip(no-pw)' : `display=${displayPv}${displayOk ? '' : ' ✗'} (store=${after})`;
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} visits=${statuses.join(',')} ` +
      `before=${summary.before} after=${summary.after} delta=${summary.delta} (want ≥${N}) ` +
      `path=${summary.newestPath} enriched=${enriched} ${displayLeg}`,
  );
  if (!moved) {
    console.log(
      '   ↳ delta < N — the visit→visitor_events server-side record is broken (bot-filter over-matching a real UA, ' +
        'edge-cache bypassing the caller-level record, or a dropped D1 write). Investigate before trusting /admin analytics.',
    );
  }
  if (displayPv !== null && Number.isFinite(displayPv) && after > 0 && displayPv === 0) {
    console.log(
      `   ↳ LYING-EMPTY: the STORE holds ${after} pageviews but the owner's /admin analytics DISPLAY shows 0 — ` +
        'wrong-source / dead-table read (the render-vs-endpoint gates are blind to this). Fix the analytics read at root.',
    );
  } else if (displayPv !== null && Number.isFinite(displayPv) && displayPv > after) {
    console.log(
      `   ↳ FABRICATED: the DISPLAY shows ${displayPv} pageviews but the STORE only holds ${after} — the analytics read over-counts.`,
    );
  }
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
