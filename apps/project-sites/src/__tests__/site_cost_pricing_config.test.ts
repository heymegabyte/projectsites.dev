/**
 * Unit tests for pricing-engine-v2 (fire-86) — `resolvePricing` in services/site_cost.ts.
 *
 * Asserts the flag-gated read path:
 *   • flag OFF (default) → the hardcoded DEFAULT_UNIT_PRICES + PLATFORM_FEE_USD, ZERO DB read.
 *   • flag ON            → the seeded pricing_config D1 table values (value_usd authoritative).
 *   • fail-soft          → a malformed / missing row falls back to the hardcoded constant.
 *
 * Both the flag resolver and the D1 read are mocked (no I/O). Mocks are declared with the GLOBAL
 * `jest` (NOT imported from @jest/globals) so @swc/jest hoists them above the imports — per the
 * project CLAUDE.md gotcha; importing `jest` would leave the real isFlagOn/dbQuery loading first.
 */
jest.mock('../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../services/db.js', () => ({ dbQuery: jest.fn(), dbQueryOne: jest.fn() }));

import { isFlagOn } from '../modules/feature_flags/services.js';
import { dbQuery } from '../services/db.js';
import { DEFAULT_UNIT_PRICES, PLATFORM_FEE_USD, resolvePricing } from '../services/site_cost.js';
import type { Env } from '../types/env.js';

const mockIsFlagOn = isFlagOn as jest.MockedFunction<typeof isFlagOn>;
const mockDbQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;

// A minimal env — resolvePricing only ever touches env.DB through the (mocked) dbQuery.
const env = { DB: {} } as unknown as Env;

/** The 9 rows the 0655 migration seeds — value_usd matches the current hardcoded constants. */
const SEED_ROWS = [
  { key: 'worker_requests', value_cents: 30, value_usd: 0.3 },
  { key: 'worker_cpu', value_cents: 2, value_usd: 0.02 },
  { key: 'd1_rows_read', value_cents: 0, value_usd: 0.001 },
  { key: 'd1_rows_written', value_cents: 100, value_usd: 1.0 },
  { key: 'd1_storage', value_cents: 75, value_usd: 0.75 },
  { key: 'r2_storage_std', value_cents: 2, value_usd: 0.015 },
  { key: 'r2_class_a', value_cents: 450, value_usd: 4.5 },
  { key: 'r2_class_b', value_cents: 36, value_usd: 0.36 },
  { key: 'platform_fee', value_cents: 5000, value_usd: 50.0 },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolvePricing — pricing_config_v2 flag gate', () => {
  it('flag OFF returns the hardcoded defaults and never reads the DB', async () => {
    mockIsFlagOn.mockResolvedValue(false);

    const pricing = await resolvePricing(env, { orgId: 'org_1' });

    expect(pricing.workerRequests.priceUsd).toBe(DEFAULT_UNIT_PRICES.workerRequests.priceUsd);
    expect(pricing.d1RowsRead.priceUsd).toBe(DEFAULT_UNIT_PRICES.d1RowsRead.priceUsd);
    expect(pricing.r2ClassA.priceUsd).toBe(DEFAULT_UNIT_PRICES.r2ClassA.priceUsd);
    expect(pricing.platformFeeUsd).toBe(PLATFORM_FEE_USD);
    // Byte-identical object shape to the hardcoded floor.
    expect(pricing).toEqual({ ...DEFAULT_UNIT_PRICES, platformFeeUsd: PLATFORM_FEE_USD });
    // The flag being off short-circuits BEFORE any DB read.
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('flag ON returns the seeded pricing_config table values (value_usd authoritative)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockDbQuery.mockResolvedValue({ data: SEED_ROWS, error: null });

    const pricing = await resolvePricing(env, { orgId: 'org_1' });

    // Rates come from the table; code-owned label/unit/divisor are preserved.
    expect(pricing.workerRequests.priceUsd).toBe(0.3);
    expect(pricing.workerRequests.divisor).toBe(DEFAULT_UNIT_PRICES.workerRequests.divisor);
    expect(pricing.d1RowsRead.priceUsd).toBe(0.001);
    expect(pricing.d1RowsWritten.priceUsd).toBe(1.0);
    expect(pricing.r2ClassA.priceUsd).toBe(4.5);
    expect(pricing.r2StorageStd.priceUsd).toBe(0.015);
    expect(pricing.platformFeeUsd).toBe(50);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it('flag ON with the seed = identical rates to flag OFF (turning it on is behavior-identical)', async () => {
    mockIsFlagOn.mockResolvedValueOnce(false);
    const off = await resolvePricing(env, { orgId: 'org_1' });

    mockIsFlagOn.mockResolvedValueOnce(true);
    mockDbQuery.mockResolvedValueOnce({ data: SEED_ROWS, error: null });
    const on = await resolvePricing(env, { orgId: 'org_1' });

    expect(on).toEqual(off);
  });

  it('flag ON reflects a super-admin edit to a single rate', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockDbQuery.mockResolvedValue({
      data: SEED_ROWS.map((r) =>
        r.key === 'worker_requests' ? { ...r, value_usd: 0.5, value_cents: 50 } : r,
      ),
      error: null,
    });

    const pricing = await resolvePricing(env, { orgId: 'org_1' });

    expect(pricing.workerRequests.priceUsd).toBe(0.5); // edited
    expect(pricing.d1Storage.priceUsd).toBe(0.75); // untouched
  });

  it('falls back to value_cents / 100 when value_usd is absent', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockDbQuery.mockResolvedValue({
      data: [{ key: 'platform_fee', value_cents: 6000, value_usd: null }],
      error: null,
    });

    const pricing = await resolvePricing(env, {});

    expect(pricing.platformFeeUsd).toBe(60); // 6000 cents → $60
    // Every unmapped key keeps its default.
    expect(pricing.workerRequests.priceUsd).toBe(DEFAULT_UNIT_PRICES.workerRequests.priceUsd);
  });

  it('is fail-soft: a DB error or empty table yields the hardcoded floor', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockDbQuery.mockResolvedValue({ data: [], error: 'd1 unavailable' });

    const pricing = await resolvePricing(env, {});

    expect(pricing).toEqual({ ...DEFAULT_UNIT_PRICES, platformFeeUsd: PLATFORM_FEE_USD });
  });

  it('is fail-soft per-row: a malformed row keeps that key default, valid rows still apply', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockDbQuery.mockResolvedValue({
      data: [
        { key: 'worker_cpu', value_cents: null, value_usd: null }, // malformed → default kept
        { key: 'r2_class_b', value_cents: 36, value_usd: 0.99 }, // valid → applied
        { key: 'unknown_future_key', value_cents: 1, value_usd: 0.01 }, // ignored
      ],
      error: null,
    });

    const pricing = await resolvePricing(env, {});

    expect(pricing.workerCpu.priceUsd).toBe(DEFAULT_UNIT_PRICES.workerCpu.priceUsd); // default
    expect(pricing.r2ClassB.priceUsd).toBe(0.99); // applied
  });
});
