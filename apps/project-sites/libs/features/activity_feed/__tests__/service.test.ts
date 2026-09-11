/**
 * Activity Feed service unit tests — mock D1, verify aggregation logic.
 */
import { getActivityFeed } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: jest.fn(),
}));

import { dbQuery } from '../../../../src/services/db.js';

function mockEnv(): Env {
  return { DB: {} as D1Database } as unknown as Env;
}

const sampleRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: overrides.id ?? 'evt-1',
  action: overrides.action ?? 'build.completed',
  message: overrides.message ?? 'Build completed for my-site',
  actor_id: overrides.actor_id ?? 'user-1',
  target_type: overrides.target_type ?? 'site',
  target_id: overrides.target_id ?? 'site-abc',
  metadata_json: overrides.metadata_json ?? null,
  created_at: overrides.created_at ?? '2026-07-15T12:00:00Z',
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getActivityFeed', () => {
  it('returns entries from audit_logs', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({ data: [sampleRow()] });
    const { entries, hasMore } = await getActivityFeed(mockEnv(), 'org-1', 50);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('build.completed');
    expect(entries[0].summary).toBe('Build completed for my-site');
    expect(hasMore).toBe(false);
  });

  it('paginates with cursor', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({ data: [sampleRow({ created_at: '2026-07-14T00:00:00Z' })] });
    const { entries } = await getActivityFeed(mockEnv(), 'org-1', 10, '2026-07-15T00:00:00Z');
    expect(entries).toHaveLength(1);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('AND created_at <='),
      ['org-1', '2026-07-15T00:00:00Z', 11],
    );
  });

  it('detects hasMore when limit+1 returned', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => sampleRow({ id: `evt-${i}` }));
    (dbQuery as jest.Mock).mockResolvedValue({ data: rows });
    const { entries, hasMore } = await getActivityFeed(mockEnv(), 'org-1', 10);
    expect(entries).toHaveLength(10);
    expect(hasMore).toBe(true);
  });

  it('clamps limit to 100 max', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({ data: [] });
    await getActivityFeed(mockEnv(), 'org-1', 500);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('LIMIT ?'),
      ['org-1', 101],
    );
  });

  it('maps an unknown action to the neutral "activity" — NOT a false build.completed (AL-328)', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({ data: [sampleRow({ action: 'totally.custom.event' })] });
    const { entries } = await getActivityFeed(mockEnv(), 'org-1');
    expect(entries[0].kind).toBe('activity');
  });

  it('maps the REAL build/workflow/config/snapshot actions to honest kinds (was all → build.completed)', async () => {
    const cases: Array<[string, string]> = [
      ['workflow.build_complete', 'build.completed'],
      ['workflow.complete', 'build.completed'],
      ['workflow.build_started', 'build.started'],
      ['workflow.build_error', 'build.failed'],
      ['workflow.phase.research', 'workflow.started'], // prefix bucket
      ['site.snapshot.created', 'snapshot.created'],
      ['site.snapshot.deleted', 'snapshot.deleted'], // FE tones .deleted danger
      ['ai_settings.updated', 'settings.updated'],
      ['site.name_changed', 'settings.updated'],
      ['env_var.delete', 'settings.updated'],
      ['voice.agent_settings_updated', 'settings.updated'],
      ['site.sql.exec', 'data.query'],
      ['cmdk.ai.answered', 'activity'], // neutral generic (not the old false "Build")
      ['billing.subscription_updated', 'billing.plan_changed'],
    ];
    for (const [action, expected] of cases) {
      (dbQuery as jest.Mock).mockResolvedValue({ data: [sampleRow({ action })] });
      const { entries } = await getActivityFeed(mockEnv(), 'org-1');
      expect({ action, kind: entries[0].kind }).toEqual({ action, kind: expected });
    }
  });

  it('extracts actor name from metadata_json', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({
      data: [sampleRow({ metadata_json: JSON.stringify({ actor_email: 'dev@example.com' }) })],
    });
    const { entries } = await getActivityFeed(mockEnv(), 'org-1');
    expect(entries[0].actorName).toBe('dev@example.com');
  });

  it('falls back to actor_id when metadata is absent', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({ data: [sampleRow({ actor_id: 'user-42' })] });
    const { entries } = await getActivityFeed(mockEnv(), 'org-1');
    expect(entries[0].actorName).toBe('user-42');
  });

  it('handles empty result', async () => {
    (dbQuery as jest.Mock).mockResolvedValue({ data: [] });
    const { entries, hasMore } = await getActivityFeed(mockEnv(), 'org-1');
    expect(entries).toEqual([]);
    expect(hasMore).toBe(false);
  });
});
