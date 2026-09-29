# model_registry

Declarative ProviderCapabilityRegistry + ModelAliasRegistry for the projectsites.dev AI router, plus the four virtual service models. Establishes the platform's OpenAI-compatible AI provider identity (campaign lane-4 §7 — acceptance: `e2e/ai-api/openai-compat.e2e.ts`).

## What it does

- Declares 8 AI providers (deepseek, anthropic, openai, gemini, grok, workers-ai, litellm, ollama) with tier, capabilities, and required env keys.
- Declares 13 model aliases (edge-fast, edge-smart, deepseek-fast, deepseek-code, deepseek-claude-code, premium-quorum, claude-architect, openai-polish, gemini-grounded, grok-live-business, grok-local-seo, grok-dispute-verifier, ollama-local-dev) with provider routing lists and capability booleans.
- Declares 4 **virtual service models** — `projectsites-auto`, `projectsites-fast`, `projectsites-balanced`, `projectsites-premium` — routing intents the platform always serves (`created` = fixed epoch `1790640000`, `_tier:"service"`, `_available:true`).
- Surfaces everything via `GET /v1/models` (list) and `GET /v1/models/:id` (lookup) in OpenAI-compatible format.

## Flag key

`model_registry` — `enabled=1, rollout=100, stage=beta` (beta 2026-09-29, enabled via the registry default like the other live flags).

When the flag is off both endpoints return a dark `404 NOT_FOUND` — before auth, so nothing leaks.

## Endpoints

`GET /v1/models` · `GET /v1/models/:id` — **Bearer `psk_` API token required** (`extractBearerToken` + `verifyApiToken`, the platform public-API pattern). Missing/invalid key → `401` in the OpenAI error envelope:

```json
{ "error": { "message": "Missing or invalid API key. …", "type": "invalid_request_error", "param": null, "code": "invalid_api_key" } }
```

List response shape (virtual models first, then the 13 aliases — 17 entries total):

```json
{
  "object": "list",
  "data": [
    {
      "id": "projectsites-auto",
      "object": "model",
      "created": 1790640000,
      "owned_by": "projectsites",
      "_tier": "service",
      "_providers": [],
      "_available": true
    },
    {
      "id": "edge-fast",
      "object": "model",
      "created": 0,
      "owned_by": "projectsites",
      "_tier": "edge",
      "_providers": ["workers-ai"],
      "_capabilities": { "chat": true, "vision": true, "embeddings": false, "tools": false, "streaming": true },
      "_available": true
    }
  ]
}
```

`GET /v1/models/:id` returns the single entry (200) for any virtual id or alias; unknown ids get the OpenAI `model_not_found` shape:

```json
{ "error": { "message": "The model 'x' does not exist or you do not have access to it.", "type": "invalid_request_error", "param": "model", "code": "model_not_found" } }
```

Alias `_available` is `true` when at least one of the alias's providers has its required env key(s) set. All aliases are always returned (discoverability); consumers filter on `_available`. Virtual models are always available.

## Safe disabled behavior

When flag is off, both routes return dark `404`. No DB reads beyond the flag check; auth (one `api_tokens` lookup) runs only when the flag is on.

## Mount line

```ts
// in src/index.ts
import { modelRegistry } from '../libs/features/model_registry/handlers.js';
app.route('/', modelRegistry);
```

## Flag registry entry

Lives in `src/modules/feature_flags/registry.ts` under `model_registry` — `default_enabled: true, default_rollout_percent: 100, stage: 'beta'` (see that file for the full runbook description; killswitch stage reverts everything to dark 404 without a redeploy).
