import { computeUsageGauges } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
}));
// resolveActiveOrgPlan is mocked separately so the count-query mock order stays
// [sites, builds, media] (it does NOT consume a dbQueryOne call in the test).
jest.mock('../../../../src/services/build_limits.js', () => ({
  resolveActiveOrgPlan: jest.fn(),
}));
import { dbQueryOne } from '../../../../src/services/db.js';
import { resolveActiveOrgPlan } from '../../../../src/services/build_limits.js';

function env(): Env {
  return { DB: {} as D1Database } as unknown as Env;
}

beforeEach(() => {
  jest.clearAllMocks();
  (resolveActiveOrgPlan as jest.Mock).mockResolvedValue(null); // default: no active paid sub → free
});

describe('computeUsageGauges', () => {
  it('returns the 3 SSOT-backed gauges (sites, builds, media) — the fabricated bandwidth gauge is dropped', async () => {
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce({ cnt: 5 }) // sites
      .mockResolvedValueOnce({ cnt: 3 }) // builds
      .mockResolvedValueOnce({ total_mb: 8 }); // media

    const gauges = await computeUsageGauges(env(), 'org-1');
    expect(gauges).toHaveLength(3);
    expect(gauges.map((g) => g.metric)).toEqual(['sites', 'builds', 'media']);
  });

  it('uses the FREE SSOT limits (1 site / 5 builds / 10 MB) — not the old fabricated 3 / 10 / 1 GB', async () => {
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce({ cnt: 0 })
      .mockResolvedValueOnce({ cnt: 0 })
      .mockResolvedValueOnce({ total_mb: 0 });

    const gauges = await computeUsageGauges(env(), 'org-1');
    expect(gauges[0].limit).toBe(1); // sites — free
    expect(gauges[1].limit).toBe(5); // builds — free
    expect(gauges[2].limit).toBe(10); // media — free, in MB
    expect(gauges[2].unit).toBe('MB');
  });

  it('computes percentage against the REAL free limit (3 / 5 builds = 60%)', async () => {
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce({ cnt: 0 })
      .mockResolvedValueOnce({ cnt: 3 }) // 3/5 = 60%
      .mockResolvedValueOnce({ total_mb: 0 });

    const gauges = await computeUsageGauges(env(), 'org-1');
    expect(gauges[1].pct).toBe(60);
    expect(gauges[1].used).toBe(3);
  });

  it('caps pct at 100 when over the free=1 site limit', async () => {
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce({ cnt: 20 }) // 20 / 1 → capped 100
      .mockResolvedValueOnce({ cnt: 0 })
      .mockResolvedValueOnce({ total_mb: 0 });

    const gauges = await computeUsageGauges(env(), 'org-1');
    expect(gauges[0].pct).toBe(100);
    expect(gauges[0].limit).toBe(1);
  });

  it('a paid (active|trialing) org gets PRO limits — unlimited sites (-1), pct held at 0', async () => {
    (resolveActiveOrgPlan as jest.Mock).mockResolvedValue('paid');
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce({ cnt: 42 })
      .mockResolvedValueOnce({ cnt: 10 })
      .mockResolvedValueOnce({ total_mb: 100 });

    const gauges = await computeUsageGauges(env(), 'org-1');
    expect(gauges[0].limit).toBe(-1); // pro sites — unlimited (client renders ∞)
    expect(gauges[0].pct).toBe(0); // unlimited → never a bogus percentage
    expect(gauges[1].limit).toBe(500); // pro builds
    expect(gauges[2].limit).toBe(5000); // pro media MB
  });

  it('reads media storage from media_assets.size_bytes (not the nonexistent sites.media_size_bytes)', async () => {
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce({ cnt: 1 })
      .mockResolvedValueOnce({ cnt: 1 })
      .mockResolvedValueOnce({ total_mb: 100 });
    await computeUsageGauges(env(), 'org-1');
    // The media gauge MUST query media_assets (which has size_bytes), NOT
    // `SUM(media_size_bytes) FROM sites` — that column doesn't exist, so the query
    // threw + was swallowed by dbQuery, making the Media gauge always read 0.
    const mediaSql = (dbQueryOne as jest.Mock).mock.calls[2][1] as string;
    expect(mediaSql).toMatch(/FROM media_assets/);
    expect(mediaSql).toMatch(/SUM\(size_bytes\)/);
    expect(mediaSql).not.toMatch(/media_size_bytes/);
  });

  it('handles null DB results gracefully', async () => {
    (dbQueryOne as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const gauges = await computeUsageGauges(env(), 'org-1');
    expect(gauges[0].used).toBe(0);
    expect(gauges[1].used).toBe(0);
    expect(gauges[2].used).toBe(0);
  });
});
