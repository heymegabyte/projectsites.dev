import { meFixture, type MeResponse } from './admin-me.fixture';
import { toRegistryKey } from './index';

/**
 * admin-me.fixture — the mock body for GET /api/auth/me (the 4th read in
 * AdminStateService.loadData; hydrates orgId/orgName/isSuperAdmin for the shell).
 * Contract: matches the worker `{ data: { user_id, org_id, org_name, email,
 * display_name, is_super_admin } }` envelope EXACTLY so the real endpoint is a swap.
 * State variants: populated (a real signed-in operator) · empty (still a valid session —
 * org present, just not a super-admin). The interceptor owns loading + error.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('meFixture (worker-contract-shaped GET /auth/me)', () => {
  it('returns the worker envelope { data: { user_id, org_id, ... } }', () => {
    const res: MeResponse = meFixture('populated', q());
    const d = res.data;
    expect(typeof d.user_id).toBe('string');
    expect(typeof d.org_id).toBe('string');
    expect(typeof d.email).toBe('string');
    // org_name labels org-scoped surfaces; a real signed-in operator has one.
    expect(typeof d.org_name).toBe('string');
    expect(typeof d.is_super_admin).toBe('boolean');
  });

  it('populated → a believable operator identity (email + org name + display name)', () => {
    const d = meFixture('populated', q()).data;
    expect(d.email).toContain('@');
    expect(d.org_name && d.org_name.length).toBeTruthy();
    expect(typeof d.display_name).toBe('string');
    expect(d.org_id.length).toBeGreaterThan(0);
  });

  it('empty → still a VALID session (org present) but NOT a super-admin', () => {
    // /auth/me is never "empty" for an authed shell — the empty knob means a plain,
    // non-super-admin operator so the super-admin-gated UI stays hidden.
    const d = meFixture('empty', q()).data;
    expect(d.org_id.length).toBeGreaterThan(0);
    expect(d.is_super_admin).toBe(false);
  });

  it('normalizes to the registry key GET /auth/me', () => {
    expect(toRegistryKey('GET', '/api/auth/me').key).toBe('GET /auth/me');
  });
});
