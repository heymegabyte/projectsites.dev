/**
 * reconcile-counts.mjs — TRUTHFUL-DATA reconciler that needs NO Browserbase.
 *
 * The sibling `reconcile-surfaces.mjs` drives a real browser (the admin API is
 * CF-bot-challenged from headless) and therefore SKIPS whenever Browserbase creds
 * are unset — so on most local/CI runs the truthful-data dimension goes unverified.
 * This probe closes that gap a different way, per `verify-against-source-of-truth`
 * ("reconcile display-vs-STORE, not just render-vs-endpoint" + "build the reconciler
 * as a reusable tool"):
 *
 *   GROUND TRUTH  ← `wrangler d1 execute --remote` COUNT(*) per concept (the store),
 *   DISPLAY       ← the authed admin API via the `*.workers.dev` origin (bypasses the
 *                    Bot-Fight challenge that blocks headless calls to projectsites.dev),
 *   FLAG          → display !== store ⇒ LYING-EMPTY / WRONG-SOURCE (a real bug).
 *
 * Fail-open (conditional-ci-gates): if E2E_API_KEY or CLOUDFLARE_API_KEY is unset it
 * prints a `::notice::` and exits 0 — never a false red on a secret-less run.
 *
 * Run:  E2E_API_KEY=$(get-secret E2E_API_KEY) CLOUDFLARE_API_KEY=$(get-secret CLOUDFLARE_API_KEY) \
 *       CLOUDFLARE_EMAIL=blzalewski@gmail.com node e2e/admin-verify/reconcile-counts.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSecret } from './_browserbase-creds.mjs';

const KEY = resolveSecret('E2E_API_KEY');
const CF_KEY = resolveSecret('CLOUDFLARE_API_KEY');
const CF_EMAIL = resolveSecret('CLOUDFLARE_EMAIL') || 'blzalewski@gmail.com';
const ORG = process.env.RECONCILE_ORG || 'e2e-test-org'; // the org E2E_API_KEY authenticates as
const API = process.env.RECONCILE_API_BASE || 'https://project-sites.manhattan.workers.dev';
const DB = 'project-sites-db-production';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

if (!KEY || !CF_KEY) {
  console.log('::notice:: reconcile-counts skipped — E2E_API_KEY / CLOUDFLARE_API_KEY unset');
  process.exit(0);
}

/** Run ONE remote D1 query and return its first result row (org is a trusted constant — safe to inline). */
function d1(sql) {
  const r = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--env', 'production', '--json', '--command', sql],
    { cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_KEY: CF_KEY, CLOUDFLARE_EMAIL: CF_EMAIL }, maxBuffer: 8 << 20 },
  );
  // Parse STDOUT only — wrangler logs a colored WARNING banner (containing `[`) to
  // STDERR; concatenating it would break JSON.parse. `--json` output is clean on stdout.
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

/** Every org-scoped store count in one query. */
const COUNT_SQL = `SELECT
  (SELECT COUNT(*) FROM sites WHERE org_id='${ORG}' AND deleted_at IS NULL) AS sites,
  (SELECT COUNT(*) FROM media_assets WHERE org_id='${ORG}' AND deleted_at IS NULL) AS media,
  (SELECT COUNT(*) FROM ai_env_vars WHERE org_id='${ORG}' AND deleted_at IS NULL) AS env_vars,
  (SELECT COUNT(*) FROM api_tokens WHERE org_id='${ORG}' AND revoked_at IS NULL AND deleted_at IS NULL) AS api_tokens,
  (SELECT COUNT(*) FROM audit_logs WHERE org_id='${ORG}') AS audit_logs,
  (SELECT COUNT(*) FROM memberships WHERE org_id='${ORG}' AND deleted_at IS NULL) AS team_members,
  (SELECT COUNT(*) FROM mcp_connections WHERE org_id='${ORG}') AS mcp_connections,
  (SELECT COUNT(*) FROM audit_logs WHERE org_id='${ORG}' AND action='workflow.build_complete' AND created_at >= datetime('now','start of month')) AS builds_month;`;

/** Fetch a display count from the authed admin API (workers.dev bypasses Bot-Fight). */
async function display(path, pick) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${KEY}`, 'user-agent': UA } });
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const j = await res.json().catch(() => null);
  if (!j) return { err: 'non-JSON' };
  return { n: pick(j) };
}

const store = d1(COUNT_SQL);
if (!store) {
  console.log('::notice:: reconcile-counts skipped — could not read D1 ground truth (wrangler auth?)');
  process.exit(0);
}

// Each surface: the store count + how to read the SAME count off the display API.
const SURFACES = [
  { key: 'sites', path: '/api/sites', pick: (j) => j.total ?? (Array.isArray(j.data) ? j.data.length : NaN) },
  { key: 'media', path: '/api/media/assets', pick: (j) => (Array.isArray(j.assets) ? j.assets.length : NaN) },
  { key: 'env_vars', path: '/api/env-vars', pick: (j) => (Array.isArray(j.vars) ? j.vars.length : NaN) },
  { key: 'api_tokens', path: '/api/v1-tokens', pick: (j) => (Array.isArray(j.data) ? j.data.length : NaN) },
  { key: 'audit_logs', path: '/api/audit-logs', pick: (j) => j.meta?.total ?? NaN },
  // Team seats (money-adjacent — a wrong member count mis-bills). Display = /api/team
  // members[] (WHERE org_id AND deleted_at IS NULL); store COUNT matches that filter.
  { key: 'team_members', path: '/api/team', pick: (j) => { const d = j.data ?? j; return Array.isArray(d.members) ? d.members.length : NaN; } },
  // MCP connections (org-wide list, mcp_oauth.ts /api/mcp/connections → {data:[…]}).
  { key: 'mcp_connections', path: '/api/mcp/connections', pick: (j) => (Array.isArray(j.data) ? j.data.length : Array.isArray(j) ? j.length : NaN) },
];

const rows = [];
for (const s of SURFACES) {
  const d = await display(s.path, s.pick);
  const storeN = Number(store[s.key]);
  const displayN = d.err ? d.err : Number(d.n);
  const ok = !d.err && Number.isFinite(displayN) && displayN === storeN;
  rows.push({ key: s.key, store: storeN, display: displayN, ok });
}

// Analytics — the incident class (verify-against-source-of-truth: "109 pageviews shown
// as 0"). Reconcile a real published site's DISPLAYED pageview total vs the visitor_events
// store. A windowed display (windowDays) legitimately differs from all-time, so PASS when
// display matches EITHER the windowed or the all-time store count; FAIL only when it
// diverges from both (the true lying-empty / wrong-source signal).
const top = d1(
  `SELECT v.site_id AS id, COUNT(*) AS all_time FROM visitor_events v JOIN sites s ON s.id=v.site_id
   WHERE s.org_id='${ORG}' AND s.deleted_at IS NULL AND v.event_type='pageview'
   GROUP BY v.site_id ORDER BY COUNT(*) DESC LIMIT 1;`,
);
if (top?.id) {
  const res = await fetch(`${API}/api/sites/${top.id}/analytics`, { headers: { authorization: `Bearer ${KEY}`, 'user-agent': UA } });
  const j = res.ok ? await res.json().catch(() => null) : null;
  const env = j?.data ?? j;
  const displayPv = Number(env?.traffic?.pageviews);
  const win = Number(env?.windowDays) || 30;
  const allTime = Number(top.all_time);
  const wq = d1(`SELECT COUNT(*) AS pv FROM visitor_events WHERE site_id='${top.id}' AND event_type='pageview' AND created_at >= datetime('now','-${win} days');`);
  const windowed = Number(wq?.pv);
  const ok = Number.isFinite(displayPv) && (displayPv === windowed || displayPv === allTime);
  rows.push({
    key: 'analytics_pv',
    store: `${windowed}(${win}d)/${allTime}(all)`,
    display: res.ok ? (Number.isFinite(displayPv) ? displayPv : 'no-field') : `HTTP ${res.status}`,
    ok,
  });
}

// Forms — the contact-form → /admin/forms journey + the known lying-empty class
// (`form_submissions` has NO deleted_at column, so a `deleted_at IS NULL` filter once
// swallowed the query → 0). Reconcile the top site's displayed submissions vs the store.
const topForm = d1(
  `SELECT fs.site_id AS id, COUNT(*) AS n FROM form_submissions fs JOIN sites s ON s.id=fs.site_id
   WHERE s.org_id='${ORG}' AND s.deleted_at IS NULL GROUP BY fs.site_id ORDER BY COUNT(*) DESC LIMIT 1;`,
);
if (topForm?.id) {
  const d = await display(`/api/sites/${topForm.id}/forms`, (j) => j.meta?.total ?? (Array.isArray(j.data) ? j.data.length : NaN));
  const storeN = Number(topForm.n);
  const displayN = d.err ? d.err : Number(d.n);
  rows.push({ key: 'form_subs', store: storeN, display: displayN, ok: !d.err && Number.isFinite(displayN) && displayN === storeN });
}

// Snapshots — per-site version history (/admin/snapshots). The list endpoint returns only
// ACTIVE snapshots (`deleted_at IS NULL`); a site accretes many soft-deleted ones, so a naive
// all-rows count is a phantom (top e2e site: 59 total vs 1 active — verified AL-085). Reconcile
// display (`res.data.length`) vs the ACTIVE count on a LIVE site (parent `sites.deleted_at IS
// NULL` too — a deleted site's endpoint 404s, another phantom). Guards the soft-delete filter:
// if it ever drops, display jumps to the full history and this FAILS loudly.
const topSnap = d1(
  `SELECT ss.site_id AS id, COUNT(*) AS n FROM site_snapshots ss JOIN sites s ON s.id=ss.site_id
   WHERE s.org_id='${ORG}' AND s.deleted_at IS NULL AND ss.deleted_at IS NULL
   GROUP BY ss.site_id ORDER BY COUNT(*) DESC LIMIT 1;`,
);
if (topSnap?.id) {
  const d = await display(`/api/sites/${topSnap.id}/snapshots`, (j) => (Array.isArray(j.data) ? j.data.length : NaN));
  const storeN = Number(topSnap.n);
  const displayN = d.err ? d.err : Number(d.n);
  rows.push({ key: 'snapshots', store: storeN, display: displayN, ok: !d.err && Number.isFinite(displayN) && displayN === storeN });
}

// Webhooks — same soft-delete-filter guard as snapshots. `listWebhookEndpoints`
// filters `deleted_at IS NULL`; a site accretes soft-deleted rows (AL-124: top live
// e2e site = 63 total vs 0 active — the whole 504-row org pile is soft-deleted /
// on-deleted-sites). Pick the LIVE site with the most TOTAL webhook rows (deleted or
// not) so a dropped filter is maximally visible, and reconcile display vs the ACTIVE
// count: if the endpoint ever stops filtering `deleted_at`, display jumps from active
// to the full history and this FAILS loudly. Flag-gated (`outbound_webhooks`) — a 404
// is honest-dark (flag off), NOT a divergence, so skip it.
const topWeb = d1(
  `SELECT w.site_id AS id, SUM(CASE WHEN w.deleted_at IS NULL THEN 1 ELSE 0 END) AS active
   FROM webhook_endpoints w JOIN sites s ON s.id = w.site_id
   WHERE w.org_id='${ORG}' AND s.deleted_at IS NULL
   GROUP BY w.site_id ORDER BY COUNT(*) DESC LIMIT 1;`,
);
if (topWeb?.id) {
  const d = await display(`/api/sites/${topWeb.id}/webhooks`, (j) => {
    const dd = j.data ?? j;
    return Array.isArray(dd.endpoints) ? dd.endpoints.length : Array.isArray(dd) ? dd.length : NaN;
  });
  if (d.err !== 'HTTP 404') {
    // 404 = outbound_webhooks flag off → honest-dark, nothing to reconcile.
    const storeN = Number(topWeb.active);
    const displayN = d.err ? d.err : Number(d.n);
    rows.push({ key: 'webhooks_active', store: storeN, display: displayN, ok: !d.err && Number.isFinite(displayN) && displayN === storeN });
  }
}

// Subscription (money-adjacent) — a VALUE reconcile, not a count: the displayed
// plan+status MUST equal the store, else billing lies about what the customer is on
// (a serious wrong-source). Store `free/active` must match `/api/billing/subscription`.
const sub = d1(
  `SELECT plan, status FROM subscriptions WHERE org_id='${ORG}' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1;`,
);
if (sub) {
  const d = await display('/api/billing/subscription', (j) => {
    const s = j.data ?? j;
    return `${s.plan}/${s.status}`;
  });
  const storeV = `${sub.plan}/${sub.status}`;
  rows.push({ key: 'subscription', store: storeV, display: d.err ?? d.n, ok: !d.err && d.n === storeV });
}

// Plan-usage gauges (/api/usage, feature: usage_gauges) — the BILLING "Plan usage" meter the
// customer reads. These are SEPARATE COUNT queries (usage_gauges/service.ts), so they can drift
// from the store INDEPENDENTLY of /api/sites. Reference bug the service comment records: builds
// read a dead `workflow_jobs` table → rendered "0 / 5" while 51 real builds existed — a
// lying-EMPTY gauge that no reconcile probe covered. Reconcile each gauge's `used` vs the
// authoritative store: sites.used == active sites, builds.used == build_complete THIS MONTH.
// Flag-gated: a 404 = usage_gauges off = honest-dark → nothing to reconcile (skip).
{
  const res = await fetch(`${API}/api/usage`, { headers: { authorization: `Bearer ${KEY}`, 'user-agent': UA } });
  if (res.status !== 404) {
    const j = res.ok ? await res.json().catch(() => null) : null;
    const gauges = Array.isArray(j?.data) ? j.data : [];
    const used = (metric) => { const g = gauges.find((x) => x.metric === metric); return g ? Number(g.used) : NaN; };
    const gSites = used('sites');
    const gBuilds = used('builds');
    rows.push({ key: 'usage_sites', store: Number(store.sites), display: res.ok ? gSites : `HTTP ${res.status}`, ok: res.ok && Number.isFinite(gSites) && gSites === Number(store.sites) });
    rows.push({ key: 'usage_builds', store: Number(store.builds_month), display: res.ok ? gBuilds : `HTTP ${res.status}`, ok: res.ok && Number.isFinite(gBuilds) && gBuilds === Number(store.builds_month) });
  }
}

const fails = rows.filter((r) => !r.ok);
for (const r of rows) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.key.padEnd(11)} store=${r.store}  display=${r.display}${r.ok ? '' : '  ← DIVERGENCE (lying-empty / wrong-source)'}`);
}
console.log(
  fails.length
    ? `VERDICT: ❌ FAIL — ${fails.length}/${rows.length} surface(s) diverge (display ≠ store)`
    : `VERDICT: ✅ PASS — ${rows.length}/${rows.length} surfaces reconcile (display == store)`,
);
process.exit(fails.length ? 1 : 0);
