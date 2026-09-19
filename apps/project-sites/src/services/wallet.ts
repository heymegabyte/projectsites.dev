/**
 * @module services/wallet
 * @description Stripe wallet billing system (sibling #100).
 *
 * Business model:
 *   1. Org subscribes to a $50/mo Stripe Subscription (SetupIntent collects the
 *      default PM at checkout time).
 *   2. Every `invoice.paid` webhook credits `monthly_credit_cents` (default $50)
 *      to `wallet_accounts.balance_cents` via {@link creditWallet}.
 *   3. Every chargeable action (domain register, container minute, AI token,
 *      image gen, snapshot, etc) calls {@link chargeWallet} which:
 *        - looks up the category, computes `base_cost × quantity × markup_factor`
 *          (caller may override `base_cost_cents` for variable-cost categories
 *          like domain TLD pricing — markup_factor still applied from D1)
 *        - debits the wallet atomically (D1 UPDATE...WHERE balance_cents >= amount)
 *        - writes an audit row into `wallet_transactions`
 *   4. When balance drops below `auto_topup_threshold_cents` (default $5), an
 *      async PaymentIntent fires against the stored default PM and credits
 *      `auto_topup_amount_cents` (default $50) on success.
 *
 * Module shape (export contract) is consumed by `wallet_adapter.ts`:
 *   chargeWallet, creditWallet, getWalletState, startSubscription, topUpWallet
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { dbQuery, dbQueryOne, dbInsert, dbUpdate } from './db.js';
import { badRequest, internalError } from '@project-sites/shared';

// ─── Public types ───────────────────────────────────────────────────────────

export type WalletSubscriptionStatus = 'none' | 'active' | 'past_due' | 'canceled' | 'trialing';

export interface WalletTransaction {
  id: string;
  created_at: string;
  category: string;
  amount_cents: number;
  reference_type: string | null;
  reference_id: string | null;
  direction: 'debit' | 'credit';
}

export interface WalletState {
  balance_cents: number;
  subscription_status: WalletSubscriptionStatus;
  default_payment_method_brand: string | null;
  default_payment_method_last4: string | null;
  last_topup_at: string | null;
  monthly_credit_remaining_days: number | null;
  recent_transactions: WalletTransaction[];
}

export interface ChargeWalletParams {
  category: string;
  quantity: number;
  base_cost_cents?: number; // override cost for variable categories
  reference_type: string;
  reference_id: string;
  metadata?: Record<string, unknown>;
}

export type WalletChargeResult =
  | {
      ok: true;
      transaction_id: string;
      charged_cents: number;
      balance_after_cents: number;
    }
  | {
      ok: false;
      reason: 'insufficient' | 'error';
      balance_cents?: number;
      message?: string;
    };

export interface CreditWalletParams {
  amount_cents: number;
  reason: string;
  reference_type: string;
  reference_id: string;
  metadata?: Record<string, unknown>;
  stripe_event_id?: string;
}

export interface StartSubscriptionResult {
  ok: boolean;
  checkout_url?: string;
  message?: string;
}

export interface TopUpResult {
  ok: boolean;
  state?: WalletState;
  message?: string;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface WalletRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_default_payment_method: string | null;
  subscription_status: string;
  balance_cents: number;
  auto_topup_threshold_cents: number;
  auto_topup_amount_cents: number;
  monthly_credit_cents: number;
  last_topup_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CostCategory {
  slug: string;
  label: string;
  unit: string;
  base_cost_cents: number;
  markup_factor: number;
  min_charge_cents: number;
  billable: number;
}

/**
 * Get-or-create the wallet row for an org. New wallets start inactive with
 * zero balance and the default $5/$50 auto-topup thresholds.
 */
async function ensureWalletRow(env: Env, orgId: string): Promise<WalletRow> {
  const existing = await dbQueryOne<WalletRow>(
    env.DB,
    `SELECT * FROM wallet_accounts WHERE org_id = ? LIMIT 1`,
    [orgId],
  );
  if (existing) return existing;
  const id = crypto.randomUUID();
  const { error: createErr } = await dbInsert(env.DB, 'wallet_accounts', {
    id,
    org_id: orgId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_default_payment_method: null,
    subscription_status: 'inactive',
    balance_cents: 0,
    auto_topup_threshold_cents: 500,
    auto_topup_amount_cents: 5000,
    monthly_credit_cents: 5000,
    last_topup_at: null,
  });
  if (createErr) throw internalError(`Failed to create wallet account: ${createErr}`);
  const created = await dbQueryOne<WalletRow>(
    env.DB,
    `SELECT * FROM wallet_accounts WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!created) throw new Error('Failed to create wallet');
  return created;
}

/**
 * Compensating balance write, used when a `wallet_transactions` ledger INSERT
 * fails AFTER `wallet_accounts.balance_cents` was already mutated. Applies
 * `deltaCents` (signed) so the balance is restored to what it was before the
 * doomed mutation — keeping the account balance consistent with the (now
 * absent) ledger row. Best-effort: a failure here is a rare double-fault that
 * needs manual reconciliation, so it is logged at error level (never swallowed
 * silently) before the caller re-throws the original ledger error.
 *
 * @param env - Worker env (needs `DB`).
 * @param walletId - `wallet_accounts.id` to compensate.
 * @param deltaCents - signed reversal amount (e.g. `+amount` to undo a debit,
 *   `-amount` to undo a credit/adjustment).
 * @param context - short tag for the log line (`debit` | `credit` | `adjustment`).
 * @remarks Impure — writes D1 + logs.
 */
async function reverseBalance(
  env: Env,
  walletId: string,
  deltaCents: number,
  context: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE wallet_accounts
          SET balance_cents = balance_cents + ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
      .bind(deltaCents, walletId)
      .run();
  } catch (e) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'wallet',
        message: 'balance_reversal_failed',
        context,
        wallet_id: walletId,
        delta_cents: deltaCents,
        err: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

async function loadCategory(env: Env, slug: string): Promise<CostCategory | null> {
  return dbQueryOne<CostCategory>(
    env.DB,
    `SELECT slug, label, unit, base_cost_cents, markup_factor, min_charge_cents, billable
       FROM cost_categories WHERE slug = ? LIMIT 1`,
    [slug],
  );
}

function mapStatus(s: string): WalletSubscriptionStatus {
  if (s === 'active' || s === 'past_due' || s === 'canceled' || s === 'trialing') return s;
  return 'none';
}

async function getOrCreateStripeCustomer(
  env: Env,
  wallet: WalletRow,
  email: string,
): Promise<string> {
  if (wallet.stripe_customer_id) return wallet.stripe_customer_id;
  const r = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      email,
      'metadata[org_id]': wallet.org_id,
      'metadata[wallet_id]': wallet.id,
    }),
  });
  if (!r.ok) throw badRequest(`Stripe customer creation failed: ${await r.text()}`);
  const c = (await r.json()) as { id: string };
  const { error: linkErr } = await dbUpdate(
    env.DB,
    'wallet_accounts',
    { stripe_customer_id: c.id },
    'id = ?',
    [wallet.id],
  );
  // The Stripe customer already exists (no idempotency key on the create above), so
  // throwing here would make a caller retry → a DUPLICATE customer. Log the lost link
  // for reconciliation instead; the id is still returned + usable for this request.
  if (linkErr) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'wallet',
        message: 'stripe_customer_link_write_failed',
        wallet_id: wallet.id,
        stripe_customer_id: c.id,
        error: linkErr,
      }),
    );
  }
  return c.id;
}

// ─── Public API (matches wallet_adapter contract) ──────────────────────────

/**
 * Read the wallet's current state including recent transactions, PM brand/last4,
 * and days remaining in the current $50/mo credit window.
 */
export async function getWalletState(env: Env, orgId: string): Promise<WalletState> {
  const wallet = await ensureWalletRow(env, orgId);
  const { data: recent } = await dbQuery<{
    id: string;
    created_at: string;
    category_slug: string | null;
    amount_cents: number;
    reference_type: string | null;
    reference_id: string | null;
    direction: string;
  }>(
    env.DB,
    `SELECT id, created_at, category_slug, amount_cents, reference_type, reference_id, direction
       FROM wallet_transactions
       WHERE org_id = ?
       ORDER BY created_at DESC LIMIT 25`,
    [orgId],
  );

  // Best-effort PM brand/last4 via Stripe (silent on failure — never blocks UI).
  let pmBrand: string | null = null;
  let pmLast4: string | null = null;
  if (wallet.stripe_default_payment_method && env.STRIPE_SECRET_KEY) {
    try {
      const r = await fetch(
        `https://api.stripe.com/v1/payment_methods/${wallet.stripe_default_payment_method}`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      if (r.ok) {
        const pm = (await r.json()) as { card?: { brand?: string; last4?: string } };
        pmBrand = pm.card?.brand ?? null;
        pmLast4 = pm.card?.last4 ?? null;
      }
    } catch {
      /* swallow */
    }
  }

  // Days remaining in current 30-day credit window.
  let remaining: number | null = null;
  if (wallet.last_topup_at) {
    const elapsed = (Date.now() - new Date(wallet.last_topup_at).getTime()) / 86_400_000;
    remaining = Math.max(0, Math.ceil(30 - elapsed));
  }

  return {
    balance_cents: wallet.balance_cents,
    subscription_status: mapStatus(wallet.subscription_status),
    default_payment_method_brand: pmBrand,
    default_payment_method_last4: pmLast4,
    last_topup_at: wallet.last_topup_at,
    monthly_credit_remaining_days: remaining,
    recent_transactions: recent.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      category: r.category_slug ?? r.reference_type ?? 'unknown',
      amount_cents: r.amount_cents,
      reference_type: r.reference_type,
      reference_id: r.reference_id,
      direction: r.direction === 'credit' ? 'credit' : 'debit',
    })),
  };
}

/**
 * Start a Stripe Checkout session for the $50/mo wallet subscription. The
 * SetupIntent at checkout captures the default PM used for later auto-topups.
 */
export async function startSubscription(
  env: Env,
  orgId: string,
  opts: { success_url: string; cancel_url: string; email?: string },
): Promise<StartSubscriptionResult> {
  if (!env.STRIPE_PRICE_ID_MONTHLY_WALLET) {
    return {
      ok: false,
      message:
        'Wallet subscription not configured — set STRIPE_PRICE_ID_MONTHLY_WALLET secret. Create the Price at https://dashboard.stripe.com/products (recurring $50/month).',
    };
  }
  const wallet = await ensureWalletRow(env, orgId);

  // Resolve customer email: explicit > org owner > skip.
  let email = opts.email;
  if (!email) {
    const owner = await dbQueryOne<{ email: string }>(
      env.DB,
      `SELECT u.email FROM users u
         JOIN memberships m ON m.user_id = u.id
         WHERE m.org_id = ? AND m.deleted_at IS NULL
         ORDER BY m.created_at ASC LIMIT 1`,
      [orgId],
    );
    email = owner?.email ?? 'wallet@projectsites.dev';
  }
  const customerId = await getOrCreateStripeCustomer(env, wallet, email);

  const params = new URLSearchParams({
    mode: 'subscription',
    customer: customerId,
    success_url: opts.success_url,
    cancel_url: opts.cancel_url,
    'payment_method_types[0]': 'card',
    'payment_method_types[1]': 'link',
    'line_items[0][price]': env.STRIPE_PRICE_ID_MONTHLY_WALLET,
    'line_items[0][quantity]': '1',
    payment_method_collection: 'always',
    'subscription_data[metadata][org_id]': orgId,
    'subscription_data[metadata][wallet_id]': wallet.id,
    'metadata[org_id]': orgId,
    'metadata[wallet_id]': wallet.id,
    'metadata[purpose]': 'wallet_subscription',
  });

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!r.ok) return { ok: false, message: `Stripe checkout failed: ${await r.text()}` };
  const session = (await r.json()) as { url: string };
  return { ok: true, checkout_url: session.url };
}

/**
 * Charge the wallet for a billable action.
 *
 * Atomicity: conditional UPDATE only mutates the row when balance_cents >= amount,
 * so two concurrent charges can never push the balance negative.
 *
 * Variable-cost: callers may pass `base_cost_cents` to override the catalog
 * default (e.g. per-TLD domain pricing). markup_factor always comes from D1
 * so super-admin tuning is authoritative.
 *
 * Auto-topup: when post-debit balance drops below the threshold, a top-up
 * PaymentIntent fires in the background (caller doesn't await it).
 */
export async function chargeWallet(
  env: Env,
  orgId: string,
  params: ChargeWalletParams,
): Promise<WalletChargeResult> {
  const wallet = await ensureWalletRow(env, orgId);
  const cat = await loadCategory(env, params.category);
  if (!cat) return { ok: false, reason: 'error', message: `unknown category: ${params.category}` };
  if (!cat.billable) return { ok: false, reason: 'error', message: 'category disabled' };
  if (wallet.subscription_status !== 'active') {
    return {
      ok: false,
      reason: 'error',
      balance_cents: wallet.balance_cents,
      message: 'wallet_subscription_inactive',
    };
  }

  const baseCost = params.base_cost_cents ?? cat.base_cost_cents;
  const raw = baseCost * params.quantity * cat.markup_factor;
  const amount = Math.max(cat.min_charge_cents, Math.ceil(raw));

  const res = await env.DB.prepare(
    `UPDATE wallet_accounts
        SET balance_cents = balance_cents - ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND balance_cents >= ?`,
  )
    .bind(amount, wallet.id, amount)
    .run();

  if (!res.success || (res.meta?.changes ?? 0) === 0) {
    // Fire auto-topup if we have a stored PM. Caller still gets insufficient.
    if (wallet.stripe_default_payment_method) {
      topUpWallet(
        env,
        orgId,
        wallet.auto_topup_amount_cents,
        autoTopupIdempotencyKey(wallet.id),
      ).catch((e) => {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'wallet',
            message: 'auto_topup_failed',
            org_id: orgId,
            err: e instanceof Error ? e.message : String(e),
          }),
        );
      });
    }
    return {
      ok: false,
      reason: 'insufficient',
      balance_cents: wallet.balance_cents,
      message: `insufficient: have ${wallet.balance_cents}¢, need ${amount}¢`,
    };
  }

  const newBalance = wallet.balance_cents - amount;
  const txId = crypto.randomUUID();
  const { error: ledgerErr } = await dbInsert(env.DB, 'wallet_transactions', {
    id: txId,
    wallet_id: wallet.id,
    org_id: orgId,
    direction: 'debit',
    category_slug: cat.slug,
    quantity: params.quantity,
    base_cost_cents: baseCost,
    markup_factor: cat.markup_factor,
    amount_cents: -amount,
    balance_after_cents: newBalance,
    reference_type: params.reference_type,
    reference_id: params.reference_id,
    stripe_event_id: null,
    metadata_json: params.metadata ? JSON.stringify(params.metadata) : null,
    created_by: null,
  });
  if (ledgerErr) {
    // Ledger write failed AFTER the balance was debited — reverse the debit so
    // the user is not charged for an operation with no ledger record (a retry
    // would otherwise double-charge), then surface the failure.
    await reverseBalance(env, wallet.id, amount, 'debit');
    throw internalError(`Failed to record wallet debit: ${ledgerErr}`);
  }

  if (newBalance < wallet.auto_topup_threshold_cents && wallet.stripe_default_payment_method) {
    topUpWallet(
      env,
      orgId,
      wallet.auto_topup_amount_cents,
      autoTopupIdempotencyKey(wallet.id),
    ).catch((e) => {
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'wallet',
          message: 'auto_topup_after_debit_failed',
          org_id: orgId,
          err: e instanceof Error ? e.message : String(e),
        }),
      );
    });
  }

  return {
    ok: true,
    transaction_id: txId,
    charged_cents: amount,
    balance_after_cents: newBalance,
  };
}

/**
 * Credit the wallet (positive amount). Idempotent on `stripe_event_id` so
 * replayed Stripe webhooks are harmless.
 */
export async function creditWallet(
  env: Env,
  orgId: string,
  params: CreditWalletParams,
): Promise<void> {
  if (params.stripe_event_id) {
    const dup = await dbQueryOne<{ id: string }>(
      env.DB,
      `SELECT id FROM wallet_transactions WHERE stripe_event_id = ? LIMIT 1`,
      [params.stripe_event_id],
    );
    if (dup) return;
  }
  const wallet = await ensureWalletRow(env, orgId);
  await env.DB.prepare(
    `UPDATE wallet_accounts
        SET balance_cents = balance_cents + ?,
            last_topup_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  )
    .bind(params.amount_cents, wallet.id)
    .run();
  const newBalance = wallet.balance_cents + params.amount_cents;
  const txId = crypto.randomUUID();
  const { error: ledgerErr } = await dbInsert(env.DB, 'wallet_transactions', {
    id: txId,
    wallet_id: wallet.id,
    org_id: orgId,
    direction: 'credit',
    category_slug: null,
    quantity: null,
    base_cost_cents: null,
    markup_factor: null,
    amount_cents: params.amount_cents,
    balance_after_cents: newBalance,
    reference_type: params.reference_type,
    reference_id: params.reference_id,
    stripe_event_id: params.stripe_event_id ?? null,
    metadata_json: JSON.stringify({ reason: params.reason, ...(params.metadata ?? {}) }),
    created_by: null,
  });
  if (ledgerErr) {
    // Reverse THIS delivery's balance add so the balance never diverges from the ledger.
    await reverseBalance(env, wallet.id, -params.amount_cents, 'credit');
    // A UNIQUE(stripe_event_id) violation (migration 0635) means a concurrent delivery
    // already recorded this exact credit — the reverse above leaves exactly ONE credit, so
    // this is a successful DB-level dedupe, NOT a failure. Return cleanly (idempotent no-op)
    // rather than throw a spurious webhook failure. Any OTHER insert error still fails loud
    // (reversed + thrown) so the Stripe webhook retries.
    if (params.stripe_event_id && /unique constraint|constraint failed/i.test(ledgerErr)) {
      return;
    }
    throw internalError(`Failed to record wallet credit: ${ledgerErr}`);
  }
}

/**
 * Stable idempotency key for an AUTO-topup charge: the same wallet within the same
 * ~5-minute bucket ⇒ the same key ⇒ Stripe collapses duplicate create requests to ONE
 * real card charge (24h idempotency window). This is what stops a double-click or two
 * racing `chargeWallet` calls from each firing a separate off-session charge.
 *
 * @param walletId - The wallet row id (stable per org).
 * @returns A key like `wallet-autotopup:<walletId>:<5min-bucket>`.
 * @example autoTopupIdempotencyKey('wallet-1') // 'wallet-autotopup:wallet-1:5966147'
 */
function autoTopupIdempotencyKey(walletId: string): string {
  return `wallet-autotopup:${walletId}:${Math.floor(Date.now() / 300_000)}`;
}

/**
 * Fire a one-off PaymentIntent against the stored default PM. The actual
 * credit happens via webhook on `payment_intent.succeeded` to avoid
 * double-credit if the SDK response races the webhook.
 *
 * @param idempotencyKey - Optional stable `Idempotency-Key` for the Stripe create call.
 *   Auto-topup callers MUST pass {@link autoTopupIdempotencyKey} so concurrent/retried
 *   charges dedupe to one; manual routes rely on the HTTP idempotency middleware.
 */
export async function topUpWallet(
  env: Env,
  orgId: string,
  amountCents: number,
  idempotencyKey?: string,
): Promise<TopUpResult> {
  const wallet = await ensureWalletRow(env, orgId);
  if (!wallet.stripe_customer_id || !wallet.stripe_default_payment_method) {
    return { ok: false, message: 'no payment method on file' };
  }
  const params = new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    customer: wallet.stripe_customer_id,
    payment_method: wallet.stripe_default_payment_method,
    off_session: 'true',
    confirm: 'true',
    'metadata[org_id]': orgId,
    'metadata[wallet_id]': wallet.id,
    'metadata[purpose]': 'wallet_topup',
  });
  const r = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // A stable Idempotency-Key collapses concurrent/retried off-session charges to ONE
      // in Stripe's 24h window — prevents the customer's card being charged twice when two
      // racing chargeWallet calls both trip auto-topup. Mirrors billing.ts create-customer (AL-746).
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: params,
  });
  if (!r.ok) {
    return { ok: false, message: `stripe_${r.status}: ${(await r.text()).slice(0, 200)}` };
  }
  const state = await getWalletState(env, orgId);
  return { ok: true, state };
}

/**
 * Admin-only manual adjustment (super-admin route). Recorded as
 * `direction='adjustment'` so the ledger preserves intent vs natural
 * credit/debit flow.
 */
export async function manualAdjustment(
  env: Env,
  orgId: string,
  opts: { amount_cents: number; reason: string; actor_id: string },
): Promise<{ ok: true; balance_after: number; transaction_id: string }> {
  const wallet = await ensureWalletRow(env, orgId);
  await env.DB.prepare(
    `UPDATE wallet_accounts
        SET balance_cents = balance_cents + ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  )
    .bind(opts.amount_cents, wallet.id)
    .run();
  const newBalance = wallet.balance_cents + opts.amount_cents;
  const txId = crypto.randomUUID();
  const { error: ledgerErr } = await dbInsert(env.DB, 'wallet_transactions', {
    id: txId,
    wallet_id: wallet.id,
    org_id: orgId,
    direction: 'adjustment',
    category_slug: null,
    quantity: null,
    base_cost_cents: null,
    markup_factor: null,
    amount_cents: opts.amount_cents,
    balance_after_cents: newBalance,
    reference_type: 'manual_adjustment',
    reference_id: null,
    stripe_event_id: null,
    metadata_json: JSON.stringify({ reason: opts.reason }),
    created_by: opts.actor_id,
  });
  if (ledgerErr) {
    // Reverse the adjustment so the admin-visible balance never diverges from
    // the ledger, then surface the failure to the super-admin caller.
    await reverseBalance(env, wallet.id, -opts.amount_cents, 'adjustment');
    throw internalError(`Failed to record wallet adjustment: ${ledgerErr}`);
  }
  return { ok: true, balance_after: newBalance, transaction_id: txId };
}

/**
 * Stripe webhook dispatcher consumed by `services/wallet_webhook.ts`. Routes
 * the four wallet-relevant Stripe events to {@link creditWallet} or
 * {@link syncSubscriptionStatus}; ignores everything else.
 *
 * Idempotency: every credit goes through {@link creditWallet} with the
 * Stripe `id` as `stripe_event_id` so replayed deliveries are no-ops.
 */
export async function handleStripeEvent(
  env: Env,
  eventType: string,
  obj: Record<string, unknown>,
): Promise<void> {
  const meta = (obj.metadata as Record<string, string> | undefined) ?? {};
  const orgId = meta.org_id;

  switch (eventType) {
    case 'invoice.paid': {
      // Monthly $50 subscription renewal. Stripe sends `subscription` on the
      // invoice when it's a sub renewal; one-time invoices have no sub.
      if (!orgId) return;
      const sub = obj.subscription as string | undefined;
      if (!sub) return; // Skip non-subscription invoices.
      const wallet = await ensureWalletRow(env, orgId);
      await creditWallet(env, orgId, {
        amount_cents: wallet.monthly_credit_cents,
        reason: 'monthly_subscription_credit',
        reference_type: 'subscription',
        reference_id: sub,
        stripe_event_id: obj.id as string,
        metadata: { invoice_amount_paid: obj.amount_paid as number | undefined },
      });
      // Also flip status to active in case it was past_due.
      const { error: statusErr } = await dbUpdate(
        env.DB,
        'wallet_accounts',
        { subscription_status: 'active' },
        'org_id = ?',
        [orgId],
      );
      // Payment-critical: a dropped status flip leaves a PAID org stuck `past_due`
      // (locked out of what they bought). Throw so the webhook is marked 'failed' +
      // logged + audited (observable) instead of a silent 200 with stale state.
      if (statusErr) throw internalError(`Failed to activate subscription: ${statusErr}`);
      return;
    }

    case 'payment_intent.succeeded': {
      if (!orgId) return;
      if (meta.purpose !== 'wallet_topup') return;
      await creditWallet(env, orgId, {
        amount_cents: obj.amount_received as number,
        reason: 'auto_topup',
        reference_type: 'topup',
        reference_id: obj.id as string,
        stripe_event_id: obj.id as string,
      });
      return;
    }

    case 'checkout.session.completed': {
      // First-time wallet subscription completes. Pull the default PM off the
      // subscription so future top-ups can fire off-session.
      if (!orgId) return;
      if (meta.purpose !== 'wallet_subscription') return;
      const subId = obj.subscription as string | undefined;
      const customerId = obj.customer as string | undefined;
      if (!subId || !customerId) return;

      // Pull subscription to get default_payment_method.
      let defaultPm: string | null = null;
      try {
        const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        if (r.ok) {
          const sub = (await r.json()) as { default_payment_method?: string | null };
          defaultPm = sub.default_payment_method ?? null;
        }
      } catch {
        /* swallow */
      }
      await syncSubscriptionStatus(env, {
        org_id: orgId,
        subscription_id: subId,
        status: 'active',
        default_payment_method: defaultPm,
      });
      // The first invoice.paid usually fires immediately; if not, this ensures
      // the wallet at least has the customer-on-file recorded.
      const { error: custErr } = await dbUpdate(
        env.DB,
        'wallet_accounts',
        { stripe_customer_id: customerId },
        'org_id = ?',
        [orgId],
      );
      // Without the customer on file, future off-session top-ups can't fire — a
      // dropped write here silently breaks recurring billing. Surface it.
      if (custErr) throw internalError(`Failed to record customer on wallet: ${custErr}`);
      return;
    }

    case 'payment_method.attached': {
      // A new PM landed on the customer; if no default is set, adopt it.
      const customerId = obj.customer as string | undefined;
      if (!customerId) return;
      const wallet = await dbQueryOne<WalletRow>(
        env.DB,
        `SELECT * FROM wallet_accounts WHERE stripe_customer_id = ? LIMIT 1`,
        [customerId],
      );
      if (!wallet) return;
      if (!wallet.stripe_default_payment_method) {
        const { error: pmErr } = await dbUpdate(
          env.DB,
          'wallet_accounts',
          { stripe_default_payment_method: obj.id as string },
          'id = ?',
          [wallet.id],
        );
        if (pmErr) throw internalError(`Failed to record default payment method: ${pmErr}`);
      }
      return;
    }

    case 'customer.subscription.deleted': {
      if (!orgId) return;
      await syncSubscriptionStatus(env, {
        org_id: orgId,
        subscription_id: obj.id as string,
        status: 'canceled',
      });
      return;
    }

    case 'customer.subscription.updated': {
      if (!orgId) return;
      if (meta.purpose !== 'wallet_subscription') return;
      const status = obj.status as string;
      const mapped: 'active' | 'past_due' | 'canceled' | 'trialing' | 'inactive' =
        status === 'active' ||
        status === 'past_due' ||
        status === 'canceled' ||
        status === 'trialing'
          ? status
          : 'inactive';
      await syncSubscriptionStatus(env, {
        org_id: orgId,
        subscription_id: obj.id as string,
        status: mapped,
        default_payment_method: (obj.default_payment_method as string | null) ?? undefined,
      });
      return;
    }

    default:
      return;
  }
}

/**
 * Sync subscription state from a Stripe webhook (`customer.subscription.*`).
 * Sibling services that depend on chargeWallet succeeding MUST check the
 * result code rather than assume the subscription is still active.
 */
export async function syncSubscriptionStatus(
  env: Env,
  opts: {
    org_id: string;
    subscription_id: string;
    status: 'active' | 'past_due' | 'canceled' | 'inactive' | 'trialing';
    default_payment_method?: string | null;
  },
): Promise<void> {
  const wallet = await ensureWalletRow(env, opts.org_id);
  const patch: Record<string, unknown> = {
    subscription_status: opts.status,
    stripe_subscription_id: opts.subscription_id,
  };
  if (opts.default_payment_method !== undefined) {
    patch.stripe_default_payment_method = opts.default_payment_method;
  }
  const { error: syncErr } = await dbUpdate(env.DB, 'wallet_accounts', patch, 'id = ?', [
    wallet.id,
  ]);
  // Subscription-state sync is billing-critical — a dropped write leaves the wallet's
  // status/subscription-id stale (wrong entitlements). Throw so a webhook caller marks
  // it 'failed' (observable) rather than a silent success with divergent state.
  if (syncErr) throw internalError(`Failed to sync subscription status: ${syncErr}`);
}
