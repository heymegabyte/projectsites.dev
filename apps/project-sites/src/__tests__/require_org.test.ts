/**
 * requireOrgId — the typed org-id guard that replaced 24 `c.get('orgId')!` non-null assertions
 * across the org-scoped feature handlers (CODE-SWEEP Fire 10). Locks BOTH halves of the contract:
 * present → the narrowed string; absent/empty → a fail-closed typed 401 (UnauthorizedError), the
 * correct response for an org-scoped route reached without auth — never `undefined` silently
 * flowing into a flag check or SQL.
 */
import { requireOrgId } from '../middleware/require_org.js';
import { UnauthorizedError } from '../platform/errors.js';

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

  it('throws a typed 401 UnauthorizedError when no org id is present (fail-closed)', () => {
    expect(() => requireOrgId(ctx(undefined))).toThrow(UnauthorizedError);
    try {
      requireOrgId(ctx(undefined));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedError);
      expect((e as UnauthorizedError).status).toBe(401);
      expect((e as UnauthorizedError).code).toBe('UNAUTHORIZED');
    }
  });

  it('treats an empty-string org id as absent (falsy → 401, never a blank-scope query)', () => {
    expect(() => requireOrgId(ctx(''))).toThrow(UnauthorizedError);
  });
});
