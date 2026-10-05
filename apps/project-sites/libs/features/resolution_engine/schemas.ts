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
