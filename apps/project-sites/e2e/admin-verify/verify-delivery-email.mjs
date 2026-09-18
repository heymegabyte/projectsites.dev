// verify-delivery-email.mjs — GOLDEN-JOURNEY completion-email contract. Proves the "your site
// is live" delivery email was ACTUALLY sent to the org owner, from PLATFORM RECORDS — not the
// recipient's inbox. Closes the gap verify-delivery-completion.mjs (public render + AL-224 logo
// transparency) and verify-delivered-site-propagation.mjs (admin surfaces) both leave open.
//
// WHY audit_logs, not the notifications table: the completion email fires via SES inside the
// workflow's finalize step and is logged to the SITE AUDIT LOG as `workflow.owner_notified`
// with `{ ok, to (masked), trace_id, site_id }` (AL-360 — made the send outcome observable). The
// notifications table is NOT written on this path (see memory
// completion-email-fires-notifications-table-does-not) — so a notif-table check false-negatives;
// the audit row is the authoritative signal. A silent SES suppression logs `ok:false` here.
//
// Signal: audit_logs row action='workflow.owner_notified' for this site (matched on `target_id`,
// which ALWAYS holds the site id) → metadata_json.ok === true.
//
// AL-743 hardening (evidence-driven — hit live on the Superdawg delivery):
//   1. RETRY-ON-EMPTY: the owner_notified row is written at publish time; a verification run
//      moments later can read a D1 replica that hasn't caught up → a FALSE "no row yet". Retry a
//      few times with backoff before concluding absent (only when the row is missing — an ok:false
//      is a definitive fail, never retried).
//   2. AUTO-TARGET: with no SITE_ID, resolve the MOST-RECENT published site in org-brian-001, so
//      the probe self-targets the latest delivery and JOINS run-all as a standing guard (was: exit 2).
//   3. Match on `target_id = SITE_ID` (reliable) rather than only `metadata_json LIKE` (metadata
//      carries site_id on newer builds but not the oldest — target_id is always correct).
//
// Tracking-mode by default (::notice, suite-safe); STRICT=1 → exit 1 on a missing row or ok:false.
// Fail-open (conditional-ci-gates): no CF auth in env ⇒ ::notice + exit 0.
//
// Usage: [SITE_ID=<uuid>] [DELIVERED_SLUG=<slug>] node e2e/admin-verify/verify-delivery-email.mjs
import { execFileSync } from 'node:child_process';

const STRICT = process.env.STRICT === '1';
const DB = process.env.PROD_D1 || 'project-sites-db-production';
const OWNER_ORG = process.env.OWNER_ORG || 'org-brian-001';

// CF auth is required for `wrangler d1 --remote`. Absent ⇒ fail-open (mirrors verify-admin-cwv).
if (!process.env.CLOUDFLARE_API_KEY && !process.env.CLOUDFLARE_API_TOKEN) {
  console.log('::notice:: verify-delivery-email skipped — no CLOUDFLARE_API_KEY/TOKEN in env');
  process.exit(0);
}

/** Run one read-only D1 query via wrangler; returns the first result row (or null). */
function d1QueryOne(sql) {
  try {
    const raw = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // wrangler --json prints `[{ results: [...], success, meta }]` (sometimes with a leading banner).
    const jsonStart = raw.indexOf('[');
    const parsed = JSON.parse(raw.slice(jsonStart));
    return parsed?.[0]?.results?.[0] ?? null;
  } catch (e) {
    if (process.env.DEBUG) console.log('::debug:: d1 query failed:', String(e.message || e).slice(0, 120));
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Resolve the target site: SITE_ID env → else the most-recent PUBLISHED delivery in the org. ──
let SITE_ID = process.env.SITE_ID || '';
let SLUG = process.env.DELIVERED_SLUG || '';
if (!SITE_ID) {
  const latest = d1QueryOne(
    `SELECT id, slug FROM sites WHERE org_id = '${OWNER_ORG}' AND status = 'published' ` +
      `AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
  );
  if (!latest?.id) {
    console.log(`::notice:: verify-delivery-email skipped — no published delivery in ${OWNER_ORG} to verify`);
    process.exit(0);
  }
  SITE_ID = latest.id;
  SLUG = SLUG || latest.slug || '';
  console.log(`↳ auto-targeted latest published delivery: ${SLUG || SITE_ID}`);
}

// SITE_ID is a UUID we control (env or our own query) — reject anything non-UUID-ish before inlining
// (wrangler d1 --command has no bind flag). This is the injection guard the inline query relies on.
if (!/^[0-9a-f-]{8,40}$/i.test(SITE_ID)) {
  console.log('::error:: SITE_ID is not a UUID');
  process.exit(2);
}

// Match on target_id (always the site id) — robust across old + new builds. metadata_json still
// carries the masked recipient + ok flag we report.
const sql =
  `SELECT action, metadata_json, created_at FROM audit_logs ` +
  `WHERE action = 'workflow.owner_notified' AND target_id = '${SITE_ID}' ` +
  `ORDER BY created_at DESC LIMIT 1`;

// RETRY-ON-EMPTY: absorb D1 replica lag on a just-published delivery (up to ~30s). A row that comes
// back ok:false is definitive (no retry) — only a MISSING row is retried.
let row = null;
const ATTEMPTS = Number(process.env.EMAIL_VERIFY_ATTEMPTS || 4);
for (let i = 1; i <= ATTEMPTS; i++) {
  row = d1QueryOne(sql);
  if (row) break;
  if (i < ATTEMPTS) {
    console.log(`  … no owner_notified row yet (attempt ${i}/${ATTEMPTS}) — replica lag? retrying in 8s`);
    await sleep(8000);
  }
}

const out = { site_id: SITE_ID, slug: SLUG || undefined };
let ok = false;
let meta = {};
if (row) {
  try {
    meta = JSON.parse(row.metadata_json || '{}');
  } catch {
    meta = {};
  }
  ok = meta.ok === true;
  out.recipient = meta.to || '(unknown)';
  out.sent_at = row.created_at;
  out.trace_id = meta.trace_id;
  out.send_ok = ok;
  if (meta.error) out.send_error = String(meta.error).slice(0, 160);
}

console.log('\n=== DELIVERY EMAIL — completion-email platform record (' + (SLUG || SITE_ID) + ') ===');
console.log(JSON.stringify(out, null, 2));

if (ok) {
  console.log(
    `\n✅ EMAIL PASS — "site built" completion email SENT to ${out.recipient} at ${out.sent_at} (audit workflow.owner_notified, ok:true).`,
  );
  process.exit(0);
}

if (!row) {
  console.log(
    `\n::notice:: no workflow.owner_notified audit row after ${ATTEMPTS} attempts — the build may not have reached the finalize/notify step, or no active org-member email exists.`,
  );
} else {
  console.log(`\n::notice:: completion email did NOT send (ok:false${out.send_error ? ' — ' + out.send_error : ''}).`);
}
if (STRICT) process.exit(1);
