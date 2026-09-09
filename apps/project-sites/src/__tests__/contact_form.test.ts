/**
 * Coverage for the PUBLIC `POST /api/contact-form/:slug` endpoint
 * (`routes/search.ts`). It forwards a visitor's submission to the site owner as
 * an HTML email. Because the visitor is UNAUTHENTICATED and the fields land in
 * an HTML document, every field MUST be HTML-escaped before interpolation —
 * otherwise a submitter injects markup (`<a href>`, `<script>`) into the email
 * the owner receives (phishing-the-owner via their own contact form).
 */
// The broad D1 stub returns a row for every query; without this the §42
// suppression check (email-router) would read it as "suppressed" and skip the
// send. Pin isSuppressed → false so these tests exercise the SES-routing path.
jest.mock('../services/email_suppressions.js', () => ({
  isSuppressed: jest.fn(async () => false),
  recordSuppressions: jest.fn(async () => ({ suppressed: 0 })),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { search } from '../routes/search.js';
// Route-decomposition installment 23: /api/contact-form/:slug moved from search.ts to
// its own module. Mount it before search so the moved route resolves here (mirrors src/index.ts).
import { contactNewsletter } from '../../libs/features/contact_newsletter/handlers.js';

/** D1 stub: the contact-form site lookup resolves to a site with a contact email. */
const SITE_ROW = {
  id: 'site-1',
  org_id: 'org-1',
  business_name: 'Newark Soup Kitchen',
  contact_email: 'owner@nsk.org',
};
function makeDb() {
  return {
    prepare: jest.fn(() => ({
      bind: jest.fn(() => ({
        // dbQueryOne → dbQuery uses `.all()` and reads `.results[0]`.
        all: jest.fn().mockResolvedValue({ results: [SITE_ROW] }),
        first: jest.fn().mockResolvedValue(SITE_ROW),
      })),
    })),
  } as unknown as D1Database;
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: makeDb(),
    // Resend removed 2026-09-09 (Brian directive). Default to the SendGrid rail
    // (mockable fetch to api.sendgrid.com); SES-specific tests override with AWS creds.
    SENDGRID_API_KEY: 'sg_test_x',
    ...overrides,
  } as unknown as Env;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.onError(errorHandler);
app.route('/', contactNewsletter);
app.route('/', search);

function submit(env: Env, body: unknown) {
  return app.request(
    '/api/contact-form/nsk',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('POST /api/contact-form/:slug — HTML-injection defense', () => {
  it('escapes schema-allowed-but-dangerous markup in the outgoing email body', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;

    // `<a href>` passes contactFormSchema (only <script>/javascript: are rejected),
    // so it reaches the email body — escapeHtml must neutralise it.
    const res = await submit(makeEnv(), {
      name: '<a href="https://evil.com">click me</a>',
      email: 'visitor@example.com',
      message: 'hello <a href="https://evil.com">link</a> world, please reply soon',
    });
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // SendGrid v3 body: content:[{ type:'text/html', value: <html> }]
    const html: string = sentBody.content[0].value;
    expect(html).not.toContain('<a href="https://evil.com">');
    expect(html).toContain('&lt;a href=&quot;https://evil.com&quot;&gt;');
  });

  it('routes the owner notification through Amazon SES with reply-to preserved when SES is configured (ADR-0019)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    global.fetch = fetchMock;
    const res = await submit(
      makeEnv({
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_DEFAULT_REGION: 'us-east-1',
        SES_FROM_EMAIL: 'noreply@projectsites.dev',
      }),
      {
        name: 'Lead Person',
        email: 'lead@business.com',
        message: 'I would like a quote please, thanks.',
      },
    );
    expect(res.status).toBe(200);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('amazonaws.com'))).toBe(true);
    expect(urls.some((u) => u.includes('api.resend.com'))).toBe(false);
    const sesBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sesBody.ReplyToAddresses).toEqual(['lead@business.com']);
  });

  it('still requires name, email, and message (400 otherwise)', async () => {
    const res = await submit(makeEnv(), { name: 'A', email: 'a@b.c', message: 'short' }); // no message? message<10
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email (400) — the raw value flows into reply_to', async () => {
    const res = await submit(makeEnv(), {
      name: 'Visitor',
      email: 'not-an-email',
      message: 'a genuine inquiry message',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a too-short message (400) — basic empty/spam floor', async () => {
    const res = await submit(makeEnv(), { name: 'Visitor', email: 'v@x.test', message: 'hi' });
    expect(res.status).toBe(400);
  });

  it('rejects a <script> in the message at the schema boundary (400, before escaping)', async () => {
    const res = await submit(makeEnv(), {
      name: 'Visitor',
      email: 'v@x.test',
      message: 'hello <script>alert(1)</script> there friend',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an over-length message (400) — abuse / email-cost cap', async () => {
    const res = await submit(makeEnv(), {
      name: 'Visitor',
      email: 'v@x.test',
      message: 'x'.repeat(5001),
    });
    expect(res.status).toBe(400);
  });

  it('logs a structured warning (no silent failure) when no email provider is configured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Strip the default SendGrid key → neither provider set.
    const res = await submit(makeEnv({ SENDGRID_API_KEY: undefined }), {
      name: 'Visitor',
      email: 'visitor@example.com',
      message: 'a genuine inquiry that should still be accepted',
    });
    expect(res.status).toBe(200); // still accepted (bell is the fallback)
    expect(fetchMock).not.toHaveBeenCalled(); // no email attempted
    // …but the silent drop is now observable in logs.
    const warned = warnSpy.mock.calls.some((args) => String(args[0]).includes('No email provider'));
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it('preserves message line breaks as <br> (after escaping)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
    await submit(makeEnv(), {
      name: 'Visitor',
      email: 'visitor@example.com',
      message: 'line1\nline2 — a real note',
    });
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.content[0].value).toContain('line1<br>line2');
  });
});

// The durable success of a contact submission is the persisted `contacts` row +
// the in-app bell — NOT the owner email (a best-effort delivery channel). The
// visitor must never see a failure for a submission that was captured. Regression
// for the two lying-FAILURE paths that returned an error AFTER persisting:
// (1) site has no contact_email → was 400; (2) email provider throws → was 500.
describe('POST /api/contact-form/:slug — persist-first, delivery is best-effort', () => {
  function makeDbWithSite(row: Record<string, unknown>) {
    return {
      prepare: jest.fn(() => ({
        bind: jest.fn(() => ({
          all: jest.fn().mockResolvedValue({ results: [row] }),
          first: jest.fn().mockResolvedValue(row),
          run: jest.fn().mockResolvedValue({ success: true, meta: {} }),
        })),
      })),
    } as unknown as D1Database;
  }

  it('returns 200 (not 400) when the site has no contact_email — the lead is still captured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    const env = makeEnv({
      DB: makeDbWithSite({ id: 's1', org_id: 'o1', business_name: 'Biz', contact_email: '' }),
    });
    const res = await submit(env, {
      name: 'Visitor',
      email: 'v@x.test',
      message: 'a genuine inquiry message here',
    });
    // The #1 conversion action must NOT error just because the OWNER hasn't set
    // a contact email — the lead is persisted + the bell fires.
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled(); // no to-address → no email attempted
  });

  it('returns 200 (not 500) when the email provider throws AFTER the contact is persisted', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('provider down'));
    global.fetch = fetchMock;
    // makeEnv → contact_email set + RESEND key → the resend fetch() branch throws.
    const res = await submit(makeEnv(), {
      name: 'Visitor',
      email: 'v@x.test',
      message: 'a genuine inquiry message here',
    });
    expect(res.status).toBe(200); // email is best-effort; the persisted lead is the durable success
  });
});

// ---------------------------------------------------------------------------
// The durable `contacts` row is the CRM record the owner sees (analytics
// bySource + any future contacts inbox). A refactor that changes source, drops
// site_id, or corrupts the metadata JSON would silently break lead attribution
// while every render/status test stays green. This LOCKS the exact write shape
// causally verified against prod D1 (a real submission landed org+site-scoped
// with source='form' + message/slug in metadata).
// ---------------------------------------------------------------------------
describe('POST /api/contact-form/:slug — writes the contacts row with the authoritative CRM shape', () => {
  it('inserts ONE contacts row: org+site scoped, source=form, message+slug in metadata', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const captured: Array<{ sql: string; vals: unknown[] }> = [];
    const db = {
      prepare: jest.fn((sql: string) => ({
        bind: jest.fn((...vals: unknown[]) => {
          if (/INSERT INTO contacts\b/i.test(sql)) captured.push({ sql, vals });
          return {
            all: jest.fn().mockResolvedValue({ results: [SITE_ROW] }),
            first: jest.fn().mockResolvedValue(SITE_ROW),
            run: jest.fn().mockResolvedValue({ success: true, meta: {} }),
          };
        }),
      })),
    } as unknown as D1Database;

    const res = await submit(makeEnv({ DB: db }), {
      name: 'Real Visitor',
      email: 'lead@visitor.test',
      phone: '+1-555-0100',
      message: 'I would like a quote for catering next month please.',
    });
    expect(res.status).toBe(200);

    // Exactly one contacts INSERT.
    expect(captured).toHaveLength(1);
    const { sql, vals } = captured[0];
    const cols = sql
      .match(/\(([^)]+)\)\s*VALUES/i)![1]
      .split(',')
      .map((s) => s.trim());
    const row: Record<string, unknown> = {};
    cols.forEach((col, i) => (row[col] = vals[i]));

    expect(row.org_id).toBe('org-1'); // SITE_ROW.org_id — org-scoped (RBAC + analytics)
    expect(row.site_id).toBe('site-1'); // SITE_ROW.id — lead attributed to the site
    expect(row.name).toBe('Real Visitor');
    expect(row.email).toBe('lead@visitor.test');
    expect(row.source).toBe('form'); // the CRM bySource bucket the owner reviews
    const meta = JSON.parse(String(row.metadata));
    expect(meta.message).toBe('I would like a quote for catering next month please.');
    expect(meta.slug).toBe('nsk'); // submitted slug preserved for attribution
  });
});

// ---------------------------------------------------------------------------
// REVIEWABILITY: the lead must ALSO land in `form_submissions` — the ONLY table
// the owner's /admin Forms inbox reads (ai_admin.ts GET /sites/:id/form-submissions,
// forms.component.ts). Historically the contact handler wrote `contacts` ONLY, which
// no admin surface reads, so generated-site contact-form leads were invisible in the
// inbox (email + bell delivery only). This LOCKS the canonical inbox mirror so a
// refactor that drops it silently makes every owner's leads invisible again while
// every render/status test stays green.
// ---------------------------------------------------------------------------
describe('POST /api/contact-form/:slug — mirrors the lead into the form_submissions inbox', () => {
  it('inserts ONE form_submissions row: org+site scoped, form_name=contact, fields in payload', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const captured: Array<{ sql: string; vals: unknown[] }> = [];
    const db = {
      prepare: jest.fn((sql: string) => ({
        bind: jest.fn((...vals: unknown[]) => {
          if (/INSERT INTO form_submissions\b/i.test(sql)) captured.push({ sql, vals });
          return {
            all: jest.fn().mockResolvedValue({ results: [SITE_ROW] }),
            first: jest.fn().mockResolvedValue(SITE_ROW),
            run: jest.fn().mockResolvedValue({ success: true, meta: {} }),
          };
        }),
      })),
    } as unknown as D1Database;

    const res = await submit(makeEnv({ DB: db }), {
      name: 'Real Visitor',
      email: 'lead@visitor.test',
      phone: '+1-555-0100',
      message: 'I would like a quote for catering next month please.',
    });
    expect(res.status).toBe(200);

    // Exactly one form_submissions INSERT — the inbox row the owner reviews.
    expect(captured).toHaveLength(1);
    const { sql, vals } = captured[0];
    const cols = sql
      .match(/\(([^)]+)\)\s*VALUES/i)![1]
      .split(',')
      .map((s) => s.trim());
    const row: Record<string, unknown> = {};
    cols.forEach((col, i) => (row[col] = vals[i]));

    expect(row.org_id).toBe('org-1'); // SITE_ROW.org_id — org-scoped (RBAC + inbox filter)
    expect(row.site_id).toBe('site-1'); // SITE_ROW.id — lead attributed to the site
    expect(row.form_name).toBe('contact'); // matches the inbox "Contact" filter chip
    expect(row.email).toBe('lead@visitor.test');
    expect(row.status).toBe('received'); // valid form_submissions.status CHECK value
    const payload = JSON.parse(String(row.payload));
    expect(payload.name).toBe('Real Visitor');
    expect(payload.email).toBe('lead@visitor.test');
    expect(payload.phone).toBe('+1-555-0100');
    expect(payload.message).toBe('I would like a quote for catering next month please.');
  });
});

// ---------------------------------------------------------------------------
// Contact-email SOURCE resolution: the admin Settings "Contact Email" field
// writes ai_site_settings.contact_email; sites.contact_email is the build/legacy
// fallback. Reading only sites.contact_email ignored the configured address →
// the owner silently never got emailed their leads. This is a cross-system
// source-drift (admin writes ai_site_settings, the form read sites).
// ---------------------------------------------------------------------------
describe('POST /api/contact-form/:slug — owner email resolves from ai_site_settings first', () => {
  /** SQL-aware D1 stub: distinct rows for the `sites` vs `ai_site_settings` reads. */
  function makeSplitDb(
    sitesRow: Record<string, unknown> | null,
    aiRow: Record<string, unknown> | null,
  ): D1Database {
    return {
      prepare: jest.fn((sql: string) => {
        const isAi = /ai_site_settings/i.test(sql);
        const row = isAi ? aiRow : sitesRow;
        return {
          bind: jest.fn(() => ({
            all: jest.fn().mockResolvedValue({ results: row ? [row] : [] }),
            first: jest.fn().mockResolvedValue(row),
            run: jest.fn().mockResolvedValue({ meta: { changes: 1 } }),
          })),
        };
      }),
    } as unknown as D1Database;
  }

  it('emails the admin-configured ai_site_settings.contact_email when sites.contact_email is null', async () => {
    // The owner set their Contact Email in /admin (→ ai_site_settings), but
    // sites.contact_email is null. The form MUST email the configured address —
    // not fall to the "no contact email → bell only" degrade that lost the lead.
    const db = makeSplitDb(
      { id: 'site-1', org_id: 'org-1', business_name: 'Biz', contact_email: null },
      { contact_email: 'configured@owner.com' },
    );
    const fetchSpy = jest.fn(async () => new Response('', { status: 202 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const env = { ENVIRONMENT: 'test', DB: db, SENDGRID_API_KEY: 'sg_test' } as unknown as Env;

    const res = await submit(env, {
      name: 'Lead',
      email: 'lead@x.com',
      message: 'I would like a quote please.',
    });

    expect(res.status).toBe(200);
    const sgCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('sendgrid'));
    expect(sgCall).toBeTruthy(); // owner was emailed the lead (SendGrid called)
    // lead routed to the admin-configured address (not the empty sites column)
    expect(JSON.stringify(sgCall?.[1])).toContain('configured@owner.com');
  });

  it('falls back to sites.contact_email when ai_site_settings has none (build/legacy path)', async () => {
    const db = makeSplitDb(
      { id: 'site-1', org_id: 'org-1', business_name: 'Biz', contact_email: 'legacy@owner.com' },
      null,
    );
    const fetchSpy = jest.fn(async () => new Response('', { status: 202 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const env = { ENVIRONMENT: 'test', DB: db, SENDGRID_API_KEY: 'sg_test' } as unknown as Env;

    const res = await submit(env, {
      name: 'Lead',
      email: 'lead@x.com',
      message: 'I would like a quote please.',
    });

    expect(res.status).toBe(200);
    const sgCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('sendgrid'));
    expect(JSON.stringify(sgCall?.[1])).toContain('legacy@owner.com');
  });
});
