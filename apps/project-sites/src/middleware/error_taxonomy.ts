/**
 * @module middleware/error_taxonomy
 * @description Error-classification PREDICATES + the HTTP status → title/suggestion
 * copy tables for the branded error page. Pure data + pure predicates — no I/O, no
 * logging, no response building (that lives in error_render / error_handler). The
 * handler keeps its original per-branch behavior; a unified classifier was tried
 * (fire-54) and rejected — it flattened branch-specific envelopes (AppError
 * `toJSON()`, Zod `details.issues`, generic-vs-raw internal messages).
 */

import { ZodError } from 'zod';

/** Human titles per HTTP status for the branded error page. */
export const HTTP_ERROR_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Not Authorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Too Large',
  429: 'Too Many Requests',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** Next-step suggestions per HTTP status for the branded error page. */
export const HTTP_ERROR_SUGGESTIONS: Record<number, string> = {
  400: 'Check the request format and try again.',
  401: 'Please <a href="https://projectsites.dev/" class="link">sign in</a> to continue.',
  403: "You don't have permission to access this resource.",
  404: 'This page doesn\'t exist. <a href="https://projectsites.dev/create" class="link">Build a site</a> instead?',
  429: "You're sending too many requests. Wait a moment and try again.",
  500: "Something went wrong on our end. We've been notified.",
  502: 'Our upstream service is temporarily unavailable.',
  503: "We're briefly offline for maintenance. Back shortly.",
};

/**
 * A ZodError, including cross-realm instances (a validation error thrown by a
 * different zod module instance still carries an `issues` array).
 */
export function isZodErrorLike(err: unknown): boolean {
  return (
    err instanceof ZodError ||
    (!!err && typeof err === 'object' && 'issues' in err && Array.isArray((err as ZodError).issues))
  );
}

/**
 * Malformed-JSON body from `c.req.json()` — a CLIENT error (400, warn-logged,
 * never Sentry). Gated on a JSON-ish message so an unrelated internal
 * SyntaxError still surfaces as a 500.
 */
export function isMalformedJsonBody(err: unknown): boolean {
  return err instanceof SyntaxError && /JSON/i.test(err.message);
}

/**
 * Account-wide R2-disabled outage (CF error 10042) — operational, not a code
 * fault; degrades to a calm 503 maintenance page per fail-fast-build-fail-soft-prod.
 * See memory feedback_deploy_r2_reliability (2026-06-24 outage).
 */
export function isStorageUnavailable(message: string): boolean {
  return /enable R2|\(10042\)|R2 .*Dashboard/i.test(message);
}
