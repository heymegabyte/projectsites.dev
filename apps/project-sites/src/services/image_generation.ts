/**
 * @module services/image_generation
 * @description Best-value image generation — advanced AND cheap (Brian directive 2026-09).
 *
 * Default model is **Flux-1-schnell on Cloudflare Workers AI** (`@cf/black-forest-labs/flux-1-schnell`):
 * SOTA image quality, edge-native (`env.AI.run`, no external key), and a fraction of DALL·E's cost —
 * the "DeepSeek-level: highly advanced yet cheap" tier for EVERY image. Flux-schnell outputs
 * 1024×1024 only, so WIDE/tall requests (heroes) escalate to the premium **OpenAI `gpt-image-1`**
 * path through the AI Gateway (Unified Billing) — which also renders far cleaner than DALL·E 3.
 *
 * `callDallE3` (name kept for its callers; now provider-agnostic) returns the raw PNG/JPEG bytes.
 * Consumed by the media library's `generateImage` (`POST /api/media/generate/image`) and the
 * site-generation image workflow.
 */

import type { Env } from '../types/env.js';
import { gatewayFetch } from './ai_gateway.js';
import { ensureArtDirected } from './image_art_direction.js';

/** Decode a base64 image payload (Flux/gpt-image-1 both return base64) to raw bytes. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;
}

/**
 * Cheap default: Flux-1-schnell on Workers AI. 1024×1024 only; edge-native; no external key.
 *
 * @returns PNG/JPEG bytes, or null if the AI binding is absent or the run fails (caller falls back).
 * @remarks Impure — calls the Workers AI binding.
 */
export async function callFluxSchnell(env: Env, prompt: string): Promise<ArrayBuffer | null> {
  if (!env.AI) return null;
  try {
    const result = (await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      // Flux-schnell is distilled for few-step sampling; 8 is its quality ceiling.
      prompt: prompt.slice(0, 2048),
      steps: 8,
    })) as { image?: string } | null;
    const b64 = result?.image;
    return b64 ? base64ToArrayBuffer(b64) : null;
  } catch (err) {
    console.warn('[image_generation] Flux-1-schnell failed, falling back:', err);
    return null;
  }
}

/**
 * Premium escalation: OpenAI `gpt-image-1` via the AI Gateway (Unified Billing). Used for wide/tall
 * heroes Flux-schnell can't frame, and as the fallback when Workers AI is unavailable. `gpt-image-1`
 * always returns `b64_json` (no `response_format`), supports low|medium|high quality, and only the
 * 1024²/1536×1024/1024×1536 sizes — so DALL·E's `1792×1024`/`1024×1792` are mapped here.
 *
 * @returns PNG bytes, or null on any failure.
 * @remarks Impure — calls OpenAI through the gateway.
 */
export async function callOpenAiImage(
  env: Env,
  prompt: string,
  size: '1024x1024' | '1792x1024' | '1024x1792',
): Promise<ArrayBuffer | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[image_generation] OPENAI_API_KEY not set — skipping premium image path');
    return null;
  }
  const gptSize =
    size === '1792x1024' ? '1536x1024' : size === '1024x1792' ? '1024x1536' : '1024x1024';
  try {
    const { response: res } = await gatewayFetch(env, 'openai', '/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: gptSize, quality: 'high' }),
    });
    if (!res.ok) {
      console.warn(`[image_generation] gpt-image-1 error: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const first = data.data?.[0];
    if (first?.b64_json) return base64ToArrayBuffer(first.b64_json);
    // Defensive: if a gateway/model variant still returns a URL, fetch it (time-boxed).
    if (first?.url) {
      const img = await fetch(first.url, { signal: AbortSignal.timeout(20_000) });
      return img.ok ? img.arrayBuffer() : null;
    }
    return null;
  } catch (err) {
    console.warn('[image_generation] gpt-image-1 call failed:', err);
    return null;
  }
}

/**
 * Generate a single image as raw bytes, cheapest-capable-model first.
 *
 * Square requests use Flux-1-schnell (cheap, edge); wide/tall requests + any Flux miss escalate to
 * `gpt-image-1`. The prompt is enriched by {@link ensureArtDirected} (idempotent) so callers that
 * pre-direct never double-wrap; `1792x1024` is treated as hero framing, others as section.
 *
 * @returns The image as an ArrayBuffer (PNG/JPEG) or null on failure.
 */
export async function callDallE3(
  env: Env,
  prompt: string,
  size: '1024x1024' | '1792x1024' | '1024x1792' = '1024x1024',
): Promise<ArrayBuffer | null> {
  const directedPrompt = ensureArtDirected(prompt, size === '1792x1024' ? 'hero' : 'section');
  // Cheap default for square images (icons, section art, most site imagery); premium only for
  // the wide/tall frames Flux-schnell can't produce.
  if (size === '1024x1024') {
    const flux = await callFluxSchnell(env, directedPrompt);
    if (flux) return flux;
  }
  return callOpenAiImage(env, directedPrompt, size);
}
