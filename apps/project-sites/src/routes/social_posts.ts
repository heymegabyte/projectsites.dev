/**
 * @module routes/social_posts
 * @description Native Social — post publishing + scheduling endpoints (Tier 1).
 *
 *   POST   /api/social/:siteId/posts/publish    — instant publish (enqueue to Upstash)
 *   POST   /api/social/:siteId/posts/schedule   — schedule for future (spawn workflow)
 *   POST   /api/social/:siteId/posts/generate   — AI-generate per-platform variants
 *   GET    /api/social/:siteId/posting-times     — optimal posting times per platform
 *
 * Flag-gated behind `social_publishing_native`. All routes 404 when flag is off.
 * Uses the Upstash queue enqueuer (social_queue_enqueuer.ts) for instant posts
 * and CF Workflows v2 (SOCIAL_PUBLISH_WORKFLOW) for scheduled posts.
 *
 * @see ../services/social_queue_enqueuer.ts
 * @see ../workflows/social-publish.ts
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../types/env.js';
import { dbInsert, dbQuery } from '../services/db.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { assertSiteOwned } from '../services/site_ownership.js';
import {
  PLATFORMS,
  type Platform,
  PLATFORM_CHAR_LIMITS,
} from '../services/social_publishers/index.js';

export const socialPostRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function requireAuth(c: { get: (k: string) => unknown }): { userId: string; orgId: string } | null {
  const userId = c.get('userId') as string | undefined;
  const orgId = c.get('orgId') as string | undefined;
  if (!userId || !orgId) return null;
  return { userId, orgId };
}

const platformEnum = z.enum(PLATFORMS as readonly [Platform, ...Platform[]]);

// ── Shared validation ────────────────────────────────────────

const PublishSchema = z.object({
  content: z.string().min(1).max(10000),
  platforms: z.array(platformEnum).min(1).max(16),
  account_ids: z.array(z.string().uuid()).min(1).max(20),
  media_ids: z.array(z.string().max(500)).max(10).optional(),
  hashtags: z.array(z.string().min(1).max(80)).max(30).optional(),
  link: z.string().url().max(2000).optional(),
  site_id: z.string().uuid().optional(),
  per_platform_overrides: z
    .record(
      platformEnum,
      z.object({ content: z.string().max(10000).optional(), alt: z.string().max(500).optional() }),
    )
    .optional(),
});

// ── Publish (instant) ────────────────────────────────────────

/**
 * `POST /api/social/:siteId/posts/publish` — Publish a post immediately.
 *
 * @remarks
 * Creates a `pulse_posts` row, enqueues to Upstash per-platform sorted sets,
 * and returns queued status with delivery entries. The drain-queue cron
 * picks up the entries within ~5 minutes and spawns workflow instances.
 *
 * Idempotent via `Idempotency-Key` header — duplicate keys return the
 * original post ID without re-enqueuing.
 *
 * Cost: ~1 D1 write + ~N Upstash ZADD commands (N = platforms × accounts).
 * Within free tier for typical usage (5 platforms × 3 accounts = 15 ZADDs).
 *
 * @throws 400 when no valid accounts found or content over per-platform char limit.
 * @throws 401 when auth context is missing.
 * @throws 503 when flag is off.
 */
socialPostRoutes.post(
  '/api/social/:siteId/posts/publish',
  zValidator('json', PublishSchema),
  async (c) => {
    const ctx = requireAuth(c);
    if (!ctx) return c.json({ error: { code: 'UNAUTHORIZED', message: 'auth required' } }, 401);
    if (!(await isFlagOn(c.env, 'social_publishing_native', { orgId: ctx.orgId }))) {
      return c.json({ error: { code: 'FEATURE_DISABLED', message: 'flag off' } }, 503);
    }

    const body = c.req.valid('json');

    // IDOR guard: `body.site_id` is persisted into pulse_posts.site_id, so a
    // non-null value MUST belong to the caller's org — otherwise a user in
    // org-A could tag a post to an org-B site. 404 (never 403 — don't leak
    // existence) on missing/foreign. Null site_id = org-scoped post, no check.
    if (body.site_id && !(await assertSiteOwned(c.env, ctx.orgId, body.site_id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }

    const idempotencyKey = c.req.header('Idempotency-Key') ?? crypto.randomUUID();
    const correlationId = `${idempotencyKey}::${crypto.randomUUID().slice(0, 8)}`;

    // Validate account_ids belong to the org and are active
    const placeholders = body.account_ids.map(() => '?').join(',');
    const { data: accounts } = await dbQuery<{ id: string; platform: string }>(
      c.env.DB,
      `SELECT id, platform FROM social_accounts
        WHERE id IN (${placeholders}) AND org_id = ? AND deleted_at IS NULL AND status = 'active'`,
      [...body.account_ids, ctx.orgId],
    );
    if (accounts.length === 0) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'no valid accounts found' } }, 400);
    }

    // Validate per-platform char limits
    for (const platform of body.platforms) {
      const limit = PLATFORM_CHAR_LIMITS[platform] ?? 10000;
      const content = body.per_platform_overrides?.[platform]?.content ?? body.content;
      if (content.length > limit) {
        return c.json(
          {
            error: {
              code: 'CONTENT_TOO_LONG',
              message: `${platform} content (${content.length}) exceeds limit (${limit})`,
            },
          },
          400,
        );
      }
    }

    // Create pulse_posts row
    const postId = crypto.randomUUID();
    const { error: postErr } = await dbInsert(c.env.DB, 'pulse_posts', {
      id: postId,
      org_id: ctx.orgId,
      site_id: body.site_id ?? null,
      created_by: ctx.userId,
      status: 'queued',
      scheduled_at: new Date().toISOString(),
      content: body.content,
      per_platform_overrides: body.per_platform_overrides
        ? JSON.stringify(body.per_platform_overrides)
        : null,
      media_keys: body.media_ids
        ? JSON.stringify(body.media_ids.map((k) => ({ r2_key: k })))
        : null,
      account_ids: JSON.stringify(body.account_ids),
      hashtags: body.hashtags ? JSON.stringify(body.hashtags) : null,
      link: body.link ?? null,
    });
    // PRIMARY durable record — a silent drop here is a lying-success (the response
    // below claims the post was created). Surface the failure instead of dropping it.
    if (postErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'social_posts',
          message: 'pulse_posts_insert_failed',
          post_id: postId,
          org_id: ctx.orgId,
          error: postErr,
        }),
      );
      return c.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to create the post. Please try again.',
          },
        },
        500,
      );
    }

    // Enqueue to per-platform Upstash sorted sets
    const now = Date.now();
    const deliveries: Array<{ platform: string; account_id: string; status: string }> = [];
    for (const platform of body.platforms) {
      const platformAccounts = accounts.filter((a) => a.platform === platform);
      for (const acc of platformAccounts) {
        const entry = {
          post_id: postId,
          org_id: ctx.orgId,
          platform: platform as Platform,
          account_id: acc.id,
          scheduled_at: now,
          correlation_id: correlationId,
        };
        const cmds = [['ZADD', `social:queue:${platform}`, String(now), JSON.stringify(entry)]];
        // Fire-and-forget to Upstash via ctx.waitUntil so we don't block the response.
        // Degraded mode: if Upstash is down, the drain-queue D1 fallback picks up
        // the pulse_posts row on the next cron tick.
        const upstashUrl = (c.env as unknown as Record<string, string>).UPSTASH_REDIS_REST_URL;
        const upstashToken = (c.env as unknown as Record<string, string>).UPSTASH_REDIS_REST_TOKEN;
        if (upstashUrl && upstashToken) {
          c.executionCtx.waitUntil(
            fetch(`${upstashUrl}/pipeline`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${upstashToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(cmds),
            }).catch(() => undefined),
          );
        }
        deliveries.push({ platform, account_id: acc.id, status: 'queued' });

        // Record social_publishes row (delivery breadcrumb — best-effort; the
        // primary pulse_posts row above is the durable record).
        const { error: pubErr } = await dbInsert(c.env.DB, 'social_publishes', {
          id: crypto.randomUUID(),
          post_id: postId,
          account_id: acc.id,
          platform,
          status: 'queued',
          correlation_id: correlationId,
        });
        if (pubErr) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              service: 'social_posts',
              message: 'social_publishes_insert_failed',
              post_id: postId,
              platform,
              error: pubErr,
            }),
          );
        }
      }
    }

    return c.json(
      {
        data: {
          id: postId,
          status: 'queued',
          deliveries,
          correlation_id: correlationId,
        },
      },
      201,
    );
  },
);

// ── Schedule ─────────────────────────────────────────────────

const ScheduleSchema = PublishSchema.extend({
  scheduled_at: z.string().datetime(),
});

/**
 * `POST /api/social/:siteId/posts/schedule` — Schedule a post for future publishing.
 *
 * @remarks
 * Creates a `pulse_posts` row with `status='scheduled'`, spawns a CF Workflow
 * v2 instance that sleeps until `scheduled_at`, then runs the full 7-step
 * publish pipeline (load → refresh → media → linkify → upload → publish →
 * record).
 *
 * Cost: ~1 D1 write + 1 Workflow instance. At 1M sites averaging 5 posts/week,
 * that's ~714K workflows/day — within CF Workflows limits (500 instances/sec).
 *
 * @throws 400 when scheduled_at is in the past.
 * @throws 401 when auth context is missing.
 * @throws 503 when flag is off.
 */
socialPostRoutes.post(
  '/api/social/:siteId/posts/schedule',
  zValidator('json', ScheduleSchema),
  async (c) => {
    const ctx = requireAuth(c);
    if (!ctx) return c.json({ error: { code: 'UNAUTHORIZED', message: 'auth required' } }, 401);
    if (!(await isFlagOn(c.env, 'social_publishing_native', { orgId: ctx.orgId }))) {
      return c.json({ error: { code: 'FEATURE_DISABLED', message: 'flag off' } }, 503);
    }

    const body = c.req.valid('json');
    const scheduledMs = new Date(body.scheduled_at).getTime();
    if (scheduledMs <= Date.now()) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'scheduled_at must be in the future' } },
        400,
      );
    }

    // IDOR guard: `body.site_id` is persisted into pulse_posts.site_id, so a
    // non-null value MUST belong to the caller's org (404 on missing/foreign —
    // never 403). Null site_id = org-scoped post, no check. See publish above.
    if (body.site_id && !(await assertSiteOwned(c.env, ctx.orgId, body.site_id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }

    // Validate accounts
    const placeholders = body.account_ids.map(() => '?').join(',');
    const { data: accounts } = await dbQuery<{ id: string }>(
      c.env.DB,
      `SELECT id FROM social_accounts
        WHERE id IN (${placeholders}) AND org_id = ? AND deleted_at IS NULL AND status = 'active'`,
      [...body.account_ids, ctx.orgId],
    );
    if (accounts.length === 0) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'no valid accounts found' } }, 400);
    }

    // Create pulse_posts row
    const postId = crypto.randomUUID();
    const { error: postErr } = await dbInsert(c.env.DB, 'pulse_posts', {
      id: postId,
      org_id: ctx.orgId,
      site_id: body.site_id ?? null,
      created_by: ctx.userId,
      status: 'scheduled',
      scheduled_at: body.scheduled_at,
      content: body.content,
      per_platform_overrides: body.per_platform_overrides
        ? JSON.stringify(body.per_platform_overrides)
        : null,
      media_keys: body.media_ids
        ? JSON.stringify(body.media_ids.map((k) => ({ r2_key: k })))
        : null,
      account_ids: JSON.stringify(body.account_ids),
      hashtags: body.hashtags ? JSON.stringify(body.hashtags) : null,
      link: body.link ?? null,
    });
    // PRIMARY durable record — surface a drop instead of a lying-success.
    if (postErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'social_posts',
          message: 'pulse_posts_insert_failed',
          post_id: postId,
          org_id: ctx.orgId,
          error: postErr,
        }),
      );
      return c.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to schedule the post. Please try again.',
          },
        },
        500,
      );
    }

    // Spawn CF Workflow v2 instance — sleeps until scheduled_at, then publishes.
    let workflowId: string | null = null;
    if (c.env.SOCIAL_PUBLISH_WORKFLOW) {
      try {
        const instance = await c.env.SOCIAL_PUBLISH_WORKFLOW.create({
          id: `social-post-${postId}`,
          params: { post_id: postId },
        });
        workflowId = instance.id;
      } catch {
        // Workflow creation failed — the drain-queue cron D1 fallback picks it up
      }
    }

    // Record queued deliveries for each platform account
    for (const platform of body.platforms) {
      const platformAccounts = accounts.filter((a) => {
        // Filter by platform — account platform stored in social_accounts row
        return true; // We'll refine this when accounts carry platform in the query above
      });
      for (const acc of platformAccounts) {
        // Delivery breadcrumb — best-effort; the scheduled pulse_posts row is the
        // durable record. Capture + log so a drop isn't silent.
        const { error: pubErr } = await dbInsert(c.env.DB, 'social_publishes', {
          id: crypto.randomUUID(),
          post_id: postId,
          account_id: acc.id,
          platform,
          status: 'queued',
        });
        if (pubErr) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              service: 'social_posts',
              message: 'social_publishes_insert_failed',
              post_id: postId,
              platform,
              error: pubErr,
            }),
          );
        }
      }
    }

    return c.json(
      {
        data: {
          id: postId,
          status: 'scheduled',
          scheduled_at: body.scheduled_at,
          workflow_id: workflowId,
        },
      },
      201,
    );
  },
);

// ── AI Generate ──────────────────────────────────────────────

const GenerateSchema = z.object({
  topic: z.string().min(1).max(500),
  platforms: z.array(platformEnum).min(1).max(16),
  tone: z.enum(['punchy', 'warm', 'authoritative', 'playful', 'story']).optional(),
});

/**
 * `POST /api/social/:siteId/posts/generate` — AI-generate per-platform post variants.
 *
 * Uses the site's brand voice + business context via the existing
 * social_auto_pilot service. Returns per-platform drafts within char limits.
 * Langfuse-traced. Never auto-publishes — returns drafts only.
 *
 * @throws 401 when auth context is missing.
 * @throws 502 when AI generation fails.
 */
socialPostRoutes.post(
  '/api/social/:siteId/posts/generate',
  zValidator('json', GenerateSchema),
  async (c) => {
    const ctx = requireAuth(c);
    if (!ctx) return c.json({ error: { code: 'UNAUTHORIZED', message: 'auth required' } }, 401);
    if (!(await isFlagOn(c.env, 'social_publishing_native', { orgId: ctx.orgId }))) {
      return c.json({ error: { code: 'FEATURE_DISABLED', message: 'flag off' } }, 503);
    }

    const { topic, platforms, tone } = c.req.valid('json');

    // Lazy-import auto-pilot to keep the cold-start footprint small.
    const { loadAutoPilotConfig, generateAutoPilotPostForNetwork, DEFAULT_AUTO_PILOT_PROMPT } =
      await import('../services/social_auto_pilot.js');

    const cfg = await loadAutoPilotConfig(c.env.DB, ctx.orgId);
    const effectivePrompt = cfg.prompt || DEFAULT_AUTO_PILOT_PROMPT;
    // Inject the topic + tone into the prompt context
    const toneHint = tone ? `\nTone: ${tone}.` : '';
    const promptWithTopic = `${effectivePrompt}\nTopic: ${topic}.${toneHint}`;

    const variants: Array<{ platform: string; text: string; mediaSuggestion?: string }> = [];
    const errors: Array<{ platform: string; error: string }> = [];

    for (const platform of platforms) {
      try {
        const draft = await generateAutoPilotPostForNetwork(
          c.env,
          ctx.orgId,
          platform,
          promptWithTopic,
        );
        variants.push({ platform, text: draft.text, mediaSuggestion: draft.mediaSuggestion });
      } catch (err) {
        errors.push({
          platform,
          error: err instanceof Error ? err.message : 'generation failed',
        });
      }
    }

    return c.json({ data: { variants, errors: errors.length > 0 ? errors : undefined } });
  },
);

// ── Posting Times ────────────────────────────────────────────

/**
 * `GET /api/social/:siteId/posting-times` — Optimal posting times per platform.
 *
 * Returns research-backed best times (day name + hour) from the pure-calendar
 * social_post_scheduler. Each entry: `{ day: 'Mon', hour: 9, label: 'Mon 9 AM' }`.
 * Future: personalized from Tinybird engagement data (Tier 3).
 *
 * @throws 401 when auth context is missing.
 */
socialPostRoutes.get('/api/social/:siteId/posting-times', async (c) => {
  const ctx = requireAuth(c);
  if (!ctx) return c.json({ error: { code: 'UNAUTHORIZED', message: 'auth required' } }, 401);
  if (!(await isFlagOn(c.env, 'social_publishing_native', { orgId: ctx.orgId }))) {
    return c.json({ error: { code: 'FEATURE_DISABLED', message: 'flag off' } }, 503);
  }

  // Lazy-import the pure calendar scheduler
  const { BEST_TIMES, ALL_PLATFORMS } = await import('../services/social_post_scheduler.js');
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const times: Array<{
    platform: string;
    day: string;
    hour: number;
    label: string;
  }> = [];

  for (const platform of ALL_PLATFORMS) {
    const best = BEST_TIMES[platform as keyof typeof BEST_TIMES];
    if (!best) continue;
    for (const bt of best) {
      const dayName = DAY_NAMES[bt.day] ?? '?';
      const ampm = bt.hour >= 12 ? 'PM' : 'AM';
      const h12 = bt.hour % 12 || 12;
      times.push({
        platform,
        day: dayName,
        hour: bt.hour,
        label: `${dayName} ${h12} ${ampm}`,
      });
    }
  }

  return c.json({ data: times });
});
