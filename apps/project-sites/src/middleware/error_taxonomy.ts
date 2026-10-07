/**
 * @module middleware/error_taxonomy
 * @description Error-classification PREDICATES. Pure predicates — no I/O, no
 * logging, no response building (that lives in error_render / error_handler). The
 * handler keeps its original per-branch behavior; a unified classifier was tried
 * (fire-54) and rejected — it flattened branch-specific envelopes (AppError
 * `toJSON()`, Zod `details.issues`, generic-vs-raw internal messages). The branded
 * error page builds its own title/suggestion copy in `lib/error_pages.ts`.
 */

import { ZodError } from 'zod';

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
