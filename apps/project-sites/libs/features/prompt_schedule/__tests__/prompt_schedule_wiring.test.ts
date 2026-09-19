/**
 * scheduledVariantForRun — the pipeline-consumption wiring (previously built-but-unwired: the
 * runPrompt path never consulted the scheduler, so a created schedule did nothing). Locks the
 * three guarantees runPrompt depends on: FLAG-GATED (off → default, never touches D1),
 * activates a live window's variant when ON, and FAIL-SOFT (any flag/D1 error → default, a
 * scheduling outage never breaks a build).
 *
 * @swc/jest hoists jest.mock above imports only via the GLOBAL `jest` (do NOT import it); a
 * jest.mock inside libs/features/<slug>/__tests__/ needs FOUR `../` to reach src/.
 */
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: jest.fn(),
  dbInsert: jest.fn(),
  dbExecute: jest.fn(),
}));

import { scheduledVariantForRun } from '../service';
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
import { dbQuery } from '../../../../src/services/db.js';
import type { Env } from '../../../../src/types/env.js';

const mockIsFlagOn = isFlagOn as unknown as jest.Mock;
const mockDbQuery = dbQuery as unknown as jest.Mock;

const NOW = Date.parse('2026-06-15T12:00:00Z');
const env = {} as unknown as Env;

/** A D1 row shape (getActiveVariant → toSchedule maps unknown-typed rows). */
function row(partial: Record<string, unknown> = {}) {
  return {
    id: 'sch-1',
    org_id: null,
    prompt_key: 'generate_website',
    variant: 'holiday',
    activate_at: '2026-06-01T00:00:00Z',
    deactivate_at: '2026-07-01T00:00:00Z',
    label: null,
    created_at: '2026-06-01T00:00:00Z',
    ...partial,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockDbQuery.mockResolvedValue({ data: [], error: null });
});

describe('scheduledVariantForRun — runPrompt consumption of prompt_schedule', () => {
  it('flag OFF → returns null AND never queries D1 (zero hot-path cost when dark)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const v = await scheduledVariantForRun(env, '', 'generate_website', NOW);
    expect(v).toBeNull();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('flag ON + a live window → returns that window variant', async () => {
    mockDbQuery.mockResolvedValue({ data: [row({ variant: 'holiday' })], error: null });
    const v = await scheduledVariantForRun(env, '', 'generate_website', NOW);
    expect(v).toBe('holiday');
  });

  it('flag ON + no active window → returns null (default rotation)', async () => {
    mockDbQuery.mockResolvedValue({ data: [], error: null });
    expect(await scheduledVariantForRun(env, '', 'generate_website', NOW)).toBeNull();
  });

  it('flag ON + a FUTURE window → returns null (not yet active)', async () => {
    mockDbQuery.mockResolvedValue({
      data: [row({ activate_at: '2026-12-01T00:00:00Z' })],
      error: null,
    });
    expect(await scheduledVariantForRun(env, '', 'generate_website', NOW)).toBeNull();
  });

  it('FAIL-SOFT: a D1 error → null (a scheduling outage never breaks a build)', async () => {
    mockDbQuery.mockRejectedValue(new Error('D1 down'));
    expect(await scheduledVariantForRun(env, '', 'generate_website', NOW)).toBeNull();
  });

  it('FAIL-SOFT: an isFlagOn error → null', async () => {
    mockIsFlagOn.mockRejectedValue(new Error('KV down'));
    expect(await scheduledVariantForRun(env, '', 'generate_website', NOW)).toBeNull();
  });
});
