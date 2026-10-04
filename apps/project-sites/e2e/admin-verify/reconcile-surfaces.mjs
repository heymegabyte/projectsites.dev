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
 * brian's account.
 *
 * ⚠️ GROUND TRUTH IS NOW LIVE, NOT A FROZEN SNAPSHOT (fire-128, RECON-SURF-LIVE-GT).
 * The old hardcoded `gt:` floors (sites 12, mcp 2, env 3, …) were a 2026-09-11 snapshot
 * that DRIFTED: brian's org shed its seeded mcp_connections + ai_env_vars, so the stale
 * `gt>0` floors produced FALSE 🔴 LYING-EMPTY flags every run (fire-126: mcp=2/env=3 were
 * actually 0/0 live; fire-127: settings/domains/forms). The surfaces were HONEST; the
 * probe's expectations were stale. We now self-ground-truth: each surface declares HOW to
 * COUNT its own table for org-brian-001 LIVE (`wrangler d1 execute --remote`, same approach
 * as the sibling reconcile-counts.mjs), and the LYING-EMPTY rule becomes:
 *   liveGt > 0 && display == 0  → 🔴 LYING-EMPTY (real bug)
 *   liveGt == 0 && display == 0 → ✅ honest-empty (PASS — the store is genuinely empty)
 * Fail-soft: if a live count query errors (wrangler auth, dropped table), we SKIP that
 * surface's gt check with a `::notice::` and verify render-only — never a false red.
 *
 * SILENT-CAP detector (AL-219, closing the AL-216 blind spot): the row-count vs
 * ground-truth check is BLIND to a silent-cap — for the audit surface a 50-row page ==
 * "OK" while the store truly holds 14,279 rows. For surfaces marked `paged: true`, we
 * ALSO read the endpoint's OWN claimed total (`meta.total`/`total`) + page limit and flag:
 * 🔴 IMPOSSIBLE-TOTAL (claims fewer than it shows) or 🟠 SILENT-CAP-RISK (returns a full
 * page but exposes NO total, so the UI can imply "this is all"). An honest endpoint that
 * exposes its total passes + the true total is reported in the row.
 *
 * ⚠️ IDENTITY (non-obvious, cost a phantom chase AL-325): THIS probe logs in AS BRIAN
 * (`test-login`, org-brian-001) → its display counts AND its ground-truth counts are both
 * scoped to org-brian-001. The sibling `reconcile-counts.mjs` auths with E2E_API_KEY (org
 * `e2e-test-org`) → a DIFFERENT org. Don't cross-count the two.
 *
 * `mode: 'populated'` — for WINDOWED / SUBSET surfaces whose exact count legitimately drifts
 * (per-site analytics pageviews are windowed; per-site logs are target-scoped). These verify
 * populated (display > 0) when their source has data, NOT an exact count. When a `mode:
 * 'populated'` surface ALSO declares a `count` (an org-scoped list like env-vars/apps/social/
 * notifications/subscription), the live ground-truth decides lying-empty-vs-honest-empty just
 * like the exact surfaces — so a legitimately-empty org no longer false-flags.
 *
 * LOCAL headless Playwright (migrated off dead Browserbase, fire-126): the Browserbase
 * coupling is isolated in the shared `_local-browser.mjs` helper.
 *
 * Creds (env → get-secret): E2E_TEST_PASSWORD (login) + CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL
 * (live D1 ground truth). Exits 0 (skip) if E2E_TEST_PASSWORD unset. Missing CF creds →
 * render-only (gt checks skipped with a notice), never a false red.
 * Usage: node e2e/admin-verify/reconcile-surfaces.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { launchLocalBrowser, getTestPassword, authSeedBrian } from './_local-browser.mjs';

const PW = getTestPassword();
if (!PW) {
  console.log('::notice:: reconcile-surfaces skipped — E2E_TEST_PASSWORD unset');
  process.exit(0);
}

const ORG = 'org-brian-001'; // THIS probe logs in as brian → ground truth is brian's org
const DB = 'project-sites-db-production';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CF_KEY = process.env.CLOUDFLARE_API_KEY || '';
const CF_EMAIL = process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com';

/**
 * Run ONE remote D1 query and return its first result row, or null on any failure.
 * ORG/SITE are trusted constants (not user input) — safe to inline. Parses STDOUT only
 * (wrangler logs a colored banner containing `[` to STDERR; `--json` output is clean on
 * stdout). Returns null (→ gt check skipped, never false-red) if wrangler errors.
 */
function d1(sql) {
  if (!CF_KEY) return null;
  const r = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--env', 'production', '--json', '--command', sql],
    { cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_KEY: CF_KEY, CLOUDFLARE_EMAIL: CF_EMAIL }, maxBuffer: 8 << 20 },
  );
  const out = r.stdout || '';
  const start = out.indexOf('[');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(out.slice(start));
    return parsed[0]?.results?.[0] ?? null;
  } catch {
    return null;
  }
}

// Resolve a LIVE per-site target for the per-site surfaces (snapshots/voice/per-site-logs/
// per-site-analytics). The old hardcoded `site-megabytespace-001` was itself a stale snapshot
// constant — it no longer exists in brian's org, so the four per-site endpoints 404'd every
// run (noise, not product bugs). Pick brian's FIRST live site instead; prefer one that has
// snapshots so the snapshots surface actually has data to reconcile. Fail-soft: if the live
// lookup is unavailable (no CF creds), fall back to a sentinel — those surfaces then simply
// report their 404/skip honestly rather than block the org-level checks.
function resolveLiveSite() {
  const withSnaps = d1(
    `SELECT s.id AS id FROM sites s
     WHERE s.org_id='${ORG}' AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM site_snapshots ss WHERE ss.site_id=s.id AND ss.deleted_at IS NULL)
     ORDER BY s.created_at ASC LIMIT 1`,
  );
  if (withSnaps?.id) return String(withSnaps.id);
  const any = d1(`SELECT id FROM sites WHERE org_id='${ORG}' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`);
  return any?.id ? String(any.id) : 'site-megabytespace-001';
}
const SITE = resolveLiveSite();

// Each surface: the DISPLAY endpoint the admin UI actually calls, how to pull the displayed
// count from the JSON envelope (`extract`), and — NEW (fire-128) — how to COUNT the
// authoritative store LIVE for org-brian-001 (`count`, an SQL COUNT(*) string, run via `d1`).
// `count: null` = a surface whose store is NOT a simple org D1 table (notifications live in a
// psnotify DO, per-site analytics is a windowed metric, per-site logs are target-scoped) →
// those stay render-only `mode:'populated'` with no live gt. Column facts verified vs LIVE
// `PRAGMA table_info` (fire-128): mcp_connections + audit_logs have NO `deleted_at`; every
// other org table does; per-site surfaces (snapshots/voice) filter by site_id not org_id.
const SURFACES = [
  {
    name: 'sites',
    endpoint: '/api/sites',
    paged: true,
    total: (d) => d?.meta?.total ?? d?.total,
    pageLimit: (d) => d?.meta?.limit ?? d?.limit,
    extract: (d) => arr(d, 'data', 'sites').length,
    count: `SELECT COUNT(*) AS n FROM sites WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
  {
    name: 'analytics (CORRECT /sites/:id/analytics)',
    endpoint: `/api/sites/${SITE}/analytics`,
    mode: 'populated',
    extract: (d) => num(d?.traffic ?? d, 'pageviews'),
    count: null, // windowed metric (visitor_events, time-boxed) — exact gt drifts by design
  },
  // NOTE (2026-09-05): there is NO dedicated "network-analytics" endpoint. The admin
  // analytics OVERVIEW derives its headline client-side from the per-site analytics row
  // above. The org-wide `/api/analytics/overview` route exists but has zero UI consumers
  // and reads sampled counts that legitimately read 0 — intentionally NOT reconciled.
  {
    name: 'media',
    endpoint: '/api/media/assets',
    extract: (d) => arr(d, 'data', 'assets', 'items').length,
    count: `SELECT COUNT(*) AS n FROM media_assets WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
  {
    name: 'snapshots',
    endpoint: `/api/sites/${SITE}/snapshots`,
    extract: (d) => arr(d, 'data', 'snapshots').length,
    // per-SITE surface (scoped by site_id, not org_id); list returns ACTIVE only → match it
    count: `SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id='${SITE}' AND deleted_at IS NULL`,
  },
  {
    name: 'audit (per-site logs)',
    endpoint: `/api/sites/${SITE}/logs?limit=200`,
    mode: 'populated',
    extract: (d) => arr(d, 'data', 'logs').length,
    count: null, // target_id-scoped windowed view — exact gt drifts; verify populated only
  },
  {
    name: 'audit (org audit-logs)',
    endpoint: '/api/audit-logs?limit=50',
    paged: true,
    total: (d) => d?.meta?.total ?? d?.total,
    pageLimit: (d) => d?.meta?.limit ?? d?.limit ?? 50,
    extract: (d) => arr(d, 'data', 'logs').length,
    count: `SELECT COUNT(*) AS n FROM audit_logs WHERE org_id='${ORG}'`, // NO deleted_at column
  },
  {
    name: 'voice numbers',
    endpoint: `/api/voice/numbers?siteId=${SITE}`,
    extract: (d) => arr(d, 'numbers', 'data').length,
    count: `SELECT COUNT(*) AS n FROM voice_numbers WHERE site_id='${SITE}' AND deleted_at IS NULL`,
  },
  {
    name: 'mcp connections',
    endpoint: '/api/mcp/connections',
    extract: (d) => arr(d, 'data', 'connections').length,
    count: `SELECT COUNT(*) AS n FROM mcp_connections WHERE org_id='${ORG}'`, // NO deleted_at column
  },
  {
    name: 'team members',
    endpoint: '/api/team',
    extract: (d) => arr(d?.data, 'members').length,
    count: `SELECT COUNT(*) AS n FROM memberships WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
  {
    name: 'env vars',
    endpoint: '/api/env-vars',
    mode: 'populated',
    extract: (d) => arr(d, 'vars').length,
    count: `SELECT COUNT(*) AS n FROM ai_env_vars WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
  {
    name: 'apps (app_instances)',
    endpoint: '/api/apps/instances',
    mode: 'populated',
    extract: (d) => arr(d, 'instances', 'data').length,
    count: `SELECT COUNT(*) AS n FROM app_instances WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
  {
    name: 'social accounts',
    endpoint: '/api/social/accounts',
    mode: 'populated',
    extract: (d) => arr(d, 'data', 'accounts').length,
    count: `SELECT COUNT(*) AS n FROM social_accounts WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
  {
    name: 'notifications',
    endpoint: '/api/notifications',
    mode: 'populated',
    extract: (d) => arr(d, 'data', 'notifications', 'items').length,
    count: null, // source is a psnotify Durable Object, NOT a D1 table — can't COUNT in D1
  },
  {
    name: 'billing subscription',
    endpoint: '/api/billing/subscription',
    mode: 'populated',
    extract: (d) => { const x = d?.data ?? d; return x && (x.status || x.plan || x.subscription || x.stripe_subscription_id || x.id) ? 1 : 0; },
    count: `SELECT COUNT(*) AS n FROM subscriptions WHERE org_id='${ORG}' AND deleted_at IS NULL`,
  },
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

// --- resolve LIVE ground truth per surface BEFORE driving the browser (one wrangler call each) ---
// liveGt: a number when the count query ran, or null (→ skip the gt check, render-only + notice).
if (!CF_KEY) {
  console.log('::notice:: reconcile-surfaces — CLOUDFLARE_API_KEY unset; verifying render-only (ground-truth gt checks skipped)');
} else {
  console.log(`::notice:: reconcile-surfaces — per-site surfaces target live site '${SITE}' (org ${ORG})`);
}
let gtSkips = 0;
for (const s of SURFACES) {
  if (!s.count) { s.liveGt = null; continue; } // deliberately render-only (windowed / non-D1 source)
  const row = d1(s.count);
  const n = row == null ? NaN : Number(row.n);
  if (Number.isFinite(n)) {
    s.liveGt = n;
  } else {
    s.liveGt = null;
    gtSkips += 1;
    console.log(`::notice:: reconcile-surfaces — live ground-truth count failed for '${s.name}'; skipping its gt check (render-only)`);
  }
}

const browser = await launchLocalBrowser();
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();

  // Log in as brian INSIDE the browser (CF-clean: goto('/') first for cf_clearance, then the
  // in-page test-login POST). authSeedBrian seeds ps_session; read the token back for fetches.
  const { ok } = await authSeedBrian(page, PW);
  if (!ok) { console.log('::error:: test-login returned no token'); process.exit(4); }
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('ps_session') || '{}').token || '');
  if (!token) { console.log('::error:: ps_session has no token after auth'); process.exit(4); }

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
    // Paged-surface TRUE total (silent-cap detector — AL-219): a list that returns a FULL PAGE
    // but exposes NO total lets the UI imply "this is all" when there's more. Pull the
    // endpoint's OWN claimed total (`meta.total`/`total`) + page limit.
    let totalN = null, limitN = null;
    if (s.paged && res.body != null) {
      try { const t = s.total?.(res.body); totalN = typeof t === 'number' && !Number.isNaN(t) ? t : null; } catch { totalN = null; }
      try { const l = s.pageLimit?.(res.body); limitN = typeof l === 'number' && !Number.isNaN(l) ? l : null; } catch { limitN = null; }
    }
    const gt = s.liveGt; // LIVE org-brian-001 count, or null = render-only (skip gt)
    let verdict;
    // A 404 usually means the surface-map endpoint is stale/renamed (a PROBE bug), not a
    // product data divergence — label it so a stale map never masquerades as a lying-empty
    // data bug. A REAL route regressing to 404 still surfaces (⚠️ stays in the divergence list).
    if (res.status === 404) verdict = '⚠️ HTTP 404 (endpoint missing / surface-map stale?)';
    else if (res.status >= 400 || res.status === 0) verdict = `❌ HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
    // LIVE ground-truth comparison (the fire-128 core): lying-empty is ONLY when the store
    // genuinely has rows but the display shows 0. An empty store + empty display is HONEST.
    else if (gt != null) {
      if (gt > 0 && displayN === 0) verdict = `🔴 LYING-EMPTY (live gt=${gt}, shows 0)`;
      else if (gt === 0 && displayN === 0) verdict = '✅ OK (honest-empty: live 0 == shows 0)';
      else if (gt > 0 && displayN < gt * 0.5) verdict = `🟠 PARTIAL (live gt=${gt}, shows ${displayN})`;
      else verdict = `✅ OK (live gt=${gt}, shows ${displayN})`;
    }
    // No live ground truth (windowed/non-D1 source, or the count query failed → fail-soft):
    // fall back to render-only populated check. The only failure is lying-empty when the
    // surface claims to have data but shows 0; any populated value is correct.
    else if (s.mode === 'populated') verdict = displayN > 0 ? `✅ OK (populated: ${displayN})` : '🟡 render-only: shows 0 (no live gt — can\'t distinguish honest-empty)';
    else verdict = displayN > 0 ? `✅ OK (render-only: ${displayN})` : '🟡 render-only: shows 0 (no live gt)';
    // Silent-cap refinement — ONLY tightens an already-passing paged surface.
    if (s.paged && !verdict.startsWith('❌') && !verdict.startsWith('⚠️') && !verdict.startsWith('🔴')) {
      if (totalN != null && totalN < displayN) verdict = `🔴 IMPOSSIBLE-TOTAL (claims ${totalN} < shows ${displayN})`;
      else if (totalN == null && limitN != null && displayN >= limitN) verdict = `🟠 SILENT-CAP-RISK (full page ${displayN}, no total exposed → UI may imply this is all)`;
      else if (totalN != null) verdict = `${verdict} · total ${totalN} exposed`;
    }
    report.push({ surface: s.name, endpoint: s.endpoint, liveGt: gt, display, total: totalN, status: res.status, verdict });
  }
  console.log('\n=== ADMIN DATA RECONCILIATION (display vs LIVE D1 ground truth, as brian) ===\n');
  for (const row of report) {
    const gtLabel = row.liveGt == null ? '—' : row.liveGt;
    console.log(`${row.verdict.padEnd(52)} ${String(row.surface).padEnd(42)} gt=${String(gtLabel).padEnd(5)} shows=${row.display}${row.total != null ? ` total=${row.total}` : ''}`);
  }
  // 🟡 render-only-shows-0 is a visibility note, NOT a divergence (no ground truth to accuse it).
  const bugs = report.filter((r) => r.verdict.startsWith('🔴') || r.verdict.startsWith('🟠') || r.verdict.startsWith('❌') || r.verdict.startsWith('⚠️'));
  console.log(`\n${bugs.length} divergence(s) found${gtSkips ? ` (${gtSkips} gt check(s) skipped — live count unavailable)` : ''}:`);
  for (const b of bugs) console.log(`  - ${b.surface}: ${b.verdict} → ${b.endpoint}`);
  console.log(
    bugs.length
      ? `VERDICT: ❌ ${bugs.length} divergence(s) — investigate (lying-empty / silent-cap / stale-route)`
      : `VERDICT: ✅ PASS — every surface reconciles with its live store (no lying-empty)`,
  );
  console.log(JSON.stringify(report, null, 0));
} finally {
  await browser.close();
}
