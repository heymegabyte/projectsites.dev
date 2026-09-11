/**
 * @module workflows/site-generation
 * @description Cloudflare Workflow for AI-powered site generation.
 *
 * Architecture: Heartbeat polling with async container execution.
 * 1. POST /build to container → starts Claude Code async, returns { jobId }
 * 2. Poll GET /status every 30s via tiny workflow steps (no timeout risk)
 * 3. GET /result when complete → upload files to R2 → update D1
 *
 * Claude Code handles EVERYTHING in a single run:
 * - Business research via curl + API keys
 * - Logo discovery / generation
 * - Website building from template (Vite+React+Tailwind)
 * - GPT-4o self-inspection via inspect.js
 * - Iterative fixes
 *
 * @packageDocumentation
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/env.js';
import { DOMAINS, AppError } from '@project-sites/shared';
import { gatewayFetch } from '../services/ai_gateway.js';
import { loadBuildFromR2, validateBuild } from '../services/build_validators.js';
import { scoreReadiness } from '../services/production_readiness.js';
import { postAskUser } from '../services/task_inbox.js';
import { appendBuildEvent, type BuildEvent } from '../services/build_events.js';
import { checkBudget, recordSpend } from '../services/build_budget.js';
import { resolveActiveOrgPlan } from '../services/build_limits.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { tryEmitEvent } from '../services/emit_event.js';
import { themeStyleFromInputs, personalityBriefFor } from '../services/theme_style.js';

/**
 * Per-variant omit of the auto-injected base fields, distributed across the
 * discriminated union so each variant keeps its own discriminator + payload.
 * A plain `Omit<BuildEvent, ...>` collapses the union and trips excess-property
 * checks; this distributive form preserves the per-`type` shape.
 */
type BuildEventBody = BuildEvent extends infer T
  ? T extends BuildEvent
    ? Omit<T, 'buildId' | 'ts' | 'featureSlug'>
    : never
  : never;

/**
 * Emit an event-sourced build-progress event (best-effort, never throws).
 *
 * Keyed by `siteId` so the cockpit subscribes via `/api/sites/:id/build/*`
 * with the id it already has. Validates via `BuildEventSchema` inside
 * `appendBuildEvent`; a malformed event is swallowed here so build progress
 * never breaks the workflow. See feature module `libs/features/build_progress/`.
 */
async function emitBuildEvent(env: Env, siteId: string, event: BuildEventBody): Promise<void> {
  try {
    await appendBuildEvent(env, {
      ...event,
      buildId: siteId,
      ts: new Date().toISOString(),
      featureSlug: 'build_progress',
    } as BuildEvent);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'workflow',
        message: 'Failed to emit build event',
        siteId,
        type: (event as { type?: string }).type,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Update site status in D1 (best-effort, never throws). */
async function updateSiteStatus(db: D1Database, siteId: string, status: string): Promise<void> {
  try {
    await db
      .prepare("UPDATE sites SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(status, siteId)
      .run();
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'workflow',
        message: 'Failed to update site status',
        siteId,
        status,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Notify the org owner that a build failed, via the typed psnotify `build.failed`
 * event (bell + channels). Best-effort: any failure is swallowed so it never
 * affects the workflow's own error handling.
 *
 * @param env - Worker bindings (needs DB for delivery).
 * @param orgId - The org whose owner is notified.
 * @param siteId - The site that failed to build.
 * @param reason - Human-readable failure reason.
 */
async function notifyBuildFailed(
  env: Env,
  orgId: string,
  siteId: string,
  reason: string,
): Promise<void> {
  try {
    const { notifyOwnerEvent } = await import('../services/notify.js');
    await notifyOwnerEvent(env, env.DB, {
      orgId,
      event: { event: 'build.failed', tenantId: orgId, siteId, error: reason || 'unknown error' },
    });
  } catch {
    /* bell is best-effort */
  }
}

/** Write a workflow audit log entry (best-effort, never throws). */
async function workflowLog(
  db: D1Database,
  orgId: string,
  siteId: string,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // Heartbeat actions are pure noise — the audit page filters them out anyway.
  // Don't bother persisting them.
  if (action === 'workflow.heartbeat' || action === 'workflow.stub_heartbeat') {
    return;
  }
  try {
    // Lift a `message` key out of metadata so it lands in the new dedicated
    // column. Falls back to a synthesised one from the action namespace when
    // the caller omitted it.
    const { message: rawMessage, ...restMeta } = metadata as { message?: unknown } & Record<
      string,
      unknown
    >;
    const message =
      typeof rawMessage === 'string' && rawMessage.trim().length > 0
        ? rawMessage.trim().slice(0, 500)
        : action.replace(/^workflow\./, 'Workflow ').replace(/_/g, ' ');
    const enrichedMeta = { ...restMeta, site_id: siteId };
    await db
      .prepare(
        `INSERT INTO audit_logs (id, org_id, actor_id, action, message, target_type, target_id, metadata_json, created_at)
         VALUES (?, ?, NULL, ?, ?, 'site', ?, ?, datetime('now'))`,
      )
      .bind(crypto.randomUUID(), orgId, action, message, siteId, JSON.stringify(enrichedMeta))
      .run();
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'workflow',
        message: 'Failed to write workflow audit log',
        action,
        siteId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Parameters passed when creating a workflow instance. */
export interface SiteGenerationParams {
  siteId: string;
  slug: string;
  businessName: string;
  businessAddress?: string;
  businessHours?: string;
  businessEmail?: string;
  businessPhone?: string;
  businessCategory?: string;
  businessWebsite?: string;
  googlePlaceId?: string;
  additionalContext?: string;
  uploadedAssets?: string[];
  uploadId?: string;
  orgId: string;
  /** Diagnostic: skip Claude Code, write a static index.html, upload to R2. */
  minimalMode?: boolean;
  /** Diagnostic: hit /build-stub (no API cost) to validate KV-callback persistence. */
  stubMode?: boolean;
}

/** Container status response shape. */
interface ContainerStatus {
  status: 'running' | 'complete' | 'error';
  step: string;
  elapsed: number;
  fileCount: number;
  error: string | null;
}

/** Container result response shape. */
interface ContainerResult {
  status: string;
  files: { name: string; content: string }[];
  error?: string;
}

/** KV-backed build status record (written by /api/internal/build-status). */
interface KvBuildRecord {
  jobId: string;
  status: 'running' | 'complete' | 'error';
  step: string;
  elapsed: number;
  fileCount: number;
  error: string | null;
  uploadResult: { uploaded?: number; failed?: number; version?: string } | null;
  lastUpdate: number;
}

/**
 * Whether a container-reported build error is a TRANSIENT "produced no usable output"
 * failure that a fresh re-run can recover — vs a deterministic fault a re-run won't fix.
 *
 * The two transient classes (loop FIRE-74→79): the DeepSeek orchestrator crashing
 * (`claude_exit=1` → 0 files → "R2 upload … uploaded 0 files") and npm install/build
 * flaking (network/resource kill). Both leave the build with NO output, so re-running on
 * a FRESH DO is a clean fresh attempt, not a double-charge for completed work. The match
 * is deliberately narrow — a validator-gate failure or a real code fault (which a re-run
 * reproduces) is NOT transient and must fail fast.
 */
export function isTransientBuildError(err: string | null | undefined): boolean {
  const e = String(err || '').toLowerCase();
  return (
    e.includes('claude_exit') ||
    e.includes('uploaded 0 files') ||
    e.includes('produced no dist') ||
    e.includes('npm install failed') ||
    e.includes('npm build failed')
  );
}

/**
 * Build the orchestrator prompt for Claude Code.
 *
 * The orchestrator does NOT implement components itself. It delegates to
 * specialist subagents in parallel via the Task tool, then routes their
 * findings to fix-capable specialists. Universal agents come from
 * megabytespace/claude-skills (synced into ~/.claude/agents/), project agents
 * are layered on top via the Dockerfile COPY.
 *
 * @see ~/.agentskills/15-site-generation/ for methodology
 * @see /home/cuser/.claude/CLAUDE.md for inherited base instructions
 */
export function buildPrompt(params: SiteGenerationParams): string {
  const safeName = (params.businessName || 'Business').replace(/[^\w\s\-'.]/g, '').slice(0, 100);
  const category = params.businessCategory || 'general business';
  const address = params.businessAddress || '';
  const phone = params.businessPhone || '';
  const website = params.businessWebsite || '';
  const slug = params.slug;

  // AL-356 — surface the DETERMINISTIC theme personality's CONTENT design language
  // (imagery mood / copy tone / section emphasis / motion) to the orchestrator. The
  // CSS side (fonts/color/motion/data-style flourish) is already handled by the
  // template + the _brand.json.themeStyle seed; this makes the CONTENT choices
  // reinforce the personality too, so a noir steakhouse gets candlelit imagery +
  // evocative copy instead of bright stock + flat corporate lines. Omitted (empty
  // block, `.filter(Boolean)` drops it) when the vertical doesn't resolve to a
  // personality — byte-identical to pre-AL-356 for those builds.
  const themeStyle = themeStyleFromInputs(params.businessCategory, params.additionalContext);
  const personalityBrief = personalityBriefFor(themeStyle);

  return [
    `# Mission: Orchestrate a BREATHTAKINGLY GORGEOUS website for "${safeName}"`,
    '',
    '## Inherited Instructions',
    'Your ~/.claude/CLAUDE.md @-imports the upstream megabytespace/claude-skills CLAUDE.md, AGENTS.md, and _router.md. Follow the orchestrator overlay there. This prompt is the per-build dispatch — the meta surface controls HOW.',
    '',
    '## Skills',
    'Load ~/.agentskills/_router.md, then skill 15 (~/.agentskills/15-site-generation/) IN FULL — research pipeline, media acquisition, build prompts, quality gates, domain features, template system. Skill 15 governs methodology.',
    '',
    '## Business Data',
    `Business: ${safeName}`,
    `Category: ${category}`,
    `Slug: ${slug}`,
    `Site URL: https://${slug}${DOMAINS.SITES_SUFFIX}`,
    address ? `Address: ${address}` : '',
    phone ? `Phone: ${phone}` : '',
    website ? `Website: ${website}` : '',
    params.googlePlaceId ? `Google Place ID: ${params.googlePlaceId}` : '',
    '',
    '## Context Files (read ALL before delegating)',
    '_research.json, _brand.json, _scraped_content.json, _assets.json, _image_profiles.json, _videos.json, _places.json, _form_data.json, _domain_features.json, _citations.json',
    '',
    '## TEMPLATE-FIRST BUILD — customize, do NOT regenerate (hard budget: under 14 minutes)',
    "The Cloudflare Workers Container is KILLED at ~15 minutes wall-clock, so this build MUST finish under 14. The template in ~/template/ is ALREADY a complete, gorgeous, WCAG-2.2-AA, multi-page site (Stripe/Linear/Vercel polish, animations, dark theme, SEO scaffolding baked in). Your job is MINOR CUSTOMIZATION of that template with this business's real data — NOT a from-scratch rebuild and NOT a multi-subagent audit swarm (there is no time for either). Do the work DIRECTLY.",
    '',
    personalityBrief
      ? `## Visual Personality: ${String(themeStyle).toUpperCase()} — reinforce it in CONTENT, not just CSS\nThe template already stamps this personality's fonts, color, radius, shadow, motion, and a matching flourish via data-style="${themeStyle}" — that side is DONE, do not fight it. Your job is to make the CONTENT match so the site reads as a real, elaborate brand and not a recolored template: ${personalityBrief}\nWhen you wire hero + section images from _assets.json and write copy, pick the ones that fit this personality — generic bright stock or flat corporate copy on a ${themeStyle} theme is a quality miss, not a neutral choice.`
      : '',
    '',
    '## Build steps (do these IN ORDER, directly — no fan-out)',
    `0. _brand.json is ALREADY MATERIALIZED for you — the workflow wrote the real business data (name="${safeName}") into the build dir's _brand.json. NEVER rewrite or regenerate it; the template's shipped copy has {BUSINESS_NAME} placeholders and overwriting it ships those placeholders LIVE. Read it, use it.`,
    '1. Read the essential context: _brand.json, _scraped_content.json, _research.json, _assets.json, _domain_features.json.',
    '2. Customize ~/template/ IN PLACE (`cd` into the build dir):',
    '   - Brand: apply colors + logo from _brand.json to the theme tokens.',
    '   - Fonts (the #1 theme signal — headings must NEVER compute to system-ui): the template now AUTO-LOADS the theme fonts at runtime — `src/brand.ts` (`applyBrand`) injects the Google Fonts `<link id="ps-theme-fonts">` for whatever heading/body/mono the theme resolves and applies `var(--font-heading)` / `var(--font-body)` to headings + body. You do NOT need to hand-edit `<head>` for fonts. The per-vertical theme preset already picks an elaborate DISPLAY face (Oswald for bold fitness, Playfair Display / Cormorant Garamond for luxe & heritage, Fraunces for boutique, Cinzel for after-dark) — LET IT WIN. Do NOT override the heading font with a generic near-Inter; a distinctive display heading is what makes the theme read as a real brand, not a template. (If the ADDITIONAL CONTEXT below names specific theme fonts, they are already loaded — just keep them.)',
    "   - Copy: replace EVERY template placeholder with the business's real content (_scraped_content.json + _research.json) on every page — hero, about, services, contact. No lorem ipsum, no placeholder text left behind.",
    `   - Hero H1 MUST name what THIS business actually is + does — grounded in _brand.json business.name + business.category (="${params.businessCategory || 'the seeded vertical'}"). It is the FIRST thing a visitor + every SEO/AI crawler reads; a generic or WRONG-VERTICAL headline is a build FAILURE, not a stylistic nit. NEVER ship cross-vertical filler: a cocktail lounge headline is NOT "Fresh flavors, made from scratch" (that is restaurant copy), a fine-jewelry headline is NOT "Gear built for how you live" (that is fitness/apparel copy) — both real defects shipped 2026-09. The H1 must be unmistakably about "${safeName}" and its category; if you cannot tell the vertical from the H1 alone, rewrite it.`,
    '   - Images: wire _assets.json images into the hero + sections (>=6 on home, >=4 per sub-page).',
    '   - Domain sections: add the sections _domain_features.json calls for (menu / booking / donation / local-business) as NEW files in src/components/sections/.',
    "   - SEO head per route (in the PRERENDERED HTML <head>, NOT script-injected): title 50-60 chars, meta description 120-156 chars, canonical, OG image, AND >=4 real JSON-LD blocks — WebSite + Organization + WebPage + BreadcrumbList minimum (LocalBusiness too when it is a physical business). Use straight quotes/apostrophes in meta content (never a backslash-escaped \\' — that ships literal to crawlers). A deterministic finalizer backstops JSON-LD + escapes, but WRITE them correctly here so the copy is business-specific, not generic.",
    '3. `npm run build`. Fix any build errors before continuing.',
    '4. ONE validation pass: `node /home/cuser/run-validators.mjs dist`. Fix ONLY the reported blockers (the 13 build-breaking codes: manifest/asset/image/og/icon/meta/jsonld/html/sitemap/copy/js/lightbox), then re-run ONCE to confirm `blockers === 0`.',
    '5. `node /home/cuser/upload-to-r2.mjs` to publish. Env vars CF_API_TOKEN, CF_ACCOUNT_ID, R2_BUCKET_NAME, SITE_SLUG, SITE_VERSION are set.',
    '',
    '## Hard Rules',
    `- THE BUSINESS NAME IS EXACTLY "${safeName}" — use it VERBATIM as the site title, every h1, the footer copyright, the JSON-LD Organization name, and every visible brand string. NEVER invent a different name (no "rebranding", no creative renaming). The template ships sample names — replace EVERY one of them, and grep for leftover names before uploading. (Journey defect 2026-08-19: a build for "${safeName}" shipped titled "Hearth & Crumb".)`,
    '- TEMPLATE-FIRST: the template is the quality floor — you CUSTOMIZE it, you never regenerate it. Most of the site is already built; leverage it.',
    '- TIME BUDGET is absolute: finish under 14 minutes. Do NOT run the visual-qa / seo-auditor / accessibility-auditor / performance-profiler / security-reviewer / completeness-checker swarm and do NOT loop-until-perfect — the single run-validators pass in step 4 is the ship gate. Deeper QA (GPT-4o visual scoring, Lighthouse, a11y) runs POST-publish via the snapshot-quality workflow, which files follow-ups; it does not block this build.',
    "- Real content only — every visible string is the real business's copy, never a placeholder.",
    '- DONE = `npm run build` succeeds AND run-validators `blockers === 0` AND upload-to-r2 completed.',
    '',
    params.additionalContext ? `ADDITIONAL CONTEXT FROM USER: ${params.additionalContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Cloudflare Workflow for AI site generation.
 *
 * Uses heartbeat polling pattern:
 * 1. start-build: POST to container, get jobId
 * 2. heartbeat-N: Poll status every 30s (tiny steps, no timeout risk)
 * 3. fetch-result: GET files when complete
 * 4. upload-to-r2: Upload files + update D1
 */
export class SiteGenerationWorkflow extends WorkflowEntrypoint<Env, SiteGenerationParams> {
  override async run(
    event: Readonly<WorkflowEvent<SiteGenerationParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const params = event.payload;
    const env = this.env;
    const startTime = Date.now();

    // #143 — one trace id per workflow run, stamped onto every build-step audit
    // row. Combined with org_id (tenant) + site_id (entity) already carried by
    // workflowLog, this gives traceId + tenantId correlation across the whole
    // build pipeline (audit_logs.metadata_json.trace_id ties the steps together).
    const traceId = crypto.randomUUID();
    const wfLog = (action: string, meta: Record<string, unknown> = {}): Promise<void> =>
      workflowLog(env.DB, params.orgId, params.siteId, action, { ...meta, trace_id: traceId });

    await wfLog('workflow.started', {
      slug: params.slug,
      business_name: params.businessName,
      business_address: params.businessAddress ?? null,
      google_place_id: params.googlePlaceId ?? null,
      has_additional_context: !!params.additionalContext,
      message: 'AI build workflow started for ' + params.businessName + ' (' + params.slug + ')',
    });

    await updateSiteStatus(env.DB, params.siteId, 'generating');

    await emitBuildEvent(env, params.siteId, {
      type: 'build.started',
      prompt: `${params.businessName} (${params.slug})`,
    });

    // ── Validate container binding ──
    if (!env.SITE_BUILDER) {
      await updateSiteStatus(env.DB, params.siteId, 'error');
      throw new Error('SITE_BUILDER container not configured');
    }

    // Per-run container ID — each workflow run gets a fresh DO + container.
    // Eliminates stale-image problems and means containers are disposable.
    // State persistence comes from KV-backed callbacks, not container disk.
    const runNonce = Date.now().toString(36);
    const containerName = `${params.slug}-build-${params.siteId.slice(0, 8)}-${runNonce}`;
    const containerId = env.SITE_BUILDER.idFromName(containerName);
    const getContainer = () => env.SITE_BUILDER!.get(containerId);
    /*
     * Restart must target a FRESH DO. The eviction-recovery paths previously
     * re-posted /build to the SAME container that just lost the job — a dead
     * DO re-hibernates and the retry dies the same way (journey 2026-08-19:
     * the one-shot restart never rescued a single eviction). Each restart
     * mints a new name-derived DO (fresh image, fresh memory), so the retry
     * is genuinely independent of the evicted instance.
     */
    let restartNonce = 0;
    // The ACTIVE container handle — swapped to the fresh DO on every restart.
    // The heartbeat loop must poll the SAME container the restart posted
    // /build to; polling the original (dead) DO returns unknown-job forever,
    // KV misses (the fresh container's record is under its own jobId), and
    // the recovery abandons 30s after every restart (journey 2026-08-19 —
    // the restart fired but the poll never followed it).
    let activeContainer = () => getContainer();
    const freshRestartContainer = () => {
      const builder = env.SITE_BUILDER;
      if (!builder) throw new Error('SITE_BUILDER container not configured');
      const fresh = builder.get(builder.idFromName(`${containerName}-r${++restartNonce}`));
      activeContainer = () => fresh;
      return fresh;
    };

    // ── Minimal mode: short-circuit, prove container infra ──
    if (params.minimalMode) {
      const minimalRes = await step.do(
        'minimal-build',
        { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '3 minutes' },
        async () => {
          const container = getContainer();
          const res = await container.fetch('http://container/build-minimal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: params.slug,
              envVars: {
                CF_API_TOKEN: typeof env.CF_API_TOKEN === 'string' ? env.CF_API_TOKEN : '',
                CF_ACCOUNT_ID: '84fa0d1b16ff8086dd958c468ce7fd59',
                R2_BUCKET_NAME: 'project-sites-production',
                SITE_SLUG: params.slug,
                SITE_VERSION: `v-${Date.now()}`,
              },
            }),
          });
          if (!res.ok) throw new Error(`build-minimal HTTP ${res.status}`);
          return await res.text();
        },
      );
      const parsed = JSON.parse(minimalRes) as {
        ok: boolean;
        uploadResult?: { uploaded?: number };
        stdoutTail?: string;
        elapsedMs?: number;
      };
      await wfLog('workflow.minimal_done', {
        ok: parsed.ok,
        uploaded: parsed.uploadResult?.uploaded ?? 0,
        elapsedMs: parsed.elapsedMs,
        stdoutTail: parsed.stdoutTail,
      });
      if (parsed.ok) {
        await updateSiteStatus(env.DB, params.siteId, 'published');
        return { ok: true, mode: 'minimal', uploaded: parsed.uploadResult?.uploaded };
      }
      await updateSiteStatus(env.DB, params.siteId, 'error');
      throw new Error('minimal build failed: ' + (parsed.stdoutTail || 'unknown'));
    }

    // ── Stub mode: validate KV-callback persistence end-to-end (no API cost) ──
    if (params.stubMode) {
      const stubJobId = await step.do(
        'stub-start-build',
        {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
          timeout: '5 minutes',
        },
        async () => {
          const container = getContainer();
          const cbSecret = env.INTERNAL_BUILD_SECRET || '';
          const cbUrl =
            env.INTERNAL_CALLBACK_URL || `https://${DOMAINS.SITES_BASE}/api/internal/build-status`;
          const res = await container.fetch('http://container/build-stub', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: params.slug,
              callbackUrl: cbUrl,
              callbackSecret: cbSecret,
            }),
          });
          if (!res.ok) throw new Error(`stub start failed: ${res.status}`);
          const r = (await res.json()) as { jobId?: string; error?: string };
          if (r.error || !r.jobId) throw new Error(`stub start error: ${r.error ?? 'no jobId'}`);
          return r.jobId;
        },
      );

      let stubFinal: KvBuildRecord | null = null;
      for (let i = 0; i < 30; i++) {
        const status = await step.do(
          `stub-heartbeat-${i}`,
          {
            retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
            timeout: '1 minute',
          },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 6_000));
            const raw = await env.CACHE_KV.get(`build:${stubJobId}`);
            return raw || JSON.stringify({ _missing: true });
          },
        );
        const parsed = JSON.parse(status) as KvBuildRecord & { _missing?: boolean };
        if (parsed._missing) continue;
        await wfLog('workflow.stub_heartbeat', {
          poll: i,
          status: parsed.status,
          step: parsed.step,
          message: `stub poll ${i}: ${parsed.status} ${parsed.step}`,
        });
        if (parsed.status !== 'running') {
          stubFinal = parsed;
          break;
        }
      }
      if (!stubFinal || stubFinal.status !== 'complete') {
        throw new Error(`stub mode failed: ${JSON.stringify(stubFinal)}`);
      }
      await wfLog('workflow.stub_done', {
        jobId: stubJobId,
        uploadResult: stubFinal.uploadResult,
        message: 'KV-callback persistence proof: complete',
      });
      return { ok: true, mode: 'stub', jobId: stubJobId, kvFinal: stubFinal };
    }

    // ── Move uploaded assets (if any) ──
    let assetManifest: string[] = params.uploadedAssets || [];
    if (params.uploadId) {
      try {
        const moved = await step.do(
          'move-uploaded-assets',
          {
            retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
            timeout: '1 minute',
          },
          async () => {
            const prefix = `uploads/${params.uploadId}/`;
            const listed = await env.SITES_BUCKET.list({ prefix, limit: 50 });
            const movedKeys: string[] = [];
            for (const obj of listed.objects) {
              const relativePath = obj.key.replace(prefix, '');
              const destKey = `sites/${params.slug}/assets/${relativePath}`;
              const data = await env.SITES_BUCKET.get(obj.key);
              if (data) {
                await env.SITES_BUCKET.put(destKey, await data.arrayBuffer(), {
                  httpMetadata: data.httpMetadata,
                });
                movedKeys.push(destKey);
              }
            }
            return JSON.stringify(movedKeys);
          },
        );
        assetManifest = [...assetManifest, ...JSON.parse(moved)];
      } catch {
        // Non-blocking — continue without uploaded assets
      }
    }

    // ── Build the prompt + context ──
    const prompt = buildPrompt(params);

    // Mint version inside step.do so workflow replay returns the cached value.
    // Without this, line `new Date().toISOString()` re-runs on replay and produces
    // a fresh timestamp — finalize-build then writes the wrong R2 prefix to D1
    // and the live site 404s while R2 has files at the *original* version path.
    const version = await step.do(
      'mint-version',
      { retries: { limit: 0, delay: '1 second' }, timeout: '30 seconds' },
      async () => new Date().toISOString().replace(/[:.]/g, '-'),
    );
    const envVars: Record<string, string> = {
      // R2 upload credentials (used by /home/cuser/upload-to-r2.mjs)
      CF_API_TOKEN: typeof env.CF_API_TOKEN === 'string' ? env.CF_API_TOKEN : '',
      CF_ACCOUNT_ID: '84fa0d1b16ff8086dd958c468ce7fd59',
      R2_BUCKET_NAME: 'project-sites-production',
      SITE_SLUG: params.slug,
      SITE_VERSION: version,
    };
    const keysToCopy: (keyof Env)[] = [
      'OPENAI_API_KEY',
      'UNSPLASH_ACCESS_KEY',
      'PEXELS_API_KEY',
      'PIXABAY_API_KEY',
      'YOUTUBE_API_KEY',
      'LOGODEV_TOKEN',
      'BRANDFETCH_API_KEY',
      'FOURSQUARE_API_KEY',
      'YELP_API_KEY',
      'GOOGLE_PLACES_API_KEY',
      'GOOGLE_CSE_KEY',
      'GOOGLE_CSE_CX',
      'IDEOGRAM_API_KEY',
      'REPLICATE_API_TOKEN',
      'STABILITY_API_KEY',
      'GOOGLE_MAPS_API_KEY',
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
      'MAPBOX_ACCESS_TOKEN',
    ];
    for (const key of keysToCopy) {
      const val = env[key];
      if (typeof val === 'string' && val) envVars[key] = val;
    }

    // Context files: asset manifest + any uploaded asset URLs
    const contextFiles: Record<string, string> = {};
    if (assetManifest.length > 0) {
      const assetUrls = assetManifest.map(
        (key) => `https://${params.slug}${DOMAINS.SITES_SUFFIX}/assets/${key.split('/').pop()}`,
      );
      contextFiles['assets.json'] = JSON.stringify(
        { keys: assetManifest, urls: assetUrls },
        null,
        2,
      );
    }

    // DETERMINISTIC brand seed — the container writes contextFiles as
    // `_{key}` in the build dir and the template's src/brand.ts imports
    // ../_brand.json at BUILD TIME. Without this file the site ships as
    // "Business" with generic copy (journey defect 2026-08-19: two builds
    // shipped wrong/generic names — "Hearth & Crumb", then "Business").
    // The name is NOT left to LLM compliance — it is materialized here.
    // CRITICAL SHAPE: the template's resolver is W3C DTCG — every leaf MUST
    // be `{ $value: ... }` (the resolver's isLeaf() checks for `$value`;
    // a plain-object leaf resolves undefined → the "Business" fallback).
    // Allow `&`, `,`, and `+` — common, legitimate business-name punctuation
    // ("Ember & Oak", "Smith, Jones & Assoc.", "R+D Labs"). They're HTML-escaped
    // downstream in fillTemplateTokens, so they're injection-safe. Previously the
    // regex stripped `&` → "Ember & Oak" rendered "Ember  Oak" (a double-space) in
    // every title/nav across builds. Still strips `<`, `>`, `"`, and other unsafe chars.
    // Collapse any resulting double-spaces so a stripped char never leaves a gap.
    const safeName = (params.businessName || 'Business')
      .replace(/[^\w\s\-'.,&+]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 100);
    const tok = (value: string, description = '') => ({
      $value: value,
      $type: 'string',
      ...(description ? { $description: description } : {}),
    });
    // THEME PERSONALITY (fire AL-198). The template ships 13 visual presets
    // (font/radius/shadow/motion/flourish) but the workflow never wrote a
    // `themeStyle` AND seeds businessClass='organization', so brand.ts's
    // fallback (presetForClass('organization')) locked EVERY workflow site to
    // `classic` — luxe/heritage/precision/boutique/scholarly/botanical were
    // unreachable. Derive the personality from the declared vertical + the
    // freeform design hint (both authoritative /create inputs). Top-level plain
    // string is EXACTLY what brand.ts reads (r.themeStyle); an undefined result
    // omits the key so the template keeps its own graceful classic fallback.
    const themeStyle = themeStyleFromInputs(params.businessCategory, params.additionalContext);
    // IMMUTABLE themeStyle signal (mirrors the _category.txt sidecar). The seeded
    // _brand.json.themeStyle below is CLOBBERABLE — the orchestrator rewrites _brand.json
    // (the same fire-54 clobber that motivated _category.txt), dropping the top-level
    // themeStyle, so applyVerticalPreset's _brand.json-based preservation silently no-ops
    // and the vertical PACK's themeStyle wins (steakhouse→warm not luxe, record store→
    // boutique not retro). So ALSO ship the personality as a standalone _theme_style.txt
    // the orchestrator never touches; the container's applyThemeStyleSidecar re-stamps it
    // onto _brand.json AFTER the pack merge → the worker's deterministic call wins.
    if (themeStyle) contextFiles['theme_style.txt'] = themeStyle;
    contextFiles['brand.json'] = JSON.stringify(
      {
        ...(themeStyle ? { themeStyle } : {}),
        business: {
          name: tok(safeName, 'Display name.'),
          shortName: tok(safeName.slice(0, 12), 'Used in PWA install + nav.'),
          tagline: tok('', 'Eyebrow line above H1.'),
          description: tok((params.additionalContext || '').slice(0, 156), 'Meta description.'),
          url: tok(`https://${params.slug}${DOMAINS.SITES_SUFFIX}`, 'Canonical https URL.'),
          businessClass: tok('organization', 'storefront|restaurant|…|organization'),
          // The user-declared vertical category — the container classifier
          // (pickVerticalPreset) reads biz.category at 10× PRIMARY weight, so seeding
          // it here makes the EXPLICIT category out-rank research-flavored name noise.
          // Root cause of the fire-32 miss: this leaf was absent → a restaurant named
          // "Harvest & Vine" fell back to its nonprofit-flavored name and shipped as a
          // nonprofit. Additive + safe (empty when unset → classifier simply ignores it).
          category: tok(
            params.businessCategory || '',
            'User-declared vertical category (authoritative classifier signal).',
          ),
          email: tok(
            params.businessEmail || '',
            'Business email → org email JSON-LD + mailto: link.',
          ),
          phone: tok(params.businessPhone || ''),
          address: tok(params.businessAddress || ''),
          hours: tok(
            params.businessHours || '',
            'Freeform hours → OpeningHoursSpecification JSON-LD + LocationMap grid.',
          ),
        },
      },
      null,
      2,
    );

    // IMMUTABLE category signal (fire-55). The seeded _brand.json.business.category
    // is CLOBBERABLE — the orchestrator rewrites _brand.json (fire-54: a reset
    // restaurant shipped as dark saas because the orchestrator overwrote the category
    // with saas copy). So the authoritative declared vertical ALSO ships as a
    // standalone _category.txt (container writes contextFiles['category.txt'] → the
    // orchestrator never touches a file it doesn't know about). pickVerticalPreset
    // short-circuits on it → the declared vertical wins regardless of hallucination.
    if (params.businessCategory && params.businessCategory.trim()) {
      contextFiles['category.txt'] = params.businessCategory.trim().slice(0, 120);
    }

    // ── Per-business About narrative (fire-75, content-uniqueness arc) ──
    // FIRE-72 shipped the CONTAINER consumer (applyResearchNarrative reads
    // _research.json.profile.description → ABOUT_DESCRIPTION, gated on
    // len + ≥2-sentences + no-slop + no-tokens + Flesch≥52), but FIRE-73 found the
    // research phase never persists a profile.description (research_data is empty) →
    // every vertical shipped the NAME-AGNOSTIC pack-default About (0% unique per the
    // content-quality eval). Seed a deterministic identity-woven About from the
    // ALWAYS-PRESENT identity (name + declared category + city) so the VISIBLE About
    // is business-SPECIFIC. Deterministic + gate-safe: if the container's stricter
    // re-check ever rejects it, the polished pack default stays (no regression). An
    // LLM upgrade is a later fire on this same seam. contextFiles['research.json'] →
    // container writes _research.json (last, wins) → applyResearchNarrative consumes it.
    {
      const catService =
        (params.businessCategory || '')
          .toLowerCase()
          .replace(
            /\b(clinics?|studios?|shops?|stores?|group|company|co|services?|practice|agency|firm|center|centre|salon|parlou?rs?|llc|inc)\b/g,
            '',
          )
          .replace(/\s{2,}/g, ' ')
          .trim() || 'local service';
      // City = the second-to-last comma field of the address ("…, Spokane, WA 99202" → "Spokane").
      const addrParts = (params.businessAddress || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const cityPhrase =
        addrParts.length >= 2 ? addrParts[addrParts.length - 2]! : 'your community';
      const seed = [...safeName].reduce((a, c) => a + c.charCodeAt(0), 0);
      const pick = (arr: string[]): string => arr[seed % arr.length] || arr[0] || '';
      const description = pick([
        `${safeName} brings dependable ${catService} to ${cityPhrase}. We keep our work honest and our answers plain, so you always know where things stand. People choose us because we treat them like neighbors, not numbers.`,
        `At ${safeName}, good ${catService} starts with listening. We serve ${cityPhrase} with clear answers, real attention, and follow-through you can count on. When you come to us, you are a person we know, not a case on a list.`,
        `${safeName} has served ${cityPhrase} for years, and that local focus shapes every day. We keep it simple: do the ${catService} right, explain it in plain words, and stand behind it. That is why people here send their friends our way.`,
      ]);
      const mission = pick([
        `Our promise is simple. We give ${cityPhrase} ${catService} you can trust, explained in plain words and delivered with respect.`,
        `We are here to make good ${catService} easy to reach in ${cityPhrase}. Honest, personal, and always on your side is how we work.`,
      ]);
      contextFiles['research.json'] = JSON.stringify(
        { profile: { description, mission_statement: mission } },
        null,
        2,
      );
      // fire-76: flip a THIRD uniqueness block (SERVICES_INTRO) from pack-default →
      // business-specific. Unlike the About (a research-profile field consumed via the
      // gated applyResearchNarrative), SERVICES_INTRO is a `_content.json` token — seed it
      // DIRECTLY: the container writes contextFiles→`_content.json`, and
      // applyVerticalContentPack keeps a non-blank existing value over the pack default
      // (existing-wins merge, verified), so this business-specific intro renders. Same
      // proven seam as fire-75's About (0%→40% live); this targets ~60% uniquePct.
      const servicesIntro = pick([
        `Everything ${safeName} does comes back to one idea: dependable ${catService} for ${cityPhrase}, explained in plain words. Here is how we help.`,
        `From the first call to the finished job, ${safeName} makes ${catService} in ${cityPhrase} simple, honest, and built to last. These are the services we offer.`,
      ]);
      // fire-77: flip the LAST TWO pack-default uniqueness blocks (HERO_SUBHEADLINE +
      // ABOUT_PARAGRAPH_1) via the SAME _content.json seam, taking the visible copy from
      // ~60% → ~100% business-specific. Both are plain `_content.json` tokens (like
      // SERVICES_INTRO — NOT the gated research-profile About), so seeding them here and
      // letting applyVerticalContentPack's existing-wins merge keep them is all it takes.
      // Kept short, slop-free, and identity-woven (name + category + city) so they read
      // naturally across all 10 verticals and never trip build_validators' banned-slop gate.
      const heroSub = pick([
        `Trusted ${catService} in ${cityPhrase} — clear answers, no surprises, and work we stand behind.`,
        `${cityPhrase}'s dependable choice for ${catService}. Honest, personal, and always on your side.`,
      ]);
      const aboutPara1 = pick([
        `${safeName} is built around the people of ${cityPhrase}. We started with one belief: ${catService} should be easy to understand and easy to trust. Every day we work to earn that trust with clear communication, real follow-through, and results we stand behind.`,
        `For the families and neighbors of ${cityPhrase}, ${safeName} keeps ${catService} refreshingly simple. No jargon and no pressure, just careful work, straight answers, and a team that remembers your name.`,
      ]);
      // AL-275: seed the HERO_HEADLINE (the <h1> ITSELF) business-specifically — the LAST
      // pack-default uniqueness block still shipping generic ("Reliable service, done right
      // the first time") on 5/5 real deliveries (Over Easy / Blooming Blossoms / City Hardware
      // / Weissman / Xpress). The theme-selection gap is fixed (AL-256), so the H1 is the sole
      // remaining generic-default miss (isolated AL-265). Fast-path builds carry NO research_data
      // (D1 ground truth) so there is no AI hero_headline to wire — a per-vertical+city derivation
      // from the seeded identity is the right fix. Same proven `_content.json` seam +
      // existing-wins merge as HERO_SUBHEADLINE/SERVICES_INTRO/ABOUT_PARAGRAPH_1 (worker-side, no
      // container rebuild; fail-soft — blank → pack default). Short + punchy for an <h1>,
      // slop-free (no banned words), identity-woven so it never collides across businesses/cities
      // and never trips build_validators' validateHeroNotPackDefault.
      const heroHeadline = pick([
        `${cityPhrase}'s trusted ${catService}`,
        `Expert ${catService} in ${cityPhrase}`,
        `Quality ${catService} ${cityPhrase} counts on`,
      ]);
      contextFiles['content.json'] = JSON.stringify(
        {
          ABOUT_PARAGRAPH_1: aboutPara1,
          HERO_HEADLINE: heroHeadline,
          HERO_SUBHEADLINE: heroSub,
          SERVICES_INTRO: servicesIntro,
        },
        null,
        2,
      );
    }

    // ── Optional: Human-in-the-loop logo approval (Workflows v2 elicitation) ──
    //
    // CANONICAL human-in-loop pattern for future workflows. Pauses the workflow
    // mid-run, surfaces a task in the admin tray via `ai_task_inbox`, and
    // resumes when the user clicks an option (or auto-defaults on timeout).
    //
    // ## Activation
    // Gated on `env.SITE_GEN_REQUIRES_LOGO_APPROVAL === 'true'`. When unset
    // (the default), the step is skipped entirely — full backwards
    // compatibility. Flip the env var to start gating builds on logo review.
    //
    // ## How it pauses
    // 1. `postAskUser` writes a row to `ai_task_inbox` with `task_kind`,
    //    `prompt`, `options[]`, `defaultChoice`, and a 30-minute expiry.
    // 2. `step.waitForEvent(\`task-resolved-${id}\`)` parks the workflow
    //    instance until the matching event fires OR the step timeout hits.
    // 3. The admin tray polls `listOpenTasks(env, orgId)`; user clicks an
    //    option; the route handler calls `resolveTask(env, id, {choice})`
    //    which (a) marks the row resolved and (b) fans the resolution into
    //    the workflow via `env.SITE_GENERATION.sendEvent`.
    //
    // ## How it resumes
    // The `waitForEvent` resolves with the resolution payload. We branch on
    // `choice`:
    //  - `Approve` → fall through to `start-build` unchanged.
    //  - `Regenerate` → loop back to logo regeneration (left as a TODO in
    //    this example — real impl re-fires the `generate-logo` step).
    //  - `Use my own` → halt the workflow; user uploads via the admin UI,
    //    which re-creates the workflow with the new asset already in R2.
    //
    // ## Auto-defaulting
    // If the user doesn't respond in 30 min, the `applyExpiredDefaults`
    // sweep cron auto-resolves to `defaultChoice` and the workflow continues
    // — `Approve` is chosen here as the failsafe.
    //
    // @see services/task_inbox.ts postAskUser / resolveTask
    // @see migrations/0039_task_inbox.sql
    if (
      (env as unknown as { SITE_GEN_REQUIRES_LOGO_APPROVAL?: string })
        .SITE_GEN_REQUIRES_LOGO_APPROVAL === 'true'
    ) {
      // Sub-step 1: post the elicitation task. Kept inside step.do so the
      // ai_task_inbox INSERT replays deterministically on workflow restart.
      const elicitationTaskId = await step.do(
        'logo-approval-post',
        {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
          timeout: '30 seconds',
        },
        async () => {
          const { id } = await postAskUser(env, {
            orgId: params.orgId,
            workflowInstanceId: event.instanceId,
            taskKind: 'approve_logo',
            prompt:
              `Approve the generated logo for ${params.businessName}? ` +
              'Choose Approve to continue the build, Regenerate to try a new logo, ' +
              'or Use my own to upload a custom logo via the admin UI.',
            options: ['Approve', 'Regenerate', 'Use my own'],
            defaultChoice: 'Approve',
            timeoutMs: 30 * 60 * 1000,
            createdBy: params.orgId,
          });
          await wfLog('workflow.logo_approval_posted', {
            task_id: id,
            message: 'Logo approval requested — workflow paused waiting for user',
          });
          return id;
        },
      );

      // Sub-step 2: park the workflow on the matching `task-resolved-${id}`
      // event. `step.waitForEvent` is the Workflows v2 primitive — survives
      // hibernation, retries, and worker restarts. On timeout it throws, and
      // we fall back to the default `Approve` choice so the build never
      // wedges indefinitely (the `applyExpiredDefaults` cron also auto-
      // resolves the row with `defaultChoice` for UI consistency).
      let approvalChoice: string = 'Approve';
      try {
        const resolution = await step.waitForEvent<{ choice?: string }>(
          `task-resolved-${elicitationTaskId}`,
          {
            type: `task-resolved-${elicitationTaskId}`,
            timeout: '30 minutes',
          },
        );
        approvalChoice = resolution?.payload?.choice ?? 'Approve';
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'workflow',
            step: 'logo-approval-wait',
            error: err instanceof Error ? err.message : String(err),
            message: 'logo approval elicitation timed out — defaulting to Approve',
          }),
        );
      }

      await wfLog('workflow.logo_approval_resolved', {
        task_id: elicitationTaskId,
        choice: approvalChoice,
        message: `Logo approval resolved: ${approvalChoice}`,
      });

      // Branch on resolution. Approve = fall through. Regenerate = re-fire
      // the logo generation pipeline (left as a follow-up — the orchestrator
      // prompt already covers regeneration on its next pass). Use-my-own =
      // halt cleanly; admin UI re-creates the workflow once asset uploaded.
      if (approvalChoice === 'Use my own') {
        await updateSiteStatus(env.DB, params.siteId, 'collecting');
        await wfLog('workflow.halted_for_upload', {
          message: 'Build halted — awaiting custom-logo upload from user',
        });
        return {
          siteId: params.siteId,
          slug: params.slug,
          status: 'halted',
          reason: 'awaiting_user_upload',
        };
      }
      // 'Regenerate' falls through with the orchestrator prompt picking up the
      // signal via _research.json on the next pass. 'Approve' falls through.
    }

    // ── Budget killswitch: cap AI spend per org BEFORE the expensive build ──
    // Feature `token_burn_meter` (idea #13). Flag-gated so unmetered builds run
    // exactly as before when the flag is off. When monthly spend hits the plan
    // cap, throw a friendly AppError pre-build so a runaway org never burns past
    // its budget. See services/build_budget.ts + libs/features/token_burn_meter/.
    await step.do(
      'budget-killswitch',
      { retries: { limit: 1, delay: '2 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
      async () => {
        const flagOn = await isFlagOn(env, 'token_burn_meter', { orgId: params.orgId }).catch(
          () => false,
        );
        if (!flagOn) return JSON.stringify({ skipped: true, reason: 'flag_off' });

        // Route through the SSOT plan resolver (`status IN ('active','trialing')`)
        // so a TRIALING paid sub gets the paid AI budget — the old
        // `status === 'active'` gate excluded trialing (trialing-drift class).
        // `.catch(() => null)` preserves the workflow-step resilience (a DB hiccup
        // resolves to the free budget, never throws out of the step).
        const plan =
          (await resolveActiveOrgPlan(env.DB, params.orgId).catch(() => null)) === 'paid'
            ? 'paid'
            : 'free';

        const meter = await checkBudget(env.DB, params.orgId, plan);
        if (!meter.allowed) {
          const friendly =
            `AI budget exhausted for this month — $${meter.spentUsd.toFixed(2)} of ` +
            `$${meter.capUsd === Infinity ? '∞' : meter.capUsd.toFixed(2)} used. ` +
            'Upgrade your plan or wait for the monthly reset to build again.';
          await updateSiteStatus(env.DB, params.siteId, 'error');
          await wfLog('workflow.budget_blocked', {
            spent_usd: meter.spentUsd,
            cap_usd: meter.capUsd,
            pct: meter.pct,
            message: friendly,
          });
          await emitBuildEvent(env, params.siteId, {
            type: 'build.failed',
            reason: friendly,
            code: 'budget_exhausted',
          });
          throw new AppError({ code: 'FORBIDDEN', message: friendly, statusCode: 403 });
        }

        await wfLog('workflow.budget_ok', {
          spent_usd: meter.spentUsd,
          cap_usd: meter.capUsd,
          remaining_usd: meter.remainingUsd,
          pct: meter.pct,
          message: `Budget OK: $${meter.spentUsd.toFixed(2)}/$${meter.capUsd === Infinity ? '∞' : meter.capUsd.toFixed(2)} (${meter.pct.toFixed(0)}%)`,
        });
        // Proactive psnotify warning when a capped org crosses 80% of its monthly AI
        // budget — so they can upgrade before a build is blocked. Best-effort.
        if (meter.capUsd !== Infinity && meter.pct >= 80) {
          try {
            const { notifyOwnerEvent } = await import('../services/notify.js');
            await notifyOwnerEvent(env, env.DB, {
              orgId: params.orgId,
              event: {
                event: 'quota.near_limit',
                tenantId: params.orgId,
                resource: 'ai_budget',
                usedPercent: Math.min(100, Math.round(meter.pct)),
              },
            });
          } catch {
            /* bell is best-effort */
          }
        }
        return JSON.stringify({ allowed: true, plan, pct: meter.pct });
      },
    );

    // ── Step 1: Start build (POST to container) ──
    // Use workers.dev URL to bypass zone-level CF managed challenge intercepting POSTs.
    const callbackSecret = env.INTERNAL_BUILD_SECRET || '';
    const callbackUrl =
      env.INTERNAL_CALLBACK_URL || `https://${DOMAINS.SITES_BASE}/api/internal/build-status`;

    // A start-build throw (pool exhaustion — 'no container instance can be
    // provided', container 500s, etc.) previously propagated straight out of
    // run() with NO status flip: the site stranded at 'generating' forever,
    // and /reset's in-flight guard 409'd every future retry (journey
    // 2026-08-20 — the exact stranded-state class that blocked rebuilds).
    // Flip to error BEFORE rethrowing so the site reaches terminal and the
    // user can retry immediately.
    let jobId: string;
    try {
      jobId = await step.do(
        'start-build',
        {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
          timeout: '5 minutes',
        },
        async () => {
          const container = getContainer();

          const _deepseekKey = (env as unknown as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY;
          const _buildLlmProvider = (env as unknown as { BUILD_LLM_PROVIDER?: string })
            .BUILD_LLM_PROVIDER;
          const useDeepSeek = !!_deepseekKey && _buildLlmProvider !== 'anthropic';

          const payload = {
            slug: params.slug,
            _anthropicKey: env.ANTHROPIC_API_KEY || '',
            _ideogramKey: (env as unknown as { IDEOGRAM_API_KEY?: string }).IDEOGRAM_API_KEY || '',
            ...(useDeepSeek && {
              _deepseekKey,
              _anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
              _anthropicModel: 'deepseek-chat',
            }),
            prompt,
            contextFiles,
            envVars,
            // Cloudflare Workers Containers cap wall-clock at ~15 min — a 45-min
            // budget can never complete (the container is killed first). The build
            // is TEMPLATE-FIRST (the Dockerfile pre-bakes template.projectsites.dev
            // + deps), so the orchestrator does minor customization, not from-scratch
            // generation, and must finish under the cap. (Brian directive 2026-08-15.)
            timeoutMin: 14,
            callbackUrl,
            callbackSecret,
          };

          const res = await container.fetch('http://container/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown');
            throw new Error(`Container start failed: ${res.status} ${errText}`);
          }

          const result = (await res.json()) as { jobId?: string; error?: string };
          if (result.error) throw new Error(`Container start error: ${result.error}`);
          if (!result.jobId) throw new Error('Container did not return jobId');

          // The container job id (`job-<ts>-<rand>`) is NOT the siteId. The
          // `/api/internal/build-status` callback needs the siteId to deploy the site's
          // WfP functions worker — map jobId → siteId in KV so the callback can resolve
          // it (root-cause fix for the 2.2a positive-dispatch miss, 2026-08-30).
          await env.CACHE_KV.put(`job2site:${result.jobId}`, params.siteId, {
            expirationTtl: 7200,
          });

          await wfLog('workflow.build_started', {
            jobId: result.jobId,
            prompt_length: prompt.length,
            env_vars_count: Object.keys(envVars).length,
            message: `Claude Code build started (${Math.round(prompt.length / 1024)}KB prompt, ${Object.keys(envVars).length} API keys)`,
          });

          await emitBuildEvent(env, params.siteId, {
            type: 'agent.started',
            agent: 'orchestrator',
            step: 'container-build',
          });

          return result.jobId;
        },
      );
    } catch (err) {
      await updateSiteStatus(env.DB, params.siteId, 'error');
      await wfLog('workflow.start_build_failed', {
        error: err instanceof Error ? err.message : String(err),
        message: 'Container build failed to start — site flipped to error so the user can retry',
      });
      throw err;
    }

    // ── Step 2: Heartbeat loop polls container directly with KV fallback ──
    // Each heartbeat sleeps 30s, then hits the container's /status. The inbound
    // HTTP traffic on a regular cadence keeps the DO warm (preventing the idle
    // hibernation that froze the previous KV-only heartbeat at the 2-min mark).
    // The container also runs its own 60s self-keepalive (/health). KV is the
    // durable fallback if the container fetch errors (DO replaced, etc).
    const MAX_POLLS = 120;
    // Poll-budget extension: a restart re-boots the whole build (~14 min) — if
    // it only CONSUMED the remaining budget, any restart past ~poll 90 was a
    // guaranteed timeout (the fresh build never gets enough polls to reach
    // terminal). Each restart ADDS 60 polls (+30 min); the restart-count guard
    // caps the total at MAX_POLLS + MAX_RESTARTS*60 — bounded by design.
    const RESTART_POLL_BUDGET = 60;
    // Eviction recovery: restart the build up to MAX_RESTARTS times when the
    // container dies mid-build. Bumped 1→3 (2026-08-27): evictions RECUR in
    // instance-pressure windows (fires 26-27 — builds ran slow ~10min then the
    // container DO evicted mid-generation), and a SINGLE restart wasn't enough —
    // fire-27 needed a 3rd MANUAL reset before a build stuck. 3 automatic
    // restarts absorb a bad window without a human resetting each time.
    const MAX_RESTARTS = 3;
    const POLL_INTERVAL_MS = 30_000;
    const STALE_THRESHOLD_MS = 8 * 60_000;

    let finalStatus: ContainerStatus | null = null;
    let restartCount = 0;
    // The effective poll budget — extends by RESTART_POLL_BUDGET on restart so
    // a restarted build gets a FULL window, not the leftover of the first.
    let pollBudget = MAX_POLLS;
    // Boot-grace deadline — after a restart, the FRESH DO needs 1-3 min to
    // boot (image + git pull inside startAndWaitForPorts). Its first polls
    // legitimately return unknown-job / no KV record; abandoning then is a
    // false negative. While now < graceUntil, unknown-job polls keep waiting.
    let restartGraceUntil = 0;
    let kvFinalRecord: KvBuildRecord | null = null;
    let lastFreshAt = Date.now();
    let lastSeenStatus: string | null = null;
    let lastSeenStep: string | null = null;

    for (let i = 0; i < pollBudget; i++) {
      const result = await step.do(
        `heartbeat-${i}`,
        {
          retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
          timeout: '1 minute',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

          // Primary: short-poll the ACTIVE container (swaps to the fresh DO
          // after a restart — polling the dead original returned
          // unknown-job forever and the recovery abandoned, journey 2026-08-19).
          try {
            const container = activeContainer();
            const res = await container.fetch(`http://container/status?jobId=${jobId}`, {
              method: 'GET',
            });
            if (res.ok) {
              const body = await res.text();
              return JSON.stringify({ _src: 'container', body });
            }
          } catch {
            // fall through to KV fallback
          }

          // Fallback: KV record (set by container's pushStatus callback). Survives DO replacement.
          const raw = await env.CACHE_KV.get(`build:${jobId}`);
          if (!raw) return JSON.stringify({ _src: 'kv', _missing: true });
          return JSON.stringify({ _src: 'kv', body: raw });
        },
      );

      const wrap = JSON.parse(result) as { _src: string; _missing?: boolean; body?: string };

      if (wrap._missing) {
        // Boot-grace: right after a restart the fresh DO is still pulling its
        // image — missing container/KV records are EXPECTED, not abandonment.
        // Keep waiting while inside the grace window; only the ORIGINAL
        // "container never reported status" guard errors on a COLD start.
        if (Date.now() < restartGraceUntil) {
          continue;
        }
        if (i >= 4) {
          await wfLog('workflow.kv_no_status', {
            poll: i,
            message: 'No build status in KV after 2min — container failed to start',
          });
          finalStatus = {
            status: 'error',
            step: 'no-callback',
            elapsed: 0,
            fileCount: 0,
            error: 'Container never reported status to KV',
          };
          break;
        }
        continue;
      }

      const parsed = JSON.parse(wrap.body || '{}') as KvBuildRecord &
        ContainerStatus & { error?: string | null };

      const TERMINAL = new Set(['complete', 'error']);
      const unknownJob = wrap._src === 'container' && parsed.status === undefined;

      // Container DO restart → /status returns {error:'unknown job'} with no `status` field.
      // First try KV (terminal record may exist from before the DO died). If KV is empty too,
      // the job is unrecoverable — break immediately instead of polling for 8 more minutes.
      if (unknownJob) {
        const raw = await env.CACHE_KV.get(`build:${jobId}`);
        if (raw) {
          const kv = JSON.parse(raw) as KvBuildRecord;
          if (TERMINAL.has(kv.status)) {
            finalStatus = {
              status: kv.status,
              step: kv.step,
              elapsed: kv.elapsed,
              fileCount: kv.fileCount,
              error: kv.error || null,
            };
            kvFinalRecord = kv;
            break;
          }
        }

        // 2026-08-19: the container died mid-build (CF Containers wall-clock or
        // instance pressure) — restart up to MAX_RESTARTS times. The previous
        // behavior errored the whole site on any eviction; automatic restarts
        // recover the common case, and once the budget is spent the next
        // eviction still errors (honest, no infinite loop).
        if (restartCount < MAX_RESTARTS) {
          restartCount++;
          await wfLog('workflow.container_evicted_restart', {
            poll: i,
            message: `Container DO lost the job — restarting the build (${restartCount}/${MAX_RESTARTS})`,
          });
          // FRESH DO — re-posting to the evicted container guarantees a
          // second eviction (its memory is gone). A new name-derived DO boots
          // a fresh image and the build genuinely restarts. Minted OUTSIDE
          // the step callback: on a Workflow REPLAY the cached step result is
          // returned WITHOUT re-invoking the callback, so a swap inside would
          // be lost and the heartbeat would keep polling the dead original.
          const container = freshRestartContainer();
          const restartJobId = await step.do(
            'restart-build-after-eviction',
            {
              retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
              timeout: '5 minutes',
            },
            async () => {
              const _deepseekKey = (env as unknown as { DEEPSEEK_API_KEY?: string })
                .DEEPSEEK_API_KEY;
              const _buildLlmProvider = (env as unknown as { BUILD_LLM_PROVIDER?: string })
                .BUILD_LLM_PROVIDER;
              const useDeepSeek = !!_deepseekKey && _buildLlmProvider !== 'anthropic';
              const payload = {
                slug: params.slug,
                _anthropicKey: env.ANTHROPIC_API_KEY || '',
                _ideogramKey:
                  (env as unknown as { IDEOGRAM_API_KEY?: string }).IDEOGRAM_API_KEY || '',
                ...(useDeepSeek && {
                  _deepseekKey,
                  _anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
                  _anthropicModel: 'deepseek-chat',
                }),
                prompt,
                contextFiles,
                envVars,
                timeoutMin: 14,
                callbackUrl,
                callbackSecret,
              };
              const res = await container.fetch('http://container/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              if (!res.ok) {
                const errText = await res.text().catch(() => 'Unknown');
                throw new Error(`Restart failed: ${res.status} ${errText}`);
              }
              const result = (await res.json()) as { jobId?: string; error?: string };
              if (result.error) throw new Error(`Restart error: ${result.error}`);
              if (!result.jobId) throw new Error('Restart returned no jobId');
              await env.CACHE_KV.put(`job2site:${result.jobId}`, params.siteId, {
                expirationTtl: 7200,
              });
              return result.jobId;
            },
          );
          jobId = restartJobId;
          // Boot grace + budget extension — the eviction path previously set
          // NEITHER (the grace was only set on the stale path and never read
          // anywhere; the budget was never extended at all — a restart at
          // poll 118 had exactly 2 polls to finish a 14-minute build).
          restartGraceUntil = Date.now() + 3 * 60_000;
          pollBudget += RESTART_POLL_BUDGET;
          lastFreshAt = Date.now();
          lastSeenStatus = null;
          lastSeenStep = null;
          await wfLog('workflow.build_restarted', { poll: i, jobId: restartJobId });
          continue;
        }

        await wfLog('workflow.container_unknown_job', {
          poll: i,
          message: 'Container DO lost job and KV has no terminal record — abandoning build',
        });
        finalStatus = {
          status: 'error',
          step: 'unknown-job',
          elapsed: 0,
          fileCount: 0,
          error: 'Container DO evicted before build completed (job state lost)',
        };
        break;
      }

      // Container /status returns plain ContainerStatus (no lastUpdate). For wall-clock
      // freshness, treat every successful container response as fresh; KV path uses lastUpdate.
      const isFromContainer = wrap._src === 'container';
      const ageMs = isFromContainer
        ? Date.now() - lastFreshAt
        : Date.now() - ((parsed as KvBuildRecord).lastUpdate || 0);

      const stateChanged = parsed.status !== lastSeenStatus || parsed.step !== lastSeenStep;
      // Only bump freshness on responses with a real status; unknown-job (handled above)
      // would otherwise mask staleness forever.
      if (isFromContainer && parsed.status) lastFreshAt = Date.now();
      lastSeenStatus = parsed.status || lastSeenStatus;
      lastSeenStep = parsed.step || lastSeenStep;

      if (i % 5 === 0 || stateChanged) {
        await wfLog('workflow.heartbeat', {
          poll: i,
          src: wrap._src,
          status: parsed.status,
          step: parsed.step,
          elapsed_seconds: parsed.elapsed,
          file_count: parsed.fileCount,
          age_ms: ageMs,
          message: `heartbeat ${i} (${wrap._src}): status=${parsed.status}, step=${parsed.step}, elapsed=${parsed.elapsed}s`,
        });
      }

      // Surface phase transitions to the event stream — only on state change
      // so the cockpit gets a clean phase log, not 120 polls of noise.
      if (stateChanged && parsed.step) {
        await emitBuildEvent(env, params.siteId, {
          type: 'agent.started',
          agent: 'container',
          step: parsed.step,
        });
      }

      if (TERMINAL.has(String(parsed.status))) {
        // fire-80: a container that REPORTS a transient build error (claude_exit=1 /
        // 0-files / an npm install|build flake that survived the in-container retry) is
        // the 2nd transient class (~1/3 of builds, FIRE-79). Route it into the SAME
        // bounded restart machinery the eviction/stale paths use — a FRESH DO re-runs
        // the orchestrator (the crashed attempt produced 0 files, so no completed work
        // is lost or double-charged). Shares restartCount so total restarts stay
        // ≤ MAX_RESTARTS. Deterministic errors (validator gates, real faults a re-run
        // reproduces) don't match isTransientBuildError → they fail fast, exactly as before.
        if (
          String(parsed.status) === 'error' &&
          isTransientBuildError(parsed.error) &&
          restartCount < MAX_RESTARTS
        ) {
          restartCount++;
          await wfLog('workflow.transient_error_restart', {
            poll: i,
            error: parsed.error,
            message: `Transient build error — restarting on a fresh DO (${restartCount}/${MAX_RESTARTS}): ${String(parsed.error).slice(0, 120)}`,
          });
          const container = freshRestartContainer();
          const restartJobId = await step.do(
            `restart-build-after-transient-error-${restartCount}`,
            {
              retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
              timeout: '5 minutes',
            },
            async () => {
              const _deepseekKey = (env as unknown as { DEEPSEEK_API_KEY?: string })
                .DEEPSEEK_API_KEY;
              const _buildLlmProvider = (env as unknown as { BUILD_LLM_PROVIDER?: string })
                .BUILD_LLM_PROVIDER;
              const useDeepSeek = !!_deepseekKey && _buildLlmProvider !== 'anthropic';
              const payload = {
                slug: params.slug,
                _anthropicKey: env.ANTHROPIC_API_KEY || '',
                _ideogramKey:
                  (env as unknown as { IDEOGRAM_API_KEY?: string }).IDEOGRAM_API_KEY || '',
                ...(useDeepSeek && {
                  _deepseekKey,
                  _anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
                  _anthropicModel: 'deepseek-chat',
                }),
                prompt,
                contextFiles,
                envVars,
                timeoutMin: 14,
                callbackUrl,
                callbackSecret,
              };
              const res = await container.fetch('http://container/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              if (!res.ok) {
                const errText = await res.text().catch(() => 'Unknown');
                throw new Error(`Restart failed: ${res.status} ${errText}`);
              }
              const result = (await res.json()) as { jobId?: string; error?: string };
              if (result.error) throw new Error(`Restart error: ${result.error}`);
              if (!result.jobId) throw new Error('Restart returned no jobId');
              await env.CACHE_KV.put(`job2site:${result.jobId}`, params.siteId, {
                expirationTtl: 7200,
              });
              return result.jobId;
            },
          );
          jobId = restartJobId;
          restartGraceUntil = Date.now() + 3 * 60_000;
          pollBudget += RESTART_POLL_BUDGET;
          lastFreshAt = Date.now();
          lastSeenStatus = null;
          lastSeenStep = null;
          continue;
        }
        finalStatus = {
          status: parsed.status,
          step: parsed.step,
          elapsed: parsed.elapsed,
          fileCount: parsed.fileCount,
          error: parsed.error || null,
        };
        // Both KV records and container /status responses include uploadResult.
        // Capture it from whichever source delivered the terminal status.
        kvFinalRecord = parsed as KvBuildRecord;
        break;
      }

      if (ageMs > STALE_THRESHOLD_MS) {
        // Staleness recovery (same restart-count policy as the unknown-job
        // path): a worker deploy mid-build evicts the container — its KV
        // lastUpdate freezes and the heartbeat goes stale. Restart while the
        // MAX_RESTARTS budget lasts; once spent, a stale status still errors
        // honestly. (Journey: my own mid-build deploys triggered this on the
        // verification build.)
        if (restartCount < MAX_RESTARTS) {
          restartCount++;
          await wfLog('workflow.container_stale_restart', {
            poll: i,
            age_ms: ageMs,
            message: `Status stale ${(ageMs / 1000) | 0}s — restarting the build (${restartCount}/${MAX_RESTARTS})`,
          });
          // FRESH DO — see the eviction restart's rationale + the
          // replay-safety note (mint OUTSIDE the callback).
          const container = freshRestartContainer();
          const restartJobId = await step.do(
            'restart-build-after-stale',
            {
              retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
              timeout: '5 minutes',
            },
            async () => {
              const _deepseekKey = (env as unknown as { DEEPSEEK_API_KEY?: string })
                .DEEPSEEK_API_KEY;
              const _buildLlmProvider = (env as unknown as { BUILD_LLM_PROVIDER?: string })
                .BUILD_LLM_PROVIDER;
              const useDeepSeek = !!_deepseekKey && _buildLlmProvider !== 'anthropic';
              const payload = {
                slug: params.slug,
                _anthropicKey: env.ANTHROPIC_API_KEY || '',
                _ideogramKey:
                  (env as unknown as { IDEOGRAM_API_KEY?: string }).IDEOGRAM_API_KEY || '',
                ...(useDeepSeek && {
                  _deepseekKey,
                  _anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
                  _anthropicModel: 'deepseek-chat',
                }),
                prompt,
                contextFiles,
                envVars,
                timeoutMin: 14,
                callbackUrl,
                callbackSecret,
              };
              const res = await container.fetch('http://container/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              if (!res.ok) {
                const errText = await res.text().catch(() => 'Unknown');
                throw new Error(`Restart failed: ${res.status} ${errText}`);
              }
              const result = (await res.json()) as { jobId?: string; error?: string };
              if (result.error) throw new Error(`Restart error: ${result.error}`);
              if (!result.jobId) throw new Error('Restart returned no jobId');
              await env.CACHE_KV.put(`job2site:${result.jobId}`, params.siteId, {
                expirationTtl: 7200,
              });
              return result.jobId;
            },
          );
          jobId = restartJobId;
          restartGraceUntil = Date.now() + 3 * 60_000;
          pollBudget += RESTART_POLL_BUDGET;
          lastFreshAt = Date.now();
          lastSeenStatus = null;
          lastSeenStep = null;
          await wfLog('workflow.build_restarted', {
            poll: i,
            jobId: restartJobId,
            reason: 'stale',
          });
          continue;
        }

        await wfLog('workflow.container_stale', {
          poll: i,
          age_ms: ageMs,
          message: `Status stale ${(ageMs / 1000) | 0}s — container died without reporting completion`,
        });
        finalStatus = {
          status: 'error',
          step: 'stale',
          elapsed: parsed.elapsed,
          fileCount: parsed.fileCount,
          error: 'Container stopped reporting status (stale)',
        };
        break;
      }
    }

    if (!finalStatus) {
      await updateSiteStatus(env.DB, params.siteId, 'error');
      await wfLog('workflow.timeout', {
        message: `Build timed out after ${MAX_POLLS} polls (${MAX_POLLS * 30}s)`,
      });
      await emitBuildEvent(env, params.siteId, {
        type: 'build.failed',
        reason: `Build timed out after ${MAX_POLLS} heartbeat polls`,
        code: 'timeout',
      });
      await notifyBuildFailed(
        env,
        params.orgId,
        params.siteId,
        `Build timed out after ${MAX_POLLS * 30}s`,
      );
      throw new Error('Build timed out after ' + MAX_POLLS + ' heartbeat polls');
    }

    if (finalStatus.status === 'error') {
      await updateSiteStatus(env.DB, params.siteId, 'error');
      await wfLog('workflow.build_error', {
        error: finalStatus.error,
        elapsed_seconds: finalStatus.elapsed,
        message: `Build failed after ${finalStatus.elapsed}s: ${finalStatus.error}`,
      });
      await emitBuildEvent(env, params.siteId, {
        type: 'build.failed',
        reason: finalStatus.error || 'unknown error',
        code: finalStatus.step || 'build_failed',
      });
      await notifyBuildFailed(
        env,
        params.orgId,
        params.siteId,
        finalStatus.error || 'unknown error',
      );
      throw new Error('Build failed: ' + (finalStatus.error || 'unknown error'));
    }

    // ── Step 3: Finalize — verify R2 upload succeeded via KV record ──
    const filesJson = await step.do(
      'finalize-build',
      {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      },
      async () => {
        const fileCount = finalStatus!.fileCount || 0;
        // Prefer in-memory record from heartbeat poll. If missing or empty, re-read
        // KV — the container's HMAC-protected callback always writes the canonical
        // uploadResult to `build:${jobId}` regardless of which path saw terminal status first.
        let uploadResult = kvFinalRecord?.uploadResult || null;
        if (!uploadResult || !uploadResult.uploaded) {
          try {
            const raw = await env.CACHE_KV.get(`build:${jobId}`);
            if (raw) {
              const fresh = JSON.parse(raw) as KvBuildRecord;
              if (fresh?.uploadResult) uploadResult = fresh.uploadResult;
            }
          } catch {}
        }
        const uploadCount = uploadResult?.uploaded || 0;

        if (uploadCount === 0) {
          await updateSiteStatus(env.DB, params.siteId, 'error');
          await wfLog('workflow.upload_failed', {
            file_count: fileCount,
            upload_result: uploadResult,
            message: `R2 upload failed — refusing to mark published. uploaded=${uploadCount} failed=${uploadResult?.failed ?? 'n/a'}`,
          });
          await emitBuildEvent(env, params.siteId, {
            type: 'build.failed',
            reason: `R2 upload produced 0 files (failed=${uploadResult?.failed ?? 'n/a'})`,
            code: 'upload_failed',
          });
          await notifyBuildFailed(
            env,
            params.orgId,
            params.siteId,
            'Publishing failed — the build produced no files',
          );
          throw new Error(
            `R2 upload produced 0 files (uploadResult=${JSON.stringify(uploadResult)})`,
          );
        }

        await wfLog('workflow.build_complete', {
          file_count: fileCount,
          upload_count: uploadCount,
          upload_failed: uploadResult?.failed || 0,
          message: `Build complete: ${fileCount} source files, ${uploadCount} files uploaded to R2`,
        });

        // Meter build compute minutes through the billing provider.
        // Cost: ~$0.02/min. At ~25 min/build, ~$0.50/build.
        const buildMinutes = Math.ceil((Date.now() - startTime) / 60000);
        void (async () => {
          try {
            const { meterBuildComputeMinutes } = await import('../services/usage_metering.js');
            await meterBuildComputeMinutes(env, {
              orgId: params.orgId,
              siteId: params.siteId,
              minutes: buildMinutes,
              buildVersion: version,
            });
          } catch {
            // fail-soft — metering must never break the build
          }
        })();

        // GitHub repo sync — commit + push all generated files to the site's
        // private repo at github.com/projectsites-dev/{siteId}. Fire-and-forget
        // so GitHub latency never blocks the build status response.
        // Feature-flag-gated behind `github_repo_sync` (experimental, default-off).
        void (async () => {
          try {
            const { isFlagOn } = await import('../modules/feature_flags/services.js');
            if (
              !(await isFlagOn(env, 'github_repo_sync', {
                orgId: params.orgId,
                siteId: params.siteId,
              }))
            )
              return;
            const { pushBuild } = await import('../services/github_repo.js');
            const files = ([] as Array<{ name: string; content: string }>).map((f) => ({
              path: f.name.startsWith('/') ? f.name.slice(1) : f.name,
              content: f.content,
            }));
            await pushBuild(env, params.siteId, files, `feat(site): build ${version}`);
          } catch {
            // fail-soft — GitHub sync must never break the build pipeline
          }
        })();

        // BRAND GATE — runs BEFORE the published flip (the step-3.5 validate-build
        // runs AFTER publish, so brand placeholders shipped live twice). Load the
        // uploaded files and run ONLY the brand validator; a hit flips the site to
        // error instead of published (the step-3.5 report still logs the detail).
        {
          try {
            const rawFiles = await loadBuildFromR2(
              env.SITES_BUCKET,
              `sites/${params.slug}/${version}/`,
            );
            const {
              validateNoBrandPlaceholders,
              validateBrandNameMatch,
              repairDoubleDotCanonical,
              repairDanglingEmDash,
              finalizeSeoInvariants,
            } = await import('../services/build_validators.js');

            // DOUBLE-DOT REPAIR + PERSIST — the container's pre-build token pass
            // runs BEFORE the LLM, but the LLM writes the canonical as
            // `https://<slug>..projectsites.dev` DURING the build. Repair the
            // uploaded copies first (deterministic, no LLM compliance), persist
            // the corrected text back to R2, and gate the REPAIRED build — the
            // double-dot class can never gate-fail a repairable build again.
            const [files, doubleDotRepaired] = repairDoubleDotCanonical(rawFiles);
            if (doubleDotRepaired > 0) {
              for (const f of files) {
                if (typeof f.text === 'string') {
                  await env.SITES_BUCKET.put(`sites/${params.slug}/${version}/${f.path}`, f.text);
                }
              }
              await wfLog('workflow.double_dot_repaired', {
                repairedFiles: doubleDotRepaired,
                message: `Repaired ..projectsites.dev canonical in ${doubleDotRepaired} file(s) before the brand gate`,
              });
            }

            // DANGLING EM-DASH REPAIR + PERSIST — same mid-build authorship
            // class: the LLM composes '<title>NAME — </title>' when the
            // tagline is empty (the seed is ''). Collapse it, persist, gate
            // the repaired copies.
            const [dashRepairedFiles, dashRepaired] = repairDanglingEmDash(files);
            if (dashRepaired > 0) {
              for (const f of dashRepairedFiles) {
                if (typeof f.text === 'string') {
                  await env.SITES_BUCKET.put(`sites/${params.slug}/${version}/${f.path}`, f.text);
                }
              }
              await wfLog('workflow.dangling_dash_repaired', {
                repairedFiles: dashRepaired,
                message: `Repaired dangling em-dash in ${dashRepaired} file(s) before the brand gate`,
              });
            }
            const dashFiles = dashRepaired > 0 ? dashRepairedFiles : files;

            // SEO INVARIANT FINALIZER — deterministic structured-data + meta backstop
            // (C.1). Prod ground-truth 2026-09-07: deployed sites ship ZERO real
            // JSON-LD blocks (the template carries the open-now CONSUMER widget that
            // reads script[type=application/ld+json] but the build never EMITS the
            // data) + sub-120-char descriptions + JS `\'` escapes leaking into meta.
            // Report-mode validators log it, never block → it ships live. Inject
            // WebSite+Organization+WebPage+BreadcrumbList, expand/clamp meta, unescape
            // — all from shell signals (og:title/canonical/og:image) + the real name,
            // no fabrication. Persist the repaired copies, gate the finalized build.
            const [seoFiles, seoReport] = finalizeSeoInvariants(dashFiles, {
              businessName: params.businessName,
              hostname: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
            });
            const seoChanged =
              seoReport.jsonLdInjected +
              seoReport.escapesRepaired +
              seoReport.descExpanded +
              seoReport.titleClamped;
            if (seoChanged > 0) {
              for (let i = 0; i < seoFiles.length; i++) {
                const f = seoFiles[i];
                if (typeof f.text === 'string' && f.text !== dashFiles[i]?.text) {
                  await env.SITES_BUCKET.put(`sites/${params.slug}/${version}/${f.path}`, f.text);
                }
              }
              await wfLog('workflow.seo_invariants_finalized', {
                jsonLdInjected: seoReport.jsonLdInjected,
                escapesRepaired: seoReport.escapesRepaired,
                descExpanded: seoReport.descExpanded,
                titleClamped: seoReport.titleClamped,
                message: `SEO finalizer before brand gate: +${seoReport.jsonLdInjected} JSON-LD block(s), ${seoReport.escapesRepaired} escape fix(es), ${seoReport.descExpanded} desc expanded, ${seoReport.titleClamped} title clamped`,
              });
            }
            const gatedFiles = seoFiles;

            // BOTH brand gates: placeholders AND the invented-name mismatch.
            // (The name-match check was only wired into the report-only
            // validate-build step — a mismatch published anyway.)
            const brandViolations = [
              ...validateNoBrandPlaceholders(gatedFiles),
              ...validateBrandNameMatch(gatedFiles, params.businessName),
            ];
            if (brandViolations.length > 0) {
              await updateSiteStatus(env.DB, params.siteId, 'error');
              await wfLog('workflow.brand_gate_failed', {
                violations: brandViolations.slice(0, 10),
                message: `Brand gate failed — refusing to publish: ${brandViolations[0]?.message ?? 'unknown'}`,
              });
              throw new Error(
                `Brand gate failed: ${brandViolations.map((v) => v.message).join('; ')}`,
              );
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith('Brand gate failed')) {
              throw err; // real brand failure — propagate
            }
            // load/build-validator errors are NOT brand failures — fail-soft so a
            // validator bug never blocks a legitimate publish.
          }
        }

        // Update D1 status to published. Hardened (journey 2026-08-19 — the
        // raw .run() silently left a row stranded at 'generating' while the
        // workflow completed, and NOTHING re-reconciled it): the hardened
        // dbExecute returns {error, changes} instead of throwing, and a
        // zero-affected or errored flip is audit-logged + retried once via
        // the status-only helper (which also flips on a re-created row).
        const { dbExecute } = await import('../services/db.js');
        const flipRes = await dbExecute(
          env.DB,
          "UPDATE sites SET status = 'published', current_build_version = ?, updated_at = datetime('now') WHERE id = ?",
          [version, params.siteId],
        );
        if (flipRes.error || flipRes.changes === 0) {
          await wfLog('workflow.publish_flip_failed', {
            error: flipRes.error,
            changes: flipRes.changes,
            message: `published flip zero-affected or errored (changes=${flipRes.changes}) — retrying via updateSiteStatus`,
          });
          await updateSiteStatus(env.DB, params.siteId, 'published');
          const verify = await env.DB.prepare('SELECT status FROM sites WHERE id = ?')
            .bind(params.siteId)
            .first<{ status: string }>()
            .catch(() => null);
          if (verify?.status === 'published') {
            await wfLog('workflow.publish_flip_recovered', {
              message: 'status flip recovered via updateSiteStatus',
            });
          }
        }

        // Create initial snapshot
        await env.DB.prepare(
          "INSERT OR IGNORE INTO site_snapshots (id, site_id, snapshot_name, build_version, description) VALUES (?, ?, 'initial', ?, 'First published version')",
        )
          .bind(crypto.randomUUID(), params.siteId, version)
          .run();

        // Stage 5.1 — freeze the just-deployed functions bundle under this build
        // version so restoring this snapshot re-deploys exactly these functions
        // (front+back roll back together). Fail-soft: never breaks the publish.
        try {
          const { freezeFunctionsBundleForSnapshot } =
            await import('../services/functions_deploy.js');
          await freezeFunctionsBundleForSnapshot(env, params.siteId, version);
        } catch {
          /* fail-soft — a functions freeze must never fail the site publish */
        }

        // Emit site.generated onto the durable bus — the build produced + uploaded
        // a published bundle. Drained to Tinybird (build-funnel analytics) + Hatchet
        // (post-publish orchestration: QA, search-submit, promotion). Idempotent per
        // (siteId, version) so a re-run of the SAME version is a no-op while a genuine
        // rebuild (new version) emits afresh; tryEmitEvent never throws.
        await tryEmitEvent(
          env,
          {
            type: 'site.generated',
            producer: 'cloudflare-workflows',
            tenantId: params.orgId,
            traceId: params.siteId,
            siteId: params.siteId,
            data: {
              slug: params.slug,
              version,
              fileCount,
              uploadCount,
              url: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
            },
          },
          { scope: [params.siteId, version] },
        );

        await emitBuildEvent(env, params.siteId, {
          type: 'preview.updated',
          url: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
        });

        // Best-effort: accumulate the build's AI spend into the token-burn meter.
        // The container build's exact token usage isn't surfaced here yet, so we
        // record a conservative per-build estimate keyed off elapsed time. Never
        // throws; flag-gated so it's a no-op when token_burn_meter is off.
        try {
          const meterOn = await isFlagOn(env, 'token_burn_meter', { orgId: params.orgId }).catch(
            () => false,
          );
          if (meterOn) {
            const elapsedSec = finalStatus!.elapsed || 0;
            // Rough container-build estimate: ~$0.01 per build-minute, $1 floor.
            const estUsd = Math.max(1, (elapsedSec / 60) * 0.01);
            await recordSpend(env, params.orgId, {
              tokensIn: 0,
              tokensOut: 0,
              model: 'container-build',
              usd: estUsd,
              siteId: params.siteId,
            });
          }
        } catch {
          // metering must never break the build
        }

        return JSON.stringify({ fileCount, version });
      },
    );

    // ── Step 3.5: Build validators (report mode — log to D1, never throw) ──
    // Enforces audit recommendations: asset existence, JSON-LD count, image format,
    // og-image quality, apple-touch-icon, meta lengths, H1 in shell, sitemap lastmod,
    // banned slop words, JS chunk size, lightbox presence, required well-known files.
    // See services/build_validators.ts and skill 15 quality-gates.md.
    await step.do(
      'validate-build',
      {
        retries: { limit: 1, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      },
      async () => {
        try {
          await emitBuildEvent(env, params.siteId, {
            type: 'tests.started',
            runner: 'build_validators',
          });
          const prefix = `sites/${params.slug}/${version}/`;
          const files = await loadBuildFromR2(env.SITES_BUCKET, prefix);
          // 1:N sitemap fidelity guard: activate validateRouteCount in the LIVE pipeline by
          // sourcing the source route count from `_scraped_content.json` (container context)
          // when present. No-op when absent — never fails a build lacking the context file.
          let sourceRouteCount: number | undefined;
          try {
            const scraped = files.find((f) => f.path.endsWith('_scraped_content.json'))?.text;
            if (scraped) {
              const parsed = JSON.parse(scraped) as { routes?: unknown[] };
              if (Array.isArray(parsed.routes)) sourceRouteCount = parsed.routes.length;
            }
          } catch {
            // malformed context JSON → skip the guard, never break the build on it
          }
          const report = validateBuild(files, {
            ...(sourceRouteCount !== undefined ? { sourceRouteCount } : {}),
            expectedBusinessName: params.businessName,
          });
          const readiness = scoreReadiness(report);
          await emitBuildEvent(env, params.siteId, {
            type: 'tests.completed',
            passed: report.ok ? 1 : 0,
            failed: report.errors.length,
          });
          await wfLog('workflow.build_validation', {
            ok: report.ok,
            file_count: files.length,
            errors: report.errors.slice(0, 50),
            warnings: report.warnings.slice(0, 50),
            summary: report.summary,
            // Production-Readiness grade (backlog #9) — queryable for the admin
            // readiness widget without a schema change.
            readiness_grade: readiness.grade,
            readiness_score: readiness.score,
            readiness_passing: readiness.passing,
            readiness_breakdown: readiness.breakdown,
            message: `Build validation: ${report.summary} · readiness ${readiness.grade} (${readiness.score}/100)`,
          });
          return JSON.stringify({
            ok: report.ok,
            summary: report.summary,
            readiness: {
              grade: readiness.grade,
              score: readiness.score,
              passing: readiness.passing,
            },
          });
        } catch (err) {
          await wfLog('workflow.build_validation_error', {
            error: err instanceof Error ? err.message : String(err),
            message: 'Build validation skipped due to error',
          });
          return JSON.stringify({ skipped: true });
        }
      },
    );

    // ── Step 4: Final visual inspection (non-blocking) ──
    await step.do(
      'visual-inspection',
      {
        retries: { limit: 1, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      },
      async () => {
        if (!env.OPENAI_API_KEY) return JSON.stringify({ skipped: true, reason: 'no_openai_key' });
        try {
          const ssUrl = `https://api.microlink.io/?url=https://${params.slug}${DOMAINS.SITES_SUFFIX}&screenshot=true&meta=false&embed=screenshot.url`;
          const ssRes = await fetch(ssUrl);
          if (!ssRes.ok) return JSON.stringify({ skipped: true, reason: 'screenshot_failed' });
          const ssData = (await ssRes.json()) as { data?: { screenshot?: { url?: string } } };
          const imageUrl = ssData?.data?.screenshot?.url;
          if (!imageUrl) return JSON.stringify({ skipped: true, reason: 'no_screenshot_url' });

          const { response: critiqueRes } = await gatewayFetch(
            env,
            'openai',
            '/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: 'Score this website screenshot 1-10 on visual quality. List top 5 issues. Return JSON: { score: number, issues: string[], logo_visible: boolean, brand_colors_correct: boolean }',
                      },
                      { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
                    ],
                  },
                ],
                max_tokens: 500,
                temperature: 0.2,
              }),
            },
          );
          if (!critiqueRes.ok) return JSON.stringify({ skipped: true, reason: 'gpt4o_failed' });
          const critiqueData = (await critiqueRes.json()) as {
            choices: { message: { content: string } }[];
          };
          const raw = critiqueData.choices?.[0]?.message?.content || '';
          const cleaned = raw
            .replace(/```json\n?/g, '')
            .replace(/```/g, '')
            .trim();
          const parsed = JSON.parse(cleaned) as { score?: number; issues?: string[] };

          await wfLog('workflow.visual_inspection', {
            score: parsed.score,
            issues: parsed.issues,
            screenshot_url: imageUrl,
            message: `Visual inspection: score=${parsed.score}/10, ${(parsed.issues || []).length} issues`,
          });

          return JSON.stringify(parsed);
        } catch {
          return JSON.stringify({ skipped: true, reason: 'error' });
        }
      },
    );

    // ── Step 4.5: Benchmark + retrospective (non-blocking, $0 default) ──
    // Tier 1 (programmatic) + Tier 2 (PSI) both free. Retrospective LLM call
    // (~$0.001 Haiku) only fires when build regressed or score < 0.85.
    // See services/benchmark.ts and services/retrospective.ts.
    await step.do(
      'benchmark-and-learn',
      {
        retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
        timeout: '3 minutes',
      },
      async () => {
        try {
          const { runBenchmarks } = await import('../services/benchmark.js');
          const { buildRetrospective, recordRetrospectivePath } =
            await import('../services/retrospective.js');

          const prevRow = (await env.DB.prepare(
            'SELECT id, mean_score FROM site_benchmarks WHERE site_id = ? ORDER BY run_at DESC LIMIT 1',
          )
            .bind(params.siteId)
            .first()) as { id: string; mean_score: number | null } | null;

          const result = await runBenchmarks({
            env,
            siteId: params.siteId,
            slug: params.slug,
            siteUrl: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
            previousMeanScore: prevRow?.mean_score ?? null,
          });

          await wfLog('workflow.benchmark', {
            mean_score: result.meanScore,
            programmatic_score: result.programmatic.score,
            psi_perf: result.psi?.performance ?? null,
            regressed: result.regressedFromPrevious,
            banned_words: result.programmatic.bannedWordHits,
            message: `Benchmark: mean=${result.meanScore.toFixed(2)} regressed=${result.regressedFromPrevious}`,
          });

          const retro = await buildRetrospective({ env, current: result });
          if (!retro.generated) {
            await wfLog('workflow.retrospective_skipped', {
              reason: retro.skipReason,
            });
            return JSON.stringify({ benchmark: result.meanScore, retrospective: 'skipped' });
          }

          const retroRow = (await env.DB.prepare(
            'SELECT id FROM site_benchmarks WHERE site_id = ? ORDER BY run_at DESC LIMIT 1',
          )
            .bind(params.siteId)
            .first()) as { id: string } | null;

          const retroPath = `retrospectives/${retro.filename}`;
          await env.SITES_BUCKET.put(retroPath, retro.markdown, {
            httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
          });

          if (retroRow) await recordRetrospectivePath(env, retroRow.id, retroPath);

          await wfLog('workflow.retrospective_generated', {
            path: retroPath,
            filename: retro.filename,
            message: `Retrospective written to ${retroPath}`,
          });

          return JSON.stringify({ benchmark: result.meanScore, retrospective: retroPath });
        } catch (err) {
          await wfLog('workflow.benchmark_error', {
            error: err instanceof Error ? err.message : String(err),
            message: 'Benchmark/retrospective skipped due to error',
          });
          return JSON.stringify({ skipped: true });
        }
      },
    );

    // ── Step 5: Send notification ──
    await step.do(
      'notify',
      {
        retries: { limit: 1, delay: '5 seconds', backoff: 'exponential' },
        timeout: '30 seconds',
      },
      async () => {
        try {
          // Look up user email for notification
          const siteRow = (await env.DB.prepare(
            'SELECT o.id as org_id FROM sites s JOIN orgs o ON s.org_id = o.id WHERE s.id = ? AND s.deleted_at IS NULL AND o.deleted_at IS NULL',
          )
            .bind(params.siteId)
            .first()) as { org_id: string } | null;
          if (siteRow) {
            // Notify an ACTIVE org member — filter soft-deleted memberships/users so a
            // person removed from the org never receives this "your site is built" email.
            const userRow = (await env.DB.prepare(
              'SELECT u.email FROM memberships m JOIN users u ON m.user_id = u.id WHERE m.org_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL LIMIT 1',
            )
              .bind(siteRow.org_id)
              .first()) as { email: string } | null;
            if (userRow?.email) {
              const { notifySiteBuilt } = await import('../services/notifications.js');
              await notifySiteBuilt(env, {
                email: userRow.email,
                siteName: params.businessName,
                slug: params.slug,
                siteUrl: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
                version: (JSON.parse(filesJson) as { version: string }).version,
              });
            }
          }
        } catch {
          // Non-critical
        }
        return 'ok';
      },
    );

    const totalSeconds = Math.round((Date.now() - startTime) / 1000);
    const result = JSON.parse(filesJson) as { fileCount: number; version: string };

    await wfLog('workflow.complete', {
      slug: params.slug,
      url: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
      total_seconds: totalSeconds,
      files: result.fileCount,
      version: result.version,
      message: `Published ${params.businessName} with ${result.fileCount} files in ${totalSeconds}s`,
    });

    await emitBuildEvent(env, params.siteId, {
      type: 'publish.completed',
      fileCount: result.fileCount,
      version: result.version,
    });

    // Notify the org owner that their AI-built site is live (ai.job.completed).
    // In a step.do so workflow replay never double-sends. Best-effort.
    await step.do('notify-owner-published', async () => {
      try {
        const { notifyOwnerEvent } = await import('../services/notify.js');
        const r = await notifyOwnerEvent(env, env.DB, {
          orgId: params.orgId,
          event: {
            event: 'build.finished',
            tenantId: params.orgId,
            siteId: params.siteId,
            previewUrl: `https://${params.slug}${DOMAINS.SITES_SUFFIX}`,
          },
        });
        return r.ok ? 'sent' : `skipped:${r.detail ?? 'unknown'}`;
      } catch {
        return 'error';
      }
    });

    // Release the container DO slot on terminal — without this the instance
    // holds its running-slot for the full sleepAfter (90m), and repeated
    // builds exhaust the max_instances pool ('Maximum number of running
    // container instances exceeded' — hit live 2026-08-19 after ~10 journey
    // builds). stop() is a SIGTERM: the job already terminal, nothing lost.
    if (env.SITE_BUILDER) {
      try {
        // Release the ACTIVE container's slot — after an eviction restart the
        // live slot-holder is the `-r1` fresh DO, NOT the original name this
        // closure captured at build start. Stopping the original leaked the
        // restarted container into the pool for its full sleepAfter — with
        // restarts + concurrent sessions + the journey's rebuilds that
        // exhausted max_instances (live 2026-08-20: 'no container instance
        // can be provided'). Stop BOTH (cheap, idempotent) so no path leaks.
        const stopAll = [getContainer(), activeContainer()];
        for (const container of stopAll) {
          try {
            const stub = container as unknown as { stop: () => Promise<void> };
            await stub.stop().catch(() => {});
          } catch {
            /* best-effort — the sleepAfter expiry is the backstop */
          }
        }
      } catch {
        /* best-effort — the sleepAfter expiry is the backstop */
      }
    }

    return {
      siteId: params.siteId,
      slug: params.slug,
      status: 'published',
      files: result.fileCount,
      elapsed_seconds: totalSeconds,
    };
  }
}
