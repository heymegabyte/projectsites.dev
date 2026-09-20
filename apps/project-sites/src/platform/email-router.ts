/**
 * @module platform/email-router
 *
 * @description
 * `getEmailProvider(env)` — the single email seam (§42/ADR-0019), mirroring
 * `getJobRouter`. Builds the transactional rail (Amazon SES) and the marketing
 * rail (Listmonk) from `Env`, falling back to the §16 fakes when a rail is
 * unconfigured (no AWS creds / no Listmonk config). `sendTransactional` routes by
 * `chooseEmailPath` so callers never pick a vendor — they pick an {@link EmailKind}.
 *
 * App code calls `getEmailProvider(c.env).sendTransactional({ kind, to, subject,
 * html })`; every transactional call site sends through this seam (behind
 * `email.ses.enabled`). Deps are injectable for tests.
 *
 * @see docs/adr/0019-amazon-ses-plus-listmonk-email.md
 */

import type { Env } from '../types/env.js';
import {
  chooseEmailPath,
  FakeEmailProvider,
  FakeMarketingEmailProvider,
  type EmailProvider,
  type EmailResult,
  type MarketingEmailProvider,
  type SendEmailInput,
} from './email.js';
import { AmazonSesEmailProvider } from '../services/ses_email_provider.js';
import { ListmonkMarketingEmailProvider } from '../services/listmonk_email_provider.js';
import { isSuppressed } from '../services/email_suppressions.js';

/** Injectable rails (each defaults to an env-bound real-or-fake provider). */
export interface EmailDeps {
  readonly transactional?: EmailProvider;
  readonly marketing?: MarketingEmailProvider;
}

/** The assembled email seam. */
export interface EmailRouter {
  readonly transactional: EmailProvider;
  readonly marketing: MarketingEmailProvider;
  /** Send a transactional email; throws if `kind` is a bulk (Listmonk) kind. */
  sendTransactional(input: SendEmailInput): Promise<EmailResult>;
}

/**
 * Build the email seam from `Env`. SES when AWS creds exist (else fake); Listmonk
 * when its config exists (else fake).
 *
 * @example await getEmailProvider(c.env).sendTransactional({ kind:'receipt', to, subject, html });
 */
export function getEmailProvider(env: Env, deps: EmailDeps = {}): EmailRouter {
  const transactional: EmailProvider =
    deps.transactional ??
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? new AmazonSesEmailProvider(env)
      : new FakeEmailProvider());

  const marketing: MarketingEmailProvider =
    deps.marketing ??
    (env.LISTMONK_API_URL && env.LISTMONK_USERNAME && env.LISTMONK_PASSWORD
      ? new ListmonkMarketingEmailProvider({
          baseUrl: env.LISTMONK_API_URL,
          apiUser: env.LISTMONK_USERNAME,
          apiToken: env.LISTMONK_PASSWORD,
        })
      : new FakeMarketingEmailProvider());

  return {
    transactional,
    marketing,
    async sendTransactional(input: SendEmailInput): Promise<EmailResult> {
      if (chooseEmailPath(input.kind) !== 'ses') {
        throw new Error(
          `"${input.kind}" is a bulk kind — use the marketing campaign API, not sendTransactional`,
        );
      }
      // §42 suppression enforcement (ADR-0019): never re-send to a hard-bounced
      // or complained address. FAIL-OPEN — a suppression-lookup failure (or no
      // DB binding) must NEVER block a legitimate send, so the check is wrapped
      // and any error proceeds to the send.
      const to = Array.isArray(input.to) ? input.to[0] : input.to;
      if (to && env.DB) {
        try {
          if (await isSuppressed(env.DB, to)) {
            console.warn(
              JSON.stringify({
                level: 'info',
                service: 'email',
                message: 'send_skipped_suppressed',
                kind: input.kind,
              }),
            );
            return { id: `suppressed:${to}`, accepted: false };
          }
        } catch {
          // fail-open: proceed to send.
        }
      }
      const result = await transactional.sendTransactional(input);

      // Meter successful sends through StripeMetersProvider (Metronome-compatible).
      if (result.accepted && input.tenantId) {
        const { meterEmailSend } = await import('../services/usage_metering.js');
        void meterEmailSend(env as import('../types/env.js').Env, {
          orgId: input.tenantId,
          count: Array.isArray(input.to) ? input.to.length : 1,
        });
      }

      return result;
    },
  };
}
