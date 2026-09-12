/**
 * AI workflow orchestration using the prompt registry.
 *
 * All LLM calls go through the prompt infrastructure:
 *   registry.resolve() → renderer.renderPrompt() → callModel() → schemas.validateOutput()
 *
 * Every call is observed (prompt_id, version, input_hash, latency, outcome).
 */

import type { Env } from '../types/env.js';
import type { PromptSpec, LlmCallResult } from '../prompts/types.js';
import { registry } from '../prompts/index.js';
import { renderPrompt } from '../prompts/renderer.js';
import { validatePromptInput, validatePromptOutput } from '../prompts/schemas.js';
import { withObservability } from '../prompts/observability.js';
import { captureLLMCall } from './analytics.js';
import type { TraceContext } from './external_llm.js';
import { log } from '../lib/log.js';

const wfLog = log.child('ai_workflows');

/**
 * Best-effort PostHog LLM Observability capture wrapped in try/catch so
 * analytics failures NEVER bubble into the workflow path.
 *
 * @remarks
 * Workers AI does not return a usage block, so the `inputTokens` /
 * `outputTokens` passed here are best-effort approximations based on the
 * rendered prompt + output character lengths (assume ~4 chars per token). The
 * resulting `costUsd` is `0` because Workers AI is included on Workers paid.
 */
async function safeCaptureWorkersAi(
  env: Env,
  params: Parameters<typeof captureLLMCall>[1],
): Promise<void> {
  try {
    await captureLLMCall(env, params);
  } catch (err) {
    wfLog.warn('analytics_capture_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Core LLM call ────────────────────────────────────────────

/**
 * Call an LLM model through the Workers AI binding.
 * Uses the prompt registry for resolution, rendering, and observability.
 *
 * @remarks
 * Every successful `env.AI.run()` fires a PostHog `$ai_generation` event via
 * {@link captureLLMCall} with `provider: 'workers_ai'`. Token counts are
 * **best-effort approximations** (`~chars/4`) because Workers AI does not
 * return a usage block. Pass `traceContext` so multi-prompt workflows roll up
 * as one trace in PostHog LLM Observability.
 */
export async function runPrompt(
  env: Env,
  promptId: string,
  version: number,
  rawInputs: Record<string, unknown>,
  options: {
    variant?: string;
    seed?: string;
    retryCount?: number;
    modelOverride?: string;
    traceContext?: TraceContext;
  } = {},
): Promise<LlmCallResult> {
  // 1. Resolve the prompt spec (with optional A/B variant)
  let spec: PromptSpec | undefined;
  if (options.seed) {
    spec = registry.resolveVariant(promptId, version, options.seed);
  } else if (options.variant) {
    spec = registry.resolveExact(promptId, version, options.variant);
  } else {
    spec = registry.resolve(promptId, version);
  }

  if (!spec) {
    throw new Error(`Prompt not found: ${promptId}@${version}`);
  }

  // 2. Validate inputs against Zod schema
  const validated = validatePromptInput(promptId, rawInputs);
  const stringInputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(validated)) {
    stringInputs[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }

  // 3. Render the prompt templates
  const rendered = renderPrompt(spec, stringInputs, { safeDelimit: true });
  const model = options.modelOverride ?? rendered.model;

  // 4. Call the LLM with observability wrapper
  const retryCount = options.retryCount ?? 0;

  const { result: output, log } = await withObservability(
    spec,
    model,
    validated,
    retryCount,
    async () => {
      const response = await env.AI.run(model as Parameters<Ai['run']>[0], {
        messages: [
          { role: 'system', content: rendered.system },
          { role: 'user', content: rendered.user },
        ],
        temperature: rendered.params.temperature,
        max_tokens: rendered.params.maxTokens,
      });

      const text =
        typeof response === 'string'
          ? response
          : ((response as { response?: string }).response ?? JSON.stringify(response));

      return { output: text, tokenCount: 0 };
    },
  );

  return {
    success: true,
    output,
    model,
    tokensUsed: log.tokenCount,
    latencyMs: log.latencyMs,
    promptId: spec.id,
    promptVersion: spec.version,
    promptVariant: spec.variant,
  };
}

/**
 * Extract JSON from an LLM response that may contain surrounding text.
 *
 * LLMs sometimes return JSON wrapped in markdown fences or preceded by
 * explanatory text (e.g. "Based on the information..."). This function
 * finds the first valid JSON object or array in the text and parses it.
 *
 * @param text - Raw LLM output text.
 * @returns Parsed JSON value.
 * @throws {SyntaxError} If no valid JSON can be extracted.
 */
export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: already valid JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue to extraction
  }

  // Try to extract from markdown code fences ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim());
    } catch {
      // continue
    }
  }

  // Find the first { or [ and match to the last } or ]
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  let startIdx = -1;
  let endChar = '';

  if (firstBrace === -1 && firstBracket === -1) {
    throw new SyntaxError(`No JSON found in LLM output: ${trimmed.substring(0, 80)}...`);
  }

  if (firstBrace === -1) {
    startIdx = firstBracket;
    endChar = ']';
  } else if (firstBracket === -1) {
    startIdx = firstBrace;
    endChar = '}';
  } else {
    startIdx = Math.min(firstBrace, firstBracket);
    endChar = startIdx === firstBrace ? '}' : ']';
  }

  const lastEnd = trimmed.lastIndexOf(endChar);
  if (lastEnd <= startIdx) {
    throw new SyntaxError(
      `No matching closing bracket in LLM output: ${trimmed.substring(0, 80)}...`,
    );
  }

  const candidate = trimmed.substring(startIdx, lastEnd + 1);
  return JSON.parse(candidate);
}

// ══════════════════════════════════════════════════════════════
// V2 WORKFLOW: Parallelized research + full website generation
// ══════════════════════════════════════════════════════════════

import type {
  ResearchProfileOutput as ProfileResult,
  ResearchSocialOutput as SocialResult,
  ResearchBrandOutput as BrandResult,
  ResearchSellingPointsOutput as SellingPointsResult,
  ResearchImagesOutput as ImagesResult,
  ScoreWebsiteOutput as WebsiteScore,
} from '../prompts/schemas.js';

/** Input for the v2 site generation workflow. */
export interface WorkflowInput {
  businessName: string;
  businessAddress?: string;
  businessPhone?: string;
  googlePlaceId?: string;
  additionalContext?: string;
  uploadedAssets?: string[];
}

/** Complete research results from all parallel prompts. */
export interface WorkflowResearch {
  profile: ProfileResult;
  social: SocialResult;
  brand: BrandResult;
  sellingPoints: SellingPointsResult;
  images: ImagesResult;
}

/** Full output of the v2 workflow. */
export interface WorkflowResult {
  research: WorkflowResearch;
  html: string;
  privacyHtml: string;
  termsHtml: string;
  quality: WebsiteScore;
}

// ── Phase 1: Profile Research ────────────────────────────────

async function runResearchProfile(env: Env, input: WorkflowInput): Promise<ProfileResult> {
  const result = await runPrompt(env, 'research_profile', 1, {
    business_name: input.businessName,
    business_address: input.businessAddress ?? '',
    business_phone: input.businessPhone ?? '',
    google_place_id: input.googlePlaceId ?? '',
    additional_context: input.additionalContext ?? '',
  });
  return validatePromptOutput(
    'research_profile',
    extractJsonFromText(result.output),
  ) as ProfileResult;
}

// ── Phase 2: Parallel Research ───────────────────────────────

async function runResearchSocial(
  env: Env,
  input: WorkflowInput,
  businessType: string,
): Promise<SocialResult> {
  const result = await runPrompt(env, 'research_social', 1, {
    business_name: input.businessName,
    business_address: input.businessAddress ?? '',
    business_type: businessType,
  });
  return validatePromptOutput(
    'research_social',
    extractJsonFromText(result.output),
  ) as SocialResult;
}

async function runResearchBrand(
  env: Env,
  input: WorkflowInput,
  businessType: string,
  websiteUrl: string,
): Promise<BrandResult> {
  // Step 1: If website exists, extract REAL colors via GPT-4o vision (Anthropic fallback)
  // This prevents the LLM from guessing colors based on industry stereotypes
  let extractedColors = '';
  if (websiteUrl && (env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY)) {
    try {
      const { callExternalLLMWithVision } = await import('./external_llm.js');
      // Use a lightweight screenshot proxy or instruct the LLM to analyze the URL
      const colorResult = await callExternalLLMWithVision(env, {
        system: `You are a brand color extraction specialist. Given a website URL, describe the EXACT brand colors used on the site. Focus on:
1. Logo dominant color (HIGHEST PRIORITY — this IS the brand color)
2. Header/nav colors
3. CTA button colors
4. Accent/link colors
Return ONLY a JSON object: {"primary":"#hex","secondary":"#hex","accent":"#hex","source":"extracted_from_website","confidence":"high|medium|low","notes":"..."}
Do NOT guess. If you cannot determine from the URL alone, set confidence to "low".`,
        user: `Extract the brand colors from this website: ${websiteUrl}
Business: ${input.businessName} (${businessType})
Look at the logo and header area first — the logo color defines the primary brand color.`,
        jsonMode: true,
        maxTokens: 500,
        provider: 'openai',
      });
      const parsed = JSON.parse(colorResult.output);
      if (parsed.primary && parsed.confidence !== 'low') {
        extractedColors = `\n\nIMPORTANT — Pre-extracted brand colors from the actual website (via GPT-4o vision):
Primary: ${parsed.primary} (from ${parsed.source})
Secondary: ${parsed.secondary || 'not determined'}
Accent: ${parsed.accent || 'not determined'}
Notes: ${parsed.notes || 'none'}
Confidence: ${parsed.confidence}
USE THESE COLORS as the primary palette. Do NOT override with industry-generic colors.`;
      }
      wfLog.info('color_extraction_ok', { slug: websiteUrl });
    } catch (err) {
      // Non-fatal — fall back to LLM color inference
      wfLog.warn('color_extraction_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = await runPrompt(env, 'research_brand', 1, {
    business_name: input.businessName,
    business_type: businessType,
    business_address: input.businessAddress ?? '',
    website_url: websiteUrl,
    additional_context: (input.additionalContext ?? '') + extractedColors,
  });
  return validatePromptOutput('research_brand', extractJsonFromText(result.output)) as BrandResult;
}

async function runResearchSellingPoints(
  env: Env,
  input: WorkflowInput,
  businessType: string,
  servicesJson: string,
  description: string,
): Promise<SellingPointsResult> {
  const result = await runPrompt(env, 'research_selling_points', 1, {
    business_name: input.businessName,
    business_type: businessType,
    services_json: servicesJson,
    description,
    additional_context: input.additionalContext ?? '',
  });
  return validatePromptOutput(
    'research_selling_points',
    extractJsonFromText(result.output),
  ) as SellingPointsResult;
}

async function runResearchImages(
  env: Env,
  input: WorkflowInput,
  businessType: string,
  servicesJson: string,
): Promise<ImagesResult> {
  const result = await runPrompt(env, 'research_images', 1, {
    business_name: input.businessName,
    business_type: businessType,
    business_address: input.businessAddress ?? '',
    services_json: servicesJson,
    additional_context: input.additionalContext ?? '',
  });
  return validatePromptOutput(
    'research_images',
    extractJsonFromText(result.output),
  ) as ImagesResult;
}

// ── Phase 3: Website Generation ──────────────────────────────

async function runGenerateWebsite(
  env: Env,
  research: WorkflowResearch,
  uploads?: string[],
): Promise<string> {
  const result = await runPrompt(env, 'generate_website', 1, {
    profile_json: JSON.stringify(research.profile),
    brand_json: JSON.stringify(research.brand),
    selling_points_json: JSON.stringify(research.sellingPoints),
    social_json: JSON.stringify(research.social),
    images_json: JSON.stringify(research.images),
    uploads_json: uploads ? JSON.stringify(uploads) : '',
  });
  validatePromptOutput('generate_website', result.output);
  return result.output;
}

// ── Phase 4: Legal Pages ─────────────────────────────────────

async function runGenerateLegalPage(
  env: Env,
  research: WorkflowResearch,
  pageType: 'privacy' | 'terms',
): Promise<string> {
  const addr = research.profile.address;
  const addressStr = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');

  const result = await runPrompt(env, 'generate_legal_pages', 1, {
    business_name: research.profile.business_name,
    brand_json: JSON.stringify(research.brand),
    page_type: pageType,
    business_address: addressStr,
    business_email: research.profile.email ?? '',
    website_url: research.social.website_url ?? '',
  });
  validatePromptOutput('generate_legal_pages', result.output);
  return result.output;
}

// ── Phase 4: Quality Scoring ─────────────────────────────────

async function runScoreWebsite(
  env: Env,
  html: string,
  businessName: string,
): Promise<WebsiteScore> {
  const result = await runPrompt(env, 'score_website', 1, {
    html_content: html.substring(0, 6000),
    business_name: businessName,
  });
  return validatePromptOutput('score_website', extractJsonFromText(result.output)) as WebsiteScore;
}

// ── V2 Full Workflow Orchestration ───────────────────────────

/**
 * Run the v2 site generation workflow with parallelized research.
 *
 * Phase 1: Profile research (need business_type for other prompts)
 * Phase 2: Social, brand, selling points, images (parallel)
 * Phase 3: Generate main website HTML
 * Phase 4: Privacy page + terms page + quality score (parallel)
 */
export async function runSiteGenerationWorkflowV2(
  env: Env,
  input: WorkflowInput,
): Promise<WorkflowResult> {
  // Phase 1: Research profile first (we need business_type for other prompts)
  const profile = await runResearchProfile(env, input);

  wfLog.info('phase_1_done', { message: 'Profile research complete' });

  // Phase 2: Parallel research (all depend on profile.business_type)
  const servicesJson = JSON.stringify(profile.services.map((s) => s.name));

  const bizType = profile.business_type ?? 'general';
  const bizDesc = profile.description ?? '';

  const [social, brand, sellingPoints, images] = await Promise.all([
    runResearchSocial(env, input, bizType),
    runResearchBrand(env, input, bizType, ''),
    runResearchSellingPoints(env, input, bizType, servicesJson, bizDesc),
    runResearchImages(env, input, bizType, servicesJson),
  ]);

  const research: WorkflowResearch = { profile, social, brand, sellingPoints, images };

  wfLog.info('phase_2_done', {
    message: 'Parallel research complete',
    success: brand.logo.found_online,
  });

  // Phase 3: Generate main website HTML
  const html = await runGenerateWebsite(env, research, input.uploadedAssets);

  wfLog.info('phase_3_done', { message: 'Website HTML generated' });

  // Phase 4: Parallel - legal pages + quality scoring
  const [privacyHtml, termsHtml, quality] = await Promise.all([
    runGenerateLegalPage(env, research, 'privacy'),
    runGenerateLegalPage(env, research, 'terms'),
    runScoreWebsite(env, html, input.businessName),
  ]);

  wfLog.info('phase_4_done', { message: 'Legal pages and scoring complete' });

  return { research, html, privacyHtml, termsHtml, quality };
}

// ── Workflows v2 dispatch helpers (item #60) ─────────────────

/** Output shape from `dispatchImageGenerationWorkflow`. */
export interface ImageGenerationDispatch {
  /** Workflow instance ID returned by `env.IMAGE_GENERATION_WORKFLOW.create`. */
  workflow_id: string;
  /** Status URL for polling (`/api/sites/:siteId/workflows/image-generation/:id`). */
  status_url: string;
}

/**
 * Fire a Workflows v2 image-generation run for one image concept.
 *
 * Replaces the legacy synchronous `generateSectionImage` call inside the
 * site-generation pipeline. Each image becomes a resumable workflow
 * instance — DALL-E retry, Stability fallback, and R2 upload all run as
 * independent steps with their own 3-try / 30s-exponential retry budgets.
 *
 * When the `IMAGE_GENERATION_WORKFLOW` binding is unbound (dev), the helper
 * returns `null` so the caller can degrade gracefully.
 *
 * @example
 * ```ts
 * const dispatch = await dispatchImageGenerationWorkflow(env, {
 *   siteId: 's1',
 *   slug: 'acme',
 *   concept: 'hero',
 *   prompt: 'A wide cinematic photograph of …',
 *   size: '1792x1024',
 * });
 * if (dispatch) console.warn(dispatch.status_url);
 * ```
 */
export async function dispatchImageGenerationWorkflow(
  env: Env,
  params: {
    siteId: string;
    slug: string;
    concept: string;
    prompt: string;
    size?: '1024x1024' | '1792x1024' | '1024x1792';
  },
): Promise<ImageGenerationDispatch | null> {
  if (!env.IMAGE_GENERATION_WORKFLOW) return null;
  const id = `imgwf-${params.siteId}-${params.concept.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}-${Date.now()}`;
  const inst = await env.IMAGE_GENERATION_WORKFLOW.create({ id, params });
  return {
    workflow_id: inst.id,
    status_url: `/api/sites/${params.siteId}/workflows/image-generation/${inst.id}`,
  };
}

// ── Prompt Registration (called at startup) ──────────────────

/**
 * Register all prompt definitions in the registry.
 * Called once at Worker startup.
 *
 * Each prompt is defined inline here (bundled with the Worker).
 * The corresponding .prompt.md files in /prompts/ are the
 * human-readable, diffable source of truth for review.
 */
export function registerAllPrompts(): void {
  registry.registerAll([
    {
      id: 'research_business',
      version: 2,
      description: 'Research a business using public data to generate structured website content',
      models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8'],
      params: { temperature: 0.3, maxTokens: 4096 },
      inputs: {
        required: ['business_name'],
        optional: ['business_phone', 'business_address', 'google_place_id', 'additional_context'],
      },
      outputs: { format: 'json', schema: 'ResearchBusinessOutput' },
      notes: {
        pii: 'Avoid customer personal data in generated content',
        quality: 'Verify claims are factually plausible',
      },
      system: [
        'You are a business research assistant specializing in small and local businesses.',
        'Given a business name and optional details, produce structured JSON content for a professional website.',
        '',
        'Rules:',
        '- All claims must be factually plausible and generic enough to be accurate.',
        '- Never fabricate specific reviews, testimonials, or customer names.',
        '- Keep the tone professional and confident.',
        '- If data is insufficient, produce reasonable defaults for the business type.',
        '',
        'Return valid JSON with: business_name, tagline (under 60 chars), description (2-3 sentences),',
        'services (3-8 items), hours [{day, hours}], faq [{question, answer}] (3-5 items),',
        'seo_title (under 60 chars), seo_description (under 160 chars).',
      ].join('\n'),
      user: [
        'Business Name: {{business_name}}',
        'Business Phone: {{business_phone}}',
        'Business Address: {{business_address}}',
        'Google Place ID: {{google_place_id}}',
        'Additional Context: {{additional_context}}',
        '',
        'Research this business and return the JSON structure described above.',
      ].join('\n'),
    },
    {
      id: 'generate_site',
      version: 2,
      description: 'Generate a complete single-page HTML website from structured business data',
      models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8'],
      params: { temperature: 0.2, maxTokens: 8192 },
      inputs: { required: ['research_data'], optional: [] },
      outputs: { format: 'html', schema: 'GenerateSiteOutput' },
      notes: { size: 'Under 50KB', accessibility: 'WCAG 2.1 AA' },
      system: [
        'You are a web designer that generates clean, mobile-first, single-page HTML websites.',
        'The output must be a complete, self-contained HTML file with embedded CSS.',
        '',
        'Requirements:',
        '- Mobile-first responsive design using modern CSS (grid, flexbox)',
        '- Semantic HTML5 elements',
        '- Build ALL of these sections, each fully written: hero (headline + real subhead + primary CTA), services (≥3 named items EACH with a 1-2 sentence description), about (≥2 real sentences), hours, contact, FAQ (≥3 real Q&A)',
        '- No external dependencies',
        '- Under 50KB total, WCAG 2.1 AA accessible',
        '',
        'CONTENT DEPTH (build-breaking): ≥350 words of SPECIFIC body copy grounded in the data — never generic filler. Render the real business name, address, phone (as a tel: link), and hours as visible text. Use the business name + city throughout so a stranger learns concrete facts about THIS business.',
        'NEVER output the section list, an outline, "Sections: ...", or any instruction/prompt text as visible copy or in the title/meta description. The meta description is marketing copy about the business, never a description of your task. Emit ONLY finished website copy.',
        '',
        'Return ONLY a complete HTML document starting with <!DOCTYPE html>.',
      ].join('\n'),
      user: 'Here is the structured business data:\n\n{{research_data}}\n\nGenerate the complete HTML website now. ≥350 words of specific real copy, every section fully written, real NAP + hours + a primary CTA. Never print the section plan or any instruction text as copy.',
    },
    {
      id: 'score_quality',
      version: 2,
      description: 'Score the quality of generated website HTML on multiple dimensions',
      models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8'],
      params: { temperature: 0.1, maxTokens: 1024 },
      inputs: { required: ['html_content'], optional: [] },
      outputs: { format: 'json', schema: 'ScoreQualityOutput' },
      notes: { scoring: 'All scores 0.0-1.0', threshold: 'Below 0.6 = regenerate' },
      system: [
        'You are a quality assurance reviewer for generated websites.',
        'Score on: accuracy, completeness, professionalism, seo, accessibility (each 0.0-1.0).',
        'Return JSON: { "scores": {...}, "overall": number, "issues": [], "suggestions": [] }',
      ].join('\n'),
      user: 'Score the following website HTML:\n\n{{html_content}}',
    },
    {
      id: 'site_copy',
      version: 3,
      description: 'Generate conversion-focused marketing copy for a small business website',
      models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8'],
      params: { temperature: 0.6, maxTokens: 900 },
      inputs: {
        required: ['businessName', 'city', 'services', 'tone'],
        optional: [],
      },
      outputs: { format: 'markdown', schema: 'SiteCopyOutput' },
      notes: { pii: 'Avoid customer personal data', brand: 'Follow tone strictly' },
      system: [
        'You are a conversion-focused copywriter for small business websites.',
        'Follow the brand tone exactly and keep all claims verifiable.',
        '',
        'Tone guide:',
        '- friendly: Warm, approachable, community-focused.',
        '- premium: Sophisticated, confident, quality-first.',
        '- no-nonsense: Direct, efficient, facts-first.',
      ].join('\n'),
      user: [
        'Business: {{businessName}}',
        'City: {{city}}',
        'Services: {{services}}',
        'Tone: {{tone}}',
        '',
        'Write:',
        '1) Hero headline + subhead + 2 CTAs',
        '2) Three benefit bullets',
        '3) Short About section',
        'Return in Markdown.',
      ].join('\n'),
    },
    {
      id: 'site_copy',
      version: 3,
      variant: 'b',
      description: 'Generate conversion-focused marketing copy (variant B: benefit-led)',
      models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8'],
      params: { temperature: 0.7, maxTokens: 900 },
      inputs: {
        required: ['businessName', 'city', 'services', 'tone'],
        optional: [],
      },
      outputs: { format: 'markdown', schema: 'SiteCopyOutput' },
      notes: {
        pii: 'Avoid customer personal data',
        ab_test: 'Variant B: benefit-led hero',
        hypothesis: 'Benefit-led headlines increase CTR by 15%',
      },
      system: [
        'You are a conversion-focused copywriter for small business websites.',
        'This variant emphasizes benefits over brand name in headlines.',
        'Follow the brand tone exactly and keep all claims verifiable.',
        '',
        'IMPORTANT: The hero headline must lead with the primary BENEFIT,',
        'not the business name. The business name appears in the subhead.',
      ].join('\n'),
      user: [
        'Business: {{businessName}}',
        'City: {{city}}',
        'Services: {{services}}',
        'Tone: {{tone}}',
        '',
        'Write:',
        '1) Hero headline (benefit-led) + subhead with business name + 2 CTAs',
        '2) Three benefit bullets',
        '3) Short About section',
        'Return in Markdown.',
      ].join('\n'),
    },
  ]);

  // Configure A/B test: 80% variant a (default), 20% variant b
  registry.configureVariants('site_copy', 3, { a: 80, b: 20 });

  // ── V2 Workflow Prompts ──────────────────────────────────────

  const defaultModels = [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
  ];

  registry.registerAll([
    {
      id: 'research_profile',
      version: 1,
      description: 'Deep business profile research',
      models: defaultModels,
      params: { temperature: 0.3, maxTokens: 4096 },
      inputs: {
        required: ['business_name'],
        optional: ['business_address', 'business_phone', 'google_place_id', 'additional_context'],
      },
      outputs: { format: 'json', schema: 'ResearchProfileOutput' },
      notes: { pii: 'No customer PII' },
      system: [
        'You are a business intelligence analyst. Produce a comprehensive JSON profile for a professional portfolio website.',
        'Infer business type from name/context. Generate plausible hours, services (4-8), and FAQ (3-5).',
        'All text must be professional, concise, and free of jargon.',
        'Return valid JSON matching the schema: business_name, tagline, description, mission_statement,',
        'business_type, services[{name,description,price_hint}], hours[{day,open,close,closed}],',
        'phone, email, address{street,city,state,zip,country}, faq[{question,answer}],',
        'seo_title (under 60 chars), seo_description (under 160 chars).',
      ].join('\n'),
      user: [
        'Business Name: {{business_name}}',
        'Address: {{business_address}}',
        'Phone: {{business_phone}}',
        'Google Place ID: {{google_place_id}}',
        'Additional Context: {{additional_context}}',
        '',
        'Research this business thoroughly and return the JSON profile.',
      ].join('\n'),
    },
    {
      id: 'research_social',
      version: 1,
      description: 'Discover social media profiles and online presence',
      models: defaultModels,
      params: { temperature: 0.2, maxTokens: 2048 },
      inputs: {
        required: ['business_name'],
        optional: ['business_address', 'business_type'],
      },
      outputs: { format: 'json', schema: 'ResearchSocialOutput' },
      notes: { confidence: '90%+ confidence only' },
      system: [
        'You are a social media researcher. Determine the most likely social media URLs for this business.',
        'Only return URLs with 90%+ confidence. Include confidence scores (0.0-1.0).',
        'Check: Facebook, Instagram, X/Twitter, LinkedIn, Yelp, Google Maps, TikTok, YouTube, Pinterest.',
        'Return JSON: { social_links[{platform,url,confidence}], website_url, review_platforms[{platform,url,rating}] }',
      ].join('\n'),
      user: [
        'Business Name: {{business_name}}',
        'Address: {{business_address}}',
        'Business Type: {{business_type}}',
        '',
        'Find social media profiles. Only include links where confidence >= 0.9.',
      ].join('\n'),
    },
    {
      id: 'research_brand',
      version: 1,
      description: 'Determine brand identity - colors, fonts, logo, style',
      models: defaultModels,
      params: { temperature: 0.3, maxTokens: 2048 },
      inputs: {
        required: ['business_name', 'business_type'],
        optional: ['business_address', 'website_url', 'additional_context'],
      },
      outputs: { format: 'json', schema: 'ResearchBrandOutput' },
      notes: { colors: 'Appropriate for industry' },
      system: [
        'You are a brand identity consultant. Determine visual brand identity for this business.',
        'Suggest 3-5 colors (hex) appropriate for the industry. Recommend Google Fonts.',
        'For logo: indicate if findable online or needs generation. If generating, describe a TEXT-FREE square ICON MARK — a simple geometric symbol or a 1-2 letter monogram of the initials in the brand color. NEVER bake the full business name into the icon: the app-icon + all favicons use this square mark, and the website renders the business name as a SEPARATE stylized wordmark BESIDE the icon. Keep fallback_design.text to the 1-2 letter monogram ONLY (never the full name).',
        'Return JSON: { logo{found_online,search_query,fallback_design{text,font,accent_shape,accent_color}},',
        'colors{primary,secondary,accent,background,surface,text_primary,text_secondary},',
        'fonts{heading,body}, brand_personality, style_notes }',
      ].join('\n'),
      user: [
        'Business Name: {{business_name}}',
        'Business Type: {{business_type}}',
        'Address: {{business_address}}',
        'Website: {{website_url}}',
        'Additional Context: {{additional_context}}',
        '',
        'Determine the brand identity.',
      ].join('\n'),
    },
    {
      id: 'research_selling_points',
      version: 1,
      description: 'Identify top 3 USPs and hero content',
      models: defaultModels,
      params: { temperature: 0.4, maxTokens: 2048 },
      inputs: {
        required: ['business_name', 'business_type'],
        optional: ['services_json', 'description', 'additional_context'],
      },
      outputs: { format: 'json', schema: 'ResearchSellingPointsOutput' },
      notes: { icons: 'Use Lucide icon names' },
      system: [
        'You are a marketing strategist. Identify exactly 3 selling points for this business.',
        'Each has: headline (3-6 words), description (2-3 sentences), icon (Lucide icon name).',
        'Also generate 2-3 hero slogans with CTAs and 3-5 benefit bullets.',
        'Icons: shield-check, clock, star, heart, zap, award, users, thumbs-up, scissors, wrench, utensils.',
        'Return JSON: { selling_points[3], hero_slogans[{headline,subheadline,cta_primary,cta_secondary}],',
        'benefit_bullets[] }',
      ].join('\n'),
      user: [
        'Business Name: {{business_name}}',
        'Business Type: {{business_type}}',
        'Services: {{services_json}}',
        'Description: {{description}}',
        'Additional Context: {{additional_context}}',
        '',
        'Identify the top 3 selling points and hero content.',
      ].join('\n'),
    },
    {
      id: 'research_images',
      version: 1,
      description: 'Determine image needs and search strategies',
      models: defaultModels,
      params: { temperature: 0.3, maxTokens: 2048 },
      inputs: {
        required: ['business_name', 'business_type'],
        optional: ['business_address', 'services_json', 'additional_context'],
      },
      outputs: { format: 'json', schema: 'ResearchImagesOutput' },
      notes: { confidence: '90%+ for real images' },
      system: [
        'You are a visual content strategist. Determine image needs for this business website.',
        'For hero carousel: 3 image concepts. For each: specific search query and stock fallback.',
        // CRITICAL (AL-424): every search query MUST name the SPECIFIC thing this business
        // type sells or does — a guitar shop → "vintage electric guitars on wall guitar store
        // interior", a distillery → "copper still distillery barrels tasting room", a bakery →
        // "artisan bread pastry case bakery counter", a bookstore → "bookstore shelves of books".
        // NEVER a generic "modern retail store / boutique / storefront / shop interior" query:
        // a generic retail/boutique query returns a CLOTHING-FASHION store (dress racks,
        // handbags) that mismatches almost every vertical (a guitar shop must never show a
        // fashion boutique). The theme aesthetic is irrelevant to the query SUBJECT — the query
        // names the ACTUAL products/space of THIS business_type, not a "boutique retail" mood.
        'Include storefront, team, and service images with confidence scores.',
        'Return JSON: { hero_images[], storefront_image, team_image, service_images[],',
        'placeholder_strategy (gradient|pattern|illustration) }',
      ].join('\n'),
      user: [
        'Business Name: {{business_name}}',
        'Business Type: {{business_type}}',
        'Address: {{business_address}}',
        'Services: {{services_json}}',
        'Additional Context: {{additional_context}}',
        '',
        'Determine image needs and search strategies.',
      ].join('\n'),
    },
    {
      id: 'generate_website',
      version: 1,
      description: 'Generate complete portfolio website from all research data',
      models: defaultModels,
      params: { temperature: 0.2, maxTokens: 16000 },
      inputs: {
        required: ['profile_json', 'brand_json', 'selling_points_json', 'social_json'],
        optional: ['images_json', 'uploads_json', 'privacy_template', 'terms_template'],
      },
      outputs: { format: 'html', schema: 'GenerateWebsiteOutput' },
      notes: { size: 'Under 80KB', a11y: 'WCAG 2.1 AA' },
      system: [
        'You are an elite web designer creating gorgeous, concise, intuitive business portfolio websites.',
        'Produce a complete HTML file with embedded CSS and minimal inline JS.',
        '',
        'Required sections: 1) Hero with CSS carousel (3 slides, auto-rotating), gradient overlays, CTAs.',
        '2) Selling points (3 cards with SVG icons). 3) About with mission blockquote.',
        '4) Services grid with CTA. 5) Full-width Google Maps embed.',
        '6) Contact form (name, email, phone, message). 7) Social media icon links (inline SVGs).',
        '8) Footer with copyright, /privacy and /terms links.',
        '',
        'Technical: Mobile-first, CSS custom properties, Google Fonts, semantic HTML5,',
        'smooth scroll, fadeInUp animations, WCAG 2.1 AA, SEO meta + Open Graph tags.',
        'No frameworks. Under 80KB. Return ONLY <!DOCTYPE html> document.',
      ].join('\n'),
      user: [
        '## Business Profile\n{{profile_json}}',
        '\n## Brand Identity\n{{brand_json}}',
        '\n## Selling Points & Hero\n{{selling_points_json}}',
        '\n## Social Media\n{{social_json}}',
        '\n## Images\n{{images_json}}',
        '\n## Uploads\n{{uploads_json}}',
        '\nGenerate the complete, gorgeous HTML website now.',
      ].join('\n'),
    },
    {
      id: 'generate_legal_pages',
      version: 1,
      description: 'Generate privacy policy or terms of service page',
      models: defaultModels,
      params: { temperature: 0.1, maxTokens: 12000 },
      inputs: {
        required: ['business_name', 'brand_json', 'page_type'],
        optional: ['business_address', 'business_email', 'website_url'],
      },
      outputs: { format: 'html', schema: 'GenerateLegalPageOutput' },
      notes: { legal: 'Generic, not legal advice' },
      system: [
        'Generate a privacy policy or terms of service page for a small business website.',
        'Match the main site visual design from brand data.',
        'Include header (business name linking to /), the legal content, and matching footer.',
        '',
        'Privacy sections: Introduction, Info We Collect, When We Collect, How We Use,',
        'How We Protect, Cookies, Third-Party Disclosure, Third-Party Links,',
        'Children Privacy, Data Breach Notice, Your Rights, Contact.',
        '',
        'Terms sections: Agreement, Responsible Use, Content Ownership, Privacy reference,',
        'Warranties, Liability, IP, Termination, Governing Law, Contact.',
        '',
        'Return ONLY <!DOCTYPE html> document matching the site design.',
      ].join('\n'),
      user: [
        'Business: {{business_name}}',
        'Address: {{business_address}}',
        'Email: {{business_email}}',
        'Website: {{website_url}}',
        'Page Type: {{page_type}}',
        'Brand: {{brand_json}}',
        '',
        'Generate the complete {{page_type}} page HTML.',
      ].join('\n'),
    },
    {
      id: 'score_website',
      version: 1,
      description: 'Score website quality across 8 dimensions',
      models: defaultModels,
      params: { temperature: 0.1, maxTokens: 2048 },
      inputs: { required: ['html_content', 'business_name'], optional: [] },
      outputs: { format: 'json', schema: 'ScoreWebsiteOutput' },
      notes: { threshold: 'Below 0.6 = regenerate' },
      system: [
        'Evaluate this HTML website. Score 0.0-1.0 on:',
        'visual_design, content_quality, completeness, responsiveness,',
        'accessibility, seo, performance, brand_consistency.',
        'Return JSON: { scores{...}, overall, issues[], suggestions[], missing_sections[] }',
      ].join('\n'),
      user: 'Business: {{business_name}}\n\nHTML:\n{{html_content}}\n\nScore this website.',
    },
  ]);
}
