/**
 * AN-FORM — getFormFunnelSummary: the contact-form LEAD FUNNEL (validated `form_start` →
 * server-confirmed `form_submit` → completion rate, per form). The security + honesty
 * contract this suite locks:
 *   - ONE query counts form_start/form_submit grouped by the form key
 *     (`json_extract(metadata,'$.form')`), scoped to `site_id = ?` (bound FIRST — the filter
 *     can only NARROW within the owned site, never cross a tenant boundary),
 *   - completion% = submits/starts, NULL when there are no starts (no attempts → no rate,
 *     never a fabricated 0%), clamped ≤100 for the submit-without-start anomaly,
 *   - honest empty on no rows / a query error (fail-soft — never throws into the summary),
 *   - the drilldown filter threads as a BOUND `?` value, never interpolated.
 *
 * Reuses the param-capturing D1 stub pattern from filtered_summary.test.ts.
 */

import { getFormFunnelSummary } from '../service.js';
import type { AnalyticsFilter } from '../schemas.js';
import type { Env } from '../../../../src/types/env.js';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type FunnelRow = { form: string | null; starts: number; submits: number };

/** D1 stub that returns `rows` for the funnel query + captures every (sql, params). */
function funnelEnv(rows: FunnelRow[]): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            all: async () => ({ results: rows as unknown[] }),
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

/** D1 stub whose query throws — proves the fail-soft path returns an honest empty. */
function errorEnv(): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => {
              throw new Error('no such table: visitor_events');
            },
            first: async () => null,
            run: async () => ({ success: false, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

const EMPTY = { starts: 0, submits: 0, completionRatePercent: null, byForm: [] };

describe('getFormFunnelSummary — aggregation + completion rate', () => {
  it('aggregates starts/submits per form and computes the completion rate', async () => {
    const { env } = funnelEnv([
      { form: 'contact', starts: 10, submits: 6 },
      { form: 'newsletter', starts: 4, submits: 4 },
    ]);
    const r = await getFormFunnelSummary(env, 'site_1', 30);
    expect(r.starts).toBe(14);
    expect(r.submits).toBe(10);
    expect(r.completionRatePercent).toBe(71); // round(10/14*100)
    expect(r.byForm).toHaveLength(2);
    expect(r.byForm[0]).toEqual({
      form: 'contact',
      starts: 10,
      submits: 6,
      completionRatePercent: 60,
    });
    expect(r.byForm[1]).toEqual({
      form: 'newsletter',
      starts: 4,
      submits: 4,
      completionRatePercent: 100,
    });
  });

  it("buckets a null form key as 'contact' (never dropped)", async () => {
    const { env } = funnelEnv([{ form: null, starts: 3, submits: 1 }]);
    const r = await getFormFunnelSummary(env, 'site_1', 30);
    expect(r.byForm[0].form).toBe('contact');
    expect(r.byForm[0].completionRatePercent).toBe(33); // round(1/3*100)
  });

  it('clamps the completion rate to 100 when submits exceed starts (cross-window anomaly)', async () => {
    const { env } = funnelEnv([{ form: 'contact', starts: 2, submits: 5 }]);
    const r = await getFormFunnelSummary(env, 'site_1', 30);
    expect(r.completionRatePercent).toBe(100);
    expect(r.byForm[0].completionRatePercent).toBe(100);
  });
});

describe('getFormFunnelSummary — honesty (never a fabricated 0%)', () => {
  it('returns an honest empty summary on no form activity — rate is null, not 0', async () => {
    const { env } = funnelEnv([]);
    const r = await getFormFunnelSummary(env, 'site_1', 30);
    expect(r).toEqual(EMPTY);
    expect(r.completionRatePercent).not.toBe(0);
  });

  it('rate is null when there are submits but zero starts (lost start beacons)', async () => {
    const { env } = funnelEnv([{ form: 'contact', starts: 0, submits: 3 }]);
    const r = await getFormFunnelSummary(env, 'site_1', 30);
    expect(r.starts).toBe(0);
    expect(r.submits).toBe(3);
    expect(r.completionRatePercent).toBeNull();
  });

  it('fail-soft: a query error yields an honest empty summary (never throws)', async () => {
    const r = await getFormFunnelSummary(errorEnv(), 'site_1', 30);
    expect(r).toEqual(EMPTY);
  });
});

describe('getFormFunnelSummary — tenant isolation + parameterization', () => {
  it('queries form_start/form_submit grouped by $.form, scoped to site_id (bound first)', async () => {
    const { env, calls } = funnelEnv([]);
    await getFormFunnelSummary(env, 'site_ISOLATED', 30);
    expect(calls).toHaveLength(1);
    const q = calls[0];
    expect(q.sql).toContain("event_type IN ('form_start', 'form_submit')");
    expect(q.sql).toContain("json_extract(metadata, '$.form')");
    expect(q.sql).toContain('site_id = ?');
    expect(q.params[0]).toBe('site_ISOLATED'); // tenant scope — site bound first
  });

  it('threads the drilldown filter as a BOUND value (never interpolated)', async () => {
    const { env, calls } = funnelEnv([]);
    await getFormFunnelSummary(env, 'site_1', 30, undefined, {
      dim: 'country',
      value: 'US',
    } as AnalyticsFilter);
    const q = calls[0];
    expect(q.sql).toContain("json_extract(metadata, '$.country') = ?");
    expect(q.params).toEqual(['site_1', '-30 days', 'US']);
    expect(q.sql).not.toContain("= 'US'"); // value is a param, never spliced into SQL text
  });
});
