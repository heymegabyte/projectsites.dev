/**
 * TDD — provider tiers + DeepSeek integration.
 *
 * Validates the new `chooseProviderForTier(env, tier)` export and confirms
 * DeepSeek's default model and base URL are wired correctly.
 *
 * Run: npx jest external_llm_provider_tiers
 */

import {
  chooseProviderForTier,
  toRoutableProvider,
  DEFAULT_MODELS_EXPORT,
  DIRECT_BASE_URLS_EXPORT,
} from '../services/external_llm.js';

// Minimal Env stub — only the keys relevant to tier resolution
function makeEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    DEEPSEEK_API_KEY: undefined,
    ...overrides,
  } as unknown as Record<string, string | undefined>;
}

describe('chooseProviderForTier — premium ladder (Fable 5 → ChatGPT → Kimi K3 → DeepSeek, Brian 2026-08-19)', () => {
  it('returns fable when FABLE_API_KEY is set (top rung)', () => {
    const env = makeEnv({
      FABLE_API_KEY: 'sk-fable-test',
      OPENAI_API_KEY: 'sk-openai',
      KIMI_API_KEY: 'sk-kimi-test',
      DEEPSEEK_API_KEY: 'sk-ds-test',
    });
    expect(chooseProviderForTier(env as never, 'premium')).toBe('fable');
  });

  it('skips the unkeyed fable rung and serves openai (Fable has no credits yet)', () => {
    const env = makeEnv({
      OPENAI_API_KEY: 'sk-openai',
      KIMI_API_KEY: 'sk-kimi-test',
      DEEPSEEK_API_KEY: 'sk-ds-test',
    });
    expect(chooseProviderForTier(env as never, 'premium')).toBe('openai');
  });

  it('serves kimi when fable + openai are both unkeyed', () => {
    const env = makeEnv({ KIMI_API_KEY: 'sk-kimi-test', DEEPSEEK_API_KEY: 'sk-ds-test' });
    expect(chooseProviderForTier(env as never, 'premium')).toBe('kimi');
  });

  it('serves deepseek as the last premium rung', () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-ds-test' });
    expect(chooseProviderForTier(env as never, 'premium')).toBe('deepseek');
  });

  it('defaults to openai when NO premium rung key is set', () => {
    const env = makeEnv();
    expect(chooseProviderForTier(env as never, 'premium')).toBe('openai');
  });
});

describe('chooseProviderForTier — standard tier', () => {
  it('returns deepseek when DEEPSEEK_API_KEY is set', () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-ds-test' });
    expect(chooseProviderForTier(env as never, 'standard')).toBe('deepseek');
  });

  it('falls back to openai when DEEPSEEK_API_KEY is absent', () => {
    const env = makeEnv({ OPENAI_API_KEY: 'sk-openai' });
    expect(chooseProviderForTier(env as never, 'standard')).toBe('openai');
  });

  it('falls back to openai when no keys are set', () => {
    const env = makeEnv();
    expect(chooseProviderForTier(env as never, 'standard')).toBe('openai');
  });
});

describe('chooseProviderForTier — instant tier', () => {
  it('returns deepseek when DEEPSEEK_API_KEY is set', () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-ds-test' });
    expect(chooseProviderForTier(env as never, 'instant')).toBe('deepseek');
  });

  it('falls back to openai when DEEPSEEK_API_KEY is absent', () => {
    const env = makeEnv({ OPENAI_API_KEY: 'sk-openai' });
    expect(chooseProviderForTier(env as never, 'instant')).toBe('openai');
  });

  it('falls back to openai when no keys are set', () => {
    const env = makeEnv();
    expect(chooseProviderForTier(env as never, 'instant')).toBe('openai');
  });
});

describe('toRoutableProvider — kimi/fable never strand a usable standard key (callExternalLLM path)', () => {
  it('passes openai/anthropic/deepseek through unchanged (identity)', () => {
    const env = makeEnv({ OPENAI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    expect(toRoutableProvider(env as never, 'openai')).toBe('openai');
    expect(toRoutableProvider(env as never, 'anthropic')).toBe('anthropic');
    expect(toRoutableProvider(env as never, 'deepseek')).toBe('deepseek');
  });

  it('collapses kimi to DeepSeek when only DEEPSEEK_API_KEY is set (was stranding → openai → threw)', () => {
    // The bug: premium resolved 'kimi', callExternalLLM hardcoded ['openai','openai'] → no openai
    // key → threw "no provider" even though a live DeepSeek key could serve the request.
    const env = makeEnv({ KIMI_API_KEY: 'sk-kimi', DEEPSEEK_API_KEY: 'sk-ds' });
    expect(toRoutableProvider(env as never, 'kimi')).toBe('deepseek');
  });

  it('collapses fable to DeepSeek when FABLE + DEEPSEEK are set but OPENAI is not (realistic premium case)', () => {
    const env = makeEnv({ FABLE_API_KEY: 'sk-fable', DEEPSEEK_API_KEY: 'sk-ds' });
    expect(toRoutableProvider(env as never, 'fable')).toBe('deepseek');
  });

  it('prefers openai for a collapsed kimi/fable when an OpenAI key is present', () => {
    const env = makeEnv({
      FABLE_API_KEY: 'sk-fable',
      OPENAI_API_KEY: 'sk-oa',
      DEEPSEEK_API_KEY: 'sk-ds',
    });
    expect(toRoutableProvider(env as never, 'fable')).toBe('openai');
  });

  it('falls through to anthropic as the last resort for a collapsed kimi/fable', () => {
    const env = makeEnv({ KIMI_API_KEY: 'sk-kimi' }); // no openai/deepseek key
    expect(toRoutableProvider(env as never, 'kimi')).toBe('anthropic');
  });
});

describe('DeepSeek defaults', () => {
  it('DEFAULT_MODELS_EXPORT has deepseek-chat as the default DeepSeek model', () => {
    expect(DEFAULT_MODELS_EXPORT.deepseek).toBe('deepseek-chat');
  });

  it('DIRECT_BASE_URLS_EXPORT has the correct DeepSeek API base URL', () => {
    expect(DIRECT_BASE_URLS_EXPORT.deepseek).toBe('https://api.deepseek.com');
  });
});
