/**
 * @module routes/wallet
 * @description Customer-facing wallet API.
 *
 * | Path                              | Purpose                              |
 * | --------------------------------- | ------------------------------------ |
 * | `GET  /api/wallet`                | Current wallet balance + status      |
 * | `POST /api/wallet/subscribe`      | Start $50/mo subscription checkout   |
 * | `POST /api/wallet/topup`          | Manual top-up (charges stored PM)    |
 * | `GET  /api/wallet/transactions`   | Org's own transaction ledger         |
 * | `GET  /api/wallet/cost-categories`| Read-only catalog (for UI rendering) |
 *
 * Sibling `/api/billing/*` routes are untouched — that's the legacy
 * tier-based subscription surface. The wallet surface is additive.
 *
 * Sibling `routes/domain_purchase.ts` also serves `/api/billing/wallet`,
 * `/api/billing/checkout/wallet`, `/api/billing/topup` against the same
 * service layer; these `/api/wallet/*` aliases coexist without conflict.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../types/env.js';
import { dbQuery, dbQueryOne } from '../services/db.js';
import { getWalletState, startSubscription, topUpWallet } from '../services/wallet.js';
import { unauthorized } from '@project-sites/shared';

const wallet = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * `GET /api/wallet` — Fetch the caller org's wallet balance + subscription
 * status + payment-method presence.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
wallet.get('/api/wallet', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized();
  const state = await getWalletState(c.env, orgId);
  return c.json(state);
});

/**
 * `POST /api/wallet/subscribe` — Start a Stripe Checkout session for the
 * $50/mo wallet subscription.
 *
 * @remarks
 * Body: `{ return_url }`. Caller is redirected to the Checkout URL
 * returned in `{ checkout_url }`. Stripe webhook completes the
 * activation. Idempotent per session id.
 *
 * @throws 400 BAD_REQUEST when payload validation fails or upstream
 *   Stripe rejects the checkout.
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
wallet.post(
  '/api/wallet/subscribe',
  zValidator('json', z.object({ return_url: z.string().url() })),
  async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId || !userId) throw unauthorized();
    const user = await dbQueryOne<{ email: string }>(
      c.env.DB,
      'SELECT email FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    const { return_url } = c.req.valid('json');
    const result = await startSubscription(c.env, orgId, {
      success_url: `${return_url}?wallet=active`,
      cancel_url: `${return_url}?wallet=canceled`,
      email: user?.email,
    });
    if (!result.ok)
      return c.json({ error: { code: 'CHECKOUT_FAILED', message: result.message } }, 400);
    return c.json({ checkout_url: result.checkout_url });
  },
);

/**
 * `POST /api/wallet/topup` — Charge the stored Stripe payment method to
 * top up the caller org's wallet.
 *
 * @remarks
 * Body: `{ amount_cents? }` clamped to 100–50000. Defaults to $50 when
 * unset. Zod-validated at the boundary (`zValidator`) — a non-integer,
 * non-positive, or unknown-key body is rejected with 400 before the charge.
 *
 * @throws 400 BAD_REQUEST when the body fails Zod validation.
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
wallet.post(
  '/api/wallet/topup',
  zValidator('json', z.object({ amount_cents: z.number().int().positive().optional() }).strict()),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) throw unauthorized();
    // Default top-up = $50 (wallet.auto_topup_amount_cents) — caller can override.
    const { amount_cents } = c.req.valid('json');
    const amount = Math.max(100, Math.min(50000, Number(amount_cents) || 5000));
    const result = await topUpWallet(c.env, orgId, amount);
    return c.json(result);
  },
);

/**
 * `GET /api/wallet/transactions?days=` — Caller org's wallet ledger.
 *
 * @remarks
 * `days` is 1–365 (default 30). Capped at 500 rows.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
wallet.get('/api/wallet/transactions', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized();
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, direction, category_slug, quantity, amount_cents, balance_after_cents,
            reference_type, reference_id, created_at
       FROM wallet_transactions
       WHERE org_id = ? AND created_at >= datetime('now', ?)
       ORDER BY created_at DESC LIMIT 500`,
    [orgId, `-${days} days`],
  );
  return c.json({ transactions: data });
});

/**
 * `GET /api/wallet/cost-categories` — Read-only catalog of billable cost
 * categories for UI rendering ("you pay $0.0042 per AI call", etc.).
 *
 * No auth required — pricing is public.
 */
wallet.get('/api/wallet/cost-categories', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT slug, label, unit, base_cost_cents, markup_factor, billable
       FROM cost_categories WHERE billable = 1 ORDER BY slug`,
  );
  return c.json({ categories: data });
});

export { wallet };
