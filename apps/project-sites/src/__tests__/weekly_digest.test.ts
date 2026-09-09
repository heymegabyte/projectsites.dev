/**
 * weekly_digest — Monday 14:00 UTC summary email (convergence r34).
 *
 * Resend was removed 2026-09-09 (Brian directive); SES is the PRIMARY rail and
 * SendGrid the break-glass fallback. When SES creds are present the digest rides
 * the SES rail directly (`getEmailProvider(env).sendTransactional` → SigV4 POST to
 * email.{region}.amazonaws.com/v2/email/outbound-emails, honouring the one-click
 * List-Unsubscribe headers via Content.Simple.Headers). Otherwise it routes through
 * the central `sendEmail` seam (SES → SendGrid; SendGrid fetches api.sendgrid.com).
 *
 * Locks the digest service end-to-end against its three boundaries (D1 via
 * db.js helpers, the SES/SendGrid REST API via global.fetch, and Web Crypto HMAC):
 *  - isoWeekString ISO-8601 week math (Thursday-anchored, year boundaries).
 *  - computeWeeklyMetrics 7-day rollup per query, null-coalescing to 0, the
 *    top-3 referrer aggregation/sort/slice, malformed-JSON skip, and the
 *    referrer-query throw → empty-array degrade.
 *  - renderDigestHtml structure, brand colors, HTML-escaping, and the
 *    no-referrers fallback row.
 *  - sign/verifyUnsubscribeToken round-trip + every reject branch.
 *  - sendWeeklyDigestForOrg every skip reason (opted_out, already_sent,
 *    no_owner_email), the SES + SendGrid send paths + the post-send idempotency
 *    insert, SES/SendGrid failure resilience, the no-rail no-op-success seam, and
 *    the secret fallback chain.
 *  - sendWeeklyDigestsForAllOrgs sent/skipped/failed tallying + per-org
 *    soft-fail.
 *
 * db.js is jest.mock'd; the email API is mocked via global.fetch. No real I/O.
 * ts-jest global `jest`; casts via `as unknown as jest.Mock`.
 */
jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
}));

// Pin the §42 suppression check off — the digest's mocked dbQueryOne queue would
// otherwise be consumed by isSuppressed and the send read as suppressed.
jest.mock('../services/email_suppressions.js', () => ({
  isSuppressed: jest.fn(async () => false),
  recordSuppressions: jest.fn(async () => ({ suppressed: 0 })),
}));

import { dbQuery, dbQueryOne, dbInsert } from '../services/db.js';
import {
  isoWeekString,
  computeWeeklyMetrics,
  renderDigestHtml,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  sendWeeklyDigestForOrg,
  sendWeeklyDigestsForAllOrgs,
} from '../services/weekly_digest.js';
import type { Env } from '../types/env.js';

const mockQuery = dbQuery as unknown as jest.Mock;
const mockQueryOne = dbQueryOne as unknown as jest.Mock;
const mockInsert = dbInsert as unknown as jest.Mock;

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockDb = {} as D1Database;

/** Email-API Response stub (SendGrid seam reads `headers.get(...)` for the message id). */
function res(ok: boolean, opts: { status?: number; text?: string } = {}) {
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    headers: { get: (_name: string): string | null => null },
    text: jest.fn(async () => opts.text ?? ''),
  };
}

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    DB: mockDb,
    WEEKLY_DIGEST_SECRET: 'digest-secret',
    ...over,
  } as unknown as Env;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────
// isoWeekString — ISO-8601 Thursday-anchored week math
// ────────────────────────────────────────────────────────────
describe('isoWeekString', () => {
  it('formats YYYY-Www with a zero-padded two-digit week', () => {
    // 2026-01-05 is a Monday in ISO week 2.
    expect(isoWeekString(new Date('2026-01-05T00:00:00Z'))).toBe('2026-W02');
  });

  it('returns a well-formed string for a mid-year date', () => {
    const s = isoWeekString(new Date('2026-05-20T12:00:00Z'));
    expect(s).toMatch(/^2026-W\d{2}$/);
  });

  it('rolls a Jan-1 that falls in the previous ISO year back to that year', () => {
    // 2021-01-01 is a Friday → ISO week 53 of 2020.
    expect(isoWeekString(new Date('2021-01-01T00:00:00Z'))).toBe('2020-W53');
  });

  it('does not mutate the input date', () => {
    const d = new Date('2026-03-15T08:00:00Z');
    const before = d.getTime();
    isoWeekString(d);
    expect(d.getTime()).toBe(before);
  });

  it('defaults to now when no date is given', () => {
    expect(isoWeekString()).toMatch(/^\d{4}-W\d{2}$/);
  });
});

// ────────────────────────────────────────────────────────────
// computeWeeklyMetrics — per-query rollup + referrer aggregation
// ────────────────────────────────────────────────────────────
describe('computeWeeklyMetrics', () => {
  it('aggregates counts and the top-3 referrers (sorted desc, sliced)', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ n: 5 }) // sites
      .mockResolvedValueOnce({ n: 9 }) // forms
      .mockResolvedValueOnce({ n: 12 }) // ai
      .mockResolvedValueOnce({ n: 2 }); // errors
    mockQuery.mockResolvedValueOnce({
      data: [
        { metadata_json: JSON.stringify({ referrer: 'google.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'google.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'bing.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'duck.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'duck.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'duck.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'extra.com' }) },
      ],
    });

    const m = await computeWeeklyMetrics(mockDb, 'org-1');

    expect(m.sites_updated).toBe(5);
    expect(m.form_submissions).toBe(9);
    expect(m.ai_traces).toBe(12);
    expect(m.errors).toBe(2);
    // duck=3, google=2, bing=1 — extra.com sliced off (top 3 only).
    expect(m.top_referrers).toEqual([
      { referrer: 'duck.com', count: 3 },
      { referrer: 'google.com', count: 2 },
      { referrer: 'bing.com', count: 1 },
    ]);
  });

  it('coalesces missing count rows to 0', async () => {
    mockQueryOne.mockResolvedValue(null);
    mockQuery.mockResolvedValueOnce({ data: [] });

    const m = await computeWeeklyMetrics(mockDb, 'org-2');

    expect(m).toEqual({
      sites_updated: 0,
      form_submissions: 0,
      ai_traces: 0,
      errors: 0,
      top_referrers: [],
    });
  });

  it('skips null and malformed metadata_json rows without throwing', async () => {
    mockQueryOne.mockResolvedValue({ n: 0 });
    mockQuery.mockResolvedValueOnce({
      data: [
        { metadata_json: null },
        { metadata_json: '{not valid json' },
        { metadata_json: JSON.stringify({ referrer: 123 }) }, // non-string referrer ignored
        { metadata_json: JSON.stringify({ referrer: '' }) }, // empty referrer ignored
        { metadata_json: JSON.stringify({ referrer: 'real.com' }) },
      ],
    });

    const m = await computeWeeklyMetrics(mockDb, 'org-3');
    expect(m.top_referrers).toEqual([{ referrer: 'real.com', count: 1 }]);
  });

  it('degrades to an empty referrer list when the referrer query throws', async () => {
    mockQueryOne.mockResolvedValue({ n: 1 });
    mockQuery.mockRejectedValueOnce(new Error('no such table: audit_logs'));

    const m = await computeWeeklyMetrics(mockDb, 'org-4');
    expect(m.top_referrers).toEqual([]);
    expect(m.sites_updated).toBe(1);
  });

  it('passes a 7-day-ago ISO window to the count queries', async () => {
    mockQueryOne.mockResolvedValue({ n: 0 });
    mockQuery.mockResolvedValueOnce({ data: [] });
    await computeWeeklyMetrics(mockDb, 'org-w');

    const [, , params] = mockQueryOne.mock.calls[0] as [unknown, string, unknown[]];
    expect(params[0]).toBe('org-w');
    expect(typeof params[1]).toBe('string');
    expect(new Date(params[1] as string).getTime()).toBeLessThan(Date.now());
  });
});

// ────────────────────────────────────────────────────────────
// renderDigestHtml — structure, escaping, brand, fallback row
// ────────────────────────────────────────────────────────────
describe('renderDigestHtml', () => {
  const baseMetrics = {
    sites_updated: 3,
    form_submissions: 7,
    ai_traces: 0,
    errors: 1,
    top_referrers: [{ referrer: 'google.com', count: 4 }],
  };

  it('renders a self-contained HTML doc with brand colors + week + org name', () => {
    const html = renderDigestHtml({
      orgName: 'Acme Co',
      weekIso: '2026-W21',
      metrics: baseMetrics,
      unsubscribeUrl: 'https://x/u',
      dashboardUrl: 'https://x/dash',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('#00E5FF'); // accent
    expect(html).toContain('#060610'); // bg
    expect(html).toContain('2026-W21');
    expect(html).toContain('Acme Co');
    expect(html).toContain('https://x/dash');
    expect(html).toContain('https://x/u');
    expect(html).toContain('google.com');
  });

  it('escapes HTML-significant chars in org name, referrer, and URLs', () => {
    const html = renderDigestHtml({
      orgName: '<script>"&\'',
      weekIso: '2026-W21',
      metrics: {
        ...baseMetrics,
        top_referrers: [{ referrer: '<evil>&"', count: 1 }],
      },
      unsubscribeUrl: 'https://x/u?a=1&b=2',
      dashboardUrl: 'https://x/d',
    });
    expect(html).not.toContain('<script>"&\'');
    expect(html).toContain('&lt;script&gt;&quot;&amp;&#39;');
    expect(html).toContain('&lt;evil&gt;&amp;&quot;');
    expect(html).toContain('a=1&amp;b=2');
  });

  it('shows the no-referrers fallback row when the list is empty', () => {
    const html = renderDigestHtml({
      orgName: 'Empty',
      weekIso: '2026-W21',
      metrics: { ...baseMetrics, top_referrers: [] },
      unsubscribeUrl: 'https://x/u',
      dashboardUrl: 'https://x/d',
    });
    expect(html).toContain('No referrers tracked this week.');
  });
});

// ────────────────────────────────────────────────────────────
// sign/verifyUnsubscribeToken — HMAC round-trip + reject branches
// ────────────────────────────────────────────────────────────
describe('unsubscribe token', () => {
  it('signs as <orgId>.<hexsig> and verifies back to the org id', async () => {
    const token = await signUnsubscribeToken('org-abc', 'secret-1');
    expect(token.startsWith('org-abc.')).toBe(true);
    const sig = token.slice('org-abc.'.length);
    expect(sig).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(await verifyUnsubscribeToken(token, 'secret-1')).toBe('org-abc');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signUnsubscribeToken('org-abc', 'secret-1');
    expect(await verifyUnsubscribeToken(token, 'secret-2')).toBeNull();
  });

  it('rejects a token with no dot separator', async () => {
    expect(await verifyUnsubscribeToken('nodothere', 'secret-1')).toBeNull();
  });

  it('rejects a token whose dot is at index 0 (empty org id)', async () => {
    expect(await verifyUnsubscribeToken('.deadbeef', 'secret-1')).toBeNull();
  });

  it('rejects a token with a wrong-length signature', async () => {
    expect(await verifyUnsubscribeToken('org-abc.short', 'secret-1')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// sendWeeklyDigestForOrg — skip reasons
// ────────────────────────────────────────────────────────────
describe('sendWeeklyDigestForOrg (skip reasons)', () => {
  it('skips opted-out orgs without touching D1 or fetch', async () => {
    const out = await sendWeeklyDigestForOrg(makeEnv(), mockDb, {
      id: 'o',
      name: 'O',
      digest_opt_out: 1,
    });
    expect(out).toEqual({ sent: false, reason: 'opted_out' });
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when a digest was already sent this ISO week', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'sent-row' }); // idempotency hit
    const out = await sendWeeklyDigestForOrg(makeEnv(), mockDb, {
      id: 'o',
      name: 'O',
      digest_opt_out: 0,
    });
    expect(out).toEqual({ sent: false, reason: 'already_sent' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when the org has no owner email', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null) // idempotency miss
      .mockResolvedValueOnce(null); // owner lookup → none
    const out = await sendWeeklyDigestForOrg(makeEnv(), mockDb, {
      id: 'o',
      name: 'O',
      digest_opt_out: 0,
    });
    expect(out).toEqual({ sent: false, reason: 'no_owner_email' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('succeeds as a no-op through the central seam when no email rail is configured', async () => {
    // Resend removed 2026-09-09. With neither SES creds nor SendGrid, the central
    // `sendEmail` seam warns-and-returns (a successful no-op) rather than throwing —
    // so the digest reports sent + writes the idempotency row, and no HTTP call fires.
    mockQueryOne
      .mockResolvedValueOnce(null) // idempotency miss
      .mockResolvedValueOnce({ email: 'owner@x.com' }) // owner
      .mockResolvedValueOnce({ n: 0 }) // sites
      .mockResolvedValueOnce({ n: 0 }) // forms
      .mockResolvedValueOnce({ n: 0 }) // ai
      .mockResolvedValueOnce({ n: 0 }); // errors
    mockQuery.mockResolvedValueOnce({ data: [] }); // referrers
    const env = makeEnv({ SENDGRID_API_KEY: undefined });

    const out = await sendWeeklyDigestForOrg(env, mockDb, {
      id: 'o',
      name: 'O',
      digest_opt_out: 0,
    });
    expect(out).toEqual({ sent: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────
// sendWeeklyDigestForOrg — send paths
// ────────────────────────────────────────────────────────────
describe('sendWeeklyDigestForOrg (send paths)', () => {
  /** Queue the standard happy-path D1 reads (idempotency miss → owner → metrics). */
  function primeHappyReads(email = 'owner@x.com') {
    mockQueryOne
      .mockResolvedValueOnce(null) // idempotency miss
      .mockResolvedValueOnce({ email }) // owner
      .mockResolvedValueOnce({ n: 1 }) // sites
      .mockResolvedValueOnce({ n: 2 }) // forms
      .mockResolvedValueOnce({ n: 3 }) // ai
      .mockResolvedValueOnce({ n: 0 }); // errors
    mockQuery.mockResolvedValueOnce({ data: [] }); // referrers
  }

  it('sends via the SendGrid fallback with Bearer auth, then writes the idempotency row', async () => {
    // Resend removed 2026-09-09. With no SES creds, the digest routes through the
    // central `sendEmail` seam → SendGrid break-glass fetch (api.sendgrid.com). The
    // seam applies its own compliance headers, so List-Unsubscribe is asserted on the
    // SES path (next test), not here.
    primeHappyReads();
    mockFetch.mockResolvedValueOnce(res(true));
    const now = new Date('2026-05-25T14:00:00Z');

    const out = await sendWeeklyDigestForOrg(
      makeEnv({ SENDGRID_API_KEY: 'SG.key' }),
      mockDb,
      {
        id: 'org-9',
        name: 'Acme',
        digest_opt_out: 0,
      },
      now,
    );

    expect(out).toEqual({ sent: true });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SG.key');
    const body = JSON.parse(init.body as string);
    expect(body.personalizations[0].to[0].email).toBe('owner@x.com');
    expect(body.subject).toBe('Weekly digest · Acme');
    // html rides content[0].value on the SendGrid rail.
    expect(body.content[0].value).toContain('Acme');
    // Idempotency row written AFTER the send.
    expect(mockInsert).toHaveBeenCalledWith(
      mockDb,
      'weekly_digest_sent',
      expect.objectContaining({
        org_id: 'org-9',
        week_iso: isoWeekString(now),
        recipient_email: 'owner@x.com',
        opens_count: 0,
      }),
    );
  });

  it('routes the digest through Amazon SES with one-click List-Unsubscribe headers when SES is configured (ADR-0019)', async () => {
    primeHappyReads();
    mockFetch.mockResolvedValueOnce(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    const out = await sendWeeklyDigestForOrg(
      makeEnv({
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_DEFAULT_REGION: 'us-east-1',
        SES_FROM_EMAIL: 'noreply@projectsites.dev',
      }),
      mockDb,
      { id: 'org-9', name: 'Acme', digest_opt_out: 0 },
      new Date('2026-05-25T14:00:00Z'),
    );
    expect(out).toEqual({ sent: true });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('amazonaws.com');
    const body = JSON.parse(init.body as string);
    const headers = body.Content.Simple.Headers as Array<{ Name: string; Value: string }>;
    expect(headers.find((h) => h.Name === 'List-Unsubscribe')?.Value).toMatch(
      /^<https:\/\/projectsites\.dev\/api\/email\/unsubscribe\?token=/,
    );
    expect(headers.some((h) => h.Name === 'List-Unsubscribe-Post')).toBe(true);
  });

  it('returns ses_error and does NOT write the idempotency row when the SES send fails', async () => {
    // Resend removed 2026-09-09. On the SES rail a non-2xx makes the provider throw,
    // which the digest maps to reason 'ses_error' and skips the idempotency insert so
    // a transient outage doesn't permanently lock out a retry.
    primeHappyReads();
    mockFetch.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    const out = await sendWeeklyDigestForOrg(
      makeEnv({
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_DEFAULT_REGION: 'us-east-1',
        SES_FROM_EMAIL: 'noreply@projectsites.dev',
      }),
      mockDb,
      {
        id: 'org-9',
        name: 'Acme',
        digest_opt_out: 0,
      },
    );
    expect(out).toEqual({ sent: false, reason: 'ses_error' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('falls back to SendGrid when SES is absent', async () => {
    primeHappyReads();
    mockFetch.mockResolvedValueOnce(res(true));
    const env = makeEnv({ SENDGRID_API_KEY: 'SG.key' });

    const out = await sendWeeklyDigestForOrg(env, mockDb, {
      id: 'org-9',
      name: 'Acme',
      digest_opt_out: 0,
    });

    expect(out).toEqual({ sent: true });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SG.key');
    const body = JSON.parse(init.body as string);
    expect(body.personalizations[0].to[0].email).toBe('owner@x.com');
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('returns send_error and skips the insert on a SendGrid non-2xx', async () => {
    // Resend removed 2026-09-09. A SendGrid non-2xx makes the central seam throw
    // "All email providers failed", which the digest maps to the generic 'send_error'
    // reason (the seam no longer surfaces the per-provider status back to the caller).
    primeHappyReads();
    mockFetch.mockResolvedValueOnce(res(false, { status: 401, text: 'unauthorized' }));
    const env = makeEnv({ SENDGRID_API_KEY: 'SG.key' });

    const out = await sendWeeklyDigestForOrg(env, mockDb, {
      id: 'org-9',
      name: 'Acme',
      digest_opt_out: 0,
    });
    expect(out).toEqual({ sent: false, reason: 'send_error' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('uses the STRIPE_WEBHOOK_SECRET → static fallback chain when WEEKLY_DIGEST_SECRET is absent', async () => {
    // Exercised on the SES rail — the one-click List-Unsubscribe header (carrying the
    // signed token) is only emitted via Content.Simple.Headers there.
    primeHappyReads();
    mockFetch.mockResolvedValueOnce(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    const env = makeEnv({
      WEEKLY_DIGEST_SECRET: undefined,
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_DEFAULT_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'noreply@projectsites.dev',
    });

    const out = await sendWeeklyDigestForOrg(env, mockDb, {
      id: 'org-secret',
      name: 'S',
      digest_opt_out: 0,
    });
    expect(out).toEqual({ sent: true });
    // Token in the unsubscribe URL must verify against the chosen fallback secret.
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const headers = body.Content.Simple.Headers as Array<{ Name: string; Value: string }>;
    const listUnsub = headers.find((h) => h.Name === 'List-Unsubscribe')!.Value;
    const token = decodeURIComponent(listUnsub.match(/token=([^>]+)>/)![1]);
    expect(await verifyUnsubscribeToken(token, 'whsec_x')).toBe('org-secret');
  });
});

// ────────────────────────────────────────────────────────────
// sendWeeklyDigestsForAllOrgs — batch tally + per-org soft-fail
// ────────────────────────────────────────────────────────────
describe('sendWeeklyDigestsForAllOrgs', () => {
  it('tallies sent / skipped / failed across orgs and soft-fails one bad row', async () => {
    const env = makeEnv();
    // org list
    mockQuery.mockResolvedValueOnce({
      data: [
        { id: 'a', name: 'A', digest_opt_out: 0 }, // → sent
        { id: 'b', name: 'B', digest_opt_out: 1 }, // → skipped (opted out, no D1)
        { id: 'c', name: 'C', digest_opt_out: 0 }, // → failed (D1 throws)
      ],
    });

    // org a: idempotency miss → owner → 4 metric counts → send ok
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ email: 'a@x.com' })
      .mockResolvedValueOnce({ n: 0 })
      .mockResolvedValueOnce({ n: 0 })
      .mockResolvedValueOnce({ n: 0 })
      .mockResolvedValueOnce({ n: 0 })
      // org c: idempotency check throws
      .mockRejectedValueOnce(new Error('d1 down'));
    // org a referrers query
    mockQuery.mockResolvedValueOnce({ data: [] });
    mockFetch.mockResolvedValueOnce(res(true)); // org a send

    const summary = await sendWeeklyDigestsForAllOrgs(env);

    expect(summary).toEqual({ total: 3, sent: 1, skipped: 1, failed: 1 });
  });

  it('returns all-zero counts for an empty org list', async () => {
    mockQuery.mockResolvedValueOnce({ data: [] });
    const summary = await sendWeeklyDigestsForAllOrgs(makeEnv());
    expect(summary).toEqual({ total: 0, sent: 0, skipped: 0, failed: 0 });
  });
});
