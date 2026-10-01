/**
 * Edge AI Router — the FIRST decision every AI request makes.
 *
 * The product promise (marketing homepage): "instant responses via Workers AI
 * (free), routine generation via DeepSeek, premium reasoning via Anthropic
 * Claude or OpenAI." This module makes that promise real at the edge:
 *
 *   1. `classifyPromptTier()` — deterministic, sub-ms classification (no LLM
 *      call, no external latency) into `instant` / `standard` / `premium`.
 *      A model-name hint (what the client asked for) wins; then explicit
 *      reasoning markers; then build/code markers; short chit-chat falls to
 *      `instant`.
 *   2. `instant` → Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
 *      streamed, FREE at the edge) — never leaves Cloudflare.
 *   3. `standard` → DeepSeek through the Cloudflare AI Gateway (OpenAI-compat
 *      `chat/completions`, `stream:true`).
 *   4. `premium` → OpenAI `gpt-4o` through the AI Gateway (OpenAI-compat).
 *      (Anthropic-via-gateway uses its native wire format and belongs to
 *      Anthropic-protocol surfaces, not this OpenAI-compat pass-through.)
 *
 * The gateway is CONDITIONAL per the standing contract: used whenever
 * `CF_ACCOUNT_ID` is set and `AI_GATEWAY_ENABLED !== "false"`; a gateway 5xx
 * falls back to the provider's direct URL inside {@link gatewayFetch}.
 *
 * Output is always OpenAI-compatible SSE (`data: {"choices":[...]}` frames +
 * `data: [DONE]`) so AI SDK clients (the bolt editor) consume it unchanged.
 */

import type { Env } from '../types/env.js';
import { chooseProviderForTier } from './external_llm.js';
import { gatewayFetch } from './ai_gateway.js';

export type AiTier = 'instant' | 'standard' | 'premium';

/** Workers AI model for instant answers (free tier, streaming). */
const INSTANT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as const;

/**
 * Bounded retry budget for TRANSIENT upstream failures (a Workers-AI throw, an
 * AI-Gateway/vendor 5xx). This is the real fix for the "3 attempts / bad
 * gateway" the editor Data-tab "Ask AI" hit: a single cold/transient 5xx used
 * to produce an IMMEDIATE bare 502, forcing the user to manually retry. We now
 * retry up to {@link MAX_UPSTREAM_ATTEMPTS} times with short backoff before
 * surfacing a TYPED error — never a swallowed, message-less 502.
 *
 * A 4xx is NOT retried (bad key / malformed body is terminal — the direct URL
 * would reject it too); only 5xx + thrown network errors are transient.
 */
const MAX_UPSTREAM_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [150, 400] as const; // backoff before attempt 2, attempt 3

/** Typed, non-swallowed error code every exhausted-retry path surfaces. */
const AI_UPSTREAM_ERROR_CODE = 'AI_UPSTREAM_UNAVAILABLE' as const;
const AI_UPSTREAM_ERROR_MESSAGE =
  'The AI service is temporarily unavailable. Please try again in a moment.';

/** Sleep helper (no-op at 0ms) for backoff between retry attempts. */
function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * The single typed error envelope for an exhausted-retry upstream failure.
 * Shape matches the OpenAI-style `{error:{code,message}}` the frontend parses
 * (`callAi` reads `body.message` / `error.message`), so the user sees a real
 * sentence, never "AI is unavailable (HTTP 502)".
 *
 * @param stream - true → an SSE error frame + `[DONE]` (200, so the SDK reader
 *   closes cleanly); false → a JSON 502 the `generateText` path reads.
 */
function upstreamUnavailableResponse(stream: boolean): Response {
  if (stream) {
    return new Response(
      `data: {"error":{"code":"${AI_UPSTREAM_ERROR_CODE}","message":${sseEscapeJson(
        AI_UPSTREAM_ERROR_MESSAGE,
      )}}}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
  }
  return Response.json(
    { error: { code: AI_UPSTREAM_ERROR_CODE, message: AI_UPSTREAM_ERROR_MESSAGE } },
    { status: 502 },
  );
}

/** `JSON.stringify` a string WITH its surrounding quotes, for an SSE `data:` frame. */
function sseEscapeJson(s: string): string {
  return JSON.stringify(s);
}

/**
 * Chat models per provider + tier (all OpenAI-compat wire format). When a
 * tier's preferred provider lacks its key, `chooseProviderForTier` falls back
 * to OpenAI — the models below cover both providers at both tiers.
 */
const TIER_MODELS: Record<
  'fable' | 'openai' | 'kimi' | 'deepseek',
  Record<Exclude<AiTier, 'instant'>, string>
> = {
  fable: { standard: 'claude-sonnet-4-6', premium: 'claude-opus-4-6' },
  openai: { standard: 'gpt-4o-mini', premium: 'gpt-4o' },
  kimi: { standard: 'kimi-k3', premium: 'kimi-k3' },
  deepseek: { standard: 'deepseek-chat', premium: 'deepseek-reasoner' },
};

/** Model-name hints the bolt editor sends → tier (its static model chips). */
const MODEL_HINT_TIER: Record<string, AiTier> = {
  'claude-opus-4-6': 'premium',
  'claude-sonnet-4-6': 'premium',
  'deepseek-chat': 'standard',
  'deepseek-reasoner': 'premium',
  'glm-4.6': 'standard',
};

/** Reasoning-intent markers → premium (checked BEFORE build markers). */
const PREMIUM_MARKERS = [
  /\b(architecture|refactor|design system|step by step|algorithm|proof|optimize|migrate)\b/,
  /\b(analy[sz]e|evaluate|compare|critique|reason|explain how|explain why)\b/,
  /\b(plan|strategy|trade-?offs|root cause|security audit)\b/,
  /\b(math|calculus|derivative|integral|logic puzzle|proof that)\b/,
];

/** Build/code markers → standard (DeepSeek generation tier). */
const STANDARD_MARKERS = [
  /\b(build|create|generate|write|implement|fix|add|update|remove)\b/,
  /\b(code|component|page|section|component|function|app|site|website|api|endpoint)\b/,
  /\b(html|css|javascript|typescript|react|angular|tailwind|sql|database|deploy)\b/,
  /```/,
];

/** Extract the last user turn's text (ignore tool/system scaffolding). */
function lastUserText(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return '';
}

/**
 * Classify a prompt into the cheapest tier that can answer it well — at the
 * edge, deterministically, in sub-ms (no LLM round-trip for routing).
 *
 * @param messages - OpenAI-format conversation (the last user turn is scored).
 * @param modelHint - Optional model name the client asked for (bolt chips).
 * @returns `instant` (Workers AI) · `standard` (DeepSeek via gateway) ·
 *   `premium` (OpenAI via gateway).
 * @example classifyPromptTier([{ role: 'user', content: 'What is 2+2?' }]) // 'instant'
 * @example classifyPromptTier([{ role: 'user', content: 'Build a hero section with Tailwind' }]) // 'standard'
 */
export function classifyPromptTier(
  messages: { role: string; content: string }[],
  modelHint?: string | null,
): AiTier {
  // Explicit client intent wins (the model chip the user picked).
  if (modelHint && MODEL_HINT_TIER[modelHint]) return MODEL_HINT_TIER[modelHint]!;

  const text = lastUserText(messages);
  const lower = text.toLowerCase();

  // Long or reasoning-shaped → premium. Checked FIRST: a long build request
  // with deep intent is premium, not standard.
  if (text.length > 800 || PREMIUM_MARKERS.some((re) => re.test(lower))) return 'premium';

  // Build/code intent → standard (DeepSeek is the volume generator).
  if (STANDARD_MARKERS.some((re) => re.test(lower))) return 'standard';

  // Anything else (short Q&A, chit-chat, definitions) → instant, free, edge.
  return 'instant';
}

/** Map a model hint directly to a tier without heuristics. */
export function tierFromModelHint(modelHint?: string | null): AiTier | null {
  if (modelHint && MODEL_HINT_TIER[modelHint]) return MODEL_HINT_TIER[modelHint]!;
  return null;
}

/** JSON-escape a string for embedding in an SSE `data:` frame. */
function sseEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * Non-streaming Workers AI answer as an OpenAI chat.completion JSON object —
 * the shape `generateText` parses (`choices[0].message.content`).
 */
async function workersAiToOpenAiJson(
  env: Env,
  messages: { role: string; content: string }[],
): Promise<Response> {
  const ai = env.AI as unknown as {
    run: (
      model: string,
      opts: unknown,
    ) => Promise<{ response?: string } | ReadableStream<string>>;
  };

  // Bounded retry: a transient Workers-AI throw used to 502 on the first try.
  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
    try {
      const out = await ai.run(INSTANT_MODEL, { messages, max_tokens: 1024 });
      const text = typeof out === 'object' && out && 'response' in out ? (out.response ?? '') : '';
      return Response.json({
        id: `wa-${Date.now()}`,
        object: 'chat.completion',
        model: INSTANT_MODEL,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
      });
    } catch {
      // swallow + retry; the typed error surfaces only after the budget is spent.
    }
  }
  return upstreamUnavailableResponse(false);
}

/**
 * Stream a Workers AI answer as OpenAI-compatible SSE frames, so OpenAI-SDK
 * clients consume it unchanged. Never throws — errors become an error frame.
 */
async function workersAiToOpenAiSse(
  env: Env,
  messages: { role: string; content: string }[],
): Promise<Response> {
  // One fallback SSE for BOTH the throw path AND a null/undefined stream — returning
  // it (instead of a non-null `!` at read time) keeps the instant router fail-soft:
  // a Workers-AI hiccup degrades to a clean [DONE] frame, never a crash inside the
  // ReadableStream `start()` closure below.
  const aiUnavailable = (): Response => upstreamUnavailableResponse(true);
  const ai = env.AI as unknown as {
    run: (model: string, opts: unknown) => Promise<ReadableStream<string>>;
  };

  // Bounded retry on a transient throw while ACQUIRING the stream (before any
  // frame is sent). Once bytes are flowing, a mid-stream error degrades to a
  // clean error frame inside the reader loop below — it cannot be retried.
  let stream: ReadableStream<string> | null = null;
  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
    try {
      stream = await ai.run(INSTANT_MODEL, { messages, stream: true, max_tokens: 1024 });
      if (stream) break;
    } catch {
      stream = null; // retry
    }
  }
  if (!stream) return aiUnavailable();
  const readable = stream;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sawDone = false;
      try {
        // Workers AI stream chunks are read via the reader (not typed
        // async-iterable — same pattern as the palette in ai_admin.ts).
        // They arrive in one of TWO shapes, so the shim handles both:
        //   • OpenAI-format SSE frames (`data: {"choices":[...]}`) — some
        //     Workers AI chat streams return these VERBATIM; wrapping them
        //     again double-encodes and breaks AI SDK clients (live-incident:
        //     the editor bounced to its landing screen on nested `data:`).
        //   • raw text deltas — wrapped into an OpenAI delta frame here.
        const reader = readable.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = (typeof value === 'string' ? value : new TextDecoder().decode(value)).trim();
          if (!text) continue;
          if (text.includes('[DONE]')) sawDone = true;
          if (text.startsWith('data:')) {
            controller.enqueue(encoder.encode(`${text}\n\n`));
          } else {
            const frame = `data: {"id":"wa","choices":[{"delta":{"content":"${sseEscape(text)}"}}]}\n\n`;
            controller.enqueue(encoder.encode(frame));
          }
        }
        if (!sawDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch {
        controller.enqueue(
          encoder.encode(
            `data: {"error":{"code":"INSTANT_AI_FAILED","message":"Stream interrupted"}}\n\ndata: [DONE]\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Edge-Tier': 'instant',
    },
  });
}

/**
 * {@link gatewayFetch} with a bounded retry on TRANSIENT upstream 5xx. The
 * underlying `gatewayFetch` already falls back gateway→direct ONCE; this adds
 * the retry budget ON TOP so a cold/transient 5xx (which hit BOTH the gateway
 * and the direct vendor) is re-attempted with backoff instead of becoming an
 * immediate 502. A 4xx (bad key / malformed body) is terminal — returned as-is,
 * never retried (the direct URL would reject it identically). A thrown network
 * error is also transient and retried.
 *
 * @returns the last {@link gatewayFetch} result (a 5xx response after the budget
 *   is spent, which {@link gatewayResponse} converts to the typed error).
 */
async function gatewayFetchWithRetry(
  env: Env,
  provider: Parameters<typeof gatewayFetch>[1],
  pathSuffix: string,
  init: RequestInit,
): Promise<Awaited<ReturnType<typeof gatewayFetch>>> {
  let last: Awaited<ReturnType<typeof gatewayFetch>> | null = null;
  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
    try {
      last = await gatewayFetch(env, provider, pathSuffix, init);
    } catch {
      last = null; // network throw → transient, retry
      continue;
    }
    const status = last.response.status;
    if (status < 500) return last; // 2xx success OR 4xx terminal — don't retry
    // 5xx → transient; loop to retry (unless budget exhausted).
  }
  return last ?? { response: new Response(null, { status: 502 }), gatewayUsed: false };
}

/**
 * Route a bolt-chat request: classify at the edge → Workers AI when instant,
 * else the tier model through the (conditional) Cloudflare AI Gateway.
 *
 * @param env - Worker env (AI binding + CF_ACCOUNT_ID + provider keys).
 * @param messages - OpenAI-format conversation.
 * @param modelHint - Client's model name (bolt model chip) as a tier hint.
 * @returns OpenAI-compatible SSE `Response` (always 200 unless upstream dies).
 */
export async function routeBoltChat(
  env: Env,
  messages: { role: string; content: string }[],
  modelHint?: string | null,
  stream = true,
): Promise<Response> {
  const tier = tierFromModelHint(modelHint) ?? classifyPromptTier(messages, modelHint);

  if (tier === 'instant') {
    return stream ? workersAiToOpenAiSse(env, messages) : workersAiToOpenAiJson(env, messages);
  }

  // gatewayFetch adds ONLY the cf-aig-* cache headers — the provider's
  // Authorization must be in init.headers (the gateway proxies it verbatim;
  // it is also the fallback credential for the direct vendor URL).
  // NOTE the fable/key gate: gatewayFetch derives the provider header FROM the
  // provider slug, so 'fable' would send `x-provider: fable` to the gateway's
  // anthropic base — but Anthropic-derived slugs fall back to 'anthropic' below
  // via the WIRE-COMPATIBLE slug. Wire compatibility (OpenAI chat/completions):
  // fable → anthropic slug, kimi → openai slug; only openai/deepseek keep
  // their own.
  const keyFor = (p: 'deepseek' | 'openai' | 'kimi'): string =>
    p === 'deepseek'
      ? (env.DEEPSEEK_API_KEY ?? '')
      : p === 'kimi'
        ? (env.KIMI_API_KEY ?? '')
        : (env.OPENAI_API_KEY ?? '');

  const provider = chooseProviderForTier(env, tier);
  if (provider === 'fable' || provider === 'anthropic') {
    // Anthropic-protocol premium rung (Fable 5). The gateway speaks the
    // anthropic slug natively; model is the anthropic-native name.
    const upstream = await gatewayFetchWithRetry(env, 'anthropic', '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.FABLE_API_KEY ?? env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider === 'fable' ? TIER_MODELS.fable.premium : 'claude-opus-4-6',
        max_tokens: 4096,
        stream,
        messages: messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });
    return gatewayResponse(upstream, tier, stream);
  }

  const gatewayProvider: 'deepseek' | 'openai' | 'kimi' =
    provider === 'deepseek' ? 'deepseek' : provider === 'kimi' ? 'kimi' : 'openai';
  const upstream = await gatewayFetchWithRetry(env, gatewayProvider, '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keyFor(gatewayProvider)}`,
    },
    body: JSON.stringify({
      model: TIER_MODELS[gatewayProvider][tier],
      messages,
      stream,
    }),
  });
  return gatewayResponse(upstream, tier, stream);
}

/**
 * Wrap a (post-retry) gatewayFetch result as the client response. On a failed
 * upstream, surface the TYPED, non-swallowed {@link AI_UPSTREAM_ERROR_CODE}
 * envelope the frontend reads — a 502 JSON for non-stream callers, an SSE error
 * frame for streaming ones.
 */
function gatewayResponse(
  upstream: Awaited<ReturnType<typeof gatewayFetch>>,
  tier: Exclude<AiTier, 'instant'>,
  stream: boolean,
): Response {
  if (!upstream.response.ok) {
    return upstreamUnavailableResponse(stream);
  }
  return new Response(upstream.response.body, {
    status: 200,
    headers: {
      'Content-Type': stream ? 'text/event-stream; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-cache',
      'X-AI-Gateway': upstream.gatewayUsed ? '1' : '0',
      'X-Edge-Tier': tier,
    },
  });
}
