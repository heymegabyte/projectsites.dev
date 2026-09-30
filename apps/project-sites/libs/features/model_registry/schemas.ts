/**
 * @module libs/features/model_registry/schemas
 * @description Zod contracts for the model-registry feature — the OpenAI-compatible
 * list response shape and individual ModelEntry objects.
 */
import { z } from 'zod';

/** Capabilities booleans reported per alias in the list response. */
export const ModelCapabilitiesSchema = z.object({
  chat: z.boolean(),
  vision: z.boolean(),
  embeddings: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/**
 * A single model entry in the OpenAI-compatible list response.
 * Aliases carry `created: 0` (deterministic); virtual service models carry
 * the fixed VIRTUAL_MODEL_CREATED epoch — both stable across requests.
 */
export const ModelEntrySchema = z.object({
  /** Model alias id (e.g. "edge-fast", "claude-architect"). */
  id: z.string(),
  /** Always "model" per OpenAI spec. */
  object: z.literal('model'),
  /** Unix timestamp. 0 for aliases; VIRTUAL_MODEL_CREATED for virtual models. */
  created: z.number(),
  owned_by: z.literal('projectsites'),
  /** Provider tier of the alias (first provider's tier). */
  _tier: z.string(),
  /** List of provider ids this alias can route to. */
  _providers: z.array(z.string()),
  /** Combined capabilities of the alias. */
  _capabilities: ModelCapabilitiesSchema,
  /** Whether at least one provider in the alias's list has its env keys configured. */
  _available: z.boolean(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

/** OpenAI-compatible list response from GET /v1/models. */
export const ModelsListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(ModelEntrySchema),
});
export type ModelsListResponse = z.infer<typeof ModelsListResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/chat/completions request (campaign lane-4, fire-57 — non-streamed)
// ---------------------------------------------------------------------------

/**
 * One OpenAI chat message. `developer` is OpenAI's newer system-role spelling
 * and is treated as `system`. Content is string-only for now — multimodal
 * content-part arrays are rejected with a 400 until vision routing lands.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * OpenAI-compatible chat.completions request body (non-streamed).
 * Deliberately NOT `.strict()` — unknown OpenAI params (top_p, n, stop, …)
 * are accepted and ignored so real openai-sdk clients work unmodified.
 * `stream: true` is refused by the handler with `stream_not_supported`.
 */
export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(ChatMessageSchema)
    .min(1)
    .refine((msgs) => msgs.some((m) => m.role === 'user' || m.role === 'assistant'), {
      message: 'messages must include at least one user or assistant message',
    }),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
