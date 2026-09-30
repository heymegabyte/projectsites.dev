/**
 * @module libs/features/model_registry/anthropic_handlers
 * @description Anthropic-compatible public API for the model-registry feature
 * (campaign lane-4, fire-58). Sibling of ./handlers.ts (the OpenAI surface) —
 * same `model_registry` flag, same psk_ token store, same virtual-model
 * routing through services/external_llm.
 *
 * | Method | Path                      | Auth                                         |
 * | ------ | ------------------------- | -------------------------------------------- |
 * | POST   | /v1/messages              | x-api-key psk_ token (Anthropic 401 else)    |
 * | POST   | /v1/messages/count_tokens | x-api-key psk_ token (Anthropic 401 else)    |
 *
 * Protocol notes:
 * - Auth is the Anthropic convention: the RAW psk_ token in `x-api-key`
 *   (never Bearer). Missing/invalid → 401 `{type:"error",error:{type:
 *   "authentication_error",message}}`.
 * - `anthropic-version` header is REQUIRED (any non-empty value accepted;
 *   this shim does not vary behavior by protocol date). Missing → 400
 *   `invalid_request_error`.
 * - `stream:true` is served as SYNTHESIZED named-event SSE (see
 *   {@link streamAnthropicMessage} for the honesty contract).
 * - Usage split follows the fire-57 rule: provider-reported
 *   input/output tokens when present; a chars/4 (floor 1) estimate when the
 *   provider omits the split — count_tokens uses the same estimator and never
 *   burns an upstream call.
 *
 * Flag-gated: dark 404 (never 403) when `model_registry` is off, BEFORE auth.
 * Contract: e2e/ai-api/anthropic-compat.e2e.ts (campaign lane-4, §7).
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { verifyApiToken } from '../../../src/services/api_tokens.js';
import { callExternalLLM } from '../../../src/services/external_llm.js';
import {
  AnthropicCountTokensRequestSchema,
  AnthropicMessagesRequestSchema,
  type AnthropicMessage,
  type AnthropicTextBlock,
} from './schemas.js';
import { FLAG_KEY, resolveChatRoute } from './service.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const anthropicCompat = new Hono<AppContext>();

/** Dark 404 — same envelope the rest of the platform uses for flag-off routes. */
function darkNotFound(c: Context<AppContext>) {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } }, 404);
}

/** The Anthropic error envelope `{type:"error",error:{type,message}}`. */
function anthropicError(
  c: Context<AppContext>,
  status: 400 | 401 | 404 | 502,
  type: 'invalid_request_error' | 'authentication_error' | 'not_found_error' | 'api_error',
  message: string,
): Response {
  return c.json({ type: 'error' as const, error: { type, message } }, status);
}

/**
 * Resolve the caller's verified API token from the Anthropic-convention
 * `x-api-key` header (raw psk_ value, no Bearer prefix). verifyApiToken
 * itself rejects non-psk_ prefixes, so garbage headers never hash.
 */
async function authenticateXApiKey(
  c: Context<AppContext>,
): Promise<Awaited<ReturnType<typeof verifyApiToken>>> {
  const key = c.req.header('x-api-key');
  return key ? await verifyApiToken(c.env.DB, key) : null;
}

/** 401 in the Anthropic envelope, mirroring their `invalid x-api-key` wording. */
function authenticationError(c: Context<AppContext>): Response {
  return anthropicError(
    c,
    401,
    'authentication_error',
    'invalid x-api-key. Pass a projectsites API token (psk_…) in the "x-api-key" header (create one under Admin → API Tokens).',
  );
}

/**
 * Shared pre-flight for both routes: flag gate → x-api-key auth →
 * anthropic-version requirement. Returns either the verified token or the
 * error Response to send.
 */
async function preflight(
  c: Context<AppContext>,
): Promise<{ token: NonNullable<Awaited<ReturnType<typeof verifyApiToken>>> } | { response: Response }> {
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) return { response: darkNotFound(c) };

  const token = await authenticateXApiKey(c);
  if (!token) return { response: authenticationError(c) };

  if (!c.req.header('anthropic-version')) {
    return {
      response: anthropicError(
        c,
        400,
        'invalid_request_error',
        'anthropic-version header is required (e.g. "anthropic-version: 2023-06-01").',
      ),
    };
  }

  return { token };
}

/** Fold string-or-text-block content to plain text. */
function contentText(content: string | AnthropicTextBlock[]): string {
  return typeof content === 'string' ? content : content.map((b) => b.text).join('\n\n');
}

/**
 * Fold an Anthropic request into external_llm's `{system, user}` shape —
 * verbatim for a single turn, role-labelled transcript for multi-turn
 * (mirrors ./handlers.ts foldMessages so both surfaces prompt identically).
 */
function foldAnthropicPrompt(
  messages: AnthropicMessage[],
  system?: string | AnthropicTextBlock[],
): { system: string; user: string } {
  const sys = (system !== undefined ? contentText(system) : '') || 'You are a helpful assistant.';
  const user =
    messages.length === 1
      ? contentText(messages[0].content)
      : messages
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentText(m.content)}`)
          .join('\n\n');
  return { system: sys, user };
}

/**
 * chars/4 token estimate, floored at 1 — the standard rough heuristic. Used
 * for count_tokens AND as the usage fallback when a provider omits its split
 * (an ESTIMATE, clearly not a provider-reported count; documented, never
 * claimed otherwise).
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Synthesize an Anthropic-wire named-event SSE response from a COMPLETED
 * message.
 *
 * Honesty contract: the upstream call ran NON-streamed to completion via
 * {@link callExternalLLM}; this helper re-emits the finished text as the
 * spec-correct Anthropic event sequence (correct wire format; upstream token
 * pass-through is a follow-up). No incremental-latency claim is made — events
 * flush as fast as the runtime drains the stream.
 *
 * Sequence (per e2e/ai-api/anthropic-compat.e2e.ts §2): `message_start` →
 * `content_block_start` → `content_block_delta`×N (≥1, word-ish text_deltas
 * that reassemble exactly) → `content_block_stop` → `message_delta`
 * (stop_reason end_turn + output usage) → exactly one terminal `message_stop`.
 */
function streamAnthropicMessage(
  model: string,
  output: string,
  inputTokens: number,
  outputTokens: number,
): Response {
  const id = `msg_${crypto.randomUUID()}`;
  // Boundary = whitespace→non-whitespace lookaround: byte-exact reassembly.
  // Empty output still emits ONE (empty) delta so the ≥1-delta contract holds.
  const pieces = output ? output.split(/(?<=\s)(?=\S)/) : [''];
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      send('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      for (const piece of pieces) {
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        });
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      send('message_stop', { type: 'message_stop' });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * POST /v1/messages
 *
 * Anthropic-compatible messages endpoint. Routes exactly like the OpenAI
 * surface: virtual service models via external_llm cost tiers, registry
 * aliases via their first routable vendor (resolveChatRoute).
 *
 * @returns 200 `{id:"msg_…", type:"message", role:"assistant", model,
 *          content:[{type:"text",text}], stop_reason:"end_turn",
 *          stop_sequence:null, usage:{input_tokens,output_tokens}}` — `model`
 *          echoes the REQUESTED id; usage is the provider split (fire-57) or
 *          a chars/4 estimate when omitted. With `stream:true`, 200
 *          `text/event-stream` of named Anthropic events (see
 *          {@link streamAnthropicMessage}).
 * @throws 404 dark (flag off) · 401 authentication_error · 400
 *         invalid_request_error (missing anthropic-version / invalid body) ·
 *         404 not_found_error (unknown/unroutable model) · 502 api_error
 *         (upstream exhausted; internals never leak).
 *
 * @example
 * // curl -X POST https://projectsites.dev/v1/messages \
 * //   -H "x-api-key: psk_…" -H "anthropic-version: 2023-06-01" \
 * //   -H "Content-Type: application/json" \
 * //   -d '{"model":"projectsites-fast","max_tokens":64,"messages":[{"role":"user","content":"Hi"}]}'
 */
anthropicCompat.post('/v1/messages', async (c) => {
  const pre = await preflight(c);
  if ('response' in pre) return pre.response;
  const { token } = pre;

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return anthropicError(c, 400, 'invalid_request_error', 'Request body must be valid JSON.');
  }

  const parsed = AnthropicMessagesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.');
    return anthropicError(
      c,
      400,
      'invalid_request_error',
      `Invalid request${path ? ` (${path})` : ''}: ${issue?.message ?? 'malformed body'}`,
    );
  }
  const body = parsed.data;

  const route = resolveChatRoute(body.model);
  if (!route) {
    return anthropicError(c, 404, 'not_found_error', `model: ${body.model} not found`);
  }

  const { system, user } = foldAnthropicPrompt(body.messages, body.system);

  try {
    const result = await callExternalLLM(c.env, {
      system,
      user,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      ...(route.kind === 'tier'
        ? { tier: route.tier }
        : { provider: route.provider, ...(route.model ? { model: route.model } : {}) }),
      traceContext: {
        orgId: token.org_id ?? undefined,
        traceId: c.get('requestId') ?? crypto.randomUUID(),
        promptId: 'anthropic_messages_api',
      },
    });

    // fire-57 split: provider-reported tokens when present; otherwise a
    // chars/4 estimate so the Anthropic invariant (both counts > 0) holds.
    const inputTokens =
      Number.isFinite(result.input_tokens) && result.input_tokens > 0
        ? result.input_tokens
        : estimateTokens(`${system}\n\n${user}`);
    const outputTokens =
      Number.isFinite(result.output_tokens) && result.output_tokens > 0
        ? result.output_tokens
        : estimateTokens(result.output);

    if (body.stream === true) {
      return streamAnthropicMessage(body.model, result.output, inputTokens, outputTokens);
    }

    return c.json(
      {
        id: `msg_${crypto.randomUUID()}`,
        type: 'message' as const,
        role: 'assistant' as const,
        // Echo the REQUESTED id — the concrete upstream model is an internal
        // routing detail (surfaced only in tracing, never the public envelope).
        model: body.model,
        content: [{ type: 'text' as const, text: result.output }],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
      200,
    );
  } catch {
    // Upstream exhausted (all providers failed) — Anthropic-shaped 502, no internals.
    return anthropicError(
      c,
      502,
      'api_error',
      'The upstream model provider failed to complete the request. Please try again shortly.',
    );
  }
});

/**
 * POST /v1/messages/count_tokens
 *
 * Anthropic-compatible token counting. Pure chars/4 estimation over the
 * folded system+messages prompt — deterministic, model-validated, and never
 * burns an upstream call (documented estimate, not a provider tokenizer).
 *
 * @returns 200 `{input_tokens:number}` (always ≥1; NEVER carries
 *          output_tokens — this is a count endpoint, not a generation).
 * @throws 404 dark (flag off) · 401 authentication_error · 400
 *         invalid_request_error (missing anthropic-version / invalid body) ·
 *         404 not_found_error (unknown model).
 *
 * @example
 * // curl -X POST https://projectsites.dev/v1/messages/count_tokens \
 * //   -H "x-api-key: psk_…" -H "anthropic-version: 2023-06-01" \
 * //   -H "Content-Type: application/json" \
 * //   -d '{"model":"projectsites-fast","messages":[{"role":"user","content":"Hi"}]}'
 */
anthropicCompat.post('/v1/messages/count_tokens', async (c) => {
  const pre = await preflight(c);
  if ('response' in pre) return pre.response;

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return anthropicError(c, 400, 'invalid_request_error', 'Request body must be valid JSON.');
  }

  const parsed = AnthropicCountTokensRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.');
    return anthropicError(
      c,
      400,
      'invalid_request_error',
      `Invalid request${path ? ` (${path})` : ''}: ${issue?.message ?? 'malformed body'}`,
    );
  }
  const body = parsed.data;

  if (!resolveChatRoute(body.model)) {
    return anthropicError(c, 404, 'not_found_error', `model: ${body.model} not found`);
  }

  const { system, user } = foldAnthropicPrompt(body.messages, body.system);
  return c.json({ input_tokens: estimateTokens(`${system}\n\n${user}`) }, 200);
});
