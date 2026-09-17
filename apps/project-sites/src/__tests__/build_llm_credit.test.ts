import {
  checkBuildLlmCredit,
  resolveBuildLlmProvider,
  BUILD_LLM_TOPUP_URLS,
} from '../services/build_llm_credit.js';

/** A minimal Response-like stub for the injected fetch. */
function res(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

describe('build_llm_credit — resolveBuildLlmProvider (mirror the workflow selection)', () => {
  it('picks deepseek when its key is present and not overridden', () => {
    expect(resolveBuildLlmProvider({ DEEPSEEK_API_KEY: 'k' })).toBe('deepseek');
  });
  it('picks anthropic when BUILD_LLM_PROVIDER forces it', () => {
    expect(
      resolveBuildLlmProvider({ DEEPSEEK_API_KEY: 'k', BUILD_LLM_PROVIDER: 'anthropic' }),
    ).toBe('anthropic');
  });
  it('picks anthropic when no deepseek key', () => {
    expect(resolveBuildLlmProvider({ ANTHROPIC_API_KEY: 'a' })).toBe('anthropic');
  });
});

describe('build_llm_credit — checkBuildLlmCredit (PRE-FLIGHT dead-balance gate)', () => {
  it('BLOCKS on a DeepSeek dead balance (is_available:false, negative total)', async () => {
    const fetchImpl = (async () =>
      res(200, {
        is_available: false,
        balance_infos: [{ currency: 'USD', total_balance: '-0.56' }],
      })) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k' }, { fetchImpl });
    expect(c).toEqual({
      ok: false,
      provider: 'deepseek',
      checked: true,
      reason: 'deepseek_dead_balance',
      balance: '-0.56',
    });
  });

  it('ALLOWS a healthy DeepSeek balance', async () => {
    const fetchImpl = (async () =>
      res(200, {
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '12.34' }],
      })) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k' }, { fetchImpl });
    expect(c.ok).toBe(true);
    expect(c.checked).toBe(true);
    expect(c.provider).toBe('deepseek');
    expect(c.balance).toBe('12.34');
  });

  it('BLOCKS on an Anthropic too-low-credit error (400 with credit message)', async () => {
    const fetchImpl = (async () =>
      res(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      })) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit(
      { ANTHROPIC_API_KEY: 'a', BUILD_LLM_PROVIDER: 'anthropic' },
      { fetchImpl },
    );
    expect(c).toEqual({
      ok: false,
      provider: 'anthropic',
      checked: true,
      reason: 'anthropic_dead_balance',
    });
  });

  it('ALLOWS a healthy Anthropic key (200 echo)', async () => {
    const fetchImpl = (async () =>
      res(200, { id: 'msg_x', content: [] })) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit({ ANTHROPIC_API_KEY: 'a' }, { fetchImpl });
    expect(c.ok).toBe(true);
    expect(c.checked).toBe(true);
    expect(c.provider).toBe('anthropic');
  });

  it('FAIL-SOFT: a network throw never blocks a legit build (ok:true, checked:false)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k' }, { fetchImpl });
    expect(c.ok).toBe(true);
    expect(c.checked).toBe(false);
    expect(c.reason).toContain('check_failed_fail_soft');
  });

  it('FAIL-SOFT: an Anthropic rate-limit (429) does NOT block (transient, not a credit failure)', async () => {
    const fetchImpl = (async () =>
      res(429, { error: { message: 'rate limited' } })) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit({ ANTHROPIC_API_KEY: 'a' }, { fetchImpl });
    expect(c.ok).toBe(true);
    expect(c.checked).toBe(false);
    expect(c.reason).toBe('anthropic_non_credit_http_429');
  });

  it('unchecked-ok when the active provider has no key (defers to the existing missing-key path)', async () => {
    const c = await checkBuildLlmCredit({ BUILD_LLM_PROVIDER: 'anthropic' });
    expect(c).toEqual({
      ok: true,
      provider: 'anthropic',
      checked: false,
      reason: 'no_api_key_for_active_provider',
    });
  });

  it('exposes deep-linked top-up URLs for both providers', () => {
    expect(BUILD_LLM_TOPUP_URLS.deepseek).toMatch(/deepseek\.com/);
    expect(BUILD_LLM_TOPUP_URLS.anthropic).toMatch(/anthropic\.com/);
  });
});

describe('build_llm_credit — BUILD_LLM_ALLOW_SEED_ONLY graceful-degradation escape hatch (AL-715)', () => {
  const deadDeepseek = (async () =>
    ({ ok: true, status: 200, json: async () => ({ is_available: false, balance_infos: [{ total_balance: '-0.56' }] }), text: async () => '' }) as unknown as Response) as unknown as typeof fetch;
  const deadAnthropic = (async () =>
    ({ ok: false, status: 400, json: async () => ({ error: { message: 'Your credit balance is too low' } }), text: async () => '' }) as unknown as Response) as unknown as typeof fetch;

  it('dead DeepSeek + flag OFF → BLOCKS (ok:false, no degraded) — the safe default is unchanged', async () => {
    const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k' }, { fetchImpl: deadDeepseek });
    expect(c.ok).toBe(false);
    expect(c.degraded).toBeUndefined();
    expect(c.reason).toBe('deepseek_dead_balance');
  });

  it('dead DeepSeek + BUILD_LLM_ALLOW_SEED_ONLY=1 → DOWNGRADES to seed-only proceed (ok:true, degraded:true)', async () => {
    const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k', BUILD_LLM_ALLOW_SEED_ONLY: '1' }, { fetchImpl: deadDeepseek });
    expect(c.ok).toBe(true);
    expect(c.degraded).toBe(true);
    expect(c.reason).toBe('deepseek_dead_balance_seed_only_allowed');
    expect(c.balance).toBe('-0.56');
  });

  it('dead Anthropic + BUILD_LLM_ALLOW_SEED_ONLY=true → seed-only proceed (ok:true, degraded:true)', async () => {
    const c = await checkBuildLlmCredit(
      { ANTHROPIC_API_KEY: 'a', BUILD_LLM_PROVIDER: 'anthropic', BUILD_LLM_ALLOW_SEED_ONLY: 'true' },
      { fetchImpl: deadAnthropic },
    );
    expect(c.ok).toBe(true);
    expect(c.degraded).toBe(true);
    expect(c.reason).toBe('anthropic_dead_balance_seed_only_allowed');
  });

  it('flag garbage/0/false does NOT open the hatch (only 1/true/yes) — never an accidental degrade', async () => {
    for (const v of ['0', 'false', 'no', '', 'xyz']) {
      const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k', BUILD_LLM_ALLOW_SEED_ONLY: v }, { fetchImpl: deadDeepseek });
      expect({ flag: v, ok: c.ok }).toEqual({ flag: v, ok: false }); // garbage flag must stay blocked
      expect(c.degraded).toBeUndefined();
    }
  });

  it('a HEALTHY balance is never marked degraded regardless of the flag', async () => {
    const healthy = (async () =>
      ({ ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '12.34' }] }), text: async () => '' }) as unknown as Response) as unknown as typeof fetch;
    const c = await checkBuildLlmCredit({ DEEPSEEK_API_KEY: 'k', BUILD_LLM_ALLOW_SEED_ONLY: '1' }, { fetchImpl: healthy });
    expect(c.ok).toBe(true);
    expect(c.degraded).toBeUndefined();
    expect(c.reason).toBe('deepseek_balance_ok');
  });
});
