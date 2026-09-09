/**
 * @module services/weekly_digest
 * @description Weekly summary digest emailed every Monday at 14:00 UTC (item #96).
 *
 * For each non-opted-out org we:
 * 1. Roll up the last 7 days of activity (sites updated, form submissions,
 *    AI traces, errors, top 3 referrers).
 * 2. Render a self-contained HTML email using the brand colors
 *    `#00E5FF` and `#060610` — no external template engine.
 * 3. Send via the central SES-primary seam in
 *    {@link ../services/notifications.ts | notifications.ts} (Resend removed 2026-09-09).
 * 4. Insert a row in `weekly_digest_sent` keyed by `(org_id, week_iso)` so a
 *    re-run inside the same ISO week becomes a no-op.
 *
 * The cron handler in `src/index.ts` invokes {@link sendWeeklyDigestsForAllOrgs}
 * on the `0 14 * * 1` schedule.
 *
 * @packageDocumentation
 */

import { escapeHtml } from '@project-sites/shared';
import { dbQuery, dbQueryOne, dbInsert } from './db.js';
import { getEmailProvider } from '../platform/email-router.js';
import { sendEmail } from './notifications.js';
import type { Env } from '../types/env.js';

/**
 * Brand colors — kept inline so the email renders even if a downstream provider
 * strips `<style>` blocks.
 */
const BRAND_BG = '#060610';
const BRAND_ACCENT = '#00E5FF';
const BRAND_TEXT_PRIMARY = '#e2e8f0';
const BRAND_TEXT_SECONDARY = '#94a3b8';

/** Per-org weekly metrics roll-up. */
export interface WeeklyMetrics {
  sites_updated: number;
  form_submissions: number;
  ai_traces: number;
  errors: number;
  top_referrers: { referrer: string; count: number }[];
}

/** Compute the ISO-8601 week string for a given date (e.g. `"2026-W21"`). */
export function isoWeekString(d: Date = new Date()): string {
  // Copy date so we don't mutate the input.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Set to Thursday in current week — ISO 8601 weeks always contain a Thursday.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Org row needed for digest dispatch. */
interface DigestOrgRow {
  id: string;
  name: string;
  digest_opt_out: number;
}

/** User row for digest recipient lookup. */
interface OwnerRow {
  email: string | null;
}

/**
 * Compute weekly metrics for an org. Each query is independent and degrades
 * gracefully — a single missing table never blocks the digest from sending.
 *
 * @param db    - D1 binding.
 * @param orgId - Organization UUID.
 *
 * @example
 * ```ts
 * const metrics = await computeWeeklyMetrics(env.DB, orgId);
 * console.warn(`Sites updated: ${metrics.sites_updated}`);
 * ```
 */
export async function computeWeeklyMetrics(db: D1Database, orgId: string): Promise<WeeklyMetrics> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Sites updated (excludes soft-deleted).
  const sitesRow = await dbQueryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sites
     WHERE org_id = ? AND deleted_at IS NULL AND updated_at >= ?`,
    [orgId, sevenDaysAgo],
  );

  // Form submissions: count audit log rows tagged form.submission for this org.
  const formsRow = await dbQueryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM audit_logs
     WHERE org_id = ? AND action LIKE 'form.%' AND created_at >= ?`,
    [orgId, sevenDaysAgo],
  );

  // AI traces: audit action LIKE 'ai.%' (covers ai.chat, ai.run, ai.endpoint.*).
  const aiRow = await dbQueryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM audit_logs
     WHERE org_id = ? AND action LIKE 'ai.%' AND created_at >= ?`,
    [orgId, sevenDaysAgo],
  );

  // Error traces — audit action ending in 'failed' or starting with 'error.'.
  const errRow = await dbQueryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM audit_logs
     WHERE org_id = ?
       AND (action LIKE '%.failed' OR action LIKE 'error.%')
       AND created_at >= ?`,
    [orgId, sevenDaysAgo],
  );

  // Top 3 referrers: best-effort scan of audit metadata for `"referrer":"..."`.
  // Returns empty array on any failure — never block the email.
  let topReferrers: { referrer: string; count: number }[] = [];
  try {
    const referrerRows = await dbQuery<{ metadata_json: string | null }>(
      db,
      `SELECT metadata_json FROM audit_logs
       WHERE org_id = ? AND created_at >= ? AND metadata_json LIKE '%referrer%'
       LIMIT 500`,
      [orgId, sevenDaysAgo],
    );
    const counts = new Map<string, number>();
    for (const row of referrerRows.data) {
      if (!row.metadata_json) continue;
      try {
        const parsed = JSON.parse(row.metadata_json) as { referrer?: unknown };
        if (typeof parsed.referrer === 'string' && parsed.referrer.length > 0) {
          counts.set(parsed.referrer, (counts.get(parsed.referrer) ?? 0) + 1);
        }
      } catch {
        // ignore malformed JSON
      }
    }
    topReferrers = [...counts.entries()]
      .map(([referrer, count]) => ({ referrer, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  } catch {
    topReferrers = [];
  }

  return {
    sites_updated: sitesRow?.n ?? 0,
    form_submissions: formsRow?.n ?? 0,
    ai_traces: aiRow?.n ?? 0,
    errors: errRow?.n ?? 0,
    top_referrers: topReferrers,
  };
}

/**
 * Render the HTML body for the weekly digest. Self-contained — no template
 * helpers, no external CSS. Uses brand colors `#00E5FF` accent and `#060610`
 * background.
 *
 * @example
 * ```ts
 * const html = renderDigestHtml({
 *   orgName: 'Acme', metrics, unsubscribeUrl: 'https://...',
 * });
 * ```
 */
export function renderDigestHtml(opts: {
  orgName: string;
  weekIso: string;
  metrics: WeeklyMetrics;
  unsubscribeUrl: string;
  dashboardUrl: string;
}): string {
  const { orgName, weekIso, metrics, unsubscribeUrl, dashboardUrl } = opts;
  const referrerRows = metrics.top_referrers.length
    ? metrics.top_referrers
        .map(
          (r) =>
            `<li style="margin:4px 0;color:${BRAND_TEXT_SECONDARY};">${escapeHtml(r.referrer)} <span style="color:${BRAND_ACCENT};">— ${r.count}</span></li>`,
        )
        .join('')
    : `<li style="color:${BRAND_TEXT_SECONDARY};">No referrers tracked this week.</li>`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Digest — ${escapeHtml(orgName)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND_TEXT_PRIMARY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_BG};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
      style="background:#0d0d20;border:1px solid rgba(0,229,255,0.18);border-radius:14px;max-width:600px;width:100%;">
      <tr><td style="padding:28px 32px 8px;">
        <div style="font-size:12px;color:${BRAND_ACCENT};letter-spacing:2px;text-transform:uppercase;font-weight:600;">Weekly Digest · ${escapeHtml(weekIso)}</div>
        <h1 style="margin:8px 0 0;font-size:24px;color:${BRAND_TEXT_PRIMARY};">${escapeHtml(orgName)}</h1>
      </td></tr>
      <tr><td style="padding:16px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
          ${metricRow('Sites updated', metrics.sites_updated)}
          ${metricRow('Form submissions', metrics.form_submissions)}
          ${metricRow('AI traces', metrics.ai_traces)}
          ${metricRow('Errors', metrics.errors)}
        </table>
      </td></tr>
      <tr><td style="padding:24px 32px 0;">
        <div style="font-size:12px;color:${BRAND_ACCENT};letter-spacing:1.5px;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Top referrers</div>
        <ul style="list-style:none;padding:0;margin:0;font-size:14px;">${referrerRows}</ul>
      </td></tr>
      <tr><td style="padding:28px 32px;">
        <a href="${escapeHtml(dashboardUrl)}"
          style="display:inline-block;padding:12px 24px;background:${BRAND_ACCENT};color:${BRAND_BG};font-weight:700;text-decoration:none;border-radius:8px;">
          Open dashboard →
        </a>
      </td></tr>
      <tr><td style="padding:0 32px 24px;border-top:1px solid rgba(255,255,255,0.06);">
        <p style="font-size:11px;color:${BRAND_TEXT_SECONDARY};margin:16px 0 0;line-height:1.5;">
          You're receiving this because you own a Project Sites organization.
          <a href="${escapeHtml(unsubscribeUrl)}" style="color:${BRAND_ACCENT};">Unsubscribe in one click</a>.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function metricRow(label: string, value: number): string {
  return `<tr><td style="padding:6px 0;font-size:14px;color:${BRAND_TEXT_SECONDARY};">${escapeHtml(label)}</td>
    <td style="padding:6px 0;font-size:18px;color:${BRAND_TEXT_PRIMARY};text-align:right;font-weight:700;">${value.toLocaleString()}</td></tr>`;
}

/**
 * HMAC-SHA256 hex digest helper used for the one-click unsubscribe token.
 * Matches the signing scheme in {@link signUnsubscribeToken}.
 */
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sign a one-click unsubscribe token tied to an org. Encodes as
 * `<orgId>.<signature>` so the verify endpoint can recover the org id
 * without a database round-trip on the URL.
 *
 * @example
 * ```ts
 * const token = await signUnsubscribeToken('org-1', env.WEEKLY_DIGEST_SECRET!);
 * const url = `https://projectsites.dev/api/email/unsubscribe?token=${token}`;
 * ```
 */
export async function signUnsubscribeToken(orgId: string, secret: string): Promise<string> {
  const sig = await hmacHex(secret, orgId);
  return `${orgId}.${sig}`;
}

/**
 * Verify an unsubscribe token. Returns the org id if valid, `null` otherwise.
 *
 * @example
 * ```ts
 * const orgId = await verifyUnsubscribeToken(token, env.WEEKLY_DIGEST_SECRET!);
 * if (!orgId) return c.text('Invalid token', 400);
 * ```
 */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
): Promise<string | null> {
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const orgId = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = await hmacHex(secret, orgId);
  // Constant-time-ish compare via length check + char loop.
  if (expected.length !== sig.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return mismatch === 0 ? orgId : null;
}

/**
 * Send the digest to a single org.
 *
 * Idempotency: writes a row into `weekly_digest_sent` keyed by
 * `(org_id, week_iso)`. On UNIQUE-constraint violation the insert short-
 * circuits and the email is not re-sent.
 *
 * @returns `{ sent: true }` when an email is dispatched, otherwise an object
 *   with a `reason` string explaining the skip (`already_sent`, `opted_out`,
 *   `no_owner_email`, `no_provider`).
 *
 * @example
 * ```ts
 * const result = await sendWeeklyDigestForOrg(env, env.DB, { id, name, digest_opt_out: 0 });
 * if (result.sent) console.warn('sent');
 * ```
 */
export async function sendWeeklyDigestForOrg(
  env: Env,
  db: D1Database,
  org: DigestOrgRow,
  now: Date = new Date(),
): Promise<{ sent: boolean; reason?: string }> {
  if (org.digest_opt_out === 1) {
    return { sent: false, reason: 'opted_out' };
  }

  const weekIso = isoWeekString(now);

  // Idempotency check.
  const existing = await dbQueryOne<{ id: string }>(
    db,
    'SELECT id FROM weekly_digest_sent WHERE org_id = ? AND week_iso = ?',
    [org.id, weekIso],
  );
  if (existing) {
    return { sent: false, reason: 'already_sent' };
  }

  // Resolve owner email — first user joined to the org as owner.
  const owner = await dbQueryOne<OwnerRow>(
    db,
    `SELECT u.email AS email FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL
       AND u.deleted_at IS NULL AND u.email IS NOT NULL
     ORDER BY m.created_at ASC LIMIT 1`,
    [org.id],
  );
  if (!owner?.email) {
    return { sent: false, reason: 'no_owner_email' };
  }

  const metrics = await computeWeeklyMetrics(db, org.id);

  // Token for one-click unsubscribe. Fall back to a non-secret signed token
  // (org id only) when no secret is configured — still useful for opt-out.
  const secret = env.WEEKLY_DIGEST_SECRET ?? env.STRIPE_WEBHOOK_SECRET ?? 'weekly-digest-fallback';
  const token = await signUnsubscribeToken(org.id, secret);
  const unsubscribeUrl = `https://projectsites.dev/api/email/unsubscribe?token=${encodeURIComponent(
    token,
  )}`;
  const dashboardUrl = 'https://projectsites.dev/admin';
  const html = renderDigestHtml({
    orgName: org.name,
    weekIso,
    metrics,
    unsubscribeUrl,
    dashboardUrl,
  });

  // ADR-0019 Resend→SES: SES is the PRIMARY rail when configured. The digest is a
  // single-recipient lifecycle email, so it goes through the transactional seam
  // (Listmonk's MarketingEmailProvider only does campaigns, not single sends). The
  // List-Unsubscribe one-click headers ride through SES Content.Simple.Headers.
  // Resend removed 2026-09-09; when SES creds are absent, the else-branch routes
  // through the central SES→SendGrid seam (`sendEmail`).
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.SES_FROM_EMAIL) {
    try {
      await getEmailProvider(env).sendTransactional({
        // A weekly digest is a SINGLE personalized per-owner send, not a bulk
        // campaign — sendTransactional rejects bulk kinds (lifecycle/newsletter/
        // campaign), and Listmonk's MarketingEmailProvider only does campaigns,
        // not single sends. So it rides the transactional rail; the List-Unsubscribe
        // headers below keep it one-click-unsubscribe compliant.
        kind: 'transactional',
        from: 'Project Sites <noreply@projectsites.dev>',
        to: owner.email,
        subject: `Weekly digest · ${org.name}`,
        html,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'weekly_digest',
          message: 'ses failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { sent: false, reason: 'ses_error' };
    }
  } else {
    // ADR-0019 Resend→SES: Resend removed 2026-09-09 (Brian directive). When AWS
    // SES creds aren't present in env, route through the central SES-primary seam
    // (`sendEmail`, SES → SendGrid break-glass; Resend already removed from it). The
    // List-Unsubscribe one-click headers the inline SES path set aren't modeled by
    // the shared seam — the transactional rail applies its own compliance headers.
    try {
      await sendEmail(env, {
        to: owner.email,
        subject: `Weekly digest · ${org.name}`,
        html,
        category: 'transactional',
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'weekly_digest',
          message: 'send failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { sent: false, reason: 'send_error' };
    }
  }

  // Idempotency row — insert AFTER the send succeeds so a transient provider
  // outage doesn't permanently lock out a retry. The UNIQUE constraint on
  // (org_id, week_iso) still prevents double-sends within the same cron run.
  await dbInsert(db, 'weekly_digest_sent', {
    id: crypto.randomUUID(),
    org_id: org.id,
    week_iso: weekIso,
    sent_at: now.toISOString(),
    opens_count: 0,
    recipient_email: owner.email,
  });

  return { sent: true };
}

/**
 * Cron entrypoint — iterates every non-soft-deleted org and dispatches the
 * weekly digest. Soft-fails per org so one bad row never blocks the batch.
 *
 * @example
 * ```ts
 * // From src/index.ts scheduled handler:
 * if (event.cron === '0 14 * * 1') {
 *   await sendWeeklyDigestsForAllOrgs(env);
 * }
 * ```
 */
export async function sendWeeklyDigestsForAllOrgs(
  env: Env,
  now: Date = new Date(),
): Promise<{ total: number; sent: number; skipped: number; failed: number }> {
  const db = env.DB;
  const orgsResult = await dbQuery<DigestOrgRow>(
    db,
    `SELECT id, name, digest_opt_out FROM orgs WHERE deleted_at IS NULL`,
    [],
  );
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const org of orgsResult.data) {
    try {
      const result = await sendWeeklyDigestForOrg(env, db, org, now);
      if (result.sent) sent += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'weekly_digest',
          message: 'org digest failed',
          org_id: org.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return { total: orgsResult.data.length, sent, skipped, failed };
}
