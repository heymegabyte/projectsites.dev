/**
 * @module mocks/fixtures/team
 *
 * @description
 * Mock fixture for the standalone admin **Team** section (`pages/admin/sections/team.component.ts`)
 * — the org members + pending-invitations surface (idea #24). On construction the component fires
 * ONE read through {@link import('../../pages/auth/org-api.service').OrgApiService.getFullOrganization}
 * (`GET /api/auth/organization/get-full-organization`), then renders the members list, the pending
 * invitations list, the seat-usage line, and the invite form. The factory below is typed to the
 * EXACT worker wire shape traced to `src/routes/auth_org.ts` (the live custom-D1 handler), so wiring
 * the real endpoint later is a provider SWAP, not a rewrite — and faithful-to-wire also catches any
 * FE shape-drift against the component's `FullOrganization` consumer.
 *
 * **This is a DIFFERENT surface from the Settings-section Team TAB.** The Settings tab
 * (`settings.component.ts`) reads `GET /team` → `{ data: { members, invites } }` (snake_case,
 * `src/routes/ai_admin.ts`), fixtured as `teamFixture` in `settings.fixture.ts`. THIS section
 * reads `GET /auth/organization/get-full-organization` → the `FullOrganization` body DIRECTLY
 * (camelCase `createdAt`/`expiresAt`/`organizationId`, NOT wrapped in `{ data }`). Two routes, two
 * envelopes — not a duplicate. Named `orgFullOrganizationFixture` to avoid a name collision with
 * `settings.fixture.ts`'s `teamFixture`.
 *
 * **Flag-gating:** NONE. `authOrg.get('/api/auth/organization/get-full-organization')` requires only
 * a resolved `orgId` (session membership) — no `requireFlag`. The worker's comment notes Better Auth
 * ships DARK behind the `better_auth` flag, but these are the CUSTOM-auth handlers over the live
 * `memberships`/`users`/`team_invites` tables that are always the live path. So the Team section
 * renders with NO flag flip.
 *
 * **⚠ Wiring caveat for the orchestrator (native-fetch bypass):** `OrgApiService` calls the worker
 * with the native `fetch` API (to round-trip the session cookie + `ps_session` Bearer), NOT Angular's
 * `HttpClient`. The mock seam (`mock-api.interceptor.ts`) is an `HttpInterceptorFn` that ONLY sees
 * `HttpClient` traffic — so a registry line for this key is INERT on `?mock=1` until a native-`fetch`
 * mock shim is added (same class as the `AuthApiService` sibling, also native-fetch + unfixtured).
 * This fixture is still correct + merge-ready (faithful-to-wire value stands alone); it just won't
 * light up the live Team section until that shim lands. Flagged so P2d's smoke step wires it — or
 * the orchestrator decides scope.
 *
 * | Registry key                                     | Factory                          | Worker contract (traced)                                                          |
 * | ------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------- |
 * | `GET /auth/organization/get-full-organization`   | {@link orgFullOrganizationFixture} | `FullOrganization` body DIRECT (NOT `{data}`) — `auth_org.ts:89` `c.json({ id, name, slug, seatLimit, seatUsed, members, invitations })` |
 *
 * @remarks
 * - Believable data, not lorem: a real 3-person barber-shop team (owner + admin + member, mirroring
 *   the `/auth/me` + `settings.fixture.ts` demo identities) and one pending invite whose `expiresAt`
 *   reads a few days out. Each member carries BOTH the embedded `user: { email, name }` AND the
 *   flat `email`/`name` the component's `memberEmail()` falls back across, plus `userId` — every
 *   shape the Better Auth wrapper may surface. Enough variety that the members list, the role
 *   labels, the last-owner guard (one owner → "Last owner", not Remove), the invites list, and the
 *   seat-usage line all render with real texture.
 * - `state` variants: `empty` → the honest brand-new-org surface (a lone owner, no invites → the
 *   "Invite your first member" launchpad + a truthful "1 of N seats used"); `populated`/`loading`/
 *   default → the rich 3-person team + one pending invite. `error` is handled by the interceptor
 *   (it throws a 500 before this runs → the component's `team-error` alert + empty team).
 * - `seatLimit`/`seatUsed` are the AUTHORITATIVE cap the worker surfaces (same entitlement the invite
 *   endpoint enforces). The demo org is a `pro` plan (10 seats) so the populated set (3 members + 1
 *   invite = 4 seats) reads as "4 of 10 seats used" with room to invite — the happy path. `empty`
 *   uses a `free` 1-seat org so the lone owner reads a truthful "1 of 1" (seat-full edge). `-1` =
 *   unlimited (enterprise); the component treats it as never-full.
 */
import type { FixtureFactory, MockState } from './index';
import type {
  FullOrganization,
  OrgMember,
  OrgInvitation,
} from '../../pages/auth/org-api.service';

/** A recent anchor so `createdAt` / `expiresAt` read as believable ISO strings. */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const iso = (hoursAgo: number): string => new Date(ANCHOR - hoursAgo * 3_600_000).toISOString();

/** The shared demo org id (mirrors the `/auth/me` + billing + settings fixtures — one identity). */
const DEMO_ORG_ID = 'org-mock-0001';

/**
 * Build one member row in the EXACT `auth_org.ts:95` projection — the embedded `user` object AND
 * the flat `email`/`name`/`userId` the Better Auth wrapper also emits, so the component's
 * `memberEmail()` fallback chain (`user?.email ?? email ?? userId`) resolves on any shape.
 */
function member(
  id: string,
  userId: string,
  email: string,
  name: string,
  role: 'owner' | 'admin' | 'member',
  createdAtHoursAgo: number,
): OrgMember {
  return {
    id,
    organizationId: DEMO_ORG_ID,
    userId,
    role,
    createdAt: iso(createdAtHoursAgo),
    user: { id: userId, email, name },
    email,
    name,
  };
}

/**
 * A believable 3-person team, owner-first (the worker orders members by `created_at ASC`). The
 * owner mirrors the `/auth/me` demo identity; roles span owner · admin · member so the role labels
 * and the per-row Remove / "Last owner" controls all render. Exactly ONE owner so the last-owner
 * guard shows a "Last owner" label (not a Remove) on the owner row — a real, demoable guard state.
 *
 * NOTE the component maps `role` onto its own `OrgRole` ('owner' | 'admin' | 'member'); the worker
 * only ever writes those three (`ORG_ROLES`), so no 'editor' here (that's the OTHER route's shape).
 */
const TEAM_MEMBERS: readonly OrgMember[] = [
  member('mem-0001', 'usr-mock-0001', 'owner@beverwyckventures.test', 'Alex Rivera', 'owner', 2160),
  member('mem-0002', 'usr-mock-0002', 'marcus@beverwyckbarber.test', 'Marcus Webb', 'admin', 1440),
  member('mem-0003', 'usr-mock-0003', 'devon@beverwyckbarber.test', 'Devon Pierce', 'member', 720),
];

/**
 * One pending invite so the invitations list + its Cancel row render. `status: 'pending'` (the
 * worker hard-codes it) + a soon `expiresAt` (negative hoursAgo = future). The component filters to
 * `!status || status === 'pending'`, so this row survives that filter.
 */
const TEAM_INVITES: readonly OrgInvitation[] = [
  {
    id: 'inv-0001',
    organizationId: DEMO_ORG_ID,
    email: 'jordan@beverwyckbarber.test',
    role: 'member',
    status: 'pending',
    expiresAt: iso(-132), // ~5.5 days out
    createdAt: iso(36),
  },
];

/** Deep-copy a member so callers can't alias the shared frozen seed (incl. the nested `user`). */
function cloneMember(m: OrgMember): OrgMember {
  return { ...m, user: m.user ? { ...m.user } : m.user };
}

/**
 * Team factory — serves the `FullOrganization` body the worker returns DIRECTLY (NOT under `{ data }`;
 * `OrgApiService` sets `res.data = parsed`, so `res.data` IS this object).
 *
 * `empty` → a lone owner on a `free` 1-seat org, no invites (the honest brand-new-org surface — the
 * "Invite your first member" launchpad + a truthful "1 of 1 seats used", which also demos the
 * seat-full edge: the owner already fills the only seat). `populated`/`loading`/default → the
 * believable 3-person `pro`-plan team (10 seats) + one pending invite = "4 of 10 seats used", the
 * happy path with room to invite. `error` is handled by the interceptor (throws a 500 before this
 * runs → the component's `team-error` alert + `team-members-empty` launchpad).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const orgFullOrganizationFixture: FixtureFactory<FullOrganization> = (
  state: MockState,
): FullOrganization => {
  if (state === 'empty') {
    return {
      id: DEMO_ORG_ID,
      name: 'Beverwyck Barber Co.',
      slug: 'beverwyck-barber',
      seatLimit: 1, // free plan — the lone owner fills the only seat (seat-full edge)
      seatUsed: 1,
      members: [cloneMember(TEAM_MEMBERS[0])],
      invitations: [],
    };
  }
  const members = TEAM_MEMBERS.map(cloneMember);
  const invitations = TEAM_INVITES.map((i) => ({ ...i }));
  return {
    id: DEMO_ORG_ID,
    name: 'Beverwyck Barber Co.',
    slug: 'beverwyck-barber',
    seatLimit: 10, // pro plan — room beyond the 4 used seats (happy path)
    seatUsed: members.length + invitations.length,
    members,
    invitations,
  };
};
