/**
 * @module services/notifications
 * @description Transactional email notifications for domain verification and site builds.
 *
 * Rail order (ADR-0019, Resend removed 2026-09-09 per Brian directive — SES is THE
 * provider): Amazon SES is the PRIMARY + canonical rail (AWS creds + verified
 * `SES_FROM_EMAIL`) — routed via `getEmailProvider(env).sendTransactional`. SendGrid
 * remains ONLY as a break-glass fallback if SES is unconfigured. No feature flag —
 * progressive degradation by env presence.
 *
 * Every fallback-rail call (success or failure) emits a structured log with
 * `{provider, status, body_excerpt, to, request_id, category}` so the operator
 * can grep the Workers tail for delivery failures without re-running the send.
 * Failures also fan out to Sentry (`captureMessage(... send failed, …)`) for
 * the high-signal alerting channel; successes drop a Sentry breadcrumb
 * (`category: 'email'`) so the next captured exception in the same request
 * carries the delivery context.
 */

import { DOMAINS } from '@project-sites/shared';

import type { Env } from '../types/env.js';
import { log } from '../lib/log.js';
import { getEmailProvider, type EmailRouter } from '../platform/email-router.js';
import type { EmailKind } from '../platform/email.js';
import { isSuppressed } from './email_suppressions.js';

/**
 * Map a free-form notification category to an {@link EmailKind} for the SES rail
 * (ADR-0019). Unknown categories are transactional.
 */
export function categoryToEmailKind(category: string): EmailKind {
  switch (category) {
    case 'magic_link':
      return 'magic-link';
    case 'claim_verification':
      return 'claim-verification';
    case 'receipt':
      return 'receipt';
    case 'billing_alert':
      return 'billing-alert';
    case 'domain_verified':
      return 'domain-verification';
    default:
      return 'transactional';
  }
}

interface EmailOpts {
  to: string;
  subject: string;
  html: string;
  /**
   * Free-form tag for log / Sentry attribution. Defaults to `'transactional'`;
   * callers SHOULD pass `'invite'` / `'magic_link'` / `'domain_verified'` /
   * `'site_built'` so the dashboards can pivot per category.
   */
  category?: string;
}

/**
 * Send an email via Amazon SES (the canonical provider), with SendGrid as a
 * break-glass fallback only when SES is unconfigured. Resend was removed
 * 2026-09-09 (Brian directive; it could never send the `noreply@projectsites.dev`
 * from-domain — only `megabyte.space` was verified in Resend).
 *
 * Wiring rules:
 *   - SES send goes through `getEmailProvider(env).sendTransactional`; on failure
 *     it falls through to SendGrid (if configured) and logs under `provider:'ses'`.
 *   - SendGrid fallback path logs under `provider: 'sendgrid'` so the operator can
 *     see which rail delivered.
 *
 * @throws Error when SES (and the SendGrid fallback, if configured) both fail.
 *   Caller-side `.catch(() => {})` policy is preserved upstream.
 */
export async function sendEmail(
  env: Env,
  opts: EmailOpts,
  deps: { email?: EmailRouter } = {},
): Promise<void> {
  const category = opts.category ?? 'transactional';

  // §42/ADR-0019 suppression enforcement — for ALL rails. The SES rail's EmailRouter
  // already checks this, but the raw Resend/SendGrid fallback `fetch`es below BYPASSED
  // it, so a fallback send (SES throttled/failed) could re-send to a hard-bounced or
  // complained address — damaging the shared sending domain's reputation (SES/Resend
  // suspend on high bounce/complaint rates). Checking once here at the seam covers every
  // rail. FAIL-OPEN: a lookup error (or no DB binding) proceeds to send — a suppression
  // hiccup must NEVER block a legitimate transactional email (e.g. magic-link login).
  if (env.DB) {
    try {
      if (await isSuppressed(env.DB, opts.to)) {
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'notifications',
            category,
            message: 'send_skipped_suppressed',
            to: opts.to,
          }),
        );
        return;
      }
    } catch {
      /* fail-open: proceed to send */
    }
  }

  // ADR-0019 progressive-degradation: every CONFIGURED rail is tried in order
  // (SES → SendGrid); a rail that FAILS falls through to the next. We throw
  // only when EVERY configured rail has failed — a single-provider outage (e.g. a SES
  // send-quota throttle) must NOT fail transactional email (magic-link login) while
  // another configured rail is still available. Previously the SES/SendGrid failure
  // paths threw immediately, so the documented fallback never actually kicked in.
  const failures: string[] = [];

  // 1. Amazon SES — PRIMARY the moment it is configured (AWS creds + verified sender).
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.SES_FROM_EMAIL) {
    try {
      const email = deps.email ?? getEmailProvider(env);
      await email.sendTransactional({
        kind: categoryToEmailKind(category),
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      return;
    } catch (err) {
      const excerpt = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      failures.push(`ses(${excerpt})`);
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'notifications',
          provider: 'ses',
          category,
          message: 'SES send failed — falling through to SendGrid',
          body_excerpt: excerpt,
          to: opts.to,
          subject: opts.subject,
        }),
      );
      log.error('SES send failed', {
        provider: 'ses',
        category,
        to: opts.to,
        subject: opts.subject,
        body_excerpt: excerpt,
      });
    }
  }

  // 2. SendGrid fallback (break-glass only — SES is the canonical provider; Resend removed 2026-09-09).
  if (env.SENDGRID_API_KEY) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: opts.to }] }],
          from: { email: 'noreply@projectsites.dev', name: 'Project Sites' },
          subject: opts.subject,
          content: [{ type: 'text/html', value: opts.html }],
        }),
      });
      const requestId = res.headers.get('x-message-id') ?? res.headers.get('x-request-id');
      if (!res.ok) {
        const bodyExcerpt = (await res.text()).slice(0, 400);
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'notifications',
            provider: 'sendgrid',
            category,
            message: 'SendGrid send failed',
            status: res.status,
            body_excerpt: bodyExcerpt,
            to: opts.to,
            subject: opts.subject,
            request_id: requestId,
          }),
        );
        log.error('SendGrid invite send failed', {
          provider: 'sendgrid',
          category,
          status: res.status,
          to: opts.to,
          subject: opts.subject,
          request_id: requestId,
          body_excerpt: bodyExcerpt,
        });
        failures.push(`sendgrid ${res.status}`);
      } else {
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'notifications',
            provider: 'sendgrid',
            category,
            message: 'SendGrid send ok',
            status: res.status,
            body_excerpt: '',
            to: opts.to,
            subject: opts.subject,
            request_id: requestId,
          }),
        );
        log.info('SendGrid invite sent', {
          provider: 'sendgrid',
          category,
          to: opts.to,
          subject: opts.subject,
          request_id: requestId,
        });
        return;
      }
    } catch (err) {
      const excerpt = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      failures.push(`sendgrid(${excerpt})`);
      log.error('SendGrid invite send failed', {
        provider: 'sendgrid',
        category,
        to: opts.to,
        subject: opts.subject,
        body_excerpt: excerpt,
      });
    }
  }

  // Every configured rail failed → surface it (callers apply their own .catch()).
  // If NONE was configured, preserve the historical warn-and-return no-op.
  if (failures.length > 0) {
    throw new Error(`All email providers failed: ${failures.join('; ')}`);
  }
  console.warn(
    JSON.stringify({
      level: 'warn',
      service: 'notifications',
      category,
      message: 'No email provider configured',
      to: opts.to,
    }),
  );
}

// ─── Brand palette (matches src/auth/email-templates.ts + brand doctrine) ───
// #060610 near-black · #00E5FF cyan · #50AAE3 blue · #7C3AED violet.
const BRAND = {
  bg: '#060610',
  ink: '#f4f4ff',
  muted: '#9aa6c4',
  faint: '#5b6484',
  cyan: '#00E5FF',
  blue: '#50AAE3',
  violet: '#7C3AED',
  green: '#34e5b0',
  line: 'rgba(0,229,255,0.14)',
} as const;
const FONT_HEAD =
  "'Space Grotesk','Sora',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_BODY =
  "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/**
 * A glowing gradient "orb" badge holding an emoji / HTML-entity glyph — the
 * delightful hero moment at the top of every email. Table-based so Outlook
 * still renders the gradient fill (the glow shadow degrades gracefully).
 */
function emailBadge(glyph: string, from: string = BRAND.cyan, to: string = BRAND.violet): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px;"><tr><td align="center" valign="middle" width="66" height="66" style="width:66px;height:66px;border-radius:50%;background:linear-gradient(135deg,${from} 0%,${to} 100%);box-shadow:0 10px 34px rgba(0,229,255,0.34),0 0 0 7px rgba(0,229,255,0.06);text-align:center;font-size:28px;line-height:66px;color:#060610;">${glyph}</td></tr></table>`;
}

/**
 * Gorgeous cyan→violet gradient CTA button with a bulletproof VML fallback so
 * Outlook renders a solid rounded cyan button instead of stripping the gradient.
 */
function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:6px auto 2px;"><tr><td align="center" style="border-radius:12px;background:linear-gradient(135deg,${BRAND.cyan} 0%,${BRAND.violet} 100%);box-shadow:0 12px 30px rgba(124,58,237,0.42);">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:280px;" arcsize="24%" fillcolor="#00E5FF" stroke="f"><w:anchorlock/><center style="color:#060610;font-family:sans-serif;font-size:15px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" style="display:inline-block;padding:15px 42px;color:#060610;font-family:${FONT_HEAD};font-size:15px;font-weight:700;letter-spacing:0.2px;text-decoration:none;border-radius:12px;">${label}</a><!--<![endif]-->
</td></tr></table>`;
}

/**
 * Inset "detail card" — a dark panel with a cyan hairline used to present
 * key/value build metadata, domain lists, etc.
 */
function emailCard(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(0,229,255,0.04);border:1px solid ${BRAND.line};border-radius:14px;margin-bottom:18px;"><tr><td style="padding:18px 20px;">${inner}</td></tr></table>`;
}

/** Small uppercase eyebrow label used inside detail cards. */
function emailLabel(text: string): string {
  return `<div style="font-family:${FONT_MONO};font-size:11px;color:${BRAND.cyan};text-transform:uppercase;letter-spacing:1.6px;margin-bottom:12px;">${text}</div>`;
}

/**
 * Email wrapper — the gorgeous, on-brand dark shell every transactional email
 * shares: #060610 canvas with a cyan glow, a cyan→violet accent bar, the logo,
 * the content slot, and a refined footer.
 */
function emailWrap(content: string, preheader?: string): string {
  const logoImg = 'https://public.megabyte.space/project-sites-logo.png';
  const siteUrl = `https://${DOMAINS.SITES_BASE}`;
  const year = new Date().getFullYear();
  return `<!DOCTYPE html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>Project Sites</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  @media only screen and (max-width:600px) {
    .email-container { width:100% !important; }
    .email-padding { padding:26px 20px !important; }
  }
  a { color:${BRAND.cyan}; }
  a:hover { color:${BRAND.blue}; }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:${FONT_BODY};color:${BRAND.ink};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;line-height:1.6;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}${'&nbsp;&zwnj;'.repeat(60)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:radial-gradient(900px 520px at 50% -8%,rgba(0,229,255,0.10),transparent 62%),${BRAND.bg};">
<tr><td align="center" style="padding:36px 16px;">
<table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(162deg,#0b0b24 0%,#0a0a1c 58%,#08081a 100%);border:1px solid ${BRAND.line};border-radius:22px;max-width:600px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.6),0 0 0 1px rgba(0,229,255,0.05);overflow:hidden;">
<!-- Accent bar -->
<tr><td style="height:4px;line-height:4px;font-size:0;background:linear-gradient(90deg,${BRAND.cyan} 0%,${BRAND.blue} 46%,${BRAND.violet} 100%);">&nbsp;</td></tr>
<!-- Logo -->
<tr><td class="email-padding" style="padding:34px 32px 0;text-align:center;">
  <a href="${siteUrl}" style="text-decoration:none;">
    <img src="${logoImg}" alt="Project Sites" width="216" height="53" style="border:0;display:inline-block;max-width:216px;height:auto;filter:drop-shadow(0 4px 18px rgba(0,229,255,0.25));" />
  </a>
</td></tr>
<!-- Gradient divider -->
<tr><td style="padding:22px 32px 0;"><div style="height:1px;background:linear-gradient(90deg,transparent 0%,rgba(0,229,255,0.28) 30%,rgba(124,58,237,0.20) 70%,transparent 100%);"></div></td></tr>
<!-- Content -->
<tr><td class="email-padding" style="padding:30px 32px;">
${content}
</td></tr>
<!-- Footer -->
<tr><td style="padding:0 32px 30px;">
  <div style="padding-top:22px;border-top:1px solid rgba(0,229,255,0.08);text-align:center;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="text-align:center;padding-bottom:12px;">
        <a href="https://x.com/HeyMegabyte" style="text-decoration:none;margin:0 9px;color:${BRAND.faint};font-size:12px;font-weight:600;">Twitter</a>
        <span style="color:rgba(91,100,132,0.4);">&middot;</span>
        <a href="https://github.com/HeyMegabyte" style="text-decoration:none;margin:0 9px;color:${BRAND.faint};font-size:12px;font-weight:600;">GitHub</a>
        <span style="color:rgba(91,100,132,0.4);">&middot;</span>
        <a href="https://linkedin.com/company/megabyte-labs" style="text-decoration:none;margin:0 9px;color:${BRAND.faint};font-size:12px;font-weight:600;">LinkedIn</a>
      </td></tr>
      <tr><td style="text-align:center;">
        <span style="font-size:11px;color:rgba(154,166,196,0.45);">&copy; ${year} </span>
        <a href="https://megabyte.space" style="font-size:11px;color:rgba(154,166,196,0.55);text-decoration:none;">Megabyte Labs</a>
        <span style="font-size:11px;color:rgba(154,166,196,0.4);"> &middot; </span>
        <a href="${siteUrl}" style="font-size:11px;color:${BRAND.cyan};text-decoration:none;font-weight:700;">projectsites.dev</a>
      </td></tr>
    </table>
  </div>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

/**
 * Send domain verification success notification.
 */
export async function notifyDomainVerified(
  env: Env,
  opts: {
    email: string;
    hostname: string;
    primaryDomain: string | null;
    defaultDomain: string;
    siteName: string;
  },
): Promise<void> {
  const html = emailWrap(
    `
    ${emailBadge('&#10003;', BRAND.green, BRAND.blue)}
    <h1 style="color:${BRAND.ink};font-family:${FONT_HEAD};font-size:26px;font-weight:700;text-align:center;margin:0 0 10px;letter-spacing:-0.02em;">Your domain is connected</h1>
    <p style="color:${BRAND.muted};font-size:15px;text-align:center;line-height:1.65;margin:0 0 24px;">
      <strong style="color:${BRAND.ink};">${opts.siteName}</strong> now answers at
      <strong style="color:${BRAND.cyan};">${opts.hostname}</strong> &mdash; live and secured with SSL. &#127881;
    </p>
    ${emailCard(`
      ${emailLabel('Your domains')}
      <div style="margin-bottom:10px;font-size:14px;">
        <span style="color:${BRAND.green};">&#9679;</span>
        <span style="color:${BRAND.ink};font-weight:600;"> ${opts.primaryDomain || opts.hostname}</span>
        <span style="color:${BRAND.cyan};font-family:${FONT_MONO};font-size:10px;letter-spacing:1px;margin-left:6px;">PRIMARY</span>
      </div>
      <div style="font-size:14px;">
        <span style="color:${BRAND.faint};">&#9679;</span>
        <span style="color:${BRAND.muted};"> ${opts.defaultDomain}</span>
        <span style="color:${BRAND.faint};font-family:${FONT_MONO};font-size:10px;letter-spacing:1px;margin-left:6px;">DEFAULT</span>
      </div>
    `)}
    <p style="color:${BRAND.faint};font-size:12.5px;line-height:1.6;margin:0;">
      <strong style="color:${BRAND.muted};">How it works:</strong> your <strong>primary</strong> domain is the main URL visitors see &mdash; every other domain (including your free subdomain) redirects to it. Change it anytime from your dashboard.
    </p>
  `,
    `${opts.hostname} is connected to ${opts.siteName} — live and SSL-secured.`,
  );

  await sendEmail(env, {
    to: opts.email,
    subject: `Domain connected: ${opts.hostname}`,
    html,
    category: 'domain_verified',
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'notifications',
        category: 'domain_verified',
        message: 'Failed to send domain verified email',
        to: opts.email,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
}

/**
 * Send site build completion notification.
 */
export async function notifySiteBuilt(
  env: Env,
  opts: {
    email: string;
    siteName: string;
    slug: string;
    siteUrl: string;
    version: string;
    pagesGenerated?: number;
  },
): Promise<void> {
  const html = emailWrap(
    `
    ${emailBadge('&#9889;')}
    <h1 style="color:${BRAND.ink};font-family:${FONT_HEAD};font-size:27px;font-weight:700;text-align:center;margin:0 0 10px;letter-spacing:-0.02em;">Your site is live! &#127881;</h1>
    <p style="color:${BRAND.muted};font-size:15px;text-align:center;line-height:1.65;margin:0 0 24px;">
      <strong style="color:${BRAND.ink};">${opts.siteName}</strong> has been built and published. Take it for a spin &mdash; it's ready for the world.
    </p>
    ${emailCard(`
      ${emailLabel('Build details')}
      <div style="font-size:14px;color:${BRAND.muted};margin-bottom:10px;">
        <span style="color:${BRAND.faint};">URL</span><br/>
        <a href="${opts.siteUrl}" style="color:${BRAND.cyan};text-decoration:none;font-weight:600;word-break:break-all;">${opts.siteUrl}</a>
      </div>
      <div style="font-size:14px;color:${BRAND.muted};margin-bottom:${opts.pagesGenerated ? '10px' : '0'};">
        <span style="color:${BRAND.faint};">Version</span>
        <span style="color:${BRAND.ink};font-family:${FONT_MONO};font-size:12.5px;"> ${opts.version}</span>
      </div>
      ${opts.pagesGenerated ? `<div style="font-size:14px;color:${BRAND.muted};"><span style="color:${BRAND.faint};">Pages</span> <span style="color:${BRAND.ink};font-weight:600;">${opts.pagesGenerated} generated</span></div>` : ''}
    `)}
    ${emailButton(opts.siteUrl, 'Visit your site &#8594;')}
  `,
    `${opts.siteName} is live at ${opts.siteUrl}`,
  );

  await sendEmail(env, {
    to: opts.email,
    subject: `Site published: ${opts.siteName}`,
    html,
    category: 'site_built',
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'notifications',
        category: 'site_built',
        message: 'Failed to send site built email',
        to: opts.email,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
}

/**
 * Send an organisation invite email to the prospective collaborator.
 *
 * Delegates to {@link sendEmail} under `category: 'invite'`, so the full
 * structured-log + Sentry-breadcrumb instrumentation applies. Failures are
 * swallowed at the caller (best-effort delivery) — Sentry already has the
 * error event for the alerting pipeline.
 *
 * @param env  - Worker bindings.
 * @param opts - Invite metadata: recipient email, org name, inviter name,
 *   single-use accept URL, optional role.
 */
export async function sendInviteEmail(
  env: Env,
  opts: {
    email: string;
    orgName: string;
    inviterName: string;
    acceptUrl: string;
    role?: 'owner' | 'admin' | 'member' | 'viewer';
  },
): Promise<void> {
  const role = opts.role ?? 'member';
  const html = emailWrap(
    `
    ${emailBadge('&#9993;')}
    <h1 style="color:${BRAND.ink};font-family:${FONT_HEAD};font-size:26px;font-weight:700;text-align:center;margin:0 0 10px;letter-spacing:-0.02em;">You're invited</h1>
    <p style="color:${BRAND.muted};font-size:15px;text-align:center;line-height:1.65;margin:0 0 24px;">
      <strong style="color:${BRAND.ink};">${opts.inviterName}</strong> invited you to join
      <strong style="color:${BRAND.cyan};">${opts.orgName}</strong> on Project Sites as <strong style="color:${BRAND.ink};">${role}</strong>.
    </p>
    ${emailButton(opts.acceptUrl, 'Accept invitation')}
    <p style="color:${BRAND.faint};font-size:12.5px;text-align:center;margin:18px 0 0;line-height:1.6;">
      Or paste this link into your browser:<br/>
      <a href="${opts.acceptUrl}" style="color:${BRAND.muted};word-break:break-all;text-decoration:none;">${opts.acceptUrl}</a>
    </p>
  `,
    `${opts.inviterName} invited you to ${opts.orgName} on Project Sites.`,
  );

  await sendEmail(env, {
    to: opts.email,
    subject: `${opts.inviterName} invited you to ${opts.orgName}`,
    html,
    category: 'invite',
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'notifications',
        category: 'invite',
        message: 'Failed to send invite email',
        to: opts.email,
        error: String(err),
      }),
    );
  });
}
