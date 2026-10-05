/**
 * @module libs/features/resolution_engine/schemas
 * @description Zod contracts for the Resolution Engine dual-provider research
 * primitive (WLK-39 S6-a). Boundary types live here per `zod-everywhere`; the
 * service infers its TS types from these schemas (never duplicates them).
 *
 * @packageDocumentation
 */
import { z } from 'zod';

/**
 * The providers the dual-research primitive can route to. These are the
 * `callExternalLLM` standard vendors (each distinct, each gateway-routed).
 * The directive wants OpenAI + Anthropic as the two INDEPENDENT heavy-research
 * legs (§12-13); deepseek is permitted as a substitute when a key is absent.
 */
export const ResearchProviderSchema = z.enum(['openai', 'anthropic', 'deepseek']);
export type ResearchProvider = z.infer<typeof ResearchProviderSchema>;

/**
 * Input to {@link runDualResearch}. `providers` MUST be two DISTINCT providers
 * when supplied; omit it to accept the directive default (`['openai','anthropic']`).
 */
export const DualResearchInputSchema = z
  .object({
    /** The research prompt both legs receive (independently — invariant #7). */
    prompt: z.string().min(1, 'prompt is required'),
    /** Optional system instruction prepended to each leg's request. */
    system: z.string().optional(),
    /**
     * Exactly two DISTINCT providers. Omitted → `['openai','anthropic']`.
     * A same-provider pair is rejected (that would not be independent dual research).
     */
    providers: z
      .tuple([ResearchProviderSchema, ResearchProviderSchema])
      .refine(([a, b]) => a !== b, 'the two research providers must be distinct')
      .optional(),
    /** Per-leg max tokens (default 4096). */
    maxTokens: z.number().int().positive().max(32_000).optional(),
  })
  .strict();

export type DualResearchInput = z.input<typeof DualResearchInputSchema>;

/**
 * Input to the authed `POST /api/resolve` route (WLK-39 S6-b-i). Carries the
 * dual-research `prompt` plus the dual-research passthroughs, and an OPTIONAL
 * `siteId` — when present the route `assertSiteOwned`s it (404, never 403) so a
 * resolution can be scoped to one of the caller's sites. `.strip()`'d (not
 * `.strict()`) so a future panel can send extra UI-only fields without a 400.
 */
export const ResolveInputSchema = z
  .object({
    /** The research prompt both legs receive, then Claude synthesizes. */
    prompt: z.string().min(1, 'prompt is required').max(20_000, 'prompt is too long'),
    /** Optional system instruction prepended to each research leg's request. */
    system: z.string().optional(),
    /** Optional two DISTINCT research providers (default `['openai','anthropic']`). */
    providers: DualResearchInputSchema.shape.providers,
    /** Optional per-leg max tokens for the research legs (default 4096). */
    maxTokens: DualResearchInputSchema.shape.maxTokens,
    /**
     * Optional site to scope the resolution to — ownership-checked (404 when the
     * site is missing/deleted/foreign, never 403). Omit for an org-scoped resolve.
     */
    siteId: z.string().min(1).optional(),
  })
  .strip();

export type ResolveInput = z.input<typeof ResolveInputSchema>;
