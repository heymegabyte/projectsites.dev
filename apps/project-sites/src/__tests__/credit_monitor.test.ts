/**
 * Unit coverage for the super-admin API credit monitor. Mocks `global.fetch` per provider URL
 * fragment and asserts: real balance parsing (the live DeepSeek negative-balance blocker),
 * unconfigured detection, console-only providers never fabricate a number, and fail-soft (a
 * throwing probe degrades one row to `unknown` without breaking the whole report).
 */
import { getCreditReport } from '../services/credit_monitor.js';
import type { Env } from '../types/env.js';

type MockResp = { ok: boolean; status?: number; json: unknown };
function mockFetch(routes: Record<string, MockResp>) {
  return jest.fn(async (url: string) => {
    for (const [frag, resp] of Object.entries(routes)) {
      if (url.includes(frag)) {
        return {
          ok: resp.ok,
          status: resp.status ?? (resp.ok ? 200 : 500),
          json: async () => resp.json,
        } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

const configuredEnv = {
  DEEPSEEK_API_KEY: 'ds',
  ANTHROPIC_API_KEY: 'an',
  OPENAI_API_KEY: 'oa',
} as unknown as Env;

afterEach(() => {
  // restore between cases
  (global as unknown as { fetch: unknown }).fetch = undefined;
});

describe('credit_monitor getCreditReport', () => {
  it('parses a negative DeepSeek balance as DEPLETED (the live build-LLM blocker)', async () => {
    global.fetch = mockFetch({
      'api.deepseek.com/user/balance': {
        ok: true,
        json: { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '-0.56' }] },
      },
    }) as unknown as typeof fetch;
    const report = await getCreditReport(configuredEnv);
    const ds = report.providers.find((p) => p.id === 'deepseek');
    expect(ds?.configured).toBe(true);
    expect(ds?.balanceUsd).toBe(-0.56);
    expect(ds?.status).toBe('depleted');
    expect(ds?.detail).toContain('UNAVAILABLE');
  });

  it('classifies a healthy positive balance as healthy', async () => {
    global.fetch = mockFetch({
      'api.deepseek.com/user/balance': {
        ok: true,
        json: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '42.00' }] },
      },
    }) as unknown as typeof fetch;
    const report = await getCreditReport(configuredEnv);
    expect(report.providers.find((p) => p.id === 'deepseek')?.status).toBe('healthy');
  });

  it('marks providers with no key as UNCONFIGURED (never probes them)', async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    const report = await getCreditReport({} as Env);
    expect(report.providers.find((p) => p.id === 'deepseek')?.status).toBe('unconfigured');
    expect(report.summary.unconfigured).toBeGreaterThan(0);
  });

  it('console providers (Anthropic) report unknown + a console detail — never a fabricated number', async () => {
    global.fetch = mockFetch({}) as unknown as typeof fetch;
    const report = await getCreditReport(configuredEnv);
    const an = report.providers.find((p) => p.id === 'anthropic');
    expect(an?.kind).toBe('console');
    expect(an?.status).toBe('unknown');
    expect(an?.balanceUsd).toBeNull();
    expect(an?.topUpUrl).toContain('console.anthropic.com');
  });

  it('is FAIL-SOFT: a throwing probe degrades one row to unknown, report stays complete', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const report = await getCreditReport(configuredEnv);
    expect(report.providers.find((p) => p.id === 'deepseek')?.status).toBe('unknown');
    expect(report.providers.length).toBeGreaterThan(8);
    expect(report.checkedAt).toBeGreaterThan(0);
  });
});
