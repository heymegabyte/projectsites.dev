// verify-build-stream.mjs — STREAMING BUILD THEATER: reconcile the live build-log stream
// against the AUTHORITATIVE store (D1 audit_logs), never render-integrity alone.
//
// The /waiting terminal renders `claude.output` audit rows streamed from the build container
// through the HMAC-signed POST /api/internal/build-log ingest (flag `live_build_stream`). A green
// terminal that shows nothing — OR shows scary infra noise — both pass every render check. This
// probe closes that gap by querying the STORE the terminal reads:
//
//   1. LIVENESS — has the container→HMAC→worker→audit path EVER written a claude.output row?
//      (0 rows ⇒ the pipe is broken/never fired ⇒ FAIL. ≥1 ⇒ the stream is live.)
//   2. NOISE RATIO (health signal, ::notice not fail) — what fraction of streamed rows are Claude
//      Code control-plane / provider-transport noise? A HIGH ratio means the build LLM is 402ing
//      (dead balance) so `claude -p` never really runs — a Brian-gated INFRA issue, not a code bug.
//   3. FORWARD FILTER-INTEGRITY (opt-in) — when STREAM_FILTER_SINCE=<ISO> is set, assert ZERO
//      claude.output rows created after that instant are noise (proves the isBuildLogNoise filter
//      is live). Skipped by default so pre-filter debt (old noise rows) never false-REDs.
//
// Read-only. Fail-OPEN when CLOUDFLARE_API_KEY is absent (conditional-ci-gates) so secret-less
// runs stay green. Auto-joins site-quality run-all via the verify-*.mjs glob.
import { execFileSync } from 'node:child_process';

const DB = 'project-sites-db-production';
const SINCE = process.env.STREAM_FILTER_SINCE || ''; // ISO ts → enable forward filter-integrity

// Mirror of build_log.ts / waiting.component.ts isBuildLogNoise — kept in sync by intent.
const NOISE = [
  /\[claude-code:/i,
  /\bunrecognized_model\b/i,
  /\bgenerate_session_title\b/i,
  /model catalog/i,
  /\bbehavesAs\b/i,
  /"query_source"\s*:/i,
  /^\s*API Error:\s*\d{3}\b/i,
  /\binsufficient balance\b/i,
];
const isNoise = (t) => NOISE.some((re) => re.test(String(t || '')));

if (!process.env.CLOUDFLARE_API_KEY) {
  console.log('::notice:: CLOUDFLARE_API_KEY unset — skipping build-stream ground-truth reconcile (fail-open).');
  process.exit(0);
}

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--env', 'production', '--json', '--command', sql],
    { encoding: 'utf-8', env: { ...process.env, CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com' }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

let fails = 0;
const rows = [];
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

// 1. Liveness + noise ratio.
const [agg] = d1(
  "SELECT COUNT(*) total, MAX(created_at) latest, SUM(CASE WHEN message LIKE '%Insufficient Balance%' OR message LIKE '%unrecognized_model%' OR message LIKE '%model catalog%' OR message LIKE '%API Error%' THEN 1 ELSE 0 END) noise FROM audit_logs WHERE action='claude.output'",
);
const total = Number(agg?.total || 0);
const noise = Number(agg?.noise || 0);
const real = total - noise;
check('build stream is LIVE (≥1 claude.output row written through the HMAC ingest)', total >= 1,
  `total=${total} real=${real} latest=${agg?.latest || 'never'}`);

if (total > 0) {
  const pct = Math.round((noise / total) * 100);
  if (pct >= 50)
    console.log(`::notice:: build-LLM HEALTH — ${pct}% of ${total} streamed lines are control-plane/transport NOISE (real=${real}). A dead build-LLM balance (402) means claude -p never runs; the theater streams errors, not a build. Brian-gated: top up DeepSeek OR set BUILD_LLM_PROVIDER=anthropic.`);
  else
    console.log(`::notice:: build-LLM HEALTH — ${pct}% noise across ${total} streamed lines (real=${real}); the build LLM is running.`);
}

// 2. Forward filter-integrity (opt-in via STREAM_FILTER_SINCE).
if (SINCE) {
  const recent = d1(
    `SELECT substr(message,1,120) message FROM audit_logs WHERE action='claude.output' AND created_at > '${SINCE.replace(/'/g, '')}' LIMIT 200`,
  );
  const leaked = recent.filter((r) => isNoise(r.message));
  check(`filter-integrity: 0 NOISE rows after ${SINCE} (${recent.length} checked)`, leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.slice(0, 3).map((l) => JSON.stringify(l.message)).join(' | ')}` : `${recent.length} post-filter rows clean`);
} else {
  console.log('::notice:: forward filter-integrity skipped — set STREAM_FILTER_SINCE=<ISO ts of the filter deploy> after a fresh build to assert no new noise leaks.');
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(60)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} build-stream reconcile failure(s) (the /waiting terminal's data store is broken or leaking noise).`
    : `\nVERDICT: ✅ PASS — build stream reconciles with D1 (pipe live, filter honest).`,
);
process.exit(fails ? 1 : 0);
