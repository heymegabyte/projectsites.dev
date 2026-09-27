/**
 * @module domain_purchase_complete
 *
 * @description
 * Completes an in-app "buy a domain through us" purchase once Stripe confirms payment
 * (`checkout.session.completed`, `metadata.kind = 'domain_purchase'`).
 *
 * The purchase endpoint (`POST /api/apps/instances/:id/domains/purchase`, {@link ../routes/apps})
 * created a combined Checkout Session (one-time domain registration + $50/mo paid subscription)
 * and persisted a PENDING row in `app_instance_domain_purchases` keyed on the Stripe session id.
 * This module drives the fulfilment side of that flow:
 *
 *  1. Register the domain at Cloudflare Registrar when the TLD is supported (the Registrar API
 *     supports programmatic new-domain registration — see {@link ../services/cf_registrar}).
 *     When it isn't supported (or CF auth is missing), mark it `registration_queued` for concierge.
 *  2. Create the CF custom hostname (HTTP-DV TLS) and attach it to the instance (KV host map +
 *     `app_instance_domains` row), reusing the same primitives as the manual attach flow.
 *  3. The $50/mo subscription itself is recorded by the existing billing webhook path
 *     (`handleCheckoutCompleted`) — this module only handles the DOMAIN side.
 *
 * Idempotency: keyed on the pending row's terminal `status`. A replayed/duplicate webhook whose
 * row is already `registered` | `registration_queued` short-circuits. Safe to re-run on `failed`.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';

import { setAppHost } from './app_host_resolver.js';
import { writeAuditLog } from './audit.js';
import { isKnownUnsupportedTld, registerDomain } from './cf_registrar.js';
import { dbExecute, dbQuery, dbQueryOne } from './db.js';
import { createCustomHostname } from './domains.js';

/** Pending purchase row shape (subset of `app_instance_domain_purchases`). */
interface PendingPurchaseRow {
  id: string;
  instance_id: string;
  org_id: string;
  domain: string;
  tld: string;
  status: string;
}

/** Instance row subset needed to route the attached hostname. */
interface InstanceRow {
  id: string;
  org_id: string;
  app_slug: string;
  subdomain: string;
}

/** Result of a completion attempt (for logging / webhook audit). */
export interface DomainPurchaseCompletion {
  readonly handled: boolean;
  readonly status: 'registered' | 'registration_queued' | 'failed' | 'skipped';
  readonly domain?: string;
  readonly reason?: string;
}

/** Resolve the Cloudflare account id (mirrors the pin used across the worker). */
function accountId(env: Env): string {
  return env.CF_ACCOUNT_ID ?? '84fa0d1b16ff8086dd958c468ce7fd59';
}

/**
 * Fulfil a paid domain purchase from a Stripe `checkout.session.completed` event.
 *
 * Looks up the pending row by Stripe session id (the idempotency key). Registers the domain at
 * CF Registrar when supported, creates + attaches the CF custom hostname, and records the outcome.
 *
 * @param env       - Worker environment (CF Registrar + custom-hostname creds, DB, KV).
 * @param sessionId - The Stripe Checkout Session id from the webhook (`obj.id`).
 * @param ownerEmail - Best-effort registrant email for the Registrar contact (org owner email).
 * @returns A {@link DomainPurchaseCompletion} describing what happened (never throws for the
 *   webhook's benefit — a registration failure is recorded as `failed`, not surfaced as a throw,
 *   so the $50/mo subscription still activates and Stripe isn't asked to retry indefinitely).
 */
export async function completeDomainPurchase(
  env: Env,
  sessionId: string,
  ownerEmail: string | null,
): Promise<DomainPurchaseCompletion> {
  const pending = await dbQueryOne<PendingPurchaseRow>(
    env.DB,
    `SELECT id, instance_id, org_id, domain, tld, status
       FROM app_instance_domain_purchases WHERE stripe_session_id = ?`,
    [sessionId],
  ).catch(() => null);

  // Not a domain-purchase session (or the pending row was never written) — nothing to do here.
  if (!pending) return { handled: false, status: 'skipped' };

  // Idempotency: already fulfilled (or terminally queued) by a prior delivery.
  if (pending.status === 'registered' || pending.status === 'registration_queued') {
    return { domain: pending.domain, handled: true, status: pending.status };
  }

  const domain = pending.domain;
  const tld = pending.tld;
  const now = () => new Date().toISOString();

  // Mark 'paid' (registration in flight) so a concurrent redelivery sees progress.
  await dbExecute(
    env.DB,
    `UPDATE app_instance_domain_purchases SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'pending'`,
    [now(), pending.id],
  ).catch(() => undefined);

  const instance = await dbQueryOne<InstanceRow>(
    env.DB,
    `SELECT id, org_id, app_slug, subdomain FROM app_instances WHERE id = ? AND deleted_at IS NULL`,
    [pending.instance_id],
  ).catch(() => null);

  // ── 1. Register at CF Registrar when the TLD is supported ────────────────────────
  let regStatus: DomainPurchaseCompletion['status'];
  let pollUrl: string | null = null;
  let reason: string | undefined;

  const cfCanRegister = !isKnownUnsupportedTld(tld);
  if (cfCanRegister) {
    const reg = await registerDomain(env, {
      account_id: accountId(env),
      // CF uses the account default registrant when contacts are sparse; we pass the owner email
      // + placeholder postal so the payload validates. WHOIS privacy (redaction) is on by default.
      contact: {
        city: 'San Francisco',
        country_code: 'US',
        email: ownerEmail ?? `org+${pending.org_id}@projectsites.dev`,
        name: 'Site Owner',
        phone: '+1.0000000000',
        postal_code: '94107',
        state: 'CA',
        street: '101 Townsend St',
      },
      domain,
      years: 1,
    });
    if (reg.ok) {
      // 'failed' state from CF is terminal-bad; 'succeeded'/'pending'/'in_progress' are OK to attach.
      if (reg.state === 'failed') {
        regStatus = 'failed';
        reason = reg.message ?? 'CF Registrar returned failed state';
      } else {
        regStatus = 'registered';
        pollUrl = reg.poll_url ?? null;
      }
    } else {
      // Unsupported TLD discovered at register time → queue for concierge; other errors → failed.
      if (reg.error === 'TLD_NOT_SUPPORTED') {
        regStatus = 'registration_queued';
        reason = reg.message ?? 'TLD not supported by CF Registrar';
      } else {
        regStatus = 'failed';
        reason = reg.message ?? `CF Registrar error (${reg.error ?? 'unknown'})`;
      }
    }
  } else {
    regStatus = 'registration_queued';
    reason = `Cloudflare Registrar does not carry .${tld} — queued for manual registration.`;
  }

  // ── 2. Create + attach the CF custom hostname (best-effort) ──────────────────────
  // We attach the hostname regardless of whether registration is done or queued: once the domain
  // resolves (registered here, or concierge points it), CF issues the cert and the site goes live.
  let sslStatus = 'pending';
  let chStatus = 'pending';
  let cfHostnameId: string | null = null;
  if (instance) {
    try {
      const cf = await createCustomHostname(env, domain);
      cfHostnameId = cf.cf_id;
      sslStatus = cf.ssl_status;
      chStatus = cf.status;
      await setAppHost(env, domain, {
        appSlug: instance.app_slug,
        instanceId: instance.id,
        orgId: instance.org_id,
        subdomain: instance.subdomain,
      }).catch(() => undefined);
    } catch (err) {
      // Non-fatal — the domain is bought; the manual attach flow / a retry can create the hostname.
      console.warn(
        JSON.stringify({
          domain,
          error: err instanceof Error ? err.message : String(err),
          instance_id: instance.id,
          level: 'warn',
          message: 'custom_hostname_attach_failed',
          service: 'domain_purchase_complete',
        }),
      );
    }

    // Persist into app_instance_domains (first domain becomes primary). Idempotent upsert on domain.
    const existing = await dbQuery<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM app_instance_domains WHERE instance_id = ?`,
      [instance.id],
    ).catch(() => ({ data: [{ n: 0 }] }));
    const isFirst = (existing.data?.[0]?.n ?? 0) === 0;
    // Domain row status mirrors the registration outcome so the UI can show "registering / queued".
    const domainRowStatus = regStatus === 'registration_queued' ? 'registration_queued' : chStatus;
    await dbExecute(
      env.DB,
      `INSERT INTO app_instance_domains
         (id, instance_id, org_id, domain, cf_hostname_id, is_primary, status, ssl_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         cf_hostname_id = excluded.cf_hostname_id, status = excluded.status,
         ssl_status = excluded.ssl_status, updated_at = excluded.updated_at`,
      [
        crypto.randomUUID(),
        instance.id,
        instance.org_id,
        domain,
        cfHostnameId,
        isFirst ? 1 : 0,
        domainRowStatus,
        sslStatus,
        now(),
        now(),
      ],
    ).catch(() => undefined);
  }

  // ── 3. Record terminal status on the pending row ─────────────────────────────────
  await dbExecute(
    env.DB,
    `UPDATE app_instance_domain_purchases
       SET status = ?, cf_poll_url = ?, error = ?, updated_at = ? WHERE id = ?`,
    [regStatus, pollUrl, reason ?? null, now(), pending.id],
  ).catch(() => undefined);

  await writeAuditLog(env.DB, {
    action: 'apps.instance.domain_purchase_completed',
    actor_id: null,
    message: `Domain purchase for '${domain}' completed with status '${regStatus}'${reason ? ` (${reason})` : ''}`,
    metadata_json: {
      cf_can_register: cfCanRegister,
      cf_poll_url: pollUrl,
      domain,
      reason: reason ?? null,
      status: regStatus,
    },
    org_id: pending.org_id,
    target_id: pending.instance_id,
    target_type: 'app_instance',
  }).catch(() => undefined);

  console.warn(
    JSON.stringify({
      domain,
      instance_id: pending.instance_id,
      level: regStatus === 'failed' ? 'error' : 'info',
      message: 'domain_purchase_completed',
      service: 'domain_purchase_complete',
      status: regStatus,
    }),
  );

  return { domain, handled: true, reason, status: regStatus };
}
