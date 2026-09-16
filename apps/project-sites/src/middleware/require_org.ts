/**
 * @module middleware/require_org
 *
 * `requireOrgId(c)` — read the authenticated org id from the Hono context, or throw a typed
 * 401. The auth middleware sets `orgId` only after a valid session/API-key (it does NOT reject
 * unauthed requests — see `middleware/auth.ts`), so `Variables.orgId` is `string | undefined`.
 * Authed org-scoped handlers were reading it as `c.get('orgId')!` — a non-null assertion that
 * (a) violates TS-strictness ("no non-null `!`") and (b) silently feeds `undefined` into flag
 * checks / SQL when a request somehow arrives unauthenticated (a latent lying-empty / wrong-scope
 * bug). This helper replaces every such `!`: present → the narrowed `string`; absent → a clean
 * `UnauthorizedError` (401 `{code:'UNAUTHORIZED'}` via the platform error envelope), which is the
 * correct response for an org-scoped route reached without auth (hardened, fail-closed).
 *
 * @throws {UnauthorizedError} 401 when no org id is present in the request context.
 *
 * @example
 * // Before: if (!(await isFlagOn(c.env, 'k', { orgId: c.get('orgId')! }))) return c.notFound();
 * // After:  const orgId = requireOrgId(c);
 * //         if (!(await isFlagOn(c.env, 'k', { orgId }))) return c.notFound();
 */
import type { Context } from 'hono';

import type { Env, Variables } from '../types/env.js';

import { UnauthorizedError } from '../platform/errors.js';

export function requireOrgId(c: Context<{ Bindings: Env; Variables: Variables }>): string {
  const orgId = c.get('orgId');
  if (!orgId) {
    throw new UnauthorizedError('Authentication required — no organization in the request context.');
  }
  return orgId;
}
