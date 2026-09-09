/**
 * Convergence §42/ADR-0019 — sendEmail routes through SES when configured.
 *
 * With AWS creds present, the central transactional sender dispatches via the
 * email router (SES). Resend was REMOVED 2026-09-09 (Brian directive) — SendGrid
 * is now the sole break-glass fallback when SES fails/unconfigured.
 */
import { sendEmail, categoryToEmailKind } from '../services/notifications.js';
import type { EmailRouter } from '../platform/email-router.js';
import type { Env } from '../types/env.js';

describe('categoryToEmailKind', () => {
  it('maps known categories + defaults unknown to transactional', () => {
    expect(categoryToEmailKind('magic_link')).toBe('magic-link');
    expect(categoryToEmailKind('claim_verification')).toBe('claim-verification');
    expect(categoryToEmailKind('domain_verified')).toBe('domain-verification');
    expect(categoryToEmailKind('billing_alert')).toBe('billing-alert');
    expect(categoryToEmailKind('invite')).toBe('transactional');
    expect(categoryToEmailKind('whatever')).toBe('transactional');
  });
});

describe('sendEmail SES migration (ADR-0019)', () => {
  const sesEnv = {
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
    SES_FROM_EMAIL: 'noreply@mail.projectsites.dev',
    // SENDGRID_API_KEY intentionally also set — SES must win regardless.
    SENDGRID_API_KEY: 'sg-key-xyz',
  } as Env;

  function fakeRouter() {
    const sent: { kind: string; to: string; subject: string }[] = [];
    const router: EmailRouter = {
      transactional: {} as EmailRouter['transactional'],
      marketing: {} as EmailRouter['marketing'],
      async sendTransactional(input) {
        sent.push({
          kind: input.kind,
          to: Array.isArray(input.to) ? input.to[0] : input.to,
          subject: input.subject,
        });
        return { id: 'ses-1', accepted: true };
      },
    };
    return Object.assign(router, { sent });
  }

  it('dispatches via the SES rail (mapped kind) and never calls Resend', async () => {
    const fetchSpy = jest.fn();
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const router = fakeRouter();
      await sendEmail(
        sesEnv,
        { to: 'a@b.com', subject: 'Verify', html: '<p>x</p>', category: 'claim_verification' },
        { email: router },
      );
      expect(router.sent).toEqual([
        { kind: 'claim-verification', to: 'a@b.com', subject: 'Verify' },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled(); // Resend/SendGrid NOT hit
    } finally {
      globalThis.fetch = orig;
    }
  });

  /** A router whose SES send always throws (a SES throttle / outage). */
  function failingRouter(): EmailRouter {
    return {
      transactional: {} as EmailRouter['transactional'],
      marketing: {} as EmailRouter['marketing'],
      async sendTransactional() {
        throw new Error('SES send failed (454): daily send quota exceeded');
      },
    };
  }

  it('FALLS THROUGH to SendGrid when the SES rail FAILS (fallback, not abort)', async () => {
    // A transient SES failure must NOT fail the send when SendGrid is configured —
    // the break-glass SendGrid fallback (ADR-0019, post-Resend-removal) has to kick in.
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'sg-1' }), {
        status: 200,
        headers: { 'x-message-id': 'req-1' },
      }),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await expect(
        sendEmail(
          sesEnv,
          { to: 'a@b.com', subject: 'Verify', html: '<p>x</p>', category: 'magic_link' },
          { email: failingRouter() },
        ),
      ).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // SendGrid WAS tried as the fallback
      expect(String(fetchSpy.mock.calls[0][0])).toContain('api.sendgrid.com');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws only when EVERY configured provider fails (SES + SendGrid both fail)', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(new Response('unprocessable', { status: 422 }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await expect(
        sendEmail(
          sesEnv,
          { to: 'a@b.com', subject: 'Verify', html: '<p>x</p>', category: 'magic_link' },
          { email: failingRouter() },
        ),
      ).rejects.toThrow(/email/i);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // SendGrid WAS attempted before giving up
    } finally {
      globalThis.fetch = orig;
    }
  });
});
