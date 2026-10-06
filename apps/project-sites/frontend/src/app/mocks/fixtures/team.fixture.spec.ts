import { orgFullOrganizationFixture } from './team.fixture';
import type { FullOrganization } from '../../pages/auth/org-api.service';
import { toRegistryKey, findFixture, registerFixtures } from './index';

/**
 * team.fixture — the mock body for the standalone admin Team section
 * (`pages/admin/sections/team.component.ts`), which reads
 * `GET /api/auth/organization/get-full-organization` via `OrgApiService`. The factory
 * is typed to the EXACT worker wire shape traced to `src/routes/auth_org.ts` (the live
 * custom-D1 handler), so wiring the real endpoint later is a provider SWAP.
 *
 * This spec tests the factory DIRECTLY — the DIRECT (un-wrapped) `FullOrganization`
 * envelope, wire-faithful member/invite field names (camelCase, embedded `user` +
 * flat fallbacks), the authoritative seat accounting, and each state variant
 * (`empty` → lone-owner first-run, `populated`/`loading` → rich team + pending invite).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('orgFullOrganizationFixture (GET /auth/organization/get-full-organization → FullOrganization DIRECT)', () => {
  it('returns the FullOrganization body DIRECTLY — NOT wrapped in { data } (matches auth_org.ts:89)', () => {
    const res: FullOrganization = orgFullOrganizationFixture('populated', q());
    // The worker `c.json({ id, name, ... })`s the body directly; OrgApiService sets
    // res.data = parsed, so there must be NO extra { data } nesting layer here.
    expect((res as unknown as { data?: unknown }).data).toBeUndefined();
    expect(Array.isArray(res.members)).toBe(true);
    expect(Array.isArray(res.invitations)).toBe(true);
    expect(typeof res.id).toBe('string');
  });

  it('carries the authoritative seat fields (seatLimit + seatUsed) from the entitlement', () => {
    const res = orgFullOrganizationFixture('populated', q());
    expect(typeof res.seatLimit).toBe('number');
    expect(typeof res.seatUsed).toBe('number');
    // seatUsed = active members + pending invites (the worker's accounting).
    expect(res.seatUsed).toBe(res.members.length + res.invitations.length);
  });

  it('each member matches the auth_org.ts projection (camelCase + embedded user + flat fallbacks)', () => {
    for (const m of orgFullOrganizationFixture('populated', q()).members) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.role).toBe('string');
      expect(['owner', 'admin', 'member']).toContain(m.role);
      // camelCase wire fields (NOT the snake_case of the OTHER /team route).
      expect(typeof m.createdAt).toBe('string');
      expect(typeof m.organizationId).toBe('string');
      expect(typeof m.userId).toBe('string');
      // The embedded user object AND the flat fallbacks the component reads across.
      expect(typeof m.user?.email).toBe('string');
      expect(typeof m.email).toBe('string');
      // memberEmail()'s chain (user?.email ?? email ?? userId) must resolve to a real email.
      const resolved = m.user?.email ?? m.email ?? m.userId ?? '';
      expect(resolved).toContain('@');
    }
  });

  it('each invitation matches the projection (camelCase expiresAt/createdAt + status pending)', () => {
    for (const inv of orgFullOrganizationFixture('populated', q()).invitations) {
      expect(typeof inv.id).toBe('string');
      expect(inv.email).toContain('@');
      expect(['owner', 'admin', 'member']).toContain(inv.role);
      expect(inv.status).toBe('pending');
      expect(typeof inv.expiresAt).toBe('string');
      expect(typeof inv.createdAt).toBe('string');
    }
  });

  it('populated holds a believable 3-person team with EXACTLY ONE owner (demos the last-owner guard)', () => {
    const { members } = orgFullOrganizationFixture('populated', q());
    expect(members.length).toBe(3);
    const owners = members.filter((m) => m.role === 'owner');
    expect(owners.length).toBe(1); // sole owner → component shows "Last owner", not Remove
    // Spans the three roles so every role label + control variant renders.
    const roles = new Set(members.map((m) => m.role));
    expect(roles.has('owner')).toBe(true);
    expect(roles.has('admin')).toBe(true);
    expect(roles.has('member')).toBe(true);
  });

  it('populated has one pending invite that survives the component status filter', () => {
    const { invitations } = orgFullOrganizationFixture('populated', q());
    expect(invitations.length).toBe(1);
    // Component keeps `!status || status === 'pending'` — this row must pass.
    expect(!invitations[0].status || invitations[0].status === 'pending').toBe(true);
  });

  it('populated is a pro-plan org with room: 3 members + 1 invite = 4 of 10 seats (not full)', () => {
    const res = orgFullOrganizationFixture('populated', q());
    expect(res.seatLimit).toBe(10);
    expect(res.seatUsed).toBe(4);
    expect(res.seatUsed).toBeLessThan(res.seatLimit!); // happy path — invite enabled
  });

  it('empty → a lone owner + no invites (the honest "invite your first member" launchpad)', () => {
    const { members, invitations } = orgFullOrganizationFixture('empty', q());
    expect(members.length).toBe(1);
    expect(members[0].role).toBe('owner');
    expect(invitations).toEqual([]);
  });

  it('empty → a free 1-seat org where the lone owner fills it (seat-full edge, "1 of 1")', () => {
    const res = orgFullOrganizationFixture('empty', q());
    expect(res.seatLimit).toBe(1);
    expect(res.seatUsed).toBe(1);
    expect(res.seatUsed).toBe(res.seatLimit); // full → the component's seat-limit UI is demoable
  });

  it('loading serves the populated body (the interceptor owns the delay)', () => {
    expect(orgFullOrganizationFixture('loading', q()).members.length).toBe(
      orgFullOrganizationFixture('populated', q()).members.length,
    );
  });

  it('does not alias the shared seed — mutating a returned member/user leaves the next call clean', () => {
    const first = orgFullOrganizationFixture('populated', q());
    first.members[0].role = 'member';
    first.members[0].user!.email = 'tampered@example.test';
    first.invitations[0].email = 'tampered@example.test';
    const second = orgFullOrganizationFixture('populated', q());
    expect(second.members[0].role).toBe('owner');
    expect(second.members[0].user!.email).not.toBe('tampered@example.test');
    expect(second.invitations[0].email).not.toBe('tampered@example.test');
  });
});

describe('team fixture — registry-key normalization + reachability (orchestrator merges index.ts)', () => {
  // index.ts is owned by the orchestrator (parallel-collision avoidance), so this slice
  // does NOT add the shipped registry line. We assert the KEY normalization here, then
  // prove reachability via the documented `registerFixtures` test seam.
  it('the OrgApiService URL normalizes to the expected registry key (query stripped, /api dropped)', () => {
    // OrgApiService builds `fetch('/api/auth/organization/get-full-organization')`.
    expect(toRegistryKey('GET', '/api/auth/organization/get-full-organization').key).toBe(
      'GET /auth/organization/get-full-organization',
    );
  });

  it('is reachable via the test seam under its static key', () => {
    const dispose = registerFixtures({
      'GET /auth/organization/get-full-organization': orgFullOrganizationFixture as never,
    });
    const { key } = toRegistryKey('GET', '/api/auth/organization/get-full-organization');
    expect(findFixture(key)).toBe(orgFullOrganizationFixture as never);
    dispose();
  });
});
