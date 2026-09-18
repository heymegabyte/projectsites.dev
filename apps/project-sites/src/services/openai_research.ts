/**
 * @module services/openai_research
 * @description OpenAI-powered business research and expert prompt formulation.
 *
 * Uses the OpenAI Chat Completions API (with configurable model) to:
 * 1. Research a business deeply (profile, brand, services, selling points)
 * 2. Formulate a single expert prompt for bolt.diy to generate a website
 *
 * The default model is `o3-mini` (extended thinking), configurable via
 * the `RESEARCH_MODEL` environment variable.
 *
 * @remarks
 * **Anthropic Citations API is not invoked here** — this module talks to
 * OpenAI exclusively. When/if an Anthropic research path is added, route it
 * through {@link services/external_llm.callExternalLLM} with `documents` set;
 * the Citations parsing is already wired there. Citation persistence into
 * `_research.json` happens at the {@link services/external_llm} layer, which
 * returns `result.citations` on every Anthropic response.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { captureLLMCall } from './analytics.js';
import type { TraceContext } from './external_llm.js';
import { gatewayFetch } from './ai_gateway.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { researchCacheKey, getCachedResearch, putCachedResearch } from './research_cache.js';

const DEFAULT_MODEL = 'o3-mini';

interface BusinessInfo {
  businessName: string;
  businessAddress?: string;
  businessPhone?: string;
  googlePlaceId?: string;
  additionalContext?: string;
  /**
   * Optional tracing context — when supplied, every nested OpenAI call fires a
   * `$ai_generation` event so the full research pipeline rolls up as one trace
   * in PostHog LLM Observability.
   *
   * @see {@link TraceContext}
   */
  traceContext?: TraceContext;
}

export interface ResearchResult {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  sellingPoints: Record<string, unknown>;
  social: Record<string, unknown>;
  expertPrompt: string;
}

/**
 * Per-1M-token pricing for OpenAI research models. Used to compute
 * `costUsd` in PostHog LLM Observability captures.
 */
const OPENAI_RESEARCH_COSTS: Record<string, { input: number; output: number }> = {
  'o3-mini': { input: 1.1, output: 4.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/**
 * Best-effort cost estimate for an OpenAI research call.
 *
 * @remarks
 * Falls back to `0` when the model is unknown; callers should treat the value
 * as advisory, not billing-grade.
 */
export function estimateOpenAiCost(model: string, inputTokens: number, outputTokens: number): number {
  // Most-specific match wins: sort keys longest-first so `gpt-4o-mini` resolves to its OWN price,
  // not `gpt-4o` — a plain `model.includes('gpt-4o')` matched `gpt-4o-mini` and mis-priced it 16.7×
  // (AL-777). Exact model OR a versioned suffix (`gpt-4o-2024-…` → `gpt-4o`) both resolve correctly.
  const key = Object.keys(OPENAI_RESEARCH_COSTS)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(`${k}-`));
  if (!key) return 0;
  const costs = OPENAI_RESEARCH_COSTS[key];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

/**
 * Fire-and-forget PostHog capture wrapped in try/catch so analytics never
 * bubbles into the research pipeline's response path.
 */
async function safeCaptureLLM(
  env: Env,
  params: Parameters<typeof captureLLMCall>[1],
): Promise<void> {
  try {
    await captureLLMCall(env, params);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'openai_research',
        event: 'analytics_capture_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Call OpenAI Chat Completions API.
 *
 * @remarks
 * Every call emits a PostHog `$ai_generation` event (success or failure)
 * routed through {@link captureLLMCall}. Analytics failures are swallowed and
 * NEVER bubble into the caller. Pass `traceContext` to attribute multi-step
 * research pipelines to a single trace in PostHog LLM Observability.
 *
 * @throws Error when `OPENAI_API_KEY` is missing or the HTTP call fails.
 */
async function callOpenAI(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    traceContext?: TraceContext;
    promptId?: string;
  },
): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const model = env.RESEARCH_MODEL || DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: options?.temperature ?? 0.3,
    max_completion_tokens: options?.maxTokens ?? 8192,
  };

  if (options?.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const distinctId = options?.traceContext?.orgId ?? options?.traceContext?.userId ?? 'system';
  const traceId = options?.traceContext?.traceId;
  const promptId = options?.promptId ?? options?.traceContext?.promptId;
  const start = Date.now();

  let res: Response;
  // Capture whether the AI Gateway actually routed this call (vs the direct-vendor fallback) so the
  // success telemetry below reports the REAL routing. The prior hardcoded `false` made every research
  // $ai_generation event read "direct", masking gateway cache-hit/margin analytics whenever the
  // gateway was active (AL-777).
  let gatewayUsed = false;
  try {
    // Route through AI Gateway (caching + observability + margin); gatewayFetch
    // falls back to the direct vendor URL automatically on a gateway 5xx.
    const gw = await gatewayFetch(env, 'openai', '/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    res = gw.response;
    gatewayUsed = gw.gatewayUsed ?? false;
  } catch (err) {
    const latency = Date.now() - start;
    void safeCaptureLLM(env, {
      distinctId,
      provider: 'openai',
      model,
      promptId,
      latencyMs: latency,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      traceId,
    });
    throw err;
  }

  if (!res.ok) {
    const latency = Date.now() - start;
    const text = await res.text();
    void safeCaptureLLM(env, {
      distinctId,
      provider: 'openai',
      model,
      promptId,
      latencyMs: latency,
      status: 'error',
      errorMessage: `OpenAI ${res.status}: ${text.slice(0, 200)}`,
      traceId,
    });
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const latency = Date.now() - start;
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const costUsd = estimateOpenAiCost(model, inputTokens, outputTokens);

  void safeCaptureLLM(env, {
    distinctId,
    provider: 'openai',
    model,
    promptId,
    inputTokens,
    outputTokens,
    latencyMs: latency,
    costUsd,
    status: 'ok',
    traceId,
    gatewayUsed,
  });

  return data.choices[0]?.message?.content ?? '';
}

/**
 * Extract JSON from a text response (handles markdown code fences).
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];

  // Strategy 1: a fenced ```json ... ``` (or bare ```) block.
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  // Strategy 2: the widest `{ ... }` span — strips prose/preamble around an object.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  // Strategy 3: the whole trimmed body (bare object / array / primitive JSON).
  candidates.push(trimmed);

  // Try each strategy in turn — a malformed FIRST fence must not abort the
  // parse when a valid `{...}` span still exists later in the response.
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to the next strategy
    }
  }

  // Every strategy failed. Surface a DIAGNOSABLE error — the bare
  // `SyntaxError: Unexpected end of JSON input` otherwise leaks to a 500 with
  // zero context. The common cause is a response truncated at
  // `max_completion_tokens` mid-JSON (invalid even in json_object mode).
  throw new Error(
    `extractJson: model returned unparseable JSON (first 200 chars: ${trimmed.slice(0, 200)})`,
  );
}

/**
 * Research a business comprehensively using OpenAI.
 */
async function researchProfile(env: Env, info: BusinessInfo): Promise<Record<string, unknown>> {
  const systemPrompt = `You are an expert business researcher. Given a business name and optional details,
research and output a comprehensive JSON profile including:
- business_type, description, services (with prices if findable), hours, phone, email, website
- address, service_area, parking, accessibility
- team members (if known), reviews_summary
- seo metadata, schema_org_type

Rules:
- ONLY include data you are confident about. Mark uncertain data as null.
- DO NOT fabricate reviews, team members, or specific prices you cannot verify.
- Use Google Places data as primary truth source when available.

Output: A single JSON object.`;

  const userPrompt = `Business: ${info.businessName}
${info.businessAddress ? `Address: ${info.businessAddress}` : ''}
${info.businessPhone ? `Phone: ${info.businessPhone}` : ''}
${info.googlePlaceId ? `Google Place ID: ${info.googlePlaceId}` : ''}
${info.additionalContext ? `Additional context: ${info.additionalContext}` : ''}`;

  const result = await callOpenAI(env, systemPrompt, userPrompt, {
    temperature: 0.2,
    maxTokens: 8192,
    jsonMode: true,
    traceContext: info.traceContext,
    promptId: 'openai_research:profile',
  });

  return extractJson(result) as Record<string, unknown>;
}

/**
 * Research brand identity (colors, fonts, personality).
 */
async function researchBrand(
  env: Env,
  info: BusinessInfo,
  profile: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const systemPrompt = `You are an expert brand designer. Given a business profile, determine the ideal brand identity.

Output JSON with:
- primary_color, secondary_color, accent_color (hex codes)
- font_heading, font_body (Google Fonts names)
- personality (3-5 adjective words)
- logo_description (what a logo should look like)
- design_style (e.g., "modern minimalist", "warm rustic", "bold corporate")
- color_rationale (why these colors work for this business)`;

  const userPrompt = `Business: ${info.businessName}
Profile: ${JSON.stringify(profile, null, 2)}`;

  const result = await callOpenAI(env, systemPrompt, userPrompt, {
    temperature: 0.3,
    maxTokens: 2048,
    jsonMode: true,
    traceContext: info.traceContext,
    promptId: 'openai_research:brand',
  });

  return extractJson(result) as Record<string, unknown>;
}

/**
 * Research selling points and hero content.
 */
async function researchSellingPoints(
  env: Env,
  info: BusinessInfo,
  profile: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const systemPrompt = `You are an expert copywriter. Given a business profile, identify the top selling points.

Output JSON with:
- hero_headline (short, powerful, max 8 words)
- hero_subheadline (one compelling sentence)
- cta_primary (button text, e.g., "Book Now", "Get Started")
- cta_secondary (button text, e.g., "Learn More", "View Portfolio")
- selling_points: array of 3 objects, each with { title, description, icon_suggestion }
- testimonial_style (what kind of social proof would work best)
- unique_value_proposition (one sentence)`;

  const userPrompt = `Business: ${info.businessName}
Profile: ${JSON.stringify(profile, null, 2)}`;

  const result = await callOpenAI(env, systemPrompt, userPrompt, {
    temperature: 0.4,
    maxTokens: 2048,
    jsonMode: true,
    traceContext: info.traceContext,
    promptId: 'openai_research:selling_points',
  });

  return extractJson(result) as Record<string, unknown>;
}

/**
 * Research social media and online presence.
 */
async function researchSocial(
  env: Env,
  info: BusinessInfo,
  profile: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const systemPrompt = `You are a social media researcher. Given a business, identify likely social media profiles.

Output JSON with:
- website_url (if known)
- social_links: object with keys like facebook, instagram, twitter, linkedin, youtube, tiktok, yelp
  (values are URLs or null if unknown)
- review_platforms: array of platforms where the business likely has reviews
- online_presence_score: 1-10 estimate of how active they are online`;

  const userPrompt = `Business: ${info.businessName}
${info.businessAddress ? `Address: ${info.businessAddress}` : ''}
Profile: ${JSON.stringify(profile, null, 2)}`;

  const result = await callOpenAI(env, systemPrompt, userPrompt, {
    temperature: 0.2,
    maxTokens: 2048,
    jsonMode: true,
    traceContext: info.traceContext,
    promptId: 'openai_research:social',
  });

  return extractJson(result) as Record<string, unknown>;
}

/**
 * Run the full research pipeline and formulate an expert prompt for bolt.diy.
 */
export async function researchAndFormulatePrompt(
  env: Env,
  info: BusinessInfo,
): Promise<ResearchResult> {
  // #19c margin lever — per-business research cache (dark behind `research_cache`).
  // A rebuild of the same business skips all 5 research LLM calls (~15→5 min). Keyed
  // by stable identity (placeId→name+address); 30-day TTL bounds staleness; `v1` key
  // namespace means a prompt-quality change can invalidate by bumping the version.
  const cacheEnabled = await isFlagOn(env, 'research_cache');
  const cacheKey = researchCacheKey({
    placeId: info.googlePlaceId,
    name: info.businessName,
    address: info.businessAddress,
  });
  if (cacheEnabled) {
    const cached = await getCachedResearch<ResearchResult>(env, cacheKey);
    if (cached) return cached;
  }

  // Step 1: Profile research (sequential — others depend on it)
  const profile = await researchProfile(env, info);

  // Step 2: Parallel research
  const [brand, sellingPoints, social] = await Promise.all([
    researchBrand(env, info, profile),
    researchSellingPoints(env, info, profile),
    researchSocial(env, info, profile),
  ]);

  // Step 3: Formulate the expert prompt
  const expertPrompt = await formulateExpertPrompt(env, {
    businessName: info.businessName,
    profile,
    brand,
    sellingPoints,
    social,
    additionalContext: info.additionalContext,
    traceContext: info.traceContext,
  });

  const result: ResearchResult = { profile, brand, sellingPoints, social, expertPrompt };
  if (cacheEnabled) await putCachedResearch(env, cacheKey, result);
  return result;
}

/**
 * Combine all research into a single expert prompt for bolt.diy.
 */
async function formulateExpertPrompt(
  env: Env,
  data: {
    businessName: string;
    profile: Record<string, unknown>;
    brand: Record<string, unknown>;
    sellingPoints: Record<string, unknown>;
    social: Record<string, unknown>;
    additionalContext?: string;
    traceContext?: TraceContext;
  },
): Promise<string> {
  const systemPrompt = `You are an expert web developer and designer. Your job is to write a SINGLE, comprehensive prompt
that will be given to an AI code editor (bolt.diy) to generate a complete, stunning, production-ready website.

The prompt you write must be completely self-contained — the AI code editor has NO other context.

The generated website must be:
- GORGEOUS: Modern design with CSS animations, smooth transitions, glassmorphism effects, gradient overlays
- ANIMATED: Scroll-triggered animations, hover microinteractions, parallax effects, animated counters
- RESPONSIVE: Mobile-first, fluid typography, works perfectly on all screen sizes
- COMPLETE: All sections a professional portfolio/business site needs
- FAST: Vanilla HTML/CSS/JS only, no frameworks, optimized for performance
- ACCESSIBLE: WCAG 2.1 AA compliant, semantic HTML5, proper contrast ratios

Required sections in the website:
1. Hero with animated background (CSS gradients/particles), headline, subheadline, 2 CTA buttons
2. About section with company story, mission statement
3. Services/offerings grid with icons, descriptions, pricing hints
4. Portfolio/gallery section (if applicable to the business)
5. Testimonials/social proof section
6. Team section (if applicable)
7. FAQ accordion section
8. Contact section with form (name, email, phone, message) and Google Maps embed
9. Footer with social links, business info, legal links

Technical requirements:
- Single HTML file with embedded CSS and minimal JS
- Google Fonts for typography
- CSS custom properties for the color scheme
- CSS animations: @keyframes for hero, scroll-reveal for sections, hover effects for cards
- Intersection Observer for scroll-triggered animations
- Form with client-side validation and success state
- Smooth scroll navigation
- Back-to-top button
- Open Graph meta tags for social sharing
- Schema.org structured data (JSON-LD)

Your output must be ONLY the prompt text — no explanations, no markdown, no wrapping.
The prompt should start directly with instructions for what to build.`;

  const userPrompt = `Create an expert prompt for this business:

Business: ${data.businessName}
${data.additionalContext ? `Context: ${data.additionalContext}` : ''}

Research Data:
Profile: ${JSON.stringify(data.profile, null, 2)}
Brand: ${JSON.stringify(data.brand, null, 2)}
Selling Points: ${JSON.stringify(data.sellingPoints, null, 2)}
Social: ${JSON.stringify(data.social, null, 2)}`;

  return callOpenAI(env, systemPrompt, userPrompt, {
    temperature: 0.4,
    maxTokens: 16000,
    traceContext: data.traceContext,
    promptId: 'openai_research:expert_prompt',
  });
}
