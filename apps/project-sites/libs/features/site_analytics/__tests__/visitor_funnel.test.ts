import { getVisitorFunnel } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

interface Cap {
  sql: string;
  params: unknown[];
}

/** D1 stub: dbQuery calls prepare(sql).bind(...params).all() → { results }. Each row is one
 *  session's `{ pv, conv, max_scroll?, has_scroll? }` aggregate (mirrors the GROUP BY sessionId). */
function stubEnv(rows: unknown[], cap?: Cap): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          if (cap) {
            cap.sql = sql;
            cap.params = params;
          }
          return {
            all: async () => ({ results: rows }),
            first: async () => rows[0] ?? null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe('getVisitorFunnel (AN19 — per-site visitor funnel)', () => {
  it('counts landing/engaged/converted by session with drop-off percentages', async () => {
    // 4 sessions: A 3pv+conv, B 2pv, C 1pv, D 1pv+conv.
    const rows = [
      { pv: 3, conv: 1 },
      { pv: 2, conv: 0 },
      { pv: 1, conv: 0 },
      { pv: 1, conv: 1 },
    ];
    const { stages } = await getVisitorFunnel(stubEnv(rows), 'site_1', 30);
    expect(stages[0]).toEqual({ key: 'landing', label: 'Landed', sessions: 4, percentOfLanding: 100 });
    expect(stages[1]).toEqual({
      key: 'engaged',
      label: 'Engaged (2+ pages)',
      sessions: 2,
      percentOfLanding: 50,
    });
    expect(stages[2]).toEqual({
      key: 'converted',
      label: 'Converted',
      sessions: 2,
      percentOfLanding: 50,
    });
  });

  it('returns an all-zero funnel (never throws) when there are no sessions', async () => {
    const { stages } = await getVisitorFunnel(stubEnv([]), 'site_1');
    expect(stages.map((s) => s.sessions)).toEqual([0, 0, 0]);
    expect(stages[0].percentOfLanding).toBe(0);
  });

  it('inserts a "Deeply engaged" stage (engaged ∩ scrolled ≥50%) when scroll depth is measured', async () => {
    // A engaged+deep+conv, B engaged-shallow, C 1pv-deep (not engaged), D engaged+deep+conv
    const rows = [
      { pv: 3, conv: 1, max_scroll: 80, has_scroll: 1 },
      { pv: 2, conv: 0, max_scroll: 30, has_scroll: 1 },
      { pv: 1, conv: 0, max_scroll: 90, has_scroll: 1 },
      { pv: 2, conv: 1, max_scroll: 60, has_scroll: 1 },
    ];
    const { stages } = await getVisitorFunnel(stubEnv(rows), 'site_1', 30);
    expect(stages.map((s) => s.key)).toEqual(['landing', 'engaged', 'deeply_engaged', 'converted']);
    expect(stages[2]).toEqual({
      key: 'deeply_engaged',
      label: 'Deeply engaged (read 50%+)',
      sessions: 2, // A + D (2+ pages AND scroll ≥50); B shallow, C only 1 page
      percentOfLanding: 50, // 2 / 4 landing
    });
    // MONOTONIC: deeply engaged is a subset of engaged, never larger.
    const engaged = stages.find((s) => s.key === 'engaged')!;
    const deep = stages.find((s) => s.key === 'deeply_engaged')!;
    expect(deep.sessions).toBeLessThanOrEqual(engaged.sessions);
  });

  it('OMITS the deep-engagement stage when NO scroll_depth samples exist (never a lying 0)', async () => {
    // Real sessions but zero scroll instrumentation → the stage would be a fabricated "0 deep".
    const rows = [
      { pv: 3, conv: 1, max_scroll: 0, has_scroll: 0 },
      { pv: 2, conv: 0, max_scroll: 0, has_scroll: 0 },
    ];
    const { stages } = await getVisitorFunnel(stubEnv(rows), 'site_1', 30);
    expect(stages.map((s) => s.key)).toEqual(['landing', 'engaged', 'converted']);
    expect(stages.some((s) => s.key === 'deeply_engaged')).toBe(false);
  });

  it('scopes to the site + non-null session + clamps the window (SQL + params)', async () => {
    const cap: Cap = { sql: '', params: [] };
    await getVisitorFunnel(stubEnv([], cap), 'site_1', 9999);
    expect(cap.sql).toContain('GROUP BY session_id');
    expect(cap.sql).toContain('session_id IS NOT NULL');
    expect(cap.sql).toContain("event_type = 'pageview'");
    expect(cap.sql).toContain('FROM visitor_events');
    // the deep-engagement stage reads per-session max scroll depth from the same GROUP BY
    expect(cap.sql).toContain("event_type = 'scroll_depth'");
    expect(cap.sql).toContain("json_extract(metadata, '$.percent')");
    expect(cap.params).toEqual(['site_1', '-30 days']);
  });
});
