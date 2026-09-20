/**
 * @module services/ses_email_provider
 *
 * @description
 * `AmazonSesEmailProvider` — the real transactional {@link EmailProvider} (§42/
 * ADR-0019). SES v2 `SendEmail` over a SigV4-signed POST (Web Crypto, no AWS SDK,
 * Workers-native). This is the canonical transactional rail every call site sends
 * through (behind `email.ses.enabled`).
 *
 * `fetchImpl` + `now` are injectable for deterministic tests; prod uses global
 * `fetch` + the wall clock. Missing creds → a clear configuration error (the
 * caller degrades behind the flag per progressive-degradation).
 *
 * @see docs/adr/0019-amazon-ses-plus-listmonk-email.md
 * @see platform/aws-sigv4.ts
 */

import type { Env } from '../types/env.js';
import { signRequestV4 } from '../platform/aws-sigv4.js';
import {
  EmailInputError,
  type EmailProvider,
  type EmailResult,
  type SendEmailInput,
} from '../platform/email.js';

type SesEnv = Pick<
  Env,
  'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY' | 'AWS_DEFAULT_REGION' | 'SES_FROM_EMAIL'
>;

export interface SesDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `{ amzDate: YYYYMMDDTHHMMSSZ, dateStamp: YYYYMMDD }` from a Date (UTC). */
function amzTimestamps(d: Date): { amzDate: string; dateStamp: string } {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return { amzDate: `${y}${mo}${da}T${h}${mi}${s}Z`, dateStamp: `${y}${mo}${da}` };
}

export class AmazonSesEmailProvider implements EmailProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly env: SesEnv,
    deps: SesDeps = {},
  ) {
    // Bind the global `fetch` to `globalThis`: assigning the bare native fetch to an
    // instance field and calling it as `this.fetchImpl(...)` invokes it with
    // `this === this provider`, which the Workers runtime rejects with
    // "Illegal invocation: function called with incorrect `this` reference" — so every
    // real SES send failed (magic-link login, build emails). An injected mock is used as-is.
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    this.now = deps.now ?? (() => new Date());
  }

  async sendTransactional(input: SendEmailInput): Promise<EmailResult> {
    const recipients = Array.isArray(input.to) ? [...input.to] : [input.to];
    if (recipients.length === 0 || recipients.some((r) => !r || !/.+@.+\..+/.test(r))) {
      throw new EmailInputError('valid recipient(s) required', 'to');
    }
    if (!input.subject) throw new EmailInputError('subject required', 'subject');
    if (!input.html) throw new EmailInputError('html required', 'html');

    const accessKeyId = this.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = this.env.AWS_SECRET_ACCESS_KEY;
    const from = input.from ?? this.env.SES_FROM_EMAIL;
    if (!accessKeyId || !secretAccessKey)
      throw new Error('SES not configured: missing AWS credentials');
    if (!from) throw new Error('SES not configured: missing SES_FROM_EMAIL');

    const region = this.env.AWS_DEFAULT_REGION || 'us-east-1';
    const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
    const extraHeaders = input.headers
      ? Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value: String(Value) }))
      : [];
    const body = JSON.stringify({
      FromEmailAddress: from,
      Destination: { ToAddresses: recipients },
      ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: input.html, Charset: 'UTF-8' } },
          ...(extraHeaders.length ? { Headers: extraHeaders } : {}),
        },
      },
    });

    const { amzDate, dateStamp } = amzTimestamps(this.now());
    const headers = await signRequestV4({
      method: 'POST',
      url,
      region,
      service: 'ses',
      accessKeyId,
      secretAccessKey,
      body,
      headers: { 'content-type': 'application/json' },
      amzDate,
      dateStamp,
    });

    const res = await this.fetchImpl(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SES send failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { MessageId?: string };
    return { id: json.MessageId ?? input.idempotencyKey ?? `ses_${amzDate}`, accepted: true };
  }
}
