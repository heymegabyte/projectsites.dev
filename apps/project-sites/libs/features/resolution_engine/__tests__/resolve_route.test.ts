/**
 * Unit tests for the Resolution Engine SYNTHESIS route — `POST /api/resolve`
 * ({@link libs/features/resolution_engine/handlers.resolutionEngine} — WLK-39
 * S6-b-i). This is the SECOND backend leg of S6: it calls the S6-a dual-research
 * primitive (`runDualResearch`), then SYNTHESIZES the two independent research
 * legs into ONE better combined answer via a Claude-class (premium-tier) model
 * through the EXISTING AI Gateway ({@link services/external_llm.callExternalLLM}).
 *
 * Directive mapping:
 *   - §13 "best(OpenAI)+best(Anthropic)+judgment = a better third" → the route
 *     feeds Claude BOTH legs' content, clearly labelled by provider, and asks it
 *     to reconcile agreements / unique ideas / disagreements into a COMBINED
 *     answer (synthesize, NOT concatenate).
 *   - flag gate → `runDualResearch` throws `ResolutionEngineDisabledError` when
 *     the `resolution_engine` flag is off; the route maps it to a 404 (never 403).
 *   - §24 / §76-D "provider outage" →
 *       · one research leg down → the survivor still feeds synthesis (200).
 *       · BOTH legs down → `runDualResearch` throws `ResolutionEngineError`; the
 *         route maps it to a 502 with secret-redacted reasons.
 *       · the SYNTHESIS call itself failing → the route returns the research legs
 *         + a `synthesis:{ok:false,reason}` marker (NEVER a 500).
 *
 * Cases: both-legs→synthesis · one-leg-down→synthesis · flag-off→404 ·
 * unauth→401 · synthesis-call-fails→research+marker · both-legs-fail→502 ·
 * siteId foreign→404 (ownership) · synthesis prompt carries BOTH legs labelled.
 *
 * Mocks `runDualResearch` (the S6-a seam — keeps the REAL error classes via
 * requireActual so `instanceof` maps correctly), `callExternalLLM` (the synthesis
 * Gateway seam), and `assertSiteOwned`, so no real network/D1 call is ever made.
 */

// @swc/jest hoists jest.mock above the imports ONLY when it sees the GLOBAL
// `jest` identifier — do NOT `import { jest } from '@jest/globals'`. See
// apps/project-sites CLAUDE.md gotcha #12.
const mockRunDualResearch = jest.fn();
jest.mock('../service.js', () => ({
  // Keep the REAL ResolutionEngineDisabledError + ResolutionEngineError classes
  // so the handler's `instanceof` branches (→404 / →502) fire correctly.
  ...jest.requireActual('../service.js'),
  runDualResearch: (...a: unknown[]) => mockRunDualResearch(...a),
}));

const mockCallExternalLLM = jest.fn();
jest.mock('../../../../src/services/external_llm.js', () => ({
  callExternalLLM: (...a: unknown[]) => mockCallExternalLLM(...a),
}));

const mockAssertSiteOwned = jest.fn();
jest.mock('../../../../src/services/site_ownership.js', () => ({
  assertSiteOwned: (...a: unknown[]) => mockAssertSiteOwned(...a),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../../../../src/types/env.js';
import { resolutionEngine } from '../handlers.js';
import { ResolutionEngineDisabledError, ResolutionEngineError } from '../service.js';

type AppContext = { Bindings: Env; Variables: Variables };

/**
 * Mount the route with an optional pre-set `orgId` (simulating the global auth
 * middleware having populated the context). `orgId=null` → unauthenticated.
 */
function app(orgId: string | null = 'org_test') {
  const a = new Hono<AppContext>();
  if (orgId) {
    a.use('*', async (c, next) => {
      c.set('orgId', orgId);
      await next();
    });
  }
  a.route('/', resolutionEngine);
  return {
    request: (body: unknown) =>
      a.request(
        '/api/resolve',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        {} as unknown as Env,
      ),
  };
}

/** A realistic ok research leg. */
const okLeg = (provider: 'openai' | 'anthropic', content: string) => ({
  provider,
  ok: true as const,
  model: provider === 'openai' ? 'gpt-4o-2024-11-20' : 'claude-fable-5',
  content,
  latencyMs: 42,
});

/** A realistic down research leg (secret-free reason). */
const downLeg = (provider: 'openai' | 'anthropic', reason: string) => ({
  provider,
  ok: false as const,
  reason,
});

/** A realistic synthesis callExternalLLM result (Claude-class premium). */
const synthResult = (output: string) => ({
  output,
  model_used: 'claude-fable-5',
  provider: 'anthropic' as const,
  latency_ms: 88,
  token_count: 400,
  input_tokens: 300,
  output_tokens: 100,
  cost_estimate: 0.004,
});

beforeEach(() => {
  mockRunDualResearch.mockReset();
  mockCallExternalLLM.mockReset();
  mockAssertSiteOwned.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Default: both legs returned, synthesis succeeds.
  mockRunDualResearch.mockResolvedValue({
    ok: true,
    legs: [okLeg('openai', 'OpenAI research findings about Acme.'), okLeg('anthropic', 'Anthropic research findings about Acme.')],
  });
  mockCallExternalLLM.mockResolvedValue(synthResult('The best combined answer, reconciling both.'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/resolve — synthesis of both research legs', () => {
  it('returns both research legs + a synthesized answer (both legs ok)', async () => {
    const res = await app().request({ prompt: 'research Acme Co' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      research: Array<{ provider: string; ok: boolean }>;
      synthesis: { ok?: boolean; provider: string; model: string; content: string };
    };
    expect(body.research).toHaveLength(2);
    expect(body.research.map((l) => l.provider).sort()).toEqual(['anthropic', 'openai']);
    expect(body.synthesis.content).toBe('The best combined answer, reconciling both.');
    expect(body.synthesis.provider).toBe('anthropic');
    expect(body.synthesis.model).toBe('claude-fable-5');
    expect(mockCallExternalLLM).toHaveBeenCalledTimes(1);
  });

  it('calls the synthesis model at the PREMIUM tier with BOTH legs labelled by provider', async () => {
    await app().request({ prompt: 'research Acme Co' });
    expect(mockCallExternalLLM).toHaveBeenCalledTimes(1);
    const [, opts] = mockCallExternalLLM.mock.calls[0] as [unknown, Record<string, string>];
    // Claude-class = premium tier (external_llm's premium ladder resolves Claude/OpenAI).
    expect(opts.tier).toBe('premium');
    // The synthesis user prompt must contain BOTH legs' content, labelled by provider.
    const prompt = `${opts.system ?? ''}\n${opts.user ?? ''}`;
    expect(prompt).toContain('OpenAI research findings about Acme.');
    expect(prompt).toContain('Anthropic research findings about Acme.');
    expect(prompt.toLowerCase()).toContain('openai');
    expect(prompt.toLowerCase()).toContain('anthropic');
    // It must instruct synthesis (agreements/disagreements/combine), not concatenation.
    expect(opts.system?.toLowerCase()).toMatch(/synthesi[sz]|combine|reconcile/);
  });

  it('still synthesizes from the survivor when ONE research leg is down', async () => {
    mockRunDualResearch.mockResolvedValue({
      ok: true,
      legs: [okLeg('openai', 'Only OpenAI survived.'), downLeg('anthropic', 'anthropic is not configured (no API key)')],
    });
    const res = await app().request({ prompt: 'research Acme Co' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      research: Array<{ provider: string; ok: boolean }>;
      synthesis: { content: string };
    };
    // Both legs are reported (one down), synthesis still produced from the survivor.
    expect(body.research).toHaveLength(2);
    expect(body.research.find((l) => l.provider === 'anthropic')?.ok).toBe(false);
    expect(body.synthesis.content).toBe('The best combined answer, reconciling both.');
    const [, opts] = mockCallExternalLLM.mock.calls[0] as [unknown, Record<string, string>];
    expect(`${opts.user}`).toContain('Only OpenAI survived.');
  });

  it('maps a disabled flag to 404 (never 403) and never calls the synthesis model', async () => {
    mockRunDualResearch.mockRejectedValue(new ResolutionEngineDisabledError());
    const res = await app().request({ prompt: 'research Acme Co' });
    expect(res.status).toBe(404);
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('returns 401 when the caller is unauthenticated (no orgId), before any research call', async () => {
    const res = await app(null).request({ prompt: 'research Acme Co' });
    expect(res.status).toBe(401);
    expect(mockRunDualResearch).not.toHaveBeenCalled();
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('returns the research legs + a synthesis:{ok:false} marker when the synthesis CALL fails (never 500)', async () => {
    mockCallExternalLLM.mockRejectedValue(new Error('synthesis provider 500: sk-leaked-secret boom'));
    const res = await app().request({ prompt: 'research Acme Co' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      research: Array<{ provider: string }>;
      synthesis: { ok: boolean; reason: string };
    };
    expect(body.research).toHaveLength(2);
    expect(body.synthesis.ok).toBe(false);
    expect(typeof body.synthesis.reason).toBe('string');
    // No secret leaks into the marker reason.
    expect(body.synthesis.reason).not.toContain('sk-leaked-secret');
  });

  it('maps both-legs-failed to a 502 honest error (redacted reasons, no secrets)', async () => {
    mockRunDualResearch.mockRejectedValue(
      new ResolutionEngineError([
        downLeg('openai', 'OpenAI API error 500'),
        downLeg('anthropic', 'anthropic is not configured (no API key)'),
      ]),
    );
    const res = await app().request({ prompt: 'research Acme Co' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string; reasons?: string[] } };
    expect(body.error.code).toBeTruthy();
    // Both provider reasons surfaced for the UI, but nothing secret.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('404s when a supplied siteId is not owned by the caller (ownership, never 403)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const res = await app().request({ prompt: 'research Acme Co', siteId: 'site_foreign' });
    expect(res.status).toBe(404);
    expect(mockAssertSiteOwned).toHaveBeenCalled();
    expect(mockRunDualResearch).not.toHaveBeenCalled();
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('proceeds when a supplied siteId IS owned by the caller', async () => {
    mockAssertSiteOwned.mockResolvedValue(true);
    const res = await app().request({ prompt: 'research Acme Co', siteId: 'site_owned' });
    expect(res.status).toBe(200);
    expect(mockAssertSiteOwned).toHaveBeenCalled();
    expect(mockRunDualResearch).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for an empty prompt', async () => {
    const res = await app().request({ prompt: '' });
    expect(res.status).toBe(400);
    expect(mockRunDualResearch).not.toHaveBeenCalled();
  });
});
