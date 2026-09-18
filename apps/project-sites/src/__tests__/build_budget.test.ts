/**
 * Unit coverage for `services/build_budget.ts` — the AI-spend budget gate.
 * Previously UNtested (token_burn_meter.test.ts only mentions it in a comment;
 * it actually tests features.ts). This is billing-adjacent logic that returns
 * `allowed:false` to 403 an org over its monthly AI budget, so its branches
 * (tier resolution, over/under cap, clamping, unlimited short-circuit) and the
 * best-effort spend writer (validate → micro-USD → insert) must be covered.
 */
import {
  checkBudget,
  recordSpend,
  PLAN_BUDGET_USD,
  AI_SPEND_METRIC,
} from '../services/build_budget.js';

// SQL-aware D1 mock. The owner-email lookup (hasUnlimitedBudget) returns null so
// the test org is never treated as unlimited; the SUM lookup returns a
// configurable monthly micro-USD spend; INSERTs are captured for assertions.
let spendMicro = 0;
let inserts: string[] = [];
const mockDb = {
  prepare: jest.fn((sql: string) => {
    // dbQueryOne reads `.all().results[0]` (NOT `.first()`), so the SUM lookup
    // must surface its row via `all`. Owner-email lookup → empty → not unlimited.
    const isSum = /SUM\(value\)/i.test(sql);
    return {
      bind: jest.fn(() => ({
        first: jest.fn().mockResolvedValue(isSum ? { total: spendMicro } : null),
        all: jest.fn().mockResolvedValue({ results: isSum ? [{ total: spendMicro }] : [] }),
        run: jest.fn().mockImplementation(() => {
          if (/^INSERT/i.test(sql)) inserts.push(sql);
          return Promise.resolve({});
        }),
      })),
    };
  }),
} as unknown as D1Database;

beforeEach(() => {
  spendMicro = 0;
  inserts = [];
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('checkBudget', () => {
  it('unlimited plan short-circuits to allowed + Infinity cap (no spend query)', async () => {
    const m = await checkBudget(mockDb, 'org-1', 'unlimited');
    expect(m.allowed).toBe(true);
    expect(m.capUsd).toBe(Infinity);
    expect(m.remainingUsd).toBe(Infinity);
    expect(m.pct).toBe(0);
  });

  it('paid plan under cap → allowed with correct spent/remaining/pct', async () => {
    spendMicro = 50 * 1_000_000; // $50 of a $100 cap
    const m = await checkBudget(mockDb, 'org-1', 'paid');
    expect(m.allowed).toBe(true);
    expect(m.capUsd).toBe(PLAN_BUDGET_USD.paid); // 100
    expect(m.spentUsd).toBe(50);
    expect(m.remainingUsd).toBe(50);
    expect(m.pct).toBe(50);
  });

  it('free plan over cap → blocked, remaining clamped to 0, pct clamped to 100', async () => {
    spendMicro = 6 * 1_000_000; // $6 of a $5 cap
    const m = await checkBudget(mockDb, 'org-1', 'free');
    expect(m.allowed).toBe(false);
    expect(m.capUsd).toBe(PLAN_BUDGET_USD.free); // 5
    expect(m.spentUsd).toBe(6);
    expect(m.remainingUsd).toBe(0);
    expect(m.pct).toBe(100);
  });

  it('unknown/null plan resolves to the free tier', async () => {
    spendMicro = 0;
    const m = await checkBudget(mockDb, 'org-1', 'garbage-plan');
    expect(m.capUsd).toBe(PLAN_BUDGET_USD.free);
    const mNull = await checkBudget(mockDb, 'org-1', null);
    expect(mNull.capUsd).toBe(PLAN_BUDGET_USD.free);
  });

  it('exactly at cap is NOT allowed (spent < cap is the gate)', async () => {
    spendMicro = 5 * 1_000_000; // exactly $5 of $5
    const m = await checkBudget(mockDb, 'org-1', 'free');
    expect(m.allowed).toBe(false);
    expect(m.remainingUsd).toBe(0);
  });
});

describe('checkBudget — fails CLOSED on a D1 error (AL-785, never OPEN the AI-spend killswitch)', () => {
  // A db whose SUM(value) spend query rejects `rejectTimes` times (owner-lookup + anything else
  // resolves empty, so the org is never treated as unlimited). dbQuery catches the throw →
  // { data: [], error } — the ONLY reliable D1-error signal monthSpendMicroUsd can inspect.
  function throwingSpendDb(rejectTimes: number) {
    let sumCalls = 0;
    return {
      prepare: jest.fn((sql: string) => ({
        bind: jest.fn(() => ({
          first: jest.fn().mockResolvedValue(null),
          all: jest.fn().mockImplementation(() => {
            if (/SUM\(value\)/i.test(sql)) {
              sumCalls++;
              if (sumCalls <= rejectTimes) return Promise.reject(new Error('D1_ERROR: read replica down'));
              return Promise.resolve({ results: [{ total: 2 * 1_000_000 }] }); // $2 once recovered
            }
            return Promise.resolve({ results: [] }); // owner lookup / other → not unlimited
          }),
          run: jest.fn().mockResolvedValue({}),
        })),
      })),
    } as unknown as D1Database;
  }

  it('DENIES on a SUSTAINED spend-query D1 error instead of reading spend as $0 (killswitch stays CLOSED)', async () => {
    const m = await checkBudget(throwingSpendDb(Infinity), 'org-budget-err', 'free');
    // RED before AL-785: dbQueryOne SWALLOWED the error → spend $0 → allowed:true (killswitch OPEN,
    // the runaway-cost hole). GREEN: fail-closed — spend treated as at-cap → denied, clean $cap/$cap.
    expect(m.allowed).toBe(false);
    expect(m.capUsd).toBe(PLAN_BUDGET_USD.free); // 5
    expect(m.spentUsd).toBe(PLAN_BUDGET_USD.free); // clamped to the cap, NOT Infinity
    expect(m.remainingUsd).toBe(0);
    expect(Number.isFinite(m.spentUsd)).toBe(true); // meter never shows "$Infinity"
  });

  it('RETRIES once and RECOVERS the real spend on a single transient blip (no false denial)', async () => {
    const m = await checkBudget(throwingSpendDb(1), 'org-budget-retry', 'free'); // fail once, then $2
    expect(m.allowed).toBe(true); // the retry recovered the real $2 spend under the $5 cap
    expect(m.spentUsd).toBe(2);
  });
});

describe('recordSpend', () => {
  it('records a valid spend as integer micro-USD into usage_events', async () => {
    await recordSpend({ DB: mockDb }, 'org-1', {
      tokensIn: 1200,
      tokensOut: 800,
      model: 'claude-opus',
      usd: 0.42,
    });
    expect(inserts.length).toBe(1);
    expect(inserts[0]).toMatch(/INSERT INTO usage_events/i);
  });

  it('drops an invalid record (no insert, no throw)', async () => {
    await expect(
      // usd is required + finite; a NaN/missing usd fails the schema
      recordSpend({ DB: mockDb }, 'org-1', { model: 'x', usd: Number.NaN } as never),
    ).resolves.toBeUndefined();
    expect(inserts.length).toBe(0);
  });

  it('skips a zero-dollar spend (micro-USD rounds to 0 → no insert)', async () => {
    await recordSpend({ DB: mockDb }, 'org-1', { model: 'claude-haiku', usd: 0 });
    expect(inserts.length).toBe(0);
  });

  it('logs the drop with billing context on an insert failure (best-effort — never throws)', async () => {
    const throwingDb = {
      prepare: jest.fn(() => ({
        bind: jest.fn(() => ({ run: jest.fn().mockRejectedValue(new Error('d1 down')) })),
      })),
    } as unknown as D1Database;
    await expect(
      recordSpend({ DB: throwingDb }, 'org-1', { model: 'm', usd: 1.5 }),
    ).resolves.toBeUndefined();
    // dbExecute swallows the D1 error and returns `{ error }` (it never throws), so the
    // old dead try/catch never surfaced the drop — only db.ts's generic d1_exec_error
    // fired. recordSpend MUST now log its OWN billing-context warn (org/model) so an
    // under-counted AI-spend budget meter is observable, not silent.
    // A dropped spend write MUST log the billing-context warn (jest here rejects the
    // 2-arg expect(value, message) form — keep the rationale in this comment).
    const warned = (console.warn as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('failed to record spend'));
    expect(warned).toBeTruthy();
    expect(warned).toContain('org-1');
    expect(warned).toContain('"model":"m"');
  });

  it('uses the canonical AI_SPEND_METRIC name', () => {
    expect(AI_SPEND_METRIC).toBe('ai_spend_micro_usd');
  });
});
