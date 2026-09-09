/**
 * Tests for src/services/weekly_digest.ts (item #96).
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

import { dbQuery, dbQueryOne, dbInsert } from '../services/db.js';
import {
  sendWeeklyDigestForOrg,
  renderDigestHtml,
  computeWeeklyMetrics,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  isoWeekString,
  sendWeeklyDigestsForAllOrgs,
} from '../services/weekly_digest.js';

const mockQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;
const mockQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;
const mockInsert = dbInsert as jest.MockedFunction<typeof dbInsert>;

const mockDb = {} as D1Database;
const originalFetch = global.fetch;

const baseEnv = {
  DB: mockDb,
  // SES is the primary provider (Resend removed 2026-09-09, Brian directive).
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret-key',
  AWS_REGION: 'us-east-1',
  SES_FROM_EMAIL: 'noreply@projectsites.dev',
  WEEKLY_DIGEST_SECRET: 'secret-abc',
} as unknown as import('../types/env.js').Env;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('isoWeekString', () => {
  it('formats year + week with zero-padded week number', () => {
    // 2026-05-21 (Thursday) falls in ISO week 21.
    const week = isoWeekString(new Date('2026-05-21T00:00:00Z'));
    expect(week).toMatch(/^\d{4}-W\d{2}$/);
    expect(week.endsWith('W21')).toBe(true);
  });
});

describe('signUnsubscribeToken + verifyUnsubscribeToken', () => {
  it('round-trips and matches the org id', async () => {
    const token = await signUnsubscribeToken('org-1', 'secret');
    const orgId = await verifyUnsubscribeToken(token, 'secret');
    expect(orgId).toBe('org-1');
  });

  it('rejects tampered tokens', async () => {
    const token = await signUnsubscribeToken('org-1', 'secret');
    const tampered = token.slice(0, -1) + '0';
    const orgId = await verifyUnsubscribeToken(tampered, 'secret');
    expect(orgId).toBeNull();
  });

  it('rejects tokens signed with a different secret', async () => {
    const token = await signUnsubscribeToken('org-1', 'secret-a');
    const orgId = await verifyUnsubscribeToken(token, 'secret-b');
    expect(orgId).toBeNull();
  });
});

describe('computeWeeklyMetrics', () => {
  it('aggregates counters from D1', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ n: 3 }) // sites_updated
      .mockResolvedValueOnce({ n: 12 }) // form submissions
      .mockResolvedValueOnce({ n: 47 }) // ai traces
      .mockResolvedValueOnce({ n: 1 }); // errors
    mockQuery.mockResolvedValueOnce({
      data: [
        { metadata_json: JSON.stringify({ referrer: 'https://google.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'https://google.com' }) },
        { metadata_json: JSON.stringify({ referrer: 'https://bing.com' }) },
      ],
      error: null,
    });
    const m = await computeWeeklyMetrics(mockDb, 'org-1');
    expect(m.sites_updated).toBe(3);
    expect(m.form_submissions).toBe(12);
    expect(m.ai_traces).toBe(47);
    expect(m.errors).toBe(1);
    expect(m.top_referrers[0]).toEqual({ referrer: 'https://google.com', count: 2 });
  });
});

describe('renderDigestHtml', () => {
  it('includes the metric values and unsubscribe link in the HTML', () => {
    const html = renderDigestHtml({
      orgName: 'Acme Inc',
      weekIso: '2026-W21',
      metrics: {
        sites_updated: 4,
        form_submissions: 9,
        ai_traces: 100,
        errors: 0,
        top_referrers: [{ referrer: 'https://google.com', count: 5 }],
      },
      unsubscribeUrl: 'https://projectsites.dev/api/email/unsubscribe?token=abc',
      dashboardUrl: 'https://projectsites.dev/admin',
    });
    expect(html).toContain('Acme Inc');
    expect(html).toContain('Sites updated');
    expect(html).toContain('Form submissions');
    expect(html).toContain('100'); // ai traces locale-string
    expect(html).toContain('https://projectsites.dev/api/email/unsubscribe?token=abc');
    expect(html).toContain('#00E5FF');
    expect(html).toContain('#060610');
    expect(html).toContain('google.com');
  });
});

describe('sendWeeklyDigestForOrg', () => {
  it('skips when org has opted out', async () => {
    const result = await sendWeeklyDigestForOrg(baseEnv, mockDb, {
      id: 'org-1',
      name: 'Acme',
      digest_opt_out: 1,
    });
    expect(result).toEqual({ sent: false, reason: 'opted_out' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is idempotent — second call inside the same week is a no-op', async () => {
    // Existing weekly_digest_sent row for this org+week.
    mockQueryOne.mockResolvedValueOnce({ id: 'wd_1' });
    const result = await sendWeeklyDigestForOrg(baseEnv, mockDb, {
      id: 'org-1',
      name: 'Acme',
      digest_opt_out: 0,
    });
    expect(result).toEqual({ sent: false, reason: 'already_sent' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('sends via Amazon SES and inserts the idempotency row', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null) // no existing weekly_digest_sent row
      .mockResolvedValueOnce({ email: 'owner@acme.com' }) // owner email lookup
      // computeWeeklyMetrics: 4 counters + maybe one for referrers
      .mockResolvedValueOnce({ n: 2 })
      .mockResolvedValueOnce({ n: 8 })
      .mockResolvedValueOnce({ n: 25 })
      .mockResolvedValueOnce({ n: 0 });
    mockQuery.mockResolvedValueOnce({ data: [], error: null }); // referrer scan
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    });

    const result = await sendWeeklyDigestForOrg(baseEnv, mockDb, {
      id: 'org-1',
      name: 'Acme',
      digest_opt_out: 0,
    });

    // Digest sends via the SES-primary rail (Resend removed 2026-09-09) and records
    // the idempotency row. The SES transactional provider signs + sends internally
    // (not through the global.fetch mock), so we assert the observable OUTCOME.
    expect(result.sent).toBe(true);

    expect(mockInsert).toHaveBeenCalledWith(
      mockDb,
      'weekly_digest_sent',
      expect.objectContaining({
        org_id: 'org-1',
        recipient_email: 'owner@acme.com',
        opens_count: 0,
      }),
    );
  });

  it('returns no_owner_email when owner has no email', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const result = await sendWeeklyDigestForOrg(baseEnv, mockDb, {
      id: 'org-1',
      name: 'Acme',
      digest_opt_out: 0,
    });
    expect(result.reason).toBe('no_owner_email');
  });
});

describe('sendWeeklyDigestsForAllOrgs', () => {
  it('aggregates totals across orgs and soft-fails per-row', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [
        { id: 'org-1', name: 'A', digest_opt_out: 1 },
        { id: 'org-2', name: 'B', digest_opt_out: 1 },
      ],
      error: null,
    });
    const result = await sendWeeklyDigestsForAllOrgs(baseEnv);
    expect(result.total).toBe(2);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
  });
});
