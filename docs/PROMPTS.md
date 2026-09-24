# Project Sites — Prompt Infrastructure Guide

> Documentation for the AI prompt system that powers website generation.

## Overview

The prompt infrastructure provides:
1. **File-based prompts** — `.prompt.md` files with YAML frontmatter
2. **Type-safe rendering** — Template substitution with injection prevention
3. **Version management** — Registry with A/B variant support
4. **Runtime hot-patching** — KV store overrides without redeployment
5. **Observability** — Structured logging, cost estimation, input hashing

## Prompt File Format

Prompts are stored in `apps/project-sites/prompts/*.prompt.md`:

```markdown
---
id: research_profile
version: 1
model: "@cf/meta/llama-3.1-70b-instruct"
max_tokens: 4096
temperature: 0.3
input_schema: ResearchProfileInput
output_schema: ResearchProfileOutput
---

# System
You are a business research analyst. Research the following business
and return a structured JSON profile.

## Output Format
Return valid JSON with these fields:
- business_name: string
- business_type: string
- tagline: string (max 100 chars)
...

# User
Research this business:
Business Name: <<<USER_INPUT>>>{{business_name}}<<<END_USER_INPUT>>>
Address: <<<USER_INPUT>>>{{business_address}}<<<END_USER_INPUT>>>
Phone: <<<USER_INPUT>>>{{business_phone}}<<<END_USER_INPUT>>>
```

### File Format Rules

1. **YAML frontmatter** between `---` delimiters at top of file
2. **# System** section — system prompt template
3. **# User** section — user prompt template
4. **`{{placeholder}}`** — template variables replaced at render time
5. **`<<<USER_INPUT>>>...<<<END_USER_INPUT>>>`** — injection prevention delimiters

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique prompt identifier |
| `version` | number | Yes | Version number (incrementing) |
| `model` | string | Yes | Workers AI model ID |
| `max_tokens` | number | Yes | Maximum output tokens |
| `temperature` | number | Yes | Sampling temperature (0-1) |
| `input_schema` | string | Yes | Name of Zod input schema |
| `output_schema` | string | Yes | Name of Zod output schema |
| `variant` | string | No | A/B variant label ("a", "b") |
| `description` | string | No | Human-readable description |

## Architecture

```
prompts/*.prompt.md          # Source of truth (git-tracked)
     │
     ▼
src/prompts/parser.ts        # Parse YAML + markdown → PromptSpec
     │
     ▼
src/prompts/registry.ts      # Register, version, A/B variant management
     │
     ▼
src/prompts/renderer.ts      # Template substitution + injection prevention
     │
     ▼
src/prompts/schemas.ts       # Zod validation for I/O
     │
     ▼
src/prompts/observability.ts # Logging, cost estimation, input hashing
     │
     ▼
src/services/ai_workflows.ts # Orchestrates LLM calls using all of the above
```

## Source Files

### `src/prompts/types.ts` — Core Types

```typescript
interface PromptSpec {
  id: string;                    // "research_business"
  version: number;               // 1, 2, 3...
  variant?: string;              // "a", "b" for A/B tests
  description: string;
  models: string[];              // ["@cf/meta/llama-3.1-70b-instruct"]
  params: {
    temperature: number;
    maxTokens: number;
  };
  inputs: {
    required: string[];          // ["business_name"]
    optional: string[];          // ["additional_context"]
  };
  outputs: {
    format: 'json' | 'markdown' | 'html' | 'text';
    schema?: string;
  };
  notes: Record<string, string>;
  system: string;                // System prompt template
  user: string;                  // User prompt template
}

type PromptKey = string;         // "id@version" or "id@version:variant"
```

### `src/prompts/parser.ts` — Markdown Parser

**Functions:**
- `parsePromptMarkdown(raw)` — Parse `.prompt.md` file → `PromptSpec`
- `extractFrontmatter(raw)` — Extract YAML frontmatter & body
- `splitSections(body)` — Extract `# System` and `# User` sections
- `parseSimpleYaml(text)` — Minimal YAML parser (scalars, arrays, nested objects)

### `src/prompts/renderer.ts` — Template Renderer

**Functions:**
- `renderPrompt(spec, inputs, options?)` — Full render pipeline:
  1. Validate required inputs present
  2. Replace `{{key}}` placeholders with values
  3. Wrap user input in `<<<USER_INPUT>>>` delimiters
  4. Return `{ system, user, model, params }`
- `renderTemplate(template, values)` — Raw template substitution
- `extractPlaceholders(template)` — Find all `{{key}}` in template
- `validateTemplatePlaceholders(spec)` — Verify all placeholders declared in inputs

### `src/prompts/registry.ts` — Version Registry

**Functions:**
- `register(spec)` — Add prompt to registry
- `registerAll(specs)` — Bulk register
- `resolve(id, version)` — Get prompt by ID + version
- `resolveLatest(id)` — Get highest version
- `resolveVariant(id, version, seed)` — Auto-select A/B variant
- `configureVariants(id, version, weights)` — Set variant weights (sum to 100)
- `loadFromKv(kv, promptIds?)` — Hot-patch from KV store
- `clearRegistry()` — Reset (for testing)
- `getStats()` — Registry statistics

**Key Format:** `promptId@version` (e.g., `research_profile@1`)

**A/B Variant Bucketing:**
```typescript
// Configure: 80% variant A, 20% variant B
configureVariants("site_copy", 3, { a: 80, b: 20 });

// Select: deterministic based on seed
const spec = resolveVariant("site_copy", 3, "user-123");
// → spec.variant === "a" or "b" based on hash(seed + id + version) % 100
```

**KV Hot-Patching:**
```typescript
// At worker startup:
await loadFromKv(env.PROMPT_STORE);

// KV key format: prompt:{id}@{version}
// KV value: raw .prompt.md content
// This overrides the file-based prompt without redeployment
```

### `src/prompts/schemas.ts` — I/O Validation

Defines Zod schemas for every prompt's input and output:

| Prompt ID | Input Fields | Output Fields |
|-----------|-------------|---------------|
| `research_profile` | business_name, address, phone, place_id, context | business_name, tagline, business_type, services[], hours[], faq[], seo_title |
| `research_social` | business_name, address, type | social_links[], website_url, review_platforms[] |
| `research_brand` | business_name, type, address, website_url, context | logo{}, colors{}, fonts{}, brand_personality, style_notes |
| `research_selling_points` | business_name, type, services_json, description, context | selling_points[], hero_slogans[], benefit_bullets[] |
| `research_images` | business_name, type, address, services_json, context | hero_images[], storefront_image, service_images[], placeholder_strategy |
| `generate_website` | profile_json, brand_json, selling_points_json, social_json, images_json | Full HTML document |
| `generate_legal_pages` | business_name, brand_json, page_type, address?, email?, website_url? | Full HTML document |
| `score_website` | html_content, business_name | scores{8 dimensions}, overall, issues[], suggestions[] |

**Usage:**
```typescript
import { validatePromptInput, validatePromptOutput } from '../prompts/schemas.js';

// Throws ZodError if invalid
validatePromptInput('research_profile', inputData);
const validated = validatePromptOutput('research_profile', JSON.parse(output));
```

### `src/prompts/observability.ts` — Call Logging

**Functions:**
- `sha256(data)` — Web Crypto SHA-256 hash
- `hashInputs(inputs)` — Deterministic hash of normalized input values
- `buildCallLog(params)` — Build structured log entry
- `emitCallLog(log)` — Emit via `console.warn`
- `estimateCost(model, inputTokens, outputTokens)` — Token cost estimation
- `withObservability(spec, model, inputs, retryCount, callFn)` — Wrap LLM call

**Log Format:**
```json
{
  "level": "info",
  "service": "ai_workflow",
  "event": "llm_call",
  "promptId": "research_profile",
  "promptVersion": 1,
  "model": "@cf/meta/llama-3.1-70b-instruct",
  "inputHash": "a1b2c3...",
  "latencyMs": 2345,
  "tokenCount": 1024,
  "outcome": "success",
  "retryCount": 0,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

## Prompt Files Inventory

### V2 Pipeline Prompts (current)

Default model routing per `src/services/external_llm.ts`:
- **Heavy lifting (70B equiv)** — `claude-sonnet-4-6` primary; DeepSeek mid-tier fallback; Workers AI Llama 70B instant fallback
- **Light tasks (8B equiv)** — `claude-haiku-4-5` primary; Workers AI Llama 8B instant fallback
- Orchestration layers (architecture, completeness, security) — Opus 4.7

| File | ID | Version | Model tier | Purpose |
|------|----|---------|---------|---------|
| `research_profile.prompt.md` | `research_profile` | 1 | 70B (Sonnet/Deepseek/Llama) | Deep business research |
| `research_social.prompt.md` | `research_social` | 1 | 8B (Haiku/Llama) | Social media discovery |
| `research_brand.prompt.md` | `research_brand` | 1 | 70B (Sonnet/Deepseek/Llama) | Brand identity |
| `research_selling_points.prompt.md` | `research_selling_points` | 1 | 70B (Sonnet/Deepseek/Llama) | USPs + hero content |
| `research_images.prompt.md` | `research_images` | 1 | 8B (Haiku/Llama) | Image strategies |
| `generate_website.prompt.md` | `generate_website` | 1 | 70B (Sonnet/Deepseek/Llama) | Full HTML generation |
| `generate_legal_pages.prompt.md` | `generate_legal_pages` | 1 | 8B (Haiku/Llama) | Privacy/terms pages |
| `score_website.prompt.md` | `score_website` | 1 | 70B (Sonnet/Deepseek/Llama) | Quality scoring |

### Legacy Prompts (v1/v2)

| File | ID | Version | Purpose |
|------|----|---------|---------|
| `research_business.prompt.md` | `research_business` | 2 | Original business research |
| `generate_site.prompt.md` | `generate_site` | 2 | Original site generation |
| `score_quality.prompt.md` | `score_quality` | 2 | Original quality scoring |

### A/B Variant Prompts

| File | ID | Version | Variant | Purpose |
|------|----|---------|---------|---------|
| `site_copy.prompt.md` | `site_copy` | 3 | a | Features-led marketing copy |
| `site_copy_v3b.prompt.md` | `site_copy` | 3 | b | Benefit-led marketing copy |

## Adding a New Prompt

1. **Create the `.prompt.md` file** in `apps/project-sites/prompts/`:
   ```markdown
   ---
   id: my_new_prompt
   version: 1
   model: "@cf/meta/llama-3.1-70b-instruct"
   max_tokens: 2048
   temperature: 0.5
   input_schema: MyNewPromptInput
   output_schema: MyNewPromptOutput
   ---

   # System
   You are a specialist in...

   # User
   Process this: <<<USER_INPUT>>>{{input_field}}<<<END_USER_INPUT>>>
   ```

2. **Add Zod schemas** in `src/prompts/schemas.ts`:
   ```typescript
   const MyNewPromptInput = z.object({
     input_field: z.string().min(1),
   });

   const MyNewPromptOutput = z.object({
     result: z.string(),
   });
   ```

3. **Register the prompt** — it's auto-registered via `registerAllPrompts()` in `src/services/ai_workflows.ts`

4. **Call the prompt** in your workflow:
   ```typescript
   const result = await runPrompt(env, 'my_new_prompt', 1, { input_field: 'value' });
   const validated = validatePromptOutput('my_new_prompt', JSON.parse(result.output));
   ```

5. **Write tests** — add test cases in `src/__tests__/prompt_*.test.ts`

## Testing Prompts

```bash
# Run all prompt-related tests
npm test -- --testPathPattern="prompt"

# Specific test files:
# - prompt_parser.test.ts     — Parser unit tests
# - prompt_renderer.test.ts   — Renderer unit tests
# - prompt_registry.test.ts   — Registry unit tests
# - prompt_schemas.test.ts    — Schema validation tests
# - prompt_observability.test.ts — Observability tests
# - prompt_eval.test.ts       — Integration/eval tests
```
