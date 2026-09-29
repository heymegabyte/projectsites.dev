/**
 * @module libs/features/model_registry/service
 * @description Declarative ProviderCapabilityRegistry and ModelAliasRegistry.
 * Pure data + helpers — no I/O, no DB writes, no external calls.
 * Surfaced via GET /v1/models (OpenAI-compatible format).
 */

/** Feature flag key that gates this feature. */
export const FLAG_KEY = 'model_registry';

// ---------------------------------------------------------------------------
// Provider capability types
// ---------------------------------------------------------------------------

export type ProviderTier = 'volume' | 'premium' | 'edge' | 'local' | 'gateway';

export interface ProviderCapabilities {
  chat: boolean;
  vision: boolean;
  embeddings: boolean;
  tools: boolean;
  streaming: boolean;
}

export interface ProviderRecord {
  id: string;
  label: string;
  tier: ProviderTier;
  capabilities: ProviderCapabilities;
  /** Env-var keys that must be present (truthy) for the provider to be available.
   *  Empty for workers-ai (uses AI binding instead of a string env var). */
  requires_env: string[];
}

// ---------------------------------------------------------------------------
// PROVIDERS registry — 8 providers
// ---------------------------------------------------------------------------

export const PROVIDERS: ProviderRecord[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    tier: 'volume',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
    requires_env: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    tier: 'premium',
    capabilities: { chat: true, vision: true, embeddings: false, tools: true, streaming: true },
    requires_env: ['ANTHROPIC_API_KEY'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    tier: 'premium',
    capabilities: { chat: true, vision: true, embeddings: true, tools: true, streaming: true },
    requires_env: ['OPENAI_API_KEY'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    tier: 'premium',
    capabilities: { chat: true, vision: true, embeddings: true, tools: true, streaming: true },
    requires_env: ['GEMINI_API_KEY'],
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    tier: 'premium',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
    requires_env: ['XAI_API_KEY'],
  },
  {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    tier: 'edge',
    capabilities: { chat: true, vision: true, embeddings: true, tools: false, streaming: true },
    // availability is checked via env.AI binding, not a string env var
    requires_env: [],
  },
  {
    id: 'litellm',
    label: 'LiteLLM',
    tier: 'gateway',
    capabilities: { chat: true, vision: true, embeddings: true, tools: true, streaming: true },
    requires_env: ['LITELLM_BASE_URL'],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    tier: 'local',
    capabilities: { chat: true, vision: false, embeddings: true, tools: false, streaming: true },
    requires_env: ['OLLAMA_BASE_URL'],
  },
];

// ---------------------------------------------------------------------------
// Model alias types
// ---------------------------------------------------------------------------

export interface AliasCapabilities {
  chat: boolean;
  vision: boolean;
  embeddings: boolean;
  tools: boolean;
  streaming: boolean;
}

export interface ModelAliasRecord {
  id: string;
  /** Provider ids this alias may route to. First in list is preferred. */
  providers: string[];
  description: string;
  capabilities: AliasCapabilities;
}

// ---------------------------------------------------------------------------
// MODEL_ALIASES registry — 13 aliases
// ---------------------------------------------------------------------------

export const MODEL_ALIASES: ModelAliasRecord[] = [
  {
    id: 'edge-fast',
    providers: ['workers-ai'],
    description: 'Lowest-latency chat via Cloudflare Workers AI edge inference.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: false, streaming: true },
  },
  {
    id: 'edge-smart',
    providers: ['workers-ai'],
    description: 'Smarter Workers AI model for more complex edge-routed completions.',
    capabilities: { chat: true, vision: true, embeddings: false, tools: false, streaming: true },
  },
  {
    id: 'deepseek-fast',
    providers: ['deepseek'],
    description: 'DeepSeek Chat for high-throughput generation at volume-tier cost.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'deepseek-code',
    providers: ['deepseek'],
    description: 'DeepSeek Coder for code generation and completion tasks.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'deepseek-claude-code',
    providers: ['deepseek'],
    description: 'DeepSeek via Anthropic-compatible endpoint for Claude Code build agents.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'premium-quorum',
    providers: ['anthropic', 'openai', 'gemini', 'deepseek'],
    description: 'Routes to the first available premium provider for highest-quality completions.',
    capabilities: { chat: true, vision: true, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'claude-architect',
    providers: ['anthropic'],
    description: 'Anthropic Claude for architecture decisions and complex multi-file reasoning.',
    capabilities: { chat: true, vision: true, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'openai-polish',
    providers: ['openai'],
    description: 'OpenAI GPT for copy polish, structured outputs, and vision tasks.',
    capabilities: { chat: true, vision: true, embeddings: true, tools: true, streaming: true },
  },
  {
    id: 'gemini-grounded',
    providers: ['gemini'],
    description: 'Google Gemini with grounding for factual, search-backed completions.',
    capabilities: { chat: true, vision: true, embeddings: true, tools: true, streaming: true },
  },
  {
    id: 'grok-live-business',
    providers: ['grok'],
    description: 'xAI Grok for live web search and real-time business intelligence.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'grok-local-seo',
    providers: ['grok'],
    description: 'xAI Grok for local SEO research and real-time citation lookup.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'grok-dispute-verifier',
    providers: ['grok'],
    description: 'xAI Grok for live fact-checking and dispute verification tasks.',
    capabilities: { chat: true, vision: false, embeddings: false, tools: true, streaming: true },
  },
  {
    id: 'ollama-local-dev',
    providers: ['ollama'],
    description: 'Locally-hosted Ollama model for offline development and testing.',
    capabilities: { chat: true, vision: false, embeddings: true, tools: false, streaming: true },
  },
];

// ---------------------------------------------------------------------------
// Virtual service models (campaign lane-4, §7 — OpenAI-compatible public API)
// ---------------------------------------------------------------------------

/**
 * `created` epoch for the virtual service models: 2026-09-29T00:00:00Z, the
 * campaign §7 ship date. Fixed (not `Date.now()`) so the catalog is stable
 * across requests and cacheable byte-for-byte.
 */
export const VIRTUAL_MODEL_CREATED = 1790640000;

/** A provider-agnostic virtual model the platform routes on the caller's behalf. */
export interface VirtualServiceModel {
  /** OpenAI-style model id callers pass to /v1/chat/completions. */
  id: string;
  /** What the platform optimizes for when this id is requested. */
  description: string;
}

/**
 * The four virtual service models REQUIRED by the OpenAI-compat acceptance
 * contract (e2e/ai-api/openai-compat.e2e.ts). They are routing intents, not
 * upstream models — the platform picks the concrete provider/model at call
 * time, so they are always listed and always `_available`.
 */
export const VIRTUAL_SERVICE_MODELS: readonly VirtualServiceModel[] = [
  {
    id: 'projectsites-auto',
    description: 'Workload-aware auto-routing — the platform picks the cheapest sufficient model.',
  },
  {
    id: 'projectsites-fast',
    description: 'Lowest-latency routing — favors edge/volume-tier models for quick completions.',
  },
  {
    id: 'projectsites-balanced',
    description: 'Balanced cost/quality routing for general-purpose completions.',
  },
  {
    id: 'projectsites-premium',
    description: 'Highest-quality routing — favors premium frontier models.',
  },
];

/**
 * Look up a virtual service model by id.
 *
 * @param id - The requested model id (e.g. `'projectsites-auto'`).
 * @returns The VirtualServiceModel, or null when the id is not virtual.
 *
 * @example
 * findVirtualModel('projectsites-fast') // → { id: 'projectsites-fast', … }
 * findVirtualModel('edge-fast')         // → null (that's an alias, not virtual)
 */
export function findVirtualModel(id: string): VirtualServiceModel | null {
  return VIRTUAL_SERVICE_MODELS.find((v) => v.id === id) ?? null;
}

/**
 * Look up a registry alias by id.
 *
 * @param id - The requested model id (e.g. `'deepseek-fast'`).
 * @returns The ModelAliasRecord, or null when unknown.
 */
export function findModelAlias(id: string): ModelAliasRecord | null {
  return MODEL_ALIASES.find((a) => a.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Availability helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the provider's required env keys are all present and truthy.
 * Special case: workers-ai is available when `env.AI` exists (an AI binding, not a string key).
 *
 * @param env - The Worker env object cast to a loose record for inspection.
 * @param providerId - The provider's `id` from PROVIDERS.
 *
 * @example
 * providerAvailable(env, 'deepseek')   // true when env.DEEPSEEK_API_KEY is set
 * providerAvailable(env, 'workers-ai') // true when env.AI binding exists
 */
export function providerAvailable(env: unknown, providerId: string): boolean {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return false;

  const e = env as Record<string, unknown>;

  if (providerId === 'workers-ai') {
    return Boolean(e['AI']);
  }

  return provider.requires_env.every((key) => Boolean(e[key]));
}

/**
 * Returns true when at least one of the alias's providers is available.
 *
 * @param env - The Worker env object.
 * @param alias - A ModelAliasRecord from MODEL_ALIASES.
 *
 * @example
 * aliasAvailable(env, MODEL_ALIASES.find(a => a.id === 'premium-quorum')!)
 * // true when anthropic OR openai OR gemini OR deepseek key is set
 */
export function aliasAvailable(env: unknown, alias: ModelAliasRecord): boolean {
  return alias.providers.some((pid) => providerAvailable(env, pid));
}
