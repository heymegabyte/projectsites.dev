/**
 * fetchActivationFunnel — the I/O layer over the activation funnel. Always returns
 * all four stages in order. Tinybird removed — D1 source TODO: now always the zero
 * funnel (degraded) until a D1-backed funnel query replaces the deleted OLAP pipe.
 */
import { fetchActivationFunnel } from '../services/activation_funnel_query.js';

const ENV = {} as never;

describe('fetchActivationFunnel', () => {
  it('returns the zero funnel (all 4 stages at 0, degraded) — Tinybird removed', async () => {
    const r = await fetchActivationFunnel(ENV, { tenantId: 'org-1' });
    expect(r.degraded).toBe(true);
    expect(r.stages.map((s) => s.stage)).toEqual([
      'lead.discovered',
      'site.claim.started',
      'site.published',
      'subscription.active',
    ]);
    expect(r.stages.every((s) => s.events === 0 && s.sites === 0)).toBe(true);
  });

  it('always returns the four canonical stages in top→bottom order', async () => {
    const r = await fetchActivationFunnel(ENV, {});
    expect(r.stages.map((s) => s.ordinal)).toEqual([0, 1, 2, 3]);
    const byStage = Object.fromEntries(r.stages.map((s) => [s.stage, s]));
    expect(byStage['lead.discovered'].label).toBe('Discovered');
    expect(byStage['site.published'].label).toBe('Delivered');
  });

  it('never throws (degrades gracefully with no backing source)', async () => {
    const r = await fetchActivationFunnel(ENV, { tenantId: 'x', days: 30 });
    expect(r.stages).toHaveLength(4);
    expect(r.degraded).toBe(true);
  });
});
