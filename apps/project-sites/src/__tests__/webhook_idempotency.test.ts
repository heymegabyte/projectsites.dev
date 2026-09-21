/**
 * Regression guard for the webhook idempotency classification (BILLING / REVENUE INTEGRITY, leg b).
 *
 * Pins the revenue-critical invariant in `webhook.ts` `checkWebhookIdempotency`: dedupe keys on
 * TERMINAL success (`processed` / `quarantined`) — NEVER on mere receipt. A `failed` / `received` /
 * `processing` row MUST be treated as NOT-a-duplicate so it REPROCESSES on redelivery; otherwise a
 * `checkout.session.completed` that failed processing once is stranded forever (customer charged, never
 * upgraded). If a future edit regresses this to "any row = duplicate", this test fails loudly.
 * See [[webhook-idempotency-must-key-on-terminal-success-not-receipt]] +
 * [[premature-terminal-status-plus-no-retry-strands-rows]].
 *
 * `jest.mock` uses the GLOBAL `jest` (NOT `@jest/globals`) so @swc/jest hoists it above the imports
 * (per apps/project-sites/CLAUDE.md gotcha #12); otherwise the real `./db.js` loads first and the mock no-ops.
 */
jest.mock('../services/db.js', () => ({
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(),
}));

import { checkWebhookIdempotency } from '../services/webhook.js';
import { dbQueryOne } from '../services/db.js';

const mockQueryOne = dbQueryOne as unknown as jest.Mock;
// Derive the db param type from the function signature — avoids importing D1Database into the test.
const db = {} as Parameters<typeof checkWebhookIdempotency>[0];

describe('checkWebhookIdempotency: dedupe keys on TERMINAL success, not receipt', () => {
  beforeEach(() => mockQueryOne.mockReset());

  it('no prior row → process it (not a duplicate)', async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await checkWebhookIdempotency(db, 'stripe', 'evt_new')).toEqual({ isDuplicate: false });
  });

  it('processed row → duplicate (ack + skip)', async () => {
    mockQueryOne.mockResolvedValue({ id: 'w1', status: 'processed', attempts: 1 });
    const r = await checkWebhookIdempotency(db, 'stripe', 'evt_done');
    expect(r.isDuplicate).toBe(true);
    expect(r.existingId).toBe('w1');
  });

  it('quarantined row → duplicate (poison pill exhausted its retries)', async () => {
    mockQueryOne.mockResolvedValue({ id: 'w2', status: 'quarantined', attempts: 6 });
    expect((await checkWebhookIdempotency(db, 'stripe', 'evt_dead')).isDuplicate).toBe(true);
  });

  it('FAILED row → NOT a duplicate; reprocess (the revenue-stranding guard)', async () => {
    mockQueryOne.mockResolvedValue({ id: 'w3', status: 'failed', attempts: 2 });
    const r = await checkWebhookIdempotency(db, 'stripe', 'evt_retry');
    expect(r.isDuplicate).toBe(false);
    expect(r.existingId).toBe('w3');
    expect(r.existingStatus).toBe('failed');
    expect(r.existingAttempts).toBe(2);
  });

  it('received / processing rows → NOT duplicates; reprocess on redelivery', async () => {
    for (const status of ['received', 'processing']) {
      mockQueryOne.mockResolvedValue({ id: 'wx', status, attempts: 1 });
      const r = await checkWebhookIdempotency(db, 'stripe', 'evt_inflight');
      expect(r.isDuplicate).toBe(false);
      expect(r.existingStatus).toBe(status);
    }
  });
});
