// verify-delivery-email.mjs — GOLDEN-JOURNEY completion-email contract. Proves the "your site
// is live" delivery email was ACTUALLY sent to the org owner, from PLATFORM RECORDS — not the
// recipient's inbox. Closes the gap verify-delivery-completion.mjs (public render + AL-224 logo
// transparency) and verify-delivered-site-propagation.mjs (admin surfaces) both leave open.
//
// WHY audit_logs, not the notifications table: the completion email fires via SES inside the
// workflow's finalize step and is logged to the SITE AUDIT LOG as `workflow.owner_notified`
// with `{ ok, to (masked), trace_id }` (AL-360 — made the send outcome observable). The
// notifications table is NOT written on this path (see memory
// completion-email-fires-notifications-table-does-not) — so a notif-table check false-negatives;
// the audit row is the authoritative signal. A silent SES suppression logs `ok:false` here.
//
// Signal: audit_logs row action='workflow.owner_notified' for this site → metadata_json.ok === true.
// Tracking-mode by default (::notice, suite-safe); STRICT=1 → exit 1 on a missing row or ok:false.
// Fail-open (conditional-ci-gates): no CF auth in env ⇒ ::notice + exit 0.
//
// Usage: SITE_ID=<uuid> [DELIVERED_SLUG=<slug>] node e2e/admin-verify/verify-delivery-email.mjs
import { execFileSync } from 'node:child_process';

const SITE_ID = process.env.SITE_ID || '';
const SLUG = process.env.DELIVERED_SLUG || '';
if (!SITE_ID) {
  console.log('::error:: set SITE_ID (the delivered site UUID) — optionally DELIVERED_SLUG for the report');
  process.exit(2);
}
const STRICT = process.env.STRICT === '1';
const DB = process.env.PROD_D1 || 'project-sites-db-production';

// CF auth is required for `wrangler d1 --remote`. Absent ⇒ fail-open (mirrors verify-admin-cwv).
if (!process.env.CLOUDFLARE_API_KEY && !process.env.CLOUDFLARE_API_TOKEN) {
  console.log('::notice:: verify-delivery-email skipped — no CLOUDFLARE_API_KEY/TOKEN in env');
  process.exit(0);
}

// Parameterless LIKE on the UUID is safe here: SITE_ID is a UUID we control (not user input),
// and wrangler d1 has no bind flag for the inline --command path. Reject anything non-UUID-ish.
if (!/^[0-9a-f-]{8,40}$/i.test(SITE_ID)) {
  console.log('::error:: SITE_ID is not a UUID');
  process.exit(2);
}

const sql =
  `SELECT action, metadata_json, created_at FROM audit_logs ` +
  `WHERE action = 'workflow.owner_notified' AND metadata_json LIKE '%${SITE_ID}%' ` +
  `ORDER BY created_at DESC LIMIT 1`;

let row = null;
try {
  const raw = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  // wrangler --json prints `[{ results: [...], success, meta }]` (sometimes with a leading banner).
  const jsonStart = raw.indexOf('[');
  const parsed = JSON.parse(raw.slice(jsonStart));
  row = parsed?.[0]?.results?.[0] ?? null;
} catch (e) {
  console.log('::notice:: verify-delivery-email — D1 query failed:', String(e.message || e).slice(0, 120));
  if (STRICT) process.exit(1);
  process.exit(0);
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
    '\n::notice:: no workflow.owner_notified audit row yet for this site — the build may not have reached the finalize/notify step, or no active org-member email exists.',
  );
} else {
  console.log(`\n::notice:: completion email did NOT send (ok:false${out.send_error ? ' — ' + out.send_error : ''}).`);
}
if (STRICT) process.exit(1);
