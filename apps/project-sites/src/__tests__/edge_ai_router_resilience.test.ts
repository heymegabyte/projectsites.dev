/**
 * Edge AI Router — bad-gateway resilience (WLK-04).
 *
 * The editor Data-tab "Ask AI" action posts to `/api/llmcall`, which routes
 * through {@link routeBoltChat}. A transient upstream 5xx (Workers AI hiccup or
 * an AI-Gateway/vendor blip) previously produced an IMMEDIATE bare `502` — the
 * "3 attempts / bad gateway" the user hit (they had to manually retry). This
 * suite is the RED-first reproduction + the GREEN contract:
 *
 *   1. A transient 5xx followed by a success is RETRIED (bounded, with backoff)
 *      so the caller sees a `200`, never a 502.
 *   2. A persistent 5xx surfaces a TYPED, non-swallowed error envelope
 *      (`error.code` = 'AI_UPSTREAM_UNAVAILABLE' + a human `message`) with a
 *      502 status — the frontend reads `message`, so it must be present.
 *
 * Only the two upstreams are mocked (Workers AI `env.AI.run` + `gatewayFetch`);
 * the routing + retry logic under test is real.
 */
import { routeBoltChat } from '../services/edge_ai_router.js';
import type { Env } from '../types/env.js';

jest.mock('../services/ai_gateway.js', () => ({
  gatewayFetch: jest.fn(),
  isGatewayActive: jest.fn(() => false),
  DIRECT_BASE_URLS_EXPORT: {},
}));

import { gatewayFetch } from '../services/ai_gateway.js';

const mockGatewayFetch = gatewayFetch as jest.MockedFunction<typeof gatewayFetch>;

/** Minimal Workers-AI binding mock whose `run` is scripted per-call. */
function makeAi(run: jest.Mock) {
  return { run } as unknown as Env['AI'];
}

/** Env with just enough for the standard/premium gateway path + a provider key. */
function makeEnv(ai: Env['AI']): Env {
  return {
    AI: ai,
    DEEPSEEK_API_KEY: 'sk-test',
    OPENAI_API_KEY: 'sk-test',
    CF_ACCOUNT_ID: 'acct',
  } as unknown as Env;
}

const INSTANT_MSG = [{ role: 'user', content: 'what is 2+2?' }]; // → instant (Workers AI)
const STANDARD_MSG = [{ role: 'user', content: 'build a hero section with tailwind' }]; // → gateway

function okChatCompletion(text = 'ok'): Response {
  return Response.json({
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('routeBoltChat — instant (Workers AI) transient-failure resilience', () => {
  it('retries a transient Workers-AI throw, then returns 200 (not 502)', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient 5xx'))
      .mockResolvedValueOnce({ response: 'four' });
    const res = await routeBoltChat(makeEnv(makeAi(run)), INSTANT_MSG, null, false);

    expect(run).toHaveBeenCalledTimes(2); // first failed, retry succeeded
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toBe('four');
  });

  it('surfaces a TYPED, non-swallowed error after exhausting retries', async () => {
    const run = jest.fn().mockRejectedValue(new Error('workers ai down'));
    const res = await routeBoltChat(makeEnv(makeAi(run)), INSTANT_MSG, null, false);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2); // retried, not one-and-done
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AI_UPSTREAM_UNAVAILABLE');
    // The frontend reads `message` — it must be a human string, never undefined.
    expect(typeof body.error?.message).toBe('string');
    expect(body.error?.message?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('routeBoltChat — gateway (standard/premium) transient-failure resilience', () => {
  it('retries a transient gateway 5xx, then returns 200 (not 502)', async () => {
    mockGatewayFetch
      .mockResolvedValueOnce({
        response: new Response('upstream boom', { status: 503 }),
        gatewayUsed: true,
      })
      .mockResolvedValueOnce({ response: okChatCompletion('hero'), gatewayUsed: true });

    const res = await routeBoltChat(makeEnv(makeAi(jest.fn())), STANDARD_MSG, null, false);

    expect(mockGatewayFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('surfaces a TYPED error (code + message) after persistent gateway 5xx', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response('still down', { status: 502 }),
      gatewayUsed: true,
    });

    const res = await routeBoltChat(makeEnv(makeAi(jest.fn())), STANDARD_MSG, null, false);

    expect(mockGatewayFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AI_UPSTREAM_UNAVAILABLE');
    expect(typeof body.error?.message).toBe('string');
    expect(body.error?.message?.length ?? 0).toBeGreaterThan(0);
  });

  it('does NOT retry a 4xx and forwards it VERBATIM (real vendor error, never masked as 502)', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response('{"error":{"message":"Invalid API key"}}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
      gatewayUsed: true,
    });

    const res = await routeBoltChat(makeEnv(makeAi(jest.fn())), STANDARD_MSG, null, false);

    expect(mockGatewayFetch).toHaveBeenCalledTimes(1); // 4xx is terminal, no retry
    // The real 4xx is surfaced as-is — NOT masked as a retryable 502. Masking made the
    // caller retry a hopeless request 3× and hid the real cause behind "unavailable".
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('Invalid API key');
  });
});
