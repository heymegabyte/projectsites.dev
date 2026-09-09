/**
 * AI Credits ledger. Every AI invocation debits 1 credit (configurable).
 * Topups are inserted via Stripe webhook or the manual `topup` endpoint.
 * Spend alerts are checked after each debit and notified via Resend.
 */
import { escapeHtml } from '@project-sites/shared';
import { sendEmail } from './notifications.js';
import type { Env } from '../types/env.js';

export const CREDIT_BUNDLES = {
  starter: { credits: 100, price_id: 'STRIPE_PRICE_CREDITS_100', usd: 5 },
  pro: { credits: 500, price_id: 'STRIPE_PRICE_CREDITS_500', usd: 20 },
  scale: { credits: 2000, price_id: 'STRIPE_PRICE_CREDITS_2000', usd: 70 },
} as const;
export type BundleKey = keyof typeof CREDIT_BUNDLES;

export async function getBalance(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM ai_credits_balance WHERE org_id = ?')
    .bind(orgId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

/** Atomically debit credits + insert a ledger row. Returns new balance. */
export async function debitCredits(
  env: Env,
  opts: { orgId: string; siteId?: string; amount: number; reason: string; aiLogId?: string },
): Promise<number> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_credits_balance (org_id, balance, lifetime_consumed, updated_at)
       VALUES (?, -?, ?, datetime('now'))
       ON CONFLICT(org_id) DO UPDATE SET
         balance = balance - ?, lifetime_consumed = lifetime_consumed + ?, updated_at = datetime('now')`,
    ).bind(opts.orgId, opts.amount, opts.amount, opts.amount, opts.amount),
    env.DB.prepare(
      `INSERT INTO ai_credits_ledger (id, org_id, site_id, delta, reason, ai_log_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, opts.orgId, opts.siteId ?? null, -opts.amount, opts.reason, opts.aiLogId ?? null),
  ]);
  const fresh = await getBalance(env, opts.orgId);
  return fresh;
}

export async function topupCredits(
  env: Env,
  opts: { orgId: string; amount: number; stripeSessionId?: string; reason?: string },
): Promise<number> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_credits_balance (org_id, balance, lifetime_purchased, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(org_id) DO UPDATE SET
         balance = balance + ?, lifetime_purchased = lifetime_purchased + ?, updated_at = datetime('now')`,
    ).bind(opts.orgId, opts.amount, opts.amount, opts.amount, opts.amount),
    env.DB.prepare(
      `INSERT INTO ai_credits_ledger (id, org_id, delta, reason, stripe_session_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, opts.orgId, opts.amount, opts.reason ?? 'topup', opts.stripeSessionId ?? null),
  ]);
  return getBalance(env, opts.orgId);
}

export interface SpendAlertRow {
  id: string;
  name: string;
  threshold_credits: number;
  trigger_type: string;
  email: string;
  last_fired_at: string | null;
}

/** Check alerts after a debit; fire-and-forget Resend if any trip. */
export async function maybeFireAlerts(env: Env, orgId: string, newBalance: number): Promise<void> {
  // Schema truth (prod D1 `spend_alerts`): trigger_type / email / last_fired_at,
  // soft-deleted via deleted_at. There is NO `alert_kind` / `notify_email` /
  // `enabled` / `last_triggered_at` column — reading those errored ("no such
  // column") so this whole function threw and alerts NEVER fired. Trigger enum
  // matches createSpendAlertSchema: balance_below / monthly_spend_above / rate_spike.
  const alerts = await env.DB.prepare(
    `SELECT id, name, threshold_credits, trigger_type, email, last_fired_at
     FROM spend_alerts WHERE org_id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId)
    .all<SpendAlertRow>();
  if (!alerts.results?.length) return;
  for (const a of alerts.results) {
    let shouldFire = false;
    if (a.trigger_type === 'balance_below' && newBalance <= a.threshold_credits) shouldFire = true;
    if (a.trigger_type === 'rate_spike' || a.trigger_type === 'monthly_spend_above') {
      // rate_spike ≈ today's burn; monthly_spend_above ≈ calendar-month spend.
      const since =
        a.trigger_type === 'monthly_spend_above'
          ? `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`
          : `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
      const row = await env.DB.prepare(
        `SELECT COALESCE(SUM(-delta), 0) AS spent FROM ai_credits_ledger
         WHERE org_id = ? AND delta < 0 AND created_at >= ?`,
      )
        .bind(orgId, since)
        .first<{ spent: number }>();
      if ((row?.spent ?? 0) >= a.threshold_credits) shouldFire = true;
    }
    if (!shouldFire) continue;
    // Throttle to once per 12h.
    if (a.last_fired_at) {
      const lastMs = Date.parse(a.last_fired_at);
      if (Date.now() - lastMs < 12 * 60 * 60 * 1000) continue;
    }
    await env.DB.prepare(
      `UPDATE spend_alerts SET last_fired_at = datetime('now'), fire_count = fire_count + 1 WHERE id = ?`,
    )
      .bind(a.id)
      .run();
    // ADR-0019: billing alerts route through the central SES seam
    // (`sendEmail`, SES-primary). The seam is html-only, so wrap the plain-text
    // alert in an escaped <pre> block. Fire-and-forget — never blocks the debit.
    const subject = `Project Sites spend alert: ${a.name}`;
    const text = `Alert "${a.name}" triggered.\nKind: ${a.trigger_type}\nThreshold: ${a.threshold_credits}\nCurrent balance: ${newBalance}\n\nManage alerts: https://projectsites.dev/admin/billing`;
    await sendEmail(env, {
      to: a.email,
      subject,
      html: `<pre>${escapeHtml(text)}</pre>`,
      category: 'billing-alert',
    }).catch(() => {});
  }
}
