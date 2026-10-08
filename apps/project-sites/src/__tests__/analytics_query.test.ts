/**
 * fetchPipeRows — fail-soft raw-rollup reader. Tinybird removed — D1 source TODO:
 * now always returns the degraded zero-state ({ rows: [], degraded: true }) until
 * a D1-backed rollup replaces the deleted OLAP pipe reads.
 */
import { fetchPipeRows, type EventsDailyRow } from '../services/analytics_query.js';

const ENV = {} as never;

describe('fetchPipeRows', () => {
  it('returns the degraded zero-state (Tinybird removed — D1 source TODO)', async () => {
    const r = await fetchPipeRows<EventsDailyRow>(ENV, 'events_by_tenant_daily', {
      tenant_id: 't1',
      days: 30,
    });
    expect(r).toEqual({ rows: [], degraded: true });
  });

  it('degrades for every rollup name, never throws', async () => {
    expect(await fetchPipeRows(ENV, 'site_publishes_by_source', {})).toEqual({
      rows: [],
      degraded: true,
    });
    expect(
      await fetchPipeRows(ENV, 'claims_by_source', {
        tenant_id: 't1',
        source: 'twitter',
        campaign: 'spring',
      }),
    ).toEqual({ rows: [], degraded: true });
  });
});
