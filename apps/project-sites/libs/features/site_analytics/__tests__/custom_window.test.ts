/**
 * Unit tests for the arbitrary {since, until} window threaded through the D1
 * first-party audience path the Editor UI actually calls: getSiteAnalyticsSummary
 * (+ its "new in window" contact/form counts + getTrafficSummary) and getDailySeries.
 *
 * Absolute window → bound SQLite-comparable literals (created_at >= ? AND < ?);
 * no window → the trailing relative datetime('now') window (backward-compat). A
 * param-capturing D1 stub records every (sql, params) so we assert the exact bounds.
 */

import { getDailySeries, getSiteAnalyticsSummary } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function captureEnv(): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            all: async () => ({ results: [] as unknown[] }),
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

describe('getDailySeries — absolute window', () => {
  it('binds the [since, until) literals for an absolute window', async () => {
    const { env, calls } = captureEnv();
    await getDailySeries(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    const q = calls.find((c) => c.sql.includes('date(created_at) AS day'));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(q!.sql).not.toContain("datetime('now'");
    expect(q!.params).toEqual(['site_1', '2026-08-01', '2026-08-16']);
  });

  it('keeps the relative window with no absolute window', async () => {
    const { env, calls } = captureEnv();
    await getDailySeries(env, 'site_1', 7);
    const q = calls.find((c) => c.sql.includes('date(created_at) AS day'));
    expect(q!.sql).toContain("datetime('now', ?)");
    expect(q!.params).toEqual(['site_1', '-7 days']);
  });
});

describe('getSiteAnalyticsSummary — absolute window', () => {
  it('binds the absolute window on the "new in window" contact + form counts', async () => {
    const { env, calls } = captureEnv();
    await getSiteAnalyticsSummary(env, 'org_1', 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    const contactsNew = calls.find(
      (c) => c.sql.includes('FROM contacts') && c.sql.includes('deleted_at IS NULL AND created_at'),
    );
    expect(contactsNew).toBeDefined();
    expect(contactsNew!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(contactsNew!.params).toEqual(['org_1', 'site_1', '2026-08-01', '2026-08-16']);
    const formNew = calls.find(
      (c) => c.sql.includes('FROM form_submissions') && c.sql.includes('AND created_at >= ?'),
    );
    expect(formNew!.params).toEqual(['org_1', 'site_1', '2026-08-01', '2026-08-16']);
  });

  it('reports windowDays as the span of the absolute window', async () => {
    const { env } = captureEnv();
    const s = await getSiteAnalyticsSummary(env, 'org_1', 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' });
    expect(s.windowDays).toBe(15);
  });

  it('keeps the relative window + requested windowDays with no absolute window', async () => {
    const { env, calls } = captureEnv();
    const s = await getSiteAnalyticsSummary(env, 'org_1', 'site_1', 30);
    expect(s.windowDays).toBe(30);
    const contactsNew = calls.find(
      (c) => c.sql.includes('FROM contacts') && c.sql.includes('deleted_at IS NULL AND created_at'),
    );
    expect(contactsNew!.sql).toContain("datetime('now', ?)");
    expect(contactsNew!.params).toEqual(['org_1', 'site_1', '-30 days']);
  });
});

describe('getDailySeries — timezone-aware day bucketing', () => {
  it('shifts the day bucket by a bound minutes-offset modifier for a valid tz', async () => {
    const { env, calls } = captureEnv();
    await getDailySeries(env, 'site_1', 30, undefined, -480); // PST (UTC-8)
    const q = calls.find((c) => c.sql.includes('AS day'));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('date(created_at, ?) AS day');
    expect(q!.sql).toContain('GROUP BY date(created_at, ?)');
    expect(q!.sql).not.toContain('date(created_at) AS day'); // no bare UTC bucket
    // params: [SELECT modifier, siteId, timeParam(relative -30 days), GROUP BY modifier]
    expect(q!.params).toEqual(['-480 minutes', 'site_1', '-30 days', '-480 minutes']);
  });

  it('keeps the bare UTC bucket (no modifier) when no tz is given', async () => {
    const { env, calls } = captureEnv();
    await getDailySeries(env, 'site_1', 30);
    const q = calls.find((c) => c.sql.includes('AS day'));
    expect(q!.sql).toContain('date(created_at) AS day');
    expect(q!.sql).not.toContain('date(created_at, ?)');
    expect(q!.params).toEqual(['site_1', '-30 days']);
  });

  it('fails SAFE to UTC for tz=0 and out-of-range offsets', async () => {
    for (const bad of [0, 9999, -9999]) {
      const { env, calls } = captureEnv();
      await getDailySeries(env, 'site_1', 7, undefined, bad);
      const q = calls.find((c) => c.sql.includes('AS day'));
      // tz=0 / out-of-range → bare UTC bucket (fail-safe), no modifier param.
      expect(q!.sql).toContain('date(created_at) AS day');
      expect(q!.params).toEqual(['site_1', '-7 days']);
    }
  });

  it('combines an absolute window with a tz offset (both bound)', async () => {
    const { env, calls } = captureEnv();
    await getDailySeries(env, 'site_1', 30, { since: '2026-08-01', until: '2026-08-16' }, 330); // IST (+5:30)
    const q = calls.find((c) => c.sql.includes('AS day'));
    expect(q!.sql).toContain('date(created_at, ?) AS day');
    expect(q!.params).toEqual(['330 minutes', 'site_1', '2026-08-01', '2026-08-16', '330 minutes']);
  });
});
