#!/usr/bin/env node
/**
 * gen-baseline.mjs — generation speed + cost baseline reader (fire-60).
 *
 * Prints p50/p95 total_ms, per-phase breakdown, and est_cost_usd over the last
 * N builds from the `build_metrics` D1 table (migration 0652). When the table
 * is empty/new, also RECONSTRUCTS a coarse historical baseline from existing
 * `sites` rows (created_at → updated_at for published sites) — clearly labeled
 * `reconstructed` vs `measured`: updated_at moves on ANY later site update, so
 * reconstructed durations are an UPPER BOUND, filtered to a sane <6h window to
 * drop long-lived re-edited rows.
 *
 * Usage:
 *   node scripts/gen-baseline.mjs                 # prod D1, last 50 builds
 *   node scripts/gen-baseline.mjs --n 200         # widen the window
 *   node scripts/gen-baseline.mjs --local         # wrangler --local D1
 *   node scripts/gen-baseline.mjs --db <d1-name>  # non-default database
 *   node scripts/gen-baseline.mjs --json          # machine-readable envelope
 *
 * Auth: shells out to `npx wrangler d1 execute` — provide CLOUDFLARE_API_TOKEN
 * or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL in the environment for --remote.
 * Read-only: issues SELECTs only.
 */

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const N = Math.max(1, parseInt(opt('n', '50'), 10) || 50);
const DB_NAME = opt('db', 'project-sites-db-production');
const LOCAL = flag('local');
const AS_JSON = flag('json');

/** Run a read-only SQL against D1 via wrangler; returns result rows. */
function d1Query(sql) {
  const argv = [
    'wrangler',
    'd1',
    'execute',
    DB_NAME,
    LOCAL ? '--local' : '--remote',
    '--json',
    '--command',
    sql,
  ];
  const out = execFileSync('npx', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  // wrangler --json emits an array of result-set envelopes.
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`unparseable wrangler output: ${out.slice(0, 200)}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed?.[0]?.results ?? [];
}

/** p-th percentile (nearest-rank) of a numeric array; null when empty. */
function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const mean = (values) =>
  values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;

const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}min`;
};
const fmtUsd = (usd) => (usd === null || usd === undefined ? 'n/a' : `$${usd.toFixed(4)}`);

// ── Measured: build_metrics rows ────────────────────────────────────────────
let measured = [];
let measuredError = null;
try {
  measured = d1Query(
    `SELECT build_id, site_id, started_at, published_at, total_ms, phase_ms,
            tokens_in, tokens_out, est_cost_usd, container_ms, outcome
       FROM build_metrics ORDER BY started_at DESC LIMIT ${N}`,
  );
} catch (err) {
  measuredError = String(err?.message || err).slice(0, 300);
}

// ── Reconstructed (primary): audit_logs workflow.started → build_complete ──
// Pairs each build_complete with the nearest PRECEDING workflow.started for
// the same site, CLIENT-SIDE (a correlated subquery over audit_logs exceeds
// D1's per-query compute limit — APIError 7500). Clamped 1min–3h to drop
// cross-run mispairs. This is the real historical build duration.
let reconstructed = [];
let reconstructedError = null;
try {
  const toMs = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')).getTime();
  // audit_logs keys the site as target_id (target_type='site') — no site_id column.
  const completes = d1Query(
    `SELECT target_id AS site_id, created_at FROM audit_logs
      WHERE action = 'workflow.build_complete' AND target_type = 'site'
      ORDER BY created_at DESC LIMIT ${N}`,
  );
  const starts = d1Query(
    `SELECT target_id AS site_id, created_at FROM audit_logs
      WHERE action = 'workflow.started' AND target_type = 'site'
      ORDER BY created_at DESC LIMIT ${Math.max(N * 4, 1000)}`,
  );
  const startsBySite = new Map();
  for (const s of starts) {
    const arr = startsBySite.get(s.site_id) ?? [];
    arr.push(toMs(s.created_at));
    startsBySite.set(s.site_id, arr);
  }
  for (const arr of startsBySite.values()) arr.sort((a, b) => a - b);
  reconstructed = completes
    .map((c) => {
      const done = toMs(c.created_at);
      const arr = startsBySite.get(c.site_id) ?? [];
      // nearest start at-or-before done
      let begin = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] <= done) {
          begin = arr[i];
          break;
        }
      }
      return begin === null
        ? null
        : { site_id: c.site_id, done_at: c.created_at, approx_ms: done - begin };
    })
    .filter((r) => r && Number.isFinite(r.approx_ms) && r.approx_ms >= 60_000 && r.approx_ms <= 10_800_000);
} catch (err) {
  reconstructedError = String(err?.message || err).slice(0, 300);
}

// ── Reconstructed (fallback): sites.created_at → updated_at (coarse) ──────
let sitesDelta = [];
try {
  if (reconstructed.length === 0) {
    sitesDelta = d1Query(
      `SELECT id, slug, created_at, updated_at,
              CAST((julianday(updated_at) - julianday(created_at)) * 86400000 AS INTEGER) AS approx_ms
         FROM sites
        WHERE status = 'published' AND deleted_at IS NULL
          AND (julianday(updated_at) - julianday(created_at)) * 86400000 BETWEEN 60000 AND 21600000
        ORDER BY created_at DESC LIMIT ${N}`,
    );
  }
} catch {
  /* fallback only — primary error already captured */
}

// ── Reconstructed cost (billing-estimate only): token_burn_meter spends ────
// usage_events ai_spend_micro_usd rows are the $0.01/min + $1-floor BILLING
// estimates recorded per container build — labeled estimate, not measured.
let histSpend = { n: 0, mean_usd: null };
try {
  const r = d1Query(
    `SELECT COUNT(*) AS n, AVG(value) / 1000000.0 AS mean_usd
       FROM usage_events WHERE metric = 'ai_spend_micro_usd'`,
  );
  if (r[0]) histSpend = { n: r[0].n ?? 0, mean_usd: r[0].mean_usd ?? null };
} catch {
  /* optional signal */
}

// ── Aggregate ───────────────────────────────────────────────────────────────
const published = measured.filter((r) => r.outcome === 'published');
const totals = published.map((r) => r.total_ms).filter((v) => Number.isFinite(v));
const costs = measured.map((r) => r.est_cost_usd).filter((v) => Number.isFinite(v));
const phases = { collecting: [], imaging: [], generating: [], publishing: [] };
for (const r of published) {
  try {
    const p = JSON.parse(r.phase_ms || '{}');
    for (const k of Object.keys(phases)) {
      if (Number.isFinite(p[k])) phases[k].push(p[k]);
    }
  } catch {
    /* corrupt phase json — skip row */
  }
}
const approxSource = reconstructed.length > 0 ? reconstructed : sitesDelta;
const approxLabel =
  reconstructed.length > 0
    ? 'audit_logs workflow.started→build_complete pairing (clamped 1min–3h)'
    : 'sites.created_at→updated_at for published sites (COARSE upper bound; window-clamped 1min–6h)';
const approx = approxSource.map((r) => r.approx_ms).filter((v) => Number.isFinite(v));

const report = {
  meta: {
    db: DB_NAME,
    mode: LOCAL ? 'local' : 'remote',
    window: N,
    generated_at: new Date().toISOString(),
    north_star: 'total_ms p95 < 300000 (5 min live) AND est_cost_usd p95 <= 1.00',
  },
  measured: {
    source: 'build_metrics (instrumented — real phase stamps + token counters)',
    rows: measured.length,
    published: published.length,
    errors: measured.filter((r) => r.outcome === 'error').length,
    halted: measured.filter((r) => r.outcome === 'halted').length,
    total_ms: { p50: percentile(totals, 50), p95: percentile(totals, 95), mean: mean(totals) },
    phase_ms_p50: Object.fromEntries(
      Object.entries(phases).map(([k, v]) => [k, percentile(v, 50)]),
    ),
    est_cost_usd: {
      p50: percentile(costs, 50),
      p95: percentile(costs, 95),
      mean: mean(costs),
    },
    error: measuredError,
  },
  reconstructed: {
    source: approxLabel,
    rows: approx.length,
    total_ms: { p50: percentile(approx, 50), p95: percentile(approx, 95), mean: mean(approx) },
    billing_estimate_spend: histSpend,
    error: reconstructedError,
  },
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`\n── Generation baseline — ${DB_NAME} (${report.meta.mode}, last ${N}) ──`);
console.log(`North star: <5 min live · ≤$1.00/build\n`);

const m = report.measured;
console.log(`MEASURED (build_metrics): ${m.rows} rows (${m.published} published / ${m.errors} error / ${m.halted} halted)`);
if (m.error) console.log(`  query error: ${m.error}`);
if (m.rows === 0) {
  console.log('  (empty — instrument just landed; rows appear on the next builds)');
} else {
  console.log(`  total     p50 ${fmtMs(m.total_ms.p50)} · p95 ${fmtMs(m.total_ms.p95)} · mean ${fmtMs(m.total_ms.mean)}`);
  for (const [k, v] of Object.entries(m.phase_ms_p50)) {
    console.log(`  ${k.padEnd(10)} p50 ${fmtMs(v)}`);
  }
  console.log(`  est cost  p50 ${fmtUsd(m.est_cost_usd.p50)} · p95 ${fmtUsd(m.est_cost_usd.p95)} · mean ${fmtUsd(m.est_cost_usd.mean)}`);
}

const h = report.reconstructed;
console.log(`\nRECONSTRUCTED: ${h.rows} rows — ${h.source}`);
if (h.error) console.log(`  query error: ${h.error}`);
if (h.rows > 0) {
  console.log(`  total     p50 ${fmtMs(h.total_ms.p50)} · p95 ${fmtMs(h.total_ms.p95)} · mean ${fmtMs(h.total_ms.mean)}`);
}
if (h.billing_estimate_spend.n > 0) {
  console.log(`  billing-estimate spend (token_burn_meter, $1-floor): ${h.billing_estimate_spend.n} builds · mean ${fmtUsd(h.billing_estimate_spend.mean_usd)}`);
}
console.log('');
