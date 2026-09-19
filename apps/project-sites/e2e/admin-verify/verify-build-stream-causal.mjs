// verify-build-stream-causal.mjs — STREAMING BUILD THEATER: the LIVE causal round-trip through the
// real HMAC ingest, the credit-INDEPENDENT end-to-end proof the pipe lacked. The existing
// site-quality/verify-build-stream.mjs reconciles against D1 *history* (liveness + noise ratio) but
// never exercises the real endpoint NOW nor confirms the render-data leg. A real build can't prove it
// either right now: the build-LLM balance is dead (402 → 98% noise, `claude -p` never runs → an EMPTY
// terminal), and topping it up is Brian-gated (billing/secret). This probe proves the whole pipe
// deterministically without a live build, by DOING the causal test (perform → store records → display
// surfaces) from verify-against-source-of-truth:
//
//   1. INGEST ACCEPTS (NOW) — HMAC-sign a 4-line batch and POST /api/internal/build-log for a real
//      OWNED site. Assert 200 + { ok:true, written:3 }. The batch is [marker(phase), planted-secret,
//      planted-402-noise, success]; the worker DROPS the noise line and KEEPS the other 3 → written:3
//      proves in ONE shot: HMAC valid + `live_build_stream` flag ON + FK-safe write (actor_id:null) +
//      the isBuildLogNoise drop all fire live.
//   2. HMAC ENFORCED — the SAME body with a bad x-build-sig → 401 (a forged container can't inject).
//   3. jobId REQUIRED — a valid-sig batch with no jobId → 400 (never an unattributed write).
//   4. RENDER-DATA LEG — GET /api/sites/:id/logs (the exact call the /waiting terminal makes via
//      getSiteLogs) surfaces the marker line → audit_logs → terminal-data path proven.
//   5. REDACTION AT REST — the planted `sk-…` / `API_KEY=…` secret is `***REDACTED***` in the stored
//      row and the raw key is ABSENT (redactStreamSecrets ran server-side; a leaked key never lands).
//   6. NOISE DROPPED AT REST — the planted `API Error: 402 Insufficient Balance` line is ABSENT from
//      the store (isBuildLogNoise ran at ingest; the owner never sees scary infra noise).
//
// The render leg's LAST mile (audit row → colored terminal line) is the pure, unit-tested
// toBuildLogLine/classifyLogLine/redactBuildLogSecrets in waiting.component.spec.ts — so store-data
// (this probe) + data→line (units) = full end-to-end coverage without a live-generating site.
//
// Read/append-only (adds 3 clearly-marked probe rows to a TEST-org site's audit_logs — additive, like
// every admin-verify causal probe). Fail-OPEN when E2E_API_KEY or INTERNAL_BUILD_SECRET is absent
// (conditional-ci-gates) so secret-less/CI runs stay green. Auto-joins admin-verify run-all via the
// verify-*-causal.mjs glob.
//
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) INTERNAL_BUILD_SECRET=$(get-secret INTERNAL_BUILD_SECRET) \
//        node e2e/admin-verify/verify-build-stream-causal.mjs
import { createHmac, randomBytes } from 'node:crypto';

// The build CONTAINER POSTs to the worker's workers.dev host (INTERNAL_CALLBACK_URL in wrangler.toml),
// NOT the custom domain — Cloudflare Bot-Fight Mode 403s inbound POST/webhook calls on projectsites.dev
// (bot-fight-mode-blocks-inbound-webhooks), so the internal pipe rides workers.dev. This probe exercises
// the SAME real path the container uses. Overridable via ORIGIN.
const ORIGIN = process.env.ORIGIN || 'https://project-sites.manhattan.workers.dev';
const KEY = process.env.E2E_API_KEY || '';
const SECRET = process.env.INTERNAL_BUILD_SECRET || '';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};
const skip = (label, detail = '') => rows.push({ ok: null, label, detail });

const sign = (body) => createHmac('sha256', SECRET).update(body).digest('hex');
const authed = (path) =>
  fetch(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': UA, Accept: 'application/json' } });

async function ingest(body, sig) {
  const res = await fetch(`${ORIGIN}/api/internal/build-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-build-sig': sig, 'User-Agent': UA },
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

if (!KEY || !SECRET) {
  skip('E2E_API_KEY / INTERNAL_BUILD_SECRET unset — build-stream causal round-trip skipped (fail-open)',
    'export both to assert the pipe');
} else {
  try {
    // discover a real OWNED (test-org) siteId — the ingest maps jobId→siteId, falling back to jobId==siteId
    const sitesRes = await authed('/api/sites');
    const sitesBody = await sitesRes.json().catch(() => null);
    const list = Array.isArray(sitesBody?.data)
      ? sitesBody.data
      : Array.isArray(sitesBody?.sites)
        ? sitesBody.sites
        : Array.isArray(sitesBody)
          ? sitesBody
          : [];
    const siteId = list[0]?.id || null;
    check('discovered a real OWNED siteId to attribute the stream to', !!siteId,
      siteId ? `siteId=${siteId}` : `0 sites (status ${sitesRes.status})`);

    if (siteId) {
      const marker = `STREAM-THEATER-CAUSAL-${Date.now()}-${randomBytes(4).toString('hex')}`;
      const RAW_SECRET = 'sk-causalprobe0123456789abcdef';
      const NOISE_LINE = 'API Error: 402 Insufficient Balance';
      const lines = [
        `${marker} writing src/components/Hero.tsx`, // marker + present-participle → phase (kept)
        `export OPENAI_API_KEY=${RAW_SECRET}`, // planted secret (kept, redacted at rest)
        NOISE_LINE, // control-plane/transport noise (DROPPED at ingest)
        `✓ created src/components/Hero.tsx`, // success (kept)
      ];
      const body = JSON.stringify({ jobId: siteId, lines });

      // ── 1. ingest ACCEPTS now → written:3 (marker + redacted-secret + success; noise dropped) ──
      const good = await ingest(body, sign(body));
      check('POST /api/internal/build-log (valid HMAC) → 200 + ok:true + written:3 (noise dropped, 3 kept)',
        good.status === 200 && good.json?.ok === true && good.json?.written === 3,
        `status=${good.status} written=${good.json?.written} ok=${good.json?.ok}`);

      // ── 2. HMAC enforced — same body, bad signature → 401 ──
      const forged = await ingest(body, 'deadbeef'.repeat(8));
      check('forged x-build-sig → 401 (a spoofed container cannot inject build logs)',
        forged.status === 401, `status=${forged.status}`);

      // ── 3. jobId required — valid sig, no jobId → 400 ──
      const noJobBody = JSON.stringify({ lines });
      const noJob = await ingest(noJobBody, sign(noJobBody));
      check('missing jobId → 400 (never an unattributed write)', noJob.status === 400, `status=${noJob.status}`);

      // give the async audit write a beat to commit before we read it back
      await new Promise((r) => setTimeout(r, 1500));

      // ── 4-6. render-data leg + redaction-at-rest + noise-dropped-at-rest ──
      const logsRes = await authed(`/api/sites/${siteId}/logs`);
      const logsText = await logsRes.text();
      check(`GET /api/sites/:id/logs surfaces the streamed marker line (audit_logs → terminal data)`,
        logsRes.status === 200 && logsText.includes(marker),
        `status=${logsRes.status} markerFound=${logsText.includes(marker)}`);
      check('planted secret is REDACTED at rest (***REDACTED*** present, raw sk-… absent)',
        logsText.includes('***REDACTED***') && !logsText.includes(RAW_SECRET),
        `redactedMarker=${logsText.includes('***REDACTED***')} rawLeaked=${logsText.includes(RAW_SECRET)}`);
      check('planted 402 noise line was DROPPED at ingest (never lands in the owner-facing store)',
        !logsText.includes('Insufficient Balance'),
        `noiseLeaked=${logsText.includes('Insufficient Balance')}`);
    }
  } catch (e) {
    check('build-stream causal round-trip completed', false, 'error: ' + String(e).slice(0, 160));
  }
}

for (const r of rows) console.log(`  ${r.ok === null ? '⏭️ ' : r.ok ? '✓' : '✗'} ${r.label.padEnd(68)} ${r.detail}`);
const ran = rows.some((r) => r.ok !== null);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} build-stream causal gate(s) broke on ${ORIGIN}.`
    : ran
      ? `\nVERDICT: ✅ PASS — the STREAMING BUILD THEATER pipe works end-to-end live: HMAC ingest accepts + enforces sig, drops noise, redacts secrets at rest, and the render-data leg (getSiteLogs) surfaces the streamed line on ${ORIGIN}.`
      : `\nVERDICT: ⏭️  SKIP — no E2E_API_KEY/INTERNAL_BUILD_SECRET; build-stream causal round-trip not asserted (fail-open).`,
);
process.exit(fails ? 1 : 0);
