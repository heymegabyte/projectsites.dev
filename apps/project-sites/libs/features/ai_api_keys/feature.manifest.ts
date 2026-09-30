/**
 * Feature manifest — AI API keys (campaign lane-3, CAMPAIGN-cf-native-ai §5).
 *
 * Durable GrantRecords attached to psk_ API tokens: the storage + request surface the Settings
 * "AI API Keys" UI and the /v1 OpenAI/Anthropic-compat executor consume. POST /api/v1-tokens
 * accepts an optional `grant` body — a mint-time snapshot of CONCRETE ids (sites / connections /
 * actions / models + limits / approval policy / mandatory expiry) validated by the SHARED
 * ai-policy layer (`GrantInputSchema`, a `.pick()` derivation of `GrantRecordSchema` from
 * `@project-sites/shared` — shapes are never redefined) and persisted to `ai_api_key_grants`
 * (migration 0649, one row per token, `token_id` UNIQUE, revision-tracked so stale snapshots fail
 * `effectiveAllow`'s live_state leg). GET list responses attach counts-only summaries; DELETE
 * revokes the grant alongside the token. Service: `src/services/ai_key_grants.ts`; routes:
 * `src/routes/api_tokens_admin.ts`.
 *
 * Flag DARK → a create request carrying `grant` rejects VALIDATION_ERROR ("not available") and NO
 * token is minted; the no-grant token flow is unchanged, so existing tokens never silently gain
 * AI/publish/integration access (grants only ever NARROW a token's reach).
 *
 * Ties the `ai_api_keys` flag to its owning surface so the flag is NOT an orphan
 * (`feature-module-architecture` + `drift-detection`).
 */
export const manifest = {
  slug: 'ai_api_keys',
  name: 'AI API keys (grant records)',
  description:
    'Durable GrantRecord snapshots (concrete site/connection/action/model ids) attached to psk_ API tokens — the storage layer for AI-scoped keys. DARK when off.',
  flagKey: 'ai_api_keys',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-29',
  unitTests: ['__tests__/ai_key_grants.test.ts', '__tests__/api_tokens_grants_route.test.ts'],
};
