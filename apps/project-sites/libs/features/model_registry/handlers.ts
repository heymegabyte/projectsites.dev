/**
 * @module libs/features/model_registry/handlers
 * @description Hono route handlers for the model-registry feature.
 * Exposes an OpenAI-compatible GET /v1/models catalog (13 registry aliases +
 * the 4 virtual service models) and a GET /v1/models/:id lookup.
 *
 * | Method | Path           | Auth                                          |
 * | ------ | -------------- | --------------------------------------------- |
 * | GET    | /v1/models     | Bearer psk_ API token (401 OpenAI error else) |
 * | GET    | /v1/models/:id | Bearer psk_ API token (401 OpenAI error else) |
 *
 * Flag-gated: returns 404 (never 403) when the `model_registry` flag is off —
 * the dark gate runs BEFORE auth so an off flag never leaks auth semantics.
 * Contract: e2e/ai-api/openai-compat.e2e.ts (campaign lane-4, §7).
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { verifyApiToken, extractBearerToken } from '../../../src/services/api_tokens.js';
import {
  FLAG_KEY,
  MODEL_ALIASES,
  PROVIDERS,
  VIRTUAL_MODEL_CREATED,
  VIRTUAL_SERVICE_MODELS,
  aliasAvailable,
  findModelAlias,
  findVirtualModel,
  type ModelAliasRecord,
} from './service.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const modelRegistry = new Hono<AppContext>();

/** Dark 404 — same envelope the rest of the platform uses for flag-off routes. */
function darkNotFound(c: Context<AppContext>) {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } }, 404);
}

/**
 * Enforce Bearer psk_ auth per the platform public-API pattern
 * (`extractBearerToken` + `verifyApiToken`, as platform_mcp does).
 *
 * @returns null when the caller holds a valid token; otherwise the 401
 *          response in the OpenAI error envelope `{error:{message,type,code}}`.
 */
async function requireApiKey(c: Context<AppContext>): Promise<Response | null> {
  const plaintext = extractBearerToken(c.req.header('authorization') ?? null);
  const token = plaintext ? await verifyApiToken(c.env.DB, plaintext) : null;
  if (token) return null;
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
});
