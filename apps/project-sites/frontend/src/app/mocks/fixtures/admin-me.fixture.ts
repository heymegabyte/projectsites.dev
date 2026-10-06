/**
 * @module mocks/fixtures/admin-me
 *
 * @description
 * Mock fixture for the current-session read (`GET /api/auth/me`) — the fourth read
 * {@link import('../../pages/admin/admin-state.service').AdminStateService} forkJoins in
 * `loadData` (with the sites roster, domain summary + subscription). It hydrates
 * `orgId` / `orgName` / `isSuperAdmin`, which label org-scoped surfaces and gate the
 * super-admin UI — so a mock session must carry a believable identity or those surfaces
 * fall back to generic placeholders.
 *
 * Typed to the EXACT worker contract — `{ data: { user_id, org_id, org_name, email,
 * display_name, is_super_admin } }` (see `GET /api/auth/me` in `src/routes/api.ts`) — so
 * wiring the real endpoint is a provider SWAP.
 *
 * @remarks
 * - `org_id` matches the billing entitlements fixture's `DEMO_ORG_ID` convention so the
 *   mocked org is ONE coherent identity across surfaces.
 * - `/auth/me` is never truly "empty" for an authed admin shell, so the `empty` knob
 *   means a plain, NON-super-admin operator (super-admin-gated UI stays hidden); the
 *   `populated` default is a super-admin so the full shell (incl. super-admin sections)
 *   is demoable. `error` is handled by the interceptor.
 */
import type { FixtureFactory, MockState } from './index';

/** The session identity the worker's `GET /api/auth/me` returns under `{ data }`. */
export interface MeRow {
  user_id: string;
  org_id: string;
  org_name: string | null;
  email: string;
  display_name: string | null;
  is_super_admin: boolean;
}

/** `GET /api/auth/me` envelope. */
export interface MeResponse {
  data: MeRow;
}

/** The shared demo org id (mirrors the billing entitlements fixture — one identity). */
const DEMO_ORG_ID = 'org-mock-0001';

/**
 * Session factory. `empty` → a valid session for a plain operator (NOT a super-admin, so
 * super-admin-gated UI hides); `populated`/`loading`/default → a super-admin operator so
 * the whole shell is demoable. Both carry a real org so org-scoped labels render.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const meFixture: FixtureFactory<MeResponse> = (state: MockState): MeResponse => {
  const superAdmin = state !== 'empty';
  return {
    data: {
      user_id: 'usr-mock-0001',
      org_id: DEMO_ORG_ID,
      org_name: 'Beverwyck Ventures',
      email: 'owner@beverwyckventures.test',
      display_name: 'Alex Rivera',
      is_super_admin: superAdmin,
    },
  };
};
