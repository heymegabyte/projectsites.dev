/**
 * @module services/external_llm
 * @description Unified external LLM client for OpenAI + Anthropic (fetch, no SDK in Workers).
 * GPT-4o is primary for research/vision; Anthropic Claude is the fallback.
 *
 * Features: retry w/ backoff+jitter · circuit breaker (5 fails/60s → skip 30s) ·
 * Cloudflare AI Gateway routing · Anthropic prompt caching when system > 1024 chars ·
 * Anthropic structured-outputs beta when responseSchema passed.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { withRetry, classifyError } from './retry.js';
import { captureLLMCall } from './analytics.js';
import { log } from '../lib/log.js';
import { meterAiTokens } from './usage_metering.js';
import {
  gatewayBaseUrl,
  gatewayFetch,
  gatewayMetadata,
  type GatewayCallOptions,
} from './ai_gateway.js';
export { DIRECT_BASE_URLS_EXPORT } from './ai_gateway.js';

const llmLog = log.child('external_llm');

/**
 * Caller-supplied tracing context threaded through every external LLM call.
 *
 * @remarks
 * Used as the PostHog `distinctId` + `$ai_trace_id` so multi-step agentic
 * flows (research → brand → site-gen → score) roll up as a single trace in
 * PostHog's LLM Observability dashboards. Every field is optional so legacy
 * callers keep working with `'system'` as the distinctId fallback.
 *
 * @example
 * ```ts
 * await callExternalLLM(env, {
 *   system: '...', user: '...',
 *   traceContext: { orgId: 'o_123', userId: 'u_456', traceId: requestId, promptId: 'research_brand' },
 * });
 * ```
 */
export interface TraceContext {
  /** Organization id — preferred PostHog distinctId when set. */
  orgId?: string;
  /** User id — fallback PostHog distinctId when orgId is absent. */
  userId?: string;
  /** Stable trace id (request id, workflow instance id) for multi-call rollup. */
  traceId?: string;
  /** Prompt id (e.g. `research_brand`, `generate_website`) for cost-per-prompt rollups. */
  promptId?: string;
}

/**
 * Parsed Anthropic Citations API entry surfaced on the response.
 *
 * @remarks
 * Populated only when the caller passes `documents` and `citations` is enabled
 * on the request. See {@link callExternalLLM} + Anthropic docs:
 * https://docs.anthropic.com/en/docs/build-with-claude/citations
 */
export interface AnthropicCitation {
  documentIndex: number;
  documentTitle?: string;
  citedText: string;
  /** PDF page (when source is a PDF). */
  startPageNumber?: number;
  endPageNumber?: number;
  /** Plain-text char index (when source is text). */
  startCharIndex?: number;
  endCharIndex?: number;
  /** Custom-content block index (when source is custom JSON blocks). */
  startBlockIndex?: number;
  endBlockIndex?: number;
}

export interface ExternalLLMOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** JSON schema for OpenAI structured output (response_format) */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  provider?: 'openai' | 'anthropic' | 'deepseek' | 'auto';
  /**
   * Cost tier for automatic provider selection when `provider` is not explicitly set.
   *
   * - `'premium'`  — Anthropic if ANTHROPIC_API_KEY present, else OpenAI
   * - `'standard'` — DeepSeek if DEEPSEEK_API_KEY present, else OpenAI (default)
   * - `'instant'`  — DeepSeek if DEEPSEEK_API_KEY present, else OpenAI
   *
   * Ignored when `provider` is given explicitly.
   */
  tier?: 'premium' | 'standard' | 'instant';
  model?: string;
  /**
   * Optional JSON Schema for Anthropic structured outputs (beta).
   *
   * @remarks
   * When supplied, the Anthropic request gains:
   * - Header: `anthropic-beta: structured-outputs-2025-11-13`
   * - Body: `output_schema: { type: 'json_schema', schema: responseSchema }`
   *
   * **Incompatible with the Anthropic Citations API** (the server returns 400
   * if both are enabled on the same request). Pick one per call.
   */
  responseSchema?: Record<string, unknown>;
  /**
   * Optional source documents for Anthropic Citations API.
   *
   * @remarks
   * When supplied (and `responseSchema` is NOT set — the two are mutually
   * exclusive), each document is sent with `citations: { enabled: true }` so
   * Claude returns grounded answers with verbatim quotes + char/page/block
   * index ranges. Returned citations are surfaced on
   * {@link ExternalLLMResult.citations}.
   *
   * Source kinds:
   * - `text` — plain UTF-8; citations carry `start_char_index`/`end_char_index`
   * - `pdf` — base64-encoded PDF; citations carry `start_page_number`/`end_page_number`
   * - `custom` — array of `{type:'text',text}` blocks; citations carry block indices
   *
   * @see https://docs.anthropic.com/en/docs/build-with-claude/citations
   */
  documents?: Array<{
    title?: string;
    kind: 'text' | 'pdf' | 'custom';
    /** UTF-8 text for `text`; base64 for `pdf`; ignored for `custom`. */
    data?: string;
    /** For `custom` kind only — array of text content blocks. */
    blocks?: Array<{ type: 'text'; text: string }>;
  }>;
  /** @see {@link TraceContext} */
  traceContext?: TraceContext;
}

export interface ExternalLLMResult {
  output: string;
  model_used: string;
  provider: 'openai' | 'anthropic' | 'deepseek';
  latency_ms: number;
  token_count: number;
  cost_estimate: number;
  /**
   * Parsed Anthropic citations (when `documents` was passed + Anthropic was the
   * resolved provider). Empty array otherwise.
   */
  citations?: AnthropicCitation[];
  /**
   * True when the Anthropic response reported `usage.cache_read_input_tokens > 0`,
   * indicating the prompt-cache prefix was reused.
   */
  cache_hit?: boolean;
}

/**
 * Cost per 1M tokens (input/output) for current default models.
 *
 * EVERY `DEFAULT_MODELS` entry MUST have a cost row here — a missing row makes
 * `estimateCostPrecise` silently return $0, undercounting the highest-volume
 * providers in LLM Observability. Guarded by `external_llm.test.ts`.
 */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
};

/** Default model IDs per provider — used when caller does not pass `model`. */
const DEFAULT_MODELS: Record<'openai' | 'anthropic' | 'deepseek', string> = {
  openai: 'gpt-4o-2024-11-20',
  anthropic: 'claude-fable-5',
  deepseek: 'deepseek-chat',
};

/** Exported for unit tests. */
export const DEFAULT_MODELS_EXPORT: Record<'openai' | 'anthropic' | 'deepseek', string> =
  DEFAULT_MODELS;

// ─── AI Gateway Helper ──────────────────────────────────────────────────────

/**
 * Resolve the base URL for a provider, routing through Cloudflare AI Gateway
 * by default (whenever `CF_ACCOUNT_ID` is set and `AI_GATEWAY_ENABLED !== "false"`).
 *
 * @deprecated Thin back-compat shim — delegates to
 * {@link services/ai_gateway.gatewayBaseUrl}. Prefer importing from `ai_gateway.ts`.
 *
 * @returns `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}/{provider}`
 * for gateway mode, else the direct vendor base URL.
 */
export function aiGatewayUrl(env: Env, provider: 'openai' | 'anthropic'): string {
  return gatewayBaseUrl(env, provider);
}

/**
 * Run a fetch through the AI Gateway with cache + metadata headers and a
 * single direct-vendor fallback on gateway 5xx.
 *
 * Caller supplies `pathSuffix` (the part after the provider base, e.g.
 * `/v1/chat/completions` for OpenAI or `/v1/messages` for Anthropic).
 *
 * @returns Tuple of `[response, gatewayUsed]` — `gatewayUsed` is `true` when
 * the successful response came through the AI Gateway, `false` when it came
 * from the direct vendor URL (gateway inactive OR 5xx fallback).
 */
async function fetchWithGatewayFallback(
  env: Env,
  provider: 'openai' | 'anthropic' | 'deepseek',
  pathSuffix: string,
  init: RequestInit,
  gatewayOptions: GatewayCallOptions = {},
): Promise<[Response, boolean]> {
  const { response, gatewayUsed } = await gatewayFetch(
    env,
    provider,
    pathSuffix,
    init,
    gatewayOptions,
  );
  return [response, gatewayUsed];
}

/**
 * Decide the cache TTL + skip-cache for a call.
 *
 * @remarks
 * Temperature ≥ 0.5 means the caller WANTS variation, so a cached identical
 * response would defeat the purpose — skip. Otherwise cache for the default TTL.
 */
function cacheOptionsFor(
  options: ExternalLLMOptions,
): Pick<GatewayCallOptions, 'cacheTtl' | 'skipCache'> {
  const temperature = options.temperature ?? 0.3;
  return temperature >= 0.5 ? { skipCache: true } : { cacheTtl: 3600 };
}

// ─── Circuit Breaker State ──────────────────────────────────────────────────

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  openUntil: number;
}

/** Circuit breaker: 5 failures in 60s → skip provider for 30s */
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_FAILURE_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_DURATION_MS = 30_000;

const circuitState: Record<string, CircuitBreakerState> = {
  openai: { failures: 0, lastFailureTime: 0, openUntil: 0 },
  anthropic: { failures: 0, lastFailureTime: 0, openUntil: 0 },
  deepseek: { failures: 0, lastFailureTime: 0, openUntil: 0 },
};

function isCircuitOpen(provider: 'openai' | 'anthropic' | 'deepseek'): boolean {
  const state = circuitState[provider];
  if (Date.now() < state.openUntil) {
    return true;
  }
  // Reset if the open period has passed
  if (state.openUntil > 0 && Date.now() >= state.openUntil) {
    state.failures = 0;
    state.openUntil = 0;
  }
  return false;
}

function recordFailure(provider: 'openai' | 'anthropic' | 'deepseek'): void {
  const state = circuitState[provider];
  const now = Date.now();

  // Reset counter if last failure was outside the window
  if (now - state.lastFailureTime > CIRCUIT_FAILURE_WINDOW_MS) {
    state.failures = 0;
  }

  state.failures++;
  state.lastFailureTime = now;

  if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = now + CIRCUIT_OPEN_DURATION_MS;
    llmLog.warn('circuit_open', { provider, count: state.failures });
  }
}

function recordSuccess(provider: 'openai' | 'anthropic' | 'deepseek'): void {
  const state = circuitState[provider];
  state.failures = 0;
  state.openUntil = 0;
}

// ─── Provider Selection ─────────────────────────────────────────────────────

/**
 * Choose provider for a given cost tier.
 *
 * PREMIUM ladder: Fable 5 → OpenAI → Kimi K3 → DeepSeek. Each rung is key-gated
 * and skipped when absent — Fable + Kimi currently carry no credits, so premium
 * serves OpenAI today and falls through the ladder automatically when their keys
 * land. `standard`/`instant`: DeepSeek first (the volume generator), OpenAI
 * fallback, Anthropic last resort.
 *
 * @remarks Vision calls MUST NOT use this; pass `provider:'openai'` explicitly
 * to `callExternalLLMWithVision` — DeepSeek has no vision API.
 */
export function chooseProviderForTier(
  env: Env,
  tier: 'premium' | 'standard' | 'instant',
): 'fable' | 'openai' | 'kimi' | 'anthropic' | 'deepseek' {
  if (tier === 'premium') {
    if (env.FABLE_API_KEY) return 'fable';
    if (env.OPENAI_API_KEY) return 'openai';
    if (env.KIMI_API_KEY) return 'kimi';
    if (env.DEEPSEEK_API_KEY) return 'deepseek';
    return 'openai';
  }
  if (env.DEEPSEEK_API_KEY) return 'deepseek';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'openai';
}

/**
 * Choose provider. GPT-4o is ALWAYS primary for research/vision; Anthropic is
 * the fallback. Explicit preference overrides this. When `tier` is supplied and
 * no explicit provider is given, delegates to {@link chooseProviderForTier}.
 */
function chooseProvider(
  env: Env,
  preference?: 'openai' | 'anthropic' | 'deepseek' | 'auto',
  tier?: 'premium' | 'standard' | 'instant',
): 'fable' | 'openai' | 'kimi' | 'anthropic' | 'deepseek' {
  if (preference === 'openai') return 'openai';
  if (preference === 'anthropic') return 'anthropic';
  if (preference === 'deepseek') return 'deepseek';

  if (tier) {
    return chooseProviderForTier(env, tier);
  }

  const hasOpenAI = !!env.OPENAI_API_KEY;
  const hasAnthropic = !!env.ANTHROPIC_API_KEY;

  if (hasOpenAI) return 'openai';
  if (hasAnthropic) return 'anthropic';

  // Neither available — return openai so the error is clear
  return 'openai';
}

// ─── Provider Calls ─────────────────────────────────────────────────────────

/**
 * Call OpenAI Chat Completions API. Routes through the AI Gateway when enabled;
 * falls back to direct vendor URL once on 5xx.
 *
 * @returns Text + token detail + `gatewayUsed` so the orchestrator can flag the
 * call in PostHog LLM Observability.
 */
async function callOpenAI(
  env: Env,
  apiKey: string,
  model: string,
  options: ExternalLLMOptions,
  messages?: Array<Record<string, unknown>>,
  // DeepSeek is OpenAI-wire-compatible (`/v1/chat/completions`) — same call path,
  // only the base URL differs. Passing the real provider routes the fetch to the
  // DeepSeek base URL via the gateway map, instead of POSTing a DeepSeek key to
  // OpenAI (→ 401) and silently falling back to premium OpenAI.
  provider: 'openai' | 'deepseek' = 'openai',
): Promise<{
  text: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  gatewayUsed: boolean;
}> {
  const body: Record<string, unknown> = {
    model,
    messages: messages ?? [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
    temperature: options.temperature ?? 0.3,
    max_completion_tokens: options.maxTokens ?? 8192,
  };

  if (options.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: options.jsonSchema.name,
        schema: options.jsonSchema.schema,
        strict: true,
      },
    };
  } else if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 240_000);

  let res: Response;
  let gatewayUsed = false;
  try {
    [res, gatewayUsed] = await fetchWithGatewayFallback(
      env,
      provider,
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      { ...cacheOptionsFor(options), metadata: gatewayMetadata(options.traceContext) },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${provider === 'deepseek' ? 'DeepSeek' : 'OpenAI'} API error ${res.status}: ${text}`,
    );
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number; prompt_tokens?: number; completion_tokens?: number };
  };

  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  return {
    text: data.choices[0]?.message?.content ?? '',
    tokens: data.usage?.total_tokens ?? inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    gatewayUsed,
  };
}

/**
 * Shape of a single Anthropic response content block — `text` blocks may carry
 * a `citations[]` array when the Citations API is enabled on the request.
 */
interface AnthropicContentBlock {
  type: string;
  text?: string;
  citations?: Array<{
    type:
      | 'char_location'
      | 'page_location'
      | 'content_block_location'
      | 'web_search_result_location';
    document_index: number;
    document_title?: string;
    cited_text: string;
    start_char_index?: number;
    end_char_index?: number;
    start_page_number?: number;
    end_page_number?: number;
    start_block_index?: number;
    end_block_index?: number;
  }>;
}

/**
 * Call Anthropic Messages API.
 *
 * - Routes through the AI Gateway when enabled; falls back to direct vendor URL once on 5xx.
 * - When `options.system.length > 1024`, sends the system as `cache_control:{type:'ephemeral'}`
 *   text blocks for prompt caching (char count is a conservative proxy for the token minimum,
 *   avoiding tokenizing the prompt on the worker).
 * - When `options.responseSchema` is set, attaches the structured-outputs beta header + `output_schema`.
 *
 * @remarks
 * **Structured outputs is incompatible with the Anthropic Citations API** —
 * setting both on the same request returns 400. Pick one per call.
 */
async function callAnthropic(
  env: Env,
  apiKey: string,
  model: string,
  options: ExternalLLMOptions,
  messages?: Array<Record<string, unknown>>,
): Promise<{
  text: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean;
  citations: AnthropicCitation[];
  gatewayUsed: boolean;
}> {
  // Plain string, or an array with cache_control when the system prompt is long
  // enough to be worth caching.
  const systemPayload: string | Array<Record<string, unknown>> =
    options.system.length > 1024
      ? [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }]
      : options.system;

  // Documents fold into the first user message as `document` blocks per the
  // Citations API. Mutually exclusive with `responseSchema` (server 400s if both set).
  const hasDocuments = !!options.documents?.length && !options.responseSchema;

  let resolvedMessages: Array<Record<string, unknown>>;
  if (messages) {
    resolvedMessages = messages;
  } else if (hasDocuments) {
    const documents = options.documents ?? [];
    const documentBlocks = documents.map((doc) => {
      const base: Record<string, unknown> = {
        type: 'document',
        citations: { enabled: true },
        title: doc.title,
      };
      if (doc.kind === 'text') {
        base.source = { type: 'text', media_type: 'text/plain', data: doc.data ?? '' };
      } else if (doc.kind === 'pdf') {
        base.source = { type: 'base64', media_type: 'application/pdf', data: doc.data ?? '' };
      } else {
        base.source = { type: 'content', content: doc.blocks ?? [] };
      }
      return base;
    });
    resolvedMessages = [
      {
        role: 'user',
        content: [...documentBlocks, { type: 'text', text: options.user }],
      },
    ];
  } else {
    resolvedMessages = [{ role: 'user', content: options.user }];
  }

  const body: Record<string, unknown> = {
    model,
    system: systemPayload,
    messages: resolvedMessages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 8192,
  };

  if (options.responseSchema) {
    body.output_schema = { type: 'json_schema', schema: options.responseSchema };
  }

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };
  if (options.responseSchema) {
    headers['anthropic-beta'] = 'structured-outputs-2025-11-13';
  }

  // 8-minute timeout for Claude Opus large generation calls (32K tokens can take 2-4 min)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 480_000);

  let res: Response;
  let gatewayUsed = false;
  try {
    [res, gatewayUsed] = await fetchWithGatewayFallback(
      env,
      'anthropic',
      '/v1/messages',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      { ...cacheOptionsFor(options), metadata: gatewayMetadata(options.traceContext) },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    content: AnthropicContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const tokens = inputTokens + outputTokens;
  const cacheHit = (data.usage?.cache_read_input_tokens ?? 0) > 0;

  // One entry per cited span; downstream consumers group by document_index to
  // reconstruct per-source reference lists.
  const citations: AnthropicCitation[] = [];
  for (const block of data.content) {
    if (!block.citations) continue;
    for (const c of block.citations) {
      citations.push({
        documentIndex: c.document_index,
        documentTitle: c.document_title,
        citedText: c.cited_text,
        startCharIndex: c.start_char_index,
        endCharIndex: c.end_char_index,
        startPageNumber: c.start_page_number,
        endPageNumber: c.end_page_number,
        startBlockIndex: c.start_block_index,
        endBlockIndex: c.end_block_index,
      });
    }
  }

  return { text, tokens, inputTokens, outputTokens, cacheHit, citations, gatewayUsed };
}

// ─── Cost Estimation ────────────────────────────────────────────────────────

/**
 * Estimate cost in USD when exact input/output token counts are available.
 *
 * @example
 * ```ts
 * const cost = estimateCostPrecise('claude-sonnet-4-6', 1500, 600); // → ~$0.0135
 * ```
 */
export function estimateCostPrecise(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Match the LONGEST (most specific) key the model name contains. `find`-first was
  // order-dependent: 'gpt-4o-mini' contains 'gpt-4o', so a 'gpt-4o' key listed first
  // shadowed the mini entry → mini was priced 16× too high ($2.50 vs $0.15 input).
  // Longest-match makes the most-specific row win regardless of table order.
  const key = Object.keys(MODEL_COSTS)
    .filter((k) => model.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return 0;
  const costs = MODEL_COSTS[key];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

/**
 * Resolve the PostHog distinctId for a trace context.
 *
 * Priority: `orgId` → `userId` → `'system'`. Analytics-only — never used for
 * authorization, never logged at info level (PII surface).
 */
function resolveDistinctId(traceContext?: TraceContext): string {
  return traceContext?.orgId ?? traceContext?.userId ?? 'system';
}

/**
 * Fire-and-forget PostHog LLM Observability capture. Wrapped in try/catch so
 * analytics failures NEVER bubble into the LLM response path.
 *
 * @see {@link captureLLMCall}
 */
async function safeCaptureLLM(
  env: Env,
  params: Parameters<typeof captureLLMCall>[1],
): Promise<void> {
  try {
    await captureLLMCall(env, params);
  } catch (err) {
    llmLog.warn('analytics_capture_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Main LLM Call ──────────────────────────────────────────────────────────

/**
 * Thin bridge: meter AI token usage through StripeMetersProvider.
 *
 * Call AFTER a successful LLM response with actual token counts.
 * Never throws — metering failures log and continue (fail-soft-prod).
 */
async function meterAiTokensForCall(
  env: Env,
  options: ExternalLLMOptions,
  inputTokens: number,
  outputTokens: number,
  model: string,
): Promise<void> {
  const orgId = options.traceContext?.orgId;
  if (!orgId || (inputTokens <= 0 && outputTokens <= 0)) return;
  void meterAiTokens(env, {
    orgId,
    inputTokens,
    outputTokens,
    model,
    feature: options.traceContext?.promptId,
  });
}

/**
 * Call an external LLM (OpenAI or Anthropic) with automatic fallback.
 *
 * GPT-4o primary with retry + exponential backoff; falls back to Anthropic
 * Claude on failure. Circuit breaker skips a provider that fails 5× within 60s.
 *
 * @example
 * ```ts
 * const result = await callExternalLLM(env, {
 *   system: 'You are a web designer.',
 *   user: 'Generate a site plan for a bakery.',
 *   jsonMode: true,
 *   maxTokens: 4000,
 * });
 * ```
 */
export async function callExternalLLM(
  env: Env,
  options: ExternalLLMOptions,
): Promise<ExternalLLMResult> {
  const primary = chooseProvider(env, options.provider, options.tier);
  // Fallback is always a non-ladder standard vendor (openai/anthropic/deepseek).
  const fallback: 'openai' | 'anthropic' | 'deepseek' =
    primary === 'openai'
      ? 'anthropic'
      : primary === 'anthropic'
        ? 'openai'
        : primary === 'deepseek'
          ? 'openai'
          : 'openai';

  const providers: Array<'openai' | 'anthropic' | 'deepseek'> = [
    primary === 'fable' || primary === 'kimi' ? 'openai' : primary,
    fallback,
  ];

  const distinctId = resolveDistinctId(options.traceContext);
  const traceId = options.traceContext?.traceId;
  const promptId = options.traceContext?.promptId;

  for (const provider of providers) {
    // The caller's explicit `options.model` belongs to the PRIMARY provider only.
    // When the loop falls back to a DIFFERENT provider, sending a cross-vendor model
    // name (e.g. a `claude-*` model to OpenAI) 404s — so the fallback provider uses
    // its OWN default model. Root cause of the auto-pilot preview + cron 502:
    // provider:'anthropic' + model:'claude-sonnet-4-6' fell back to OpenAI, which
    // 404'd "model `claude-sonnet-4-6` does not exist".
    const model =
      provider === primary ? (options.model ?? DEFAULT_MODELS[provider]) : DEFAULT_MODELS[provider];

    if (isCircuitOpen(provider)) {
      llmLog.info('circuit_open_skip', { provider });
      void safeCaptureLLM(env, {
        distinctId,
        provider,
        model,
        promptId,
        latencyMs: 0,
        status: 'circuit_open',
        traceId,
      });
      continue;
    }

    const apiKey =
      provider === 'openai'
        ? env.OPENAI_API_KEY
        : provider === 'deepseek'
          ? env.DEEPSEEK_API_KEY
          : (env.ANTHROPIC_API_KEY as string | undefined);

    if (!apiKey) continue;

    const start = Date.now();

    try {
      const result = await withRetry(
        () =>
          provider === 'openai' || provider === 'deepseek'
            ? callOpenAI(env, apiKey, model, options, undefined, provider)
            : callAnthropic(env, apiKey, model, options),
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          onRetry: (attempt, err, _delayMs) => {
            llmLog.warn('retry', {
              provider,
              model,
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const latency = Date.now() - start;
      recordSuccess(provider);

      // Result shape diverges between providers — only Anthropic carries
      // `cacheHit` + `citations` + `inputTokens`/`outputTokens`/`gatewayUsed`.
      // Loose cast for the extended fields rather than threading a discriminated
      // union through every callsite.
      const r = result as Record<string, unknown> & { text: string; tokens: number };
      const cacheHit = Boolean(r.cacheHit);
      const citations = (Array.isArray(r.citations) ? r.citations : []) as AnthropicCitation[];
      const inputTokens = typeof r.inputTokens === 'number' ? r.inputTokens : 0;
      const outputTokens = typeof r.outputTokens === 'number' ? r.outputTokens : 0;
      const gatewayUsed = Boolean(r.gatewayUsed);
      const costUsd = estimateCostPrecise(model, inputTokens, outputTokens);

      llmLog.info('call_success', { provider, model, durationMs: latency, count: result.tokens });

      void safeCaptureLLM(env, {
        distinctId,
        provider,
        model,
        promptId,
        inputTokens,
        outputTokens,
        latencyMs: latency,
        costUsd,
        status: 'ok',
        traceId,
        cacheHit,
        gatewayUsed,
      });

      void meterAiTokensForCall(env, options, inputTokens, outputTokens, model);

      return {
        output: result.text,
        model_used: model,
        provider,
        latency_ms: latency,
        token_count: result.tokens,
        cost_estimate: costUsd,
        citations,
        cache_hit: cacheHit,
      };
    } catch (err) {
      const latency = Date.now() - start;
      const errorCategory = classifyError(err);
      recordFailure(provider);

      llmLog.warn('provider_exhausted', {
        provider,
        model,
        durationMs: latency,
        error: err instanceof Error ? err.message : String(err),
      });

      void safeCaptureLLM(env, {
        distinctId,
        provider,
        model,
        promptId,
        latencyMs: latency,
        status: errorCategory === 'timeout' ? 'timeout' : 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        traceId,
      });

      // If this is the fallback too, rethrow
      if (provider === fallback) throw err;
    }
  }

  throw new Error('No LLM provider available — set OPENAI_API_KEY or ANTHROPIC_API_KEY');
}

// ─── Vision Call ────────────────────────────────────────────────────────────

/**
 * Call an external LLM with vision capability (image analysis).
 *
 * GPT-4o vision primary, falls back to Anthropic Claude vision. Accepts either
 * an image URL or base64-encoded image data.
 *
 * @example
 * ```ts
 * const result = await callExternalLLMWithVision(env, {
 *   system: 'You are a visual brand analyst.',
 *   user: 'Describe the brand colors and logo in this screenshot.',
 *   imageUrl: 'https://example.com/screenshot.png',
 *   maxTokens: 2000,
 * });
 * ```
 */
export async function callExternalLLMWithVision(
  env: Env,
  options: ExternalLLMOptions & { imageUrl?: string; imageBase64?: string },
): Promise<ExternalLLMResult> {
  if (!options.imageUrl && !options.imageBase64) {
    // No image provided, fall back to standard text call
    return callExternalLLM(env, options);
  }

  // Vision calls must never use DeepSeek — it has no vision API. Cast to narrow
  // union; vision callers always pass provider 'openai'|'anthropic'|undefined so
  // chooseProvider won't resolve to 'deepseek' here.
  const primary = chooseProvider(env, options.provider) as 'openai' | 'anthropic';
  const fallback: 'openai' | 'anthropic' = primary === 'openai' ? 'anthropic' : 'openai';

  const providers: Array<'openai' | 'anthropic'> = [primary, fallback];

  const distinctId = resolveDistinctId(options.traceContext);
  const traceId = options.traceContext?.traceId;
  const promptId = options.traceContext?.promptId;

  for (const provider of providers) {
    // Same provider-scoped model rule as callExternalLLM: the explicit model belongs
    // to the primary provider; a fallback to the other vendor uses its own default
    // (a cross-vendor model name 404s).
    const model =
      provider === primary ? (options.model ?? DEFAULT_MODELS[provider]) : DEFAULT_MODELS[provider];

    if (isCircuitOpen(provider)) {
      llmLog.info('circuit_open_skip_vision', { provider });
      void safeCaptureLLM(env, {
        distinctId,
        provider,
        model,
        promptId,
        latencyMs: 0,
        status: 'circuit_open',
        traceId,
      });
      continue;
    }

    const apiKey =
      provider === 'openai' ? env.OPENAI_API_KEY : (env.ANTHROPIC_API_KEY as string | undefined);

    if (!apiKey) continue;

    const start = Date.now();

    try {
      const result = await withRetry(
        () => {
          if (provider === 'openai') {
            return callOpenAIWithVision(env, apiKey, model, options);
          }
          return callAnthropicWithVision(env, apiKey, model, options);
        },
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          onRetry: (attempt, err, _delayMs) => {
            llmLog.warn('retry_vision', {
              provider,
              model,
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const latency = Date.now() - start;
      recordSuccess(provider);

      const r = result as Record<string, unknown> & { text: string; tokens: number };
      const cacheHit = Boolean(r.cacheHit);
      const citations = (Array.isArray(r.citations) ? r.citations : []) as AnthropicCitation[];
      const inputTokens = typeof r.inputTokens === 'number' ? r.inputTokens : 0;
      const outputTokens = typeof r.outputTokens === 'number' ? r.outputTokens : 0;
      const gatewayUsed = Boolean(r.gatewayUsed);
      const costUsd = estimateCostPrecise(model, inputTokens, outputTokens);

      llmLog.info('vision_call_success', {
        provider,
        model,
        durationMs: latency,
        count: result.tokens,
      });

      void safeCaptureLLM(env, {
        distinctId,
        provider,
        model,
        promptId: promptId ? `${promptId}:vision` : 'vision',
        inputTokens,
        outputTokens,
        latencyMs: latency,
        costUsd,
        status: 'ok',
        traceId,
        cacheHit,
        gatewayUsed,
      });

      return {
        output: result.text,
        model_used: model,
        provider,
        latency_ms: latency,
        token_count: result.tokens,
        cost_estimate: costUsd,
        citations,
        cache_hit: cacheHit,
      };
    } catch (err) {
      const latency = Date.now() - start;
      const errorCategory = classifyError(err);
      recordFailure(provider);

      llmLog.warn('vision_provider_exhausted', {
        provider,
        model,
        durationMs: latency,
        error: err instanceof Error ? err.message : String(err),
      });

      void safeCaptureLLM(env, {
        distinctId,
        provider,
        model,
        promptId: promptId ? `${promptId}:vision` : 'vision',
        latencyMs: latency,
        status: errorCategory === 'timeout' ? 'timeout' : 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        traceId,
      });

      if (provider === fallback) throw err;
    }
  }

  throw new Error('No LLM vision provider available — set OPENAI_API_KEY or ANTHROPIC_API_KEY');
}

// ─── Vision Provider Implementations ────────────────────────────────────────

async function callOpenAIWithVision(
  env: Env,
  apiKey: string,
  model: string,
  options: ExternalLLMOptions & { imageUrl?: string; imageBase64?: string },
): Promise<{ text: string; tokens: number }> {
  const imageContent: Record<string, unknown> = options.imageUrl
    ? { type: 'image_url', image_url: { url: options.imageUrl, detail: 'high' } }
    : {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${options.imageBase64}`, detail: 'high' },
      };

  const messages = [
    { role: 'system', content: options.system },
    {
      role: 'user',
      content: [{ type: 'text', text: options.user }, imageContent],
    },
  ];

  return callOpenAI(env, apiKey, model, options, messages);
}

async function callAnthropicWithVision(
  env: Env,
  apiKey: string,
  model: string,
  options: ExternalLLMOptions & { imageUrl?: string; imageBase64?: string },
): Promise<{ text: string; tokens: number }> {
  // Anthropic requires base64 for images; if we only have a URL, fetch it.
  let base64Data = options.imageBase64;
  let mediaType = 'image/png';

  if (!base64Data && options.imageUrl) {
    // Bound the image fetch with the same AbortController pattern every LLM call in this file
    // uses (callOpenAI/callAnthropic) — a bare fetch() has no timeout on Workers, so a slow or
    // unresponsive image host (dead CDN, stalled signed-URL proxy) would hang the whole vision
    // call INDEFINITELY. withRetry only bounds retry COUNT, not per-attempt duration, so the hang
    // is never caught — it stalls until the platform wall-clock kills the isolate, breaking the
    // fail-soft contract the rest of this file upholds. 30s is generous for an image download.
    const imgController = new AbortController();
    const imgTimeout = setTimeout(() => imgController.abort(), 30_000);
    let imgRes: Response;
    try {
      imgRes = await fetch(options.imageUrl, { signal: imgController.signal });
    } finally {
      clearTimeout(imgTimeout);
    }
    if (!imgRes.ok) {
      throw new Error(`Failed to fetch image for Anthropic vision: ${imgRes.status}`);
    }
    const contentType = imgRes.headers.get('content-type') ?? 'image/png';
    mediaType = contentType.split(';')[0].trim();
    const buffer = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64Data = btoa(binary);
  }

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        },
        { type: 'text', text: options.user },
      ],
    },
  ];

  return callAnthropic(env, apiKey, model, options, messages);
}

// ─── OpenAI Files API ───────────────────────────────────────────────────────

/**
 * Upload a document to the OpenAI Files API for downstream use with Assistants,
 * the Responses API file-search tool, or batch jobs.
 *
 * @remarks
 * - Endpoint: `POST https://api.openai.com/v1/files` (multipart/form-data)
 * - `purpose: 'assistants'` is the broadest grant; switch to `'batch'` or
 *   `'fine-tune'` for those specific call paths.
 * - Files persist on OpenAI infrastructure until deleted via
 *   `DELETE /v1/files/{file_id}` — call site is responsible for lifecycle.
 * - Unwired by design (no caller in this turn) — reserved for future
 *   Anthropic-Files / OpenAI Assistants research flows where the uploaded
 *   document_id is the source for a Citations or file-search call.
 *
 * @throws Error when `OPENAI_API_KEY` is missing or the upload fails (non-2xx).
 *
 * @example
 * ```ts
 * const bytes = await (await fetch(pdfUrl)).arrayBuffer();
 * const fileId = await uploadDocToOpenAI(env, {
 *   name: 'njsk-2024-annual-report.pdf',
 *   bytes,
 *   mime: 'application/pdf',
 * });
 * // → 'file_abc123'
 * ```
 *
 * @see https://platform.openai.com/docs/api-reference/files/create
 */
export async function uploadDocToOpenAI(
  env: Env,
  file: { name: string; bytes: ArrayBuffer | Uint8Array; mime: string },
): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('uploadDocToOpenAI: OPENAI_API_KEY is not configured');
  }

  // @cloudflare/workers-types declares Blob's ctor param as
  // `((ArrayBuffer | ArrayBufferView) | string | Blob)[]` — there is NO
  // BlobPart name in this lib. TS 5.9's Uint8Array<ArrayBufferLike> isn't
  // assignable to ArrayBufferView<ArrayBuffer>, so cast to the param union
  // (file.bytes is a concrete ArrayBuffer/Uint8Array here — safe + version-robust).
  const blob = new Blob([file.bytes as ArrayBuffer | ArrayBufferView], { type: file.mime });
  const formData = new FormData();
  formData.append('purpose', 'assistants');
  formData.append('file', blob, file.name);

  const { response: res } = await gatewayFetch(env, 'openai', '/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Files API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}
