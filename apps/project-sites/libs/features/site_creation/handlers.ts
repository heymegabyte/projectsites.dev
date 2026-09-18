/**
 * @module libs/features/site_creation/handlers
 *
 * @description
 * The AI-assisted site-creation cluster: turn a business selection into a live
 * site and provide the prompt-tooling the create wizard leans on. `create-from-search`
 * mints the site row (auto-slugged) and kicks off the generation workflow;
 * `improve-prompt`/`generate-prompt` shape the build prompt via Workers AI; and
 * `categorize` classifies the business (driving template/vertical selection).
 *
 * | Method | Path                            | Auth  | Purpose                                              |
 * | ------ | ------------------------------- | ----- | ---------------------------------------------------- |
 * | POST   | /api/sites/create-from-search   | org   | Create a site + start the AI generation workflow     |
 * | POST   | /api/sites/improve-prompt       | org   | AI-improve a user's build prompt                     |
 * | POST   | /api/sites/generate-prompt      | org   | AI-generate a build prompt from business context     |
 * | POST   | /api/ai/categorize              | org   | AI-classify a business (template/vertical selection) |
 *
 * Extracted VERBATIM from the `search.ts` monolith (route-decomposition
 * installment 27) — only the route-registration receiver changed (`search.` →
 * `siteCreation.`). The exclusive `generateSmartSlug` (AI slug from a business
 * name) and `ensureUniqueSlug` (R2-manifest uniqueness check) helpers moved here.
 * NOTE: a same-named but SEPARATE `ensureUniqueSlug` lives in `src/routes/api.ts`
 * (its own R2-manifest checker) — a pre-existing duplication left as-is; this is
 * search.ts's local copy. Uses search.ts's own scaffolding (inline `c.get('orgId')`
 * + explicit 401, no `onError`) — NOT `ai_admin_kit`.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { badRequest, unauthorized, sanitizeHtml, stripHtml } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { dbInsert, dbQueryOne } from '../../../src/services/db.js';
import { writeAuditLog } from '../../../src/services/audit.js';
import { runObservedWorkersAI } from '../../../src/lib/workers_ai.js';
import { isThemeStyleName } from '../../../src/services/theme_style.js';
import { createFromSearchSchema } from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteCreation = new Hono<AppContext>();

siteCreation.post('/api/sites/create-from-search', async (c) => {
  const orgId = c.get('orgId');

  if (!orgId) {
    throw unauthorized('Must be authenticated');
  }

  // Check build limits (1 free, then $50/mo per site).
  const { checkBuildLimit, resolveActiveOrgPlan } = await import('../../../src/services/build_limits.js');
  const plan = await resolveActiveOrgPlan(c.env.DB, orgId);
  const limitCheck = await checkBuildLimit(c.env.DB, orgId, plan);
  if (!limitCheck.allowed) {
    c.executionCtx.waitUntil(
      writeAuditLog(c.env.DB, {
        org_id: orgId,
        actor_id: c.get('userId') ?? null,
        action: 'build_limit.exceeded',
        message: `Build limit reached for org '${orgId}' (used ${limitCheck.used}/${limitCheck.limit} on '${plan ?? 'free'}' plan)`,
        target_type: 'org',
        target_id: orgId,
        metadata_json: {
          used: limitCheck.used,
          limit: limitCheck.limit,
          plan: plan ?? 'free',
        },
        request_id: c.get('requestId'),
      }),
    );
    return c.json(
      {
        error: {
          code: 'BUILD_LIMIT_REACHED',
          message: `You've used ${limitCheck.used} of ${limitCheck.limit} ${limitCheck.limit === 1 ? 'site' : 'sites'}. ${limitCheck.limit === 1 ? 'Free accounts include 1 site — add more for $50/month per site.' : 'Contact support to raise your site ceiling.'}`,
        },
      },
      403,
    );
  }

  // Zod-validate the boundary (AL-724): this is the core funnel entry — a wrong-typed field
  // (e.g. `business_type: 12345`) must fail-soft as a 400, never crash 500 via `(12345).trim()`
  // nor lying-success persist a number into a TEXT column that throws downstream. safeParse →
  // 400 (matches the contact_newsletter sibling idiom), never throws.
  const parsed = createFromSearchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw badRequest(
      `Invalid request body: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'} — ${i.message}`)
        .slice(0, 5)
        .join('; ')}`,
    );
  }
  const body = parsed.data;

  // Normalize both v1 (flat) and v2 (nested business object) payload formats.
  const mode = body.mode ?? null;
  const businessName =
    body.business?.name || body.business_name || (mode === 'custom' ? 'Custom Website' : null);
  const businessAddress = body.business?.address || body.business_address;
  const businessHours = body.business?.hours || body.business_hours;
  const googlePlaceId = body.business?.place_id || body.google_place_id;
  const businessPhone = body.business?.phone || body.business_phone || null;
  const businessEmail = body.business?.email || body.business_email || null;
  // Declared vertical (fire-55/76) — PERSISTED on the sites row (migration 0632, for /reset
  // re-threading) AND passed to the workflow. Mirrors the NAP flat-key chain: Places type →
  // flat business_type → flat business_category → nested. Now type-safe (schema-validated),
  // so the former `as string | undefined` casts are gone (AL-724).
  const businessCategory =
    body.business?.types?.[0] ??
    body.business_type ??
    body.business_category ??
    body.business?.category ??
    null;

  if (!businessName || businessName.trim().length === 0) {
    throw badRequest('Missing required field: business_name (or business.name)');
  }

  if (businessName.length > 200) {
    throw badRequest('Business name must be 200 characters or fewer');
  }

  const additionalContext = body.additional_context
    ? sanitizeHtml(String(body.additional_context).slice(0, 5000))
    : null;

  // Explicit visual personality (AL-467): the /create form's deliberate per-category
  // choice, forwarded ONLY when it is a valid preset name so the workflow can prefer
  // it over re-deriving from `additional_context` prose. Invalid/absent → undefined →
  // the workflow's derivation fallback runs, byte-identical to prior behavior.
  const themeStyle = isThemeStyleName(body.theme_style)
    ? String(body.theme_style).trim().toLowerCase()
    : undefined;

  if (businessAddress && String(businessAddress).length > 500) {
    throw badRequest('Business address must be 500 characters or fewer');
  }

  if (businessHours && String(businessHours).length > 300) {
    throw badRequest('Business hours must be 300 characters or fewer');
  }

  const sanitizedName = stripHtml(businessName).trim();
  if (!sanitizedName) {
    throw badRequest('Business name cannot be empty after sanitization');
  }

  if (mode) {
    console.warn(`[create-from-search] mode=${mode}, business=${sanitizedName}`);
  }

  const baseSlug = await generateSmartSlug(c.env, sanitizedName, businessAddress);

  // Ensure slug uniqueness across D1 (sites table) + R2 published content.
  const slug = await ensureUniqueSlug(c.env, baseSlug);

  const siteId = crypto.randomUUID();

  const site = {
    id: siteId,
    org_id: orgId,
    slug,
    business_name: sanitizedName,
    business_phone: businessPhone,
    business_email: businessEmail,
    business_category: businessCategory,
    business_hours: businessHours ?? null,
    business_address: businessAddress ?? null,
    google_place_id: googlePlaceId ?? null,
    bolt_chat_id: null,
    current_build_version: null,
    status: 'building',
    lighthouse_score: null,
    lighthouse_last_run: null,
    deleted_at: null,
  };

  const result = await dbInsert(c.env.DB, 'sites', site);

  if (result.error) {
    throw badRequest(`Failed to create site: ${result.error}`);
  }

  let workflowInstanceId: string | null = null;
  if (c.env.SITE_WORKFLOW) {
    const instance = await c.env.SITE_WORKFLOW.create({
      id: siteId,
      params: {
        siteId,
        slug,
        businessName: sanitizedName,
        businessAddress: businessAddress ?? undefined,
        businessHours: businessHours ?? undefined,
        businessEmail: businessEmail ?? undefined,
        businessPhone: businessPhone ?? undefined,
        // Authoritative vertical signal (fire-55): Google Places type, else the flat
        // `business_type` / `business_category` (or nested `business.category`) a caller
        // declares — the loop + any typed-create path. Threaded to the container as the
        // immutable _category.txt so pickVerticalPreset short-circuits on it (orchestrator-
        // proof, unlike the clobberable _brand.json category) AND drives the identity-woven
        // About/SERVICES copy. fire-76 root-cause: the loop sends `business_category`, but
        // only `business_type` was read here → the explicit category was DROPPED on EVERY
        // create (weave fell back to "local service", classification to fragile name-
        // inference — the "Harvest & Vine → nonprofit" class). Mirror the NAP flat-key chain.
        businessCategory: businessCategory ?? undefined,
        // AL-467: authoritative theme signal (the /create form's deliberate pick);
        // the workflow prefers it over re-deriving the personality from prose.
        themeStyle,
        googlePlaceId: googlePlaceId ?? undefined,
        additionalContext: additionalContext ?? undefined,
        uploadId: (body as Record<string, unknown>).upload_id as string | undefined,
        orgId: orgId,
      },
    });
    workflowInstanceId = instance.id;
  } else if (c.env.QUEUE) {
    // Fallback to queue when the workflow binding is unavailable. The message MUST
    // carry the SAME authoritative fields SITE_WORKFLOW.create receives — most
    // critically the unique `slug` (from ensureUniqueSlug, may carry a `-N` suffix).
    // The queue consumer uploads the build to `sites/${slug}/${version}/…`; if `slug`
    // is omitted it recomputes one from business_name → a DIFFERENT prefix than the
    // serving path resolves by the D1 `sites.slug` → the "published" site 404s.
    // Address + phone feed V2 research; dropping them silently degrades the site.
    await c.env.QUEUE.send({
      job_name: 'generate_site',
      site_id: siteId,
      slug,
      business_name: sanitizedName,
      business_address: businessAddress ?? null,
      business_hours: businessHours ?? null,
      business_email: businessEmail ?? null,
      business_phone: businessPhone ?? null,
      google_place_id: googlePlaceId ?? null,
      additional_context: additionalContext,
      // AL-467: carry the authoritative theme signal on the queue-fallback message too
      // (contract parity with SITE_WORKFLOW.create above) so the consumer can honor it.
      theme_style: themeStyle ?? null,
    });
  }

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'site.created_from_search',
    message: `Site '${slug}' created from search for '${sanitizedName}'`,
    target_type: 'site',
    target_id: siteId,
    metadata_json: {
      business_name: sanitizedName,
      slug,
      google_place_id: googlePlaceId ?? null,
      business_address: businessAddress ?? null,
      mode,
    },
    request_id: c.get('requestId'),
  });

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'workflow.queued',
    message: `AI build pipeline queued for '${slug}' — research, generate, and deploy`,
    target_type: 'site',
    target_id: siteId,
    metadata_json: {
      business_name: sanitizedName,
      slug,
      workflow_instance_id: workflowInstanceId ?? null,
      has_additional_context: !!additionalContext,
    },
    request_id: c.get('requestId'),
  });

  // Log anticipated build phases so the Logs modal shows pipeline stages.
  const buildPhases = [
    {
      action: 'workflow.phase.research',
      message: `Build phase 1 (research) queued for '${slug}'`,
    },
    {
      action: 'workflow.phase.generation',
      message: `Build phase 2 (AI generation) queued for '${slug}'`,
    },
    {
      action: 'workflow.phase.deployment',
      message: `Build phase 3 (CDN deploy + publish) queued for '${slug}'`,
    },
  ];
  for (const phase of buildPhases) {
    await writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: phase.action,
      message: phase.message,
      target_type: 'site',
      target_id: siteId,
      metadata_json: {
        slug,
        workflow_instance_id: workflowInstanceId ?? null,
      },
      request_id: c.get('requestId'),
    }).catch(() => {});
  }

  return c.json(
    {
      data: {
        site_id: siteId,
        slug,
        status: 'building',
        workflow_instance_id: workflowInstanceId,
      },
    },
    201,
  );
});

// ─── Improve Prompt with AI ─────────────────────────────────
siteCreation.post('/api/sites/improve-prompt', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const businessName = typeof body.business_name === 'string' ? body.business_name.trim() : '';
  const businessAddress =
    typeof body.business_address === 'string' ? body.business_address.trim() : '';

  if (text.length > 5000) {
    throw badRequest('Text must not exceed 5000 characters');
  }

  let systemPrompt: string;
  let userPrompt: string;

  if (!text) {
    // No text provided — generate a template with placeholders.
    systemPrompt =
      'You are a professional website copywriter and business consultant. ' +
      'Generate a comprehensive business profile template for a small business portfolio website. ' +
      'Use placeholders in [BRACKETS] for information the business owner needs to fill in. ' +
      'Include sections for: business description, services/products offered, business hours, ' +
      'contact information (phone, email, physical address), about the owner/team, ' +
      'and any unique selling points. Make it professional and ready to customize. ' +
      'Return ONLY the template text, nothing else.';

    userPrompt =
      'Generate a business profile template with placeholders for a small business website.';
    if (businessName) {
      userPrompt += '\n\nBusiness name: ' + businessName;
    }
    if (businessAddress) {
      userPrompt += '\nBusiness address: ' + businessAddress;
    }
  } else {
    systemPrompt =
      'You are a professional website copywriter and business consultant. ' +
      'Your job is to take rough notes about a business and improve them into clear, well-structured ' +
      'information that would help an AI build a great website. ' +
      'Fix grammar, spelling, and formatting. Organize the information logically. ' +
      'Where information seems missing or incomplete, insert placeholders in [BRACKETS] and ' +
      'add a brief comment about what should go there. ' +
      'Keep the same general meaning but make it professional and comprehensive. ' +
      'Return ONLY the improved text, nothing else.';

    userPrompt = 'Here is the rough text to improve:\n\n' + text;
    if (businessName) {
      userPrompt += '\n\nBusiness name: ' + businessName;
    }
    if (businessAddress) {
      userPrompt += '\nBusiness address: ' + businessAddress;
    }
  }

  try {
    const ai = c.env.AI;
    if (!ai) {
      // Fallback: static template if AI binding not available.
      const fallbackText =
        text ||
        (businessName ? businessName + ' — ' : '[Business Name] — ') +
          'Welcome to our business!\n\n' +
          '[Brief description of what your business does]\n\n' +
          'Services:\n- [Service 1]\n- [Service 2]\n- [Service 3]\n\n' +
          'Hours: [Mon-Fri 9AM-5PM]\n' +
          'Phone: [Your phone number]\n' +
          'Email: [Your email address]\n' +
          'Address: ' +
          (businessAddress || '[Your business address]');
      return c.json({ data: { improved_text: fallbackText } });
    }

    const result = await runObservedWorkersAI(
      c.env,
      '@cf/meta/llama-3.1-8b-instruct-fp8',
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      },
      {
        distinctId: c.get('orgId') ?? c.get('userId') ?? 'anon',
        promptId: 'ai_improve_prompt',
        traceId: c.get('requestId'),
      },
    );

    const improved =
      typeof result === 'object' && result !== null && 'response' in result
        ? String((result as { response: string }).response).trim()
        : text;

    return c.json({ data: { improved_text: improved || text } });
  } catch {
    // On AI failure, return original text rather than error.
    return c.json({ data: { improved_text: text } });
  }
});

// ─── Generate Expert Prompt (OpenAI Research → bolt.diy Prompt) ──

siteCreation.post('/api/sites/generate-prompt', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');

  if (!userId || !orgId) {
    throw unauthorized('Authentication required');
  }

  const body = await c.req.json().catch(() => ({}));
  const businessName = typeof body.business_name === 'string' ? body.business_name.trim() : '';
  const businessAddress =
    typeof body.business_address === 'string' ? body.business_address.trim() : '';
  const businessPhone = typeof body.business_phone === 'string' ? body.business_phone.trim() : '';
  const googlePlaceId = typeof body.google_place_id === 'string' ? body.google_place_id.trim() : '';
  const additionalContext =
    typeof body.additional_context === 'string' ? body.additional_context.trim() : '';
  const siteId = typeof body.site_id === 'string' ? body.site_id.trim() : '';

  if (!businessName) {
    throw badRequest('business_name is required');
  }

  if (!c.env.OPENAI_API_KEY) {
    throw badRequest('OpenAI API key is not configured. Cannot run research pipeline.');
  }

  const { researchAndFormulatePrompt } = await import('../../../src/services/openai_research.js');

  const result = await researchAndFormulatePrompt(c.env, {
    businessName,
    businessAddress: businessAddress || undefined,
    businessPhone: businessPhone || undefined,
    googlePlaceId: googlePlaceId || undefined,
    additionalContext: additionalContext || undefined,
  });

  // If a site ID was provided, store the research data in R2.
  if (siteId) {
    const site = await dbQueryOne<{ slug: string; current_build_version: string | null }>(
      c.env.DB,
      'SELECT slug, current_build_version FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [siteId, orgId],
    );

    if (site) {
      const version = site.current_build_version || new Date().toISOString().replace(/[:.]/g, '-');
      await c.env.SITES_BUCKET.put(
        `sites/${site.slug}/${version}/research.json`,
        JSON.stringify(
          {
            profile: result.profile,
            brand: result.brand,
            sellingPoints: result.sellingPoints,
            social: result.social,
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: 'application/json' } },
      );
    }
  }

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'research.generate_prompt',
    message: `Generated AI research prompt for '${businessName}'`,
    target_type: 'site',
    target_id: siteId || null,
    metadata_json: { business_name: businessName, model: c.env.RESEARCH_MODEL || 'o3-mini' },
  }).catch(() => {
    /* best-effort */
  });

  return c.json({
    data: {
      prompt: result.expertPrompt,
      research: {
        profile: result.profile,
        brand: result.brand,
        sellingPoints: result.sellingPoints,
        social: result.social,
      },
    },
  });
});

// ─── Slug Uniqueness Helper ──────────────────────────────────

/**
 * Generate a smart, AI-calculated slug that is the shortest meaningful
 * representation of the business name + location differentiator.
 *
 * Examples:
 * - "Trader Joe's" at "3056 NJ-10, Denville, NJ" → "trader-joes-denville"
 * - "When Doody Calls - Pooper Scoopers" → "when-doody-calls"
 * - "Vito's Mens Salon" → "vitos-mens-salon"
 *
 * Falls back to simple slugification if AI is unavailable.
 */
async function generateSmartSlug(
  env: Env,
  businessName: string,
  address?: string,
): Promise<string> {
  const simpleSlug =
    businessName
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63) || `site-${Date.now().toString(36)}`;

  try {
    const result = await env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct-fp8' as Parameters<typeof env.AI.run>[0],
      {
        messages: [
          {
            role: 'system',
            content: `Generate the shortest, simplest URL slug for a business website. Rules:
- Output ONLY the slug, nothing else. No explanation.
- Use lowercase letters, numbers, and hyphens only.
- Remove possessives ('s → s), articles (the, a, an), and filler words.
- For chain businesses (Trader Joe's, McDonald's, Starbucks), include a location differentiator (neighborhood or city name).
- For unique businesses, just use the core business name (2-4 words max).
- Remove subtitles/taglines after dashes unless they ARE the brand name.
- Maximum 40 characters, prefer under 25.

Examples:
"Trader Joe's" at "3056 NJ-10, Denville, NJ 07834" → trader-joes-denville
"Trader Joe's - Hell's Kitchen" at "435 W 42nd St, NY" → trader-joes-hells-kitchen
"When Doody Calls - Pooper Scoopers" at "Dallas, TX" → when-doody-calls
"Vito's Mens Salon" at "74 N Beverwyck Rd, Lake Hiawatha, NJ" → vitos-mens-salon
"The White House" at "1600 Pennsylvania Ave, DC" → the-white-house
"McDonald's" at "789 Broadway, New York, NY" → mcdonalds-broadway-nyc`,
          },
          {
            role: 'user',
            content: `Business: "${businessName}"${address ? `\nAddress: "${address}"` : ''}`,
          },
        ],
        max_tokens: 50,
      },
    );

    const response = ((result as { response?: string }).response ?? '').trim();
    const aiSlug = response
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);

    if (aiSlug && aiSlug.length >= 3 && aiSlug.length <= 63 && /^[a-z0-9]/.test(aiSlug)) {
      return aiSlug;
    }
  } catch {
    // AI unavailable — fall through to simple slug.
  }

  return simpleSlug;
}

/**
 * Ensure the slug is unique across D1 and R2. Appends an incrementing suffix
 * (-2, -3, …) if taken; falls back to a random suffix after 10 attempts.
 */
async function ensureUniqueSlug(env: Env, slug: string): Promise<string> {
  let candidate = slug;

  for (let attempt = 0; attempt < 10; attempt++) {
    // Include deleted rows — the unique constraint spans all rows.
    const existingInDb = await dbQueryOne<{ id: string }>(
      env.DB,
      'SELECT id FROM sites WHERE slug = ?',
      [candidate],
    );

    if (!existingInDb) {
      // Also check R2 for orphaned content.
      const manifestInR2 = await env.SITES_BUCKET.get(`sites/${candidate}/_manifest.json`);
      if (!manifestInR2) {
        return candidate;
      }
    }

    candidate = `${slug}-${attempt + 2}`;
  }

  return `${slug}-${Date.now().toString(36).slice(-4)}`;
}

/** AI-powered business categorization into one of the predefined categories. */
siteCreation.post('/api/ai/categorize', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name: string;
    address?: string;
    types?: string[];
  };
  if (!body.name) {
    return c.json({ data: { category: '' } });
  }

  const categories = [
    'Restaurant / Café',
    'Salon / Barbershop',
    'Legal / Law Firm',
    'Medical / Healthcare',
    'Retail / Shop',
    'Technology / SaaS',
    'Construction / Home Services',
    'Fitness / Gym',
    'Real Estate',
    'Photography / Creative',
    'Automotive',
    'Education / Tutoring',
    'Financial / Accounting',
    'Other',
  ];

  try {
    const prompt = `Classify this business into exactly one category. Respond with ONLY the category name, nothing else.

Business: "${body.name}"${body.address ? ` at ${body.address}` : ''}${body.types?.length ? ` (types: ${body.types.join(', ')})` : ''}

Categories: ${categories.join(', ')}

Category:`;

    const result = (await runObservedWorkersAI(
      c.env,
      '@cf/meta/llama-3.1-8b-instruct-fp8',
      {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 30,
        temperature: 0,
      },
      {
        distinctId: c.get('orgId') ?? c.get('userId') ?? 'anon',
        promptId: 'ai_categorize',
        traceId: c.get('requestId'),
      },
    )) as { response?: string };

    const raw = (result.response || '').trim();
    const matched =
      categories.find((cat) => raw.includes(cat)) ||
      categories.find((cat) => raw.toLowerCase().includes(cat.toLowerCase().split(' / ')[0])) ||
      '';

    return c.json({ data: { category: matched } });
  } catch (err) {
    console.warn('[ai/categorize] AI call failed:', err);
    return c.json({ data: { category: '' } });
  }
});
