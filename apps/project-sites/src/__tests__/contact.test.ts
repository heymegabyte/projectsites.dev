import { handleContactForm } from '../services/contact.js';
import { AppError } from '@project-sites/shared';

// #121 reply-deliverability guard: stub the MX lookup so the happy paths always
// send the receipt (the real DoH logic is covered in email_deliverability.test.ts).
// Uses the GLOBAL `jest` so @swc/jest hoists this above the contact import.
jest.mock('../services/email_deliverability.js', () => ({
  hasDeliverableMx: jest.fn(async () => true),
}));
import { hasDeliverableMx } from '../services/email_deliverability.js';
const mockHasDeliverableMx = hasDeliverableMx as unknown as jest.Mock;

// Persistence is the PRIMARY lead-capture channel — mock db.js so each test
// controls whether the `contacts` INSERT succeeds. Global `jest` for @swc hoisting.
jest.mock('../services/db.js', () => ({
  dbInsert: jest.fn(async () => ({ error: null })),
}));
import { dbInsert } from '../services/db.js';
const mockDbInsert = dbInsert as unknown as jest.Mock;

// Resend removed 2026-09-09 (Brian directive): Amazon SES is PRIMARY, SendGrid is the
// break-glass fallback. With no AWS creds set, sendEmail() falls straight through to the
// SendGrid rail, so the default env exercises the SendGrid `fetch` path.
const mockEnv = {
  ENVIRONMENT: 'staging',
  SENDGRID_API_KEY: 'test-sendgrid-key',
} as any;

const originalFetch = global.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  // Reset persist to success each test (clearAllMocks does NOT restore the impl,
  // and a leaked mockResolvedValueOnce survives it — per the iter-108 harness trap).
  mockDbInsert.mockReset();
  mockDbInsert.mockResolvedValue({ error: null });
  global.fetch = mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ id: 'mock-msg-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Valid submission
// ---------------------------------------------------------------------------
describe('handleContactForm – valid submission', () => {
  const validInput = {
    name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+1234567890',
    message: 'Hello, I have a question about your services.',
  };

  it('sends two emails (notification + confirmation)', async () => {
    await handleContactForm(mockEnv, validInput);

    // Two fetch calls: one for notification, one for confirmation — both via SendGrid.
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: notification to team (SendGrid body shape)
    const firstCallUrl = mockFetch.mock.calls[0][0];
    expect(firstCallUrl).toBe('https://api.sendgrid.com/v3/mail/send');
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(firstBody.personalizations[0].to).toEqual([{ email: 'hey@megabyte.space' }]);
    expect(firstBody.subject).toContain('Jane Doe');
    expect(firstBody.reply_to).toEqual({ email: 'jane@example.com' });

    // Second call: confirmation to user
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.personalizations[0].to).toEqual([{ email: 'jane@example.com' }]);
    expect(secondBody.subject).toContain('received your message');
  });

  it('routes both emails through Amazon SES with reply-to preserved when SES is configured (ADR-0019)', async () => {
    const sesEnv = {
      ...mockEnv,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_DEFAULT_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'noreply@projectsites.dev',
    } as any;
    await handleContactForm(sesEnv, validInput);

    const urls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.every((u: string) => u.includes('amazonaws.com'))).toBe(true);
    expect(urls.some((u: string) => u.includes('api.resend.com'))).toBe(false);
    // The brand-notification email must preserve reply-to → the lead so the
    // business can respond directly (SES ReplyToAddresses, not dropped).
    const notifBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(notifBody.ReplyToAddresses).toEqual(['jane@example.com']);
  });

  it('works without a phone number', async () => {
    const input = { name: 'Bob', email: 'bob@test.com', message: 'This is my test message.' };
    await handleContactForm(mockEnv, input);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('skips the auto-receipt when the submitter domain is undeliverable (#121)', async () => {
    mockHasDeliverableMx.mockResolvedValueOnce(false); // fake/typo/NXDOMAIN domain
    await handleContactForm(mockEnv, validInput);
    // Team notification still sent (Email 1); the receipt (Email 2) is suppressed
    // so a hard bounce never dents our sender reputation.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(mockHasDeliverableMx).toHaveBeenCalledWith(expect.anything(), 'example.com');
  });

  it('HTML-escapes user input in email body', async () => {
    const input = {
      name: 'Test <b>User</b>',
      email: 'test@example.com',
      message: 'Hello & goodbye "friend"',
    };
    await handleContactForm(mockEnv, input);

    const notificationBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const notificationHtml = notificationBody.content[0].value;
    expect(notificationHtml).toContain('&lt;b&gt;User&lt;/b&gt;');
    expect(notificationHtml).toContain('&amp; goodbye &quot;friend&quot;');
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------
describe('handleContactForm – validation', () => {
  it('rejects missing name', async () => {
    await expect(
      handleContactForm(mockEnv, { email: 'a@b.com', message: 'Long enough message' }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects empty name', async () => {
    await expect(
      handleContactForm(mockEnv, { name: '', email: 'a@b.com', message: 'Long enough message' }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid email', async () => {
    await expect(
      handleContactForm(mockEnv, {
        name: 'Bob',
        email: 'not-an-email',
        message: 'Long enough message',
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing email', async () => {
    await expect(
      handleContactForm(mockEnv, { name: 'Bob', message: 'Long enough message' }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing message', async () => {
    await expect(handleContactForm(mockEnv, { name: 'Bob', email: 'a@b.com' })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects short message (< 10 chars)', async () => {
    await expect(
      handleContactForm(mockEnv, { name: 'Bob', email: 'a@b.com', message: 'Short' }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects script tags in name', async () => {
    await expect(
      handleContactForm(mockEnv, {
        name: '<script>alert("xss")</script>',
        email: 'a@b.com',
        message: 'A normal message here.',
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects script tags in message', async () => {
    await expect(
      handleContactForm(mockEnv, {
        name: 'Bob',
        email: 'a@b.com',
        message: 'Hello <script>alert("xss")</script> world',
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects javascript: in message', async () => {
    await expect(
      handleContactForm(mockEnv, {
        name: 'Bob',
        email: 'a@b.com',
        message: 'Check this link: javascript:alert(1)',
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects name that is too long (> 200 chars)', async () => {
    await expect(
      handleContactForm(mockEnv, {
        name: 'A'.repeat(201),
        email: 'a@b.com',
        message: 'A normal message here.',
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects phone that is too long (> 20 chars)', async () => {
    await expect(
      handleContactForm(mockEnv, {
        name: 'Bob',
        email: 'a@b.com',
        phone: '1'.repeat(21),
        message: 'A normal message here.',
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Email provider errors
// ---------------------------------------------------------------------------
describe('handleContactForm – email providers', () => {
  it('falls back to SendGrid when SES fails (SES configured) — a transient SES 5xx never loses the lead', async () => {
    // The bug: when SES is configured, sendEmail used it exclusively and let a SES
    // failure propagate (no fallback) → the public /api/contact form 5xx'd and the
    // lead was lost. SES must fall back to SendGrid on FAILURE, not just absence.
    const sesEnv = {
      ...mockEnv,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_DEFAULT_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'noreply@projectsites.dev',
    } as any;
    // SES (amazonaws.com) 500s; SendGrid succeeds (202).
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('amazonaws.com')
        ? new Response('ses temporarily unavailable', { status: 500 })
        : new Response('', { status: 202 }),
    );

    await handleContactForm(sesEnv, {
      name: 'Jane',
      email: 'jane@example.com',
      message: 'Testing SES failure fallback to SendGrid.',
    });

    const urls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
    // SES was attempted first, then SendGrid picked up the send → lead delivered, not lost.
    expect(urls.some((u) => u.includes('amazonaws.com'))).toBe(true);
    expect(urls.some((u) => u.includes('api.sendgrid.com'))).toBe(true);
    // Resend is gone entirely — never called.
    expect(urls.some((u) => u.includes('api.resend.com'))).toBe(false);
  });

  it('still succeeds when no email provider is configured — the lead persists to D1', async () => {
    // Email absence no longer loses the lead: it's captured in the `contacts`
    // table first, so the handler resolves (was: threw 'Email delivery is not
    // configured' → the visitor errored and the lead was lost).
    const noEmailEnv = { ENVIRONMENT: 'staging' } as any;

    await expect(
      handleContactForm(noEmailEnv, {
        name: 'Bob',
        email: 'bob@test.com',
        message: 'Testing no provider configured.',
      }),
    ).resolves.toBeUndefined();
    expect(mockDbInsert.mock.calls[0][1]).toBe('contacts');
  });

  it('still succeeds when both email providers fail — the lead persists to D1', async () => {
    // An all-email-rail outage no longer loses the lead (was: threw). It's durably
    // captured in D1; honest failure requires BOTH persist AND email to fail (see
    // the lead-persistence suite for that path).
    mockFetch.mockResolvedValue(new Response('error', { status: 500 }));

    await expect(
      handleContactForm(mockEnv, {
        name: 'Bob',
        email: 'bob@test.com',
        message: 'Testing both providers failing.',
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Coverage: escapeHtml, email content, boundary values
// ---------------------------------------------------------------------------
describe('handleContactForm – coverage gaps', () => {
  it('escapes all HTML special characters in notification email', async () => {
    const input = {
      name: 'A & B "test" <user>',
      email: 'test@example.com',
      message: 'Chars: & < > " should all be escaped properly',
    };
    await handleContactForm(mockEnv, input);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const html = body.content[0].value;
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&quot;');
    expect(html).not.toContain('<user>');
  });

  it('notification email contains all form fields', async () => {
    const input = {
      name: 'Alice',
      email: 'alice@example.com',
      phone: '+15551234567',
      message: 'Please contact me about your premium plan.',
    };
    await handleContactForm(mockEnv, input);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const html = body.content[0].value;
    expect(html).toContain('Alice');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('+15551234567');
    expect(html).toContain('premium plan');
    expect(body.subject).toContain('Alice');
    expect(body.reply_to).toEqual({ email: 'alice@example.com' });
  });

  it('confirmation email contains user name and message copy', async () => {
    const input = {
      name: 'Bob',
      email: 'bob@example.com',
      message: 'I would like a demo of the platform.',
    };
    await handleContactForm(mockEnv, input);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const html = body.content[0].value;
    expect(html).toContain('Bob');
    expect(html).toContain('demo of the platform');
    expect(body.subject).toContain('received your message');
    expect(body.personalizations[0].to).toEqual([{ email: 'bob@example.com' }]);
  });

  it('notification email omits phone row when not provided', async () => {
    const input = {
      name: 'Charlie',
      email: 'charlie@test.com',
      message: 'No phone number here.',
    };
    await handleContactForm(mockEnv, input);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content[0].value).not.toContain('Phone:');
  });

  it('accepts name at boundary (200 chars)', async () => {
    const input = {
      name: 'A'.repeat(200),
      email: 'test@example.com',
      message: 'Testing maximum name length boundary.',
    };
    await handleContactForm(mockEnv, input);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('accepts message at minimum boundary (10 chars)', async () => {
    const input = {
      name: 'Test',
      email: 'test@example.com',
      message: '1234567890',
    };
    await handleContactForm(mockEnv, input);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sends via SendGrid when SES is not configured (SendGrid-only rail)', async () => {
    const sendGridOnlyEnv = {
      ENVIRONMENT: 'staging',
      SENDGRID_API_KEY: 'test-sendgrid-key',
    } as any;

    await handleContactForm(sendGridOnlyEnv, {
      name: 'Test',
      email: 'test@example.com',
      message: 'Testing SendGrid-only path.',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.sendgrid.com/v3/mail/send');
  });
});

// ---------------------------------------------------------------------------
// Lead persistence — the platform contact form must NEVER lose a lead to an
// email-rail outage (it was email-only; now it persists a durable CRM row first).
// ---------------------------------------------------------------------------
describe('handleContactForm – lead persistence (never lose a lead)', () => {
  const validInput = {
    name: 'Lead Person',
    email: 'lead@example.com',
    phone: '+15551234567',
    message: 'I am interested in a website for my business.',
  };

  it('persists the lead to the contacts CRM table BEFORE emailing (never email-only)', async () => {
    await handleContactForm(mockEnv, validInput);
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    const [, table, row] = mockDbInsert.mock.calls[0];
    expect(table).toBe('contacts');
    expect(row.name).toBe('Lead Person');
    expect(row.email).toBe('lead@example.com');
    // Org-less endpoint → the seeded `system` sentinel org, no owning site.
    expect(row.org_id).toBe('system');
    expect(row.site_id).toBeNull();
    expect(JSON.parse(row.metadata).message).toContain('interested');
  });

  it('does NOT throw when every email rail fails but the lead persisted (lead survives)', async () => {
    // Persist OK; all email sends 500. The old email-only handler THREW here →
    // the visitor errored and the lead was lost. Now the lead is in D1, so the
    // handler resolves and the visitor sees success.
    mockDbInsert.mockResolvedValueOnce({ error: null });
    mockFetch.mockResolvedValue(new Response('err', { status: 500 }));
    await expect(handleContactForm(mockEnv, validInput)).resolves.toBeUndefined();
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
  });

  it('throws ONLY when the lead is captured NOWHERE (D1 drop AND email failure)', async () => {
    // Full outage: the persist drops AND every email rail fails → honest 5xx so
    // the visitor retries (never a lying success that silently drops the lead).
    mockDbInsert.mockResolvedValueOnce({ error: 'D1_ERROR: disk I/O' });
    mockFetch.mockResolvedValue(new Response('err', { status: 500 }));
    await expect(handleContactForm(mockEnv, validInput)).rejects.toThrow();
  });
});
