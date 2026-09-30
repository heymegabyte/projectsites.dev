/**
 * @module libs/features/model_registry/handlers
 * @description Hono route handlers for the model-registry feature.
 * Exposes an OpenAI-compatible GET /v1/models catalog (13 registry aliases +
 * the 4 virtual service models), a GET /v1/models/:id lookup, and the
 * NON-STREAMED POST /v1/chat/completions endpoint (virtual-model routing via
 * services/external_llm).
 *
 * | Method | Path                 | Auth                                          |
 * | ------ | -------------------- | --------------------------------------------- |
 * | GET    | /v1/models           | Bearer psk_ API token (401 OpenAI error else) |
 * | GET    | /v1/models/:id       | Bearer psk_ API token (401 OpenAI error else) |
 * | POST   | /v1/chat/completions | Bearer psk_ API token (401 OpenAI error else) |
 *
 * Flag-gated: returns 404 (never 403) when the `model_registry` flag is off —
 * the dark gate runs BEFORE auth so an off flag never leaks auth semantics.
 * Contract: e2e/ai-api/openai-compat.e2e.ts (campaign lane-4, §7 + fire-57).
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { verifyApiToken, extractBearerToken } from '../../../src/services/api_tokens.js';
import { callExternalLLM } from '../../../src/services/external_llm.js';
import { ChatCompletionRequestSchema, type ChatMessage } from './schemas.js';
import {
  FLAG_KEY,
  MODEL_ALIASES,
  PROVIDERS,
  VIRTUAL_MODEL_CREATED,
  VIRTUAL_SERVICE_MODELS,
  aliasAvailable,
  findModelAlias,
  findVirtualModel,
  resolveChatRoute,
  type ModelAliasRecord,
} from './service.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const modelRegistry = new Hono<AppContext>();

/** Dark 404 — same envelope the rest of the platform uses for flag-off routes. */
function darkNotFound(c: Context<AppContext>) {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } }, 404);
}

/**
 * Resolve the caller's verified API token (Bearer psk_ per the platform
 * public-API pattern: `extractBearerToken` + `verifyApiToken`).
 *
 * @returns The verified token record (carries `org_id` for tracing/metering),
 *          or null when the header is missing/malformed/revoked.
 */
async function authenticateApiKey(
  c: Context<AppContext>,
): Promise<Awaited<ReturnType<typeof verifyApiToken>>> {
  const plaintext = extractBearerToken(c.req.header('authorization') ?? null);
  return plaintext ? await verifyApiToken(c.env.DB, plaintext) : null;
}

/** The OpenAI 401 error envelope `{error:{message,type,param,code}}`. */
function invalidApiKey(c: Context<AppContext>): Response {
  return c.json(
    {
      error: {
        message:
          'Missing or invalid API key. Pass a projectsites API token as "Authorization: Bearer psk_…" (create one under Admin → API Tokens).',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    },
    401,
  );
}

/**
 * Enforce Bearer psk_ auth for routes that don't need the token record.
 *
 * @returns null when the caller holds a valid token; otherwise the 401
 *          response in the OpenAI error envelope `{error:{message,type,code}}`.
 */
async function requireApiKey(c: Context<AppContext>): Promise<Response | null> {
  const token = await authenticateApiKey(c);
  return token ? null : invalidApiKey(c);
}

/** Serialize a registry alias into an OpenAI model entry (+ our `_` metadata). */
function aliasEntry(env: Env, alias: ModelAliasRecord) {
  // Resolve the _tier from the alias's first provider.
  const firstProvider = PROVIDERS.find((p) => p.id === alias.providers[0]);
  return {
    id: alias.id,
    object: 'model' as const,
    created: 0 as const,
    owned_by: 'projectsites' as const,
    _tier: firstProvider?.tier ?? 'unknown',
    _providers: alias.providers,
    _capabilities: alias.capabilities,
    _available: aliasAvailable(env, alias),
  };
}

/** Serialize a virtual service model into an OpenAI model entry. */
function virtualEntry(id: string, description: string) {
  return {
    id,
    object: 'model' as const,
    created: VIRTUAL_MODEL_CREATED,
    owned_by: 'projectsites' as const,
    _tier: 'service' as const,
    _providers: [] as string[],
    _description: description,
    // Virtual models are routing intents the platform always serves.
    _available: true as const,
  };
}

/**
 * GET /v1/models
 *
 * Returns an OpenAI-compatible list of the 4 virtual service models followed
 * by all 13 registered aliases. Alias `_available` reflects whether at least
 * one of its providers has env keys configured; virtual models are always
 * available.
 *
 * @returns OpenAI list response `{ object: 'list', data: [...] }`.
 * @throws 404 when the `model_registry` flag is off; 401 without a valid psk_ token.
 *
 * @example
 * // curl -H "Authorization: Bearer psk_…" https://projectsites.dev/v1/models
 * // { "object": "list", "data": [{ "id": "projectsites-auto", ... }, ...] }
 */
modelRegistry.get('/v1/models', async (c) => {
  // Feature flag gate — 404 (never 403) when disabled, before auth (no leak).
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) return darkNotFound(c);

  const unauthorized = await requireApiKey(c);
  if (unauthorized) return unauthorized;

  const data = [
    ...VIRTUAL_SERVICE_MODELS.map((v) => virtualEntry(v.id, v.description)),
    ...MODEL_ALIASES.map((alias) => aliasEntry(c.env, alias)),
  ];

  return c.json({ object: 'list' as const, data }, 200);
});

/**
 * GET /v1/models/:id
 *
 * OpenAI-compatible single-model lookup. Resolves virtual service models
 * first, then registry aliases; unknown ids get the OpenAI `model_not_found`
 * error envelope.
 *
 * @returns 200 with the model entry, or an OpenAI-shaped 404 for unknown ids.
 * @throws 404 (dark) when the flag is off; 401 without a valid psk_ token.
 *
 * @example
 * // curl -H "Authorization: Bearer psk_…" https://projectsites.dev/v1/models/projectsites-auto
 * // { "id": "projectsites-auto", "object": "model", "created": 1790640000, "owned_by": "projectsites" }
 */
modelRegistry.get('/v1/models/:id', async (c) => {
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) return darkNotFound(c);

  const unauthorized = await requireApiKey(c);
  if (unauthorized) return unauthorized;

  const id = c.req.param('id');

  const virtual = findVirtualModel(id);
  if (virtual) return c.json(virtualEntry(virtual.id, virtual.description), 200);

  const alias = findModelAlias(id);
  if (alias) return c.json(aliasEntry(c.env, alias), 200);

  return modelNotFound(c, id);
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions (campaign lane-4, fire-57 — NON-STREAMED)
// ---------------------------------------------------------------------------

/** OpenAI `model_not_found` 404 — the SAME envelope GET /v1/models/:id emits. */
function modelNotFound(c: Context<AppContext>, id: string): Response {
  return c.json(
    {
      error: {
        message: `The model '${id}' does not exist or you do not have access to it.`,
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    },
    404,
  );
}

/** OpenAI 400 `invalid_request_error` envelope for body/param problems. */
function invalidRequest(c: Context<AppContext>, message: string, param: string | null): Response {
  return c.json(
    { error: { message, type: 'invalid_request_error', param, code: 'invalid_request_error' } },
    400,
  );
}

/**
 * Fold an OpenAI messages array into external_llm's `{system, user}` shape.
 *
 * `system`/`developer` messages join into one system prompt; the remaining
 * conversation becomes the user payload — verbatim for a single turn,
 * role-labelled transcript for multi-turn.
 */
function foldMessages(messages: ChatMessage[]): { system: string; user: string } {
  const isSystem = (m: ChatMessage) => m.role === 'system' || m.role === 'developer';
  const system =
    messages
      .filter(isSystem)
      .map((m) => m.content)
      .join('\n\n') || 'You are a helpful assistant.';

  const turns = messages.filter((m) => !isSystem(m));
  const user =
    turns.length === 1
      ? turns[0].content
      : turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');

  return { system, user };
}

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible NON-STREAMED chat completions. Virtual service models
 * route through external_llm's cost tiers (auto→standard, fast→instant,
 * premium→premium ladder) and `projectsites-balanced` pins gpt-4o-mini-class;
 * registry aliases pin their first routable vendor (see resolveChatRoute).
 *
 * @returns 200 `{id:"chatcmpl-…", object:"chat.completion", created, model,
 *          choices:[{index,message,finish_reason}], usage}` — `model` echoes
 *          the REQUESTED id; usage total comes from the provider (split 0/0
 *          when the provider doesn't expose it).
 * @throws 404 dark (flag off) · 401 invalid_api_key · 400 invalid body /
 *         `stream_not_supported` (honest — never fake SSE) · 404
 *         model_not_found (unknown OR unroutable id) · 502 provider_error
 *         (upstream exhausted; internals never leak).
 *
 * @example
 * // curl -X POST https://projectsites.dev/v1/chat/completions \
 * //   -H "Authorization: Bearer psk_…" -H "Content-Type: application/json" \
 * //   -d '{"model":"projectsites-auto","messages":[{"role":"user","content":"Hi"}]}'
 */
modelRegistry.post('/v1/chat/completions', async (c) => {
  // Feature flag gate — 404 (never 403) when disabled, before auth (no leak).
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) return darkNotFound(c);

  const token = await authenticateApiKey(c);
  if (!token) return invalidApiKey(c);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return invalidRequest(c, 'Request body must be valid JSON.', null);
  }

  const parsed = ChatCompletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || null;
    return invalidRequest(
      c,
      `Invalid request${path ? ` (${path})` : ''}: ${issue?.message ?? 'malformed body'}`,
      path,
    );
  }
  const body = parsed.data;

  // Honest non-streaming: refuse stream:true outright — never fake SSE.
  if (body.stream === true) {
    return c.json(
      {
        error: {
          message: 'Streaming is not yet supported',
          type: 'invalid_request_error',
          code: 'stream_not_supported',
        },
      },
      400,
    );
  }

  const route = resolveChatRoute(body.model);
  if (!route) return modelNotFound(c, body.model);

  const { system, user } = foldMessages(body.messages);

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
        promptId: 'chat_completions_api',
      },
    });

    const totalTokens = Number.isFinite(result.token_count) ? result.token_count : 0;

    return c.json(
      {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        // Echo the REQUESTED id — the concrete upstream model is an internal
        // routing detail (surfaced only in tracing, never the public envelope).
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant' as const, content: result.output },
            finish_reason: 'stop' as const,
          },
        ],
        // external_llm surfaces only the provider's total; the split is
        // honestly reported as 0/0 rather than fabricated.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: totalTokens },
      },
      200,
    );
  } catch {
    // Upstream exhausted (all providers failed) — OpenAI-shaped 502, no internals.
    return c.json(
      {
        error: {
          message:
            'The upstream model provider failed to complete the request. Please try again shortly.',
          type: 'api_error',
          param: null,
          code: 'provider_error',
        },
      },
      502,
    );
  }
});
