/**
 * @module libs/features/contact_newsletter/handlers
 *
 * @description
 * Public form-ingest endpoints that generated sites POST to: the **contact
 * form** (persist a lead to `contacts` + `form_submissions`, deliver to the
 * owner via SES→SendGrid→Resend + an in-app bell) and the **newsletter
 * double-opt-in subscribe** (feeds `newsletter_subscribers`). Both are public +
 * guest-reachable and Zod-validated; both are persist-first + error-checked so a
 * delivery/provider failure never becomes a lying-success and never loses a lead.
 *
 * | Method | Path                      | Auth   | Purpose                                                   |
 * | ------ | ------------------------- | ------ | -------------------------------------------------------- |
 * | POST   | /api/contact-form/:slug   | public | Persist + deliver a generated-site contact submission    |
 * | POST   | /api/newsletter/subscribe | public | Native double-opt-in newsletter subscribe                |
 *
 * Extracted VERBATIM from the `search.ts` monolith (route-decomposition
 * installment 23) — only the route-registration receiver changed (`search.` →
 * `contactNewsletter.`) and each handler's dynamic `import('../services/…')` was
 * re-pathed to `../../../src/services/…` for the new module depth. The
 * exclusive `contactFormSchema` + `escapeHtml` (from shared) + `getEmailProvider`
 * (from email-router) deps all moved here and left search.ts. The
 * SES→SendGrid→Resend delivery chain is preserved byte-for-
 * byte (Resend/SendGrid are INTENTIONAL live fallbacks behind SES per ADR-0019,
 * NOT the removed integration). No `onError` (handlers return explicit JSON /
 * catch to 500), matching the original.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { contactFormSchema, escapeHtml } from '@project-sites/shared';
import { getEmailProvider } from '../../../src/platform/email-router.js';
import type { Env, Variables } from '../../../src/types/env.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const contactNewsletter = new Hono<AppContext>();

/**
 * Contact form handler — receives submissions from generated sites and forwards
 * them via SES/SendGrid/Resend to the business email.
 */
contactNewsletter.post('/api/contact-form/:slug', async (c) => {
  const slug = c.req.param('slug');

  // Validate against the canonical contactFormSchema (shared) instead of a manual
  // truthy check: enforces a real email format (raw value flows into the email
  // reply_to), length caps (name 200 / message 5000 / phone 20 — abuse + cost),
  // a 10-char message floor, and script/javascript: refinements (defense-in-depth
  // atop the escapeHtml below). safeParse → 400 (fail-soft), never throws.
  const parsed = contactFormSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid contact form submission',
        },
      },
      400,
    );
  }
  const body = parsed.data;

  try {
    const { dbQueryOne } = await import('../../../src/services/db.js');
    const site = await dbQueryOne<{
      id: string;
      org_id: string;
      business_name: string;
      contact_email?: string;
    }>(
      c.env.DB,
      'SELECT id, org_id, business_name, contact_email FROM sites WHERE slug = ? AND deleted_at IS NULL',
      [slug],
    );
    if (!site) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

    // Persist a durable `contacts` row FIRST — the CRM record the owner sees in
    // /admin analytics (contacts total + bySource). The email + in-app bell below
    // are best-effort DELIVERY on top; a real submission must never be lost to an
    // email misconfig or provider failure. Error-checked → never a lying-success;
    // failure logs, never throws (the submitter's response is unaffected).
    if (site.org_id) {
      const { dbInsert } = await import('../../../src/services/db.js');
      const { error: contactErr } = await dbInsert(c.env.DB, 'contacts', {
        id: crypto.randomUUID(),
        org_id: site.org_id,
        site_id: site.id,
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        source: 'form',
        metadata: JSON.stringify({ message: body.message, slug }),
      });
      if (contactErr) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'contact-form',
            message: 'contacts_persist_failed',
            slug,
            site_id: site.id,
            error: contactErr,
          }),
        );
      }

      // ALSO mirror the lead into `form_submissions` — the table the owner's
      // /admin Forms inbox actually reads (ai_admin.ts GET /sites/:id/form-submissions).
      // The `contacts` write above is durable CRM capture, but NO admin surface
      // reads `contacts`, so generated-site contact-form leads were invisible in
      // the inbox — delivered only by best-effort email + bell. Writing the
      // canonical inbox row makes every lead reviewable (and repliable via the
      // forms reply actions, which key on a form_submissions id). Best-effort +
      // error-checked: a failure logs, never throws — the contacts row, email,
      // and bell are independent capture channels, and the visitor's 200 stands.
      const { error: submissionErr } = await dbInsert(c.env.DB, 'form_submissions', {
        id: crypto.randomUUID(),
        site_id: site.id,
        org_id: site.org_id,
        form_name: 'contact',
        email: body.email,
        payload: JSON.stringify({
          name: body.name,
          email: body.email,
          phone: body.phone ?? '',
          message: body.message,
        }),
        ip_address:
          c.req.header('cf-connecting-ip') ??
          c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
          null,
        user_agent: c.req.header('user-agent')?.slice(0, 512) ?? null,
        origin_url: c.req.header('referer') ?? c.req.header('origin') ?? null,
        forwarded_to: '[]',
        status: 'received',
        created_at: new Date().toISOString(),
      });
      if (submissionErr) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'contact-form',
            message: 'form_submissions_persist_failed',
            slug,
            site_id: site.id,
            error: submissionErr,
          }),
        );
      }
    }

    // Resolve the owner's notification address. The admin Settings "Contact Email"
    // field writes `ai_site_settings.contact_email` (the user-configured, AUTHORITATIVE
    // value — see ai_admin.ts ai-settings PUT); `sites.contact_email` is the
    // build/research-populated legacy fallback. Reading ONLY `sites.contact_email`
    // ignored a configured address → the owner silently never got emailed their leads
    // even after setting it in admin (admin writes ai_site_settings, this read sites).
    const aiSettings = await dbQueryOne<{ contact_email?: string | null }>(
      c.env.DB,
      'SELECT contact_email FROM ai_site_settings WHERE site_id = ?',
      [site.id],
    );
    const toEmail = aiSettings?.contact_email || site.contact_email || '';

    // Escape every untrusted field BEFORE interpolation (the message keeps its
    // line breaks via <br>, applied AFTER escaping so injected markup is inert).
    const safeName = escapeHtml(body.name);
    const safeEmail = escapeHtml(body.email);
    const safePhone = body.phone ? escapeHtml(body.phone) : '';
    const safeMessage = escapeHtml(body.message).replace(/\n/g, '<br>');
    const safeBusiness = escapeHtml(site.business_name);
    const htmlBody = `<h2>New Contact Form Submission</h2><p><strong>From:</strong> ${safeName} (${safeEmail})</p>${safePhone ? `<p><strong>Phone:</strong> ${safePhone}</p>` : ''}<p><strong>Message:</strong></p><p>${safeMessage}</p><hr><p style="color:#888;font-size:12px;">Sent via ${safeBusiness} on projectsites.dev</p>`;

    // Owner email is a BEST-EFFORT delivery channel — NEVER fail the visitor's
    // submission on a missing to-address or a provider error. The durable success
    // is the persisted `contacts` row (above) + the in-app bell (below). This was
    // a lying-FAILURE class: no `contact_email` → 400 (skipping the bell) and a
    // provider throw → 500, BOTH after the lead was already captured — so the
    // visitor saw an error for a submission that actually reached the owner.
    try {
      if (!toEmail) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'contact-form',
            message: 'no_contact_email_configured — lead persisted + bell only',
            slug,
            site_id: site.id,
          }),
        );
      } else if (c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY && c.env.SES_FROM_EMAIL) {
        // ADR-0019 Resend→SES: SES is the PRIMARY rail when configured. reply_to
        // (the lead submitter) rides through so the owner can reply to the lead;
        // the per-site friendly from-name is preserved. SendGrid/Resend stay
        // fallback until SES is proven live.
        await getEmailProvider(c.env).sendTransactional({
          kind: 'transactional',
          from: `${site.business_name} <noreply@projectsites.dev>`,
          to: toEmail,
          replyTo: body.email,
          subject: `New message from ${body.name} via your website`,
          html: htmlBody,
        });
      } else if (c.env.SENDGRID_API_KEY) {
        await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${c.env.SENDGRID_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: toEmail }] }],
            from: { email: 'noreply@projectsites.dev', name: `${site.business_name} Website` },
            reply_to: { email: body.email, name: body.name },
            subject: `New message from ${body.name} via your website`,
            content: [{ type: 'text/html', value: htmlBody }],
          }),
        });
        // Resend removed 2026-09-09 (Brian directive) — SES + SendGrid only.
      } else {
        // No email provider configured — the owner email is NOT sent (the in-app
        // bell below is the only delivery). Surface it in logs so the operator
        // isn't blind to silently-undelivered contact emails.
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'contact-form',
            message:
              'No email provider (SENDGRID/RESEND) configured — owner email NOT sent; bell only',
            slug,
            site_id: site.id,
          }),
        );
      }
    } catch (emailErr) {
      // Delivery failure is logged, never surfaced to the visitor — the lead is
      // already persisted + the bell still fires below.
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'contact-form',
          message: 'owner_email_send_failed',
          slug,
          site_id: site.id,
          error: emailErr instanceof Error ? emailErr.message : String(emailErr),
        }),
      );
    }

    // In-app bell notification to the site owner (psnotify backbone). Additive +
    // guarded + fire-and-forget; never blocks the form response.
    if (site.org_id) {
      try {
        const { notifySiteOwner } = await import('../../../src/services/notify.js');
        const p = notifySiteOwner(c.env, c.env.DB, {
          orgId: site.org_id,
          subject: `New message from ${body.name} ✉️`,
          body: `${body.name} (${body.email}) contacted you via ${site.business_name}.`,
        });
        try {
          c.executionCtx.waitUntil(p);
        } catch {
          void p;
        }
      } catch {
        /* notify is best-effort — email already sent above */
      }
    }

    return c.json({ data: { success: true } });
  } catch (err) {
    console.warn('[contact-form] Error:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to send' } }, 500);
  }
});

/**
 * Newsletter subscribe — the dedicated native-subscriber ingest that feeds the
 * `newsletter_subscribers` table (and the /admin analytics "Newsletter" tile).
 *
 * @remarks
 * Closes a triple-drift gap: the generated-site signup widget POSTs here,
 * `services/advanced_features.ts` owns `newsletterSubscribe()`, and the analytics
 * tile READS `newsletter_subscribers` — but the ROUTE joining them was never
 * mounted, so this path 404'd and the tile had no live writer. Distinct from
 * `/api/v1/forms/submit` (generic form → external ESP): this is the double-opt-in
 * native subscriber (`confirmed=0` until the opt-in email is clicked). Persist-first
 * + error-checked (never a lying-success). Public + guest-reachable — Zod-validated.
 */
const newsletterSubscribeSchema = z.object({
  email: z.string().trim().email('A valid email is required.').max(320),
  siteId: z.string().trim().min(1, 'siteId is required.').max(200),
  segment: z.string().trim().max(64).optional(),
});

contactNewsletter.post('/api/newsletter/subscribe', async (c) => {
  const parsed = newsletterSubscribeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid subscription',
        },
      },
      400,
    );
  }
  const { email, siteId, segment } = parsed.data;

  try {
    const { dbQueryOne } = await import('../../../src/services/db.js');
    const site = await dbQueryOne<{ id: string }>(
      c.env.DB,
      'SELECT id FROM sites WHERE (id = ? OR slug = ?) AND deleted_at IS NULL',
      [siteId, siteId],
    );
    if (!site) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

    const { newsletterSubscribe } = await import('../../../src/services/advanced_features.js');
    const res = await newsletterSubscribe(c.env, { siteId: site.id, email, segment });
    if (res.error) {
      // Persist failed for real (not a duplicate no-op) — surface it, never a
      // lying-success. The subscriber's number won't reach the owner otherwise.
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'newsletter-subscribe',
          message: 'subscribe_persist_failed',
          site_id: site.id,
          error: res.error,
        }),
      );
      return c.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Could not save your subscription. Please try again.',
          },
        },
        500,
      );
    }
    return c.json({ data: { subscribed: true, double_opt_in_required: true } });
  } catch (err) {
    console.warn('[newsletter-subscribe] Error:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to subscribe' } }, 500);
  }
});

/**
 * Newsletter UNSUBSCRIBE — the compliance counterpart to subscribe. Public +
 * self-serve (same {siteId, email} trust model as subscribe): a subscriber (or a
 * one-click email link) removes themselves from a site's native newsletter.
 *
 * @remarks
 * Closes a real gap: `newsletter_subscribers.unsubscribed` had NO writer anywhere in
 * the worker, so a native subscriber could never leave (CAN-SPAM/GDPR require a working
 * unsubscribe) and the `newsletter-causal` probe's test rows could never be cleaned.
 * Persist-first + error-checked (never a lying-success). Idempotent — unsubscribing a
 * non-subscriber / already-unsubscribed row is a benign success no-op (`removed: 0`).
 * Zod-validated; resolves the site by id-or-slug just like subscribe.
 */
const newsletterUnsubscribeSchema = z.object({
  email: z.string().trim().email('A valid email is required.').max(320),
  siteId: z.string().trim().min(1, 'siteId is required.').max(200),
});

contactNewsletter.post('/api/newsletter/unsubscribe', async (c) => {
  const parsed = newsletterUnsubscribeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid unsubscribe request',
        },
      },
      400,
    );
  }
  const { email, siteId } = parsed.data;

  try {
    const { dbQueryOne } = await import('../../../src/services/db.js');
    const site = await dbQueryOne<{ id: string }>(
      c.env.DB,
      'SELECT id FROM sites WHERE (id = ? OR slug = ?) AND deleted_at IS NULL',
      [siteId, siteId],
    );
    if (!site) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

    const { newsletterUnsubscribe } = await import('../../../src/services/advanced_features.js');
    const res = await newsletterUnsubscribe(c.env, { siteId: site.id, email });
    if (res.error) {
      // Persist failed for real — surface it, never a lying-success (the subscriber
      // would think they unsubscribed while still receiving mail).
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'newsletter-unsubscribe',
          message: 'unsubscribe_persist_failed',
          site_id: site.id,
          error: res.error,
        }),
      );
      return c.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Could not process your unsubscribe. Please try again.',
          },
        },
        500,
      );
    }
    // Idempotent success: `removed` is 0 when the email was not a live subscriber.
    return c.json({ data: { unsubscribed: true, removed: res.updated } });
  } catch (err) {
    console.warn('[newsletter-unsubscribe] Error:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to unsubscribe' } }, 500);
  }
});
