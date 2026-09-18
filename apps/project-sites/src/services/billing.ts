/**
 * @module billing
 * @description Billing and subscription management service for Project Sites.
 *
 * Handles Stripe integration, subscription lifecycle, entitlement resolution,
 * and optional sale-webhook delivery. Every DB operation uses parameterized SQL.
 *
 * ## Stripe Event Flow
 *
 * ```
 * checkout.session.completed  -> handleCheckoutCompleted   -> plan='paid', status='active'
 * customer.subscription.updated -> handleSubscriptionUpdated -> sync status & period
 * customer.subscription.deleted -> handleSubscriptionDeleted -> plan='free', status='canceled'
 * invoice.payment_failed       -> handlePaymentFailed       -> status='past_due'
 * ```
 *
 * ## Boolean Convention
 *
 * D1 (SQLite) uses integer `0` / `1` for boolean columns. All boolean fields
 * (`cancel_at_period_end`, `retention_offer_applied`) are written as `0` or `1`.
 *
 * @packageDocumentation
 */

import {
  PRICING,
  type Entitlements,
  getEntitlements,
  badRequest,
  internalError,
} from '@project-sites/shared';
import type { BudgetTier } from '@project-sites/shared/schemas';
import { dbQueryOne, dbInsert, dbUpdate } from './db.js';
import { resolveActiveOrgPlan } from './build_limits.js';
import { writeAuditLog } from './audit.js';
import type { Env } from '../types/env.js';

/**
 * Stripe API error envelope as parsed from a non-2xx response body.
 *
 * Stripe always returns `{ error: { type, code?, decline_code?, message,
 * param? } }` for both `4xx` and `5xx`. We surface `code` (the stable,
 * machine-readable string like `card_declined` / `customer_max_subscriptions`)
 * to the caller alongside a user-safe `message`.
 *
 * @see https://stripe.com/docs/error-codes
 */
interface StripeErrorEnvelope {
  type?: string;
  code?: string;
  decline_code?: string;
  message?: string;
  param?: string;
  request_log_url?: string;
}

/** Best-effort parse of a Stripe error body — falls back to raw text. */
function parseStripeError(raw: string): { code: string; message: string; type: string } {
  try {
    const parsed = JSON.parse(raw) as { error?: StripeErrorEnvelope };
    const err = parsed.error ?? {};
    return {
      code: err.code ?? err.decline_code ?? err.type ?? 'stripe_unknown_error',
      message: err.message ?? 'Stripe rejected the request.',
      type: err.type ?? 'unknown',
    };
  } catch {
    return {
      code: 'stripe_invalid_response',
      message: raw.slice(0, 200) || 'Stripe returned an unparseable error body.',
      type: 'unknown',
    };
  }
}

/**
 * Get or create a Stripe customer for an organisation.
 *
 * Looks up an existing `stripe_customer_id`; if none, creates a customer via the
 * Stripe API and inserts a new free-tier subscription row.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param env   - Worker environment containing `STRIPE_SECRET_KEY`.
 * @param orgId - Organisation UUID.
 * @param email - Billing email forwarded to Stripe.
 * @returns Object containing the Stripe customer ID.
 */
export async function getOrCreateStripeCustomer(
  db: D1Database,
  env: Env,
  orgId: string,
  email: string,
): Promise<{ stripe_customer_id: string }> {
  const existing = await dbQueryOne<{ id: string; stripe_customer_id: string }>(
    db,
    'SELECT id, stripe_customer_id FROM subscriptions WHERE org_id = ? AND deleted_at IS NULL',
    [orgId],
  );

  if (existing?.stripe_customer_id) {
    return { stripe_customer_id: existing.stripe_customer_id };
  }

  // Stable per-org Idempotency-Key: the check-then-act above is NON-atomic, so two
  // concurrent checkouts (double-click / client retry) both miss the SELECT and race to
  // POST /v1/customers → two DUPLICATE Stripe customers for one org. A stable key makes
  // Stripe return the SAME customer on any retry within its 24h idempotency window, so the
  // race collapses to one customer. (Beyond 24h the check-then-act has already persisted the
  // row, so the SELECT short-circuits.) Reference: [[uuid-version-discipline]] idempotency-key.
  const response = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `create-customer:${orgId}`,
    },
    body: new URLSearchParams({
      email,
      'metadata[org_id]': orgId,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe customer creation failed',
        org_id: orgId,
        status: response.status,
      }),
    );
    throw badRequest(`Failed to create Stripe customer: ${err}`);
  }

  const customer = (await response.json()) as { id: string };
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'Stripe customer created',
      org_id: orgId,
      stripe_customer_id: customer.id,
    }),
  );

  const { error: subRowErr } = await dbInsert(db, 'subscriptions', {
    id: crypto.randomUUID(),
    org_id: orgId,
    stripe_customer_id: customer.id,
    stripe_subscription_id: null,
    plan: 'free',
    status: 'active',
    cancel_at_period_end: 0,
    retention_offer_applied: 0,
    dunning_stage: 0,
    deleted_at: null,
  });
  // Don't throw on a lost subscription-row write — return the (already-created) customer so
  // checkout still proceeds. The stable Idempotency-Key above makes this self-healing: the
  // next getOrCreateStripeCustomer call's SELECT misses (no row persisted), re-POSTs with the
  // SAME key → Stripe returns the SAME customer (no duplicate) → the sub-row insert retries.
  // Log for reconciliation meanwhile.
  if (subRowErr) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'billing',
        message: 'subscription_row_insert_failed',
        org_id: orgId,
        stripe_customer_id: customer.id,
        error: subRowErr,
      }),
    );
  }

  return { stripe_customer_id: customer.id };
}

/**
 * Create a Stripe Checkout session optimised for Stripe Link.
 *
 * Resolves (or creates) the org's Stripe customer, then builds a Checkout
 * session with card + Link payment methods, a single Pro line-item, and
 * optional promotion codes.
 *
 * @param db   - The D1Database binding from `env.DB`.
 * @param env  - Worker environment containing `STRIPE_SECRET_KEY`.
 * @param opts - Checkout options including org ID, return URLs, and customer email.
 * @returns Object with the hosted checkout URL and session ID.
 */
export async function createCheckoutSession(
  db: D1Database,
  env: Env,
  opts: {
    orgId: string;
    siteId?: string;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    budgetTier?: BudgetTier;
  },
): Promise<{ checkout_url: string; session_id: string }> {
  const { stripe_customer_id } = await getOrCreateStripeCustomer(
    db,
    env,
    opts.orgId,
    opts.customerEmail,
  );

  const params = new URLSearchParams({
    mode: 'subscription',
    customer: stripe_customer_id,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    'payment_method_types[0]': 'card',
    'payment_method_types[1]': 'link',
    'line_items[0][price_data][currency]': PRICING.CURRENCY,
    'line_items[0][price_data][unit_amount]': String(PRICING.MONTHLY_CENTS),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': 'Project Sites Pro',
    'line_items[0][price_data][product_data][description]':
      'Remove top bar, custom domains, analytics',
    'line_items[0][quantity]': '1',
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
  });

  if (opts.siteId) {
    params.append('metadata[site_id]', opts.siteId);
  }
  params.append('metadata[org_id]', opts.orgId);

  // Lookup site slug (best-effort) for human-readable audit messages.
  let siteSlug: string | null = null;
  if (opts.siteId) {
    const siteRow = await dbQueryOne<{ slug: string }>(
      db,
      'SELECT slug FROM sites WHERE id = ? AND deleted_at IS NULL',
      [opts.siteId],
    ).catch(() => null);
    siteSlug = siteRow?.slug ?? null;
  }

  let response: Response;
  try {
    response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
  } catch (networkErr) {
    // Network/timeout failures — Stripe SDK equivalent is APIConnectionError.
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    const stripeCode = 'stripe_network_error';
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe checkout fetch failed (network)',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        stripe_error_code: stripeCode,
        error: msg,
      }),
    );
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'billing',
        message: 'Stripe checkout error',
        stripe_error_code: stripeCode,
        stripe_error_type: 'api_connection_error',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        site_slug: siteSlug,
        raw: msg.slice(0, 500),
      }),
    );
    await writeAuditLog(db, {
      org_id: opts.orgId,
      actor_id: null,
      action: 'billing.checkout_failed',
      message: `Pro checkout failed for '${siteSlug ?? opts.siteId ?? opts.orgId}': ${stripeCode}`,
      target_type: 'subscription',
      target_id: opts.siteId ?? opts.orgId,
      metadata_json: { stripe_error_code: stripeCode, error: msg },
    });
    throw badRequest(`Could not reach Stripe. Please retry. (${stripeCode})`);
  }

  if (!response.ok) {
    const raw = await response.text();
    const { code: stripeCode, message: stripeMsg, type: stripeType } = parseStripeError(raw);
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe checkout creation failed',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        status: response.status,
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_message: stripeMsg,
      }),
    );
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'billing',
        message: 'Stripe checkout error',
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_status: response.status,
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        site_slug: siteSlug,
        stripe_message: stripeMsg,
      }),
    );
    await writeAuditLog(db, {
      org_id: opts.orgId,
      actor_id: null,
      action: 'billing.checkout_failed',
      message: `Pro checkout failed for '${siteSlug ?? opts.siteId ?? opts.orgId}': ${stripeCode}`,
      target_type: 'subscription',
      target_id: opts.siteId ?? opts.orgId,
      metadata_json: {
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_status: response.status,
        stripe_message: stripeMsg,
      },
    });
    // User-safe envelope: include the stable Stripe code so the frontend can
    // map it to a specific UX (decline → "try another card", rate_limit →
    // back-off banner) without parsing free-text English.
    throw badRequest(`Stripe checkout failed (${stripeCode}): ${stripeMsg}`);
  }

  const session = (await response.json()) as { id: string; url: string };
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'Checkout session created',
      org_id: opts.orgId,
      session_id: session.id,
    }),
  );

  return { checkout_url: session.url, session_id: session.id };
}

/**
 * Create a Stripe Checkout Session in **embedded** (`ui_mode: 'embedded'`) mode.
 *
 * Returns a `client_secret` that the frontend uses with `stripe.initEmbeddedCheckout()`
 * to render the checkout form inline, avoiding a full-page redirect.
 */
export async function createEmbeddedCheckoutSession(
  db: D1Database,
  env: Env,
  opts: {
    orgId: string;
    siteId?: string;
    customerEmail: string;
    returnUrl: string;
    budgetTier?: BudgetTier;
  },
): Promise<{ client_secret: string; session_id: string }> {
  const { stripe_customer_id } = await getOrCreateStripeCustomer(
    db,
    env,
    opts.orgId,
    opts.customerEmail,
  );

  const params = new URLSearchParams({
    mode: 'subscription',
    ui_mode: 'embedded',
    customer: stripe_customer_id,
    return_url: opts.returnUrl,
    'payment_method_types[0]': 'card',
    'payment_method_types[1]': 'link',
    'line_items[0][price_data][currency]': PRICING.CURRENCY,
    'line_items[0][price_data][unit_amount]': String(PRICING.MONTHLY_CENTS),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': 'Project Sites Pro',
    'line_items[0][price_data][product_data][description]':
      'Remove top bar, custom domains, analytics',
    'line_items[0][quantity]': '1',
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
  });

  if (opts.siteId) {
    params.append('metadata[site_id]', opts.siteId);
  }
  params.append('metadata[org_id]', opts.orgId);

  // Lookup site slug for human-readable audit messages.
  let siteSlug: string | null = null;
  if (opts.siteId) {
    const siteRow = await dbQueryOne<{ slug: string }>(
      db,
      'SELECT slug FROM sites WHERE id = ? AND deleted_at IS NULL',
      [opts.siteId],
    ).catch(() => null);
    siteSlug = siteRow?.slug ?? null;
  }

  let response: Response;
  try {
    response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    const stripeCode = 'stripe_network_error';
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe embedded checkout fetch failed (network)',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        stripe_error_code: stripeCode,
        error: msg,
      }),
    );
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'billing',
        message: 'Stripe checkout error',
        stripe_error_code: stripeCode,
        stripe_error_type: 'api_connection_error',
        ui_mode: 'embedded',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        site_slug: siteSlug,
        raw: msg.slice(0, 500),
      }),
    );
    await writeAuditLog(db, {
      org_id: opts.orgId,
      actor_id: null,
      action: 'billing.checkout_failed',
      message: `Pro checkout failed for '${siteSlug ?? opts.siteId ?? opts.orgId}': ${stripeCode}`,
      target_type: 'subscription',
      target_id: opts.siteId ?? opts.orgId,
      metadata_json: { stripe_error_code: stripeCode, ui_mode: 'embedded', error: msg },
    });
    throw badRequest(`Could not reach Stripe. Please retry. (${stripeCode})`);
  }

  if (!response.ok) {
    const raw = await response.text();
    const { code: stripeCode, message: stripeMsg, type: stripeType } = parseStripeError(raw);
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe embedded checkout creation failed',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        status: response.status,
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_message: stripeMsg,
      }),
    );
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'billing',
        message: 'Stripe checkout error',
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_status: response.status,
        ui_mode: 'embedded',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        site_slug: siteSlug,
        stripe_message: stripeMsg,
      }),
    );
    await writeAuditLog(db, {
      org_id: opts.orgId,
      actor_id: null,
      action: 'billing.checkout_failed',
      message: `Pro checkout failed for '${siteSlug ?? opts.siteId ?? opts.orgId}': ${stripeCode}`,
      target_type: 'subscription',
      target_id: opts.siteId ?? opts.orgId,
      metadata_json: {
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_status: response.status,
        stripe_message: stripeMsg,
        ui_mode: 'embedded',
      },
    });
    throw badRequest(`Stripe embedded checkout failed (${stripeCode}): ${stripeMsg}`);
  }

  const session = (await response.json()) as { id: string; client_secret: string };
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'Embedded checkout session created',
      org_id: opts.orgId,
      session_id: session.id,
    }),
  );

  return { client_secret: session.client_secret, session_id: session.id };
}

/**
 * Create a one-shot Stripe **PaymentIntent** for inline 1-click checkout via
 * Express Checkout Element (Apple Pay / Google Pay / Link row) + Payment
 * Element (card + Link Authentication).
 *
 * Returns a `client_secret` the frontend uses with `stripe.confirmPayment()` —
 * no full-page redirect, no embedded Checkout iframe, just the minimal-widget
 * row mounted directly inside our Angular dialog. Apple Pay / Google Pay /
 * Link surface automatically based on the account's PMC + browser support.
 *
 * @param opts.amountCents       Amount in cents (min 50¢ for USD).
 * @param opts.currency          ISO 4217 lowercase, defaults to 'usd'.
 * @param opts.description       Human-readable charge description (statement).
 * @param opts.saveForFutureUse  Attach payment_method to customer for future Link 1-click.
 */
export async function createPaymentIntent(
  db: D1Database,
  env: Env,
  opts: {
    orgId: string;
    siteId?: string;
    customerEmail: string;
    amountCents: number;
    currency?: string;
    description?: string;
    saveForFutureUse?: boolean;
  },
): Promise<{ client_secret: string; payment_intent_id: string }> {
  const { stripe_customer_id } = await getOrCreateStripeCustomer(
    db,
    env,
    opts.orgId,
    opts.customerEmail,
  );

  const params = new URLSearchParams({
    amount: String(opts.amountCents),
    currency: opts.currency || PRICING.CURRENCY,
    customer: stripe_customer_id,
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
    'metadata[org_id]': opts.orgId,
  });
  if (opts.siteId) params.append('metadata[site_id]', opts.siteId);
  if (opts.description) params.append('description', opts.description);
  if (opts.saveForFutureUse !== false) {
    params.append('setup_future_usage', 'off_session');
  }

  let response: Response;
  try {
    response = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe PaymentIntent fetch failed (network)',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        error: msg,
      }),
    );
    throw badRequest(`Could not reach Stripe. Please retry. (stripe_network_error)`);
  }

  if (!response.ok) {
    const raw = await response.text();
    const { code: stripeCode, message: stripeMsg, type: stripeType } = parseStripeError(raw);
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Stripe PaymentIntent creation failed',
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        status: response.status,
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_message: stripeMsg,
      }),
    );
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'billing',
        message: 'Stripe PaymentIntent error',
        stripe_error_code: stripeCode,
        stripe_error_type: stripeType,
        stripe_status: response.status,
        org_id: opts.orgId,
        site_id: opts.siteId ?? null,
        amount_cents: opts.amountCents,
      }),
    );
    throw badRequest(`Stripe payment failed (${stripeCode}): ${stripeMsg}`);
  }

  const pi = (await response.json()) as { id: string; client_secret: string };
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'PaymentIntent created',
      org_id: opts.orgId,
      payment_intent_id: pi.id,
      amount_cents: opts.amountCents,
      currency: opts.currency || PRICING.CURRENCY,
    }),
  );

  return { client_secret: pi.client_secret, payment_intent_id: pi.id };
}

/**
 * Handle the `checkout.session.completed` Stripe webhook event.
 *
 * Updates the org's subscription row to `plan = 'paid'` / `status = 'active'`,
 * records the Stripe subscription ID and payment timestamp, then fires the
 * optional external sale webhook.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param env   - Worker environment (Stripe key, webhook config).
 * @param event - Parsed Stripe event payload with customer, subscription, and metadata.
 */
export async function handleCheckoutCompleted(
  db: D1Database,
  env: Env,
  event: {
    customer: string;
    subscription: string;
    metadata?: { org_id?: string; site_id?: string };
  },
): Promise<void> {
  const orgId = event.metadata?.org_id;
  if (!orgId) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Checkout completed but missing org_id in metadata',
        customer: event.customer,
      }),
    );
    throw badRequest('Missing org_id in checkout metadata');
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'Checkout completed — upgrading to paid',
      org_id: orgId,
      subscription: event.subscription,
    }),
  );

  const { error: subErr } = await dbUpdate(
    db,
    'subscriptions',
    {
      stripe_subscription_id: event.subscription,
      plan: 'paid',
      status: 'active',
      dunning_stage: 0,
      last_payment_at: new Date().toISOString(),
    },
    'org_id = ?',
    [orgId],
  );
  // A dropped upgrade leaves a PAID org stuck on 'free' (locked out of what they
  // bought). Throw so the Stripe webhook route marks the event 'failed' + audits
  // (observable) instead of a silent 200 with divergent entitlement state.
  if (subErr) throw internalError(`Failed to activate paid subscription: ${subErr}`);

  // Mark the specific site as paid if site_id is present
  const siteId = event.metadata?.site_id;
  if (siteId) {
    const { error: siteErr } = await dbUpdate(
      db,
      'sites',
      { plan: 'paid' },
      'id = ? AND org_id = ?',
      [siteId, orgId],
    );
    if (siteErr) throw internalError(`Failed to mark site paid: ${siteErr}`);
    console.warn(
      JSON.stringify({
        level: 'info',
        service: 'billing',
        message: 'Site upgraded to paid',
        org_id: orgId,
        site_id: siteId,
      }),
    );
  }

  await writeAuditLog(db, {
    org_id: orgId,
    actor_id: null,
    action: 'billing.subscription.started',
    message: `Subscription started on 'paid' plan${siteId ? ` for site '${siteId}'` : ''} (Stripe sub '${event.subscription}')`,
    target_type: 'subscription',
    target_id: event.subscription,
    metadata_json: {
      stripe_customer_id: event.customer,
      stripe_subscription_id: event.subscription,
      site_id: siteId ?? null,
      plan: 'paid',
    },
  });

  if (env.SALE_WEBHOOK_URL && env.SALE_WEBHOOK_SECRET) {
    await callSaleWebhook(env, {
      org_id: orgId,
      site_id: event.metadata?.site_id ?? null,
      stripe_customer_id: event.customer,
      stripe_subscription_id: event.subscription,
    });
  }
}

/**
 * Handle the `customer.subscription.updated` Stripe webhook event.
 *
 * Syncs the subscription status, cancellation flag, and billing period
 * timestamps from Stripe into the local `subscriptions` row.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param event - Parsed Stripe subscription object with period timestamps (Unix seconds).
 */
export async function handleSubscriptionUpdated(
  db: D1Database,
  event: {
    id: string;
    status: string;
    cancel_at_period_end: boolean;
    current_period_start: number;
    current_period_end: number;
    metadata?: { org_id?: string };
  },
): Promise<void> {
  const orgId = event.metadata?.org_id;
  if (!orgId) return;

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'Subscription updated',
      org_id: orgId,
      status: event.status,
      cancel_at_period_end: event.cancel_at_period_end,
    }),
  );

  const { error: subErr } = await dbUpdate(
    db,
    'subscriptions',
    {
      status: event.status,
      cancel_at_period_end: event.cancel_at_period_end ? 1 : 0,
      current_period_start: new Date(event.current_period_start * 1000).toISOString(),
      current_period_end: new Date(event.current_period_end * 1000).toISOString(),
    },
    'org_id = ?',
    [orgId],
  );
  // A dropped sync leaves local entitlement state diverged from Stripe (stale
  // status / period). Throw → observable 'failed' webhook instead of silent drift.
  if (subErr) throw internalError(`Failed to sync subscription update: ${subErr}`);

  await writeAuditLog(db, {
    org_id: orgId,
    actor_id: null,
    action: 'billing.subscription.updated',
    message: `Subscription '${event.id}' status synced to '${event.status}'${event.cancel_at_period_end ? ' (cancel-at-period-end)' : ''}`,
    target_type: 'subscription',
    target_id: event.id,
    metadata_json: {
      stripe_subscription_id: event.id,
      status: event.status,
      cancel_at_period_end: event.cancel_at_period_end,
    },
  });
}

/**
 * Handle the `customer.subscription.deleted` Stripe webhook event (cancellation).
 *
 * Downgrades the org to the free plan and clears the Stripe subscription ID.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param event - Parsed Stripe subscription object with metadata.
 */
export async function handleSubscriptionDeleted(
  db: D1Database,
  event: { id: string; metadata?: { org_id?: string } },
): Promise<void> {
  const orgId = event.metadata?.org_id;
  if (!orgId) return;

  console.warn(
    JSON.stringify({
      level: 'warn',
      service: 'billing',
      message: 'Subscription canceled — downgrading to free',
      org_id: orgId,
      subscription_id: event.id,
    }),
  );

  const { error: subErr } = await dbUpdate(
    db,
    'subscriptions',
    {
      plan: 'free',
      status: 'canceled',
      stripe_subscription_id: null,
    },
    'org_id = ?',
    [orgId],
  );
  // A dropped cancellation leaves a canceled org on the 'paid' plan (revenue leak
  // — paid entitlements kept for free). Throw → observable 'failed' webhook.
  if (subErr) throw internalError(`Failed to downgrade canceled subscription: ${subErr}`);

  // Downgrade all org sites to free
  const { error: siteErr } = await dbUpdate(db, 'sites', { plan: 'free' }, 'org_id = ?', [orgId]);
  if (siteErr) throw internalError(`Failed to downgrade org sites: ${siteErr}`);

  await writeAuditLog(db, {
    org_id: orgId,
    actor_id: null,
    action: 'billing.subscription.cancelled',
    message: `Subscription '${event.id}' cancelled — org downgraded to 'free' plan`,
    target_type: 'subscription',
    target_id: event.id,
    metadata_json: { stripe_subscription_id: event.id, plan: 'free', status: 'canceled' },
  });
}

/**
 * Handle the `invoice.payment_failed` Stripe webhook event.
 *
 * Marks the subscription as `past_due` and records the failure timestamp
 * for dunning-flow tracking.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param event - Parsed Stripe invoice event with subscription and metadata.
 */
export async function handlePaymentFailed(
  db: D1Database,
  event: { subscription: string; metadata?: { org_id?: string } },
): Promise<void> {
  const orgId = event.metadata?.org_id;
  if (!orgId) return;

  console.warn(
    JSON.stringify({
      level: 'warn',
      service: 'billing',
      message: 'Payment failed — marking past_due',
      org_id: orgId,
      subscription: event.subscription,
    }),
  );

  const { error: subErr } = await dbUpdate(
    db,
    'subscriptions',
    {
      status: 'past_due',
      last_payment_failed_at: new Date().toISOString(),
    },
    'org_id = ?',
    [orgId],
  );
  // A dropped past_due flip leaves a failed-payment org 'active' (keeps paid
  // entitlements despite non-payment — revenue leak). Throw → observable 'failed'
  // webhook so dunning/recovery can act, instead of a silent 200.
  if (subErr) throw internalError(`Failed to mark subscription past_due: ${subErr}`);

  await writeAuditLog(db, {
    org_id: orgId,
    actor_id: null,
    action: 'billing.payment_failed',
    message: `Payment failed for subscription '${event.subscription}' — status set to 'past_due'`,
    target_type: 'subscription',
    target_id: event.subscription,
    metadata_json: { stripe_subscription_id: event.subscription, status: 'past_due' },
  });
}

/**
 * Get organisation entitlements based on subscription state.
 *
 * An org is considered `paid` only when both `plan = 'paid'` **and**
 * `status = 'active'` (or trialing); all other states fall back to the `free` tier.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param orgId - Organisation UUID.
 * @returns Resolved entitlements for the org's current plan.
 */
export async function getOrgEntitlements(db: D1Database, orgId: string): Promise<Entitlements> {
  // Route through the shared status-gated plan resolver (SSOT) so entitlement
  // resolution matches build-quota + site-features:
  //   - a TRIALING paid sub IS entitled to paid features (was WRONGLY excluded:
  //     `status !== 'active'` treated trialing as free → a paying trial user got
  //     free entitlements + free team-seat limits — a paid-feature lockout bug);
  //   - a past_due / canceled sub (plan still 'paid' in the row) resolves to null
  //     → free (no entitlement leak after a failed payment).
  const plan = await resolveActiveOrgPlan(db, orgId);
  return getEntitlements(orgId, plan === 'paid' ? 'paid' : 'free');
}

/**
 * Get full subscription details for an organisation.
 *
 * Returns the plan, status, Stripe identifiers, cancellation flag, and
 * current billing-period end date. Returns `null` when the org has no
 * active (non-deleted) subscription row.
 *
 * @param db    - The D1Database binding from `env.DB`.
 * @param orgId - Organisation UUID.
 * @returns Subscription summary or `null` if none exists.
 */
export async function getOrgSubscription(
  db: D1Database,
  orgId: string,
): Promise<{
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
} | null> {
  const row = await dbQueryOne<{
    plan: string;
    status: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    cancel_at_period_end: number;
    current_period_end: string | null;
  }>(
    db,
    'SELECT plan, status, stripe_customer_id, stripe_subscription_id, cancel_at_period_end, current_period_end FROM subscriptions WHERE org_id = ? AND deleted_at IS NULL',
    [orgId],
  );

  if (!row) return null;

  // Convert D1 integer boolean (0/1) back to JS boolean for the public API
  return {
    plan: row.plan,
    status: row.status,
    stripe_customer_id: row.stripe_customer_id,
    stripe_subscription_id: row.stripe_subscription_id,
    cancel_at_period_end: row.cancel_at_period_end === 1,
    current_period_end: row.current_period_end,
  };
}

/**
 * Create a Stripe Billing Portal session.
 *
 * Opens the customer-facing portal where users update payment methods,
 * view invoices, or cancel their subscription. No database access required.
 *
 * @param env              - Worker environment containing `STRIPE_SECRET_KEY`.
 * @param stripeCustomerId - The Stripe customer ID (`cus_xxx`).
 * @param returnUrl        - URL the user returns to after leaving the portal.
 * @returns Object containing the portal session URL.
 */
export async function createBillingPortalSession(
  env: Env,
  stripeCustomerId: string,
  returnUrl: string,
): Promise<{ portal_url: string }> {
  const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: stripeCustomerId,
      return_url: returnUrl,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'billing',
        message: 'Billing portal creation failed',
        status: response.status,
      }),
    );
    throw badRequest(`Failed to create billing portal: ${err}`);
  }

  const session = (await response.json()) as { url: string };
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'billing',
      message: 'Billing portal session created',
      customer_id: stripeCustomerId,
    }),
  );
  return { portal_url: session.url };
}

/**
 * Call the optional external sale webhook with retry and exponential backoff.
 *
 * Sends a signed JSON payload to `SALE_WEBHOOK_URL`. The signature is an
 * HMAC-SHA256 hex digest in the `X-Webhook-Signature` header, computed over the
 * raw JSON body using `SALE_WEBHOOK_SECRET`. Retries up to 3 times with
 * exponential backoff (1 s, 2 s).
 *
 * @param env     - Worker environment with `SALE_WEBHOOK_URL` and `SALE_WEBHOOK_SECRET`.
 * @param payload - Sale details including org, site, and Stripe identifiers.
 */
async function callSaleWebhook(
  env: Env,
  payload: {
    org_id: string;
    site_id: string | null;
    stripe_customer_id: string;
    stripe_subscription_id: string;
  },
): Promise<void> {
  if (!env.SALE_WEBHOOK_URL || !env.SALE_WEBHOOK_SECRET) return;

  const body = JSON.stringify({
    ...payload,
    plan: 'paid',
    amount_cents: PRICING.MONTHLY_CENTS,
    currency: PRICING.CURRENCY,
    timestamp: new Date().toISOString(),
    request_id: crypto.randomUUID(),
    trace_id: crypto.randomUUID(),
  });

  const { hmacSha256 } = await import('@project-sites/shared');
  const signature = await hmacSha256(env.SALE_WEBHOOK_SECRET, body);

  // Retry with backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(env.SALE_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body,
      });

      if (response.ok) return;

      console.error(
        JSON.stringify({
          level: 'warn',
          service: 'billing',
          message: `Sale webhook attempt ${attempt + 1} failed: ${response.status}`,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          service: 'billing',
          message: `Sale webhook attempt ${attempt + 1} error`,
          error: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }

    // Exponential backoff
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}
