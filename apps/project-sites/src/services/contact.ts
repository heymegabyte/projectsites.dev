/**
 * @module services/contact
 * @description Contact form handler that validates input and sends emails via
 * Amazon SES (primary, ADR-0019), falling back to SendGrid on failure.
 *
 * Sends two emails per submission:
 * 1. Main email to the brand contact address with all form fields.
 * 2. Confirmation email to the user acknowledging receipt.
 */

import {
  BRAND,
  contactFormSchema,
  badRequest,
  internalError,
  escapeHtml,
} from '@project-sites/shared';
import type { ContactForm } from '@project-sites/shared';
import type { Env } from '../types/env.js';
import { getEmailProvider } from '../platform/email-router.js';
import { hasDeliverableMx } from './email_deliverability.js';
import { dbInsert } from './db.js';
import { log } from '../lib/log.js';

const contactLog = log.child('contact');

/* ------------------------------------------------------------------ */
/*  Email Sending (SES primary, SendGrid fallback)                    */
/* ------------------------------------------------------------------ */

interface EmailOpts {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

async function sendViaSendGrid(apiKey: string, opts: EmailOpts): Promise<void> {
  const body: Record<string, unknown> = {
    personalizations: [{ to: [{ email: opts.to }] }],
    from: { email: 'noreply@projectsites.dev', name: 'Project Sites' },
    subject: opts.subject,
    content: [{ type: 'text/html', value: opts.html }],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    },
  };
  if (opts.replyTo) body.reply_to = { email: opts.replyTo };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    void text;
    contactLog.error('sendgrid_api_error', { status: res.status });
    throw badRequest(`Failed to send email (status ${res.status}).`);
  }
}

async function sendEmail(env: Env, opts: EmailOpts): Promise<void> {
  const failures: string[] = [];

  // ADR-0019: SES is the PRIMARY rail when configured (AWS creds + verified
  // sender). `replyTo` (the submitter) rides through so the brand can reply
  // straight to the lead. CRITICAL: fall back to SendGrid on SES
  // FAILURE, not just on absence — a transient SES 5xx must never abort the
  // submission and lose the lead (the same fallback-on-absence-not-failure bug
  // fixed in notifications.ts). Progressive degradation by env, no flag.
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.SES_FROM_EMAIL) {
    try {
      await getEmailProvider(env).sendTransactional({
        kind: 'transactional',
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        replyTo: opts.replyTo,
      });
      return;
    } catch (err) {
      failures.push(`SES: ${err instanceof Error ? err.message : String(err)}`);
      contactLog.warn('ses_send_failed_falling_back', {
        error: err instanceof Error ? err.message : String(err),
      });
      // fall through to SendGrid
    }
  }

  if (env.SENDGRID_API_KEY) {
    return await sendViaSendGrid(env.SENDGRID_API_KEY, opts);
  }

  throw badRequest(
    failures.length > 0
      ? `Email delivery failed on all configured providers (${failures.join('; ')}).`
      : 'Email delivery is not configured. Please contact support.',
  );
}

function buildContactNotificationEmail(data: ContactForm): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:transparent;color:#e2e8f0;padding:8px 4px;">
  <div style="max-width:640px;margin:0 auto;background:#161635;border-radius:12px;padding:32px 28px;border:1px solid rgba(80,165,219,0.1);">
    <div style="text-align:center;margin-bottom:24px;">
      <img src="https://projectsites.dev/logo-header.png" alt="Project Sites" style="max-height:44px;max-width:260px;height:auto;" />
    </div>
    <h1 style="color:#50a5db;font-size:24px;margin:0 0 20px;">New Contact Form Submission</h1>
    <table style="width:100%;color:#94a3b8;font-size:14px;line-height:1.8;border-collapse:collapse;">
      <tr><td style="font-weight:700;color:#e2e8f0;padding:6px 16px 6px 0;vertical-align:top;">Name:</td><td style="padding:6px 0;">${escapeHtml(data.name)}</td></tr>
      <tr><td style="font-weight:700;color:#e2e8f0;padding:6px 16px 6px 0;vertical-align:top;">Email:</td><td style="padding:6px 0;"><a href="mailto:${escapeHtml(data.email)}" style="color:#50a5db;text-decoration:none;">${escapeHtml(data.email)}</a></td></tr>
      ${data.phone ? `<tr><td style="font-weight:700;color:#e2e8f0;padding:6px 16px 6px 0;vertical-align:top;">Phone:</td><td style="padding:6px 0;">${escapeHtml(data.phone)}</td></tr>` : ''}
    </table>
    <hr style="border:none;border-top:1px solid rgba(80,165,219,0.1);margin:20px 0;">
    <p style="font-weight:700;color:#e2e8f0;font-size:14px;margin:0 0 8px;">Message:</p>
    <p style="color:#94a3b8;line-height:1.7;white-space:pre-wrap;margin:0;">${escapeHtml(data.message)}</p>
  </div>
</body>
</html>`.trim();
}

function buildContactConfirmationEmail(data: ContactForm): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:transparent;color:#e2e8f0;padding:8px 4px;">
  <div style="max-width:640px;margin:0 auto;background:#161635;border-radius:12px;padding:32px 28px;border:1px solid rgba(80,165,219,0.1);">
    <div style="text-align:center;margin-bottom:24px;">
      <img src="https://projectsites.dev/logo-header.png" alt="Project Sites" style="max-height:44px;max-width:260px;height:auto;" />
    </div>
    <h1 style="color:#50a5db;font-size:24px;margin:0 0 16px;">Thanks for reaching out!</h1>
    <p style="color:#94a3b8;line-height:1.6;margin:0 0 12px;">Hi ${escapeHtml(data.name)},</p>
    <p style="color:#94a3b8;line-height:1.6;margin:0 0 24px;">We've received your message and will get back to you shortly. Here's a copy of what you sent:</p>
    <div style="background:rgba(80,165,219,0.05);border-radius:8px;padding:16px;border:1px solid rgba(80,165,219,0.08);">
      <p style="color:#94a3b8;line-height:1.6;white-space:pre-wrap;margin:0;font-size:13px;">${escapeHtml(data.message)}</p>
    </div>
    <p style="color:#64748b;font-size:13px;margin:24px 0 0;">&mdash; The Project Sites Team</p>
  </div>
</body>
</html>`.trim();
}

/* ------------------------------------------------------------------ */
/*  Public handler                                                     */
/* ------------------------------------------------------------------ */

/**
 * Validate + dispatch a contact-form submission as two transactional emails.
 *
 * @remarks
 * Email 1 lands in `BRAND.CONTACT_EMAIL` with `replyTo` set to the user's
 * address so a single reply round-trips. Email 2 is the user's receipt.
 * Provider order: SES primary → SendGrid (each falls back on failure).
 *
 * @example
 * ```ts
 * await handleContactForm(env, await c.req.json());
 * ```
 *
 * @throws {AppError} `BAD_REQUEST` when input fails `contactFormSchema`
 *   validation, when both providers are unconfigured, or when delivery
 *   returns a non-2xx status.
 */
export async function handleContactForm(env: Env, input: unknown): Promise<void> {
  const validated = contactFormSchema.parse(input);

  // Capture 1 (PRIMARY, durable): persist the lead to the `contacts` CRM table
  // FIRST. A platform contact IS a business lead — it must survive even if every
  // email rail fails (email-only was losing leads on an all-rail outage). Mirrors
  // the per-site form's persist-first model (search.ts). This is an org-less
  // endpoint, so the lead belongs to the seeded `system` sentinel org (the same
  // convention this route's audit log already uses) with no owning site.
  // Best-effort: log a drop but keep going — the team-email below is a second
  // capture channel, and we honest-fail only if BOTH miss (guard after Email 1).
  let persisted = false;
  const { error: contactErr } = await dbInsert(env.DB, 'contacts', {
    id: crypto.randomUUID(),
    org_id: 'system',
    site_id: null,
    name: validated.name,
    email: validated.email,
    phone: validated.phone ?? null,
    source: 'form',
    metadata: JSON.stringify({ message: validated.message, channel: 'platform_contact' }),
  });
  if (contactErr) {
    contactLog.error('contact_persist_failed', { error: contactErr });
  } else {
    persisted = true;
  }

  // Capture 2 (notification): email the team — BEST-EFFORT. The lead is already
  // durably captured above, so a transient email failure must NOT error the
  // visitor (an error triggers a resubmit → duplicate lead). Log + continue.
  let notified = false;
  try {
    await sendEmail(env, {
      to: BRAND.CONTACT_EMAIL,
      subject: `Contact Form: ${validated.name}`,
      html: buildContactNotificationEmail(validated),
      replyTo: validated.email,
    });
    notified = true;
  } catch (err) {
    contactLog.warn('team_notification_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Honest failure ONLY when the lead was captured NOWHERE (D1 write dropped AND
  // every email rail failed — a full outage) — never a lying success that
  // silently drops a business lead. The visitor sees a 5xx and can retry.
  if (!persisted && !notified) {
    throw internalError(
      'We could not record your message right now. Please try again in a moment.',
    );
  }

  // Confirmation to the user — guarded by a reply-deliverability check
  // (#121). Skip the auto-receipt when the submitter's domain can't receive mail
  // (fake/typo domain, NXDOMAIN, no MX) so a hard bounce never dents our sender
  // reputation. The team still got Email 1 with the reply-to. Fail-open on DoH
  // errors so a transient lookup hiccup never drops a legit receipt.
  const recipientDomain = validated.email.split('@')[1] ?? '';
  const deliverable = await hasDeliverableMx(fetch, recipientDomain);
  if (!deliverable) {
    contactLog.warn('receipt_skipped_undeliverable', { domain: recipientDomain });
    return;
  }
  // Best-effort receipt: the lead is already captured, so a failed receipt send
  // must not error the visitor (their message WAS received).
  try {
    await sendEmail(env, {
      to: validated.email,
      subject: 'We received your message — Project Sites',
      html: buildContactConfirmationEmail(validated),
    });
  } catch (err) {
    contactLog.warn('receipt_send_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
