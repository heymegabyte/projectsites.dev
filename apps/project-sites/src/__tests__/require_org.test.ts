/**
 * requireOrgId — the typed org-id guard that replaced 38 `c.get('orgId')!` non-null assertions
 * across the org-scoped feature handlers + index.ts (CODE-SWEEP Fire 10 + 11). Locks BOTH halves:
 * present → the narrowed string; absent/empty → a fail-closed 401.
 *
 * CRITICAL (Fire 11 prod-verify): the thrown error MUST be the SHARED `@project-sites/shared`
 * `AppError` — the global error_handler maps ONLY `instanceof AppError` (from that barrel) to its
 * HTTP status via `.statusCode` + `.toJSON()`. The FIRST cut threw the PLATFORM `errors.ts`
 * `UnauthorizedError` (a separate class using `.status`), which the handler did NOT recognize →
 * every unauthed hit fell through to a 500 (prod-confirmed on /api/system/status + /api/activity +
 * /api/onboarding). The old test locked the wrong class (`.status` on the platform error) so it
 * stayed green while prod 500'd. These assertions now lock the ACTUAL error_handler contract.
 */
import { requireOrgId } from '../middleware/require_org.js';
import { AppError } from '@project-sites/shared';

// Minimal fake Hono context — requireOrgId only reads c.get('orgId'). `as unknown as` (the
// established safe test-mock cast) keeps this `any`-free, the very class the sweep removes.
const ctx = (orgId?: string) =>
  ({ get: (k: string) => (k === 'orgId' ? orgId : undefined) }) as unknown as Parameters<
    typeof requireOrgId
  >[0];

describe('requireOrgId', () => {
  it('returns the org id when present in the request context', () => {
    expect(requireOrgId(ctx('org-brian-001'))).toBe('org-brian-001');
  });

  it('throws the SHARED AppError the error_handler maps to 401 (statusCode + code + toJSON)', () => {
    expect(() => requireOrgId(ctx(undefined))).toThrow(AppError);
    try {
      requireOrgId(ctx(undefined));
      throw new Error('should have thrown');
    } catch (e) {
      // instanceof the SHARED AppError → the error_handler's `err instanceof AppError` branch fires
      // (the platform errors.ts class would NOT match → 500). This is the assertion that catches the
      // Fire-10/11 regression.
      expect(e).toBeInstanceOf(AppError);
      // The error_handler reads `.statusCode` (NOT `.status`) — assert the property it actually uses.
      expect((e as AppError).statusCode).toBe(401);
      expect((e as AppError).code).toBe('UNAUTHORIZED');
      // The handler calls `.toJSON()` for the JSON envelope — it must produce the 401 shape.
      const body = (e as AppError).toJSON() as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('treats an empty-string org id as absent (falsy → 401, never a blank-scope query)', () => {
    expect(() => requireOrgId(ctx(''))).toThrow(AppError);
  });
});
