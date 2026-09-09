/**
 * @module __tests__/credits
 * @description Unit coverage for the AI credit ledger (`services/credits.ts`).
 * Exercises balance reads, debit/topup atomic batch + ledger inserts, per-org
 * scoping, and the spend-alert engine (balance_low + daily_burn kinds, 12h
 * throttle, fire-and-forget email via the central `sendEmail` seam, enabled
 * gate). Email routes SES-primary (a non-fetching Fake without AWS creds) →
 * SendGrid break-glass (`api.sendgrid.com`); Resend was removed 2026-09-09
 * (Brian directive). D1 is mocked via a small configurable stub of the
 * `prepare().bind().first()/all()/run()` + `batch()` chain; `fetch` is stubbed
 * for the SendGrid/SES call. No real APIs.
 */
import {
  CREDIT_BUNDLES,
  getBalance,
  debitCredits,
  topupCredits,
  maybeFireAlerts,
  type SpendAlertRow,
} from '../services/credits.js';
import type { Env } from '../types/env.js';

// ─── D1 mock harness ──────────────────────────────────────────
// Each prepared statement records its SQL + bound params, then resolves
// first()/all()/run() from a per-test queue keyed by call order.

interface PreparedRecord {
  sql: string;
  params: unknown[];
}

interface DbHarness {
  db: Env['DB'];
  /** statements prepared+bound outside a batch (direct .first/.all/.run) */
  prepared: PreparedRecord[];
  /** each entry is the group of statements captured for one batch() call */
  batches: PreparedRecord[][];
  /** queue of values returned by `.first<T>()`, FIFO */
  firstQueue: unknown[];
  /** queue of values returned by `.all<T>()`, FIFO */
  allQueue: Array<{ results?: unknown[] }>;
}

function makeDb(): DbHarness {
  const harness: Partial<DbHarness> = {
    prepared: [],
    batches: [],
    firstQueue: [],
    allQueue: [],
  };

  const makeStatement = (sql: string) => {
    const rec: PreparedRecord = { sql, params: [] };
    const stmt = {
      bind: (...params: unknown[]) => {
        rec.params = params;
        harness.prepared!.push(rec);
        return stmt;
      },
      first: async <T>(): Promise<T | null> => (harness.firstQueue!.shift() ?? null) as T | null,
      all: async <T>(): Promise<{ results?: T[] }> =>
        (harness.allQueue!.shift() ?? { results: [] }) as { results?: T[] },
      run: async () => ({ meta: {} }),
    };
    return stmt;
  };

  harness.db = {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (stmts: unknown[]) => {
      // debit/topup build their batch statements via fresh prepare().bind()
      // chains, so the bound records are sitting in `prepared`. Move them into
      // a batch group so callers can assert per-batch shape.
      harness.batches!.push(harness.prepared!.splice(0));
      return stmts.map(() => ({ meta: {} }));
    },
  } as unknown as Env['DB'];

  return harness as DbHarness;
}

function makeEnv(db: Env['DB'], extra: Partial<Env> = {}): Env {
  return { DB: db, ...extra } as unknown as Env;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── CREDIT_BUNDLES ───────────────────────────────────────────

describe('CREDIT_BUNDLES', () => {
  it('exposes starter/pro/scale bundles with credits + price_id + usd', () => {
    expect(CREDIT_BUNDLES.starter).toEqual({
      credits: 100,
      price_id: 'STRIPE_PRICE_CREDITS_100',
      usd: 5,
    });
    expect(CREDIT_BUNDLES.pro.credits).toBe(500);
    expect(CREDIT_BUNDLES.scale.credits).toBe(2000);
    expect(Object.keys(CREDIT_BUNDLES)).toEqual(['starter', 'pro', 'scale']);
  });
});

// ─── getBalance ───────────────────────────────────────────────

describe('getBalance', () => {
  it('returns the balance from the row', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 42 });
    const balance = await getBalance(makeEnv(h.db), 'org-a');
    expect(balance).toBe(42);
  });

  it('returns 0 when no row exists', async () => {
    const h = makeDb();
    // firstQueue empty → first() resolves null
    const balance = await getBalance(makeEnv(h.db), 'org-missing');
    expect(balance).toBe(0);
  });

  it('returns 0 when balance is zero', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 0 });
    const balance = await getBalance(makeEnv(h.db), 'org-zero');
    expect(balance).toBe(0);
  });

  it('scopes the query to the org_id', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 7 });
    await getBalance(makeEnv(h.db), 'org-scope');
    const rec = h.prepared[0];
    expect(rec.sql).toContain('ai_credits_balance');
    expect(rec.sql).toContain('WHERE org_id = ?');
    expect(rec.params).toEqual(['org-scope']);
  });
});

// ─── debitCredits ─────────────────────────────────────────────

describe('debitCredits', () => {
  it('runs an atomic batch (balance upsert + ledger insert) then returns fresh balance', async () => {
    const h = makeDb();
    // After the batch, debitCredits calls getBalance → one first()
    h.firstQueue.push({ balance: 95 });

    const fresh = await debitCredits(makeEnv(h.db), {
      orgId: 'org-a',
      siteId: 'site-1',
      amount: 5,
      reason: 'ai_invocation',
      aiLogId: 'log-9',
    });

    expect(fresh).toBe(95);
    // exactly one batch of two statements
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(2);
  });

  it('inserts a ledger row with NEGATIVE delta + a uuid id', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 90 });

    await debitCredits(makeEnv(h.db), {
      orgId: 'org-a',
      amount: 10,
      reason: 'ai_invocation',
    });

    const [balanceStmt, ledgerStmt] = h.batches[0];
    expect(balanceStmt.sql).toContain('ai_credits_balance');
    expect(ledgerStmt.sql).toContain('ai_credits_ledger');
    // ledger params: id, org_id, site_id(null), delta(-amount), reason, ai_log_id(null)
    expect(ledgerStmt.params[1]).toBe('org-a');
    expect(ledgerStmt.params[2]).toBeNull(); // siteId omitted → null
    expect(ledgerStmt.params[3]).toBe(-10); // negative delta
    expect(ledgerStmt.params[4]).toBe('ai_invocation');
    expect(ledgerStmt.params[5]).toBeNull(); // aiLogId omitted → null
    expect(typeof ledgerStmt.params[0]).toBe('string'); // uuid id
  });

  it('binds the balance upsert with amount on both insert + conflict paths', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 88 });

    await debitCredits(makeEnv(h.db), { orgId: 'org-x', amount: 12, reason: 'gen' });

    const balanceStmt = h.batches[0][0];
    // amount is bound POSITIVE in all 4 slots; the negation lives in the SQL
    // (`VALUES (?, -?, ...)` + `SET balance = balance - ?`), not the params.
    expect(balanceStmt.params).toEqual(['org-x', 12, 12, 12, 12]);
    expect(balanceStmt.sql).toContain('balance = balance - ?');
  });

  it('passes siteId + aiLogId through when provided', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 50 });

    await debitCredits(makeEnv(h.db), {
      orgId: 'org-a',
      siteId: 'site-7',
      amount: 3,
      reason: 'edit',
      aiLogId: 'ai-42',
    });

    const ledgerStmt = h.batches[0][1];
    expect(ledgerStmt.params[2]).toBe('site-7');
    expect(ledgerStmt.params[5]).toBe('ai-42');
  });
});

// ─── topupCredits ─────────────────────────────────────────────

describe('topupCredits', () => {
  it('runs a batch then returns the fresh balance', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 200 });

    const fresh = await topupCredits(makeEnv(h.db), {
      orgId: 'org-a',
      amount: 100,
      stripeSessionId: 'cs_test_1',
    });

    expect(fresh).toBe(200);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(2);
  });

  it('inserts a POSITIVE delta ledger row + default reason "topup"', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 100 });

    await topupCredits(makeEnv(h.db), { orgId: 'org-a', amount: 100 });

    const ledgerStmt = h.batches[0][1];
    expect(ledgerStmt.sql).toContain('ai_credits_ledger');
    expect(ledgerStmt.params[1]).toBe('org-a');
    expect(ledgerStmt.params[2]).toBe(100); // positive delta
    expect(ledgerStmt.params[3]).toBe('topup'); // default reason
    expect(ledgerStmt.params[4]).toBeNull(); // stripeSessionId omitted → null
  });

  it('passes stripeSessionId + custom reason through', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 600 });

    await topupCredits(makeEnv(h.db), {
      orgId: 'org-a',
      amount: 500,
      stripeSessionId: 'cs_live_99',
      reason: 'bundle_pro',
    });

    const ledgerStmt = h.batches[0][1];
    expect(ledgerStmt.params[3]).toBe('bundle_pro');
    expect(ledgerStmt.params[4]).toBe('cs_live_99');
  });

  it('seeds the balance upsert with the positive amount', async () => {
    const h = makeDb();
    h.firstQueue.push({ balance: 100 });

    await topupCredits(makeEnv(h.db), { orgId: 'org-b', amount: 100 });

    const balanceStmt = h.batches[0][0];
    expect(balanceStmt.params[0]).toBe('org-b');
    expect(balanceStmt.params).toContain(100);
  });
});

// ─── maybeFireAlerts ──────────────────────────────────────────

const alertRow = (over: Partial<SpendAlertRow> = {}): SpendAlertRow => ({
  id: 'al-1',
  name: 'Low balance',
  threshold_credits: 10,
  trigger_type: 'balance_below',
  email: 'ops@example.com',
  last_fired_at: null,
  ...over,
});

describe('maybeFireAlerts', () => {
  it('no-ops when no enabled alerts exist', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [] });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db), 'org-a', 3);

    expect(fetchSpy).not.toHaveBeenCalled();
    // only the alert-list query ran, no UPDATE
    expect(h.prepared).toHaveLength(1);
  });

  it('queries enabled alerts scoped to the org', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [] });
    await maybeFireAlerts(makeEnv(h.db), 'org-scope', 5);
    const rec = h.prepared[0];
    expect(rec.sql).toContain('spend_alerts');
    expect(rec.sql).toContain('deleted_at IS NULL');
    expect(rec.params).toEqual(['org-scope']);
  });

  it('fires a balance_low alert when balance <= threshold and SendGrid is configured', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10 })] });
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, headers: new Headers() });
    global.fetch = fetchSpy as unknown as typeof fetch;

    // Resend removed (Brian directive 2026-09-09); with no AWS creds the SES rail is a
    // non-fetching Fake, so SendGrid is the break-glass rail that actually POSTs.
    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 5);

    // UPDATE last_triggered_at ran
    expect(h.prepared.some((p) => p.sql.includes('UPDATE spend_alerts'))).toBe(true);
    // SendGrid POST fired (never api.resend.com)
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({ method: 'POST' }),
    );
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('api.resend.com'))).toBe(false);
  });

  it('routes a balance_low alert through Amazon SES, not Resend, when SES is configured (ADR-0019)', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10 })] });
    const fetchSpy = jest
      .fn()
      .mockResolvedValue(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(
      makeEnv(h.db, {
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_DEFAULT_REGION: 'us-east-1',
        SES_FROM_EMAIL: 'noreply@projectsites.dev',
      }),
      'org-a',
      5,
    );

    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('amazonaws.com'))).toBe(true);
    expect(urls.some((u) => u.includes('api.resend.com'))).toBe(false);
  });

  it('does NOT fire balance_low when balance is above threshold', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10 })] });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    // A rail IS configured (SendGrid) so a fetch WOULD fire if the threshold tripped —
    // asserting it didn't proves the balance-gate, not a missing provider.
    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 50);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.prepared.some((p) => p.sql.includes('UPDATE spend_alerts'))).toBe(false);
  });

  it('updates last_triggered_at but skips the email send when no provider configured', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10 })] });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db), 'org-a', 5); // no AWS/SendGrid creds → no rail

    expect(h.prepared.some((p) => p.sql.includes('UPDATE spend_alerts'))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throttles when last_triggered_at is within 12h', async () => {
    const h = makeDb();
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10, last_fired_at: recent })] });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 5);

    expect(fetchSpy).not.toHaveBeenCalled();
    // no UPDATE because throttled
    expect(h.prepared.some((p) => p.sql.includes('UPDATE spend_alerts'))).toBe(false);
  });

  it('fires again when last_triggered_at is older than 12h', async () => {
    const h = makeDb();
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(); // 13h ago
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10, last_fired_at: old })] });
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, headers: new Headers() });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 5);

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('fires a daily_burn alert when summed spend >= threshold', async () => {
    const h = makeDb();
    h.allQueue.push({
      results: [alertRow({ trigger_type: 'rate_spike', threshold_credits: 100 })],
    });
    // the daily-burn sub-query first() returns the spent total
    h.firstQueue.push({ spent: 150 });
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, headers: new Headers() });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 80);

    expect(fetchSpy).toHaveBeenCalled();
    expect(h.prepared.some((p) => p.sql.includes('UPDATE spend_alerts'))).toBe(true);
  });

  it('does NOT fire daily_burn when summed spend is below threshold', async () => {
    const h = makeDb();
    h.allQueue.push({
      results: [alertRow({ trigger_type: 'rate_spike', threshold_credits: 100 })],
    });
    h.firstQueue.push({ spent: 40 });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 80);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a missing daily-burn sum as 0 (no fire)', async () => {
    const h = makeDb();
    h.allQueue.push({
      results: [alertRow({ alert_kind: 'daily_burn', threshold_credits: 1 })],
    });
    // firstQueue empty → sub-query first() returns null → COALESCE → 0 < 1
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 80);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows a failed SendGrid fetch (fire-and-forget)', async () => {
    const h = makeDb();
    h.allQueue.push({ results: [alertRow({ threshold_credits: 10 })] });
    const fetchSpy = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      maybeFireAlerts(makeEnv(h.db, { SENDGRID_API_KEY: 'SG.test' }), 'org-a', 5),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalled();
  });
});
