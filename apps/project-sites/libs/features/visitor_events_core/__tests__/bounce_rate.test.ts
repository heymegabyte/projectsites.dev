/**
 * Unit tests for the TRUE single-page-session bounce rate in getTrafficSummary.
 *
 * bounceRatePercent = round(single-pageview-sessions / total-sessions * 100),
 * computed from a per-session depth subquery over visitor_events; null when
 * there is no per-session data. Stubs env.DB by SQL shape (sibling idiom from
 * rollup_summary.test.ts) so only the bounce subquery's result is controlled.
 */

import { getTrafficSummary } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * D1 stub answering by SQL shape. The bounce subquery (the outer
 * `SUM(CASE WHEN pv = 1 ...)`) returns the caller-supplied `{sessions, single}`;
 * every other aggregate degrades to a harmless zero/empty row so the summary parses.
 */
function stubEnv(bounce: { sessions: number; single: number }): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            all: async () => {
              if (sql.includes('SUM(CASE WHEN pv = 1')) {
                return { results: [{ sessions: bounce.sessions, single: bounce.single }] };
              }
              return { results: [] as unknown[] };
            },
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe('getTrafficSummary — true single-page-session bounce rate', () => {
  it('reports 75 when 3 of 4 sessions have exactly one pageview', async () => {
    // 3 sessions with 1 pageview + 1 session with 3 pageviews = 4 total, 3 single.
    const s = await getTrafficSummary(stubEnv({ sessions: 4, single: 3 }), 'site_1', 30);
    expect(s.bounceRatePercent).toBe(75);
  });

  it('reports null when there are no sessions', async () => {
    const s = await getTrafficSummary(stubEnv({ sessions: 0, single: 0 }), 'site_1', 30);
    expect(s.bounceRatePercent).toBeNull();
  });

  it('rounds to the nearest integer (1 of 3 single → 33)', async () => {
    const s = await getTrafficSummary(stubEnv({ sessions: 3, single: 1 }), 'site_1', 30);
    expect(s.bounceRatePercent).toBe(33);
  });
});
