/**
 * @module lib/env
 * @description Zod-based runtime validation for the Worker `Env` bindings.
 *
 * Cloudflare Workers inject `env` at the start of every request, but there is
 * no built-in way to guarantee required secrets are present at runtime. This
 * module bridges that gap: call `parseEnv(env)` in the worker fetch handler
 * **before** any route logic runs so a missing required secret surfaces as an
 * immediate, human-readable startup error instead of a cryptic runtime crash
 * deep inside a route.
 *
 * ## Usage
 *
 * ```ts
 * // src/index.ts
 * import { parseEnv } from './lib/env.js';
 *
 * app.use('*', async (c, next) => {
 *   parseEnv(c.env);   // throws ZodError → caught by errorHandler → 500
 *   await next();
 * });
 * ```
 *
 * ## Optional vs Required
 *
 * A binding is **required** when:
 * - It is declared without `?` in `types/env.ts`, AND
 * - Its absence would cause an unrecoverable failure on any request.
 *
 * Everything else is optional — `z.string().optional()`.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────────────
// Local-dev detection
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Env tags that mean "this is a developer's machine / `wrangler dev`", where the
 * third-party integration secrets (Stripe / Places / PostHog / CF-for-SaaS) are
 * legitimately absent because those code paths aren't exercised locally.
 */
const LOCAL_ENV_TAGS = new Set(['development', 'dev', 'local', 'test']);

/**
 * True when the Worker is running in a local/dev context.
 *
 * @remarks
 * Detected from `ENVIRONMENT` (set to `development` by `wrangler dev` /
 * `.dev.vars`). Production sets `ENVIRONMENT=production`, so this is `false`
 * there and the full required-secret set stays fail-fast (per
 * `fail-fast-build-fail-soft-prod`: strict at build/boot in prod, tolerant of a
 * bare local box so the app comes up connected for E2E).
 */
export function isLocalDevEnv(env: Record<string, unknown>): boolean {
  const tag = typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT.toLowerCase() : '';
  return LOCAL_ENV_TAGS.has(tag);
}

// ──────────────────────────────────────────────────────────────────────────────
// Env schema
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the Zod schema for the Cloudflare Worker `Env` bindings.
 *
 * We only validate **string secrets** here — Cloudflare platform bindings
 * (D1Database, KVNamespace, R2Bucket, etc.) are validated by the Workers
 * runtime itself and cannot be parsed as primitive strings.
 *
 * The nine third-party integration secrets below are **required in production**
 * (their absence is immediately fatal to real user flows) but **optional in
 * local dev** — a `wrangler dev` box seeds `ENVIRONMENT=development` and never
 * calls Stripe / Places / CF-for-SaaS on the auth-and-editor paths an E2E
 * journey drives, so hard-failing every request on a missing prod secret would
 * make the whole local stack un-bootable (a real gap the Long-Trail LIVE slice
 * caught). `ENVIRONMENT` itself is always required.
 *
 * Production-required keys (optional only when {@link isLocalDevEnv} is true):
 *  - POSTHOG_API_KEY
 *  - STRIPE_SECRET_KEY
 *  - STRIPE_PUBLISHABLE_KEY
 *  - STRIPE_WEBHOOK_SECRET
 *  - CF_API_TOKEN
 *  - CF_ZONE_ID
 *  - GOOGLE_CLIENT_ID
 *  - GOOGLE_CLIENT_SECRET
 *  - GOOGLE_PLACES_API_KEY
 *
 * @param local - When `true`, the nine integration secrets degrade to optional.
 */
export function buildEnvSchema(local: boolean) {
  /** Required in prod, optional on a local/dev box. */
  const prodRequired = (label: string) =>
    local ? z.string().optional() : z.string().min(1, `${label} is required`);

  return z.object({
    // ── Required in production (optional in local dev) ─────────────────────────
    /** PostHog API key for server-side event capture. */
    POSTHOG_API_KEY: prodRequired('POSTHOG_API_KEY'),
    /** Stripe secret key for server-side API calls. */
    STRIPE_SECRET_KEY: prodRequired('STRIPE_SECRET_KEY'),
    /** Stripe publishable key (passed to frontend checkout). */
    STRIPE_PUBLISHABLE_KEY: prodRequired('STRIPE_PUBLISHABLE_KEY'),
    /** Stripe webhook endpoint signing secret. */
    STRIPE_WEBHOOK_SECRET: prodRequired('STRIPE_WEBHOOK_SECRET'),
    /** Cloudflare API token for Custom Hostnames (CF for SaaS). */
    CF_API_TOKEN: prodRequired('CF_API_TOKEN'),
    /** Cloudflare zone ID for `projectsites.dev`. */
    CF_ZONE_ID: prodRequired('CF_ZONE_ID'),
    /** Google OAuth 2.0 client ID. */
    GOOGLE_CLIENT_ID: prodRequired('GOOGLE_CLIENT_ID'),
    /** Google OAuth 2.0 client secret. */
    GOOGLE_CLIENT_SECRET: prodRequired('GOOGLE_CLIENT_SECRET'),
    /** Google Places (new) API key for business search. */
    GOOGLE_PLACES_API_KEY: prodRequired('GOOGLE_PLACES_API_KEY'),
    /** Deployment environment tag — always required. */
    ENVIRONMENT: z.string().min(1, 'ENVIRONMENT is required'),

    // ── Optional secrets (degrade gracefully when absent) ────────────────────────
  POSTHOG_PUBLIC_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  GA4_MEASUREMENT_ID: z.string().optional(),
  GTM_CONTAINER_ID: z.string().optional(),
  GA4_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GA4_PROPERTY_ID: z.string().optional(),
  WHOISXML_API_KEY: z.string().optional(),
  GODADDY_API_KEY: z.string().optional(),
  GODADDY_API_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  RESEARCH_MODEL: z.string().optional(),
  OPEN_ROUTER_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  AB_MODEL_SPLIT: z.string().optional(),
  TEMPLATE_CACHE_TTL: z.string().optional(),
  GOOGLE_CSE_KEY: z.string().optional(),
  GOOGLE_CSE_CX: z.string().optional(),
  MAX_GENERATED_IMAGES: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  PEXELS_API_KEY: z.string().optional(),
  PIXABAY_API_KEY: z.string().optional(),
  UNSPLASH_ACCESS_KEY: z.string().optional(),
  IDEOGRAM_API_KEY: z.string().optional(),
  REPLICATE_API_TOKEN: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  FOURSQUARE_API_KEY: z.string().optional(),
  YELP_API_KEY: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  MAPBOX_ACCESS_TOKEN: z.string().optional(),
  LOGODEV_TOKEN: z.string().optional(),
  BRANDFETCH_API_KEY: z.string().optional(),
  TRIPADVISOR_API_KEY: z.string().optional(),
  TRUSTPILOT_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  STABILITY_API_KEY: z.string().optional(),
  REMOVEBG_API_KEY: z.string().optional(),
  LOTTIEFILES_API_KEY: z.string().optional(),
  PAGESPEED_API_KEY: z.string().optional(),
  GTMETRIX_API_KEY: z.string().optional(),
  HUNTER_API_KEY: z.string().optional(),
  WHAT3WORDS_API_KEY: z.string().optional(),
  ABSTRACT_GEO_API_KEY: z.string().optional(),
  CLARITY_PROJECT_ID: z.string().optional(),
  PLAUSIBLE_DOMAIN: z.string().optional(),
  CLOUDFLARE_API_KEY: z.string().optional(),
  CLOUDFLARE_EMAIL: z.string().email().optional(),
  CF_ACCESS_CLIENT_ID: z.string().optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().optional(),
  INTERNAL_BUILD_SECRET: z.string().optional(),
  INTERNAL_CALLBACK_URL: z.string().url().optional(),
  // RESEND_API_KEY removed 2026-09-09 (Brian directive) — Amazon SES is the canonical email provider.
  SENDGRID_API_KEY: z.string().optional(),
  CHATWOOT_API_URL: z.string().optional(),
  CHATWOOT_API_KEY: z.string().optional(),
  PSNOTIFY_SIGNING_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_SHEETS_API_KEY: z.string().optional(),
  OPENSRS_USERNAME: z.string().optional(),
  OPENSRS_API_KEY: z.string().optional(),
  OPENSRS_ENV: z.enum(['live', 'test']).optional(),
  SALE_WEBHOOK_URL: z.string().url().optional(),
  SALE_WEBHOOK_SECRET: z.string().optional(),
  METERING_PROVIDER: z.string().optional(),
  WEEKLY_DIGEST_SECRET: z.string().optional(),
  RESEARCH_JSON_PUBLIC: z.string().optional(),
  MCP_ENCRYPTION_KEY: z.string().optional(),
  MAILCHIMP_CLIENT_ID: z.string().optional(),
  MAILCHIMP_CLIENT_SECRET: z.string().optional(),
  MAILCHIMP_OAUTH_CLIENT_ID: z.string().optional(),
  MAILCHIMP_OAUTH_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_OAUTH_CLIENT_ID: z.string().optional(),
  HUBSPOT_OAUTH_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_APP_ID: z.string().optional(),
  HUBSPOT_PORTAL_ID: z.string().optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  STRIPE_CONNECT_CLIENT_ID_TEST: z.string().optional(),
  STRIPE_OAUTH_CLIENT_ID: z.string().optional(),
  STRIPE_ACCOUNT_ID: z.string().optional(),
  CALENDLY_OAUTH_CLIENT_ID: z.string().optional(),
  CALENDLY_OAUTH_CLIENT_SECRET: z.string().optional(),
  CALENDLY_WEBHOOK_SIGNING_KEY: z.string().optional(),
  AIRTABLE_OAUTH_CLIENT_ID: z.string().optional(),
  AIRTABLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  AIRTABLE_INTEGRATION_ID: z.string().optional(),
  PAGERDUTY_OAUTH_CLIENT_ID: z.string().optional(),
  PAGERDUTY_OAUTH_CLIENT_SECRET: z.string().optional(),
  PAGERDUTY_ACCOUNT_SUBDOMAIN: z.string().optional(),
  STRIPE_PRICE_CREDITS_100: z.string().optional(),
  STRIPE_PRICE_CREDITS_500: z.string().optional(),
  STRIPE_PRICE_CREDITS_2000: z.string().optional(),
  STRIPE_PRICE_ID_MONTHLY_WALLET: z.string().optional(),
  WFP_NAMESPACE_NAME: z.string().optional(),
  CF_ACCOUNT_ID: z.string().optional(),
  AI_GATEWAY_ENABLED: z.string().optional(),
  NEON_API_KEY: z.string().optional(),
  UPSTASH_EMAIL: z.string().email().optional(),
  UPSTASH_API_KEY: z.string().optional(),
  TWITTER_CLIENT_ID: z.string().optional(),
  TWITTER_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  THREADS_APP_ID: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY: z.string().optional(),
  TWILIO_API_SECRET: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  // LiveKit Cloud — voice receptionist transport (ADR voice-architecture.md amendment).
  // API_KEY/API_SECRET verify the signed /webhooks/livekit events; URL/SIP_URI feed the
  // agent container + SIP dispatch. Feature stays dark (route 404s) until KEY+SECRET set.
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_SIP_URI: z.string().optional(),
  // Platform LiteLLM facade (OpenAI-compatible) — fallback LLM endpoint for the
  // voice agent when a site has no per-site LiteLLM config in ai_env_vars.
    LITELLM_BASE_URL: z.string().optional(),
    LITELLM_API_KEY: z.string().optional(),
  });
}

/**
 * Canonical (production-strict) env schema. Kept as the SSOT for the
 * {@link ParsedEnv} type; runtime parsing goes through {@link parseEnv}, which
 * selects the local-relaxed variant on a dev box.
 */
export const EnvSchema = buildEnvSchema(false);

/** Type of the validated (string-only) env keys. */
export type ParsedEnv = z.infer<typeof EnvSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// parseEnv
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validate the string-typed keys in the Worker `Env` object.
 *
 * Extracts only the string-primitive fields from `env` (ignoring platform
 * bindings like `D1Database`, `KVNamespace`, `R2Bucket`, etc.) and runs them
 * through the env schema — {@link buildEnvSchema}`(true)` on a local/dev box
 * (the nine integration secrets become optional), the production-strict
 * {@link EnvSchema} otherwise.
 *
 * @throws {ZodError} If any required key is missing or fails validation.
 *   The error bubbles up to the global `errorHandler` which formats it as a
 *   `VALIDATION_ERROR` 400 JSON envelope with `issues[]` detail.
 *
 * @example
 * ```ts
 * // Call once per request BEFORE any route logic:
 * parseEnv(c.env);
 * ```
 */
export function parseEnv(env: Record<string, unknown>): ParsedEnv {
  // Pull only string-typed keys — platform bindings (objects) are skipped.
  const stringKeys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' || value === undefined) {
      stringKeys[key] = value;
    }
  }
  const schema = isLocalDevEnv(stringKeys) ? buildEnvSchema(true) : EnvSchema;
  return schema.parse(stringKeys) as ParsedEnv;
}
