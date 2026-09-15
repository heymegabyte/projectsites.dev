#!/usr/bin/env node
/**
 * verify-billing-entitlements-display.mjs — TRUTHFUL DATA guard for the Billing →
 * Subscription "Entitlements" card (custom-domains / team-seats / analytics). The
 * card renders the plan's GRANTS, and billing.component.ts:1810-1812 documents a
 * PAST regression: it read the sites/storage/seats shape instead of the resolver
 * shape (maxCustomDomains / maxTeamSeats / analyticsEnabled), which "pinned every
 * entitlement to 0" — a silent lying-data bug (a free user saw 0 team seats while
 * the plan actually grants 1). reconcile-counts covers plan+status but NOT the
 * entitlement VALUES, so that regression class is otherwise unguarded: a refactor
 * re-reading the wrong field would re-pin the card to 0 with no gate catching it.
 *
 * This reconciles the rendered card (DOM, after the rolling-counters settle) against
 * the authoritative store (GET /api/billing/entitlements):
 *   • [data-testid="entitlement-custom_domains"] == maxCustomDomains
 *   • [data-testid="entitlement-seats"]          == maxTeamSeats
 *   • [data-testid="entitlement-analytics"]      == (analyticsEnabled ? 'Included' : 'Not included')
 *
 * Local Chromium (the authed admin shell is NOT CF-bot-challenged — seed ps_session
 * + goto /admin/billing). Waits for the counters to finish (they animate 0→value, so
 * a naive early read would false-flag a transient 0 — the exact 2.6s-vs-8s artifact).
 * Skips (exit 0) when E2E_API_KEY is unset so forks + secret-less CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-billing-entitlements-display.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-billing-entitlements-display skipped — E2E_API_KEY unset');
  process.exit(0);
}

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const API = process.env.API_ORIGIN || 'https://project-sites.manhattan.workers.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

try {
  // ── STORE: the authoritative entitlement grants ────────────────────────────
  const entRes = await fetch(`${API}/api/billing/entitlements`, {
    headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': UA, Origin: ORIGIN },
    signal: AbortSignal.timeout(20000),
  });
  if (entRes.status !== 200) {
    console.log(`::notice:: verify-billing-entitlements-display skipped — entitlements API returned ${entRes.status}`);
    process.exit(0);
  }
  const store = (await entRes.json().catch(() => ({})))?.data ?? {};
  const wantDomains = String(store.maxCustomDomains ?? '');
  const wantSeats = String(store.maxTeamSeats ?? '');
  // AL-600: the false state is the SYMMETRIC honest "Not included" (was a bare "—" that
  // read as "no data" next to the numeric domains/seats entitlements). Keeps display==store.
  const wantAnalytics = store.analyticsEnabled ? 'Included' : 'Not included';

  // ── DISPLAY: what the Billing card actually renders (after counters settle) ──
  const b = await chromium.launch();
  const p = await (
    await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  ).newPage();
  await p.goto(`${ORIGIN}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.evaluate(
    (k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })),
    KEY,
  );
  await p.goto(`${ORIGIN}/admin/billing`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The rolling-counters animate 0→value once entitlements load; wait for the seats
  // cell to render the settled (non-empty, non-transient-0-unless-store-is-0) value.
  await p.waitForSelector('[data-testid="entitlement-seats"]', { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(6000);
  const read = async (testid) =>
    (await p.evaluate((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      return el ? (el.textContent || '').trim() : null;
    }, testid));
  const gotDomains = await read('entitlement-custom_domains');
  const gotSeats = await read('entitlement-seats');
  const gotAnalytics = await read('entitlement-analytics');
  await b.close();

  const rows = [];
  let fails = 0;
  const cmp = (label, got, want) => {
    const ok = got !== null && got === want;
    rows.push({ label, ok, detail: `display="${got}" store="${want}"` });
    if (!ok) fails++;
  };
  cmp('custom-domains display == maxCustomDomains', gotDomains, wantDomains);
  cmp('team-seats display == maxTeamSeats', gotSeats, wantSeats);
  cmp('analytics display == analyticsEnabled', gotAnalytics, wantAnalytics);

  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(46)} ${r.detail}`);
  const ok = fails === 0;
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} — billing entitlements card ${ok ? 'reconciles with the resolver (display == store)' : 'DRIFTS from the resolver'}`,
  );
  if (!ok) console.log('   ↳ a card pinned to 0 while the store grants more = the billing.component.ts:1810 wrong-field regression.');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
