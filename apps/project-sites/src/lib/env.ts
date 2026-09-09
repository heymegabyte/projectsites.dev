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
// Env schema
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for the Cloudflare Worker `Env` bindings.
 *
 * We only validate **string secrets** here — Cloudflare platform bindings
 * (D1Database, KVNamespace, R2Bucket, etc.) are validated by the Workers
 * runtime itself and cannot be parsed as primitive strings.
 *
 * Required keys (non-optional in env.ts + immediately fatal if absent):
 *  - POSTHOG_API_KEY
 *  - STRIPE_SECRET_KEY
 *  - STRIPE_PUBLISHABLE_KEY
 *  - STRIPE_WEBHOOK_SECRET
 *  - CF_API_TOKEN
 *  - CF_ZONE_ID
 *  - GOOGLE_CLIENT_ID
 *  - GOOGLE_CLIENT_SECRET
 *  - GOOGLE_PLACES_API_KEY
 *  - ENVIRONMENT
 */
export const EnvSchema = z.object({
  // ── Required secrets ────────────────────────────────────────────────────────
  /** PostHog API key for server-side event capture. */
  POSTHOG_API_KEY: z.string().min(1, 'POSTHOG_API_KEY is required'),
  /** Stripe secret key for server-side API calls. */
  STRIPE_SECRET_KEY: z.string().min(1, 'STRIPE_SECRET_KEY is required'),
  /** Stripe publishable key (passed to frontend checkout). */
  STRIPE_PUBLISHABLE_KEY: z.string().min(1, 'STRIPE_PUBLISHABLE_KEY is required'),
  /** Stripe webhook endpoint signing secret. */
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'STRIPE_WEBHOOK_SECRET is required'),
  /** Cloudflare API token for Custom Hostnames (CF for SaaS). */
  CF_API_TOKEN: z.string().min(1, 'CF_API_TOKEN is required'),
  /** Cloudflare zone ID for `projectsites.dev`. */
  CF_ZONE_ID: z.string().min(1, 'CF_ZONE_ID is required'),
  /** Google OAuth 2.0 client ID. */
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  /** Google OAuth 2.0 client secret. */
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  /** Google Places (new) API key for business search. */
  GOOGLE_PLACES_API_KEY: z.string().min(1, 'GOOGLE_PLACES_API_KEY is required'),
  /** Deployment environment tag. */
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
 * through {@link EnvSchema}.
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
  return EnvSchema.parse(stringKeys);
}
