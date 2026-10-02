/**
 * PostHog server-side event capture for Cloudflare Workers.
 *
 * Uses the PostHog HTTP API directly (no SDK needed) to track
 * server-side events like auth flows, site creation, and errors.
 *
 * @module lib/posthog
 */

import type { Env } from '../types/env.js';

interface PostHogEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

const POSTHOG_API_URL = 'https://us.i.posthog.com/capture/';

/**
 * Capture a server-side event in PostHog.
 *
 * Fire-and-forget: uses waitUntil to avoid blocking the response.
 * Safe to call even if POSTHOG_API_KEY is not configured.
 */
export function capture(env: Env, ctx: ExecutionContext, event: PostHogEvent): void {
  if (!env.POSTHOG_API_KEY) return;

  const host = env.POSTHOG_HOST ?? POSTHOG_API_URL;
  const url = host.endsWith('/capture/') ? host : `${host}/capture/`;

  const body = JSON.stringify({
    api_key: env.POSTHOG_API_KEY,
    event: event.event,
    distinct_id: event.distinctId,
    properties: {
      ...event.properties,
      $lib: 'project-sites-worker',
      environment: env.ENVIRONMENT,
    },
    timestamp: new Date().toISOString(),
  });

  const promise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'posthog',
        message: 'Failed to capture event',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });

  ctx.waitUntil(promise);
}

/**
 * Track an authentication event.
 */
export function trackAuth(
  env: Env,
  ctx: ExecutionContext,
  method: 'magic_link' | 'google_oauth' | 'github_oauth',
  step: 'requested' | 'verified' | 'failed',
  distinctId: string,
  extra?: Record<string, unknown>,
): void {
  capture(env, ctx, {
    event: `auth_${method}_${step}`,
    distinctId,
    properties: {
      auth_method: method,
      auth_step: step,
      ...extra,
    },
  });
}

/**
 * Track a site lifecycle event.
 *
 * @remarks
 * Emits BOTH the legacy underscore-name (`site_created`, `site_deleted`) AND
 * the dot-named event used by the frontend telemetry facade
 * (`site.create.submitted`, `site.deleted`). Server + client converge on a
 * single dot-name taxonomy without breaking historical dashboards keyed off
 * the underscore names. PostHog dedupe is idempotent — the same
 * `distinct_id` + timestamp + event name pair is recognized as one row.
 */
export function trackSite(
  env: Env,
  ctx: ExecutionContext,
  action: string,
  distinctId: string,
  extra?: Record<string, unknown>,
): void {
  capture(env, ctx, {
    event: `site_${action}`,
    distinctId,
    properties: extra,
  });
  // Dot-named alias for parity with the frontend telemetry convention.
  // Mapping: `created` → `site.create.submitted` (matches GA4 generate_lead
  // conversion alias); everything else stays `site.<action>`.
  const dotted = action === 'created' ? 'site.create.submitted' : `site.${action}`;
  capture(env, ctx, {
    event: dotted,
    distinctId,
    properties: { ...extra, source: 'worker' },
  });
}

/**
 * Track an error event.
 */
export function trackError(
  env: Env,
  ctx: ExecutionContext,
  errorType: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  capture(env, ctx, {
    event: 'server_error',
    distinctId: 'system',
    properties: {
      error_type: errorType,
      error_message: message,
      ...extra,
    },
  });
}

/**
 * Track a domain lifecycle event.
 */
export function trackDomain(
  env: Env,
  ctx: ExecutionContext,
  action: string,
  distinctId: string,
  extra?: Record<string, unknown>,
): void {
  capture(env, ctx, {
    event: `domain_${action}`,
    distinctId,
    properties: extra,
  });
}

/**
 * Track billing/payment events with revenue data.
 */
export function trackBilling(
  env: Env,
  ctx: ExecutionContext,
  action: string,
  distinctId: string,
  extra?: Record<string, unknown>,
): void {
  capture(env, ctx, {
    event: `billing_${action}`,
    distinctId,
    properties: {
      ...extra,
      $groups: { company: (extra?.org_id as string) ?? undefined },
    },
  });
}
