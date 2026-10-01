/**
 * claim_flow — service layer (fire-60).
 *
 * @remarks
 * The paid-claim funnel: a generated site is viewable FREE on its subdomain;
 * CLAIMING is a $29/mo Stripe subscription that unlocks custom domain + edits +
 * AI ops + email. This service owns:
 *
 *  - **Price mechanism** — {@link getOrCreateClaimPrice}: lookup-or-create the
 *    "ProjectSites Claim" $29/mo price by stable `lookup_key`, cached in KV.
 *    Creation is TEST-MODE-ONLY (or explicit `CLAIM_PRICE_AUTOCREATE=true`) so a
 *    live account is never mutated as a side effect; with no resolvable price id
 *    the checkout falls back to inline `price_data` — the exact pattern the
 *    existing Pro checkout ({@link ../../../src/services/billing.js}) uses, so
 *    live mode keeps working without a hardcoded, unverified price id.
 *  - **Checkout** — {@link createClaimCheckoutSession}: a subscription-mode
 *    session carrying `metadata[org_id]` + `metadata[site_id]` + `metadata[kind]=claim`.
 *    The EXISTING `checkout.session.completed` webhook path
 *    (`billing.handleCheckoutCompleted`) already reads those keys and marks the
 *    site claimed (`sites.plan='paid'`) + the org subscription active — no new
 *    webhook code, by design (extend, never reimplement).
 *  - **Entitlement seam** — {@link isSiteClaimed}: claimed = site `plan='paid'`
 *    OR the owning org resolves paid via `resolveActiveOrgPlan` (the status-gated
 *    SSOT that correctly INCLUDES `trialing` and excludes `past_due`/`canceled`).
 *  - **Top-bar pitch attrs** — {@link claimPitchScriptAttrs}: the escaped
 *    `data-claim`/`data-business` attributes `site_serving.ts` appends to the
 *    `/app.js` script tag so the client bar renders the claim pitch.
 *
 * @packageDocumentation
 */

import { badRequest } from '@project-sites/shared';

import type { Env } from '../../../src/types/env.js';

import { getOrCreateStripeCustomer } from '../../../src/services/billing.js';
import { resolveActiveOrgPlan } from '../../../src/services/build_limits.js';
import { writeAuditLog } from '../../../src/services/audit.js';
import { dbQueryOne } from '../../../src/services/db.js';

/** Claim subscription price: $29/mo USD. */
export const CLAIM_MONTHLY_CENTS = 2900;

/** Stable Stripe `lookup_key` for the claim price — NEVER a hardcoded price id. */
export const CLAIM_PRICE_LOOKUP_KEY = 'projectsites_claim_29_monthly';

/** KV key caching the resolved Stripe price id (config-on-first-create). */
const KV_PRICE_ID_KEY = 'claim_flow:stripe_price_id';

/** Structured log helper (console.warn per repo convention — console.log is lint-blocked). */
function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level, service: 'claim_flow', message, ...fields }));
}

/** True when runtime Stripe config mutation (price create) is permitted. */
function priceCreateAllowed(env: Env): boolean {
  if ((env as { CLAIM_PRICE_AUTOCREATE?: string }).CLAIM_PRICE_AUTOCREATE === 'true') return true;
  return (env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_');
}

/**
 * Resolve the $29/mo claim price id: KV cache → Stripe lookup by `lookup_key` →
 * (test-mode-only) idempotent create. Returns `null` when no id is resolvable —
 * callers MUST fall back to inline `price_data` (never a guessed price id).
 *
 * Idempotency: the KV cache + Stripe `lookup_key` + a stable `Idempotency-Key`
 * on the create make this safe to call concurrently and repeatedly.
 *
 * Fail-soft: any Stripe/network error returns `null` (checkout still works via
 * the inline fallback) — the claim funnel never breaks on config resolution.
 */
export async function getOrCreateClaimPrice(env: Env): Promise<string | null> {
  try {
    const cached = await env.CACHE_KV?.get(KV_PRICE_ID_KEY);
    if (cached) return cached;
  } catch {
    /* KV miss/err → continue to Stripe lookup */
  }

  if (!env.STRIPE_SECRET_KEY) return null;
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  try {
    // 1. Lookup (read-only — always safe, live or test).
    const lookupUrl =
      'https://api.stripe.com/v1/prices?' +
      new URLSearchParams({
        'lookup_keys[]': CLAIM_PRICE_LOOKUP_KEY,
        active: 'true',
        limit: '1',
      }).toString();
    const lookupRes = await fetch(lookupUrl, { headers });
    if (lookupRes.ok) {
      const found = (await lookupRes.json()) as { data?: { id: string }[] };
      const id = found.data?.[0]?.id;
      if (id) {
        await env.CACHE_KV?.put(KV_PRICE_ID_KEY, id).catch?.(() => undefined);
        return id;
      }
    }

    // 2. Create — guarded: TEST mode (sk_test_) or explicit CLAIM_PRICE_AUTOCREATE=true.
    //    In live mode we create NOTHING; checkout falls back to inline price_data
    //    (identical to the existing Pro checkout's pattern, so nothing breaks).
    if (!priceCreateAllowed(env)) {
      log('info', 'claim price absent; live mode — skipping create, inline fallback', {
        lookup_key: CLAIM_PRICE_LOOKUP_KEY,
      });
      return null;
    }
    const createRes = await fetch('https://api.stripe.com/v1/prices', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `claim-price:${CLAIM_PRICE_LOOKUP_KEY}` },
      body: new URLSearchParams({
        currency: 'usd',
        unit_amount: String(CLAIM_MONTHLY_CENTS),
        'recurring[interval]': 'month',
        lookup_key: CLAIM_PRICE_LOOKUP_KEY,
        transfer_lookup_key: 'true',
        'product_data[name]': 'ProjectSites Claim',
      }),
    });
    if (!createRes.ok) {
      log('warn', 'claim price create failed', { status: createRes.status });
      return null;
    }
    const created = (await createRes.json()) as { id: string };
    await env.CACHE_KV?.put(KV_PRICE_ID_KEY, created.id).catch?.(() => undefined);
    log('info', 'claim price created', { price_id: created.id });
    return created.id;
  } catch (err) {
    log('warn', 'claim price resolution failed — inline fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Create the $29/mo claim checkout session for a site.
 *
 * Reuses {@link getOrCreateStripeCustomer} (one Stripe customer per org, race-safe)
 * and mirrors the Pro checkout's session shape. `metadata[org_id]` +
 * `metadata[site_id]` are the CONTRACT the existing
 * `checkout.session.completed` webhook (`handleCheckoutCompleted`) consumes to
 * mark the site claimed; `metadata[kind]='claim'` distinguishes claim events in
 * audit/analytics (the webhook's wallet/domain_purchase branches ignore it).
 *
 * @throws {AppError} `BAD_REQUEST` with a stable `stripe_*` code when Stripe rejects.
 */
export async function createClaimCheckoutSession(
  db: D1Database,
  env: Env,
  opts: {
    orgId: string;
    siteId: string;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ checkout_url: string; session_id: string }> {
  const { stripe_customer_id } = await getOrCreateStripeCustomer(
    db,
    env,
    opts.orgId,
    opts.customerEmail,
  );

  const priceId = await getOrCreateClaimPrice(env);

  const params = new URLSearchParams({
    mode: 'subscription',
    customer: stripe_customer_id,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    'payment_method_types[0]': 'card',
    'payment_method_types[1]': 'link',
    'line_items[0][quantity]': '1',
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
  });
  if (priceId) {
    params.append('line_items[0][price]', priceId);
  } else {
    // Inline fallback — same mechanism the existing Pro checkout uses; Stripe
    // mints the price at session-create time (user-initiated, never standing config).
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(CLAIM_MONTHLY_CENTS));
    params.append('line_items[0][price_data][recurring][interval]', 'month');
    params.append('line_items[0][price_data][product_data][name]', 'ProjectSites Claim');
    params.append(
      'line_items[0][price_data][product_data][description]',
      'Your website, made official — custom domain, AI editing, and email',
    );
  }
  params.append('metadata[org_id]', opts.orgId);
  params.append('metadata[site_id]', opts.siteId);
  params.append('metadata[kind]', 'claim');

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
    log('error', 'claim checkout fetch failed (network)', {
      org_id: opts.orgId,
      site_id: opts.siteId,
      error: msg,
    });
    throw badRequest('Could not reach Stripe. Please retry. (stripe_network_error)');
  }

  if (!response.ok) {
    const raw = await response.text();
    let code = 'stripe_unknown_error';
    let message = 'Stripe rejected the request.';
    try {
      const parsed = JSON.parse(raw) as {
        error?: { code?: string; type?: string; message?: string };
      };
      code = parsed.error?.code ?? parsed.error?.type ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      /* keep defaults */
    }
    log('error', 'claim checkout rejected by Stripe', {
      org_id: opts.orgId,
      site_id: opts.siteId,
      stripe_error_code: code,
      status: response.status,
    });
    await writeAuditLog(db, {
      org_id: opts.orgId,
      actor_id: null,
      action: 'billing.checkout_failed',
      message: `Claim checkout failed for site '${opts.siteId}': ${code}`,
      target_type: 'subscription',
      target_id: opts.siteId,
      metadata_json: { stripe_error_code: code, kind: 'claim' },
    }).catch(() => undefined);
    throw badRequest(`${message} (${code})`);
  }

  const session = (await response.json()) as { id: string; url: string };
  log('info', 'claim checkout session created', {
    org_id: opts.orgId,
    site_id: opts.siteId,
    session_id: session.id,
  });
  return { checkout_url: session.url, session_id: session.id };
}

/**
 * Entitlement seam: is this site claimed (paid-grade)?
 *
 * Claimed = the site row itself is `plan='paid'` (the claim webhook's write) OR
 * the owning org resolves paid through {@link resolveActiveOrgPlan} — the
 * status-gated SSOT (`status IN ('active','trialing')`), so a trialing claimer
 * is entitled and a `past_due` one is not. Custom-domain + AI-ops gates that
 * already route through `getOrgEntitlements` therefore pass automatically once
 * the claim webhook lands; this helper exists for callers that need the
 * per-SITE answer (e.g. the top-bar, per-site feature gates).
 */
export async function isSiteClaimed(env: Env, siteId: string): Promise<boolean> {
  const row = await dbQueryOne<{ plan: string; org_id: string }>(
    env.DB,
    'SELECT plan, org_id FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  if (!row) return false;
  if (row.plan === 'paid') return true;
  const orgPlan = await resolveActiveOrgPlan(env.DB, row.org_id);
  return orgPlan === 'paid';
}

/** HTML-attribute escape (mirrors site_serving's safeSlug escaping). */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );
}

/**
 * Build the extra `data-*` attributes `site_serving.ts` appends to the `/app.js`
 * script tag when the `claim_flow` flag is ON and the site is unclaimed. The
 * client script reads them and renders the claim pitch
 * ("This site was built for {business}. Claim it — $29/mo.") instead of the
 * generic register bar. Pure + escaped; business name capped at 120 chars.
 */
export function claimPitchScriptAttrs(businessName: string): string {
  const name = escapeAttr(String(businessName).slice(0, 120));
  return ` data-claim="1" data-business="${name}"`;
}
