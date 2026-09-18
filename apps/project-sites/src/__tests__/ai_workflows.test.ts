/**
 * Tests for the ai_workflows module.
 *
 * Validates that runPrompt + registerAllPrompts correctly orchestrate
 * prompt resolution, rendering, AI calls, and output parsing. (The legacy
 * single-shot v1 pipeline — researchBusiness/generateSiteHtml/scoreQuality/
 * generateSiteCopy/runSiteGenerationWorkflow — was deleted as dead code;
 * the live path is runSiteGenerationWorkflowV2's phase-based helpers.)
 *
 * The Workers AI binding (env.AI.run) is mocked to return appropriate
 * fixture responses for each prompt type.
 */

import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  (globalThis as any).crypto = webcrypto;
}

// Mock the analytics boundary so the AL-746 observability wiring is assertable without a real
// PostHog fetch (ai_workflows imports ONLY captureLLMCall from here). Uses the GLOBAL `jest`
// (NOT an @jest/globals import) so @swc/jest hoists this above the runPrompt import — otherwise
// the real module loads first + the mock silently no-ops (swc-jest-module-mock-pitfall).
jest.mock('../services/analytics.js', () => ({ captureLLMCall: jest.fn(async () => undefined) }));

import type { Env } from '../types/env.js';
import { runPrompt, registerAllPrompts } from '../services/ai_workflows.js';
import { captureLLMCall } from '../services/analytics.js';
import { clearRegistry, getStats } from '../prompts/registry.js';

// ─── Mock AI Responses ───────────────────────────────────────────

const MOCK_RESEARCH_RESPONSE = JSON.stringify({
  business_name: "Mario's Ristorante",
  tagline: 'Authentic Italian since 1985',
  description:
    'A family-owned Italian restaurant serving traditional recipes passed down through generations.',
  services: ['Dine-in', 'Takeout', 'Catering', 'Private Events'],
  hours: [
    { day: 'Monday-Thursday', hours: '11am-9pm' },
    { day: 'Friday-Saturday', hours: '11am-10pm' },
    { day: 'Sunday', hours: '12pm-8pm' },
  ],
  faq: [
    { question: 'Do you accept reservations?', answer: 'Yes, call us or book online.' },
    { question: 'Is parking available?', answer: 'Free parking behind the building.' },
    { question: 'Gluten-free options?', answer: 'Yes, ask for our GF menu.' },
  ],
  seo_title: "Mario's Ristorante - Italian Dining",
  seo_description:
    'Family-owned Italian restaurant. Dine-in, takeout, catering. Traditional recipes since 1985.',
});

const MOCK_HTML_RESPONSE =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mario\'s Ristorante</title></head>' +
  '<body><header><h1>Mario\'s Ristorante</h1></header><main><section id="hero"><h2>Authentic Italian since 1985</h2>' +
  '</section><section id="services"><h2>Our Services</h2></section></main></body></html>';

const MOCK_SCORE_RESPONSE = JSON.stringify({
  scores: {
    accuracy: 0.85,
    completeness: 0.9,
    professionalism: 0.88,
    seo: 0.75,
    accessibility: 0.7,
  },
  overall: 0.82,
  issues: ['Missing alt attributes on images'],
  suggestions: ['Add structured data markup'],
});

const MOCK_COPY_RESPONSE =
  "# Welcome to Mario's Ristorante\n\n" +
  '## Your Neighborhood Italian Kitchen in Boston\n\n' +
  '**Call Now** | **View Menu**\n\n' +
  '- Fresh ingredients daily\n' +
  '- Family recipes since 1985\n' +
  '- Private event hosting\n\n' +
  '### About Us\n\nWe are a family-owned restaurant...';

// ─── Mock Env ────────────────────────────────────────────────────

function createMockEnv(aiRunImpl?: jest.Mock): Env {
  const aiRun =
    aiRunImpl ??
    jest
      .fn()
      .mockImplementation(
        (_model: string, params: { messages: Array<{ role: string; content: string }> }) => {
          const userContent = params.messages.find((m) => m.role === 'user')?.content ?? '';

          // Route the mock response based on what appears in the user prompt
          if (userContent.includes('Research this business')) {
            return Promise.resolve({ response: MOCK_RESEARCH_RESPONSE });
          }
          if (userContent.includes('Generate the complete HTML website')) {
            return Promise.resolve({ response: MOCK_HTML_RESPONSE });
          }
          if (userContent.includes('Score the following website HTML')) {
            return Promise.resolve({ response: MOCK_SCORE_RESPONSE });
          }
          if (userContent.includes('Hero headline') || userContent.includes('benefit-led')) {
            return Promise.resolve({ response: MOCK_COPY_RESPONSE });
          }

          return Promise.resolve({ response: '{}' });
        },
      );

  return {
    AI: { run: aiRun },
    ENVIRONMENT: 'test',
    CACHE_KV: {} as any,
    PROMPT_STORE: {} as any,
    DB: {} as any,
    SITES_BUCKET: {} as any,
    QUEUE: {} as any,
    STRIPE_SECRET_KEY: 'sk_test_xxx',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_xxx',
    STRIPE_WEBHOOK_SECRET: 'whsec_xxx',
    CF_API_TOKEN: 'test-cf-token',
    CF_ZONE_ID: 'test-zone-id',
    SENDGRID_API_KEY: 'SG.test',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_PLACES_API_KEY: 'test-places-key',
    SENTRY_DSN: 'https://test@sentry.io/123',
    POSTHOG_API_KEY: 'phc_test',
  } as unknown as Env;
}

// ─── Test Suite ──────────────────────────────────────────────────

beforeEach(() => {
  clearRegistry();
  registerAllPrompts();
});

describe('registerAllPrompts', () => {
  it('populates the registry with all prompts', () => {
    // clearRegistry + registerAllPrompts already called in beforeEach
    const stats = getStats();

    // 5 legacy + 8 v2 = 13 prompts, legacy has 4 unique IDs + 8 v2 = 12 unique
    expect(stats.totalPrompts).toBe(13);
    expect(stats.uniqueIds).toBe(12);
  });

  it('configures variant weights for site_copy', () => {
    const stats = getStats();

    expect(stats.variantConfigs).toBe(1);
  });

  it('is idempotent when called multiple times', () => {
    registerAllPrompts(); // call a second time
    const stats = getStats();

    // registerAll overwrites existing keys, so counts stay the same
    expect(stats.totalPrompts).toBe(13);
    expect(stats.uniqueIds).toBe(12);
  });
});

describe('runPrompt', () => {
  it('calls AI.run and returns an LlmCallResult for research_business', async () => {
    const env = createMockEnv();
    const result = await runPrompt(env, 'research_business', 2, {
      business_name: 'Test Biz',
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe(MOCK_RESEARCH_RESPONSE);
    expect(result.promptId).toBe('research_business');
    expect(result.promptVersion).toBe(2);
    expect(result.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(typeof result.latencyMs).toBe('number');
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it('fires a PostHog $ai_generation event with real token estimates (AL-746 — was NEVER called)', async () => {
    (captureLLMCall as jest.Mock).mockClear();
    const env = createMockEnv();
    const result = await runPrompt(env, 'research_business', 2, { business_name: 'Test Biz' }, {
      traceContext: { orgId: 'org_1', traceId: 'trace_abc', promptId: 'research_business' },
    });

    // The observability call the JSDoc promised — before AL-746 safeCaptureWorkersAi had ZERO
    // call sites, so this asserted-0 → asserted-1 is the RED→GREEN proof of the wiring.
    expect(captureLLMCall as jest.Mock).toHaveBeenCalledTimes(1);
    const [, params] = (captureLLMCall as jest.Mock).mock.calls[0];
    expect(params).toMatchObject({
      distinctId: 'org_1',
      provider: 'workers_ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      promptId: 'research_business',
      status: 'ok',
      costUsd: 0,
      traceId: 'trace_abc',
    });
    // Token counts are real estimates now (~chars/4), never the old hardcoded 0.
    expect(params.inputTokens).toBeGreaterThan(0);
    expect(params.outputTokens).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('throws for an unknown prompt ID', async () => {
    const env = createMockEnv();

    await expect(runPrompt(env, 'nonexistent_prompt', 1, { foo: 'bar' })).rejects.toThrow(
      'Prompt not found: nonexistent_prompt@1',
    );
  });

  it('throws for a valid prompt ID but wrong version', async () => {
    const env = createMockEnv();

    await expect(
      runPrompt(env, 'research_business', 99, { business_name: 'Test' }),
    ).rejects.toThrow('Prompt not found: research_business@99');
  });

  it('passes rendered messages to AI.run with correct structure', async () => {
    const env = createMockEnv();
    await runPrompt(env, 'research_business', 2, {
      business_name: 'Acme Corp',
    });

    const callArgs = (env.AI.run as jest.Mock).mock.calls[0];
    expect(callArgs[0]).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

    const payload = callArgs[1];
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[1].role).toBe('user');
    expect(payload.messages[1].content).toContain('Acme Corp');
    expect(typeof payload.temperature).toBe('number');
    expect(typeof payload.max_tokens).toBe('number');
  });
});
