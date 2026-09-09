/**
 * @module env
 * @description Cloudflare Worker environment bindings and Hono context variables.
 *
 * This module defines every secret, binding, and request-scoped variable used
 * by the Project Sites worker. Bindings are configured in `wrangler.toml`;
 * secrets are set via `wrangler secret put`.
 *
 * ## Binding Categories
 *
 * | Category    | Bindings                                  |
 * | ----------- | ----------------------------------------- |
 * | Storage     | `DB` (D1), `SITES_BUCKET` (R2)            |
 * | Cache       | `CACHE_KV`, `PROMPT_STORE` (KV)           |
 * | Compute     | `AI` (Workers AI), `QUEUE` (optional)     |
 * | Auth        | Google OAuth, Stripe, SendGrid            |
 * | Observ.     | PostHog, Sentry                           |
 * | Infra       | Cloudflare API (CF_API_TOKEN, CF_ZONE_ID) |
 *
 * @packageDocumentation
 */

/**
 * Cloudflare Worker environment bindings.
 *
 * All secrets and platform bindings injected by the Workers runtime.
 * Required bindings will cause a deploy-time error if missing;
 * optional ones (marked with `?`) degrade gracefully.
 *
 * @example
 * ```ts
 * // In a Hono route handler:
 * app.get('/api/example', async (c) => {
 *   const db = c.env.DB;        // D1Database
 *   const kv = c.env.CACHE_KV;  // KVNamespace
 *   const ai = c.env.AI;        // Ai
 * });
 * ```
 */
export interface Env {
  // ── KV Namespaces ──────────────────────────────────────────
  /** General-purpose cache (host→site resolution, etc.). TTL: 60 s. */
  CACHE_KV: KVNamespace;
  /** Prompt definition hot-fix store (overrides file-based prompts). */
  PROMPT_STORE: KVNamespace;

  // ── D1 Database ────────────────────────────────────────────
  /** Primary relational store (SQLite via Cloudflare D1). */
  DB: D1Database;

  // ── E2E test sign-in seam ─────────────────────────────────
  /**
   * Hardcoded password for the `brian@megabyte.space` test-login seam used by
   * the Playwright E2E suite. The `/api/auth/test-login` endpoint returns 404
   * whenever this is UNSET, so the seam never exists in normal prod — it is a
   * test affordance, never a live auth backdoor. Provision via
   * `wrangler secret put E2E_TEST_PASSWORD`. See `authenticateTestLogin`.
   */
  E2E_TEST_PASSWORD?: string;
  /**
   * Secret arming the `GET /api/auth/magic-link/peek` test seam used by the
   * Playwright suite (Pathway C real-auth round-trip in `e2e/helpers/auth.ts`).
   * The peek endpoint returns 404 whenever this is UNSET, so the seam never
   * exists in normal prod. When set, `POST /api/auth/magic-link` also stashes
   * the plaintext token in KV (15-min TTL) so the suite can complete a real
   * verification. Provision via `wrangler secret put E2E_PEEK_SECRET`.
   */
  E2E_PEEK_SECRET?: string;

  // ── R2 Object Storage ─────────────────────────────────────
  /** Static site output bucket (`sites/{slug}/{version}/`, `marketing/`). */
  SITES_BUCKET: R2Bucket;

  // ── Queue (optional) ──────────────────────────────────────
  /** Background job queue. Optional until Queues is enabled on the account. */
  QUEUE?: Queue;

  // ── Workflow ─────────────────────────────────────────────
  /** Cloudflare Workflow binding for AI site generation. */
  SITE_WORKFLOW: Workflow;
  /**
   * Workflows v2 binding for resumable Google Drive ingest. See
   * {@link workflows/drive-sync.DriveSyncWorkflow}. Optional — when missing,
   * callers fall back to the legacy `syncDriveFolder` inline path.
   */
  DRIVE_SYNC_WORKFLOW?: Workflow;
  /**
   * Workflows v2 binding for resumable AI image generation with provider
   * fallback (DALL-E 3 → Stability AI). See
   * {@link workflows/image-generation.ImageGenerationWorkflow}. Optional.
   */
  IMAGE_GENERATION_WORKFLOW?: Workflow;
  /**
   * Workflows v2 binding for snapshot quality capture (screenshot +
   * Lighthouse + composition + a11y). See
   * {@link workflows/snapshot-quality.SnapshotQualityWorkflow}. Optional —
   * when missing, capture endpoints return 503.
   */
  SNAPSHOT_QUALITY_WORKFLOW?: Workflow;
  CONTENT_FRESHNESS_WORKFLOW?: Workflow;
  /**
   * Pulse Social publish workflow binding. Fans out per-account publishes
   * for one pulse_posts row. See {@link workflows/social-publish.SocialPublishWorkflow}.
   * Fired by the every-minute due-post sweep cron.
   */
  SOCIAL_PUBLISH_WORKFLOW?: Workflow;

  // ── Pulse Social — per-platform OAuth app credentials (optional) ────
  /** Cloudflare Turnstile secret — server-side siteverify for the #32 build bot-gate. */
  TURNSTILE_SECRET_KEY?: string;
  /** Twitter / X — OAuth 2.0 app creds. https://developer.x.com/en/portal/dashboard */
  TWITTER_CLIENT_ID?: string;
  TWITTER_CLIENT_SECRET?: string;
  /** LinkedIn — OAuth 2.0 app creds. https://www.linkedin.com/developers/apps */
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  /** Facebook / Instagram / Threads — shared Meta app creds. https://developers.facebook.com/apps/ */
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  THREADS_APP_ID?: string;
  /** Reddit — OAuth installed-app creds. https://www.reddit.com/prefs/apps */
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  /** Discord — bot token (shared across orgs). https://discord.com/developers/applications */
  DISCORD_BOT_TOKEN?: string;
  /** Slack — OAuth v2 app creds. https://api.slack.com/apps */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Telegram — bot token from BotFather. */
  TELEGRAM_BOT_TOKEN?: string;

  /**
   * Cloudflare Browser Rendering binding (workers-bindings flavour). The
   * snapshot-quality workflow falls back to the REST API when the binding
   * is absent, so this is purely optional.
   */
  BROWSER?: unknown;

  /**
   * Browserbase — PREMIUM FALLBACK browser provider (captcha / residential
   * proxy / session replay / live view / long sessions). NEVER the default:
   * CF Browser Rendering (`BROWSER`) is primary; the browser gateway routes to
   * Browserbase only when CF is unavailable or a specialty case demands it.
   * @see services/browser_gateway.ts
   */
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;

  /**
   * Cloudflare Flagship — native feature-flag service binding (OpenFeature, edge-
   * evaluated in-isolate; public beta 2026). Optional: when bound,
   * `getFeatureEvaluationProvider` prefers it over the D1 engine (which stays the
   * admin source-of-truth + fallback). Typed `unknown` (platform binding, no npm
   * package); the feature-evaluation factory narrows it to `FlagshipBinding`.
   * @see middleware/feature-evaluation.ts · https://developers.cloudflare.com/flagship/
   */
  FLAGSHIP?: unknown;

  /** Claude Code build container (Durable Object). */
  SITE_BUILDER?: DurableObjectNamespace;
  /** SQLite-backed Durable Object — global trace ring buffer. */
  TRACE_HUB?: DurableObjectNamespace;
  /** SQLite-backed Durable Object — global activity feed. */
  ACTIVITY_HUB?: DurableObjectNamespace;
  /** Per-site Durable Object — Unified Analytics ingestion dispatcher (Plane H). */
  EVENT_DISPATCHER?: DurableObjectNamespace;
  // §13 self-hosted job-runner plane replaced by CF-native Workflows + Hatchet
  // Cloud (ADR-0034). All associated env vars and bindings were removed.
  // Formbricks REMOVED (2026-06-27) — exceeds the 4-service max. Container, DO
  // class, namespace, binding, host route, and all FORMBRICKS_* env deleted.

  // ─── Documenso (sign.projectsites.dev) — dedicated CF Workers Container ─────
  /** Documenso container DO binding. Optional until the watched deploy binds it; the sign.* host route degrades to 503 without it. */
  DOCUMENSO_CONTAINER?: DurableObjectNamespace;
  /** Documenso Postgres URL — Neon project `Documenso` (shiny-wind-41827027). wrangler secret. */
  DOCUMENSO_DATABASE_URL?: string;
  /** Documenso DIRECT (non-pooled) Postgres URL — required by its prisma directUrl. wrangler secret. */
  DOCUMENSO_DATABASE_DIRECT_URL?: string;
  /** Documenso SMTP password — SES-derived SMTP password (HMAC of AWS secret). wrangler secret. */
  DOCUMENSO_SMTP_PASSWORD?: string;
  /** Documenso NextAuth secret (openssl rand -base64 32). wrangler secret. */
  DOCUMENSO_NEXTAUTH_SECRET?: string;
  /** Documenso primary encryption key (openssl rand -base64 32, >=32 chars). wrangler secret. */
  DOCUMENSO_ENCRYPTION_KEY?: string;
  /** Documenso secondary encryption key (openssl rand -base64 32, >=32 chars). wrangler secret. */
  DOCUMENSO_ENCRYPTION_SECONDARY_KEY?: string;
  /** Documenso signing P12 cert, base64 (optional for boot, needed to SIGN). wrangler secret. */
  DOCUMENSO_SIGNING_CERT_B64?: string;
  /** Documenso signing P12 passphrase. wrangler secret. */
  DOCUMENSO_SIGNING_PASSPHRASE?: string;
  /** Documenso R2 (S3) access key id — scoped token for the `documenso-documents` bucket. wrangler secret. */
  DOCUMENSO_R2_ACCESS_KEY_ID?: string;
  /** Documenso R2 (S3) secret access key — sha256 of the scoped R2 API token value. wrangler secret. */
  DOCUMENSO_R2_SECRET_ACCESS_KEY?: string;
  /** Documenso Turnstile secret key — CF-minted widget for sign.projectsites.dev. wrangler secret. */
  DOCUMENSO_TURNSTILE_SECRET_KEY?: string;
  /** Documenso's DEDICATED Google OAuth client id (383658000977-…) — separate from the shared GOOGLE_CLIENT_ID. wrangler secret. */
  DOCUMENSO_GOOGLE_CLIENT_ID?: string;
  /** Documenso's DEDICATED Google OAuth client secret. wrangler secret. */
  DOCUMENSO_GOOGLE_CLIENT_SECRET?: string;

  // ─── Gotenberg (convert.projectsites.dev) — Office→PDF CF Workers Container ──
  /** Gotenberg container DO binding. Documenso's doc-conversion path proxies here; 503 until bound. */
  GOTENBERG_CONTAINER?: DurableObjectNamespace;
  /** Gotenberg basic-auth username (the endpoint is public-edge reachable). wrangler secret. */
  GOTENBERG_AUTH_USERNAME?: string;
  /** Gotenberg basic-auth password (openssl rand -hex 24). wrangler secret. */
  GOTENBERG_AUTH_PASSWORD?: string;

  // ─── cal.diy (schedule.projectsites.dev) — dedicated CF Workers Container ───
  /** cal.diy container DO binding. Optional until the watched deploy binds it; the schedule.* host route degrades to 503 without it. */
  CALDIY_CONTAINER?: DurableObjectNamespace;
  /** cal.diy Postgres URL (POOLED, runtime) — Neon project `Caldiy` (empty-surf-47784419). wrangler secret. */
  CALDIY_DATABASE_URL?: string;
  /** cal.diy Postgres DIRECT URL (non-pooled) — required by cal.com's prisma schema (directUrl). wrangler secret. */
  CALDIY_DATABASE_DIRECT_URL?: string;
  /** cal.diy NextAuth secret (openssl rand -base64 32). wrangler secret. */
  CALDIY_NEXTAUTH_SECRET?: string;
  /** cal.diy CALENDSO_ENCRYPTION_KEY (AES-256, openssl rand -base64 32). wrangler secret. */
  CALDIY_ENCRYPTION_KEY?: string;
  /**
   * Global toggle for the Unified Analytics beacon (Plane H). When `'true'`,
   * served sites inject the tracker → `/api/events` → durable D1 store → Analytics
   * tab — works via a NORMAL deploy, independent of the gated EVENT_DISPATCHER
   * DO migration (which adds external-provider fan-out on top).
   */
  ANALYTICS_INGEST_ENABLED?: string;

  // ── Workers AI ────────────────────────────────────────────
  /** Cloudflare Workers AI binding for LLM inference. */
  AI: Ai;

  // ── Vectorize (RAG) ───────────────────────────────────────
  /**
   * Cloudflare Vectorize index (768-dim cosine, bge-base-en-v1.5 embeddings).
   * Retained data-safe after the vectorize_search feature removal (child-site
   * cut, batch 9) — currently unread by any code path. Optional binding.
   *
   * Uses a local structural interface (VectorizeBinding) rather than the
   * @cloudflare/workers-types VectorizeIndex to avoid VectorizeVectorMetadata
   * incompatibility with services that use `metadata?: Record<string, unknown>`.
   *
   * @see {@link https://developers.cloudflare.com/vectorize/}
   */
  RAG_INDEX?: {
    upsert(
      vectors: Array<{
        id: string;
        values: number[];
        metadata?: Record<string, unknown>;
      }>,
    ): Promise<unknown>;
    query(
      vector: number[],
      options?: {
        topK?: number;
        filter?: Record<string, unknown>;
        returnMetadata?: 'all' | 'indexed' | boolean;
        returnValues?: boolean;
      },
    ): Promise<{
      matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
    }>;
    deleteByIds(ids: string[]): Promise<unknown>;
  };

  // ── Environment ───────────────────────────────────────────
  /** Current deployment environment (`"staging"` | `"production"`). */
  ENVIRONMENT: string;

  // ── Google Analytics & Tag Manager ────────────────────────
  /** GA4 Measurement ID (e.g., G-XXXXXXXX) injected into every served site. */
  GA4_MEASUREMENT_ID?: string;
  /** GTM Container ID (e.g., GTM-XXXXXXX) injected into every served site. */
  GTM_CONTAINER_ID?: string;
  /** Operator killswitch for the app.js concierge chat — set to `'true'` → POST /api/chat/:slug returns 404. */
  CONCIERGE_CHAT_DISABLED?: string;
  /** Operator killswitch for the "Listen to this page" AI audio — set to `'true'` → POST /api/page-audio/:slug returns 404. */
  PAGE_AUDIO_DISABLED?: string;
  /** Google Analytics Data API credentials (service account JSON, base64-encoded). */
  GA4_SERVICE_ACCOUNT_JSON?: string;
  /** GA4 Property ID for Data API queries (numeric, e.g., 123456789). */
  GA4_PROPERTY_ID?: string;

  // ── PostHog (Analytics) ───────────────────────────────────
  /** PostHog API key for server-side event capture (personal phx_* or project phc_*). */
  POSTHOG_API_KEY: string;
  /** PostHog public project key (phc_*) injected into served-site HTML. Required for client-side init. */
  POSTHOG_PUBLIC_KEY?: string;
  /** PostHog API host (defaults to `https://app.posthog.com`). */
  POSTHOG_HOST?: string;

  // ── Sentry (Error Tracking) ────────────────────────────────
  /** Sentry DSN for error tracking (worker + admin frontend). Never injected into child sites. */
  SENTRY_DSN?: string;

  // ── Langfuse (LLM Observability) ──────────────────────────
  /** Langfuse secret key (`sk-lf-*`) for server-side trace/observation ingestion. */
  LANGFUSE_SECRET_KEY?: string;
  /** Langfuse public key (`pk-lf-*`) — pairs with the secret key for Basic-auth ingestion. */
  LANGFUSE_PUBLIC_KEY?: string;
  /** Langfuse host (cloud `https://us.cloud.langfuse.com` / `https://cloud.langfuse.com`, or self-hosted). */
  LANGFUSE_BASE_URL?: string;

  // ── Stripe (Payments) ─────────────────────────────────────
  /** Stripe secret key for server-side API calls. */
  STRIPE_SECRET_KEY: string;
  /** Stripe publishable key (passed to frontend checkout). */
  STRIPE_PUBLISHABLE_KEY: string;
  /** Stripe webhook endpoint signing secret for signature verification. */
  STRIPE_WEBHOOK_SECRET: string;

  // ── Domain & Conversion ────────────────────────────────────
  /** WhoisXML API key for domain availability checking. */
  WHOISXML_API_KEY?: string;
  /** GoDaddy API key for domain registration. */
  GODADDY_API_KEY?: string;
  /** GoDaddy API secret for domain registration. */
  GODADDY_API_SECRET?: string;

  // ── CRM (Twenty @ crm.projectsites.dev — AGPL, HTTP boundary only) ─────────
  /** Twenty CRM REST base URL, e.g. https://crm.projectsites.dev. Lead store. */
  TWENTY_API_URL?: string;
  /** Twenty CRM API bearer token (workspace API key). wrangler secret. */
  TWENTY_API_KEY?: string;

  // ── Lead enrichment (optional, paid — gated by the `lead_enrichment_paid` flag) ──
  /** Paid contact-enrichment provider REST endpoint (POST {name,address} → {website,phone,email,socials}). */
  LEAD_ENRICHMENT_API_URL?: string;
  /** Paid contact-enrichment provider bearer key. wrangler secret. Never called unless the flag is on. */
  LEAD_ENRICHMENT_API_KEY?: string;

  // ── LLM Fallbacks (optional) ──────────────────────────────
  /** OpenAI API key for research pipeline and fallback LLM calls. */
  OPENAI_API_KEY?: string;
  /** Anthropic API key for Claude models in headless generation pipeline. */
  ANTHROPIC_API_KEY?: string;
  /** Model ID for the research/prompt-formulation pipeline (default: o3-mini). */
  RESEARCH_MODEL?: string;
  /** OpenRouter API key for model routing. */
  OPEN_ROUTER_API_KEY?: string;
  /** Groq API key for fast inference fallback. */
  GROQ_API_KEY?: string;
  /** DeepSeek API key — used for standard/instant tiers (OpenAI-compatible, model deepseek-chat). */
  DEEPSEEK_API_KEY?: string;
  /** Fable 5 API key — top premium rung (Brian ladder 2026-08-19). No credits yet; unset today. */
  FABLE_API_KEY?: string;
  /** Kimi K3 API key — third premium rung (Brian ladder 2026-08-19). No credits yet; unset today. */
  KIMI_API_KEY?: string;
  /** AWS access key for Amazon SES (transactional email, ADR-0019). wrangler secret. */
  AWS_ACCESS_KEY_ID?: string;
  /** AWS secret key for Amazon SES. wrangler secret. */
  AWS_SECRET_ACCESS_KEY?: string;
  /** AWS region for SES (default us-east-1). var. */
  AWS_DEFAULT_REGION?: string;
  /** Verified SES sender, e.g. noreply@mail.projectsites.dev. var. */
  SES_FROM_EMAIL?: string;
  /** HMAC secret for the inbound SES bounce/complaint webhook (Hookdeck/SNS
   * forwards SES events here, HMAC-signed). wrangler secret. */
  SES_WEBHOOK_SECRET?: string;
  /** Arcjet key for the §48 app-aware abuse layer (bot/abuse decisioning on top
   * of the CF rate limiter). Unset → fail-open. wrangler secret. */
  ARCJET_KEY?: string;
  /** HS256/session secret for the EMBEDDED Better Auth instance (auth/better-auth.ts,
   * the full-cutover rebuild). Self-generable (openssl rand -base64 32). wrangler secret. */
  BETTER_AUTH_SECRET?: string;
  /** OTLP/HTTP traces endpoint for the §35 OpenTelemetry span port, e.g.
   * https://api.honeycomb.io/v1/traces. Unset → NoopTracerProvider (ships dark;
   * Workers Tracing remains the always-on backbone). var. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** Optional OTLP headers as `k=v,k2=v2` (e.g. `x-honeycomb-team=KEY`). wrangler secret. */
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  /** Axiom ingest bearer token (`xaat-*`). Required for Axiom log shipping. wrangler secret. */
  AXIOM_TOKEN?: string;
  /** Axiom dataset name for log ingest (default `'projectsites'`). var. */
  AXIOM_DATASET?: string;
  /** Set to `'true'` to enable Axiom log ingest (default off). var. */
  AXIOM_ENABLED?: string;
  /** Public URL for the log exploration UI (e.g. Axiom or Grafana). Exposed to admin. var. */
  LOGS_PUBLIC_URL?: string;
  /** Stainless API key for the §47 SDK-codegen port — submits the OpenAPI spec
   * (/api/admin/docs/openapi.json) to generate typed client SDKs. Unset →
   * NoopSdkCodegenProvider (ships dark; no codegen runs). wrangler secret. */
  STAINLESS_API_KEY?: string;
  /** Stainless project slug the spec is published under. var. */
  STAINLESS_PROJECT?: string;
  /** Listmonk base URL, e.g. https://mail.projectsites.dev (ADR-0019). var. */
  LISTMONK_API_URL?: string;
  /** Listmonk admin/API username. wrangler secret. */
  LISTMONK_USERNAME?: string;
  /** Listmonk admin/API password/token. wrangler secret. */
  LISTMONK_PASSWORD?: string;
  /** OpenFGA API URL, e.g. https://authz.projectsites.dev (§29/ADR-0005). var. */
  OPENFGA_API_URL?: string;
  /** OpenFGA store id. var. */
  OPENFGA_STORE_ID?: string;
  /** OpenFGA bearer token (if the store requires auth). wrangler secret. */
  OPENFGA_AUTH_TOKEN?: string;
  /** OpenFGA authorization model id (optional; latest used when absent). var. */
  OPENFGA_MODEL_ID?: string;

  // ── Headless Pipeline Config ────────────────────────────────
  /** A/B model split ratio (0-1). 0.5 = 50% OpenAI, 50% Anthropic. Default: 0.5. */
  AB_MODEL_SPLIT?: string;
  /** Template cache TTL in seconds. Default: 604800 (7 days). */
  TEMPLATE_CACHE_TTL?: string;

  // ── Image Generation & Discovery ──────────────────────────
  /** Google Custom Search API key for image discovery. */
  GOOGLE_CSE_KEY?: string;
  /** Google Custom Search Engine ID for image discovery. */
  GOOGLE_CSE_CX?: string;
  /** Maximum number of AI-generated images per site (default: 5). */
  MAX_GENERATED_IMAGES?: string;

  // ── Media Discovery & Generation APIs ───────────────────────
  /** YouTube Data API v3 key for video search/discovery. */
  YOUTUBE_API_KEY?: string;
  /** Pexels API key for royalty-free stock photos + video. */
  PEXELS_API_KEY?: string;
  /** Pixabay API key for royalty-free images + video + illustrations. */
  PIXABAY_API_KEY?: string;
  /** Unsplash API access key for high-quality royalty-free photos. */
  UNSPLASH_ACCESS_KEY?: string;
  /** Ideogram API key for AI image/logo generation. */
  IDEOGRAM_API_KEY?: string;
  /** Replicate API token for Stable Diffusion, image upscaling, bg removal. */
  REPLICATE_API_TOKEN?: string;
  /** Runway API key for AI video generation (Gen-2/Gen-3). */
  RUNWAY_API_KEY?: string;

  // ── Business Data APIs ────────────────────────────────────
  /** Foursquare API key for venue photos, tips, and categories. */
  FOURSQUARE_API_KEY?: string;
  /** Yelp Fusion API key for reviews, ratings, and photos. */
  YELP_API_KEY?: string;
  /** Google Maps embed API key. */
  GOOGLE_MAPS_API_KEY?: string;

  // ── Image Optimization & Maps ─────────────────────────────
  /** Cloudinary cloud name for image transformation CDN. */
  CLOUDINARY_CLOUD_NAME?: string;
  /** Cloudinary API key for upload/transform. */
  CLOUDINARY_API_KEY?: string;
  /** Cloudinary API secret for signed requests. */
  CLOUDINARY_API_SECRET?: string;
  /** Mapbox access token for custom styled interactive maps. */
  MAPBOX_ACCESS_TOKEN?: string;

  // ── Brand Discovery APIs ──────────────────────────────────
  /** Logo.dev API token for high-res company logos by domain. */
  LOGODEV_TOKEN?: string;
  /** Brandfetch API key for full brand kits (logo, colors, fonts) by domain. */
  BRANDFETCH_API_KEY?: string;

  // ── Reviews & Trust APIs ──────────────────────────────────
  /** TripAdvisor Content API key for hospitality reviews/ratings. */
  TRIPADVISOR_API_KEY?: string;
  /** Trustpilot API key for business trust scores and reviews. */
  TRUSTPILOT_API_KEY?: string;

  // ── Generative AI APIs ────────────────────────────────────
  /** ElevenLabs API key for AI voiceover generation. */
  ELEVENLABS_API_KEY?: string;
  /** Stability AI API key for Stable Diffusion image generation. */
  STABILITY_API_KEY?: string;
  /** Remove.bg API key for background removal from product/logo images. */
  REMOVEBG_API_KEY?: string;

  // ── Animation & UX ────────────────────────────────────────
  /** LottieFiles API key for animated illustrations per business category. */
  LOTTIEFILES_API_KEY?: string;

  // ── SEO & Quality Gates ───────────────────────────────────
  /** Google PageSpeed Insights API key (can reuse GOOGLE_MAPS_API_KEY). */
  PAGESPEED_API_KEY?: string;
  /** GTmetrix API key for real performance scoring. */
  GTMETRIX_API_KEY?: string;

  // ── Contact & Location ────────────────────────────────────
  /** Hunter.io API key for discovering business email patterns. */
  HUNTER_API_KEY?: string;
  /** What3Words API key for precise location addressing. */
  WHAT3WORDS_API_KEY?: string;
  /** Abstract API key for geolocation (timezone, currency). */
  ABSTRACT_GEO_API_KEY?: string;

  // ── Analytics Embeds ──────────────────────────────────────
  /** Microsoft Clarity project ID for free heatmaps/session recordings. */
  CLARITY_PROJECT_ID?: string;
  /** Plausible Analytics domain for privacy-friendly analytics. */
  PLAUSIBLE_DOMAIN?: string;

  // ── Cloudflare API ────────────────────────────────────────
  /** Cloudflare API token for Custom Hostnames (Cloudflare for SaaS). */
  CF_API_TOKEN: string;
  /** Cloudflare zone ID for `projectsites.dev`. */
  CF_ZONE_ID: string;
  /**
   * Cloudflare global API key (legacy `X-Auth-Key`). Required when
   * `CF_API_TOKEN` lacks Account → Analytics: Read AND Zone → Analytics:
   * Read on every zone this account touches. Pair with `CLOUDFLARE_EMAIL`.
   * Used by `services/multi_url_analytics.ts` + `services/cf_credentials.ts`.
   */
  CLOUDFLARE_API_KEY?: string;
  /** Cloudflare account owner email — paired with `CLOUDFLARE_API_KEY`. */
  CLOUDFLARE_EMAIL?: string;
  /** Cloudflare Access Service Token client ID (bypasses bot protection for container builds). */
  CF_ACCESS_CLIENT_ID?: string;
  /** Cloudflare Access Service Token client secret. */
  CF_ACCESS_CLIENT_SECRET?: string;
  /** HMAC secret for container→worker build status callbacks. */
  INTERNAL_BUILD_SECRET?: string;
  /** Override callback URL (workers.dev) to bypass zone CF managed challenge. */
  INTERNAL_CALLBACK_URL?: string;

  // ── CMS content bridge (cms_content feature) ─────────────
  /** Shared HMAC secret for the Payload CMS → worker `notify-sites` revalidation webhook. */
  SITES_REVALIDATE_SECRET?: string;
  /** Payload CMS origin for the blog-feed proxy (default https://cms.projectsites.dev). */
  CMS_BASE_URL?: string;

  // ── Email (Amazon SES primary; SendGrid break-glass) ─────
  // Resend removed 2026-09-09 (Brian directive) — SES is the canonical provider.
  /** SendGrid v3 API key for transactional email. Break-glass fallback only. */
  SENDGRID_API_KEY?: string;

  // ── Native OAuth client credentials (per-provider — used by mcp_oauth.ts) ───
  // NOTE: a former capability-router subsystem was removed (Pass 28) — it was
  // unmounted dead code superseded by native OAuth (ADR-0034).
  /** Notion OAuth client ID for integration connections. */
  NOTION_OAUTH_CLIENT_ID?: string;
  /** Notion OAuth client secret for integration connections. */
  NOTION_OAUTH_CLIENT_SECRET?: string;
  /** Discord OAuth client ID for integration connections. */
  DISCORD_OAUTH_CLIENT_ID?: string;
  /** Discord OAuth client secret for integration connections. */
  DISCORD_OAUTH_CLIENT_SECRET?: string;

  // ── Chatwoot (Support Chat) ───────────────────────────────
  /** Chatwoot instance API URL. */
  CHATWOOT_API_URL?: string;
  /** Chatwoot API key. */
  CHATWOOT_API_KEY?: string;
  /** Shared secret for AgentBot webhook signature verification. */
  CHATWOOT_AGENT_BOT_SECRET?: string;

  // ── Deepcrawl (website data extraction for site pipeline) ──
  /** Deepcrawl v0 API worker base URL. If unset, Deepcrawl features are disabled. */
  DEEPCRAWL_API_URL?: string;
  /** Deepcrawl API key for authenticated endpoints. Required when AUTH_MODE=better-auth. */
  DEEPCRAWL_API_KEY?: string;

  // ── psnotify (DO-based unified notifications, replaces Novu) ──
  /** psnotify DO binding. The notification center DO inbox + preferences. */
  PSNOTIFY_DO?: DurableObjectNamespace;
  /** psnotify signing secret for webhook verification. Auto-generated if unset. */
  PSNOTIFY_SIGNING_SECRET?: string;

  // ── GitHub (OAuth) ─────────────────────────────────────────
  /** GitHub OAuth App client ID. */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App client secret. */
  GITHUB_CLIENT_SECRET?: string;
  /** GitHub org for per-site source repos — default: projectsites-dev. */
  GITHUB_ORG?: string;
  /** GitHub fine-grained PAT with repo create/contents/commit scope for the org. */
  GITHUB_REPO_TOKEN?: string;

  // ── Google (OAuth + Places + Sheets) ──────────────────────
  /** Google OAuth 2.0 client ID. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth 2.0 client secret. */
  GOOGLE_CLIENT_SECRET: string;
  /** Google Places (new) API key for business search. */
  GOOGLE_PLACES_API_KEY: string;
  /** Google Sheets API key for spreadsheet data sources. Falls back to GOOGLE_PLACES_API_KEY. */
  GOOGLE_SHEETS_API_KEY?: string;

  // ── Domain Registration (CF Registrar via global-key auth + RDAP) ──
  // Availability: RDAP (free, IETF-standard, no key — see services/rdap_availability.ts).
  // Pricing:      CF Registrar public TLD endpoint (no auth — see services/cf_registrar.ts).
  // Register:     POST /accounts/:account_id/registrar/domains/:domain authed by the
  //               existing CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL above. No
  //               separate registrar-scoped token needed.
  /** OpenSRS reseller username for domain registration. */
  OPENSRS_USERNAME?: string;
  /** OpenSRS private API key for domain registration. */
  OPENSRS_API_KEY?: string;
  /** OpenSRS API environment: 'live' or 'test'. Defaults to 'test'. */
  OPENSRS_ENV?: string;

  // ── Sale Webhook ──────────────────────────────────────────
  /** External webhook URL called on successful subscription purchase. */
  SALE_WEBHOOK_URL?: string;
  /** HMAC secret for signing sale webhook payloads. */
  SALE_WEBHOOK_SECRET?: string;

  // ── Billing / Metering ──────────────────────────────────────
  /**
   * Billing provider identifier.
   * `noop` only (the default) — billing runs on Stripe; the former metering
   * provider was removed. `stripe_meters`, `openmeter`, and `metronome` are
   * NOT valid values either.
   */
  BILLING_PROVIDER?: string;
  /** Legacy metering provider identifier — superseded by BILLING_PROVIDER. */
  METERING_PROVIDER?: string;
  /** Stripe Price IDs for base subscriptions. */
  STRIPE_PRICE_BASE_SITE_MONTHLY?: string;
  STRIPE_PRICE_BASE_SITE_YEARLY?: string;

  // Billing runs on Stripe; BILLING_PROVIDER is noop-only (metering provider removed).
  /** HMAC secret used to sign one-click weekly-digest unsubscribe tokens. */
  WEEKLY_DIGEST_SECRET?: string;

  // ── Feature Flags ──────────────────────────────────────────
  /** When "true", research.json is publicly accessible at /api/sites/by-slug/:slug/research.json */
  RESEARCH_JSON_PUBLIC?: string;

  // ── AI Platform (added by migration 0013) ─────────────────
  /** AES-GCM key (base64, 32 bytes) used to encrypt MCP OAuth tokens at rest. */
  MCP_ENCRYPTION_KEY?: string;
  /**
   * PREVIOUS AES-GCM key (base64, 32 bytes) — set ONLY during a key rotation.
   * `decrypt` tries the primary `MCP_ENCRYPTION_KEY` first and falls back to this
   * old key when the primary fails, so rotation is zero-downtime: deploy with the
   * new key as primary + the old key here, lazily re-encrypt rows on next write,
   * then drop this secret. See `docs/security/secret-at-rest-audit.md`.
   */
  MCP_ENCRYPTION_KEY_OLD?: string;
  /**
   * HMAC secret for signing per-site capability manifests
   * (services/site_capability_manifest.ts). Falls back to MCP_ENCRYPTION_KEY
   * when unset so signing works without a separate secret in dev.
   */
  MANIFEST_SIGNING_SECRET?: string;
  /** HS256 secret for super-admin impersonation tokens (§super_admin /impersonate).
   * Self-generable (openssl rand -base64 32). Unset → impersonation records the
   * session but issues no token (fail-soft). wrangler secret. */
  IMPERSONATION_JWT_SECRET?: string;
  /** MailChimp OAuth app client ID + secret (single tenant; per-site tokens). */
  MAILCHIMP_CLIENT_ID?: string;
  MAILCHIMP_CLIENT_SECRET?: string;
  /** Canonical OAuth-prefix aliases for Mailchimp (new naming convention). Legacy bare keys above kept as fallbacks. */
  MAILCHIMP_OAUTH_CLIENT_ID?: string;
  MAILCHIMP_OAUTH_CLIENT_SECRET?: string;
  /** HubSpot OAuth app credentials. Legacy keys; new code reads `HUBSPOT_OAUTH_CLIENT_ID` first. */
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  HUBSPOT_OAUTH_CLIENT_ID?: string;
  HUBSPOT_OAUTH_CLIENT_SECRET?: string;
  HUBSPOT_APP_ID?: string;
  HUBSPOT_PORTAL_ID?: string;
  /** Stripe Connect client ID (separate from STRIPE_SECRET_KEY which is our own account). */
  STRIPE_CONNECT_CLIENT_ID?: string;
  STRIPE_CONNECT_CLIENT_ID_TEST?: string;
  STRIPE_OAUTH_CLIENT_ID?: string;
  STRIPE_ACCOUNT_ID?: string;
  /** Calendly OAuth app credentials (auth.calendly.com). */
  CALENDLY_OAUTH_CLIENT_ID?: string;
  CALENDLY_OAUTH_CLIENT_SECRET?: string;
  CALENDLY_WEBHOOK_SIGNING_KEY?: string;
  /** Airtable OAuth integration credentials (airtable.com/oauth2/v1). */
  AIRTABLE_OAUTH_CLIENT_ID?: string;
  AIRTABLE_OAUTH_CLIENT_SECRET?: string;
  AIRTABLE_INTEGRATION_ID?: string;
  /** PagerDuty OAuth 2.0 app credentials (identity.pagerduty.com). */
  PAGERDUTY_OAUTH_CLIENT_ID?: string;
  PAGERDUTY_OAUTH_CLIENT_SECRET?: string;
  PAGERDUTY_ACCOUNT_SUBDOMAIN?: string;
  /** Vercel Marketplace Integration OAuth credentials (oac_… client id + secret). */
  VERCEL_OAUTH_CLIENT_ID?: string;
  VERCEL_OAUTH_CLIENT_SECRET?: string;
  /** Stripe Price IDs for AI credit topups (one-time purchases). */
  STRIPE_PRICE_CREDITS_100?: string;
  STRIPE_PRICE_CREDITS_500?: string;
  STRIPE_PRICE_CREDITS_2000?: string;
  /**
   * Stripe Price ID for the $50/mo wallet subscription used by
   * `services/wallet.ts`. Create at https://dashboard.stripe.com/products
   * (Product: "Project Sites Wallet", recurring monthly $50.00 USD).
   */
  STRIPE_PRICE_ID_MONTHLY_WALLET?: string;

  // ── Workers for Platforms (user-defined endpoints) ────────
  /** Dispatch namespace binding (set in wrangler.toml [[dispatch_namespaces]]). */
  USER_DISPATCH?: DispatchNamespace;
  /** WFP namespace name used for management API calls (uploads, deletes). */
  WFP_NAMESPACE_NAME?: string;
  /** Cloudflare account ID for WFP REST API. */
  CF_ACCOUNT_ID?: string;
  /** Note: CF_API_TOKEN is already declared above for the existing Cloudflare API surface; we reuse it for WFP REST calls. */

  // ── Real-time collaborative editing (feature: collab_editing) ────────
  /**
   * `CollabRoomDO` Durable Object namespace (PartyServer + Yjs). Optional —
   * shipped INERT: the `[[durable_objects.bindings]]` + `[[migrations]]`
   * COLLAB_ROOM block in wrangler.toml is commented (a new DO class is a
   * watched one-way-door deploy). `/api/sites/:id/collab` returns 503 when
   * this binding is absent. See routes/collab.ts + durable_objects/collab_room.ts.
   */
  COLLAB_ROOM?: DurableObjectNamespace;

  /**
   * AI Gateway routing kill-switch. Gateway is the DEFAULT path whenever
   * `CF_ACCOUNT_ID` is set; set this to the string `"false"` to bypass the
   * gateway and call vendors directly (incident response). Any other value
   * (or unset) keeps the gateway active. See {@link services/ai_gateway.isGatewayActive}.
   * On gateway 5xx, the client falls back to the direct vendor URL once per request.
   */
  AI_GATEWAY_ENABLED?: string;
  /**
   * AI Gateway name segment for the routing URL
   * (`https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AI_GATEWAY_NAME}/{provider}`).
   * Defaults to `"projectsites"` when unset. Provision the gateway at
   * https://dash.cloudflare.com/?to=/:account/ai/ai-gateway.
   */
  AI_GATEWAY_NAME?: string;

  /** Workers Analytics Engine binding — admin dashboard visit tracker. */
  ANALYTICS?: AnalyticsEngineDataset;

  // ── Apps tab (CFC app store) ──────────────────────────────
  /** Neon REST API key for per-app Postgres project provisioning. */
  NEON_API_KEY?: string;
  /** Upstash account email — paired with `UPSTASH_API_KEY` for Redis provisioning. */
  UPSTASH_EMAIL?: string;
  /** Upstash REST API key for per-app Redis database provisioning. */
  UPSTASH_API_KEY?: string;
  /**
   * AppRuntime container Durable Object. Stubbed in the dispatcher until
   * the sibling agent ships the DO class — the route layer degrades to
   * a `503` until the binding is wired in `wrangler.toml`.
   */
  APP_RUNTIME?: DurableObjectNamespace;

  // ── Per-image AppRuntime subclasses (top-10 catalog apps) ──────────
  // Each binds a dedicated `[[containers]]` block in wrangler.toml to the
  // upstream image of that catalog entry. All optional initially so local
  // dev + preview deploys don't break before the migration tag is applied.
  // See `src/durable_objects/app_runtime_subclasses.ts` for the slug map.
  /** AnythingLLM — `mintplexlabs/anythingllm:latest` */
  APP_RUNTIME_ANYTHING_LLM?: DurableObjectNamespace;
  /** Appsmith — `appsmith/appsmith-ce:latest` */
  APP_RUNTIME_APPSMITH?: DurableObjectNamespace;
  /** Audiobookshelf — `ghcr.io/advplyr/audiobookshelf:latest` */
  APP_RUNTIME_AUDIOBOOKSHELF?: DurableObjectNamespace;
  /** BookStack — `lscr.io/linuxserver/bookstack:latest` */
  APP_RUNTIME_BOOKSTACK?: DurableObjectNamespace;
  /** Cal.com — `calcom/cal.com:latest` */
  APP_RUNTIME_CAL?: DurableObjectNamespace;
  /** Chroma — `chromadb/chroma:latest` */
  APP_RUNTIME_CHROMADB?: DurableObjectNamespace;
  /** Code Server — `codercom/code-server:latest` */
  APP_RUNTIME_CODE_SERVER?: DurableObjectNamespace;
  /** Coqui TTS — `ghcr.io/coqui-ai/tts-cpu:latest` */
  APP_RUNTIME_COQUI_TTS?: DurableObjectNamespace;
  /** Directus — `directus/directus:latest` */
  APP_RUNTIME_DIRECTUS?: DurableObjectNamespace;
  /** Drone CI — `drone/drone:2` */
  APP_RUNTIME_DRONE?: DurableObjectNamespace;
  /** Flowise — `flowiseai/flowise:latest` */
  APP_RUNTIME_FLOWISE?: DurableObjectNamespace;
  /** Focalboard — `mattermost/focalboard:latest` */
  APP_RUNTIME_FOCALBOARD?: DurableObjectNamespace;
  /** Forgejo — `codeberg.org/forgejo/forgejo:latest` */
  APP_RUNTIME_FORGEJO?: DurableObjectNamespace;
  /** FreshRSS — `freshrss/freshrss:latest` */
  APP_RUNTIME_FRESHRSS?: DurableObjectNamespace;
  /** Ghost — `ghost:5-alpine` */
  APP_RUNTIME_GHOST?: DurableObjectNamespace;
  /** Gitea — `gitea/gitea:latest` */
  APP_RUNTIME_GITEA?: DurableObjectNamespace;
  /** Grafana — `grafana/grafana-oss:latest` */
  APP_RUNTIME_GRAFANA?: DurableObjectNamespace;
  /** Healthchecks — `healthchecks/healthchecks:latest` */
  APP_RUNTIME_HEALTHCHECKS?: DurableObjectNamespace;
  /** Immich — `ghcr.io/imagegenius/immich:latest` */
  APP_RUNTIME_IMMICH?: DurableObjectNamespace;
  /** Jellyfin — `jellyfin/jellyfin:latest` */
  APP_RUNTIME_JELLYFIN?: DurableObjectNamespace;
  /** Khoj — `ghcr.io/khoj-ai/khoj:latest` */
  APP_RUNTIME_KHOJ?: DurableObjectNamespace;
  /** Langflow — `langflowai/langflow:latest` */
  APP_RUNTIME_LANGFLOW?: DurableObjectNamespace;
  /** Langfuse — `langfuse/langfuse:2` */
  APP_RUNTIME_LANGFUSE?: DurableObjectNamespace;
  /** LibreChat — `ghcr.io/danny-avila/librechat:latest` */
  APP_RUNTIME_LIBRECHAT?: DurableObjectNamespace;
  /** Linkwarden — `ghcr.io/linkwarden/linkwarden:latest` */
  APP_RUNTIME_LINKWARDEN?: DurableObjectNamespace;
  /** Listmonk — `listmonk/listmonk:latest` */
  APP_RUNTIME_LISTMONK?: DurableObjectNamespace;
  /** LiteLLM — `ghcr.io/berriai/litellm-database:main-stable` */
  APP_RUNTIME_LITELLM?: DurableObjectNamespace;
  /** Lobe Chat — `lobehub/lobe-chat-database:latest` */
  APP_RUNTIME_LOBE_CHAT?: DurableObjectNamespace;
  /** Mattermost — `mattermost/mattermost-team-edition:latest` */
  APP_RUNTIME_MATTERMOST?: DurableObjectNamespace;
  /** Memos — `neosmemo/memos:stable` */
  APP_RUNTIME_MEMOS?: DurableObjectNamespace;
  /** Miniflux — `miniflux/miniflux:latest` */
  APP_RUNTIME_MINIFLUX?: DurableObjectNamespace;
  /** Morphic — `ghcr.io/miurla/morphic:latest` */
  APP_RUNTIME_MORPHIC?: DurableObjectNamespace;
  /** n8n — `n8nio/n8n:latest` */
  APP_RUNTIME_N8N?: DurableObjectNamespace;
  /** Navidrome — `deluan/navidrome:latest` */
  APP_RUNTIME_NAVIDROME?: DurableObjectNamespace;
  /** Nextcloud — `nextcloud:latest` */
  APP_RUNTIME_NEXTCLOUD?: DurableObjectNamespace;
  /** NocoDB — `nocodb/nocodb:latest` */
  APP_RUNTIME_NOCODB?: DurableObjectNamespace;
  /** Open WebUI — `ghcr.io/open-webui/open-webui:main` */
  APP_RUNTIME_OPEN_WEBUI?: DurableObjectNamespace;
  /** Outline — `outlinewiki/outline:latest` */
  APP_RUNTIME_OUTLINE?: DurableObjectNamespace;
  /** Perplexica — `itzcrazykns1337/perplexica:latest` */
  APP_RUNTIME_PERPLEXICA?: DurableObjectNamespace;
  /** Arize Phoenix — `arizephoenix/phoenix:latest` */
  APP_RUNTIME_PHOENIX?: DurableObjectNamespace;
  /** Plausible — `plausible/community-edition:latest` */
  APP_RUNTIME_PLAUSIBLE?: DurableObjectNamespace;
  /** PocketBase — `spectado/pocketbase:latest` */
  APP_RUNTIME_POCKETBASE?: DurableObjectNamespace;
  /** Qdrant — `qdrant/qdrant:latest` */
  APP_RUNTIME_QDRANT?: DurableObjectNamespace;
  /** SearXNG — `searxng/searxng:latest` */
  APP_RUNTIME_SEARXNG?: DurableObjectNamespace;
  /** Stirling PDF — `docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest` */
  APP_RUNTIME_STIRLING_PDF?: DurableObjectNamespace;
  /** Tabby — `tabbyml/tabby:latest` */
  APP_RUNTIME_TABBY?: DurableObjectNamespace;
  /** Teable — `teableio/teable:latest` */
  APP_RUNTIME_TEABLE?: DurableObjectNamespace;
  /** Umami — `ghcr.io/umami-software/umami:postgresql-latest` */
  APP_RUNTIME_UMAMI?: DurableObjectNamespace;
  /** Uptime Kuma — `louislam/uptime-kuma:1` */
  APP_RUNTIME_UPTIME_KUMA?: DurableObjectNamespace;
  /** Vaultwarden — `vaultwarden/server:latest` */
  APP_RUNTIME_VAULTWARDEN?: DurableObjectNamespace;
  /** Vikunja — `vikunja/vikunja:latest` */
  APP_RUNTIME_VIKUNJA?: DurableObjectNamespace;
  /** Weaviate — `semitechnologies/weaviate:1.28.0` */
  APP_RUNTIME_WEAVIATE?: DurableObjectNamespace;
  /** Whisper ASR — `onerahmet/openai-whisper-asr-webservice:latest` */
  APP_RUNTIME_WHISPER_ASR?: DurableObjectNamespace;
  /** Wiki.js — `ghcr.io/requarks/wiki:2` */
  APP_RUNTIME_WIKIJS?: DurableObjectNamespace;

  // ── Twilio (Voice + SMS Agent) ─────────────────────────────
  /** Twilio Account SID (AC…). Required for every Voice/SMS call. */
  TWILIO_ACCOUNT_SID?: string;
  /** Dub API key (self-hosted instance at app.claimyour.site) for link shortening. Optional → fail-soft. */
  DUB_API_KEY?: string;
  /** Dub API base override. Default https://app.claimyour.site/api. */
  DUB_API_BASE?: string;
  /** Short-link domain registered in Dub. Default linkbl.ink. */
  LINKBL_DOMAIN?: string;
  /** Twilio Auth Token — signs every outbound REST call AND verifies inbound webhooks. */
  TWILIO_AUTH_TOKEN?: string;
  /** Twilio API Key SID (SK…) — for short-lived Access Tokens (Client/Voice). */
  TWILIO_API_KEY?: string;
  /** Twilio API Key Secret — paired with `TWILIO_API_KEY` for JWT signing. */
  TWILIO_API_SECRET?: string;
  /** TwiML App SID (AP…) — required by Voice Access Tokens for outgoing calls. */
  TWILIO_TWIML_APP_SID?: string;
  /** Deepgram API key for low-latency real-time STT (falls back to Workers AI Whisper). */
  DEEPGRAM_API_KEY?: string;
  // NOTE: ELEVENLABS_API_KEY is already declared above for image/voiceover generation —
  // the Voice Agent reuses the same secret for ElevenLabs TTS.
  /** LiveKit Cloud project URL (wss://…livekit.cloud) — agent container connects here. */
  LIVEKIT_URL?: string;
  /** LiveKit API key (iss of the webhook JWT) — also authorizes SIP dispatch + agent. */
  LIVEKIT_API_KEY?: string;
  /** LiveKit API secret — HS256 key that signs/verifies the /webhooks/livekit JWT. */
  LIVEKIT_API_SECRET?: string;
  /** LiveKit SIP ingress URI (sip:<project>.sip.livekit.cloud) — Twilio SIP trunk target. */
  LIVEKIT_SIP_URI?: string;
  /** Platform LiteLLM facade base URL (OpenAI-compatible) — voice-agent LLM fallback. */
  LITELLM_BASE_URL?: string;
  /** Platform LiteLLM master/virtual key — voice-agent LLM fallback when no per-site key. */
  LITELLM_API_KEY?: string;

  /**
   * Per-call Browse Agent Container Durable Object. Built by a sibling agent.
   * Optional until the DO class + container image are wired in `wrangler.toml`.
   * The in-call browse trigger moved to the LiveKit agent (`infra/voice-agent`);
   * when absent the voice agent degrades to plain LLM-only replies.
   */
  VOICE_BROWSE_AGENT?: DurableObjectNamespace;

  /**
   * Cloudflare native rate-limit binding for the two public OAuth mint endpoints
   * (POST /oauth/register + POST /oauth/token). Atomic, per-colo, free tier.
   * Declared optional so local/test envs without the binding compile + run.
   * Configured: 15 requests / 10 s / colo in wrangler.toml [[unsafe.bindings]].
   */
  OAUTH_RATELIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** Cloudflare Workers for Platforms dispatch namespace runtime shape. */
interface DispatchNamespace {
  get(
    name: string,
    args?: Record<string, unknown>,
  ): { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
}

/** Cloudflare Workers Analytics Engine binding runtime shape. */
interface AnalyticsEngineDataset {
  writeDataPoint(data: { blobs?: (string | null)[]; doubles?: number[]; indexes?: string[] }): void;
}

/**
 * Hono context variables set by middleware and consumed by route handlers.
 *
 * These are request-scoped values attached via `c.set()` / `c.get()`.
 *
 * @example
 * ```ts
 * // In middleware:
 * c.set('requestId', crypto.randomUUID());
 *
 * // In route handler:
 * const rid = c.get('requestId');
 * ```
 */
export interface Variables {
  /** Unique request ID for distributed tracing (`X-Request-ID` header). */
  requestId: string;
  /** Authenticated user ID (set after session validation). */
  userId?: string;
  /** Organization ID the user belongs to. */
  orgId?: string;
  /** User's role within the org (`owner` | `admin` | `member` | `viewer`). */
  userRole?: string;
  /** Whether the user is a billing admin for their org. */
  billingAdmin?: boolean;
  /** ID of the org-scoped API key (psk_…) that authenticated the request, if any. */
  apiKeyId?: string;
}
